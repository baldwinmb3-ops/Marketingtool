const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const { chromium } = require('playwright');
const { newDb } = require('pg-mem');

const { createApp } = require('../server/app.cjs');
const { closePool } = require('../server/db.cjs');

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function createHarness() {
  const previousCorsOrigin = Object.prototype.hasOwnProperty.call(process.env, 'APP_CORS_ORIGIN')
    ? process.env.APP_CORS_ORIGIN
    : undefined;
  process.env.APP_CORS_ORIGIN = '*';

  const mem = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pgAdapter = mem.adapters.createPg();
  const pool = new pgAdapter.Pool();
  const { app } = await createApp({ db: pool, seedDatabase: true });
  const htmlPath = path.join(__dirname, '..', 'premium_pricing_clickable.html');
  const assetPath = path.join(__dirname, '..');

  app.get('/runtime-config.js', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type('application/javascript');
    res.send(`window.__FlickerRuntimeConfig = Object.assign({}, window.__FlickerRuntimeConfig || {}, { apiBaseUrl: window.location.origin });\n`);
  });
  app.get('/', (_req, res) => {
    res.sendFile(htmlPath);
  });
  app.get('/premium_pricing_clickable.html', (_req, res) => {
    res.sendFile(htmlPath);
  });
  app.get('/logo.png', (_req, res) => {
    res.sendFile(path.join(assetPath, 'logo.png'));
  });
  app.get('/version.json', (_req, res) => {
    res.sendFile(path.join(assetPath, 'version.json'));
  });

  const server = http.createServer(app);
  const baseUrl = await listen(server);
  const browser = await chromium.launch({ headless: true });

  async function close() {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
    await closePool(pool);
    if (previousCorsOrigin === undefined) {
      delete process.env.APP_CORS_ORIGIN;
    } else {
      process.env.APP_CORS_ORIGIN = previousCorsOrigin;
    }
  }

  return {
    browser,
    appUrl: `${baseUrl}/premium_pricing_clickable.html`,
    close,
  };
}

async function signInDualRoleAdmin(page, appUrl) {
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-field="authLocalIdentifier"]').fill('ADMIN1001');
  await page.locator('[data-field="authLocalPassword"]').fill('Admin123A');
  await page.locator('[data-action="auth-local-signin"]').click();
  await page.waitForFunction(() => document.body.innerText.includes('Admin Control') || document.body.innerText.includes('Marketer Quote Builder'));
  if ((await page.locator('text=Admin Control').count()) === 0) {
    const adminSwitch = page.locator('[data-action="switch-session-role"][data-role="admin"]');
    if (await adminSwitch.count()) {
      await adminSwitch.click();
      await waitForRoleReady(page, 'Admin Control');
      return;
    }
  }
  await page.locator('text=Admin Control').waitFor({ state: 'visible' });
}

async function waitForRoleReady(page, headingText) {
  await page.locator(`text=${headingText}`).waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.body.innerText.includes('Switching role...'));
  await page.waitForFunction(() => {
    const buttons = Array.from(document.querySelectorAll('[data-action="switch-session-role"]'));
    return !buttons.some((button) => button.disabled);
  });
}

function collectCounts(logs) {
  const count = (label) => logs.filter((line) => line.includes(`[SYNC_DIAG] ${label}`)).length;
  return {
    authSessionClear: count('auth-session-clear'),
    triggerAutoCloudLoadNowCall: count('triggerAutoCloudLoadNow-call'),
    triggerAutoCloudLoadNowDeduped: count('triggerAutoCloudLoadNow-dedupe'),
    runCloudSyncNowStart: count('runCloudSyncNow-start'),
    runCloudSyncNowDeduped: count('runCloudSyncNow-dedupe'),
    authSessionSwitchRole: count('auth-session-switch-role'),
    authSessionSwitchRoleSkip: count('auth-session-switch-role-skip'),
  };
}

async function installSlowBackgroundCloudFetch(page, delayMs = 450) {
  await page.addInitScript((delay) => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      let shouldDelay = false;
      if (/\/api\/users(?:$|\?)/.test(String(url))) {
        shouldDelay = true;
      } else if (/\/api\/cloud(?:$|\?)/.test(String(url))) {
        try {
          const rawBody = init && typeof init.body === 'string' ? init.body : '';
          const parsed = rawBody ? JSON.parse(rawBody) : {};
          const action = String((parsed && parsed.action) || '').trim().toLowerCase();
          shouldDelay = action === 'catalog_get_live' || action === 'booking_get';
        } catch {}
      }
      if (shouldDelay) {
        await new Promise((resolve) => window.setTimeout(resolve, delay));
      }
      return originalFetch(input, init);
    };
  }, delayMs);
}

test('auth/session sync stays single-flight during repeated role switching', { concurrency: false }, async () => {
  const h = await createHarness();
  try {
    const page = await h.browser.newPage();
    const logs = [];
    const responses = [];

    page.on('console', (message) => {
      logs.push(message.text());
    });
    page.on('response', (response) => {
      responses.push({
        url: response.url(),
        status: response.status(),
        method: response.request().method(),
      });
    });

    await signInDualRoleAdmin(page, h.appUrl);
    await page.waitForTimeout(300);

    const switchDurations = [];
    const switchCases = [
      { role: 'marketer', heading: 'Marketer Quote Builder' },
      { role: 'admin', heading: 'Admin Control' },
      { role: 'marketer', heading: 'Marketer Quote Builder' },
      { role: 'admin', heading: 'Admin Control' },
    ];

    for (const step of switchCases) {
      const startedAt = Date.now();
      await page.locator(`[data-action="switch-session-role"][data-role="${step.role}"]`).click();
      await waitForRoleReady(page, step.heading);
      switchDurations.push(Date.now() - startedAt);
      await page.waitForTimeout(250);
    }

    const counts = collectCounts(logs);
    const failingCloudResponses = responses.filter((entry) => entry.url.includes('/api/cloud') && entry.status >= 400);
    const failingUsersResponses = responses.filter((entry) => entry.url.includes('/api/users') && entry.status >= 400);

    assert.equal(counts.authSessionClear, 0, `Unexpected auth-session-clear logs: ${logs.join('\n')}`);
    assert.ok(
      counts.triggerAutoCloudLoadNowCall <= 6,
      `Expected at most 6 auto-load starts, saw ${counts.triggerAutoCloudLoadNowCall}\n${logs.join('\n')}`,
    );
    assert.ok(
      counts.runCloudSyncNowStart <= 6,
      `Expected at most 6 cloud sync starts, saw ${counts.runCloudSyncNowStart}\n${logs.join('\n')}`,
    );
    assert.equal(
      counts.authSessionSwitchRole,
      5,
      `Expected exactly 5 completed role switches, saw ${counts.authSessionSwitchRole}\n${logs.join('\n')}`,
    );
    assert.equal(failingCloudResponses.length, 0, `Unexpected /api/cloud failures: ${JSON.stringify(failingCloudResponses)}`);
    assert.equal(failingUsersResponses.length, 0, `Unexpected /api/users failures: ${JSON.stringify(failingUsersResponses)}`);
    switchDurations.forEach((durationMs) => {
      assert.ok(durationMs < 5000, `Role switch took too long: ${durationMs}ms`);
    });
  } finally {
    await h.close();
  }
});

test('admin Save&Send still works after role-switch hardening', { concurrency: false }, async () => {
  const h = await createHarness();
  try {
    const page = await h.browser.newPage();
    const responses = [];

    page.on('response', (response) => {
      responses.push({
        url: response.url(),
        status: response.status(),
        method: response.request().method(),
      });
    });

    await signInDualRoleAdmin(page, h.appUrl);
    await page.locator('[data-action="tab"][data-tab="build"]').click();
    await page.locator('[data-action="open-brand"]').first().waitFor({ state: 'visible' });
    await page.locator('[data-action="open-brand"]').first().click();
    await page.locator('[data-field="brandDraft"]').fill('Primary Admin Save Smoke');
    await page.locator('[data-action="close-brand-detail"]').click();
    await page.locator('[data-action="save-admin"]').click();
    await page.waitForTimeout(800);
    await page.waitForFunction(() => {
      const text = document.body.innerText;
      return text.includes('All changes saved & sent') || text.includes('0 items saved but not sent');
    });

    const failingCloudResponses = responses.filter((entry) => entry.url.includes('/api/cloud') && entry.status >= 400);
    assert.equal(failingCloudResponses.length, 0, `Unexpected /api/cloud failures during Save&Send: ${JSON.stringify(failingCloudResponses)}`);
  } finally {
    await h.close();
  }
});

test('role switch stays responsive while background sync is slow', { concurrency: false }, async () => {
  const h = await createHarness();
  try {
    const page = await h.browser.newPage();
    await installSlowBackgroundCloudFetch(page, 500);
    await signInDualRoleAdmin(page, h.appUrl);
    await page.waitForTimeout(300);

    const switchDurations = [];
    const switchCases = [
      { role: 'marketer', heading: 'Marketer Quote Builder' },
      { role: 'admin', heading: 'Admin Control' },
    ];

    for (const step of switchCases) {
      const startedAt = Date.now();
      await page.locator(`[data-action="switch-session-role"][data-role="${step.role}"]`).click();
      await waitForRoleReady(page, step.heading);
      switchDurations.push({ role: step.role, durationMs: Date.now() - startedAt });
      await page.waitForTimeout(150);
    }

    switchDurations.forEach(({ role, durationMs }) => {
      assert.ok(
        durationMs < 1200,
        `Expected ${role} switch to stay responsive while background sync is slow, saw ${durationMs}ms`,
      );
    });
  } finally {
    await h.close();
  }
});
