const { HttpClient } = require('./lib/http-client.cjs');

const BASE_URL = String(process.env.API_BASE_URL || process.env.TEST_API_BASE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');

const USERS = {
  admin1: { identifier: 'ADMIN1001', password: 'Admin123A', role: 'admin' },
  admin2: { identifier: 'ADMIN2001', password: 'Assist123A', role: 'admin' },
  marketer1: { identifier: 'MARK1001', password: 'Marketer123A', role: 'marketer' },
  marketer2: { identifier: 'MARK2002', password: 'MarketerTwo123A', role: 'marketer' },
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function bookingId(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

async function signIn(client, user) {
  const res = await client.request('POST', '/api/auth/sign-in', user);
  assert(res.status === 200 && res.body && res.body.ok === true, `Sign-in failed for ${user.identifier}`);
  return res;
}

async function latestVersion(client) {
  const res = await client.request('GET', '/api/snapshots/published/latest');
  assert(res.status === 200 && res.body && res.body.ok === true, 'Unable to load latest snapshot');
  return Number(res.body.metadata && res.body.metadata.version) || 1;
}

async function createBooking(client, id, snapshotVersion) {
  return client.request('POST', '/api/bookings', {
    id,
    brandId: 'brand-medieval-times',
    brandName: 'Medieval Times',
    guestFirstName: 'Test',
    guestLastName: 'Guest',
    showDate: '2026-04-15',
    showTime: '19:00',
    snapshotVersion,
    quoteLines: [{ ticketLineId: 'line-medieval-adult', qty: 1, freeQty: 0, extraEach: 0 }],
    clientTotals: { retailTotal: 1, costTotal: 1, profit: 99999 },
  });
}

async function scenarioNonAdminPublishBlocked() {
  const marketer = new HttpClient(BASE_URL);
  await signIn(marketer, USERS.marketer1);
  const publish = await marketer.request('POST', '/api/admin/publish', {});
  assert(publish.status === 403, `Expected 403, got ${publish.status}`);
  console.log('PASS non-admin publish blocked');
}

async function scenarioStaleSnapshot() {
  const marketer = new HttpClient(BASE_URL);
  const admin = new HttpClient(BASE_URL);
  await signIn(marketer, USERS.marketer1);
  const oldVersion = await latestVersion(marketer);
  await signIn(admin, USERS.admin1);
  const publish = await admin.request('POST', '/api/admin/publish', {});
  assert(publish.status === 200, `Publish failed with ${publish.status}`);
  const stale = await createBooking(marketer, bookingId('stale'), oldVersion);
  assert(stale.status === 409, `Expected stale booking 409, got ${stale.status}`);
  assert(stale.body && stale.body.code === 'SNAPSHOT_STALE', `Expected SNAPSHOT_STALE code, got ${JSON.stringify(stale.body)}`);
  console.log('PASS stale snapshot booking blocked');
}

async function scenarioClaimConflict() {
  const marketer = new HttpClient(BASE_URL);
  const adminA = new HttpClient(BASE_URL);
  const adminB = new HttpClient(BASE_URL);

  await signIn(marketer, USERS.marketer2);
  const version = await latestVersion(marketer);
  const id = bookingId('claim');
  const created = await createBooking(marketer, id, version);
  assert(created.status === 201, `Booking create failed ${created.status}`);

  await signIn(adminA, USERS.admin1);
  await signIn(adminB, USERS.admin2);
  const [a, b] = await Promise.all([
    adminA.request('POST', `/api/bookings/${id}/claim`, { actor_device: 'sim-a' }),
    adminB.request('POST', `/api/bookings/${id}/claim`, { actor_device: 'sim-b' }),
  ]);
  const okCount = [a, b].filter((r) => r.status === 200 && r.body && r.body.ok === true).length;
  const failCount = [a, b].filter((r) => r.status >= 400 || (r.body && r.body.ok === false)).length;
  assert(okCount === 1 && failCount === 1, `Expected one claim success/one fail. A=${JSON.stringify(a)} B=${JSON.stringify(b)}`);
  console.log('PASS booking claim conflict handling');
}

async function scenarioSessionRevocation() {
  const admin = new HttpClient(BASE_URL);
  await signIn(admin, USERS.admin1);
  const check1 = await admin.request('GET', '/api/auth/session');
  assert(check1.status === 200 && check1.body && check1.body.session && check1.body.session.isAuthenticated === true, 'Expected active session');
  const signOut = await admin.request('POST', '/api/auth/sign-out', {});
  assert(signOut.status === 200, `Sign-out failed: ${signOut.status}`);
  const check2 = await admin.request('GET', '/api/auth/session');
  assert(check2.status === 200 && check2.body && check2.body.session && check2.body.session.isAuthenticated === false, 'Expected revoked session');
  console.log('PASS session sign-out/revocation');

  const expiryWaitMs = Math.max(0, Number.parseInt(String(process.env.SIM_EXPECT_EXPIRY_MS || '0'), 10) || 0);
  if (expiryWaitMs > 0) {
    await signIn(admin, USERS.admin1);
    await new Promise((resolve) => setTimeout(resolve, expiryWaitMs));
    const expired = await admin.request('GET', '/api/auth/session');
    assert(
      expired.status === 200 &&
        expired.body &&
        expired.body.session &&
        expired.body.session.isAuthenticated === false,
      `Expected session expiration after wait=${expiryWaitMs}ms`,
    );
    console.log(`PASS session expiration check (${expiryWaitMs}ms wait)`);
  }
}

const SCENARIOS = {
  'non-admin': scenarioNonAdminPublishBlocked,
  stale: scenarioStaleSnapshot,
  conflict: scenarioClaimConflict,
  session: scenarioSessionRevocation,
  all: async () => {
    await scenarioNonAdminPublishBlocked();
    await scenarioStaleSnapshot();
    await scenarioClaimConflict();
    await scenarioSessionRevocation();
  },
};

async function run() {
  const target = String(process.argv[2] || 'all').trim().toLowerCase();
  const fn = SCENARIOS[target];
  if (!fn) {
    console.error(`Unknown scenario "${target}". Use: all, non-admin, stale, conflict, session`);
    process.exit(1);
  }
  console.log(`Running scenario "${target}" against ${BASE_URL}`);
  await fn();
  console.log('Scenario run complete.');
}

run().catch((error) => {
  const message = String((error && error.message) || error || 'Scenario failed');
  console.error(`Scenario failed: ${message}`);
  process.exit(1);
});
