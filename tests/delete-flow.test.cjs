const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const request = require('supertest');
const { chromium } = require('playwright');
const { newDb } = require('pg-mem');

const { createApp } = require('../server/app.cjs');
const { closePool } = require('../server/db.cjs');

const STORAGE_KEY = 'premium_pricing_clickable_html_v2';

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
  app.get('/runtime-config.js', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type('application/javascript');
    res.send(`window.__FlickerRuntimeConfig = Object.assign({}, window.__FlickerRuntimeConfig || {}, { apiBaseUrl: window.location.origin });\n`);
  });
  app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'premium_pricing_clickable.html'));
  });
  app.get('/premium_pricing_clickable.html', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'premium_pricing_clickable.html'));
  });
  app.get('/logo.png', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'logo.png'));
  });
  app.get('/version.json', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'version.json'));
  });
  const backendServer = http.createServer(app);
  const backendBaseUrl = await listen(backendServer);
  const browser = await chromium.launch({ headless: true });
  const api = request.agent(app);
  const adminApi = request.agent(app);
  const assistantApi = request.agent(app);

  const signIn = async (agent, identifier, password, role) => {
    const res = await agent.post('/api/auth/sign-in').send({ identifier, password, role });
    assert.equal(res.status, 200, `Sign-in failed: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.ok, true, `Sign-in not ok: ${JSON.stringify(res.body)}`);
    return res;
  };

  await signIn(adminApi, 'ADMIN1001', 'Admin123A', 'admin');
  await signIn(assistantApi, 'ADMIN2001', 'Assist123A', 'admin');

  async function close() {
    await browser.close();
    await new Promise((resolve) => backendServer.close(resolve));
    await closePool(pool);
    if (previousCorsOrigin === undefined) {
      delete process.env.APP_CORS_ORIGIN;
    } else {
      process.env.APP_CORS_ORIGIN = previousCorsOrigin;
    }
  }

  return {
    browser,
    frontendBaseUrl: backendBaseUrl,
    appUrl: `${backendBaseUrl}/premium_pricing_clickable.html`,
    backendBaseUrl,
    api,
    adminApi,
    assistantApi,
    close,
  };
}

async function signInAsAdmin(page, appUrl, identifier = 'ADMIN1001', password = 'Admin123A') {
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
  if ((await page.locator('[data-field="authLocalIdentifier"]').count()) > 0) {
    await page.locator('[data-field="authLocalIdentifier"]').fill(identifier);
    await page.locator('[data-field="authLocalPassword"]').fill(password);
    await page.locator('[data-action="auth-local-signin"]').click();
  }
  await page.waitForFunction(() => document.body.innerText.includes('Admin Control') || document.body.innerText.includes('Marketer Quote Builder'));
  if ((await page.locator('text=Admin Control').count()) === 0) {
    const adminSwitch = page.locator('[data-action="switch-session-role"][data-role="admin"]');
    if (await adminSwitch.count()) {
      await adminSwitch.click();
      await page.locator('text=Admin Control').waitFor({ state: 'visible' });
      return;
    }
  }
  await page.locator('text=Admin Control').waitFor({ state: 'visible' });
}

async function openUserManagementTab(page, tab) {
  await page.locator('[data-action="tab"][data-tab="admins"]').click();
  await page.locator('text=User Management').waitFor({ state: 'visible' });
  await page.locator(`[data-action="user-mgmt-tab"][data-tab="${tab}"]`).click();
  if (tab === 'marketers') {
    await page.getByRole('heading', { name: 'Marketers', exact: true }).waitFor({ state: 'visible' });
  } else {
    await page.getByRole('heading', { name: 'Primary Admins', exact: true }).waitFor({ state: 'visible' });
  }
}

async function searchUsers(page, text) {
  const input = page.locator('[data-field="userMgmtSearch"]');
  await input.fill(text);
  await page.waitForTimeout(100);
}

async function readStorageState(page) {
  return page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  }, STORAGE_KEY);
}

function extractWwids(users = []) {
  return (Array.isArray(users) ? users : []).map((row) => String((row && row.wwid) || '').trim().toUpperCase()).filter(Boolean);
}

async function backendUsersFor(agent) {
  const res = await agent.get('/api/users');
  assert.equal(res.status, 200, `Users fetch failed: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.ok, true);
  return Array.isArray(res.body.users) ? res.body.users : [];
}

async function backendHasUser(agent, wwid) {
  const rows = await backendUsersFor(agent);
  return rows.some((row) => String((row && row.wwid) || '').trim().toUpperCase() === String(wwid || '').trim().toUpperCase());
}

async function confirmDelete(page, deleteAction, dialogAction) {
  await page.locator(`[data-action="${deleteAction}"]`).click();
  await page.locator(`[data-action="${dialogAction}"]`).waitFor({ state: 'visible' });
  await page.locator(`[data-action="${dialogAction}"]`).click();
}

async function dismissDialogIfPresent(page) {
  const closeAction = page.locator('[data-action="close-app-dialog"]');
  if (await closeAction.count()) {
    await closeAction.first().click();
    return true;
  }
  const okButton = page.getByRole('button', { name: 'OK', exact: true });
  if (await okButton.count()) {
    await okButton.first().click();
    return true;
  }
  return false;
}

function createDeleteRouteController(page) {
  let armed = true;
  let release;
  const intercepted = new Promise((resolve) => {
    page.route('**/api/cloud', async (route) => {
      const req = route.request();
      let body = null;
      try {
        body = req.postDataJSON();
      } catch {}
      const isDelete =
        req.method() === 'POST' &&
        body &&
        body.action === 'apply_user_operations' &&
        Array.isArray(body.user_operations) &&
        body.user_operations.some((op) => op && String(op.op || '').trim().toLowerCase() === 'delete_user');
      if (!armed || !isDelete) {
        await route.continue();
        return;
      }
      armed = false;
      const decisionPromise = new Promise((resolveRelease) => {
        release = resolveRelease;
      });
      resolve({
        body,
        release(decision) {
          if (release) release(decision);
        },
      });
      const decision = await decisionPromise;
      if (decision === 'continue') {
        await route.continue();
        return;
      }
      if (decision && decision.type === 'fulfill') {
        await route.fulfill(decision.payload);
        return;
      }
      await route.abort(decision || 'failed');
    });
  });
  return { intercepted };
}

test('delete flow: marketer success is durable and survives refresh', { concurrency: false }, async () => {
  const h = await createHarness();
  try {
    const page = await h.browser.newPage();
    await signInAsAdmin(page, h.appUrl);
    await openUserManagementTab(page, 'marketers');
    await searchUsers(page, 'Marketer One');
    await confirmDelete(page, 'del-marketer', 'dialog-del-marketer');
    await page.waitForTimeout(400);

    assert.equal(await page.locator('text=Marketer One').count(), 0, 'Marketer should be removed from UI after durable success');
    assert.equal(await backendHasUser(h.adminApi, 'MARK1001'), false, 'Backend should no longer list MARK1001');

    const state = await readStorageState(page);
    const pendingOps = Array.isArray(state && state.pendingUserCloudOps) ? state.pendingUserCloudOps : [];
    const tombstones = Array.isArray(state && state.deletedUserTombstones) ? state.deletedUserTombstones : [];
    assert.equal(pendingOps.some((op) => String((op && op.wwid) || '').trim().toUpperCase() === 'MARK1001'), false, 'Pending delete op should clear after success');
    assert.equal(tombstones.some((row) => String((row && row.wwid) || '').trim().toUpperCase() === 'MARK1001'), false, 'Delete tombstone should clear after success');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await openUserManagementTab(page, 'marketers');
    await searchUsers(page, 'Marketer One');
    assert.equal(await page.locator('text=Marketer One').count(), 0, 'Refresh should not bring deleted marketer back');
  } finally {
    await h.close();
  }
});

test('delete flow: admin assistant success is durable and survives refresh', { concurrency: false }, async () => {
  const h = await createHarness();
  try {
    const page = await h.browser.newPage();
    await signInAsAdmin(page, h.appUrl);
    await openUserManagementTab(page, 'admins');
    await searchUsers(page, 'Admin Assistant');
    await confirmDelete(page, 'del-admin-assistant', 'dialog-del-admin-assistant');
    await page.waitForTimeout(400);

    assert.equal(await page.locator('text=Admin Assistant').count(), 0, 'Assistant admin should be removed from UI after durable success');
    assert.equal(await backendHasUser(h.adminApi, 'ADMIN2001'), false, 'Backend should no longer list ADMIN2001');

    const state = await readStorageState(page);
    const pendingOps = Array.isArray(state && state.pendingUserCloudOps) ? state.pendingUserCloudOps : [];
    const tombstones = Array.isArray(state && state.deletedUserTombstones) ? state.deletedUserTombstones : [];
    assert.equal(pendingOps.some((op) => String((op && op.wwid) || '').trim().toUpperCase() === 'ADMIN2001'), false, 'Pending delete op should clear after assistant delete success');
    assert.equal(tombstones.some((row) => String((row && row.wwid) || '').trim().toUpperCase() === 'ADMIN2001'), false, 'Delete tombstone should clear after assistant delete success');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await openUserManagementTab(page, 'admins');
    await searchUsers(page, 'Admin Assistant');
    assert.equal(await page.locator('text=Admin Assistant').count(), 0, 'Refresh should not bring deleted assistant admin back');
  } finally {
    await h.close();
  }
});

test('delete flow: failed cloud delete keeps UI/backend consistent', { concurrency: false }, async () => {
  const h = await createHarness();
  try {
    const page = await h.browser.newPage();
    await page.route('**/api/cloud', async (route) => {
      const req = route.request();
      let body = null;
      try {
        body = req.postDataJSON();
      } catch {}
      const isDelete =
        req.method() === 'POST' &&
        body &&
        body.action === 'apply_user_operations' &&
        Array.isArray(body.user_operations) &&
        body.user_operations.some((op) => op && String(op.op || '').trim().toLowerCase() === 'delete_user');
      if (!isDelete) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, message: 'Forced delete failure' }),
      });
    });

    await signInAsAdmin(page, h.appUrl);
    await openUserManagementTab(page, 'marketers');
    await searchUsers(page, 'Marketer One');
    await confirmDelete(page, 'del-marketer', 'dialog-del-marketer');
    await page.waitForTimeout(500);

    assert.ok(await page.locator('text=Marketer One').count() > 0, 'Failed delete should restore or preserve the marketer in UI');
    assert.equal(await backendHasUser(h.adminApi, 'MARK1001'), true, 'Backend should still have the marketer after failed delete');

    const state = await readStorageState(page);
    const pendingOps = Array.isArray(state && state.pendingUserCloudOps) ? state.pendingUserCloudOps : [];
    const tombstones = Array.isArray(state && state.deletedUserTombstones) ? state.deletedUserTombstones : [];
    assert.equal(pendingOps.some((op) => String((op && op.wwid) || '').trim().toUpperCase() === 'MARK1001'), false, 'Failed delete should not leave a queued delete op behind');
    assert.equal(tombstones.some((row) => String((row && row.wwid) || '').trim().toUpperCase() === 'MARK1001'), false, 'Failed delete should not leave a tombstone behind');
  } finally {
    await h.close();
  }
});

test('delete flow: local UI must not remove the user before durable confirmation', { concurrency: false }, async () => {
  const h = await createHarness();
  try {
    const page = await h.browser.newPage();
    const controller = createDeleteRouteController(page);
    await signInAsAdmin(page, h.appUrl);
    await openUserManagementTab(page, 'marketers');
    await searchUsers(page, 'Marketer One');
    await confirmDelete(page, 'del-marketer', 'dialog-del-marketer');

    const held = await controller.intercepted;
    assert.ok(held && held.body, 'Expected delete request to be intercepted');

    const state = await readStorageState(page);
    const usersWwids = extractWwids(state && state.users);
    const pendingOps = Array.isArray(state && state.pendingUserCloudOps) ? state.pendingUserCloudOps : [];
    const tombstones = Array.isArray(state && state.deletedUserTombstones) ? state.deletedUserTombstones : [];
    assert.ok(usersWwids.includes('MARK1001'), 'Local persisted user list should still contain the marketer until backend delete is confirmed');
    assert.equal(pendingOps.some((op) => String((op && op.wwid) || '').trim().toUpperCase() === 'MARK1001'), false, 'Held delete should not persist a delete queue item before confirmation');
    assert.equal(tombstones.some((row) => String((row && row.wwid) || '').trim().toUpperCase() === 'MARK1001'), false, 'Held delete should not persist a tombstone before confirmation');
    assert.equal(await backendHasUser(h.adminApi, 'MARK1001'), true, 'Backend should still have the user while delete request is held');

    held.release({ type: 'fulfill', payload: { status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, message: 'Release after observation' }) } });
    await page.waitForTimeout(400);
  } finally {
    await h.close();
  }
});

test('delete flow: reload during interrupted delete must stay consistent', { concurrency: false }, async () => {
  const h = await createHarness();
  try {
    const page = await h.browser.newPage();
    const controller = createDeleteRouteController(page);
    await signInAsAdmin(page, h.appUrl);
    await openUserManagementTab(page, 'marketers');
    await searchUsers(page, 'Marketer One');
    await confirmDelete(page, 'del-marketer', 'dialog-del-marketer');

    const held = await controller.intercepted;
    await page.reload({ waitUntil: 'domcontentloaded' });
    held.release('failed');
    await signInAsAdmin(page, h.appUrl);
    await openUserManagementTab(page, 'marketers');
    await searchUsers(page, 'Marketer One');
    await page.waitForFunction(() => document.body.innerText.includes('Marketer One'), { timeout: 5000 }).catch(() => {});

    assert.ok(await page.locator('text=Marketer One').count() > 0, 'Reload during failed delete should still show the marketer');
    assert.equal(await backendHasUser(h.adminApi, 'MARK1001'), true, 'Backend should still have the marketer after interrupted delete');

    const state = await readStorageState(page);
    const pendingOps = Array.isArray(state && state.pendingUserCloudOps) ? state.pendingUserCloudOps : [];
    const tombstones = Array.isArray(state && state.deletedUserTombstones) ? state.deletedUserTombstones : [];
    assert.equal(pendingOps.some((op) => String((op && op.wwid) || '').trim().toUpperCase() === 'MARK1001'), false, 'Reload after interrupted delete should not leave a pending delete op');
    assert.equal(tombstones.some((row) => String((row && row.wwid) || '').trim().toUpperCase() === 'MARK1001'), false, 'Reload after interrupted delete should not leave a tombstone');
  } finally {
    await h.close();
  }
});

test('delete flow: retry after failure succeeds cleanly', { concurrency: false }, async () => {
  const h = await createHarness();
  try {
    const page = await h.browser.newPage();
    let failedOnce = false;
    await page.route('**/api/cloud', async (route) => {
      const req = route.request();
      let body = null;
      try {
        body = req.postDataJSON();
      } catch {}
      const isDelete =
        req.method() === 'POST' &&
        body &&
        body.action === 'apply_user_operations' &&
        Array.isArray(body.user_operations) &&
        body.user_operations.some((op) => op && String(op.op || '').trim().toLowerCase() === 'delete_user');
      if (!isDelete) {
        await route.continue();
        return;
      }
      if (!failedOnce) {
        failedOnce = true;
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ ok: false, message: 'Forced first delete failure' }),
        });
        return;
      }
      await route.continue();
    });

    await signInAsAdmin(page, h.appUrl);
    await openUserManagementTab(page, 'marketers');
    await searchUsers(page, 'Marketer One');
    await confirmDelete(page, 'del-marketer', 'dialog-del-marketer');
    await page.waitForTimeout(450);

    assert.ok(await page.locator('text=Marketer One').count() > 0, 'User should still be present after first failed delete');
    assert.equal(await backendHasUser(h.adminApi, 'MARK1001'), true, 'Backend should still have user after first failed delete');
    await dismissDialogIfPresent(page);

    await confirmDelete(page, 'del-marketer', 'dialog-del-marketer');
    await page.waitForTimeout(450);

    assert.equal(await page.locator('text=Marketer One').count(), 0, 'Second delete attempt should remove the user');
    assert.equal(await backendHasUser(h.adminApi, 'MARK1001'), false, 'Backend should remove user after retry success');

    const state = await readStorageState(page);
    const pendingOps = Array.isArray(state && state.pendingUserCloudOps) ? state.pendingUserCloudOps : [];
    const tombstones = Array.isArray(state && state.deletedUserTombstones) ? state.deletedUserTombstones : [];
    assert.equal(pendingOps.some((op) => String((op && op.wwid) || '').trim().toUpperCase() === 'MARK1001'), false, 'Retry success should not leave a pending delete op');
    assert.equal(tombstones.some((row) => String((row && row.wwid) || '').trim().toUpperCase() === 'MARK1001'), false, 'Retry success should not leave a tombstone');
  } finally {
    await h.close();
  }
});

test('delete flow: second session sees the durable final result after refresh', { concurrency: false }, async () => {
  const h = await createHarness();
  try {
    const contextA = await h.browser.newContext();
    const contextB = await h.browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    await signInAsAdmin(pageA, h.appUrl);
    await signInAsAdmin(pageB, h.appUrl);
    await openUserManagementTab(pageA, 'marketers');
    await openUserManagementTab(pageB, 'marketers');
    await searchUsers(pageA, 'Marketer One');
    await searchUsers(pageB, 'Marketer One');
    assert.ok(await pageB.locator('text=Marketer One').count() > 0, 'Second session should initially see the marketer');

    await confirmDelete(pageA, 'del-marketer', 'dialog-del-marketer');
    await pageA.waitForTimeout(450);

    assert.equal(await backendHasUser(h.adminApi, 'MARK1001'), false, 'Backend should remove user after delete in first session');
    await pageB.reload({ waitUntil: 'domcontentloaded' });
    await openUserManagementTab(pageB, 'marketers');
    await searchUsers(pageB, 'Marketer One');
    assert.equal(await pageB.locator('text=Marketer One').count(), 0, 'Second session refresh should not show a ghost user');

    await contextA.close();
    await contextB.close();
  } finally {
    await h.close();
  }
});
