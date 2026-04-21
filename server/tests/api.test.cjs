const test = require('node:test');
const assert = require('node:assert/strict');

const { newDb } = require('pg-mem');

const { createApp } = require('../app.cjs');
const { closePool } = require('../db.cjs');
const { hashPassword } = require('../lib.cjs');

async function listen(serverApp) {
  return await new Promise((resolve, reject) => {
    const server = serverApp.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

async function readJson(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

async function setupHarness() {
  const mem = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pgAdapter = mem.adapters.createPg();
  const db = new pgAdapter.Pool();
  const { app } = await createApp({
    db,
    seedDatabase: false,
    runtimeInfo: { mode: 'test', persistence: 'pg-mem', degraded: false },
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
