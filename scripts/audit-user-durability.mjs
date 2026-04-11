import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { createRequire } from 'module';
import { productionUrl } from './deploy-config.mjs';

const require = createRequire(import.meta.url);
const { createPoolFromEnv, closePool } = require('../server/db.cjs');
const { latestValidatedBackup } = require('../server/backup-safety.cjs');

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return '';
  return String(process.argv[idx + 1] || '').trim();
}

function positionalArgs() {
  const flagsWithValues = new Set(['--browser-profile', '--origin', '--backend-base-url', '--storage-key', '--out']);
  const out = [];
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = String(process.argv[i] || '').trim();
    if (!arg) continue;
    if (flagsWithValues.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) continue;
    out.push(arg);
  }
  return out;
}

function requestJson(urlText, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlText);
    const transport = url.protocol === 'http:' ? http : https;
    const request = transport.request(
      url,
      { method, headers },
      (response) => {
        let raw = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          raw += chunk;
        });
        response.on('end', () => {
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch {
            parsed = null;
          }
          resolve({ status: response.statusCode || 0, body: parsed, raw });
        });
      },
    );
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function loadSmokeUsers() {
  const filePath = String(process.env.RELEASE_SMOKE_USERS_FILE || '').trim();
  if (filePath && fs.existsSync(filePath)) {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (Array.isArray(parsed)) return parsed;
  }
  const raw = String(process.env.RELEASE_SMOKE_USERS_JSON || '').trim();
  if (raw) {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  }
  return [];
}

function smokeAdminCandidate(entries) {
  return (Array.isArray(entries) ? entries : []).find((entry) => {
    const expected = String((entry && entry.expectedLogin) || 'success').trim().toLowerCase();
    const role = String((entry && entry.role) || '').trim().toLowerCase();
    return role === 'admin' && (expected === 'success' || !expected);
  }) || null;
}

async function signInSmokeAdmin(backendBaseUrl, smokeUser) {
  if (!smokeUser) return { status: 0, body: null, raw: '' };
  const payload = JSON.stringify({
    identifier: smokeUser.identifier,
    password: smokeUser.password,
    role: smokeUser.role,
  });
  return requestJson(`${backendBaseUrl}/api/auth/sign-in`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    },
    body: payload,
  });
}

function normalizeIdentifierKeys(entry = {}) {
  const id = String(entry.id || '').trim();
  const wwid = String(entry.wwid || '').replace(/\s+/g, '').trim().toUpperCase();
  const email = String(entry.email || entry.workEmail || entry.emailOrLogin || '').trim().toLowerCase();
  return { id, wwid, email };
}

function matchesIdentity(left = {}, right = {}) {
  const a = normalizeIdentifierKeys(left);
  const b = normalizeIdentifierKeys(right);
  return (!!a.id && a.id === b.id) || (!!a.wwid && a.wwid === b.wwid) || (!!a.email && a.email === b.email);
}

function summarizeStatuses(rows) {
  const summary = { total: 0, active: 0, inactive: 0, deleted: 0 };
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    summary.total += 1;
    const status = String(row.status || 'active').trim().toLowerCase();
    if (status === 'deleted') summary.deleted += 1;
    else if (status === 'inactive') summary.inactive += 1;
    else summary.active += 1;
  });
  return summary;
}

function hasDbCredentials() {
  return !!String(
    process.env.DATABASE_URL ||
      process.env.PGHOST ||
      process.env.PGUSER ||
      process.env.PGDATABASE ||
      '',
  ).trim();
}

async function loadDbUsersDirect() {
  if (!hasDbCredentials()) return null;
  const pool = createPoolFromEnv();
  try {
    const client = await pool.connect();
    try {
      const result = await client.query(
        'SELECT id, wwid, email, status, role, is_assistant, can_access_manager, manager_only FROM users ORDER BY created_at ASC',
      );
      return result.rows.map((row) => ({
        id: String(row.id || '').trim(),
        wwid: String(row.wwid || '').trim(),
        workEmail: String(row.email || '').trim().toLowerCase(),
        emailOrLogin: String(row.email || '').trim().toLowerCase(),
        status: String(row.status || 'active').trim().toLowerCase(),
        role: String(row.role || 'marketer').trim().toLowerCase(),
        isAssistant: !!row.is_assistant,
        canAccessManager: !!row.can_access_manager,
        managerOnly: !!row.manager_only,
      }));
    } finally {
      client.release();
    }
  } finally {
    await closePool(pool);
  }
}

async function run() {
  const userDataDir = path.resolve(argValue('--browser-profile') || '.tmp_chrome_profile_live');
  const origin = String(argValue('--origin') || productionUrl).trim().replace(/\/+$/, '');
  const backendBaseUrl = String(argValue('--backend-base-url') || 'https://marketingtool-backend-445z.onrender.com').trim().replace(/\/+$/, '');
  const storageKey = String(argValue('--storage-key') || 'premium_pricing_clickable_html_v2').trim();
  const outPath = String(argValue('--out') || '').trim();
  const checkIdentifiers = positionalArgs();

  const context = await chromium.launchPersistentContext(userDataDir, { headless: true, channel: 'chrome' });
  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500);

    const stored = await page.evaluate((key) => {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    }, storageKey);

    const appState = stored && typeof stored === 'object' ? stored : {};
    let sessionId = String((((appState || {}).authSession || {}).cloudSessionId || appState.cloudSessionToken || '')).trim();
    let backendUsers = sessionId
      ? await requestJson(`${backendBaseUrl}/api/users`, {
          headers: { accept: 'application/json', 'x-session-id': sessionId },
        })
      : { status: 0, body: null, raw: '' };
    if (backendUsers.status !== 200) {
      const smokeUser = smokeAdminCandidate(loadSmokeUsers());
      if (smokeUser) {
        const signIn = await signInSmokeAdmin(backendBaseUrl, smokeUser);
        const smokeSessionId = String((signIn.body && signIn.body.session_id) || '').trim();
        if (signIn.status === 200 && smokeSessionId) {
          sessionId = smokeSessionId;
          backendUsers = await requestJson(`${backendBaseUrl}/api/users`, {
            headers: { accept: 'application/json', 'x-session-id': smokeSessionId },
          });
        }
      }
    }
    const localUsers = Array.isArray(appState.users) ? appState.users : [];
    let dbUsers = backendUsers.status === 200 && backendUsers.body && Array.isArray(backendUsers.body.users) ? backendUsers.body.users : null;
    let dbSource = 'backend:/api/users';
    if (!dbUsers) {
      const directUsers = await loadDbUsersDirect();
      if (!directUsers) {
        throw new Error(`Could not read /api/users from backend (${backendUsers.status}) and no DB credentials were available for fallback`);
      }
      dbUsers = directUsers;
      dbSource = 'direct-postgres';
    }
    const pendingOps = Array.isArray(stored.pendingUserCloudOps) ? stored.pendingUserCloudOps : [];

    const localOnlyUsers = localUsers.filter((localUser) => !dbUsers.some((dbUser) => matchesIdentity(localUser, dbUser)));
    const dbOnlyUsers = dbUsers.filter((dbUser) => !localUsers.some((localUser) => matchesIdentity(dbUser, localUser)));
    const queuedOnlyIdentities = pendingOps
      .map((op) => {
        const meta = op && typeof op === 'object' && op.metadata && typeof op.metadata === 'object' ? op.metadata : {};
        return {
          id: String(meta.local_user_id || '').trim(),
          wwid: String(op && op.wwid ? op.wwid : '').trim(),
          email: String(meta.work_email || meta.email || '').trim().toLowerCase(),
          op: String(op && op.op ? op.op : '').trim(),
        };
      })
      .filter((entry) => {
        return (
          !localUsers.some((localUser) => matchesIdentity(entry, localUser)) &&
          !dbUsers.some((dbUser) => matchesIdentity(entry, dbUser))
        );
      });
    const persistedWithPending = dbUsers.filter((dbUser) => {
      return pendingOps.some((op) => matchesIdentity(dbUser, { id: op?.metadata?.local_user_id, wwid: op?.wwid, email: op?.metadata?.work_email || op?.metadata?.email }));
    });

    const lookupChecks = [];
    for (const identifier of checkIdentifiers) {
      for (const role of ['marketer', 'admin', 'manager']) {
        const payload = JSON.stringify({ action: 'auth_lookup', identifier, role });
        const response = await requestJson(`${backendBaseUrl}/api/cloud`, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
          },
          body: payload,
        });
        lookupChecks.push({
          identifier,
          role,
          status: response.status,
          body: response.body,
        });
      }
    }

    const latestBackup = latestValidatedBackup(path.resolve(process.cwd(), 'backups', 'users'));
    const dbStatuses = summarizeStatuses(dbUsers);
    const deletedFromBackup =
      dbSource === 'backend:/api/users' && latestBackup && latestBackup.counts
        ? Number(latestBackup.counts.deleted) || 0
        : dbStatuses.deleted;
    const persistedTotal = dbStatuses.active + dbStatuses.inactive + deletedFromBackup;
    const result = {
      checkedAt: new Date().toISOString(),
      sourceOfTruth:
        dbSource === 'backend:/api/users' && latestBackup
          ? `Postgres users table via ${dbSource} plus latest validated backup for deleted-user totals`
          : `Postgres users table via ${dbSource}`,
      summary: {
        persistedActive: dbStatuses.active,
        persistedInactive: dbStatuses.inactive,
        persistedDeleted: deletedFromBackup,
        localOnly: localOnlyUsers.length,
        queuedOnly: queuedOnlyIdentities.length,
        pending: pendingOps.length,
        persistedWithPending: persistedWithPending.length,
      },
      browserState: {
        storageKey,
        profileDir: userDataDir,
        authRole: appState.role,
        authSessionRole: appState.authSession && appState.authSession.role,
        localUsers: summarizeStatuses(localUsers),
        pendingUserOps: pendingOps.length,
        deletedUserTombstones: Array.isArray(appState.deletedUserTombstones) ? appState.deletedUserTombstones.length : 0,
      },
      postgres: {
        total: persistedTotal,
        statuses: Object.assign({}, dbStatuses, { deleted: deletedFromBackup, total: persistedTotal }),
        source: dbSource,
      },
      classification: {
        persistedInDb: persistedTotal,
        localOnly: localOnlyUsers.length,
        dbOnly: dbOnlyUsers.length,
        queuedOnly: queuedOnlyIdentities.length,
        persistedWithPendingOps: persistedWithPending.length,
      },
      details: {
        localOnlyUsers: localOnlyUsers.map((row) => normalizeIdentifierKeys(row)),
        dbOnlyUsers: dbOnlyUsers.map((row) => normalizeIdentifierKeys(row)),
        queuedOnlyIdentities,
        inactiveDurableUsers: dbUsers
          .filter((row) => String(row.status || '').trim().toLowerCase() === 'inactive')
          .map((row) => ({
            id: row.id,
            wwid: row.wwid,
            email: row.workEmail || row.emailOrLogin || '',
            name: row.name,
          })),
      },
      lookupChecks,
    };

    if (outPath) {
      fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
      fs.writeFileSync(path.resolve(outPath), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    }
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await context.close();
  }
}

run().catch((error) => {
  const message = String((error && error.message) || error || 'Audit failed');
  console.error(`Audit failed: ${message}`);
  process.exit(1);
});
