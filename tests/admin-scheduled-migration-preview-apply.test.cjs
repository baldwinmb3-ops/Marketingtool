const test = require('node:test');
const assert = require('node:assert/strict');
const { newDb } = require('pg-mem');

const { createApp } = require('../server/app.cjs');
const { closePool, withDb, upsertUserRow, readDb } = require('../server/db.cjs');
const { hashPassword } = require('../server/lib.cjs');
const { sanitizeCatalogPayload } = require('../server/domain.cjs');
const {
  buildScheduledMigrationSummary,
  PUBLISH_BASE_VERSION_STALE_CODE,
  SMOKE_PUBLISH_BLOCKED_CODE,
} = require('../server/catalog-publish-guard.cjs');

const VERSION_STAMP = '2026-05-26T17:46:25.435Z';
const BASE_VERSION = 281;

const SCHEDULED_TRUE_BRANDS = [
  { name: 'AArons Dinner woop', id: 'brand-aarons-dinner-woop' },
  { name: 'Alabama Christmas', id: 'brand-alabama-christmas' },
  { name: 'Alabama Theater Balcony', id: 'brand-alabama-theater-balcony' },
  { name: 'Alabama Theater Orchestra', id: 'brand-alabama-theater-orchestra' },
  { name: 'Alabama Theatre Floor', id: 'brand-alabama-theatre-floor' },
  { name: 'Barefoot Queen Riverboat Dinner Cruise', id: 'brand-att-barefoot-queen-dinner-cruise', category: 'Attractions', showInCalendar: false },
  { name: 'Barefoot Queen Riverboat Sightseeing Cruise', id: 'brand-att-barefoot-queen-sightseeing-cruise', category: 'Attractions', showInCalendar: false },
  { name: 'Carolina Opry', id: 'brand-carolina-opry' },
  { name: 'Charles Bach Wonders', id: 'brand-show-charles-bach-wonders' },
  { name: 'Greg Rowles Legacy Theater', id: 'brand-show-greg-rowles-legacy' },
  { name: 'HOB Gospel Brunch', id: 'brand-hob-gospel-brunch' },
  { name: 'House of Blues Gospel Brunch', id: 'brand-house-of-blues-gospel-brunch' },
  { name: 'House of Blues Murder Mystery', id: 'brand-house-of-blues-murder-mystery' },
  { name: 'House of Blues Myrtle Beach', id: 'brand-house-of-blues-myrtle-beach' },
  { name: 'Le Grand Circ Disco', id: 'brand-le-grand-circ-disco' },
  { name: 'Le Grand Circ Maximum Velocity', id: 'brand-le-grand-circ-maximum-velocity' },
  { name: 'Le Grand Cirque - Winter in the Air', id: 'brand-le-grand-cirque-winter-in-the-air' },
  { name: 'Legends in Concert', id: 'brand-show-legends-in-concert' },
  { name: 'Medieval Times', id: 'brand-medieval-times' },
  { name: 'Pirates Voyage', id: 'brand-pirates-voyage' },
  { name: 'Steve Falcon Comedy Hypnosis Hour', id: 'brand-steve-falcon-comedy-hypnosis-hour' },
];

const SCHEDULED_FALSE_BRANDS = [
  'AArons go carts',
  'Aaroo rides',
  'American Express Reward Cards',
  'Benjamins Seafood',
  'Bloomin Brands Group',
  'Broadway Grand Prix',
  'Brookgreen Gardens',
  'Brothers Grill',
  'Cancun Lagoon Mini Golf',
  "Captain Jack's Seafood Buffet",
  "Combo Ripley's Aquarium",
  'Crave Italian Grill',
  'Darden Brands Group',
  "Dave & Busters Food Card",
  'Dave And Busters Game Card - Not Food',
  "Dick's Last Resort (Myrtle Beach Only)",
  'Divine Dining',
  'Down Wind Sails Parasail',
  'Downwind Sails, Bannana Boat',
  'Duplin Winery Tasting',
  'Duplin Winery Tasting - 1 Person',
  'Fun Warehouse',
  'GAV Group Restaurant',
  'Gift-Up Margaritaville at Sea',
  'Global Amenities OPC Piece',
  'Greg Norman Australian Grill',
  'Hard Rock Myrtle Beach Voucher',
  'Hollywood Wax Museum',
  'Hollywood Wax Museum All Access',
  'House of Blues - Gift Certificate',
  "Landry's Seafood",
  'Legends Round of Golf',
  "Lenny's Pancake House",
  'Liberty Tap Room & Grill',
  "Lulu's Restaurant",
  'Margaritaville/Landshark - IMC in Journey',
  'MB Watersports',
  'Molten Mountain Miniature Golf',
  'Murder in the Wild West Dinner Show',
  'Mutiny Bay Mini Golf',
  'Myrtle Waves GA',
  'Pavilion 360 Observation Wheel',
  'Pavilion Park',
  'Pier 14 on the Ocean',
  'RCI Certificate - 8 Day / 7 Night Vacation',
  'RCI Getaway Certificate - 2 to 6 Night Stay',
  "RigaTony's Dinner Show",
  'Rioz Brazilian Steakhouse',
  "Ripley's Aquarium",
  "Sea Captain's House",
  'Sea Screamer / Sea Thunder Dolphin Cruise',
  'Sea Screamer/Thunder Dolphin Cruise',
  'Shark Wake Obstacle Island 1 Session 50 mins',
  'Skywheel',
  'SOHO Main Street NMB',
  'Tango Rewards Link',
  'Tbonz Gill & Grill',
  'The Escape Room Myrtle Beach',
  "The Original Geno's Pizza",
  'Tidal Creek Brewhouse',
  'True Incentive',
  'Uber + Uber Eats Voucher',
  'Vacation Pass',
  'Voodoo Brewery',
  'Wicked Tuna',
  'Wonder Works - General Admission',
  'Wonder Works All Access',
  'Wyndham Rewards',
  'ZZ LIVE TEST PARASAIL',
];

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function listen(serverApp) {
  return new Promise((resolve, reject) => {
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

function slugifyName(name, index = 0) {
  return `brand-migration-${String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || `row-${index}`}`;
}

function buildTrueBrand(entry, index) {
  const brand = {
    id: entry.id || slugifyName(entry.name, index),
    name: entry.name,
    category: entry.category || 'Shows',
    active: true,
    showInCalendar: entry.showInCalendar !== undefined ? !!entry.showInCalendar : true,
    bookingRequired: false,
    note: `${entry.name} note`,
  };
  if (entry.id === 'brand-medieval-times') {
    brand.showScheduleDates = {
      '2026-06-01': ['7:00 PM', '9:00 PM'],
      '2026-06-02': ['7:00 PM'],
    };
    brand.showScheduleStatus = {
      '2026-06-01': { '9:00 PM': 'soldout' },
    };
    brand.showAlertHistory = [
      { id: 'legacy-brand-medieval-times-2026-05-08T17:42:09.312Z', message: 'Legacy alert snapshot', active: false },
    ];
  } else if (entry.id === 'brand-carolina-opry') {
    brand.showScheduleDates = { '2026-06-03': ['8:00 PM'] };
    brand.showUpdateAlert = true;
    brand.showAlertHistory = [
      { id: 'legacy-brand-carolina-opry-2026-04-28T12:35:54.390Z', message: 'Legacy outgoing alert', active: true },
    ];
  } else if (entry.id === 'brand-att-barefoot-queen-sightseeing-cruise') {
    brand.showScheduleDates = { '2026-06-05': ['1:00 PM', '3:00 PM'] };
    brand.showUpdateAlert = true;
    brand.showAlertHistory = [{ id: 'alert-1778865205414-5898', message: 'Sightseeing alert', active: true }];
  } else if (entry.id === 'brand-att-barefoot-queen-dinner-cruise') {
    brand.showScheduleDates = {
      '2026-06-05': ['5:30 PM'],
      '2026-06-06': ['5:30 PM'],
    };
    brand.showScheduleStatus = {
      '2026-06-06': { '5:30 PM': 'soldout' },
    };
  }
  return brand;
}

function buildFalseBrand(name, index) {
  const overrides = {};
  if (name === 'Myrtle Waves GA') {
    overrides.id = 'brand-myrtle-waves-ga';
    overrides.showInCalendar = true;
    overrides.bookingRequired = false;
  }
  return {
    id: overrides.id || slugifyName(name, index),
    name,
    category: 'Attractions',
    active: true,
    showInCalendar: overrides.showInCalendar !== undefined ? overrides.showInCalendar : false,
    bookingRequired: overrides.bookingRequired !== undefined ? overrides.bookingRequired : false,
    note: `${name} note`,
  };
}

function buildProductionLikeCatalogPayload() {
  const trueBrands = SCHEDULED_TRUE_BRANDS.map((entry, index) => buildTrueBrand(entry, index));
  const falseBrands = SCHEDULED_FALSE_BRANDS.map((name, index) => buildFalseBrand(name, index + trueBrands.length));
  const brands = [...trueBrands, ...falseBrands];
  assert.equal(brands.length, 90, 'Expected 90 brands in migration fixture');
  return sanitizeCatalogPayload({
    meta: {
      version: BASE_VERSION,
      publishedAt: VERSION_STAMP,
      lastPublishedAt: VERSION_STAMP,
      lastPublishedCatalogVersion: BASE_VERSION,
      updatedAt: VERSION_STAMP,
    },
    brands,
    ticketLines: [
      { id: 'line-medieval-adult', brandId: 'brand-medieval-times', ticketLabel: 'Adult', retailPrice: 49.99, cmaPrice: 39.99, active: true },
      { id: 'line-myrtle-adult', brandId: 'brand-myrtle-waves-ga', ticketLabel: 'Adult (48+)', retailPrice: 49.99, cmaPrice: 39.99, active: true },
      { id: 'line-barefoot-dinner', brandId: 'brand-att-barefoot-queen-dinner-cruise', ticketLabel: 'Dinner Cruise', retailPrice: 89.99, cmaPrice: 74.99, active: true },
    ],
    resources: [
      { id: 'resource-calendar-medieval', title: 'Medieval Calendar', kind: 'image', url: 'https://example.com/medieval.png', active: true },
      { id: 'resource-calendar-myrtle', title: 'Myrtle Calendar', kind: 'image', url: 'https://example.com/myrtle.png', active: true },
    ],
  });
}

async function seedPublishedSnapshot(pool, payload, version = BASE_VERSION, options = {}) {
  const stamp = String(options.stamp || VERSION_STAMP);
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
    db.snapshots.draft = {
      updatedAt: stamp,
      updatedByUserId: userId,
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
  });
}

async function setupHarness() {
  const mem = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pgAdapter = mem.adapters.createPg();
  const pool = new pgAdapter.Pool();
  const { app } = await createApp({
    db: pool,
    seedDatabase: false,
    runtimeInfo: { mode: 'test', persistence: 'pg-mem', degraded: false },
  });
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS manager_title TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS manager_only BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS manager_on_duty BOOLEAN NOT NULL DEFAULT FALSE`);
  await upsertUserRow(pool, {
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
    canAccessManager: false,
    managerTitle: '',
    managerOnly: false,
    departmentIds: [],
    status: 'active',
    isLocked: false,
    passwordHash: hashPassword('Admin123A'),
    forcePasswordReset: false,
    createdAt: VERSION_STAMP,
    updatedAt: VERSION_STAMP,
  });
  await upsertUserRow(pool, {
    id: 'user-admin-2',
    displayName: 'Assistant Admin',
    firstName: 'Assistant',
    lastName: 'Admin',
    wwid: 'ADMIN2001',
    email: 'assistant@premiumapp.local',
    phone: '',
    role: 'admin',
    isAssistant: true,
    canAccessMarketer: true,
    canAccessAdmin: true,
    canAccessManager: false,
    managerTitle: '',
    managerOnly: false,
    departmentIds: [],
    status: 'active',
    isLocked: false,
    passwordHash: hashPassword('Assist123A'),
    forcePasswordReset: false,
    createdAt: VERSION_STAMP,
    updatedAt: VERSION_STAMP,
  });
  await upsertUserRow(pool, {
    id: 'user-marketer-1',
    displayName: 'Marketer One',
    firstName: 'Marketer',
    lastName: 'One',
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
    createdAt: VERSION_STAMP,
    updatedAt: VERSION_STAMP,
  });
  const snapshotPayload = {
    meta: { version: 1, source: 'test', publishedAt: VERSION_STAMP, updatedAt: VERSION_STAMP },
    brands: [],
    ticketLines: [],
    resources: [],
    managerCategories: [],
    managerEntries: [],
  };
  await pool.query(
    `INSERT INTO snapshot_published_current (
       id, version, published_at, updated_at, published_by_user_id, payload
     ) VALUES (
       TRUE, $1, $2, $3, $4, $5::jsonb
     )`,
    [1, VERSION_STAMP, VERSION_STAMP, 'user-admin-1', JSON.stringify(snapshotPayload)],
  );
  await pool.query(
    `INSERT INTO snapshot_history (
       version, published_at, updated_at, published_by_user_id, payload
     ) VALUES (
       $1, $2, $3, $4, $5::jsonb
     )`,
    [1, VERSION_STAMP, VERSION_STAMP, 'user-admin-1', JSON.stringify(snapshotPayload)],
  );
  await pool.query(
    `INSERT INTO snapshot_draft (
       id, updated_at, updated_by_user_id, payload
     ) VALUES (
       TRUE, $1, $2, $3::jsonb
     )`,
    [VERSION_STAMP, 'user-admin-1', JSON.stringify(snapshotPayload)],
  );
  const server = await listen(app);
  const address = server.address();
  return {
    app,
    db: pool,
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    adminCookie: '',
    assistantCookie: '',
    marketerCookie: '',
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

async function requestJson(harness, path, { method = 'GET', body, headers = {}, cookie = '' } = {}) {
  const finalHeaders = { ...headers };
  if (body !== undefined) finalHeaders['content-type'] = finalHeaders['content-type'] || 'application/json';
  if (cookie) finalHeaders.cookie = cookie;
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

async function signIn(harness, identifier, password, role, targetKey) {
  const response = await requestJson(harness, '/api/auth/sign-in', {
    method: 'POST',
    body: { identifier, password, role },
  });
  const setCookie = response.headers.get('set-cookie') || '';
  const sessionCookie = setCookie.split(';')[0];
  assert.equal(response.status, 200, `Sign-in failed: ${JSON.stringify(response.body)}`);
  assert.equal(response.body.ok, true);
  if (targetKey) harness[targetKey] = sessionCookie;
  return response;
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
      } else {
        process.env[key] = previous.get(key);
      }
    });
  }
}

async function addSmokePrimaryAdmin(pool, overrides = {}) {
  const password = String(overrides.password || 'Smoke123A');
  const stamp = String(overrides.stamp || VERSION_STAMP);
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

function buildBrandMap(payload) {
  const rows = Array.isArray(payload && payload.brands) ? payload.brands : [];
  return new Map(rows.map((row) => [String((row && row.id) || '').trim(), row]));
}

function withoutScheduled(payload) {
  const source = deepClone(payload);
  source.brands = Array.isArray(source.brands)
    ? source.brands.map((row) => {
        const next = row && typeof row === 'object' ? deepClone(row) : {};
        delete next.scheduled;
        return next;
      })
    : [];
  return source;
}

test('scheduled migration preview returns the verified 90-brand scheduled-only summary', async () => {
  const h = await setupHarness();
  try {
    const payload = buildProductionLikeCatalogPayload();
    await seedPublishedSnapshot(h.db, payload);
    await signIn(h, 'ADMIN1001', 'Admin123A', 'admin', 'adminCookie');
    const preview = await requestJson(h, '/api/cloud', {
      method: 'POST',
      cookie: h.adminCookie,
      body: { action: 'catalog_preview_scheduled_migration' },
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.ok, true);
    assert.equal(preview.body.ready_to_apply, true);
    assert.equal(preview.body.base_snapshot_version, BASE_VERSION);
    assert.equal(preview.body.summary.brandCount, 90);
    assert.equal(preview.body.summary.scheduledMissingBefore, 90);
    assert.equal(preview.body.summary.changedBrands, 90);
    assert.equal(preview.body.summary.scheduledOnly, 90);
    assert.equal(preview.body.summary.nonScheduledCount, 0);
    assert.equal(preview.body.summary.scheduledTrueCount, 21);
    assert.equal(preview.body.summary.scheduledFalseCount, 69);
    assert.equal(preview.body.summary.showInCalendarDiffs, 0);
    assert.equal(preview.body.summary.bookingRequiredDiffs, 0);
    assert.equal(preview.body.summary.categoryDiffs, 0);
    assert.equal(preview.body.summary.ticketLineDiffs, 0);
    assert.equal(preview.body.summary.priceDiffs, 0);
    assert.equal(preview.body.summary.resourceDiffs, 0);
    assert.equal(preview.body.summary.scheduleAlertDiffs, 0);

    const keyBrands = Array.isArray(preview.body.key_brands) ? preview.body.key_brands : [];
    const myrtle = keyBrands.find((entry) => String((entry && entry.name) || '').trim() === 'Myrtle Waves GA');
    const medieval = keyBrands.find((entry) => String((entry && entry.id) || '').trim() === 'brand-medieval-times');
    const dinner = keyBrands.find((entry) => String((entry && entry.id) || '').trim() === 'brand-att-barefoot-queen-dinner-cruise');
    const sightseeing = keyBrands.find((entry) => String((entry && entry.id) || '').trim() === 'brand-att-barefoot-queen-sightseeing-cruise');
    assert.deepEqual(
      {
        myrtle: { scheduled: myrtle && myrtle.scheduled, showInCalendar: myrtle && myrtle.showInCalendar, bookingRequired: myrtle && myrtle.bookingRequired },
        medieval: { scheduled: medieval && medieval.scheduled, showInCalendar: medieval && medieval.showInCalendar },
        dinner: { scheduled: dinner && dinner.scheduled, showInCalendar: dinner && dinner.showInCalendar },
        sightseeing: { scheduled: sightseeing && sightseeing.scheduled, showInCalendar: sightseeing && sightseeing.showInCalendar },
      },
      {
        myrtle: { scheduled: false, showInCalendar: true, bookingRequired: false },
        medieval: { scheduled: true, showInCalendar: true },
        dinner: { scheduled: true, showInCalendar: false },
        sightseeing: { scheduled: true, showInCalendar: false },
      },
    );
  } finally {
    await teardownHarness(h);
  }
});

test('scheduled migration apply publishes explicit scheduled booleans and preserves every protected field', async () => {
  const h = await setupHarness();
  try {
    const payload = buildProductionLikeCatalogPayload();
    await seedPublishedSnapshot(h.db, payload);
    await signIn(h, 'ADMIN1001', 'Admin123A', 'admin', 'adminCookie');

    const preview = await requestJson(h, '/api/cloud', {
      method: 'POST',
      cookie: h.adminCookie,
      body: { action: 'catalog_preview_scheduled_migration' },
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.ready_to_apply, true);

    const apply = await requestJson(h, '/api/cloud', {
      method: 'POST',
      cookie: h.adminCookie,
      body: {
        action: 'catalog_apply_scheduled_migration',
        base_snapshot_version: preview.body.base_snapshot_version,
        request_id: 'scheduled-migration-test-apply',
      },
    });
    assert.equal(apply.status, 200, JSON.stringify(apply.body));
    assert.equal(apply.body.ok, true);
    assert.equal(apply.body.published_snapshot_version_before, BASE_VERSION);
    assert.equal(apply.body.published_snapshot_version_after, BASE_VERSION + 1);
    assert.equal(apply.body.applied_preview.summary.scheduledTrueCount, 21);
    assert.equal(apply.body.applied_preview.summary.scheduledFalseCount, 69);

    const state = await readDb(h.db);
    const published = state && state.snapshots && state.snapshots.published ? state.snapshots.published : null;
    assert.ok(published, 'Expected published snapshot after apply');
    assert.equal(Number(published.version), BASE_VERSION + 1);

    const summary = buildScheduledMigrationSummary(payload, published.payload);
    assert.equal(summary.brandCount, 90);
    assert.equal(summary.scheduledMissingBefore, 90);
    assert.equal(summary.changedBrands, 90);
    assert.equal(summary.scheduledOnly, 90);
    assert.equal(summary.nonScheduledCount, 0);
    assert.equal(summary.scheduledTrueCount, 21);
    assert.equal(summary.scheduledFalseCount, 69);
    assert.equal(summary.showInCalendarDiffs, 0);
    assert.equal(summary.bookingRequiredDiffs, 0);
    assert.equal(summary.categoryDiffs, 0);
    assert.equal(summary.ticketLineDiffs, 0);
    assert.equal(summary.priceDiffs, 0);
    assert.equal(summary.resourceDiffs, 0);
    assert.equal(summary.showScheduleDatesDiffs, 0);
    assert.equal(summary.showScheduleStatusDiffs, 0);
    assert.equal(summary.showAlertHistoryDiffs, 0);
    assert.equal(summary.showUpdateAlertDiffs, 0);
    assert.equal(summary.scheduleAlertDiffs, 0);

    const publishedBrands = Array.isArray(published.payload && published.payload.brands) ? published.payload.brands : [];
    assert.equal(publishedBrands.filter((row) => row && row.scheduled === true).length, 21);
    assert.equal(publishedBrands.filter((row) => row && row.scheduled === false).length, 69);
    assert.equal(publishedBrands.filter((row) => !(row && typeof row.scheduled === 'boolean')).length, 0);

    const beforeSansScheduled = withoutScheduled(payload);
    const afterSansScheduled = withoutScheduled(published.payload);
    assert.deepEqual(afterSansScheduled.brands, beforeSansScheduled.brands);
    assert.deepEqual(afterSansScheduled.ticketLines, beforeSansScheduled.ticketLines);
    assert.deepEqual(afterSansScheduled.resources, beforeSansScheduled.resources);

    const byId = buildBrandMap(published.payload);
    const myrtle = byId.get('brand-myrtle-waves-ga');
    const medieval = byId.get('brand-medieval-times');
    const dinner = byId.get('brand-att-barefoot-queen-dinner-cruise');
    const sightseeing = byId.get('brand-att-barefoot-queen-sightseeing-cruise');
    assert.deepEqual(
      {
        myrtle: { scheduled: myrtle && myrtle.scheduled, showInCalendar: myrtle && myrtle.showInCalendar, bookingRequired: myrtle && myrtle.bookingRequired },
        medieval: { scheduled: medieval && medieval.scheduled, showInCalendar: medieval && medieval.showInCalendar },
        dinner: { scheduled: dinner && dinner.scheduled, showInCalendar: dinner && dinner.showInCalendar },
        sightseeing: { scheduled: sightseeing && sightseeing.scheduled, showInCalendar: sightseeing && sightseeing.showInCalendar },
      },
      {
        myrtle: { scheduled: false, showInCalendar: true, bookingRequired: false },
        medieval: { scheduled: true, showInCalendar: true },
        dinner: { scheduled: true, showInCalendar: false },
        sightseeing: { scheduled: true, showInCalendar: false },
      },
    );
  } finally {
    await teardownHarness(h);
  }
});

test('scheduled migration apply blocks on stale published snapshot version', async () => {
  const h = await setupHarness();
  try {
    const payload = buildProductionLikeCatalogPayload();
    await seedPublishedSnapshot(h.db, payload, BASE_VERSION);
    await signIn(h, 'ADMIN1001', 'Admin123A', 'admin', 'adminCookie');

    const preview = await requestJson(h, '/api/cloud', {
      method: 'POST',
      cookie: h.adminCookie,
      body: { action: 'catalog_preview_scheduled_migration' },
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.ready_to_apply, true);

    await seedPublishedSnapshot(h.db, payload, BASE_VERSION + 1, { stamp: '2026-05-26T18:00:00.000Z' });

    const apply = await requestJson(h, '/api/cloud', {
      method: 'POST',
      cookie: h.adminCookie,
      body: {
        action: 'catalog_apply_scheduled_migration',
        base_snapshot_version: preview.body.base_snapshot_version,
        request_id: 'scheduled-migration-test-stale',
      },
    });
    assert.equal(apply.status, 409, JSON.stringify(apply.body));
    assert.equal(apply.body.ok, false);
    assert.equal(apply.body.code, PUBLISH_BASE_VERSION_STALE_CODE);
    assert.equal(Number(apply.body.current_published_version), BASE_VERSION + 1);
  } finally {
    await teardownHarness(h);
  }
});

test('scheduled migration blocks assistant admin, marketer, and smoke admin before any publish', async () => {
  const h = await setupHarness();
  try {
    const payload = buildProductionLikeCatalogPayload();
    await seedPublishedSnapshot(h.db, payload);
    const assistantSignIn = await signIn(h, 'ADMIN2001', 'Assist123A', 'admin', 'assistantCookie');
    await signIn(h, 'MARK1001', 'Marketer123A', 'marketer', 'marketerCookie');
    const assistantHasPublish = !!(
      assistantSignIn &&
      assistantSignIn.body &&
      assistantSignIn.body.permissions &&
      assistantSignIn.body.permissions.publish_catalog
    );

    const assistantPreview = await requestJson(h, '/api/cloud', {
      method: 'POST',
      cookie: h.assistantCookie,
      body: { action: 'catalog_preview_scheduled_migration' },
    });
    assert.equal(assistantPreview.status, 403, JSON.stringify(assistantPreview.body));
    assert.equal(assistantPreview.body.ok, false);
    assert.equal(assistantPreview.body.code, assistantHasPublish ? 'PRIMARY_ADMIN_REQUIRED' : 'FORBIDDEN');

    const assistantApply = await requestJson(h, '/api/cloud', {
      method: 'POST',
      cookie: h.assistantCookie,
      body: { action: 'catalog_apply_scheduled_migration', base_snapshot_version: BASE_VERSION },
    });
    assert.equal(assistantApply.status, 403, JSON.stringify(assistantApply.body));
    assert.equal(assistantApply.body.ok, false);
    assert.equal(assistantApply.body.code, assistantHasPublish ? 'PRIMARY_ADMIN_REQUIRED' : 'FORBIDDEN');

    const marketerPreview = await requestJson(h, '/api/cloud', {
      method: 'POST',
      cookie: h.marketerCookie,
      body: { action: 'catalog_preview_scheduled_migration' },
    });
    assert.equal(marketerPreview.status, 403, JSON.stringify(marketerPreview.body));
    assert.equal(marketerPreview.body.ok, false);
    assert.equal(marketerPreview.body.code, 'FORBIDDEN');

    const smokeUser = await addSmokePrimaryAdmin(h.db);
    await signIn(h, smokeUser.identifier, smokeUser.password, 'admin', 'smokeCookie');
    await withEnv({ NODE_ENV: 'production' }, async () => {
      const smokePreview = await requestJson(h, '/api/cloud', {
        method: 'POST',
        cookie: h.smokeCookie,
        body: { action: 'catalog_preview_scheduled_migration' },
      });
      assert.equal(smokePreview.status, 403, JSON.stringify(smokePreview.body));
      assert.equal(smokePreview.body.ok, false);
      assert.equal(smokePreview.body.code, SMOKE_PUBLISH_BLOCKED_CODE);
    });
  } finally {
    await teardownHarness(h);
  }
});
