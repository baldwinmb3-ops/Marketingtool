const test = require('node:test');
const assert = require('node:assert/strict');
const { newDb } = require('pg-mem');

const { createApp } = require('../app.cjs');
const { closePool, upsertUserRow } = require('../db.cjs');
const { hashPassword } = require('../lib.cjs');
const {
  resetPilotReadinessDiagnostics,
} = require('../pilot-readiness-diagnostics.cjs');

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

async function signIn(harness, identifier, password, role) {
  const response = await requestJson(harness, '/api/auth/sign-in', {
    method: 'POST',
    useAuth: false,
    body: { identifier, password, role },
  });
  const setCookie = response.headers.get('set-cookie') || '';
  harness.cookie = setCookie.split(';')[0];
  assert.equal(response.status, 200, `Sign-in failed: ${JSON.stringify(response.body)}`);
  assert.equal(response.body.ok, true);
  assert.ok(harness.cookie, 'sign-in should set a session cookie');
  return response;
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
  const stamp = '2026-06-02T13:00:00.000Z';
  const snapshotPayload = {
    meta: {
      version: 1,
      source: 'test',
      publishedAt: stamp,
      updatedAt: stamp,
    },
    brands: [
      {
        id: 'brand-medieval-times',
        name: 'Medieval Times',
        active: true,
        showScheduleDates: {},
        showScheduleStatus: {},
      },
    ],
    ticketLines: [
      {
        id: 'line-medieval-adult',
        brandId: 'brand-medieval-times',
        ticketLabel: 'Adult',
        qualifierText: '12+',
        infoText: '',
        retailPrice: 89.99,
        cmaPrice: 74.5,
        active: true,
        sortOrder: 1,
        preGift: false,
        bogoEnabled: false,
        bogoLimit: 2,
        childFree: false,
        createdAt: stamp,
        updatedAt: stamp,
      },
    ],
    resources: [],
    managerCategories: [],
    managerEntries: [],
    phoneDirectoryEntries: [],
  };
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS manager_title TEXT NOT NULL DEFAULT ''`);
  await db.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS manager_on_duty BOOLEAN NOT NULL DEFAULT FALSE`);

  await upsertUserRow(db, {
    id: 'user-admin-1',
    displayName: 'Primary Admin',
    firstName: 'Primary',
    lastName: 'Admin',
    wwid: 'ADMIN1001',
    email: 'admin@premiumapp.local',
    phone: '',
    role: 'admin',
    isAssistant: false,
    canAccessMarketer: true,
    canAccessAdmin: true,
    canAccessManager: true,
    managerTitle: 'Manager',
    managerOnly: false,
    departmentIds: [],
    status: 'active',
    isLocked: false,
    passwordHash: hashPassword('Admin123A'),
    forcePasswordReset: false,
    createdAt: stamp,
    updatedAt: stamp,
  });
  await upsertUserRow(db, {
    id: 'user-marketer-1',
    displayName: 'Primary Marketer',
    firstName: 'Primary',
    lastName: 'Marketer',
    wwid: 'MARK1001',
    email: 'marketer@premiumapp.local',
    phone: '',
    role: 'marketer',
    isAssistant: false,
    canAccessMarketer: true,
    canAccessAdmin: false,
    canAccessManager: false,
    managerTitle: '',
    managerOnly: false,
    departmentIds: [],
    status: 'active',
    isLocked: false,
    passwordHash: hashPassword('Marketer123A'),
    forcePasswordReset: false,
    createdAt: stamp,
    updatedAt: stamp,
  });

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

function buildCloudBookingRow(id, tourNumber, overrides = {}) {
  return {
    id,
    brandId: 'brand-medieval-times',
    brandName: 'Medieval Times',
    guestFirstName: 'Pilot',
    guestLastName: 'Diagnostics',
    showDate: '2026-04-12',
    showTime: '6:00 PM',
    primaryShowDate: '2026-04-12',
    primaryShowTime: '6:00 PM',
    backupShowDate: '2026-04-12',
    backupShowTime: '8:00 PM',
    tourNumber,
    snapshotVersion: 1,
    quoteLines: [{ ticketLineId: 'line-medieval-adult', qty: 1, freeQty: 0, extraEach: 0 }],
    clientTotals: { retailTotal: 0, costTotal: 0 },
    ...overrides,
  };
}

test('pilot readiness diagnostics endpoint requires admin access and exposes aggregates only', async () => {
  resetPilotReadinessDiagnostics();
  const h = await setupHarness();
  try {
    const unauthenticated = await requestJson(h, '/api/diagnostics/pilot-readiness', { useAuth: false });
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.body.ok, false);

    await signIn(h, 'MARK1001', 'Marketer123A', 'marketer');
    const forbidden = await requestJson(h, '/api/diagnostics/pilot-readiness');
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.ok, false);

    await signIn(h, 'ADMIN1001', 'Admin123A', 'admin');
    const users = await requestJson(h, '/api/users');
    assert.equal(users.status, 200);
    assert.equal(users.body.ok, true);

    const diagnostics = await requestJson(h, '/api/diagnostics/pilot-readiness');
    assert.equal(diagnostics.status, 200, `Diagnostics fetch failed: ${JSON.stringify(diagnostics.body)}`);
    assert.equal(diagnostics.body.ok, true);
    assert.ok(diagnostics.body.diagnostics);
    assert.equal(typeof diagnostics.body.diagnostics.startedAt, 'string');
    assert.equal(typeof diagnostics.body.diagnostics.generatedAt, 'string');
    assert.ok(diagnostics.body.diagnostics.session);
    assert.ok(diagnostics.body.diagnostics.routes);
    assert.ok(diagnostics.body.diagnostics.routes['GET /api/users']);

    const serialized = JSON.stringify(diagnostics.body);
    assert.doesNotMatch(serialized, /DATABASE_URL/i);
    assert.doesNotMatch(serialized, /password_hash/i);
    assert.doesNotMatch(serialized, /authorization/i);
    assert.doesNotMatch(serialized, /session_id/i);
    assert.doesNotMatch(serialized, /set-cookie/i);

    const routeMetric = diagnostics.body.diagnostics.routes['GET /api/users'];
    assert.equal(typeof routeMetric.requestCount, 'number');
    assert.equal(typeof routeMetric.statusCounts['2xx'], 'number');
    assert.equal(typeof routeMetric.explicitStatusCounts['401'], 'number');
    assert.equal(typeof routeMetric.responseBytes.total, 'number');
    assert.equal(typeof routeMetric.latencyMs.sampleCount, 'number');
  } finally {
    await teardownHarness(h);
  }
});

test('pilot readiness diagnostics counts wrapped backend routes without changing endpoint behavior', async () => {
  resetPilotReadinessDiagnostics();
  const h = await setupHarness();
  try {
    await signIn(h, 'MARK1001', 'Marketer123A', 'marketer');
    const createA = await requestJson(h, '/api/bookings', {
      method: 'POST',
      body: buildCloudBookingRow('booking-pilot-diag-release', 'PILOT-DIAG-REL'),
    });
    assert.equal(createA.status, 201, `Booking create A failed: ${JSON.stringify(createA.body)}`);
    assert.equal(createA.body.ok, true);

    const createB = await requestJson(h, '/api/bookings', {
      method: 'POST',
      body: buildCloudBookingRow('booking-pilot-diag-complete', 'PILOT-DIAG-DONE'),
    });
    assert.equal(createB.status, 201, `Booking create B failed: ${JSON.stringify(createB.body)}`);
    assert.equal(createB.body.ok, true);

    await signIn(h, 'ADMIN1001', 'Admin123A', 'admin');

    const users = await requestJson(h, '/api/users');
    assert.equal(users.status, 200);
    assert.equal(users.body.ok, true);

    const managers = await requestJson(h, '/api/managers/on-duty');
    assert.equal(managers.status, 200);
    assert.equal(managers.body.ok, true);
    assert.ok(Array.isArray(managers.body.managers));

    const queue = await requestJson(h, '/api/bookings');
    assert.equal(queue.status, 200);
    assert.equal(queue.body.ok, true);
    assert.ok(Array.isArray(queue.body.bookings));

    const claimRelease = await requestJson(h, '/api/bookings/booking-pilot-diag-release/claim', {
      method: 'POST',
      body: { actor_device: 'pilot-diag' },
    });
    assert.equal(claimRelease.status, 200);
    assert.equal(claimRelease.body.ok, true);

    const release = await requestJson(h, '/api/bookings/booking-pilot-diag-release/release', {
      method: 'POST',
      body: { actor_device: 'pilot-diag' },
    });
    assert.equal(release.status, 200);
    assert.equal(release.body.ok, true);

    const claimComplete = await requestJson(h, '/api/bookings/booking-pilot-diag-complete/claim', {
      method: 'POST',
      body: { actor_device: 'pilot-diag' },
    });
    assert.equal(claimComplete.status, 200);
    assert.equal(claimComplete.body.ok, true);

    const complete = await requestJson(h, '/api/bookings/booking-pilot-diag-complete/complete', {
      method: 'POST',
      body: { actor_device: 'pilot-diag' },
    });
    assert.equal(complete.status, 200);
    assert.equal(complete.body.ok, true);

    const catalogGetLive = await requestJson(h, '/api/cloud', {
      method: 'POST',
      body: { action: 'catalog_get_live' },
    });
    assert.equal(catalogGetLive.status, 200);
    assert.equal(catalogGetLive.body.ok, true);
    assert.ok(catalogGetLive.body.row);

    const bookingGet = await requestJson(h, '/api/cloud', {
      method: 'POST',
      body: { action: 'booking_get' },
    });
    assert.equal(bookingGet.status, 200);
    assert.equal(bookingGet.body.ok, true);
    assert.ok(bookingGet.body.row);

    const bookingSave = await requestJson(h, '/api/cloud', {
      method: 'POST',
      body: {
        action: 'booking_save',
        payload: { requests: [] },
      },
    });
    assert.equal(bookingSave.status, 200);
    assert.equal(bookingSave.body.ok, true);

    const published = await requestJson(h, '/api/snapshots/published/latest');
    assert.equal(published.status, 200);
    assert.equal(published.body.ok, true);

    const saveAndSend = await requestJson(h, '/api/cloud', {
      method: 'POST',
      body: {
        action: 'save_and_sync',
        payload: published.body.snapshot,
        request_id: 'pilot-readiness-diagnostics-save-send',
      },
    });
    assert.equal(saveAndSend.status, 200, `save_and_sync failed: ${JSON.stringify(saveAndSend.body)}`);
    assert.equal(saveAndSend.body.ok, true);

    const diagnostics = await requestJson(h, '/api/diagnostics/pilot-readiness');
    assert.equal(diagnostics.status, 200);
    assert.equal(diagnostics.body.ok, true);

    const routes = diagnostics.body.diagnostics.routes;
    assert.equal(routes['GET /api/users'].requestCount, 1);
    assert.equal(routes['GET /api/managers/on-duty'].requestCount, 1);
    assert.equal(routes['GET /api/bookings'].requestCount, 1);
    assert.equal(routes['POST /api/bookings'].requestCount, 2);
    assert.equal(routes['POST /api/bookings/:id/claim'].requestCount, 2);
    assert.equal(routes['POST /api/bookings/:id/release'].requestCount, 1);
    assert.equal(routes['POST /api/bookings/:id/complete'].requestCount, 1);
    assert.equal(routes['POST /api/cloud action=catalog_get_live'].requestCount, 1);
    assert.equal(routes['POST /api/cloud action=booking_get'].requestCount, 1);
    assert.equal(routes['POST /api/cloud action=booking_save'].requestCount, 1);
    assert.equal(routes['POST /api/cloud action=save_and_send'].requestCount, 1);

    assert.ok(diagnostics.body.diagnostics.session.lookupCount >= 10, 'Expected authenticated route lookups to be counted.');
    assert.equal(typeof diagnostics.body.diagnostics.session.rowUpdateCount, 'number');
    assert.ok(diagnostics.body.diagnostics.session.rowUpdateCount >= 0, 'Session row updates should be counted without forcing extra writes.');
    assert.ok(
      diagnostics.body.diagnostics.session.rowUpdateCount <= diagnostics.body.diagnostics.session.lookupCount,
      'Session row updates must not exceed lookup attempts.',
    );
  } finally {
    await teardownHarness(h);
  }
});
