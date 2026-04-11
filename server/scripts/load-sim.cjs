const { HttpClient } = require('./lib/http-client.cjs');

const BASE_URL = String(process.env.API_BASE_URL || process.env.TEST_API_BASE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const ITERATIONS = Math.max(1, Number.parseInt(String(process.env.SIM_ITERATIONS || process.argv[2] || '12'), 10) || 12);

const USERS = {
  admin1: { identifier: 'ADMIN1001', password: 'Admin123A', role: 'admin' },
  admin2: { identifier: 'ADMIN2001', password: 'Assist123A', role: 'admin' },
  marketer1: { identifier: 'MARK1001', password: 'Marketer123A', role: 'marketer' },
  marketer2: { identifier: 'MARK2002', password: 'MarketerTwo123A', role: 'marketer' },
};

function bookingId(prefix, idx) {
  return `${prefix}-${idx}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

async function signIn(client, user) {
  const res = await client.request('POST', '/api/auth/sign-in', user);
  if (!(res.status === 200 && res.body && res.body.ok === true)) {
    throw new Error(`Sign-in failed for ${user.identifier}: ${JSON.stringify(res.body)}`);
  }
}

async function latestVersion(client) {
  const res = await client.request('GET', '/api/snapshots/published/latest');
  if (!(res.status === 200 && res.body && res.body.ok === true)) {
    throw new Error(`Failed to fetch latest snapshot: ${JSON.stringify(res.body)}`);
  }
  return Number(res.body.metadata && res.body.metadata.version) || 1;
}

async function run() {
  console.log(`Running lightweight load simulation against ${BASE_URL}`);
  console.log(`Iterations: ${ITERATIONS}`);

  const adminA = new HttpClient(BASE_URL);
  const adminB = new HttpClient(BASE_URL);
  const marketerA = new HttpClient(BASE_URL);
  const marketerB = new HttpClient(BASE_URL);

  await Promise.all([
    signIn(adminA, USERS.admin1),
    signIn(adminB, USERS.admin2),
    signIn(marketerA, USERS.marketer1),
    signIn(marketerB, USERS.marketer2),
  ]);

  let sessionChecks = 0;
  let bookingCreates = 0;
  let claimWins = 0;
  let claimConflicts = 0;

  for (let i = 0; i < ITERATIONS; i += 1) {
    const marketer = i % 2 === 0 ? marketerA : marketerB;
    const version = await latestVersion(marketer);
    const id = bookingId('load', i);
    const create = await marketer.request('POST', '/api/bookings', {
      id,
      brandId: 'brand-medieval-times',
      brandName: 'Medieval Times',
      guestFirstName: `Load${i}`,
      guestLastName: 'User',
      showDate: '2026-04-20',
      showTime: '18:00',
      snapshotVersion: version,
      quoteLines: [{ ticketLineId: 'line-medieval-adult', qty: 1, freeQty: 0, extraEach: 0 }],
      clientTotals: { retailTotal: 0.01, costTotal: 0.01, profit: 99999 },
    });
    if (create.status === 201) bookingCreates += 1;

    const [claimA, claimB] = await Promise.all([
      adminA.request('POST', `/api/bookings/${id}/claim`, { actor_device: 'load-a' }),
      adminB.request('POST', `/api/bookings/${id}/claim`, { actor_device: 'load-b' }),
    ]);
    const outcomes = [claimA, claimB];
    claimWins += outcomes.filter((r) => r.status === 200 && r.body && r.body.ok === true).length;
    claimConflicts += outcomes.filter((r) => r.status >= 400 || (r.body && r.body.ok === false)).length;

    const [s1, s2, s3, s4] = await Promise.all([
      adminA.request('GET', '/api/auth/session'),
      adminB.request('GET', '/api/auth/session'),
      marketerA.request('GET', '/api/auth/session'),
      marketerB.request('GET', '/api/auth/session'),
    ]);
    sessionChecks += [s1, s2, s3, s4].filter((r) => r.status === 200).length;
  }

  console.log('');
  console.log('Load simulation complete.');
  console.log(`Booking create success: ${bookingCreates}/${ITERATIONS}`);
  console.log(`Claim success count: ${claimWins}`);
  console.log(`Claim conflict count: ${claimConflicts}`);
  console.log(`Session checks 200 OK: ${sessionChecks}/${ITERATIONS * 4}`);
}

run().catch((error) => {
  const message = String((error && error.message) || error || 'Load simulation failed');
  console.error(`Load simulation failed: ${message}`);
  process.exit(1);
});
