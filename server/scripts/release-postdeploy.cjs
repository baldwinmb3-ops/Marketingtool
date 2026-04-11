const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const { createPoolFromEnv, closePool } = require('../db.cjs');
const { buildUsersBackupSnapshot, summarizeUsers, loadUsersBackupFile } = require('../user-backup.cjs');
const { databaseLooksProductionLike } = require('../db-safety.cjs');

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return '';
  return String(process.argv[idx + 1] || '').trim();
}

function latestReportPath(baseDir) {
  const dir = path.resolve(baseDir);
  if (!fs.existsSync(dir)) return '';
  const entries = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.report.json'))
    .map((name) => ({
      fullPath: path.join(dir, name),
      mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries[0] ? entries[0].fullPath : '';
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

function loadSmokeUsers(baseUrl) {
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
  const isLocalBaseUrl = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(String(baseUrl || '').trim());
  if (!isLocalBaseUrl || databaseLooksProductionLike()) {
    return [];
  }
  return [
    { identifier: 'ADMIN1001', password: 'Admin123A', role: 'admin', expectedLogin: 'success', expectedDbStatus: 'active' },
    { identifier: 'ADMIN2001', password: 'Assist123A', role: 'admin', expectedLogin: 'success', expectedDbStatus: 'active' },
    { identifier: 'MARK1001', password: 'Marketer123A', role: 'marketer', expectedLogin: 'success', expectedDbStatus: 'active' },
  ];
}

function normalizeSmokeExpectation(value, fallback = 'success') {
  const key = String(value || '').trim().toLowerCase();
  if (key === 'inactive' || key === 'fail_inactive' || key === 'expect_inactive') return 'inactive';
  if (key === 'failure' || key === 'fail' || key === 'error') return 'failure';
  return String(fallback || 'success').trim().toLowerCase() || 'success';
}

function normalizeSmokeIdentifier(value) {
  return String(value || '').trim().toLowerCase();
}

function findSmokeUserInSnapshot(users, sample) {
  const identifier = normalizeSmokeIdentifier(sample.identifier);
  const email = normalizeSmokeIdentifier(sample.email || '');
  const requestedRole = String(sample.role || '').trim().toLowerCase();
  return (Array.isArray(users) ? users : []).find((user) => {
    const userWwid = normalizeSmokeIdentifier(user.wwid || '');
    const userEmail = normalizeSmokeIdentifier(user.email || '');
    let roleMatches = true;
    if (requestedRole === 'manager') {
      roleMatches = !!user.canAccessManager;
    } else if (requestedRole) {
      roleMatches =
        String(user.role || '').trim().toLowerCase() === requestedRole ||
        (requestedRole === 'admin' && !!user.canAccessAdmin) ||
        (requestedRole === 'marketer' && !!user.canAccessMarketer);
    }
    return roleMatches && ((identifier && (userWwid === identifier || userEmail === identifier)) || (email && userEmail === email));
  });
}

function compareCounts(before, after) {
  const keys = Array.from(new Set([...Object.keys(before || {}), ...Object.keys(after || {})])).sort();
  return keys
    .map((key) => ({ key, before: Number(before && before[key]) || 0, after: Number(after && after[key]) || 0 }))
    .filter((row) => row.before !== row.after);
}

function visibleCountsFromBackupFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const payload = loadUsersBackupFile(filePath);
  const users = Array.isArray(payload && payload.users) ? payload.users : [];
  return summarizeUsers(users.filter((row) => String((row && row.status) || 'active').trim().toLowerCase() !== 'deleted'));
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

async function fetchUsersViaSmokeAdmin(baseUrl, smokeUsers) {
  const adminSmoke = (Array.isArray(smokeUsers) ? smokeUsers : []).find((entry) => {
    return normalizeSmokeExpectation(entry && entry.expectedLogin, 'success') === 'success' && String(entry && entry.role || '').trim().toLowerCase() === 'admin';
  });
  if (!adminSmoke) {
    throw new Error('No active admin smoke user is available for postdeploy /api/users verification.');
  }
  const payload = JSON.stringify({
    identifier: adminSmoke.identifier,
    password: adminSmoke.password,
    role: adminSmoke.role,
  });
  const signIn = await requestJson(`${baseUrl}/api/auth/sign-in`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    },
    body: payload,
  });
  if (signIn.status !== 200 || !(signIn.body && signIn.body.ok) || !String(signIn.body.session_id || '').trim()) {
    throw new Error(`Smoke admin sign-in failed for /api/users verification (${signIn.status}).`);
  }
  const usersResponse = await requestJson(`${baseUrl}/api/users`, {
    headers: {
      accept: 'application/json',
      'x-session-id': String(signIn.body.session_id || '').trim(),
    },
  });
  if (usersResponse.status !== 200 || !(usersResponse.body && usersResponse.body.ok) || !Array.isArray(usersResponse.body.users)) {
    throw new Error(`Smoke admin /api/users verification failed (${usersResponse.status}).`);
  }
  return {
    exportedAt: new Date().toISOString(),
    counts: summarizeUsers(usersResponse.body.users),
    users: usersResponse.body.users,
    source: 'backend:/api/users',
  };
}

async function run() {
  const reportPath = path.resolve(
    argValue('--report') || latestReportPath(path.join(process.cwd(), 'backups', 'users', 'predeploy')),
  );
  if (!reportPath || !fs.existsSync(reportPath)) {
    throw new Error('Could not find a predeploy report. Run npm run release:preflight first.');
  }

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const baseUrl = String(
    argValue('--base-url') ||
      process.env.RELEASE_BACKEND_BASE_URL ||
      process.env.TEST_API_BASE_URL ||
      process.env.APP_API_BASE_URL ||
      'http://127.0.0.1:8787',
  )
    .trim()
    .replace(/\/+$/, '');

  const smokeUsers = loadSmokeUsers(baseUrl);
  let pool = null;
  try {
    const currentSnapshot = hasDbCredentials()
      ? await (async () => {
          pool = createPoolFromEnv();
          const snapshot = await buildUsersBackupSnapshot(pool);
          snapshot.source = 'direct-postgres';
          return snapshot;
        })()
      : await fetchUsersViaSmokeAdmin(baseUrl, smokeUsers);
    const comparisonCountsBefore =
      currentSnapshot.source === 'backend:/api/users'
        ? visibleCountsFromBackupFile(report.files && report.files.usersJson) || {}
        : report.counts || {};
    const countDiffs = compareCounts(comparisonCountsBefore, currentSnapshot.counts || {});
    const samples = Array.isArray(report.samples) ? report.samples : [];
    const missingSamples = samples.filter((sample) => {
      return !currentSnapshot.users.some((user) => {
        return (
          (sample.id && user.id === sample.id) ||
          (sample.wwid && user.wwid === sample.wwid) ||
          (sample.email && user.email === sample.email)
        );
      });
    });

    const health = await requestJson(`${baseUrl}/api/health`);
    const signInChecks = [];
    for (const sample of smokeUsers) {
      const expectedLogin = normalizeSmokeExpectation(sample.expectedLogin, 'success');
      const expectedDbStatus = String(sample.expectedDbStatus || (expectedLogin === 'inactive' ? 'inactive' : 'active'))
        .trim()
        .toLowerCase();
      const snapshotUser = findSmokeUserInSnapshot(currentSnapshot.users, sample);
      const payload = JSON.stringify({
        identifier: sample.identifier,
        password: sample.password,
        role: sample.role,
      });
      const signIn = await requestJson(`${baseUrl}/api/auth/sign-in`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
        body: payload,
      });
      signInChecks.push({
        identifier: sample.identifier,
        role: sample.role,
        expectedLogin,
        expectedDbStatus,
        durableUserFound: !!snapshotUser,
        durableUserStatus: snapshotUser ? String(snapshotUser.status || '').trim().toLowerCase() : 'missing',
        ok:
          !!snapshotUser &&
          String(snapshotUser.status || '').trim().toLowerCase() === expectedDbStatus &&
          (expectedLogin === 'success'
            ? signIn.status === 200 && !!(signIn.body && signIn.body.ok)
            : expectedLogin === 'inactive'
              ? signIn.status === 401 && !(signIn.body && signIn.body.ok)
              : signIn.status !== 200 || !(signIn.body && signIn.body.ok)),
        status: signIn.status,
        hasSessionId: !!(signIn.body && signIn.body.session_id),
        message: String((signIn.body && signIn.body.message) || signIn.raw || '').trim(),
      });
    }

    const result = {
      ok:
        health.status === 200 &&
        countDiffs.length === 0 &&
        missingSamples.length === 0 &&
        smokeUsers.length > 0 &&
        signInChecks.every((row) => row.ok),
      checkedAt: currentSnapshot.exportedAt,
      backendBaseUrl: baseUrl,
      smokeUsersConfigured: smokeUsers.length > 0,
      health: {
        status: health.status,
        body: health.body,
      },
      snapshotSource: currentSnapshot.source || (hasDbCredentials() ? 'direct-postgres' : 'backend:/api/users'),
      comparisonCountsBefore,
      countsBefore: report.counts || {},
      countsAfter: currentSnapshot.counts || {},
      countDiffs,
      missingSamples,
      signInChecks,
    };
    if (!smokeUsers.length) {
      result.smokeUsersMessage =
        'No release smoke credentials were provided. Set RELEASE_SMOKE_USERS_FILE or RELEASE_SMOKE_USERS_JSON for production postdeploy sign-in verification.';
    }

    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      process.exitCode = 1;
    }
  } finally {
    if (pool) {
      await closePool(pool);
    }
  }
}

run().catch((error) => {
  const message = String((error && error.message) || error || 'Release postdeploy failed');
  console.error(`Release postdeploy failed: ${message}`);
  process.exit(1);
});
