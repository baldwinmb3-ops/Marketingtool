const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { newDb } = require('pg-mem');

const { createApp } = require('../app.cjs');
const { closePool } = require('../db.cjs');

async function setupHarness() {
  const mem = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pgAdapter = mem.adapters.createPg();
  const pool = new pgAdapter.Pool();
  const { app } = await createApp({ db: pool, seedDatabase: true });
  return {
    app,
    db: pool,
    agent: request.agent(app),
  };
}

async function signIn(agent, identifier, password, role) {
  const res = await agent.post('/api/auth/sign-in').send({ identifier, password, role });
  assert.equal(res.status, 200, `Sign-in failed: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.ok, true);
  return res;
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

test('cors allows deployed Vercel origins and preview URLs', async () => {
  await withEnv(
    {
      APP_CORS_ORIGIN: 'https://marketingtool-mocha.vercel.app,https://marketingtool-mocha-*.vercel.app',
    },
    async () => {
      const h = await setupHarness();
      const previewOrigin = 'https://marketingtool-mocha-git-main-preview.vercel.app';
      try {
        const productionPreflight = await request(h.app)
          .options('/api/cloud')
          .set('Origin', 'https://marketingtool-mocha.vercel.app')
          .set('Access-Control-Request-Method', 'POST')
          .set('Access-Control-Request-Headers', 'content-type,x-session-id');
        assert.equal(productionPreflight.status, 204);
        assert.equal(productionPreflight.headers['access-control-allow-origin'], 'https://marketingtool-mocha.vercel.app');
        assert.equal(productionPreflight.headers['access-control-allow-credentials'], 'true');
        assert.match(String(productionPreflight.headers['access-control-allow-headers'] || ''), /x-session-id/i);

        const previewPreflight = await request(h.app)
          .options('/api/cloud')
          .set('Origin', previewOrigin)
          .set('Access-Control-Request-Method', 'POST')
          .set('Access-Control-Request-Headers', 'content-type,x-session-id');
        assert.equal(previewPreflight.status, 204);
        assert.equal(previewPreflight.headers['access-control-allow-origin'], previewOrigin);
        assert.equal(previewPreflight.headers['access-control-allow-credentials'], 'true');

        const blocked = await request(h.app)
          .options('/api/cloud')
          .set('Origin', 'https://example-attacker.invalid')
          .set('Access-Control-Request-Method', 'POST')
          .set('Access-Control-Request-Headers', 'content-type');
        assert.equal(blocked.status, 500);
        assert.equal(blocked.headers['access-control-allow-origin'], undefined);
      } finally {
        await closePool(h.db);
      }
    },
  );
});

test('cors fallback defaults still allow the production frontend when APP_CORS_ORIGIN is unset', async () => {
  await withEnv({ APP_CORS_ORIGIN: undefined }, async () => {
    const h = await setupHarness();
    try {
      const productionPreflight = await request(h.app)
        .options('/api/cloud')
        .set('Origin', 'https://marketingtool-mocha.vercel.app')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type,x-session-id');
      assert.equal(productionPreflight.status, 204);
      assert.equal(productionPreflight.headers['access-control-allow-origin'], 'https://marketingtool-mocha.vercel.app');
      assert.equal(productionPreflight.headers['access-control-allow-credentials'], 'true');
    } finally {
      await closePool(h.db);
    }
  });
});

test('/api/health reports runtime metadata when provided', async () => {
  const mem = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pgAdapter = mem.adapters.createPg();
  const pool = new pgAdapter.Pool();
  const runtimeInfo = {
    mode: 'memory-fallback',
    persistence: 'pg-mem (boot fallback, non-durable)',
    degraded: true,
    durable: false,
    authoritative: false,
    reason: 'database quota exceeded',
    fallbackTriggeredAt: '2026-04-04T19:00:00.000Z',
    operatorWarning: 'NON-DURABLE pg-mem boot fallback is active.',
  };
  try {
    const { app } = await createApp({ db: pool, seedDatabase: true, runtimeInfo });
    const res = await request(app).get('/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.service, 'marketingtool-backend');
    assert.equal(typeof res.body.version, 'string');
    assert.equal(res.body.runtime.mode, runtimeInfo.mode);
    assert.equal(res.body.runtime.persistence, runtimeInfo.persistence);
    assert.equal(res.body.runtime.degraded, runtimeInfo.degraded);
    assert.equal(res.body.runtime.durable, runtimeInfo.durable);
    assert.equal(res.body.runtime.authoritative, runtimeInfo.authoritative);
    assert.equal(res.body.runtime.reason, runtimeInfo.reason);
    assert.equal(res.body.runtime.fallbackTriggeredAt, runtimeInfo.fallbackTriggeredAt);
    assert.equal(res.body.runtime.operatorWarning, runtimeInfo.operatorWarning);
    if (res.body.runtime.latestBackup) {
      assert.equal(typeof res.body.runtime.latestBackup.validatedAt, 'string');
      assert.equal(typeof res.body.runtime.latestBackup.file, 'string');
    }
  } finally {
    await closePool(pool);
  }
});

test('non-admin publish attempt must fail', async () => {
  const h = await setupHarness();
  try {
    await signIn(h.agent, 'MARK1001', 'Marketer123A', 'marketer');
    const publish = await h.agent.post('/api/admin/publish').send({ payload: { brands: [], ticketLines: [] } });
    assert.equal(publish.status, 403);
    assert.equal(publish.body.ok, false);
  } finally {
    await closePool(h.db);
  }
});

test('assistant admin can save and send through cloud publish action', async () => {
  const h = await setupHarness();
  try {
    await signIn(h.agent, 'ADMIN2001', 'Assist123A', 'admin');
    const published = await h.agent.get('/api/snapshots/published/latest');
    assert.equal(published.status, 200, `Published snapshot fetch failed: ${JSON.stringify(published.body)}`);
    assert.equal(published.body.ok, true);

    const saveSend = await h.agent.post('/api/cloud').send({
      action: 'save_and_sync',
      payload: published.body.snapshot,
      request_id: 'assistant-admin-save-send',
    });

    assert.equal(saveSend.status, 200, `Assistant save_and_sync failed: ${JSON.stringify(saveSend.body)}`);
    assert.equal(saveSend.body.ok, true);
    assert.equal(saveSend.body.version, 2);
    assert.equal(saveSend.body.message, 'Cloud synced.');
  } finally {
    await closePool(h.db);
  }
});

test('stale snapshot booking must fail', async () => {
  const h = await setupHarness();
  const marketer = request.agent(h.app);
  try {
    await signIn(h.agent, 'ADMIN1001', 'Admin123A', 'admin');
    const publish = await h.agent.post('/api/admin/publish').send({});
    assert.equal(publish.status, 200);
    assert.equal(publish.body.version, 2);

    await signIn(marketer, 'MARK1001', 'Marketer123A', 'marketer');
    const create = await marketer.post('/api/bookings').send({
      id: 'booking-stale-1',
      brandId: 'brand-medieval-times',
      brandName: 'Medieval Times',
      guestFirstName: 'Stale',
      guestLastName: 'Snapshot',
      showDate: '2026-04-01',
      showTime: '10:00',
      snapshotVersion: 1,
      quoteLines: [{ ticketLineId: 'line-medieval-adult', qty: 1, freeQty: 0, extraEach: 0 }],
      clientTotals: { retailTotal: 10, costTotal: 1 },
    });

    assert.equal(create.status, 409);
    assert.equal(create.body.code, 'SNAPSHOT_STALE');
  } finally {
    await closePool(h.db);
  }
});

test('booking create recomputes totals and ignores client totals', async () => {
  const h = await setupHarness();
  const marketer = request.agent(h.app);
  try {
    await signIn(marketer, 'MARK1001', 'Marketer123A', 'marketer');
    const create = await marketer.post('/api/bookings').send({
      id: 'booking-recompute-1',
      brandId: 'brand-medieval-times',
      brandName: 'Medieval Times',
      guestFirstName: 'Pricing',
      guestLastName: 'Authority',
      showDate: '2026-04-05',
      showTime: '10:00',
      snapshotVersion: 1,
      quoteLines: [{ ticketLineId: 'line-medieval-adult', qty: 1, freeQty: 0, extraEach: 0 }],
      clientTotals: { retailTotal: 0.01, costTotal: 0.01, profit: 99999 },
    });

    assert.equal(create.status, 201, `Create failed: ${JSON.stringify(create.body)}`);
    assert.equal(create.body.ok, true);
    assert.equal(create.body.booking.clientTotals.retailTotal, 0.01);
    assert.equal(create.body.booking.clientTotals.costTotal, 0.01);
    assert.equal(create.body.booking.authoritativeTotals.retailTotal, 89.99);
    assert.equal(create.body.booking.authoritativeTotals.costTotal, 74.5);
    assert.equal(create.body.booking.authoritativeTotals.profit, 15.49);
    assert.equal(create.body.booking.commissionProfit, 15.49);
  } finally {
    await closePool(h.db);
  }
});

test('double booking claim: one must fail', async () => {
  const h = await setupHarness();
  const marketer = request.agent(h.app);
  const adminA = request.agent(h.app);
  const adminB = request.agent(h.app);

  try {
    await signIn(marketer, 'MARK1001', 'Marketer123A', 'marketer');
    const create = await marketer.post('/api/bookings').send({
      id: 'booking-claim-1',
      brandId: 'brand-medieval-times',
      brandName: 'Medieval Times',
      guestFirstName: 'Double',
      guestLastName: 'Claim',
      showDate: '2026-04-02',
      showTime: '11:00',
      snapshotVersion: 1,
      quoteLines: [{ ticketLineId: 'line-medieval-adult', qty: 1, freeQty: 0, extraEach: 0 }],
      clientTotals: { retailTotal: 0, costTotal: 0 },
    });
    assert.equal(create.status, 201);

    await signIn(adminA, 'ADMIN1001', 'Admin123A', 'admin');
    await signIn(adminB, 'ADMIN2001', 'Assist123A', 'admin');

    const [claimA, claimB] = await Promise.all([
      adminA.post('/api/bookings/booking-claim-1/claim').send({ actor_device: 'device-a' }),
      adminB.post('/api/bookings/booking-claim-1/claim').send({ actor_device: 'device-b' }),
    ]);

    const okCount = [claimA, claimB].filter((res) => res.status === 200 && res.body && res.body.ok === true).length;
    const failCount = [claimA, claimB].filter((res) => res.status >= 400 || (res.body && res.body.ok === false)).length;

    assert.equal(
      okCount,
      1,
      `Expected one successful claim. A=${claimA.status}/${JSON.stringify(claimA.body)} B=${claimB.status}/${JSON.stringify(claimB.body)}`,
    );
    assert.equal(
      failCount,
      1,
      `Expected one failed claim. A=${claimA.status}/${JSON.stringify(claimA.body)} B=${claimB.status}/${JSON.stringify(claimB.body)}`,
    );
  } finally {
    await closePool(h.db);
  }
});

test('cloud booking complete persists for both admin and marketer reloads', async () => {
  const h = await setupHarness();
  const marketer = request.agent(h.app);
  const admin = request.agent(h.app);

  try {
    await signIn(marketer, 'MARK1001', 'Marketer123A', 'marketer');
    const create = await marketer.post('/api/bookings').send({
      id: 'booking-cloud-complete-1',
      brandId: 'brand-medieval-times',
      brandName: 'Medieval Times',
      guestFirstName: 'Cloud',
      guestLastName: 'Complete',
      showDate: '2026-04-02',
      showTime: '11:00',
      snapshotVersion: 1,
      quoteLines: [{ ticketLineId: 'line-medieval-adult', qty: 1, freeQty: 0, extraEach: 0 }],
      clientTotals: { retailTotal: 0, costTotal: 0 },
    });
    assert.equal(create.status, 201, `Create failed: ${JSON.stringify(create.body)}`);

    await signIn(admin, 'ADMIN1001', 'Admin123A', 'admin');

    const claim = await admin.post('/api/cloud').send({
      action: 'booking_claim',
      request_id: 'booking-cloud-complete-1',
      actor_device: 'admin-device',
    });
    assert.equal(claim.status, 200, `Cloud claim failed: ${JSON.stringify(claim.body)}`);
    assert.equal(claim.body.ok, true);

    const complete = await admin.post('/api/cloud').send({
      action: 'booking_complete',
      request_id: 'booking-cloud-complete-1',
      actor_device: 'admin-device',
    });
    assert.equal(complete.status, 200, `Cloud complete failed: ${JSON.stringify(complete.body)}`);
    assert.equal(complete.body.ok, true);

    const adminGet = await admin.post('/api/cloud').send({ action: 'booking_get' });
    assert.equal(adminGet.status, 200, `Admin booking_get failed: ${JSON.stringify(adminGet.body)}`);
    assert.equal(adminGet.body.ok, true);

    const adminRows = (((adminGet.body || {}).row || {}).payload || {}).requests || [];
    const adminRow = adminRows.find((entry) => String((entry && entry.id) || '') === 'booking-cloud-complete-1');
    assert.ok(adminRow, 'Admin booking_get should include the completed booking.');
    assert.equal(adminRow.status, 'done');
    assert.equal(adminRow.completedByName, 'Primary Admin');

    const adminLock = Array.isArray(adminGet.body.locks)
      ? adminGet.body.locks.find((entry) => String((entry && entry.request_id) || '') === 'booking-cloud-complete-1')
      : null;
    assert.ok(adminLock, 'Admin booking_get should include the completed booking lock.');
    assert.equal(adminLock.status, 'done');

    const marketerGet = await marketer.post('/api/cloud').send({ action: 'booking_get' });
    assert.equal(marketerGet.status, 200, `Marketer booking_get failed: ${JSON.stringify(marketerGet.body)}`);
    assert.equal(marketerGet.body.ok, true);

    const marketerRows = (((marketerGet.body || {}).row || {}).payload || {}).requests || [];
    const marketerRow = marketerRows.find((entry) => String((entry && entry.id) || '') === 'booking-cloud-complete-1');
    assert.ok(marketerRow, 'Marketer booking_get should include the completed booking.');
    assert.equal(marketerRow.status, 'done');
    assert.equal(marketerRow.completedByName, 'Primary Admin');
  } finally {
    await closePool(h.db);
  }
});

test('session survives backend restart and sign-out revokes it', async () => {
  const mem = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pgAdapter = mem.adapters.createPg();
  const pool = new pgAdapter.Pool();
  try {
    const { app: appA } = await createApp({ db: pool, seedDatabase: true });
    const signInRes = await request(appA)
      .post('/api/auth/sign-in')
      .send({ identifier: 'ADMIN1001', password: 'Admin123A', role: 'admin' });
    assert.equal(signInRes.status, 200);
    const cookies = signInRes.headers['set-cookie'];
    assert.ok(Array.isArray(cookies) && cookies.length > 0);

    const { app: appB } = await createApp({ db: pool, seedDatabase: false, initializeDatabase: false });
    const sessionCheck = await request(appB).get('/api/auth/session').set('Cookie', cookies);
    assert.equal(sessionCheck.status, 200);
    assert.equal(sessionCheck.body.ok, true);
    assert.equal(sessionCheck.body.session.isAuthenticated, true);

    const signOut = await request(appB).post('/api/auth/sign-out').set('Cookie', cookies);
    assert.equal(signOut.status, 200);
    assert.equal(signOut.body.ok, true);

    const afterSignOut = await request(appB).get('/api/auth/session').set('Cookie', cookies);
    assert.equal(afterSignOut.status, 200);
    assert.equal(afterSignOut.body.ok, true);
    assert.equal(afterSignOut.body.session.isAuthenticated, false);
  } finally {
    await closePool(pool);
  }
});

test('cloud session header fallback works without cookies', async () => {
  const h = await setupHarness();
  try {
    const signIn = await request(h.app)
      .post('/api/cloud')
      .send({ action: 'auth_sign_in', role: 'admin', identifier: 'ADMIN1001', password: 'Admin123A' });
    assert.equal(signIn.status, 200);
    assert.equal(signIn.body.ok, true);
    assert.ok(signIn.body.session_id);

    const sid = String(signIn.body.session_id || '');

    const catalog = await request(h.app)
      .post('/api/cloud')
      .set('X-Session-Id', sid)
      .send({ action: 'catalog_get_live', stage: 'published' });
    assert.equal(catalog.status, 200);
    assert.equal(catalog.body.ok, true);

    const signOut = await request(h.app).post('/api/auth/sign-out').set('X-Session-Id', sid).send({});
    assert.equal(signOut.status, 200);
    assert.equal(signOut.body.ok, true);

    const after = await request(h.app)
      .post('/api/cloud')
      .set('X-Session-Id', sid)
      .send({ action: 'catalog_get_live', stage: 'published' });
    assert.equal(after.status, 401);
    assert.equal(after.body.ok, false);
  } finally {
    await closePool(h.db);
  }
});

test('explicit bearer transport hint prefers bearer auth even when a different cookie session exists', async () => {
  const h = await setupHarness();
  try {
    const browserSignIn = await signIn(h.agent, 'ADMIN1001', 'Admin123A', 'admin');
    const cookieSid = String(browserSignIn.body.session_id || '');
    assert.ok(cookieSid);

    const bearerSignIn = await request(h.app)
      .post('/api/cloud')
      .send({ action: 'auth_sign_in', role: 'admin', identifier: 'ADMIN2001', password: 'Assist123A' });
    assert.equal(bearerSignIn.status, 200, `Cloud sign-in failed: ${JSON.stringify(bearerSignIn.body)}`);
    assert.equal(bearerSignIn.body.ok, true);
    const bearerSid = String(bearerSignIn.body.session_id || '');
    assert.ok(bearerSid);
    assert.notEqual(bearerSid, cookieSid);

    const sessionCheck = await h.agent
      .get('/api/auth/session')
      .set('Authorization', `Bearer ${bearerSid}`)
      .set('X-Session-Id', bearerSid)
      .set('X-Session-Transport', 'bearer');
    assert.equal(sessionCheck.status, 200, `Bearer-preferred session check failed: ${JSON.stringify(sessionCheck.body)}`);
    assert.equal(sessionCheck.body.ok, true);
    assert.equal(sessionCheck.body.session.isAuthenticated, true);
    assert.equal(sessionCheck.body.session.user.wwid, 'ADMIN2001');
  } finally {
    await closePool(h.db);
  }
});

test('conflicting session transports are rejected when no explicit transport hint is provided', async () => {
  const h = await setupHarness();
  try {
    const browserSignIn = await signIn(h.agent, 'ADMIN1001', 'Admin123A', 'admin');
    const cookieSid = String(browserSignIn.body.session_id || '');
    assert.ok(cookieSid);

    const headerSignIn = await request(h.app)
      .post('/api/cloud')
      .send({ action: 'auth_sign_in', role: 'admin', identifier: 'ADMIN2001', password: 'Assist123A' });
    assert.equal(headerSignIn.status, 200, `Second cloud sign-in failed: ${JSON.stringify(headerSignIn.body)}`);
    assert.equal(headerSignIn.body.ok, true);
    const headerSid = String(headerSignIn.body.session_id || '');
    assert.ok(headerSid);
    assert.notEqual(headerSid, cookieSid);

    const conflict = await h.agent
      .post('/api/cloud')
      .set('X-Session-Id', headerSid)
      .send({ action: 'catalog_get_live', stage: 'published' });
    assert.equal(conflict.status, 400, `Expected ambiguous transport rejection: ${JSON.stringify(conflict.body)}`);
    assert.equal(conflict.body.ok, false);
    assert.equal(conflict.body.code, 'AMBIGUOUS_SESSION_TRANSPORT');
  } finally {
    await closePool(h.db);
  }
});

test('cloud auth_switch_role keeps the same live session while changing the requested allowed role', async () => {
  const h = await setupHarness();
  try {
    const signIn = await request(h.app)
      .post('/api/cloud')
      .send({ action: 'auth_sign_in', role: 'marketer', identifier: 'ADMIN1001', password: 'Admin123A' });
    assert.equal(signIn.status, 200, `Cloud sign-in failed: ${JSON.stringify(signIn.body)}`);
    assert.equal(signIn.body.ok, true);
    assert.ok(signIn.body.permissions && signIn.body.permissions.publish_catalog, 'Expected publish permission on sign-in payload');
    const beforeSid = String(signIn.body.session_id || '');
    assert.ok(beforeSid);

    const switched = await request(h.app)
      .post('/api/cloud')
      .set('X-Session-Id', beforeSid)
      .send({ action: 'auth_switch_role', role: 'admin' });
    assert.equal(switched.status, 200, `Cloud role switch failed: ${JSON.stringify(switched.body)}`);
    assert.equal(switched.body.ok, true);
    assert.equal(switched.body.session.role, 'admin');
    const afterSid = String(switched.body.session_id || '');
    assert.ok(afterSid);
    assert.equal(afterSid, beforeSid);

    const sessionCheck = await request(h.app).get('/api/auth/session').set('X-Session-Id', afterSid);
    assert.equal(sessionCheck.status, 200);
    assert.equal(sessionCheck.body.ok, true);
    assert.equal(sessionCheck.body.session.role, 'admin');

    const oldSession = await request(h.app)
      .post('/api/cloud')
      .set('X-Session-Id', beforeSid)
      .send({ action: 'catalog_get_live', stage: 'published' });
    assert.equal(oldSession.status, 200);
    assert.equal(oldSession.body.ok, true);
  } finally {
    await closePool(h.db);
  }
});

test('cloud auth_switch_role rejects marketer-only sessions that cannot become admin', async () => {
  const h = await setupHarness();
  try {
    const signIn = await request(h.app)
      .post('/api/cloud')
      .send({ action: 'auth_sign_in', role: 'marketer', identifier: 'MARK1001', password: 'Marketer123A' });
    assert.equal(signIn.status, 200, `Cloud sign-in failed: ${JSON.stringify(signIn.body)}`);
    assert.equal(signIn.body.ok, true);
    const sid = String(signIn.body.session_id || '');
    assert.ok(sid);

    const switched = await request(h.app)
      .post('/api/cloud')
      .set('X-Session-Id', sid)
      .send({ action: 'auth_switch_role', role: 'admin' });
    assert.equal(switched.status, 403);
    assert.equal(switched.body.ok, false);
  } finally {
    await closePool(h.db);
  }
});

test('marketer-only cloud sign-in returns backend-authoritative marketer-only roles', async () => {
  const h = await setupHarness();
  try {
    await signIn(h.agent, 'ADMIN1001', 'Admin123A', 'admin');

    const create = await h.agent.post('/api/cloud').send({
      action: 'apply_user_operations',
      user_operations: [
        {
          op: 'create_user',
          wwid: '666666',
          role: 'marketer',
          display_name: 'bb',
          force_password_reset: false,
          metadata: {
            first_name: 'bb',
            last_name: 'bb',
            work_email: 'bb@wyn.com',
            temp_password: 'Bb123A',
            can_access_admin: false,
            can_access_marketer: false,
            can_access_manager: false,
            manager_only: false,
          },
        },
      ],
    });
    assert.equal(create.status, 200, `Create marketer failed: ${JSON.stringify(create.body)}`);
    assert.equal(create.body.ok, true);

    const signInResult = await request(h.app)
      .post('/api/cloud')
      .send({ action: 'auth_sign_in', role: 'marketer', identifier: '666666', password: 'Bb123A' });
    assert.equal(signInResult.status, 200, `Cloud sign-in failed: ${JSON.stringify(signInResult.body)}`);
    assert.equal(signInResult.body.ok, true);
    assert.deepEqual(signInResult.body.available_roles, ['marketer']);
    assert.equal(signInResult.body.user.role, 'marketer');
    assert.equal(!!signInResult.body.user.can_access_admin, false);
    assert.equal(!!signInResult.body.user.can_access_marketer, false);
    assert.equal(!!signInResult.body.user.can_access_manager, false);
  } finally {
    await closePool(h.db);
  }
});

test('cloud apply_user_operations plus verify_user_login_state marks marketer ready only after exact temp password matches', async () => {
  const h = await setupHarness();
  try {
    await signIn(h.agent, 'ADMIN1001', 'Admin123A', 'admin');

    const apply = await h.agent.post('/api/cloud').send({
      action: 'apply_user_operations',
      user_operations: [
        {
          op: 'create_user',
          wwid: 'NEWMARK9001',
          role: 'marketer',
          display_name: 'New Marketer',
          force_password_reset: true,
          metadata: {
            first_name: 'New',
            last_name: 'Marketer',
            work_email: 'newmarketer9001@example.com',
            temp_password: 'Temp456A',
          },
        },
      ],
    });

    assert.equal(apply.status, 200, `Apply failed: ${JSON.stringify(apply.body)}`);
    assert.equal(apply.body.ok, true);

    const verify = await h.agent.post('/api/cloud').send({
      action: 'verify_user_login_state',
      role: 'marketer',
      identifier: 'NEWMARK9001',
      expected_wwid: 'NEWMARK9001',
      expected_email: 'newmarketer9001@example.com',
      expected_force_password_reset: true,
      expected_password: 'Temp456A',
    });

    assert.equal(verify.status, 200, `Verify failed: ${JSON.stringify(verify.body)}`);
    assert.equal(verify.body.ok, true);
    assert.equal(verify.body.ready, true);
    assert.equal(verify.body.verification_state, 'cloud_ready');
    assert.equal(verify.body.checks.password_match, true);
    assert.equal(verify.body.checks.force_password_reset_match, true);
  } finally {
    await closePool(h.db);
  }
});

test('cloud verify_user_login_state reports drift until repair operation reapplies the expected temp password', async () => {
  const h = await setupHarness();
  try {
    await signIn(h.agent, 'ADMIN1001', 'Admin123A', 'admin');

    await h.agent.post('/api/cloud').send({
      action: 'apply_user_operations',
      user_operations: [
        {
          op: 'create_user',
          wwid: 'REPAIR9002',
          role: 'marketer',
          display_name: 'Repair Marketer',
          force_password_reset: true,
          metadata: {
            first_name: 'Repair',
            last_name: 'Marketer',
            work_email: 'repair9002@example.com',
            temp_password: 'Temp456A',
          },
        },
      ],
    });

    const drift = await h.agent.post('/api/cloud').send({
      action: 'verify_user_login_state',
      role: 'marketer',
      identifier: 'REPAIR9002',
      expected_wwid: 'REPAIR9002',
      expected_email: 'repair9002@example.com',
      expected_force_password_reset: true,
      expected_password: 'Wrong456A',
    });

    assert.equal(drift.status, 200, `Drift verify failed: ${JSON.stringify(drift.body)}`);
    assert.equal(drift.body.ok, true);
    assert.equal(drift.body.ready, false);
    assert.equal(drift.body.verification_state, 'drift_detected');
    assert.ok(Array.isArray(drift.body.failures));
    assert.ok(drift.body.failures.some((row) => row.code === 'TEMP_PASSWORD_MISMATCH'));

    const repair = await h.agent.post('/api/cloud').send({
      action: 'apply_user_operations',
      user_operations: [
        {
          op: 'update_user',
          wwid: 'REPAIR9002',
          role: 'marketer',
          display_name: 'Repair Marketer',
          force_password_reset: true,
          metadata: {
            first_name: 'Repair',
            last_name: 'Marketer',
            work_email: 'repair9002@example.com',
            temp_password: 'Fixed456A',
          },
        },
      ],
    });

    assert.equal(repair.status, 200, `Repair apply failed: ${JSON.stringify(repair.body)}`);
    assert.equal(repair.body.ok, true);

    const repaired = await h.agent.post('/api/cloud').send({
      action: 'verify_user_login_state',
      role: 'marketer',
      identifier: 'REPAIR9002',
      expected_wwid: 'REPAIR9002',
      expected_email: 'repair9002@example.com',
      expected_force_password_reset: true,
      expected_password: 'Fixed456A',
    });

    assert.equal(repaired.status, 200, `Repaired verify failed: ${JSON.stringify(repaired.body)}`);
    assert.equal(repaired.body.ok, true);
    assert.equal(repaired.body.ready, true);
    assert.equal(repaired.body.verification_state, 'cloud_ready');
  } finally {
    await closePool(h.db);
  }
});

test('cloud password reset rotation invalidates the old temporary password and accepts the new one', async () => {
  const h = await setupHarness();
  try {
    await signIn(h.agent, 'ADMIN1001', 'Admin123A', 'admin');

    const initialTemp = 'Temp456A';
    const rotatedTemp = 'Fresh789A';

    const create = await h.agent.post('/api/cloud').send({
      action: 'apply_user_operations',
      user_operations: [
        {
          op: 'create_user',
          wwid: 'RESET9003',
          role: 'marketer',
          display_name: 'Reset Marketer',
          force_password_reset: true,
          metadata: {
            first_name: 'Reset',
            last_name: 'Marketer',
            work_email: 'reset9003@example.com',
            temp_password: initialTemp,
          },
        },
      ],
    });

    assert.equal(create.status, 200, `Create apply failed: ${JSON.stringify(create.body)}`);
    assert.equal(create.body.ok, true);

    const reset = await h.agent.post('/api/cloud').send({
      action: 'apply_user_operations',
      user_operations: [
        {
          op: 'update_user',
          wwid: 'RESET9003',
          role: 'marketer',
          display_name: 'Reset Marketer',
          force_password_reset: true,
          metadata: {
            first_name: 'Reset',
            last_name: 'Marketer',
            work_email: 'reset9003@example.com',
            temp_password: rotatedTemp,
          },
        },
      ],
    });

    assert.equal(reset.status, 200, `Reset apply failed: ${JSON.stringify(reset.body)}`);
    assert.equal(reset.body.ok, true);

    const oldVerify = await h.agent.post('/api/cloud').send({
      action: 'verify_user_login_state',
      role: 'marketer',
      identifier: 'RESET9003',
      expected_wwid: 'RESET9003',
      expected_email: 'reset9003@example.com',
      expected_force_password_reset: true,
      expected_password: initialTemp,
    });

    assert.equal(oldVerify.status, 200, `Old password verify failed: ${JSON.stringify(oldVerify.body)}`);
    assert.equal(oldVerify.body.ok, true);
    assert.equal(oldVerify.body.ready, false);
    assert.equal(oldVerify.body.verification_state, 'drift_detected');
    assert.ok(Array.isArray(oldVerify.body.failures));
    assert.ok(oldVerify.body.failures.some((row) => row.code === 'TEMP_PASSWORD_MISMATCH'));

    const newVerify = await h.agent.post('/api/cloud').send({
      action: 'verify_user_login_state',
      role: 'marketer',
      identifier: 'RESET9003',
      expected_wwid: 'RESET9003',
      expected_email: 'reset9003@example.com',
      expected_force_password_reset: true,
      expected_password: rotatedTemp,
    });

    assert.equal(newVerify.status, 200, `New password verify failed: ${JSON.stringify(newVerify.body)}`);
    assert.equal(newVerify.body.ok, true);
    assert.equal(newVerify.body.ready, true);
    assert.equal(newVerify.body.verification_state, 'cloud_ready');
    assert.equal(newVerify.body.checks.password_match, true);
  } finally {
    await closePool(h.db);
  }
});

test('cloud apply_user_operations rejects malformed update rows before any write occurs', async () => {
  const h = await setupHarness();
  try {
    await signIn(h.agent, 'ADMIN1001', 'Admin123A', 'admin');
    const beforeUsers = await h.agent.get('/api/users');
    const before = beforeUsers.body.users.find((row) => String((row && row.wwid) || '').trim().toUpperCase() === 'MARK1001');
    assert.ok(before, 'Expected MARK1001 before malformed update test');

    const apply = await h.agent.post('/api/cloud').send({
      action: 'apply_user_operations',
      user_operations: [
        {
          op: 'update_user',
          wwid: 'MARK1001',
          display_name: 'Bad Update',
          metadata: {
            work_email: 'bad-update@example.com',
          },
        },
      ],
    });

    assert.equal(apply.status, 400, `Malformed update should fail: ${JSON.stringify(apply.body)}`);
    assert.equal(apply.body.ok, false);
    assert.match(String(apply.body.message || ''), /explicit role/i);

    const afterUsers = await h.agent.get('/api/users');
    const after = afterUsers.body.users.find((row) => String((row && row.wwid) || '').trim().toUpperCase() === 'MARK1001');
    assert.ok(after, 'Expected MARK1001 after malformed update test');
    assert.equal(after.workEmail, before.workEmail);
    assert.equal(after.name, before.name);
  } finally {
    await closePool(h.db);
  }
});

test('update_user can match by local_user_id and persist changed WWID/contact fields', async () => {
  const h = await setupHarness();
  try {
    await signIn(h.agent, 'ADMIN1001', 'Admin123A', 'admin');

    const beforeUsers = await h.agent.get('/api/users');
    assert.equal(beforeUsers.status, 200, `Users fetch failed: ${JSON.stringify(beforeUsers.body)}`);
    const existing = beforeUsers.body.users.find((row) => String((row && row.wwid) || '').trim().toUpperCase() === 'MARK1001');
    assert.ok(existing, 'Expected MARK1001 before update');

    const update = await h.agent.post('/api/cloud').send({
      action: 'apply_user_operations',
      user_operations: [
        {
          op: 'update_user',
          wwid: 'MARK1001X',
          role: 'marketer',
          display_name: 'Michael Updated',
          metadata: {
            local_user_id: existing.id,
            first_name: 'Michael',
            last_name: 'Updated',
            work_email: 'mark1001.updated@example.com',
            phone: '555-2222',
          },
        },
      ],
    });

    assert.equal(update.status, 200, `User update failed: ${JSON.stringify(update.body)}`);
    assert.equal(update.body.ok, true);

    const afterUsers = await h.agent.get('/api/users');
    assert.equal(afterUsers.status, 200, `Users fetch failed after update: ${JSON.stringify(afterUsers.body)}`);
    const updated = afterUsers.body.users.find((row) => String((row && row.wwid) || '').trim().toUpperCase() === 'MARK1001X');
    assert.ok(updated, 'Expected updated marketer with new WWID');
    assert.equal(updated.firstName, 'Michael');
    assert.equal(updated.lastName, 'Updated');
    assert.equal(updated.workEmail, 'mark1001.updated@example.com');
    assert.equal(updated.phoneNumber, '555-2222');
    assert.equal(afterUsers.body.users.some((row) => String((row && row.wwid) || '').trim().toUpperCase() === 'MARK1001'), false);

    const lookup = await h.agent.post('/api/cloud').send({
      action: 'auth_lookup',
      role: 'marketer',
      identifier: 'MARK1001X',
    });
    assert.equal(lookup.status, 200, `Lookup failed after WWID update: ${JSON.stringify(lookup.body)}`);
    assert.equal(lookup.body.ok, true);
    assert.equal(lookup.body.found, true);
    assert.equal(Object.prototype.hasOwnProperty.call(lookup.body.user || {}, 'wwid'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(lookup.body.user || {}, 'work_email'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(lookup.body.user || {}, 'updated_at'), false);
  } finally {
    await closePool(h.db);
  }
});

test('admin user operations honor marketer and manager role flags from metadata', async () => {
  const h = await setupHarness();
  try {
    await signIn(h.agent, 'ADMIN1001', 'Admin123A', 'admin');

    const create = await h.agent.post('/api/cloud').send({
      action: 'apply_user_operations',
      user_operations: [
        {
          op: 'create_user',
          wwid: 'ROLEFLAG9008',
          role: 'primary_admin',
          display_name: 'Role Flag Admin',
          metadata: {
            first_name: 'Role',
            last_name: 'Flag',
            work_email: 'roleflag9008@example.com',
            can_access_marketer: false,
            can_access_manager: false,
          },
        },
      ],
    });

    assert.equal(create.status, 200, `Admin create failed: ${JSON.stringify(create.body)}`);
    assert.equal(create.body.ok, true);

    const afterCreate = await h.agent.get('/api/users');
    const created = afterCreate.body.users.find((row) => String((row && row.wwid) || '').trim().toUpperCase() === 'ROLEFLAG9008');
    assert.ok(created, 'Expected created admin in /api/users');
    assert.equal(created.role, 'admin');
    assert.equal(created.isAssistant, false);
    assert.equal(created.canAccessMarketer, false);
    assert.equal(created.canAccessManager, false);

    const update = await h.agent.post('/api/cloud').send({
      action: 'apply_user_operations',
      user_operations: [
        {
          op: 'update_user',
          wwid: 'ROLEFLAG9008',
          role: 'assistant_admin',
          display_name: 'Role Flag Admin',
          metadata: {
            local_user_id: created.id,
            first_name: 'Role',
            last_name: 'Flag',
            work_email: 'roleflag9008@example.com',
            can_access_marketer: true,
            can_access_manager: true,
          },
        },
      ],
    });

    assert.equal(update.status, 200, `Admin update failed: ${JSON.stringify(update.body)}`);
    assert.equal(update.body.ok, true);

    const afterUpdate = await h.agent.get('/api/users');
    const updated = afterUpdate.body.users.find((row) => String((row && row.wwid) || '').trim().toUpperCase() === 'ROLEFLAG9008');
    assert.ok(updated, 'Expected updated admin in /api/users');
    assert.equal(updated.role, 'admin');
    assert.equal(updated.isAssistant, true);
    assert.equal(updated.canAccessMarketer, true);
    assert.equal(updated.canAccessManager, true);
  } finally {
    await closePool(h.db);
  }
});

test('api users excludes deleted accounts so deleted WWIDs can be reused', async () => {
  const h = await setupHarness();
  try {
    await signIn(h.agent, 'ADMIN1001', 'Admin123A', 'admin');

    const create = await h.agent.post('/api/cloud').send({
      action: 'apply_user_operations',
      user_operations: [
        {
          op: 'create_user',
          wwid: 'REUSE9004',
          role: 'marketer',
          display_name: 'Reuse Marketer',
          force_password_reset: true,
          metadata: {
            first_name: 'Reuse',
            last_name: 'Marketer',
            work_email: 'reuse9004@example.com',
            temp_password: 'Reuse456A',
          },
        },
      ],
    });

    assert.equal(create.status, 200, `Create apply failed: ${JSON.stringify(create.body)}`);
    assert.equal(create.body.ok, true);

    const remove = await h.agent.post('/api/cloud').send({
      action: 'apply_user_operations',
      user_operations: [
        {
          op: 'delete_user',
          wwid: 'REUSE9004',
          role: 'marketer',
        },
      ],
    });

    assert.equal(remove.status, 200, `Delete apply failed: ${JSON.stringify(remove.body)}`);
    assert.equal(remove.body.ok, true);

    const users = await h.agent.get('/api/users');
    assert.equal(users.status, 200, `Users fetch failed: ${JSON.stringify(users.body)}`);
    assert.equal(users.body.ok, true);
    assert.ok(Array.isArray(users.body.users));
    assert.equal(users.body.users.some((row) => String((row && row.wwid) || '').trim().toUpperCase() === 'REUSE9004'), false);
  } finally {
    await closePool(h.db);
  }
});

test('inactive durable users still exist in /api/users even though auth_lookup reports them missing', async () => {
  const h = await setupHarness();
  try {
    await signIn(h.agent, 'ADMIN1001', 'Admin123A', 'admin');

    const deactivate = await h.agent.post('/api/cloud').send({
      action: 'apply_user_operations',
      user_operations: [
        {
          op: 'set_user_status',
          wwid: 'MARK1001',
          role: 'marketer',
          status: 'inactive',
        },
      ],
    });

    assert.equal(deactivate.status, 200, `Deactivate failed: ${JSON.stringify(deactivate.body)}`);
    assert.equal(deactivate.body.ok, true);

    const lookup = await request(h.app).post('/api/cloud').send({
      action: 'auth_lookup',
      identifier: 'MARK1001',
      role: 'marketer',
    });

    assert.equal(lookup.status, 200, `auth_lookup failed: ${JSON.stringify(lookup.body)}`);
    assert.equal(lookup.body.ok, true);
    assert.equal(lookup.body.found, false);

    const users = await h.agent.get('/api/users');
    assert.equal(users.status, 200, `Users fetch failed: ${JSON.stringify(users.body)}`);
    assert.equal(users.body.ok, true);
    const inactive = users.body.users.find((row) => String((row && row.wwid) || '').trim().toUpperCase() === 'MARK1001');
    assert.ok(inactive, 'Expected inactive durable user in /api/users');
    assert.equal(String(inactive.status || '').trim().toLowerCase(), 'inactive');
  } finally {
    await closePool(h.db);
  }
});

test('manager session can fetch marketer users only and sees department assignments', async () => {
  const h = await setupHarness();
  try {
    await signIn(h.agent, 'MGR1001', 'Manager123A', 'marketer');

    const users = await h.agent.get('/api/users');
    assert.equal(users.status, 200, `Users fetch failed: ${JSON.stringify(users.body)}`);
    assert.equal(users.body.ok, true);
    assert.ok(Array.isArray(users.body.users));
    assert.equal(users.body.users.some((row) => String((row && row.wwid) || '').trim().toUpperCase() === 'ADMIN1001'), false);
    assert.ok(users.body.users.every((row) => String((row && row.role) || '').trim().toLowerCase() === 'marketer'));

    const self = users.body.users.find((row) => String((row && row.wwid) || '').trim().toUpperCase() === 'MGR1001');
    assert.ok(self, 'Expected manager login user in marketer-scoped list');
    assert.deepEqual(self.departmentIds, ['manager-cat-stores']);
  } finally {
    await closePool(h.db);
  }
});

test('marketer manager directory returns department managers with on-duty flags and contact info', async () => {
  const h = await setupHarness();
  const managerAgent = request.agent(h.app);
  const marketerAgent = request.agent(h.app);
  try {
    await signIn(h.agent, 'ADMIN1001', 'Admin123A', 'admin');

    const create = await h.agent.post('/api/cloud').send({
      action: 'apply_user_operations',
      user_operations: [
        {
          op: 'create_user',
          wwid: 'ASSTMGR9010',
          role: 'marketer',
          display_name: 'Assistant Coverage',
          force_password_reset: true,
          metadata: {
            first_name: 'Assistant',
            last_name: 'Coverage',
            work_email: 'assistant.coverage9010@example.com',
            phone: '555-3333',
            temp_password: 'AssistCover456A',
            department_ids: ['manager-cat-stores'],
            can_access_manager: true,
            manager_only: true,
            manager_title: 'Assistant Manager',
          },
        },
      ],
    });

    assert.equal(create.status, 200, `Assistant manager create failed: ${JSON.stringify(create.body)}`);
    assert.equal(create.body.ok, true);

    await signIn(managerAgent, 'MGR1001', 'Manager123A', 'manager');
    await signIn(marketerAgent, 'MARK1001', 'Marketer123A', 'marketer');

    const directory = await marketerAgent.get('/api/managers/on-duty');
    assert.equal(directory.status, 200, `Manager directory fetch failed: ${JSON.stringify(directory.body)}`);
    assert.equal(directory.body.ok, true);
    assert.ok(Array.isArray(directory.body.managers));

    const manager = directory.body.managers.find((row) => String((row && row.wwid) || '').trim().toUpperCase() === 'MGR1001');
    const assistant = directory.body.managers.find((row) => String((row && row.wwid) || '').trim().toUpperCase() === 'ASSTMGR9010');

    assert.ok(manager, 'Expected on-duty manager in department directory');
    assert.ok(assistant, 'Expected off-duty assistant manager in department directory');
    assert.equal(manager.onDuty, true);
    assert.equal(assistant.onDuty, false);
    assert.equal(assistant.managerTitle, 'Assistant Manager');
    assert.equal(assistant.phoneNumber, '555-3333');
    assert.equal(assistant.workEmail, 'assistant.coverage9010@example.com');
    assert.ok(
      directory.body.managers.every((row) => Array.isArray(row.departmentIds) && row.departmentIds.includes('manager-cat-stores')),
      'Expected manager directory to stay within the marketer department',
    );

    const toggleOff = await managerAgent.post('/api/managers/duty').send({ on_duty: false });
    assert.equal(toggleOff.status, 200, `Manager duty toggle failed: ${JSON.stringify(toggleOff.body)}`);
    assert.equal(toggleOff.body.ok, true);
    assert.equal(toggleOff.body.manager_on_duty, false);
    assert.equal(toggleOff.body.session.managerOnDuty, false);

    const managerSession = await managerAgent.get('/api/auth/session');
    assert.equal(managerSession.status, 200, `Manager session fetch failed: ${JSON.stringify(managerSession.body)}`);
    assert.equal(managerSession.body.ok, true);
    assert.equal(managerSession.body.session.managerOnDuty, false);

    const afterToggle = await marketerAgent.get('/api/managers/on-duty');
    assert.equal(afterToggle.status, 200, `Manager directory after toggle failed: ${JSON.stringify(afterToggle.body)}`);
    const managerAfterToggle = afterToggle.body.managers.find((row) => String((row && row.wwid) || '').trim().toUpperCase() === 'MGR1001');
    assert.ok(managerAfterToggle, 'Expected manager to remain in department directory after duty toggle');
    assert.equal(managerAfterToggle.onDuty, false);
  } finally {
    await closePool(h.db);
  }
});

test('manager session can create a marketer in the manager department but cannot grant manager/admin access', async () => {
  const h = await setupHarness();
  try {
    await signIn(h.agent, 'MGR1001', 'Manager123A', 'marketer');

    const create = await h.agent.post('/api/cloud').send({
      action: 'apply_user_operations',
      user_operations: [
        {
          op: 'create_user',
          wwid: 'MGRMK9005',
          role: 'marketer',
          display_name: 'Manager Created Marketer',
          force_password_reset: true,
          metadata: {
            first_name: 'Manager',
            last_name: 'Created',
            work_email: 'mgrmk9005@example.com',
            temp_password: 'MgrTemp456A',
            department_ids: ['manager-cat-stores', 'manager-cat-hotels'],
          },
        },
      ],
    });

    assert.equal(create.status, 200, `Manager create failed: ${JSON.stringify(create.body)}`);
    assert.equal(create.body.ok, true);

    const verify = await h.agent.post('/api/cloud').send({
      action: 'verify_user_login_state',
      role: 'marketer',
      identifier: 'MGRMK9005',
      expected_wwid: 'MGRMK9005',
      expected_email: 'mgrmk9005@example.com',
      expected_force_password_reset: true,
      expected_password: 'MgrTemp456A',
    });

    assert.equal(verify.status, 200, `Manager verify failed: ${JSON.stringify(verify.body)}`);
    assert.equal(verify.body.ok, true);
    assert.equal(verify.body.ready, true);

    const users = await h.agent.get('/api/users');
    const created = users.body.users.find((row) => String((row && row.wwid) || '').trim().toUpperCase() === 'MGRMK9005');
    assert.ok(created, 'Expected manager-created marketer in manager user list');
    assert.deepEqual(created.departmentIds, ['manager-cat-stores']);

    const denied = await h.agent.post('/api/cloud').send({
      action: 'apply_user_operations',
      user_operations: [
        {
          op: 'create_user',
          wwid: 'MGRBAD9006',
          role: 'marketer',
          display_name: 'Manager Escalation Attempt',
          force_password_reset: true,
          metadata: {
            first_name: 'Escalation',
            last_name: 'Attempt',
            work_email: 'mgrbad9006@example.com',
            temp_password: 'MgrBad456A',
            can_access_manager: true,
            manager_only: true,
          },
        },
      ],
    });

    assert.equal(denied.status, 403, `Manager privilege escalation should fail: ${JSON.stringify(denied.body)}`);
    assert.equal(denied.body.ok, false);
  } finally {
    await closePool(h.db);
  }
});

test('manager verify_user_login_state rejects users outside assigned departments', async () => {
  const h = await setupHarness();
  const manager = request.agent(h.app);
  try {
    await signIn(h.agent, 'ADMIN1001', 'Admin123A', 'admin');

    const create = await h.agent.post('/api/cloud').send({
      action: 'apply_user_operations',
      user_operations: [
        {
          op: 'create_user',
          wwid: 'OUTSIDE9011',
          role: 'marketer',
          display_name: 'Outside Marketer',
          force_password_reset: true,
          metadata: {
            first_name: 'Outside',
            last_name: 'Marketer',
            work_email: 'outside9011@example.com',
            temp_password: 'Outside456A',
            department_ids: ['outside-dept'],
          },
        },
      ],
    });
    assert.equal(create.status, 200, `Admin create failed: ${JSON.stringify(create.body)}`);
    assert.equal(create.body.ok, true);

    await signIn(manager, 'MGR1001', 'Manager123A', 'marketer');
    const verify = await manager.post('/api/cloud').send({
      action: 'verify_user_login_state',
      role: 'marketer',
      identifier: 'OUTSIDE9011',
      expected_wwid: 'OUTSIDE9011',
      expected_email: 'outside9011@example.com',
      expected_force_password_reset: true,
      expected_password: 'Outside456A',
    });

    assert.equal(verify.status, 403, `Expected manager verify scope failure: ${JSON.stringify(verify.body)}`);
    assert.equal(verify.body.ok, false);
    assert.match(String(verify.body.message || ''), /assigned departments/i);
  } finally {
    await closePool(h.db);
  }
});

test('admin-created manager-only user verifies ready through marketer login flow', async () => {
  const h = await setupHarness();
  try {
    await signIn(h.agent, 'ADMIN2001', 'Assist123A', 'admin');

    const create = await h.agent.post('/api/cloud').send({
      action: 'apply_user_operations',
      user_operations: [
        {
          op: 'create_user',
          wwid: 'MGRVR9007',
          role: 'marketer',
          display_name: 'Manager Verify Ready',
          force_password_reset: true,
          metadata: {
            first_name: 'Manager',
            last_name: 'Verify',
            work_email: 'mgrvr9007@example.com',
            temp_password: 'MgrReady456A',
            department_ids: ['manager-cat-stores'],
            can_access_manager: true,
            manager_only: true,
          },
        },
      ],
    });

    assert.equal(create.status, 200, `Manager-only create failed: ${JSON.stringify(create.body)}`);
    assert.equal(create.body.ok, true);

    const verify = await h.agent.post('/api/cloud').send({
      action: 'verify_user_login_state',
      role: 'marketer',
      identifier: 'MGRVR9007',
      expected_wwid: 'MGRVR9007',
      expected_email: 'mgrvr9007@example.com',
      expected_force_password_reset: true,
      expected_password: 'MgrReady456A',
    });

    assert.equal(verify.status, 200, `Manager-only verify failed: ${JSON.stringify(verify.body)}`);
    assert.equal(verify.body.ok, true);
    assert.equal(verify.body.ready, true);

    const signInResult = await h.agent.post('/api/auth/sign-in').send({
      identifier: 'MGRVR9007',
      password: 'MgrReady456A',
      role: 'marketer',
    });

    assert.equal(signInResult.status, 200, `Manager-only sign-in failed: ${JSON.stringify(signInResult.body)}`);
    assert.equal(signInResult.body.ok, true);
  } finally {
    await closePool(h.db);
  }
});

test('cloud save_and_sync rejects malformed user operations before publishing a new snapshot', async () => {
  const h = await setupHarness();
  try {
    await signIn(h.agent, 'ADMIN2001', 'Assist123A', 'admin');
    const published = await h.agent.get('/api/snapshots/published/latest');
    assert.equal(published.status, 200, `Published snapshot fetch failed: ${JSON.stringify(published.body)}`);
    const beforeVersion = Number(published.body.metadata && published.body.metadata.version);

    const saveSend = await h.agent.post('/api/cloud').send({
      action: 'save_and_sync',
      payload: published.body.snapshot,
      request_id: 'malformed-save-send',
      user_operations: [
        {
          op: 'update_user',
          wwid: 'MARK1001',
          display_name: 'Should Not Publish',
          metadata: {
            work_email: 'bad-publish@example.com',
          },
        },
      ],
    });

    assert.equal(saveSend.status, 400, `Malformed save_and_sync should fail: ${JSON.stringify(saveSend.body)}`);
    assert.equal(saveSend.body.ok, false);
    assert.match(String(saveSend.body.message || ''), /explicit role/i);

    const afterPublished = await h.agent.get('/api/snapshots/published/latest');
    assert.equal(afterPublished.status, 200, `Published snapshot fetch after malformed save failed: ${JSON.stringify(afterPublished.body)}`);
    assert.equal(Number(afterPublished.body.metadata && afterPublished.body.metadata.version), beforeVersion);
  } finally {
    await closePool(h.db);
  }
});

test('cloud save_and_sync_status returns unknown for an unrecorded request id', async () => {
  const h = await setupHarness();
  try {
    await signIn(h.agent, 'ADMIN1001', 'Admin123A', 'admin');

    const statusInfo = await h.agent.post('/api/cloud').send({
      action: 'save_and_sync_status',
      request_id: 'missing-save-status',
    });

    assert.equal(statusInfo.status, 404, `Missing save status should return 404: ${JSON.stringify(statusInfo.body)}`);
    assert.equal(statusInfo.body.ok, false);
    assert.equal(statusInfo.body.status, 'unknown');
    assert.equal(statusInfo.body.request_id, 'missing-save-status');
  } finally {
    await closePool(h.db);
  }
});

test('cloud save_and_sync_status returns pending_confirmation for started but unconfirmed requests', async () => {
  const h = await setupHarness();
  try {
    await signIn(h.agent, 'ADMIN1001', 'Admin123A', 'admin');
    const requestId = 'pending-save-status';

    await h.db.query(
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

    const pending = await h.agent.post('/api/cloud').send({
      action: 'save_and_sync_status',
      request_id: requestId,
    });

    assert.equal(pending.status, 202, `Pending save status should return 202: ${JSON.stringify(pending.body)}`);
    assert.equal(pending.body.ok, false);
    assert.equal(pending.body.status, 'pending_confirmation');
    assert.equal(pending.body.request_id, requestId);
    assert.equal(pending.body.expected_version, 7);
    assert.equal(pending.body.expected_stamp, '2026-04-20T16:00:00.000Z|7');
  } finally {
    await closePool(h.db);
  }
});

test('cloud save_and_sync_status returns confirmed_failure for failed requests', async () => {
  const h = await setupHarness();
  try {
    await signIn(h.agent, 'ADMIN1001', 'Admin123A', 'admin');
    const requestId = 'failed-save-status';

    await h.db.query(
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

    await h.db.query(
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

    const failed = await h.agent.post('/api/cloud').send({
      action: 'save_and_sync_status',
      request_id: requestId,
    });

    assert.equal(failed.status, 200, `Confirmed failure status should return 200: ${JSON.stringify(failed.body)}`);
    assert.equal(failed.body.ok, false);
    assert.equal(failed.body.status, 'confirmed_failure');
    assert.equal(failed.body.request_id, requestId);
    assert.equal(failed.body.code, 'INJECTED_FAILURE');
    assert.equal(failed.body.message, 'Injected save failure.');
  } finally {
    await closePool(h.db);
  }
});

test('cloud save_and_sync_status returns confirmed_success for completed save_and_sync requests and replays by request id', async () => {
  const h = await setupHarness();
  try {
    await signIn(h.agent, 'ADMIN1001', 'Admin123A', 'admin');
    const published = await h.agent.get('/api/snapshots/published/latest');
    assert.equal(published.status, 200, `Published snapshot fetch failed: ${JSON.stringify(published.body)}`);
    const beforeVersion = Number(published.body.metadata && published.body.metadata.version);
    const requestId = 'successful-save-status';

    const saveSend = await h.agent.post('/api/cloud').send({
      action: 'save_and_sync',
      payload: published.body.snapshot,
      request_id: requestId,
    });

    assert.equal(saveSend.status, 200, `save_and_sync should succeed: ${JSON.stringify(saveSend.body)}`);
    assert.equal(saveSend.body.ok, true);
    assert.equal(saveSend.body.status, 'confirmed_success');
    assert.equal(saveSend.body.request_id, requestId);

    const statusInfo = await h.agent.post('/api/cloud').send({
      action: 'save_and_sync_status',
      request_id: requestId,
    });

    assert.equal(statusInfo.status, 200, `save_and_sync_status should confirm success: ${JSON.stringify(statusInfo.body)}`);
    assert.equal(statusInfo.body.ok, true);
    assert.equal(statusInfo.body.status, 'confirmed_success');
    assert.equal(statusInfo.body.request_id, requestId);
    assert.equal(Number(statusInfo.body.version || 0), beforeVersion + 1);

    const replay = await h.agent.post('/api/cloud').send({
      action: 'save_and_sync',
      payload: published.body.snapshot,
      request_id: requestId,
    });

    assert.equal(replay.status, 200, `Repeated request id should replay prior success: ${JSON.stringify(replay.body)}`);
    assert.equal(replay.body.ok, true);
    assert.equal(replay.body.status, 'confirmed_success');
    assert.equal(replay.body.request_id, requestId);

    const afterPublished = await h.agent.get('/api/snapshots/published/latest');
    assert.equal(afterPublished.status, 200, `Published snapshot fetch after save failed: ${JSON.stringify(afterPublished.body)}`);
    assert.equal(Number(afterPublished.body.metadata && afterPublished.body.metadata.version), beforeVersion + 1);
  } finally {
    await closePool(h.db);
  }
});

test('cloud health_check and auth_lookup still behave unchanged with save_and_sync_status support', async () => {
  const h = await setupHarness();
  try {
    await signIn(h.agent, 'ADMIN1001', 'Admin123A', 'admin');

    const health = await h.agent.post('/api/cloud').send({
      action: 'health_check',
    });
    assert.equal(health.status, 200, `health_check should still succeed: ${JSON.stringify(health.body)}`);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.configured, true);

    const lookup = await h.agent.post('/api/cloud').send({
      action: 'auth_lookup',
      identifier: 'ADMIN1001',
      role: 'admin',
    });
    assert.equal(lookup.status, 200, `auth_lookup should still succeed: ${JSON.stringify(lookup.body)}`);
    assert.equal(lookup.body.ok, true);
    assert.equal(lookup.body.found, true);
    assert.equal(lookup.body.account_state, 'available');
  } finally {
    await closePool(h.db);
  }
});
