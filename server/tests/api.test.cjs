const test = require('node:test');
const assert = require('node:assert/strict');

const { newDb } = require('pg-mem');

const { createApp } = require('../app.cjs');
const { closePool, withDb, upsertUserRow, readDb } = require('../db.cjs');
const { hashPassword } = require('../lib.cjs');
const {
  DESTRUCTIVE_PUBLISH_BLOCKED_CODE,
  PUBLISH_BASE_VERSION_STALE_CODE,
  SMOKE_PUBLISH_BLOCKED_CODE,
  buildCatalogScheduleSummary,
  buildRecoveryConfirmationToken,
} = require('../catalog-publish-guard.cjs');

async function listen(serverApp) {
  return await new Promise((resolve, reject) => {
    const server = serverApp.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function readJson(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

function createTransientAggregateError(message = '') {
  return new AggregateError(
    [Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' })],
    message,
  );
}

function installTransientQueryFailure(pool, match) {
  const originalQuery = pool.query.bind(pool);
  let remaining = 1;
  pool.query = async (text, params) => {
    const sql = typeof text === 'string' ? text : String((text && text.text) || '');
    const shouldFail = remaining > 0 && (typeof match === 'function' ? !!match(sql, params) : sql.includes(String(match || '')));
    if (shouldFail) {
      remaining -= 1;
      throw createTransientAggregateError();
    }
    return originalQuery(text, params);
  };
  return () => {
    pool.query = originalQuery;
  };
}

async function setupHarness(appOptions = {}) {
  const mem = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pgAdapter = mem.adapters.createPg();
  const db = new pgAdapter.Pool();
  const finalOptions = appOptions && typeof appOptions === 'object' ? appOptions : {};
  const runtimeInfo =
    finalOptions.runtimeInfo && typeof finalOptions.runtimeInfo === 'object' && !Array.isArray(finalOptions.runtimeInfo)
      ? finalOptions.runtimeInfo
      : {};
  const { app } = await createApp({
    db,
    seedDatabase: false,
    ...finalOptions,
    runtimeInfo: { mode: 'test', persistence: 'pg-mem', degraded: false, ...runtimeInfo },
  });
  const stamp = '2026-04-20T12:00:00.000Z';
  const snapshotPayload = {
    meta: {
      version: 1,
      source: 'test',
      publishedAt: stamp,
      updatedAt: stamp,
    },
    brands: [],
    ticketLines: [],
    resources: [],
    managerCategories: [],
    managerEntries: [],
  };
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS manager_title TEXT NOT NULL DEFAULT ''`);
  await db.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS manager_on_duty BOOLEAN NOT NULL DEFAULT FALSE`);
  await db.query(
    `INSERT INTO users (
       id, display_name, first_name, last_name, wwid, email, phone, role,
       is_assistant, can_access_marketer, can_access_admin, can_access_manager, manager_title, manager_only,
       department_ids, status, is_locked, password_hash, force_password_reset, created_at, updated_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,
       $9,$10,$11,$12,$13,$14,
       $15::jsonb,$16,$17,$18,$19,$20,$21
     )`,
    [
      'user-admin-1',
      'Primary Admin',
      'Primary',
      'Admin',
      'ADMIN1001',
      'admin@premiumapp.local',
      '',
      'admin',
      false,
      true,
      false,
      true,
      'Manager',
      false,
      JSON.stringify([]),
      'active',
      false,
      hashPassword('Admin123A'),
      false,
      stamp,
      stamp,
    ],
  );
  await db.query(
    `INSERT INTO snapshot_published_current (
       id, version, published_at, updated_at, published_by_user_id, payload
     ) VALUES (
       TRUE, $1, $2, $3, $4, $5::jsonb
     )`,
    [1, stamp, stamp, 'user-admin-1', JSON.stringify(snapshotPayload)],
  );
  await db.query(
    `INSERT INTO snapshot_history (
       version, published_at, updated_at, published_by_user_id, payload
     ) VALUES (
       $1, $2, $3, $4, $5::jsonb
     )`,
    [1, stamp, stamp, 'user-admin-1', JSON.stringify(snapshotPayload)],
  );
  await db.query(
    `INSERT INTO snapshot_draft (
       id, updated_at, updated_by_user_id, payload
     ) VALUES (
       TRUE, $1, $2, $3::jsonb
     )`,
    [stamp, 'user-admin-1', JSON.stringify(snapshotPayload)],
  );
  const server = await listen(app);
  const address = server.address();
  return {
    app,
    db,
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    cookie: '',
  };
}

async function teardownHarness(harness) {
  if (harness && harness.server) {
    await new Promise((resolve) => harness.server.close(resolve));
  }
  if (harness && harness.db) {
    await closePool(harness.db);
  }
}

async function requestJson(harness, path, { method = 'GET', body, headers = {}, useAuth = true } = {}) {
  const finalHeaders = {
    ...headers,
  };
  if (body !== undefined) {
    finalHeaders['content-type'] = finalHeaders['content-type'] || 'application/json';
  }
  if (useAuth && harness.cookie) {
    finalHeaders.cookie = harness.cookie;
  }
  const res = await fetch(`${harness.baseUrl}${path}`, {
    method,
    headers: finalHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: res.status,
    headers: res.headers,
    body: await readJson(res),
  };
}

async function signIn(harness, identifier = 'ADMIN1001', password = 'Admin123A', role = 'admin') {
  const response = await requestJson(harness, '/api/auth/sign-in', {
    method: 'POST',
    useAuth: false,
    body: { identifier, password, role },
  });
  const setCookie = response.headers.get('set-cookie') || '';
  harness.cookie = setCookie.split(';')[0];
  assert.equal(response.status, 200, `sign-in should succeed: ${JSON.stringify(response.body)}`);
  assert.equal(response.body.ok, true);
  assert.ok(harness.cookie, 'sign-in should set a session cookie');
  return response;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureBrand(payload, brandId, defaults = {}) {
  if (!Array.isArray(payload.brands)) payload.brands = [];
  let brand = payload.brands.find((entry) => String((entry && entry.id) || '').trim() === String(brandId || '').trim()) || null;
  if (!brand) {
    brand = {
      id: brandId,
      name: String(defaults.name || brandId),
      active: true,
      showScheduleDates: {},
      showScheduleStatus: {},
    };
    payload.brands.push(brand);
  }
  return brand;
}

function setBrandSchedule(payload, brandId, scheduleDates, scheduleStatus = {}, defaults = {}) {
  const brand = ensureBrand(payload, brandId, defaults);
  brand.active = true;
  brand.name = String(defaults.name || brand.name || brandId);
  brand.showScheduleDates = deepClone(scheduleDates);
  brand.showScheduleStatus = deepClone(scheduleStatus);
  return brand;
}

function buildScheduledCatalogPayload(basePayload) {
  const payload = deepClone(basePayload);
  payload.meta = payload.meta && typeof payload.meta === 'object' ? payload.meta : {};
  payload.ticketLines = Array.isArray(payload.ticketLines) ? payload.ticketLines : [];
  payload.resources = Array.isArray(payload.resources) ? payload.resources : [];
  payload.managerCategories = Array.isArray(payload.managerCategories) ? payload.managerCategories : [];
  payload.managerEntries = Array.isArray(payload.managerEntries) ? payload.managerEntries : [];
  payload.phoneDirectoryEntries = Array.isArray(payload.phoneDirectoryEntries) ? payload.phoneDirectoryEntries : [];
  setBrandSchedule(
    payload,
    'brand-medieval-times',
    {
      '2026-06-01': ['7:00 PM', '9:00 PM'],
      '2026-06-02': ['7:00 PM'],
    },
    {
      '2026-06-01': { '9:00 PM': 'soldout' },
    },
    { name: 'Medieval Times' },
  );
  setBrandSchedule(
    payload,
    'brand-carolina-opry',
    {
      '2026-06-03': ['8:00 PM'],
    },
    {},
    { name: 'Carolina Opry' },
  );
  return payload;
}

async function seedPublishedSnapshot(pool, payload, version, options = {}) {
  const stamp = String(options.stamp || `2026-05-01T00:${String(version).padStart(2, '0')}:00.000Z`);
  const userId = String(options.userId || 'user-admin-1');
  const nextPayload = deepClone(payload);
  nextPayload.meta = nextPayload.meta && typeof nextPayload.meta === 'object' ? nextPayload.meta : {};
  nextPayload.meta.version = version;
  nextPayload.meta.lastPublishedCatalogVersion = version;
  nextPayload.meta.publishedAt = stamp;
  nextPayload.meta.lastPublishedAt = stamp;
  nextPayload.meta.updatedAt = stamp;
  await withDb(pool, async (db) => {
    if (!db.snapshots || typeof db.snapshots !== 'object') db.snapshots = {};
    db.snapshots.published = {
      version,
      publishedAt: stamp,
      updatedAt: stamp,
      publishedByUserId: userId,
      payload: deepClone(nextPayload),
    };
    const history = Array.isArray(db.snapshots.history) ? db.snapshots.history.filter((entry) => Number(entry.version) !== Number(version)) : [];
    history.push({
      version,
      publishedAt: stamp,
      updatedAt: stamp,
      publishedByUserId: userId,
      payload: deepClone(nextPayload),
    });
    history.sort((left, right) => Number(left.version || 0) - Number(right.version || 0));
    db.snapshots.history = history;
    db.snapshots.draft = {
      updatedAt: stamp,
      updatedByUserId: userId,
      payload: deepClone(nextPayload),
    };
  });
}

async function latestPublishedSnapshot(harness) {
  const published = await requestJson(harness, '/api/snapshots/published/latest');
  assert.equal(published.status, 200, `published snapshot fetch failed: ${JSON.stringify(published.body)}`);
  return published;
}

async function latestAuditByAction(pool, action) {
  const state = await readDb(pool);
  const rows = Array.isArray(state.audit) ? state.audit.filter((entry) => String(entry.action || '') === String(action || '')) : [];
  return rows.length ? rows[rows.length - 1] : null;
}

async function addSmokePrimaryAdmin(pool, overrides = {}) {
  const password = String(overrides.password || 'Smoke123A');
  const stamp = String(overrides.stamp || '2026-05-01T00:00:00.000Z');
  const wwid = String(overrides.wwid || 'SMOKE9001');
  await upsertUserRow(pool, {
    id: String(overrides.id || 'user-smoke-admin-only-1'),
    displayName: String(overrides.displayName || 'Stage Smoke Admin Only 05137931'),
    firstName: String(overrides.firstName || 'Stage'),
    lastName: String(overrides.lastName || 'Smoke Admin Only 05137931'),
    wwid,
    email: String(overrides.email || 'smoke-admin@example.com'),
    phone: '',
    role: 'admin',
    isAssistant: false,
    canAccessMarketer: false,
    canAccessAdmin: true,
    canAccessManager: false,
    managerTitle: '',
    managerOnly: false,
    departmentIds: [],
    status: 'active',
    isLocked: false,
    passwordHash: hashPassword(password),
    forcePasswordReset: false,
    createdAt: stamp,
    updatedAt: stamp,
  });
  return { identifier: wwid, password };
}

async function addAssistantAdmin(pool, overrides = {}) {
  const password = String(overrides.password || 'Assist123A');
  const stamp = String(overrides.stamp || '2026-05-01T00:00:00.000Z');
  const wwid = String(overrides.wwid || 'ADMIN2001');
  await upsertUserRow(pool, {
    id: String(overrides.id || 'user-admin-2'),
    displayName: String(overrides.displayName || 'Assistant Admin'),
    firstName: String(overrides.firstName || 'Assistant'),
    lastName: String(overrides.lastName || 'Admin'),
    wwid,
    email: String(overrides.email || 'assistant-admin@example.com'),
    phone: '',
    role: 'admin',
    isAssistant: true,
    canAccessMarketer: true,
    canAccessAdmin: true,
    canAccessManager: true,
    managerTitle: '',
    managerOnly: false,
    departmentIds: [],
    status: 'active',
    isLocked: false,
    passwordHash: hashPassword(password),
    forcePasswordReset: false,
    createdAt: stamp,
    updatedAt: stamp,
  });
  return { identifier: wwid, password };
}

async function withEnv(overrides, callback) {
  const keys = Object.keys(overrides || {});
  const previous = new Map();
  keys.forEach((key) => {
    previous.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    const nextValue = overrides[key];
    if (nextValue === undefined || nextValue === null) {
      delete process.env[key];
      return;
    }
    process.env[key] = String(nextValue);
  });
  try {
    return await callback();
  } finally {
    keys.forEach((key) => {
      if (previous.get(key) === undefined) {
        delete process.env[key];
        return;
      }
      process.env[key] = previous.get(key);
    });
  }
}

test('cloud save_and_sync_status returns unknown for an unrecorded request id', async () => {
  const harness = await setupHarness();
  try {
    await signIn(harness);

    const statusInfo = await requestJson(harness, '/api/cloud', {
      method: 'POST',
      body: {
        action: 'save_and_sync_status',
        request_id: 'missing-save-status',
      },
    });

    assert.equal(statusInfo.status, 404, `missing request id status should return 404: ${JSON.stringify(statusInfo.body)}`);
    assert.equal(statusInfo.body.ok, false);
    assert.equal(statusInfo.body.status, 'unknown');
    assert.equal(statusInfo.body.request_id, 'missing-save-status');
    assert.equal(statusInfo.body.message, 'Cloud save request is not recorded yet.');
  } finally {
    await teardownHarness(harness);
  }
});

test('cloud save_and_sync_status returns pending_confirmation for started but unconfirmed requests', async () => {
  const harness = await setupHarness();
  try {
    await signIn(harness);
    const requestId = 'pending-save-status';

    await harness.db.query(
      `INSERT INTO audit_log (id, at, action, actor_user_id, actor_name, target_type, target_id, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        'audit-pending-save-status-started',
        '2026-04-20T16:00:00.000Z',
        'catalog.save_and_send_started',
        'user-admin-1',
        'Primary Admin',
        'snapshot',
        requestId,
        JSON.stringify({
          requestId,
          expectedVersion: 7,
          expectedStamp: '2026-04-20T16:00:00.000Z|7',
        }),
      ],
    );

    const pending = await requestJson(harness, '/api/cloud', {
      method: 'POST',
      body: {
        action: 'save_and_sync_status',
        request_id: requestId,
      },
    });

    assert.equal(pending.status, 202, `pending status should return 202: ${JSON.stringify(pending.body)}`);
    assert.equal(pending.body.ok, false);
    assert.equal(pending.body.status, 'pending_confirmation');
    assert.equal(pending.body.request_id, requestId);
    assert.equal(pending.body.expected_version, 7);
    assert.equal(pending.body.expected_stamp, '2026-04-20T16:00:00.000Z|7');
    assert.equal(pending.body.message, 'Cloud save is still being confirmed.');
  } finally {
    await teardownHarness(harness);
  }
});

test('cloud save_and_sync_status reads audit_log directly without full-state reads', async () => {
  const harness = await setupHarness();
  const requestId = 'pending-save-status-direct-read';
  const originalQuery = harness.db.query.bind(harness.db);
  const originalConnect = harness.db.connect.bind(harness.db);
  const blockFullStateRead = (text) => {
    const sql = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
    return (
      sql === 'select * from users order by created_at asc' ||
      sql === 'select * from snapshot_published_current where id = true limit 1' ||
      sql === 'select * from snapshot_history order by version asc' ||
      sql === 'select * from snapshot_draft where id = true limit 1' ||
      sql === 'select row_data from bookings order by created_at asc' ||
      sql === 'select * from booking_events order by created_at asc'
    );
  };
  try {
    await signIn(harness);
    await harness.db.query(
      `INSERT INTO audit_log (id, at, action, actor_user_id, actor_name, target_type, target_id, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        'audit-pending-save-status-direct-read-started',
        '2026-04-20T16:30:00.000Z',
        'catalog.save_and_send_started',
        'user-admin-1',
        'Primary Admin',
        'snapshot',
        requestId,
        JSON.stringify({
          requestId,
          expectedVersion: 8,
          expectedStamp: '2026-04-20T16:30:00.000Z|8',
        }),
      ],
    );

    harness.db.query = async (text, params) => {
      if (blockFullStateRead(text)) {
        throw new Error(`save_and_sync_status should not use full-state read: ${String(text || '').trim()}`);
      }
      return originalQuery(text, params);
    };
    harness.db.connect = async (...args) => {
      const client = await originalConnect(...args);
      const originalClientQuery = client.query.bind(client);
      client.query = async (text, params) => {
        if (blockFullStateRead(text)) {
          throw new Error(`save_and_sync_status should not use full-state read: ${String(text || '').trim()}`);
        }
        return originalClientQuery(text, params);
      };
      return client;
    };

    const pending = await requestJson(harness, '/api/cloud', {
      method: 'POST',
      body: {
        action: 'save_and_sync_status',
        request_id: requestId,
      },
    });

    assert.equal(pending.status, 202, `pending status should still return 202 without full-state reads: ${JSON.stringify(pending.body)}`);
    assert.equal(pending.body.ok, false);
    assert.equal(pending.body.status, 'pending_confirmation');
    assert.equal(pending.body.request_id, requestId);
  } finally {
    harness.db.query = originalQuery;
    harness.db.connect = originalConnect;
    await teardownHarness(harness);
  }
});

test('cloud save_and_sync_status returns confirmed_failure for failed requests', async () => {
  const harness = await setupHarness();
  try {
    await signIn(harness);
    const requestId = 'failed-save-status';

    await harness.db.query(
      `INSERT INTO audit_log (id, at, action, actor_user_id, actor_name, target_type, target_id, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        'audit-failed-save-status-started',
        '2026-04-20T16:00:00.000Z',
        'catalog.save_and_send_started',
        'user-admin-1',
        'Primary Admin',
        'snapshot',
        requestId,
        JSON.stringify({
          requestId,
          expectedVersion: 7,
          expectedStamp: '2026-04-20T16:00:00.000Z|7',
        }),
      ],
    );

    await harness.db.query(
      `INSERT INTO audit_log (id, at, action, actor_user_id, actor_name, target_type, target_id, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        'audit-failed-save-status-failed',
        '2026-04-20T16:00:05.000Z',
        'catalog.save_and_send_failed',
        'user-admin-1',
        'Primary Admin',
        'snapshot',
        requestId,
        JSON.stringify({
          requestId,
          startedAt: '2026-04-20T16:00:00.000Z',
          code: 'INJECTED_FAILURE',
          message: 'Injected save failure.',
        }),
      ],
    );

    const failed = await requestJson(harness, '/api/cloud', {
      method: 'POST',
      body: {
        action: 'save_and_sync_status',
        request_id: requestId,
      },
    });

    assert.equal(failed.status, 200, `confirmed failure should return 200: ${JSON.stringify(failed.body)}`);
    assert.equal(failed.body.ok, false);
    assert.equal(failed.body.status, 'confirmed_failure');
    assert.equal(failed.body.request_id, requestId);
    assert.equal(failed.body.code, 'INJECTED_FAILURE');
    assert.equal(failed.body.message, 'Injected save failure.');
  } finally {
    await teardownHarness(harness);
  }
});

test('cloud save_and_sync makes a fresh request_id visible before the delayed publish completes and still returns success on the primary request', async () => {
  const requestId = 'delayed-primary-save-status';
  const started = createDeferred();
  const release = createDeferred();
  const harness = await setupHarness({
    testHooks: {
      onSaveAndSendStarted: ({ requestId: hookRequestId }) => {
        if (hookRequestId !== requestId) return undefined;
        started.resolve();
        return release.promise;
      },
    },
  });
  try {
    await signIn(harness);
    const published = await requestJson(harness, '/api/snapshots/published/latest');
    assert.equal(published.status, 200, `published snapshot fetch failed: ${JSON.stringify(published.body)}`);

    const saveSendPromise = requestJson(harness, '/api/cloud', {
      method: 'POST',
      body: {
        action: 'save_and_sync',
        payload: published.body.snapshot,
        request_id: requestId,
      },
    });

    await started.promise;

    const pending = await requestJson(harness, '/api/cloud', {
      method: 'POST',
      body: {
        action: 'save_and_sync_status',
        request_id: requestId,
      },
    });
    assert.equal(pending.status, 202, `fresh request id should be visible while save is in flight: ${JSON.stringify(pending.body)}`);
    assert.equal(pending.body.status, 'pending_confirmation');
    assert.equal(pending.body.request_id, requestId);

    release.resolve();

    const saveSend = await saveSendPromise;
    assert.equal(saveSend.status, 200, `delayed save_and_sync should still complete on the primary request: ${JSON.stringify(saveSend.body)}`);
    assert.equal(saveSend.body.ok, true);
    assert.equal(saveSend.body.status, 'confirmed_success');
    assert.equal(saveSend.body.request_id, requestId);

    const confirmed = await requestJson(harness, '/api/cloud', {
      method: 'POST',
      body: {
        action: 'save_and_sync_status',
        request_id: requestId,
      },
    });
    assert.equal(confirmed.status, 200, `fresh request id should confirm after the save completes: ${JSON.stringify(confirmed.body)}`);
    assert.equal(confirmed.body.ok, true);
    assert.equal(confirmed.body.status, 'confirmed_success');
    assert.equal(confirmed.body.request_id, requestId);
  } finally {
    release.resolve();
    await teardownHarness(harness);
  }
});

test('cloud save_and_sync_status returns confirmed_success for completed save_and_sync requests and replays by request id', async () => {
  const harness = await setupHarness();
  try {
    await signIn(harness);
    const published = await requestJson(harness, '/api/snapshots/published/latest');
    assert.equal(published.status, 200, `published snapshot fetch failed: ${JSON.stringify(published.body)}`);
    const beforeVersion = Number(published.body.metadata && published.body.metadata.version);
    const requestId = 'successful-save-status';

    const saveSend = await requestJson(harness, '/api/cloud', {
      method: 'POST',
      body: {
        action: 'save_and_sync',
        payload: published.body.snapshot,
        request_id: requestId,
      },
    });

    assert.equal(saveSend.status, 200, `save_and_sync should succeed: ${JSON.stringify(saveSend.body)}`);
    assert.equal(saveSend.body.ok, true);
    assert.equal(saveSend.body.status, 'confirmed_success');
    assert.equal(saveSend.body.request_id, requestId);

    const statusInfo = await requestJson(harness, '/api/cloud', {
      method: 'POST',
      body: {
        action: 'save_and_sync_status',
        request_id: requestId,
      },
    });

    assert.equal(statusInfo.status, 200, `save_and_sync_status should confirm success: ${JSON.stringify(statusInfo.body)}`);
    assert.equal(statusInfo.body.ok, true);
    assert.equal(statusInfo.body.status, 'confirmed_success');
    assert.equal(statusInfo.body.request_id, requestId);
    assert.equal(Number(statusInfo.body.version || 0), beforeVersion + 1);

    const replay = await requestJson(harness, '/api/cloud', {
      method: 'POST',
      body: {
        action: 'save_and_sync',
        payload: published.body.snapshot,
        request_id: requestId,
      },
    });

    assert.equal(replay.status, 200, `replayed request id should reuse prior success: ${JSON.stringify(replay.body)}`);
    assert.equal(replay.body.ok, true);
    assert.equal(replay.body.status, 'confirmed_success');
    assert.equal(replay.body.request_id, requestId);

    const afterPublished = await requestJson(harness, '/api/snapshots/published/latest');
    assert.equal(afterPublished.status, 200, `published snapshot fetch after save failed: ${JSON.stringify(afterPublished.body)}`);
    assert.equal(Number(afterPublished.body.metadata && afterPublished.body.metadata.version), beforeVersion + 1);
  } finally {
    await teardownHarness(harness);
  }
});

test('cloud booking_get does not 500 immediately after save_and_sync when the shared read path hits a transient AggregateError', async () => {
  const harness = await setupHarness();
  let restoreQuery = null;
  try {
    await signIn(harness);
    const published = await requestJson(harness, '/api/snapshots/published/latest');
    assert.equal(published.status, 200, `published snapshot fetch failed: ${JSON.stringify(published.body)}`);

    const saveSend = await requestJson(harness, '/api/cloud', {
      method: 'POST',
      body: {
        action: 'save_and_sync',
        payload: published.body.snapshot,
        request_id: 'post-publish-booking-get-retry',
      },
    });
    assert.equal(saveSend.status, 200, `save_and_sync should succeed before booking_get: ${JSON.stringify(saveSend.body)}`);

    restoreQuery = installTransientQueryFailure(harness.db, 'SELECT row_data FROM bookings ORDER BY created_at ASC');

    const bookingGet = await requestJson(harness, '/api/cloud', {
      method: 'POST',
      body: { action: 'booking_get' },
    });

    assert.equal(bookingGet.status, 200, `booking_get should retry the transient AggregateError: ${JSON.stringify(bookingGet.body)}`);
    assert.equal(bookingGet.body.ok, true);
    assert.equal(bookingGet.body.message, 'Cloud booking queue loaded.');
  } finally {
    if (restoreQuery) restoreQuery();
    await teardownHarness(harness);
  }
});

test('cloud catalog_get_live does not 500 immediately after save_and_sync when the shared read path hits a transient AggregateError', async () => {
  const harness = await setupHarness();
  let restoreQuery = null;
  try {
    await signIn(harness);
    const published = await requestJson(harness, '/api/snapshots/published/latest');
    assert.equal(published.status, 200, `published snapshot fetch failed: ${JSON.stringify(published.body)}`);

    const saveSend = await requestJson(harness, '/api/cloud', {
      method: 'POST',
      body: {
        action: 'save_and_sync',
        payload: published.body.snapshot,
        request_id: 'post-publish-catalog-get-retry',
      },
    });
    assert.equal(saveSend.status, 200, `save_and_sync should succeed before catalog_get_live: ${JSON.stringify(saveSend.body)}`);

    restoreQuery = installTransientQueryFailure(harness.db, 'SELECT * FROM snapshot_published_current WHERE id = TRUE LIMIT 1');

    const catalogGet = await requestJson(harness, '/api/cloud', {
      method: 'POST',
      body: { action: 'catalog_get_live' },
    });

    assert.equal(catalogGet.status, 200, `catalog_get_live should retry the transient AggregateError: ${JSON.stringify(catalogGet.body)}`);
    assert.equal(catalogGet.body.ok, true);
    assert.equal(catalogGet.body.message, 'Cloud catalog loaded.');
  } finally {
    if (restoreQuery) restoreQuery();
    await teardownHarness(harness);
  }
});

test('cloud booking_get and catalog_get_live remain stable immediately after a normal save_and_sync', async () => {
  const harness = await setupHarness();
  try {
    await signIn(harness);
    const published = await requestJson(harness, '/api/snapshots/published/latest');
    assert.equal(published.status, 200, `published snapshot fetch failed: ${JSON.stringify(published.body)}`);

    const saveSend = await requestJson(harness, '/api/cloud', {
      method: 'POST',
      body: {
        action: 'save_and_sync',
        payload: published.body.snapshot,
        request_id: 'post-publish-follow-up-stability',
      },
    });
    assert.equal(saveSend.status, 200, `save_and_sync should succeed before follow-up reads: ${JSON.stringify(saveSend.body)}`);
    assert.equal(saveSend.body.ok, true);

    const bookingGet = await requestJson(harness, '/api/cloud', {
      method: 'POST',
      body: { action: 'booking_get' },
    });
    assert.equal(bookingGet.status, 200, `booking_get should remain stable after save_and_sync: ${JSON.stringify(bookingGet.body)}`);
    assert.equal(bookingGet.body.ok, true);

    const catalogGet = await requestJson(harness, '/api/cloud', {
      method: 'POST',
      body: { action: 'catalog_get_live' },
    });
    assert.equal(catalogGet.status, 200, `catalog_get_live should remain stable after save_and_sync: ${JSON.stringify(catalogGet.body)}`);
    assert.equal(catalogGet.body.ok, true);
  } finally {
    await teardownHarness(harness);
  }
});

test('cloud booking_save preserves tour scheduling fields for existing booking rows', async () => {
  const harness = await setupHarness();
  try {
    await signIn(harness);
    const stamp = '2026-05-10T00:00:00.000Z';
    await withDb(harness.db, async (db) => {
      db.bookings = [
        {
          id: 'booking-tour-fields-1',
          brandId: 'brand-pirates-voyage',
          brandName: 'Pirates Voyage',
          showDate: '2026-05-10',
          showTime: '6:00 PM',
          primaryShowDate: '2026-05-10',
          primaryShowTime: '6:00 PM',
          backupShowDate: '2026-05-11',
          backupShowTime: '6:00 PM',
          tourNumber: '1234',
          status: 'done',
          snapshotVersion: 1,
          quoteLines: [],
          authoritativeTotals: {},
          commissionProfit: 0,
          createdAt: stamp,
          updatedAt: stamp,
          revision: 1,
        },
      ];
    });

    const save = await requestJson(harness, '/api/cloud', {
      method: 'POST',
      body: {
        action: 'booking_save',
        payload: {
          meta: { source: 'booking-requests', updatedAt: stamp, version: 1 },
          requests: [
            {
              id: 'booking-tour-fields-1',
              brandId: 'brand-pirates-voyage',
              brandName: 'Pirates Voyage',
              showDate: '2026-05-10',
              showTime: '6:00 PM',
              primaryShowDate: '2026-05-10',
              primaryShowTime: '6:00 PM',
              backupShowDate: '2026-05-11',
              backupShowTime: '6:00 PM',
              tourNumber: '1234',
              guestEmail: 'guest@example.com',
              tourDate: '2026-05-10',
              tourLocation: 'Frontline',
              tourTime: '9:00 AM',
              additionalNotes: 'Window seat requested.',
              status: 'done',
              snapshotVersion: 1,
              quoteLines: [],
              createdAt: stamp,
              updatedAt: stamp,
              revision: 1,
            },
          ],
        },
      },
    });

    assert.equal(save.status, 200, `booking_save should preserve tour fields: ${JSON.stringify(save.body)}`);
    assert.equal(save.body.ok, true);

    const bookingGet = await requestJson(harness, '/api/cloud', {
      method: 'POST',
      body: { action: 'booking_get' },
    });

    assert.equal(bookingGet.status, 200, `booking_get should succeed after booking_save: ${JSON.stringify(bookingGet.body)}`);
    assert.equal(bookingGet.body.ok, true);
    const rows = (((bookingGet.body || {}).row || {}).payload || {}).requests || [];
    const row = rows.find((entry) => String((entry && entry.id) || '').trim() === 'booking-tour-fields-1') || null;
    assert.ok(row, 'Expected saved booking row in booking_get payload');
    assert.equal(row.guestEmail, 'guest@example.com');
    assert.equal(row.tourDate, '2026-05-10');
    assert.equal(row.tourLocation, 'Frontline');
    assert.equal(row.tourTime, '9:00 AM');
    assert.equal(row.additionalNotes, 'Window seat requested.');
  } finally {
    await teardownHarness(harness);
  }
});

test('cloud booking_save preserves marketer cancel reasons and blocks admin claim on canceled requests', async () => {
  const harness = await setupHarness();
  try {
    await signIn(harness);
    const stamp = '2026-05-10T01:00:00.000Z';
    await withDb(harness.db, async (db) => {
      db.bookings = [
        {
          id: 'booking-cloud-cancel-1',
          brandId: 'brand-pirates-voyage',
          brandName: 'Pirates Voyage',
          showDate: '2026-05-10',
          showTime: '6:00 PM',
          primaryShowDate: '2026-05-10',
          primaryShowTime: '6:00 PM',
          backupShowDate: '2026-05-11',
          backupShowTime: '6:00 PM',
          tourNumber: 'TOUR-CANCEL-1',
          guestFirstName: 'Canceled',
          guestLastName: 'Guest',
          status: 'pending',
          snapshotVersion: 1,
          quoteLines: [],
          authoritativeTotals: {},
          commissionProfit: 0,
          createdAt: stamp,
          updatedAt: stamp,
          revision: 1,
        },
      ];
    });

    const cancelReason = 'Guest called to cancel after changing travel plans.';
    const canceledAt = '2026-05-10T01:05:00.000Z';
    const cancelSave = await requestJson(harness, '/api/cloud', {
      method: 'POST',
      body: {
        action: 'booking_save',
        payload: {
          meta: { source: 'booking-requests', updatedAt: canceledAt, version: 1 },
          requests: [
            {
              id: 'booking-cloud-cancel-1',
              brandId: 'brand-pirates-voyage',
              brandName: 'Pirates Voyage',
              showDate: '2026-05-10',
              showTime: '6:00 PM',
              primaryShowDate: '2026-05-10',
              primaryShowTime: '6:00 PM',
              backupShowDate: '2026-05-11',
              backupShowTime: '6:00 PM',
              tourNumber: 'TOUR-CANCEL-1',
              guestFirstName: 'Canceled',
              guestLastName: 'Guest',
              status: 'canceled',
              cancelReason,
              canceledByName: 'Marketer One',
              canceledByUserId: 'user-marketer-1',
              canceledByDevice: 'marketer-web',
              canceledAt,
              statusAt: canceledAt,
              snapshotVersion: 1,
              quoteLines: [],
              createdAt: stamp,
              updatedAt: canceledAt,
              revision: 1,
            },
          ],
        },
      },
    });

    assert.equal(cancelSave.status, 200, `Canceled booking_save failed: ${JSON.stringify(cancelSave.body)}`);
    assert.equal(cancelSave.body.ok, true);
    const cancelRows = (((cancelSave.body || {}).row || {}).payload || {}).requests || [];
    const canceledRow = cancelRows.find((entry) => String((entry && entry.id) || '').trim() === 'booking-cloud-cancel-1');
    assert.ok(canceledRow, 'Canceled row should remain in booking_save response.');
    assert.equal(canceledRow.status, 'canceled');
    assert.equal(canceledRow.cancelReason, cancelReason);
    assert.equal(canceledRow.canceledByName, 'Marketer One');
    assert.equal(canceledRow.canceledByDevice, 'marketer-web');

    const bookingGet = await requestJson(harness, '/api/cloud', {
      method: 'POST',
      body: { action: 'booking_get' },
    });

    assert.equal(bookingGet.status, 200, `booking_get after cancel failed: ${JSON.stringify(bookingGet.body)}`);
    assert.equal(bookingGet.body.ok, true);
    const fetchedRows = (((bookingGet.body || {}).row || {}).payload || {}).requests || [];
    const fetchedCanceled = fetchedRows.find((entry) => String((entry && entry.id) || '').trim() === 'booking-cloud-cancel-1');
    assert.ok(fetchedCanceled, 'booking_get should keep canceled rows visible.');
    assert.equal(fetchedCanceled.status, 'canceled');
    assert.equal(fetchedCanceled.cancelReason, cancelReason);
    assert.equal(fetchedCanceled.canceledAt, canceledAt);

    const directClaim = await requestJson(harness, '/api/bookings/booking-cloud-cancel-1/claim', {
      method: 'POST',
      body: { actor_device: 'admin-direct' },
    });
    assert.equal(directClaim.status, 409, `Direct claim should be blocked for canceled rows: ${JSON.stringify(directClaim.body)}`);
    assert.equal(directClaim.body.reason, 'already-canceled');

    const cloudClaim = await requestJson(harness, '/api/cloud', {
      method: 'POST',
      body: {
        action: 'booking_claim',
        request_id: 'booking-cloud-cancel-1',
        actor_device: 'admin-cloud',
      },
    });
    assert.equal(cloudClaim.status, 200, `Cloud claim request failed unexpectedly: ${JSON.stringify(cloudClaim.body)}`);
    assert.equal(cloudClaim.body.ok, false);
    assert.equal(cloudClaim.body.reason, 'already-canceled');
  } finally {
    await teardownHarness(harness);
  }
});

test('cloud health_check and auth_lookup still behave unchanged with save_and_sync_status support', async () => {
  const harness = await setupHarness();
  try {
    await signIn(harness);

    const health = await requestJson(harness, '/api/cloud', {
      method: 'POST',
      body: { action: 'health_check' },
    });
    assert.equal(health.status, 200, `health_check should still succeed: ${JSON.stringify(health.body)}`);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.configured, true);

    const lookup = await requestJson(harness, '/api/cloud', {
      method: 'POST',
      body: {
        action: 'auth_lookup',
        identifier: 'ADMIN1001',
        role: 'admin',
      },
    });
    assert.equal(lookup.status, 200, `auth_lookup should still succeed: ${JSON.stringify(lookup.body)}`);
    assert.equal(lookup.body.ok, true);
    assert.equal(lookup.body.found, true);
    assert.equal(lookup.body.account_state, 'ready');
  } finally {
    await teardownHarness(harness);
  }
});

test('cloud save_and_sync allows publish when existing schedules are preserved', async () => {
  const harness = await setupHarness();
  try {
    await signIn(harness);
    const initial = await latestPublishedSnapshot(harness);
    const scheduledPayload = buildScheduledCatalogPayload(initial.body.snapshot);
    await seedPublishedSnapshot(harness.db, scheduledPayload, 2);

    const current = await latestPublishedSnapshot(harness);
    const beforeCounts = buildCatalogScheduleSummary(current.body.snapshot).counts;
    const saveSend = await requestJson(harness, '/api/cloud', {
      method: 'POST',
      body: {
        action: 'save_and_sync',
        request_id: 'preserve-schedules-publish',
        payload: deepClone(current.body.snapshot),
      },
    });

    assert.equal(saveSend.status, 200, `Schedule-preserving publish should pass: ${JSON.stringify(saveSend.body)}`);
    assert.equal(saveSend.body.ok, true);
    assert.equal(saveSend.body.status, 'confirmed_success');

    const afterPublished = await latestPublishedSnapshot(harness);
    assert.equal(Number(afterPublished.body.metadata && afterPublished.body.metadata.version), 3);
    assert.deepEqual(buildCatalogScheduleSummary(afterPublished.body.snapshot).counts, beforeCounts);
  } finally {
    await teardownHarness(harness);
  }
});

test('cloud save_and_sync allows unrelated brand edits without schedule loss', async () => {
  const harness = await setupHarness();
  try {
    await signIn(harness);
    const initial = await latestPublishedSnapshot(harness);
    const scheduledPayload = buildScheduledCatalogPayload(initial.body.snapshot);
    await seedPublishedSnapshot(harness.db, scheduledPayload, 2);

    const current = await latestPublishedSnapshot(harness);
    const payload = deepClone(current.body.snapshot);
    const medieval = ensureBrand(payload, 'brand-medieval-times', { name: 'Medieval Times' });
    medieval.marketerSearchLabel = 'Medieval Times Search Updated';
    const beforeCounts = buildCatalogScheduleSummary(current.body.snapshot).counts;

    const saveSend = await requestJson(harness, '/api/cloud', {
      method: 'POST',
      body: {
        action: 'save_and_sync',
        request_id: 'unrelated-brand-edit-publish',
        payload,
      },
    });

    assert.equal(saveSend.status, 200, `Unrelated brand edit should publish: ${JSON.stringify(saveSend.body)}`);
    assert.equal(saveSend.body.ok, true);

    const afterPublished = await latestPublishedSnapshot(harness);
    const updatedBrand = (afterPublished.body.snapshot.brands || []).find((entry) => String((entry && entry.id) || '') === 'brand-medieval-times');
    assert.ok(updatedBrand, 'Expected Medieval Times in published payload');
    assert.equal(updatedBrand.marketerSearchLabel, 'Medieval Times Search Updated');
    assert.deepEqual(buildCatalogScheduleSummary(afterPublished.body.snapshot).counts, beforeCounts);
  } finally {
    await teardownHarness(harness);
  }
});

test('cloud save_and_sync allows additive schedule updates', async () => {
  const harness = await setupHarness();
  try {
    await signIn(harness);
    const initial = await latestPublishedSnapshot(harness);
    const scheduledPayload = buildScheduledCatalogPayload(initial.body.snapshot);
    await seedPublishedSnapshot(harness.db, scheduledPayload, 2);

    const current = await latestPublishedSnapshot(harness);
    const payload = deepClone(current.body.snapshot);
    const medieval = ensureBrand(payload, 'brand-medieval-times', { name: 'Medieval Times' });
    medieval.showScheduleDates['2026-06-02'].push('9:30 PM');
    const beforeCounts = buildCatalogScheduleSummary(current.body.snapshot).counts;

    const saveSend = await requestJson(harness, '/api/cloud', {
      method: 'POST',
      body: {
        action: 'save_and_sync',
        request_id: 'add-schedule-time-publish',
        payload,
      },
    });

    assert.equal(saveSend.status, 200, `Additive schedule publish should pass: ${JSON.stringify(saveSend.body)}`);
    assert.equal(saveSend.body.ok, true);

    const afterPublished = await latestPublishedSnapshot(harness);
    const afterCounts = buildCatalogScheduleSummary(afterPublished.body.snapshot).counts;
    assert.equal(afterCounts.totalScheduleSlots, beforeCounts.totalScheduleSlots + 1);
    assert.equal(afterCounts.scheduledBrandCount, beforeCounts.scheduledBrandCount);
  } finally {
    await teardownHarness(harness);
  }
});

test('cloud save_and_sync allows status-only removal when the dated slot is preserved', async () => {
  const harness = await setupHarness();
  try {
    await signIn(harness);
    const initial = await latestPublishedSnapshot(harness);
    const scheduledPayload = buildScheduledCatalogPayload(initial.body.snapshot);
    const medievalSeed = ensureBrand(scheduledPayload, 'brand-medieval-times', { name: 'Medieval Times' });
    medievalSeed.showScheduleWeekly = {
      '1': ['7:00 PM', '9:00 PM'],
      '2': ['7:00 PM'],
    };
    medievalSeed.showScheduleStatus = {
      '2026-06-01': { '7:00 PM': 'limited', '9:00 PM': 'soldout' },
    };
    await seedPublishedSnapshot(harness.db, scheduledPayload, 2);

    const current = await latestPublishedSnapshot(harness);
    const payload = deepClone(current.body.snapshot);
    const medieval = ensureBrand(payload, 'brand-medieval-times', { name: 'Medieval Times' });
    const liveMedieval = ensureBrand(current.body.snapshot, 'brand-medieval-times', { name: 'Medieval Times' });
    medieval.showScheduleStatus = {
      '2026-06-01': { '9:00 PM': 'soldout' },
    };
    const beforeCounts = buildCatalogScheduleSummary(current.body.snapshot).counts;

    const saveSend = await requestJson(harness, '/api/cloud', {
      method: 'POST',
      body: {
        action: 'save_and_sync',
        request_id: 'status-only-clear-preserved-slot',
        payload,
      },
    });

    assert.equal(saveSend.status, 200, `Status-only removal should publish: ${JSON.stringify(saveSend.body)}`);
    assert.equal(saveSend.body.ok, true);
    assert.equal(saveSend.body.status, 'confirmed_success');

    const afterPublished = await latestPublishedSnapshot(harness);
    const afterMedieval = ensureBrand(afterPublished.body.snapshot, 'brand-medieval-times', { name: 'Medieval Times' });
    const afterCounts = buildCatalogScheduleSummary(afterPublished.body.snapshot).counts;
    assert.deepEqual(afterMedieval.showScheduleDates, liveMedieval.showScheduleDates, 'Status-only publish must preserve the live showScheduleDates.');
    assert.deepEqual(afterMedieval.showScheduleWeekly || {}, liveMedieval.showScheduleWeekly || {}, 'Status-only publish must preserve the live showScheduleWeekly.');
    assert.deepEqual(
      afterMedieval.showScheduleStatus || {},
      { '2026-06-01': { '9:00 PM': 'soldout' } },
      'Status-only publish must remove only the intended status override.',
    );
    assert.equal(afterCounts.totalScheduleSlots, beforeCounts.totalScheduleSlots, 'Status-only publish must preserve total schedule slot count.');
    assert.equal(afterCounts.scheduledBrandCount, beforeCounts.scheduledBrandCount, 'Status-only publish must preserve scheduled brand count.');
    assert.equal(afterCounts.totalStatusEntries, beforeCounts.totalStatusEntries - 1, 'Status-only publish should remove only the intended status entry.');
    assert.equal(afterCounts.totalWeeklySlots, beforeCounts.totalWeeklySlots, 'Status-only publish must preserve weekly schedule slot count.');
  } finally {
    await teardownHarness(harness);
  }
});

test('cloud save_and_sync blocks removing a whole live show date and its slot status', async () => {
  const harness = await setupHarness();
  try {
    await signIn(harness);
    const initial = await latestPublishedSnapshot(harness);
    const scheduledPayload = buildScheduledCatalogPayload(initial.body.snapshot);
    const medievalSeed = ensureBrand(scheduledPayload, 'brand-medieval-times', { name: 'Medieval Times' });
    medievalSeed.showScheduleWeekly = {
      '1': ['7:00 PM', '9:00 PM'],
      '2': ['7:00 PM'],
    };
    medievalSeed.showScheduleStatus = {
      '2026-06-01': { '9:00 PM': 'soldout' },
      '2026-06-02': { '7:00 PM': 'limited' },
    };
    await seedPublishedSnapshot(harness.db, scheduledPayload, 2);
    const beforeState = await readDb(harness.db);

    const current = await latestPublishedSnapshot(harness);
    const payload = deepClone(current.body.snapshot);
    const medieval = ensureBrand(payload, 'brand-medieval-times', { name: 'Medieval Times' });
    delete medieval.showScheduleDates['2026-06-02'];
    delete medieval.showScheduleStatus['2026-06-02'];

    const saveSend = await requestJson(harness, '/api/cloud', {
      method: 'POST',
      body: {
        action: 'save_and_sync',
        request_id: 'remove-live-show-date-and-status',
        payload,
      },
    });

    assert.equal(saveSend.status, 409, `Whole-date removal should be blocked: ${JSON.stringify(saveSend.body)}`);
    assert.equal(saveSend.body.ok, false);
    assert.equal(saveSend.body.code, DESTRUCTIVE_PUBLISH_BLOCKED_CODE);
    const affected = Array.isArray(saveSend.body.affected_brands) ? saveSend.body.affected_brands : [];
    const medievalImpact = affected.find((entry) => String(entry.id || '') === 'brand-medieval-times');
    assert.ok(medievalImpact, `Expected Medieval Times in affected brands: ${JSON.stringify(affected)}`);
    assert.equal(Number(medievalImpact.removedScheduleSlotCount || 0) >= 1, true, `Expected removed dated slot count: ${JSON.stringify(medievalImpact)}`);
    assert.equal(Number(medievalImpact.removedStatusEntryCount || 0) >= 1, true, `Expected removed status count: ${JSON.stringify(medievalImpact)}`);
    assert.ok(
      Array.isArray(medievalImpact.removedScheduleSlotsSample) && medievalImpact.removedScheduleSlotsSample.includes('2026-06-02|7:00 PM'),
      `Expected removed dated slot sample for 2026-06-02 7:00 PM: ${JSON.stringify(medievalImpact)}`,
    );

    const afterPublished = await latestPublishedSnapshot(harness);
    assert.equal(Number(afterPublished.body.metadata && afterPublished.body.metadata.version), 2);
    assert.deepEqual(afterPublished.body.snapshot, beforeState.snapshots.published.payload);

    const afterState = await readDb(harness.db);
    assert.deepEqual(afterState.snapshots.draft.payload, beforeState.snapshots.draft.payload);
  } finally {
    await teardownHarness(harness);
  }
});

test('cloud save_and_sync blocks removing weekly schedule templates even when dated slots remain', async () => {
  const harness = await setupHarness();
  try {
    await signIn(harness);
    const initial = await latestPublishedSnapshot(harness);
    const scheduledPayload = buildScheduledCatalogPayload(initial.body.snapshot);
    const medievalSeed = ensureBrand(scheduledPayload, 'brand-medieval-times', { name: 'Medieval Times' });
    medievalSeed.showScheduleWeekly = {
      '1': ['7:00 PM', '9:00 PM'],
      '2': ['7:00 PM'],
    };
    await seedPublishedSnapshot(harness.db, scheduledPayload, 2);
    const beforeState = await readDb(harness.db);

    const current = await latestPublishedSnapshot(harness);
    const payload = deepClone(current.body.snapshot);
    const medieval = ensureBrand(payload, 'brand-medieval-times', { name: 'Medieval Times' });
    medieval.showScheduleWeekly = {
      '1': ['7:00 PM', '9:00 PM'],
    };

    const saveSend = await requestJson(harness, '/api/cloud', {
      method: 'POST',
      body: {
        action: 'save_and_sync',
        request_id: 'remove-weekly-template-only',
        payload,
      },
    });

    assert.equal(saveSend.status, 409, `Weekly schedule removal should be blocked: ${JSON.stringify(saveSend.body)}`);
    assert.equal(saveSend.body.ok, false);
    assert.equal(saveSend.body.code, DESTRUCTIVE_PUBLISH_BLOCKED_CODE);
    const affected = Array.isArray(saveSend.body.affected_brands) ? saveSend.body.affected_brands : [];
    const medievalImpact = affected.find((entry) => String(entry.id || '') === 'brand-medieval-times');
    assert.ok(medievalImpact, `Expected Medieval Times in affected brands: ${JSON.stringify(affected)}`);
    assert.equal(Number(medievalImpact.removedScheduleSlotCount || 0), 0, `Weekly-only removal should not report removed dated slots: ${JSON.stringify(medievalImpact)}`);
    assert.equal(Number(medievalImpact.removedWeeklySlotCount || 0) >= 1, true, `Expected removed weekly slot count: ${JSON.stringify(medievalImpact)}`);
    assert.ok(
      Array.isArray(medievalImpact.removedWeeklySlotsSample) && medievalImpact.removedWeeklySlotsSample.includes('2|7:00 PM'),
      `Expected removed weekly slot sample for weekday 2 at 7:00 PM: ${JSON.stringify(medievalImpact)}`,
    );

    const afterPublished = await latestPublishedSnapshot(harness);
    assert.equal(Number(afterPublished.body.metadata && afterPublished.body.metadata.version), 2);
    assert.deepEqual(afterPublished.body.snapshot, beforeState.snapshots.published.payload);

    const afterState = await readDb(harness.db);
    assert.deepEqual(afterState.snapshots.draft.payload, beforeState.snapshots.draft.payload);
  } finally {
    await teardownHarness(harness);
  }
});

test('cloud save_and_sync blocks destructive schedule loss on an unrelated scheduled brand in the same payload', async () => {
  const harness = await setupHarness();
  try {
    await signIn(harness);
    const initial = await latestPublishedSnapshot(harness);
    const scheduledPayload = buildScheduledCatalogPayload(initial.body.snapshot);
    await seedPublishedSnapshot(harness.db, scheduledPayload, 2);
    const beforeState = await readDb(harness.db);

    const current = await latestPublishedSnapshot(harness);
    const payload = deepClone(current.body.snapshot);
    const carolina = ensureBrand(payload, 'brand-carolina-opry', { name: 'Carolina Opry' });
    const medieval = ensureBrand(payload, 'brand-medieval-times', { name: 'Medieval Times' });
    medieval.marketerSearchLabel = 'Medieval Times Search Updated';
    carolina.showScheduleDates = {};
    carolina.showScheduleStatus = {};

    const saveSend = await requestJson(harness, '/api/cloud', {
      method: 'POST',
      body: {
        action: 'save_and_sync',
        request_id: 'unrelated-brand-destructive-loss',
        payload,
      },
    });

    assert.equal(saveSend.status, 409, `Unrelated destructive brand loss should be blocked: ${JSON.stringify(saveSend.body)}`);
    assert.equal(saveSend.body.ok, false);
    assert.equal(saveSend.body.code, DESTRUCTIVE_PUBLISH_BLOCKED_CODE);
    assert.ok(
      Array.isArray(saveSend.body.affected_brands) &&
        saveSend.body.affected_brands.some((entry) => String(entry.id || '') === 'brand-carolina-opry'),
      `Expected Carolina Opry in affected brands: ${JSON.stringify(saveSend.body.affected_brands)}`,
    );

    const afterPublished = await latestPublishedSnapshot(harness);
    assert.equal(Number(afterPublished.body.metadata && afterPublished.body.metadata.version), 2);
    assert.deepEqual(afterPublished.body.snapshot, beforeState.snapshots.published.payload);

    const afterState = await readDb(harness.db);
    assert.deepEqual(afterState.snapshots.draft.payload, beforeState.snapshots.draft.payload);
  } finally {
    await teardownHarness(harness);
  }
});

test('cloud save_and_sync blocks destructive schedule loss and leaves published and draft unchanged', async () => {
  const harness = await setupHarness();
  try {
    await signIn(harness);
    const initial = await latestPublishedSnapshot(harness);
    const scheduledPayload = buildScheduledCatalogPayload(initial.body.snapshot);
    await seedPublishedSnapshot(harness.db, scheduledPayload, 2);

    const current = await latestPublishedSnapshot(harness);
    const payload = deepClone(current.body.snapshot);
    const medieval = ensureBrand(payload, 'brand-medieval-times', { name: 'Medieval Times' });
    medieval.showScheduleDates = {};
    medieval.showScheduleStatus = {};
    const beforeState = await readDb(harness.db);

    const saveSend = await requestJson(harness, '/api/cloud', {
      method: 'POST',
      body: {
        action: 'save_and_sync',
        request_id: 'destructive-schedule-loss',
        payload,
      },
    });

    assert.equal(saveSend.status, 409, `Destructive publish should be blocked: ${JSON.stringify(saveSend.body)}`);
    assert.equal(saveSend.body.ok, false);
    assert.equal(saveSend.body.code, DESTRUCTIVE_PUBLISH_BLOCKED_CODE);
    assert.equal(saveSend.body.message, 'Publish blocked because it would remove existing show dates/times. Use explicit restore mode if this is intentional disaster recovery.');
    assert.ok(
      Array.isArray(saveSend.body.affected_brands) &&
        saveSend.body.affected_brands.some((entry) => String(entry.id || '') === 'brand-medieval-times'),
      `Expected Medieval Times in affected brands: ${JSON.stringify(saveSend.body.affected_brands)}`,
    );

    const afterPublished = await latestPublishedSnapshot(harness);
    assert.equal(Number(afterPublished.body.metadata && afterPublished.body.metadata.version), 2);
    assert.deepEqual(afterPublished.body.snapshot, beforeState.snapshots.published.payload);

    const afterState = await readDb(harness.db);
    assert.deepEqual(afterState.snapshots.draft.payload, beforeState.snapshots.draft.payload);

    const audit = await latestAuditByAction(harness.db, 'catalog.save_and_send_failed');
    assert.ok(audit, 'Expected blocked destructive publish audit entry');
    assert.equal(String((audit.details && audit.details.code) || ''), DESTRUCTIVE_PUBLISH_BLOCKED_CODE);
    assert.ok(
      Array.isArray(audit.details && audit.details.affectedBrands) &&
        audit.details.affectedBrands.some((entry) => String(entry.id || '') === 'brand-medieval-times'),
      `Expected destructive audit details for Medieval Times: ${JSON.stringify(audit && audit.details)}`,
    );
  } finally {
    await teardownHarness(harness);
  }
});

test('cloud save_and_sync blocks stale 73-brand seed/default payload before publish', async () => {
  const harness = await setupHarness();
  try {
    await signIn(harness);
    const initial = await latestPublishedSnapshot(harness);
    const staleSeedPayload = deepClone(initial.body.snapshot);
    staleSeedPayload.brands = Array.from({ length: 73 }, (_, index) => ({
      id: `brand-seed-${index + 1}`,
      name: `Seed Brand ${index + 1}`,
      active: true,
      showScheduleDates: {},
      showScheduleStatus: {},
    }));
    const scheduledPayload = buildScheduledCatalogPayload(initial.body.snapshot);
    await seedPublishedSnapshot(harness.db, scheduledPayload, 2);
    const beforeState = await readDb(harness.db);

    const saveSend = await requestJson(harness, '/api/cloud', {
      method: 'POST',
      body: {
        action: 'save_and_sync',
        request_id: 'stale-seed-default-publish',
        payload: staleSeedPayload,
      },
    });

    assert.equal(saveSend.status, 409, `Stale seed payload should be blocked: ${JSON.stringify(saveSend.body)}`);
    assert.equal(saveSend.body.ok, false);
    assert.equal(saveSend.body.code, PUBLISH_BASE_VERSION_STALE_CODE);
    assert.equal(saveSend.body.current_published_version, 2);
    assert.equal(saveSend.body.base_snapshot_version, 1);

    const afterPublished = await latestPublishedSnapshot(harness);
    assert.equal(Number(afterPublished.body.metadata && afterPublished.body.metadata.version), 2);
    assert.deepEqual(afterPublished.body.snapshot, beforeState.snapshots.published.payload);

    const afterState = await readDb(harness.db);
    assert.deepEqual(afterState.snapshots.draft.payload, beforeState.snapshots.draft.payload);

    const audit = await latestAuditByAction(harness.db, 'catalog.save_and_send_failed');
    assert.ok(audit, 'Expected stale publish rejection audit entry');
    assert.equal(String((audit.details && audit.details.code) || ''), PUBLISH_BASE_VERSION_STALE_CODE);
    assert.equal(Number((audit.details && audit.details.currentVersion) || 0), 2);
    assert.equal(Number((audit.details && audit.details.baseVersion) || 0), 1);
  } finally {
    await teardownHarness(harness);
  }
});

test('admin publish allows schedule-preserving publish when base version matches current', async () => {
  const harness = await setupHarness();
  try {
    await signIn(harness);
    const initial = await latestPublishedSnapshot(harness);
    const scheduledPayload = buildScheduledCatalogPayload(initial.body.snapshot);
    await seedPublishedSnapshot(harness.db, scheduledPayload, 2);

    const safePayload = deepClone(scheduledPayload);
    const brandId = safePayload.brands[0] && safePayload.brands[0].id;
    const brand = safePayload.brands.find((entry) => entry.id === brandId);
    brand.displayName = `${brand.displayName || brand.name || 'Brand'} Updated`;

    const publish = await requestJson(harness, '/api/admin/publish', {
      method: 'POST',
      body: {
        payload: safePayload,
        base_snapshot_version: 2,
      },
    });

    assert.equal(publish.status, 200, `Schedule-preserving admin publish should pass: ${JSON.stringify(publish.body)}`);
    assert.equal(publish.body.ok, true);
    assert.equal(Number(publish.body.version), 3);

    const afterPublished = await latestPublishedSnapshot(harness);
    assert.equal(Number(afterPublished.body.metadata && afterPublished.body.metadata.version), 3);
    assert.equal(afterPublished.body.snapshot.brands[0].displayName, brand.displayName);

    const audit = await latestAuditByAction(harness.db, 'catalog.publish');
    assert.ok(audit, 'Expected catalog.publish audit entry');
    assert.equal(Number((audit.details && audit.details.version) || 0), 3);
  } finally {
    await teardownHarness(harness);
  }
});

test('admin publish blocks destructive schedule loss and leaves published and draft unchanged', async () => {
  const harness = await setupHarness();
  try {
    await signIn(harness);
    const initial = await latestPublishedSnapshot(harness);
    const scheduledPayload = buildScheduledCatalogPayload(initial.body.snapshot);
    await seedPublishedSnapshot(harness.db, scheduledPayload, 2);
    const beforeState = await readDb(harness.db);

    const destructivePayload = deepClone(scheduledPayload);
    const firstBrand = destructivePayload.brands[0];
    setBrandSchedule(destructivePayload, firstBrand.id, []);

    const publish = await requestJson(harness, '/api/admin/publish', {
      method: 'POST',
      body: {
        payload: destructivePayload,
        base_snapshot_version: 2,
      },
    });

    assert.equal(publish.status, 409, `Destructive admin publish should be blocked: ${JSON.stringify(publish.body)}`);
    assert.equal(publish.body.ok, false);
    assert.equal(publish.body.code, DESTRUCTIVE_PUBLISH_BLOCKED_CODE);
    assert.ok(Array.isArray(publish.body.affected_brands) && publish.body.affected_brands.length > 0);

    const afterPublished = await latestPublishedSnapshot(harness);
    assert.equal(Number(afterPublished.body.metadata && afterPublished.body.metadata.version), 2);
    assert.deepEqual(afterPublished.body.snapshot, beforeState.snapshots.published.payload);

    const afterState = await readDb(harness.db);
    assert.deepEqual(afterState.snapshots.draft.payload, beforeState.snapshots.draft.payload);

    const audit = await latestAuditByAction(harness.db, 'catalog.publish_blocked');
    assert.ok(audit, 'Expected blocked admin publish audit entry');
    assert.equal(String((audit.details && audit.details.code) || ''), DESTRUCTIVE_PUBLISH_BLOCKED_CODE);
  } finally {
    await teardownHarness(harness);
  }
});

test('admin publish blocks stale 73-brand seed/default payload before publish', async () => {
  const harness = await setupHarness();
  try {
    await signIn(harness);
    const initial = await latestPublishedSnapshot(harness);
    const scheduledPayload = buildScheduledCatalogPayload(initial.body.snapshot);
    await seedPublishedSnapshot(harness.db, scheduledPayload, 2);
    const beforeState = await readDb(harness.db);

    const stalePayload = deepClone(initial.body.snapshot);
    stalePayload.meta = Object.assign({}, stalePayload.meta || {}, { version: 1 });
    stalePayload.brands = Array.from({ length: 73 }, (_, index) => ({
      id: `brand-stale-${index + 1}`,
      name: `Stale Brand ${index + 1}`,
      displayName: `Stale Brand ${index + 1}`,
      active: true,
      showScheduleDates: {},
      showScheduleStatus: {},
    }));

    const publish = await requestJson(harness, '/api/admin/publish', {
      method: 'POST',
      body: {
        payload: stalePayload,
        base_snapshot_version: 1,
      },
    });

    assert.equal(publish.status, 409, `Stale admin publish should be blocked: ${JSON.stringify(publish.body)}`);
    assert.equal(publish.body.ok, false);
    assert.equal(publish.body.code, PUBLISH_BASE_VERSION_STALE_CODE);

    const afterPublished = await latestPublishedSnapshot(harness);
    assert.equal(Number(afterPublished.body.metadata && afterPublished.body.metadata.version), 2);
    assert.deepEqual(afterPublished.body.snapshot, beforeState.snapshots.published.payload);

    const afterState = await readDb(harness.db);
    assert.deepEqual(afterState.snapshots.draft.payload, beforeState.snapshots.draft.payload);
  } finally {
    await teardownHarness(harness);
  }
});

test('catalog restore snapshot requires explicit confirmation and supports draft preview then published restore', async () => {
  const harness = await setupHarness();
  try {
    await signIn(harness);
    const initialState = await readDb(harness.db);
    const initialPublishedPayload = deepClone(initialState.snapshots.published.payload);
    const normalizedInitialPublishedPayload = Object.assign({}, initialPublishedPayload, {
      phoneDirectoryEntries: Array.isArray(initialPublishedPayload.phoneDirectoryEntries)
        ? deepClone(initialPublishedPayload.phoneDirectoryEntries)
        : [],
    });
    const initial = await latestPublishedSnapshot(harness);
    const scheduledPayload = buildScheduledCatalogPayload(initial.body.snapshot);
    await seedPublishedSnapshot(harness.db, scheduledPayload, 2);

    const missingConfirmation = await requestJson(harness, '/api/cloud', {
      method: 'POST',
      body: {
        action: 'catalog_restore_snapshot',
        source_snapshot_version: 1,
        recovery_target: 'draft',
      },
    });
    assert.equal(missingConfirmation.status, 400, `Missing recovery confirmation should fail: ${JSON.stringify(missingConfirmation.body)}`);
    assert.equal(missingConfirmation.body.ok, false);
    assert.equal(missingConfirmation.body.code, 'RECOVERY_CONFIRMATION_REQUIRED');

    const draftPreview = await requestJson(harness, '/api/cloud', {
      method: 'POST',
      body: {
        action: 'catalog_restore_snapshot',
        source_snapshot_version: 1,
        recovery_target: 'draft',
        confirmation_token: buildRecoveryConfirmationToken(1, 'draft'),
      },
    });
    assert.equal(draftPreview.status, 200, `Draft recovery preview should pass: ${JSON.stringify(draftPreview.body)}`);
    assert.equal(draftPreview.body.ok, true);
    assert.equal(draftPreview.body.target, 'draft');

    const afterDraftPreview = await readDb(harness.db);
    assert.equal(afterDraftPreview.snapshots.published.version, 2);
    assert.deepEqual(afterDraftPreview.snapshots.draft.payload, normalizedInitialPublishedPayload);

    const publishRestore = await requestJson(harness, '/api/cloud', {
      method: 'POST',
      body: {
        action: 'catalog_restore_snapshot',
        source_snapshot_version: 1,
        recovery_target: 'published',
        confirmation_token: buildRecoveryConfirmationToken(1, 'published'),
      },
    });
    assert.equal(publishRestore.status, 200, `Published recovery restore should pass: ${JSON.stringify(publishRestore.body)}`);
    assert.equal(publishRestore.body.ok, true);
    assert.equal(publishRestore.body.target, 'published');
    assert.equal(publishRestore.body.source_snapshot_version, 1);

    const afterPublished = await latestPublishedSnapshot(harness);
    assert.equal(Number(afterPublished.body.metadata && afterPublished.body.metadata.version), 3);
    assert.deepEqual(
      afterPublished.body.snapshot,
      Object.assign({}, normalizedInitialPublishedPayload, {
        meta: Object.assign({}, normalizedInitialPublishedPayload.meta || {}, {
          version: 3,
          publishedAt: afterPublished.body.metadata.publishedAt,
          updatedAt: afterPublished.body.metadata.updatedAt,
        }),
      }),
    );

    const restoreAudit = await latestAuditByAction(harness.db, 'catalog.restore_snapshot_publish');
    assert.ok(restoreAudit, 'Expected restore publish audit entry');
    assert.equal(Number((restoreAudit.details && restoreAudit.details.sourceVersion) || 0), 1);
  } finally {
    await teardownHarness(harness);
  }
});

test('catalog restore snapshot is limited to primary admin accounts', async () => {
  const harness = await setupHarness();
  try {
    const assistant = await addAssistantAdmin(harness.db);
    await signIn(harness, assistant.identifier, assistant.password, 'admin');
    const restore = await requestJson(harness, '/api/cloud', {
      method: 'POST',
      body: {
        action: 'catalog_restore_snapshot',
        source_snapshot_version: 1,
        recovery_target: 'draft',
        confirmation_token: buildRecoveryConfirmationToken(1, 'draft'),
      },
    });
    assert.equal(restore.status, 403, `assistant admin should be blocked from recovery mode: ${JSON.stringify(restore.body)}`);
    assert.equal(restore.body.ok, false);
    assert.equal(restore.body.code, 'PRIMARY_ADMIN_REQUIRED');
  } finally {
    await teardownHarness(harness);
  }
});

test('smoke admin publish is blocked on production-like runtime unless explicitly enabled', async () => {
  await withEnv({ NODE_ENV: 'production' }, async () => {
    const harness = await setupHarness();
    try {
      const smokeUser = await addSmokePrimaryAdmin(harness.db);
      await signIn(harness, smokeUser.identifier, smokeUser.password, 'admin');
      const published = await latestPublishedSnapshot(harness);

      const saveSend = await requestJson(harness, '/api/cloud', {
        method: 'POST',
        body: {
          action: 'save_and_sync',
          request_id: 'smoke-admin-publish-blocked',
          payload: published.body.snapshot,
        },
      });

      assert.equal(saveSend.status, 403, `Smoke admin publish should be blocked: ${JSON.stringify(saveSend.body)}`);
      assert.equal(saveSend.body.ok, false);
      assert.equal(saveSend.body.code, SMOKE_PUBLISH_BLOCKED_CODE);

      const legacyPublish = await requestJson(harness, '/api/admin/publish', {
        method: 'POST',
        body: {
          payload: published.body.snapshot,
          base_snapshot_version: 1,
        },
      });

      assert.equal(legacyPublish.status, 403, `Smoke admin legacy publish should be blocked: ${JSON.stringify(legacyPublish.body)}`);
      assert.equal(legacyPublish.body.ok, false);
      assert.equal(legacyPublish.body.code, SMOKE_PUBLISH_BLOCKED_CODE);
    } finally {
      await teardownHarness(harness);
    }
  });
});
