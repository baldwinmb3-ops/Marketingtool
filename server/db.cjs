const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const {
  nowIso,
  normalizeRole,
  normalizeManagerTitle,
  normalizeStatus,
  normalizeWwid,
  normalizeEmail,
  normalizeIdentifier,
  hashPassword,
  randomId,
} = require('./lib.cjs');
const { shouldSeedOnBoot } = require('./db-safety.cjs');

const MIGRATION_SQL_PATH = path.join(__dirname, 'sql', '001_init.sql');
const MIGRATION_SQL = fs.readFileSync(MIGRATION_SQL_PATH, 'utf8');
const DB_QUEUE_BY_POOL = new WeakMap();

function toIso(value, fallback = nowIso()) {
  const date = new Date(value || fallback);
  return Number.isNaN(date.getTime()) ? new Date(fallback).toISOString() : date.toISOString();
}

function toBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  return !!fallback;
}

function asJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function normalizeDepartmentIds(value) {
  const source = Array.isArray(value) ? value : asJson(value, []);
  if (!Array.isArray(source)) return [];
  const seen = new Set();
  const out = [];
  source.forEach((entry) => {
    const id = String(entry || '').trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  });
  return out;
}

function createSeedSnapshot() {
  const t = nowIso();
  return {
    meta: { version: 1, source: 'seed', publishedAt: t, updatedAt: t },
    brands: [
      {
        id: 'brand-medieval-times',
        name: 'Medieval Times',
        category: 'Shows',
        active: true,
        bookingRequired: true,
        createdAt: t,
        updatedAt: t,
      },
      {
        id: 'brand-carolina-opry',
        name: 'Carolina Opry',
        category: 'Shows',
        active: true,
        bookingRequired: true,
        createdAt: t,
        updatedAt: t,
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
        createdAt: t,
        updatedAt: t,
      },
      {
        id: 'line-medieval-child',
        brandId: 'brand-medieval-times',
        ticketLabel: 'Child',
        qualifierText: '3-11',
        infoText: '',
        retailPrice: 49.99,
        cmaPrice: 38.58,
        active: true,
        sortOrder: 2,
        preGift: false,
        bogoEnabled: false,
        bogoLimit: 2,
        childFree: false,
        createdAt: t,
        updatedAt: t,
      },
      {
        id: 'line-opry-premium',
        brandId: 'brand-carolina-opry',
        ticketLabel: 'Premium',
        qualifierText: '',
        infoText: '',
        retailPrice: 69,
        cmaPrice: 55,
        active: true,
        sortOrder: 1,
        preGift: false,
        bogoEnabled: false,
        bogoLimit: 2,
        childFree: false,
        createdAt: t,
        updatedAt: t,
      },
    ],
    resources: [
      {
        id: 'resource-shows-calendar-april',
        title: 'April Show Schedule',
        kind: 'pdf',
        url: 'https://example.local/resources/april-show-schedule.pdf',
        notes: 'Sample seeded schedule resource for testing.',
        active: true,
        createdAt: t,
        updatedAt: t,
      },
    ],
    managerCategories: [
      { id: 'manager-cat-stores', name: 'Stores', system: true, createdAt: t, updatedAt: t },
      { id: 'manager-cat-inhouse', name: 'Inhouse', system: true, createdAt: t, updatedAt: t },
      { id: 'manager-cat-hotels', name: 'Hotels', system: true, createdAt: t, updatedAt: t },
    ],
    managerEntries: [
      {
        id: 'manager-entry-1',
        name: 'Manager One',
        phone: '555-1010',
        email: 'manager.one@example.com',
        wwid: 'MGR1001',
        categoryIds: ['manager-cat-stores'],
        onDuty: false,
        active: true,
        dutyUpdatedAt: t,
        createdAt: t,
        updatedAt: t,
      },
    ],
    phoneDirectoryEntries: [],
  };
}

function createSeedUsers() {
  const t = nowIso();
  return [
    {
      id: 'user-admin-1',
      displayName: 'Primary Admin',
      firstName: 'Primary',
      lastName: 'Admin',
      wwid: 'ADMIN1001',
      email: 'admin@premiumapp.local',
      role: 'admin',
      isAssistant: false,
      canAccessMarketer: true,
      canAccessAdmin: false,
      canAccessManager: true,
      managerTitle: 'Manager',
      managerOnly: false,
      status: 'active',
      isLocked: false,
      forcePasswordReset: false,
      passwordHash: hashPassword('Admin123A'),
      createdAt: t,
      updatedAt: t,
    },
    {
      id: 'user-admin-assistant-1',
      displayName: 'Admin Assistant',
      firstName: 'Admin',
      lastName: 'Assistant',
      wwid: 'ADMIN2001',
      email: 'assistant@premiumapp.local',
      role: 'admin',
      isAssistant: true,
      canAccessMarketer: true,
      canAccessAdmin: false,
      canAccessManager: true,
      managerTitle: 'Manager',
      managerOnly: false,
      status: 'active',
      isLocked: false,
      forcePasswordReset: false,
      passwordHash: hashPassword('Assist123A'),
      createdAt: t,
      updatedAt: t,
    },
    {
      id: 'user-marketer-1',
      displayName: 'Marketer One',
      firstName: 'Marketer',
      lastName: 'One',
      wwid: 'MARK1001',
      email: 'marketer@premiumapp.local',
      role: 'marketer',
      isAssistant: false,
      canAccessMarketer: false,
      canAccessAdmin: false,
      canAccessManager: false,
      managerTitle: '',
      managerOnly: false,
      departmentIds: ['manager-cat-stores'],
      status: 'active',
      isLocked: false,
      forcePasswordReset: false,
      passwordHash: hashPassword('Marketer123A'),
      createdAt: t,
      updatedAt: t,
    },
    {
      id: 'user-marketer-2',
      displayName: 'Marketer Two',
      firstName: 'Marketer',
      lastName: 'Two',
      wwid: 'MARK2002',
      email: 'marketer.two@premiumapp.local',
      role: 'marketer',
      isAssistant: false,
      canAccessMarketer: false,
      canAccessAdmin: false,
      canAccessManager: false,
      managerTitle: '',
      managerOnly: false,
      departmentIds: ['manager-cat-hotels'],
      status: 'active',
      isLocked: false,
      forcePasswordReset: false,
      passwordHash: hashPassword('MarketerTwo123A'),
      createdAt: t,
      updatedAt: t,
    },
    {
      id: 'user-manager-only-1',
      displayName: 'Manager Punch Only',
      firstName: 'Manager',
      lastName: 'Only',
      wwid: 'MGR1001',
      email: 'manager.one@example.com',
      role: 'marketer',
      isAssistant: false,
      canAccessMarketer: false,
      canAccessAdmin: false,
      canAccessManager: true,
      managerTitle: 'Manager',
      managerOnly: true,
      departmentIds: ['manager-cat-stores'],
      status: 'active',
      isLocked: false,
      forcePasswordReset: false,
      passwordHash: hashPassword('Manager123A'),
      createdAt: t,
      updatedAt: t,
    },
    {
      id: 'user-manager-all-1',
      displayName: 'Manager All Access',
      firstName: 'Manager',
      lastName: 'All',
      wwid: 'MGR3001',
      email: 'manager.all@example.com',
      role: 'marketer',
      isAssistant: false,
      canAccessMarketer: false,
      canAccessAdmin: true,
      canAccessManager: true,
      managerTitle: 'Manager',
      managerOnly: false,
      departmentIds: ['manager-cat-hotels'],
      status: 'active',
      isLocked: false,
      forcePasswordReset: false,
      passwordHash: hashPassword('ManagerAll123A'),
      createdAt: t,
      updatedAt: t,
    },
  ];
}

function createSeedBookings(t) {
  return [
    {
      id: 'seed-booking-pending-1',
      brandId: 'brand-medieval-times',
      brandName: 'Medieval Times',
      guestFirstName: 'Alex',
      guestLastName: 'Visitor',
      showDate: '2026-04-04',
      showTime: '19:00',
      primaryShowDate: '2026-04-04',
      primaryShowTime: '19:00',
      backupShowDate: '',
      backupShowTime: '',
      tourNumber: 'T-100',
      status: 'pending',
      snapshotVersion: 1,
      quoteLines: [{ ticketLineId: 'line-medieval-adult', qty: 2, freeQty: 0, extraEach: 0, isAddon: false }],
      clientTotals: { retailTotal: 179.98, costTotal: 149.0, profit: 30.98 },
      authoritativeTotals: { retailTotal: 179.98, costTotal: 149.0, complimentaryValue: 0, profit: 30.98, computedAt: t },
      commissionProfit: 30.98,
      createdByDevice: 'seed-device',
      createdByRole: 'marketer',
      adminName: '',
      adminUserId: '',
      adminDevice: '',
      workingByName: '',
      workingByUserId: '',
      workingByDevice: '',
      workingAt: '',
      completedByName: '',
      completedByUserId: '',
      completedByDevice: '',
      completedAt: '',
      statusAt: t,
      createdAt: t,
      updatedAt: t,
      revision: 1,
    },
    {
      id: 'seed-booking-working-1',
      brandId: 'brand-carolina-opry',
      brandName: 'Carolina Opry',
      guestFirstName: 'Jamie',
      guestLastName: 'Traveler',
      showDate: '2026-04-05',
      showTime: '20:00',
      primaryShowDate: '2026-04-05',
      primaryShowTime: '20:00',
      backupShowDate: '',
      backupShowTime: '',
      tourNumber: 'T-101',
      status: 'working',
      snapshotVersion: 1,
      quoteLines: [{ ticketLineId: 'line-opry-premium', qty: 1, freeQty: 0, extraEach: 0, isAddon: false }],
      clientTotals: { retailTotal: 69.0, costTotal: 55.0, profit: 14.0 },
      authoritativeTotals: { retailTotal: 69.0, costTotal: 55.0, complimentaryValue: 0, profit: 14.0, computedAt: t },
      commissionProfit: 14.0,
      createdByDevice: 'seed-device',
      createdByRole: 'marketer',
      adminName: 'Admin Assistant',
      adminUserId: 'user-admin-assistant-1',
      adminDevice: 'seed-admin-ipad',
      workingByName: 'Admin Assistant',
      workingByUserId: 'user-admin-assistant-1',
      workingByDevice: 'seed-admin-ipad',
      workingAt: t,
      completedByName: '',
      completedByUserId: '',
      completedByDevice: '',
      completedAt: '',
      statusAt: t,
      createdAt: t,
      updatedAt: t,
      revision: 2,
    },
  ];
}

function createSeedBookingEvents(t) {
  return [
    {
      id: 'booking-event-seed-1',
      bookingId: 'seed-booking-working-1',
      eventType: 'booking.claim',
      actorUserId: 'user-admin-assistant-1',
      actorName: 'Admin Assistant',
      details: { source: 'seed' },
      at: t,
    },
  ];
}

function createSeedDb() {
  const t = nowIso();
  const snapshot = createSeedSnapshot();
  const bookings = createSeedBookings(t);
  return {
    meta: { createdAt: t, updatedAt: t, schemaVersion: 2 },
    users: createSeedUsers(),
    snapshots: {
      published: {
        version: 1,
        publishedAt: t,
        updatedAt: t,
        publishedByUserId: 'user-admin-1',
        payload: snapshot,
      },
      history: [
        {
          version: 1,
          publishedAt: t,
          updatedAt: t,
          publishedByUserId: 'user-admin-1',
          payload: snapshot,
        },
      ],
      draft: { updatedAt: t, updatedByUserId: 'user-admin-1', payload: snapshot },
    },
    bookings,
    bookingEvents: createSeedBookingEvents(t),
    audit: [
      {
        id: 'audit-seed-1',
        at: t,
        action: 'seed.initialized',
        actorUserId: 'system',
        actorName: 'Seed Loader',
        targetType: 'database',
        targetId: 'bootstrap',
        details: { bookings: bookings.length },
      },
    ],
  };
}

function envBool(name, fallback = false) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return !!fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(raw)) return false;
  return !!fallback;
}

function createPoolFromEnv(overrides = {}) {
  const host = process.env.PGHOST || '127.0.0.1';
  const port = Number.parseInt(String(process.env.PGPORT || '5432'), 10) || 5432;
  const user = process.env.PGUSER || 'postgres';
  const password = process.env.PGPASSWORD || 'postgres';
  const database = process.env.PGDATABASE || 'marketingtool';
  const connectionString =
    overrides.connectionString ||
    process.env.DATABASE_URL ||
    `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
  const useSsl = envBool('APP_DB_SSL', false) || envBool('DATABASE_SSL', false);
  return new Pool({
    connectionString,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
    max: Number.parseInt(String(process.env.APP_DB_POOL_MAX || '10'), 10) || 10,
  });
}

async function migrateDatabase(pool) {
  await pool.query(MIGRATION_SQL);
}

function mapUserToState(row) {
  return {
    id: String(row.id || ''),
    displayName: String(row.display_name || '').trim(),
    firstName: String(row.first_name || '').trim(),
    lastName: String(row.last_name || '').trim(),
    wwid: String(row.wwid || ''),
    email: String(row.email || '').trim().toLowerCase(),
    phone: String(row.phone || '').trim(),
    role: String(row.role || 'marketer'),
    isAssistant: toBool(row.is_assistant, false),
    canAccessMarketer: toBool(row.can_access_marketer, false),
    canAccessAdmin: toBool(row.can_access_admin, false),
    canAccessManager: toBool(row.can_access_manager, false),
    managerTitle: normalizeManagerTitle(row.manager_title, ''),
    managerOnly: toBool(row.manager_only, false),
    departmentIds: normalizeDepartmentIds(row.department_ids),
    status: String(row.status || 'active'),
    isLocked: toBool(row.is_locked, false),
    forcePasswordReset: toBool(row.force_password_reset, false),
    passwordHash: String(row.password_hash || ''),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function buildRoleCondition(role) {
  if (!role) return '';
  if (role === 'admin') {
    return "AND (role = 'admin' OR can_access_admin = TRUE)";
  }
  if (role === 'marketer') {
    return "AND (role = 'marketer' OR role = 'admin' OR can_access_marketer = TRUE)";
  }
  if (role === 'manager') {
    return 'AND can_access_manager = TRUE';
  }
  return '';
}

async function selectUserRowByIdentifier(client, identifier, requestedRole) {
  const key = normalizeIdentifier(identifier);
  if (!key) return null;
  const normalizedWwid = normalizeWwid(key);
  const normalizedEmail = normalizeEmail(key);
  if (!normalizedWwid && !normalizedEmail) return null;
  const roleClause = buildRoleCondition(normalizeRole(requestedRole));
  const sql = `
    SELECT *
    FROM users
    WHERE status = $1
      AND (
        ($2 <> '' AND wwid = $2)
        OR ($3 <> '' AND email = $3)
      )
      ${roleClause}
    ORDER BY created_at ASC
    LIMIT 1
  `;
  const params = ['active', normalizedWwid || '', normalizedEmail || ''];
  const result = await client.query(sql, params);
  return result.rows[0] || null;
}

async function findUserRowByIdentifier(pool, identifier, requestedRole = null) {
  if (!pool) return null;
  const client = await pool.connect();
  try {
    return await selectUserRowByIdentifier(client, identifier, requestedRole);
  } finally {
    client.release();
  }
}

async function selectUsers(client) {
  const result = await client.query("SELECT * FROM users WHERE COALESCE(status, 'active') <> 'deleted' ORDER BY created_at ASC");
  return result.rows.map(mapUserToState);
}

async function listUsers(pool) {
  const client = await pool.connect();
  try {
    return await selectUsers(client);
  } finally {
    client.release();
  }
}

async function listOnDutyManagerUsers(pool) {
  const result = await pool.query(
    `SELECT DISTINCT u.*
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.revoked_at IS NULL
       AND s.expires_at > NOW()
       AND COALESCE(s.manager_on_duty, FALSE) = TRUE
       AND COALESCE(u.status, 'active') = 'active'
     ORDER BY u.display_name ASC, u.created_at ASC`,
  );
  return result.rows.map(mapUserToState);
}

async function updateUserPassword(pool, userId, passwordHash, forcePasswordReset = false, updatedAt = nowIso(), clearLock = false) {
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE users
       SET password_hash = $1,
           force_password_reset = $2,
           updated_at = $3,
           is_locked = CASE WHEN $5 THEN FALSE ELSE is_locked END
       WHERE id = $4`,
      [String(passwordHash || ''), toBool(forcePasswordReset, false), toIso(updatedAt), String(userId || ''), toBool(clearLock, false)],
    );
  } finally {
    client.release();
  }
}

async function readDbInternal(client) {
  const [usersRes, publishedRes, historyRes, draftRes, bookingsRes, eventsRes, auditRes] = await Promise.all([
    client.query('SELECT * FROM users ORDER BY created_at ASC'),
    client.query('SELECT * FROM snapshot_published_current WHERE id = TRUE LIMIT 1'),
    client.query('SELECT * FROM snapshot_history ORDER BY version ASC'),
    client.query('SELECT * FROM snapshot_draft WHERE id = TRUE LIMIT 1'),
    client.query('SELECT row_data FROM bookings ORDER BY created_at ASC'),
    client.query('SELECT * FROM booking_events ORDER BY created_at ASC'),
    client.query('SELECT * FROM audit_log ORDER BY at ASC'),
  ]);

  const users = usersRes.rows.map(mapUserToState);
  const publishedRow = publishedRes.rows[0] || null;
  const draftRow = draftRes.rows[0] || null;
  const history = historyRes.rows.map((row) => ({
    version: Number.parseInt(String(row.version || '1'), 10) || 1,
    publishedAt: toIso(row.published_at),
    updatedAt: toIso(row.updated_at),
    publishedByUserId: String(row.published_by_user_id || ''),
    payload: asJson(row.payload, {}),
  }));
  const bookings = bookingsRes.rows.map((row) => asJson(row.row_data, null)).filter(Boolean);
  const bookingEvents = eventsRes.rows.map((row) => ({
    id: String(row.id || ''),
    bookingId: String(row.booking_id || ''),
    eventType: String(row.event_type || ''),
    actorUserId: String(row.actor_user_id || '').trim(),
    actorName: String(row.actor_name || '').trim(),
    details: asJson(row.details, {}),
    at: toIso(row.created_at),
  }));
  const audit = auditRes.rows.map((row) => ({
    id: String(row.id || ''),
    at: toIso(row.at),
    action: String(row.action || ''),
    actorUserId: String(row.actor_user_id || ''),
    actorName: String(row.actor_name || ''),
    targetType: String(row.target_type || ''),
    targetId: String(row.target_id || ''),
    details: asJson(row.details, {}),
  }));

  return {
    meta: {
      createdAt: users[0] ? users[0].createdAt : nowIso(),
      updatedAt: nowIso(),
      schemaVersion: 2,
    },
    users,
    snapshots: {
      published: publishedRow
        ? {
            version: Number.parseInt(String(publishedRow.version || '1'), 10) || 1,
            publishedAt: toIso(publishedRow.published_at),
            updatedAt: toIso(publishedRow.updated_at),
            publishedByUserId: String(publishedRow.published_by_user_id || ''),
            payload: asJson(publishedRow.payload, {}),
          }
        : null,
      history,
      draft: draftRow
        ? {
            updatedAt: toIso(draftRow.updated_at),
            updatedByUserId: String(draftRow.updated_by_user_id || ''),
            payload: asJson(draftRow.payload, {}),
          }
        : null,
    },
    bookings,
    bookingEvents,
    audit,
  };
}

async function upsertUserRow(client, user) {
  const row = user && typeof user === 'object' ? user : {};
  await client.query(
    `INSERT INTO users (
      id, display_name, first_name, last_name, wwid, email, phone, role,
      is_assistant, can_access_marketer, can_access_admin, can_access_manager, manager_title, manager_only,
      department_ids, status, is_locked, password_hash, force_password_reset, created_at, updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,
      $9,$10,$11,$12,$13,$14,
      $15,$16,$17,$18,$19,$20,$21
    )
    ON CONFLICT (id) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name,
      wwid = EXCLUDED.wwid,
      email = EXCLUDED.email,
      phone = EXCLUDED.phone,
      role = EXCLUDED.role,
      is_assistant = EXCLUDED.is_assistant,
      can_access_marketer = EXCLUDED.can_access_marketer,
      can_access_admin = EXCLUDED.can_access_admin,
      can_access_manager = EXCLUDED.can_access_manager,
      manager_title = EXCLUDED.manager_title,
      manager_only = EXCLUDED.manager_only,
      department_ids = EXCLUDED.department_ids,
      status = EXCLUDED.status,
      is_locked = EXCLUDED.is_locked,
      password_hash = EXCLUDED.password_hash,
      force_password_reset = EXCLUDED.force_password_reset,
      updated_at = EXCLUDED.updated_at`,
    [
      String(row.id || ''),
      String(row.displayName || '').trim() || 'User',
      String(row.firstName || '').trim(),
      String(row.lastName || '').trim(),
      normalizeWwid(row.wwid),
      normalizeEmail(row.email),
      String(row.phone || '').trim(),
      normalizeRole(row.role) || 'marketer',
      !!row.isAssistant,
      !!row.canAccessMarketer,
      !!row.canAccessAdmin,
      !!row.canAccessManager,
      normalizeManagerTitle(row.managerTitle, ''),
      !!row.managerOnly,
      JSON.stringify(normalizeDepartmentIds(row.departmentIds)),
      normalizeStatus(row.status),
      !!row.isLocked,
      String(row.passwordHash || ''),
      !!row.forcePasswordReset,
      toIso(row.createdAt),
      toIso(row.updatedAt),
    ],
  );
}

async function persistDbInternal(client, db) {
  const state = db && typeof db === 'object' ? db : createSeedDb();
  const users = Array.isArray(state.users) ? state.users : [];
  const snapshots = state.snapshots && typeof state.snapshots === 'object' ? state.snapshots : {};
  const published = snapshots.published && typeof snapshots.published === 'object' ? snapshots.published : null;
  const history = Array.isArray(snapshots.history) ? snapshots.history : [];
  const draft = snapshots.draft && typeof snapshots.draft === 'object' ? snapshots.draft : null;
  const bookings = Array.isArray(state.bookings) ? state.bookings : [];
  const bookingIdSet = new Set(
    bookings
      .map((row) => String(row && row.id ? row.id : '').trim())
      .filter(Boolean),
  );
  const bookingEvents = Array.isArray(state.bookingEvents)
    ? state.bookingEvents.filter((entry) => bookingIdSet.has(String(entry && entry.bookingId ? entry.bookingId : '').trim()))
    : [];
  const audit = Array.isArray(state.audit) ? state.audit : [];

  for (const user of users) {
    await upsertUserRow(client, user);
  }

  if (published) {
    await client.query(
      `INSERT INTO snapshot_published_current (
        id, version, published_at, updated_at, published_by_user_id, payload
      ) VALUES (
        TRUE, $1, $2, $3, $4, $5::jsonb
      )
      ON CONFLICT (id) DO UPDATE SET
        version = EXCLUDED.version,
        published_at = EXCLUDED.published_at,
        updated_at = EXCLUDED.updated_at,
        published_by_user_id = EXCLUDED.published_by_user_id,
        payload = EXCLUDED.payload`,
      [
        Math.max(1, Number.parseInt(String(published.version || '1'), 10) || 1),
        toIso(published.publishedAt),
        toIso(published.updatedAt),
        String(published.publishedByUserId || ''),
        JSON.stringify(published.payload && typeof published.payload === 'object' ? published.payload : {}),
      ],
    );
  }

  await client.query('DELETE FROM snapshot_history');
  for (const entry of history) {
    const row = entry && typeof entry === 'object' ? entry : {};
    await client.query(
      `INSERT INTO snapshot_history (
        version, published_at, updated_at, published_by_user_id, payload
      ) VALUES ($1,$2,$3,$4,$5::jsonb)
      ON CONFLICT (version) DO UPDATE SET
        published_at = EXCLUDED.published_at,
        updated_at = EXCLUDED.updated_at,
        published_by_user_id = EXCLUDED.published_by_user_id,
        payload = EXCLUDED.payload`,
      [
        Math.max(1, Number.parseInt(String(row.version || '1'), 10) || 1),
        toIso(row.publishedAt),
        toIso(row.updatedAt),
        String(row.publishedByUserId || ''),
        JSON.stringify(row.payload && typeof row.payload === 'object' ? row.payload : {}),
      ],
    );
  }

  if (draft) {
    await client.query(
      `INSERT INTO snapshot_draft (
        id, updated_at, updated_by_user_id, payload
      ) VALUES (TRUE, $1, $2, $3::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        updated_at = EXCLUDED.updated_at,
        updated_by_user_id = EXCLUDED.updated_by_user_id,
        payload = EXCLUDED.payload`,
      [
        toIso(draft.updatedAt),
        String(draft.updatedByUserId || ''),
        JSON.stringify(draft.payload && typeof draft.payload === 'object' ? draft.payload : {}),
      ],
    );
  }

  const bookingIds = bookings
    .map((row) => String(row && row.id ? row.id : '').trim())
    .filter(Boolean);
  if (bookingIds.length) {
    await client.query('DELETE FROM bookings WHERE NOT (id = ANY($1::text[]))', [bookingIds]);
  } else {
    await client.query('DELETE FROM bookings');
  }
  for (const entry of bookings) {
    const row = entry && typeof entry === 'object' ? entry : {};
    const id = String(row.id || '').trim();
    if (!id) continue;
    await client.query(
      `INSERT INTO bookings (
        id, status, snapshot_version, revision, working_by_user_id, completed_by_user_id, created_at, updated_at, row_data
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb
      )
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        snapshot_version = EXCLUDED.snapshot_version,
        revision = EXCLUDED.revision,
        working_by_user_id = EXCLUDED.working_by_user_id,
        completed_by_user_id = EXCLUDED.completed_by_user_id,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at,
        row_data = EXCLUDED.row_data`,
      [
        id,
        String(row.status || 'pending').trim().toLowerCase() || 'pending',
        Math.max(1, Number.parseInt(String(row.snapshotVersion || '1'), 10) || 1),
        Math.max(1, Number.parseInt(String(row.revision || '1'), 10) || 1),
        String(row.workingByUserId || '').trim() || null,
        String(row.completedByUserId || '').trim() || null,
        toIso(row.createdAt),
        toIso(row.updatedAt),
        JSON.stringify(row),
      ],
    );
  }

  const eventIds = bookingEvents
    .map((entry) => String(entry && entry.id ? entry.id : '').trim())
    .filter(Boolean);
  if (eventIds.length) {
    await client.query('DELETE FROM booking_events WHERE NOT (id = ANY($1::text[]))', [eventIds]);
  } else {
    await client.query('DELETE FROM booking_events');
  }
  for (const entry of bookingEvents) {
    const row = entry && typeof entry === 'object' ? entry : {};
    const eventId = String(row.id || '').trim();
    if (!eventId) continue;
    await client.query(
      `INSERT INTO booking_events (
        id, booking_id, event_type, actor_user_id, actor_name, details, created_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6::jsonb,$7
      )
      ON CONFLICT (id) DO UPDATE SET
        booking_id = EXCLUDED.booking_id,
        event_type = EXCLUDED.event_type,
        actor_user_id = EXCLUDED.actor_user_id,
        actor_name = EXCLUDED.actor_name,
        details = EXCLUDED.details,
        created_at = EXCLUDED.created_at`,
      [
        eventId,
        String(row.bookingId || '').trim(),
        String(row.eventType || '').trim().slice(0, 80) || 'booking.event',
        String(row.actorUserId || '').trim() || null,
        String(row.actorName || '').trim(),
        JSON.stringify(row.details && typeof row.details === 'object' ? row.details : {}),
        toIso(row.at),
      ],
    );
  }

  const auditIds = audit
    .map((entry) => String(entry && entry.id ? entry.id : '').trim())
    .filter(Boolean);
  if (auditIds.length) {
    await client.query('DELETE FROM audit_log WHERE NOT (id = ANY($1::text[]))', [auditIds]);
  } else {
    await client.query('DELETE FROM audit_log');
  }
  for (const entry of audit) {
    const row = entry && typeof entry === 'object' ? entry : {};
    const auditId = String(row.id || '').trim();
    if (!auditId) continue;
    await client.query(
      `INSERT INTO audit_log (
        id, at, action, actor_user_id, actor_name, target_type, target_id, details
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8::jsonb
      )
      ON CONFLICT (id) DO UPDATE SET
        at = EXCLUDED.at,
        action = EXCLUDED.action,
        actor_user_id = EXCLUDED.actor_user_id,
        actor_name = EXCLUDED.actor_name,
        target_type = EXCLUDED.target_type,
        target_id = EXCLUDED.target_id,
        details = EXCLUDED.details`,
      [
        auditId,
        toIso(row.at),
        String(row.action || 'unknown').trim().slice(0, 80),
        String(row.actorUserId || '').trim(),
        String(row.actorName || '').trim(),
        String(row.targetType || '').trim().slice(0, 60),
        String(row.targetId || '').trim().slice(0, 120),
        JSON.stringify(row.details && typeof row.details === 'object' ? row.details : {}),
      ],
    );
  }
}

async function seedDatabase(pool, options = {}) {
  const force = !!(options && options.force);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (force) {
      await client.query('DELETE FROM sessions');
      await client.query('DELETE FROM booking_events');
      await client.query('DELETE FROM bookings');
      await client.query('DELETE FROM audit_log');
      await client.query('DELETE FROM snapshot_history');
      await client.query('DELETE FROM snapshot_draft');
      await client.query('DELETE FROM snapshot_published_current');
      await client.query('DELETE FROM users');
    }

    const usersCount = await client.query('SELECT COUNT(*)::int AS count FROM users');
    const publishedCount = await client.query('SELECT COUNT(*)::int AS count FROM snapshot_published_current');
    const shouldSeed =
      force ||
      Number.parseInt(String(usersCount.rows[0] && usersCount.rows[0].count), 10) === 0 ||
      Number.parseInt(String(publishedCount.rows[0] && publishedCount.rows[0].count), 10) === 0;

    if (!shouldSeed) {
      await client.query('COMMIT');
      return false;
    }

    const seed = createSeedDb();
    await persistDbInternal(client, seed);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function initDatabase(pool, options = {}) {
  await migrateDatabase(pool);
  if (!shouldSeedOnBoot(options.seed)) return;
  await seedDatabase(pool, { force: false });
}

async function readDb(pool) {
  const client = await pool.connect();
  try {
    return await readDbInternal(client);
  } finally {
    client.release();
  }
}

async function withDb(pool, task) {
  const prior = DB_QUEUE_BY_POOL.get(pool) || Promise.resolve();
  const run = prior.then(async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      try {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('marketingtool_state_lock'))");
      } catch (_lockError) {
        // pg-mem and some managed environments may not expose advisory lock helpers.
        // We still serialize writes in-process via DB_QUEUE_BY_POOL.
      }
      const db = await readDbInternal(client);
      const result = await task(db);
      await persistDbInternal(client, db);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });
  DB_QUEUE_BY_POOL.set(pool, run.catch(() => {}));
  return run;
}

async function withLockedWriteTransaction(pool, task) {
  const prior = DB_QUEUE_BY_POOL.get(pool) || Promise.resolve();
  const run = prior.then(async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      try {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('marketingtool_state_lock'))");
      } catch (_lockError) {
        // pg-mem and some managed environments may not expose advisory lock helpers.
        // We still serialize writes in-process via DB_QUEUE_BY_POOL.
      }
      const result = await task(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });
  DB_QUEUE_BY_POOL.set(pool, run.catch(() => {}));
  return run;
}

function findUserByIdentifier(db, identifier, requestedRole = null) {
  const key = normalizeIdentifier(identifier);
  if (!key) return null;
  const wwid = normalizeWwid(key);
  const email = normalizeEmail(key);
  const role = normalizeRole(requestedRole);
  const users = Array.isArray(db.users) ? db.users : [];

  const matches = users.filter((entry) => {
    const row = entry && typeof entry === 'object' ? entry : {};
    if (normalizeStatus(row.status) !== 'active') return false;
    const sameIdentity = (wwid && normalizeWwid(row.wwid) === wwid) || (email && normalizeEmail(row.email) === email);
    if (!sameIdentity) return false;
    if (!role) return true;
    if (role === 'admin') return normalizeRole(row.role) === 'admin' || !!row.canAccessAdmin;
    if (role === 'marketer')
      return normalizeRole(row.role) === 'marketer' || normalizeRole(row.role) === 'admin' || !!row.canAccessMarketer;
    if (role === 'manager') return !!row.canAccessManager;
    return false;
  });

  return matches[0] || null;
}

function logAudit(db, entry) {
  if (!Array.isArray(db.audit)) db.audit = [];
  const row = entry && typeof entry === 'object' ? entry : {};
  db.audit.push({
    id: randomId('audit'),
    at: nowIso(),
    action: String(row.action || 'unknown').trim().slice(0, 80),
    actorUserId: String(row.actorUserId || '').trim(),
    actorName: String(row.actorName || '').trim(),
    targetType: String(row.targetType || '').trim().slice(0, 60),
    targetId: String(row.targetId || '').trim().slice(0, 120),
    details: row.details && typeof row.details === 'object' ? row.details : {},
  });
  if (db.audit.length > 1000) db.audit = db.audit.slice(-1000);
}

function logBookingEvent(db, entry) {
  if (!Array.isArray(db.bookingEvents)) db.bookingEvents = [];
  const row = entry && typeof entry === 'object' ? entry : {};
  db.bookingEvents.push({
    id: randomId('booking-event'),
    bookingId: String(row.bookingId || '').trim(),
    eventType: String(row.eventType || 'booking.event').trim().slice(0, 80),
    actorUserId: String(row.actorUserId || '').trim(),
    actorName: String(row.actorName || '').trim(),
    details: row.details && typeof row.details === 'object' ? row.details : {},
    at: nowIso(),
  });
  if (db.bookingEvents.length > 5000) db.bookingEvents = db.bookingEvents.slice(-5000);
}

async function createSessionRecord(pool, options = {}) {
  const userId = String(options.userId || '').trim();
  if (!userId) throw new Error('userId is required');
  const activeRole = normalizeRole(options.activeRole) || 'marketer';
  const managerOnDuty = Object.prototype.hasOwnProperty.call(options, 'managerOnDuty')
    ? !!options.managerOnDuty
    : activeRole === 'manager';
  const ttlMs = Math.max(60_000, Number.parseInt(String(options.ttlMs || 0), 10) || 1000 * 60 * 60 * 12);
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const id = randomId('sess');

  await pool.query(
    `INSERT INTO sessions (
      id, user_id, active_role, manager_on_duty, created_at, expires_at, last_seen_at, revoked_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,NULL)`,
    [id, userId, activeRole, managerOnDuty, createdAt, expiresAt, createdAt],
  );
  return { id, userId, activeRole, managerOnDuty, createdAt, expiresAt };
}

async function getSessionRecord(pool, sessionId, options = {}) {
  const id = String(sessionId || '').trim();
  if (!id) return null;
  const ttlMs = Math.max(60_000, Number.parseInt(String(options.ttlMs || 0), 10) || 1000 * 60 * 60 * 12);
  const rows = await pool.query(
    `SELECT
      s.id AS session_id,
      s.user_id AS session_user_id,
      s.active_role AS session_active_role,
      s.manager_on_duty AS session_manager_on_duty,
      s.created_at AS session_created_at,
      s.expires_at AS session_expires_at,
      u.*
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = $1
      AND s.revoked_at IS NULL
      AND s.expires_at > NOW()
      AND u.status = 'active'
    LIMIT 1`,
    [id],
  );
  const row = rows.rows[0];
  if (!row) return null;

  const nextExpiresAt = new Date(Date.now() + ttlMs).toISOString();
  const lastSeenAt = nowIso();
  await pool.query('UPDATE sessions SET expires_at = $2, last_seen_at = $3 WHERE id = $1', [id, nextExpiresAt, lastSeenAt]);

  return {
    id: String(row.session_id || ''),
    userId: String(row.session_user_id || ''),
    activeRole: normalizeRole(row.session_active_role) || 'marketer',
    managerOnDuty: toBool(row.session_manager_on_duty, false),
    createdAt: toIso(row.session_created_at),
    expiresAt: toIso(nextExpiresAt),
    user: mapUserToState(row),
  };
}

async function updateSessionRecordRole(pool, sessionId, activeRole) {
  const id = String(sessionId || '').trim();
  const nextRole = normalizeRole(activeRole) || null;
  if (!id || !nextRole) return null;
  const updatedAt = nowIso();
  const managerOnDuty = nextRole === 'manager';
  const result = await pool.query(
    `UPDATE sessions
     SET active_role = $2,
         manager_on_duty = $3,
         last_seen_at = $4
     WHERE id = $1
       AND revoked_at IS NULL
     RETURNING id, user_id, active_role, manager_on_duty, created_at, expires_at`,
    [id, nextRole, managerOnDuty, updatedAt],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: String(row.id || ''),
    userId: String(row.user_id || ''),
    activeRole: normalizeRole(row.active_role) || 'marketer',
    managerOnDuty: toBool(row.manager_on_duty, false),
    createdAt: toIso(row.created_at),
    expiresAt: toIso(row.expires_at),
  };
}

async function updateSessionDutyStatus(pool, sessionId, managerOnDuty) {
  const id = String(sessionId || '').trim();
  if (!id) return null;
  const nextDuty = !!managerOnDuty;
  const updatedAt = nowIso();
  const result = await pool.query(
    `UPDATE sessions
     SET manager_on_duty = $2,
         last_seen_at = $3
     WHERE id = $1
       AND revoked_at IS NULL
       AND expires_at > NOW()
     RETURNING id, user_id, active_role, manager_on_duty, created_at, expires_at`,
    [id, nextDuty, updatedAt],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: String(row.id || ''),
    userId: String(row.user_id || ''),
    activeRole: normalizeRole(row.active_role) || 'marketer',
    managerOnDuty: toBool(row.manager_on_duty, false),
    createdAt: toIso(row.created_at),
    expiresAt: toIso(row.expires_at),
  };
}

async function revokeSessionRecord(pool, sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return;
  await pool.query('UPDATE sessions SET revoked_at = NOW() WHERE id = $1', [id]);
}

async function closePool(pool) {
  if (pool && typeof pool.end === 'function') {
    await pool.end();
  }
}

module.exports = {
  createSeedDb,
  createPoolFromEnv,
  migrateDatabase,
  seedDatabase,
  initDatabase,
  readDb,
  withDb,
  withLockedWriteTransaction,
  findUserByIdentifier,
  findUserRowByIdentifier,
  listUsers,
  listOnDutyManagerUsers,
  mapUserToState,
  logAudit,
  logBookingEvent,
  createSessionRecord,
  getSessionRecord,
  updateSessionRecordRole,
  updateSessionDutyStatus,
  revokeSessionRecord,
  updateUserPassword,
  upsertUserRow,
  closePool,
};
