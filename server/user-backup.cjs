const fs = require('fs');

const { nowIso, normalizeEmail, normalizeRole, normalizeStatus, normalizeWwid } = require('./lib.cjs');

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

function mapUserRowToBackup(row) {
  const src = row && typeof row === 'object' ? row : {};
  return {
    id: String(src.id || '').trim(),
    displayName: String(src.display_name || src.displayName || src.name || '').trim() || 'User',
    firstName: String(src.first_name || src.firstName || '').trim(),
    lastName: String(src.last_name || src.lastName || '').trim(),
    wwid: normalizeWwid(src.wwid),
    email: normalizeEmail(src.email || src.workEmail || src.emailOrLogin),
    role: normalizeRole(src.role) || 'marketer',
    isAssistant: toBool(src.is_assistant ?? src.isAssistant, false),
    canAccessMarketer: toBool(src.can_access_marketer ?? src.canAccessMarketer, false),
    canAccessAdmin: toBool(src.can_access_admin ?? src.canAccessAdmin, false),
    canAccessManager: toBool(src.can_access_manager ?? src.canAccessManager, false),
    managerOnly: toBool(src.manager_only ?? src.managerOnly, false),
    departmentIds: normalizeDepartmentIds(src.department_ids ?? src.departmentIds),
    status: normalizeStatus(src.status),
    isLocked: toBool(src.is_locked ?? src.isLocked, false),
    passwordHash: String(src.password_hash || src.passwordHash || ''),
    forcePasswordReset: toBool(src.force_password_reset ?? src.forcePasswordReset, false),
    createdAt: toIso(src.created_at ?? src.createdAt),
    updatedAt: toIso(src.updated_at ?? src.updatedAt),
  };
}

function summarizeUsers(users) {
  const list = Array.isArray(users) ? users : [];
  const summary = {
    total: list.length,
    active: 0,
    inactive: 0,
    deleted: 0,
    admins: 0,
    marketers: 0,
    assistantAdmins: 0,
    managerEnabled: 0,
    managerOnly: 0,
  };
  list.forEach((entry) => {
    const row = mapUserRowToBackup(entry);
    if (row.status === 'deleted') summary.deleted += 1;
    else if (row.status === 'inactive') summary.inactive += 1;
    else summary.active += 1;
    if (row.role === 'admin') {
      summary.admins += 1;
      if (row.isAssistant) summary.assistantAdmins += 1;
    } else {
      summary.marketers += 1;
    }
    if (row.canAccessManager) summary.managerEnabled += 1;
    if (row.managerOnly) summary.managerOnly += 1;
  });
  return summary;
}

function pickBackupSamples(users, sampleSize = 6) {
  const list = Array.isArray(users) ? users.map(mapUserRowToBackup) : [];
  const active = list.filter((entry) => entry.status === 'active');
  const admins = active.filter((entry) => entry.role === 'admin').slice(0, Math.ceil(sampleSize / 2));
  const marketers = active.filter((entry) => entry.role === 'marketer').slice(0, Math.ceil(sampleSize / 2));
  const picked = [];
  const seen = new Set();
  [...admins, ...marketers, ...active].forEach((entry) => {
    if (picked.length >= sampleSize) return;
    const key = `${entry.id}|${entry.wwid}|${entry.email}`;
    if (seen.has(key)) return;
    seen.add(key);
    picked.push({
      id: entry.id,
      wwid: entry.wwid,
      email: entry.email,
      role: entry.role,
      status: entry.status,
      displayName: entry.displayName,
    });
  });
  return picked;
}

async function listRawUsers(pool) {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT * FROM users ORDER BY created_at ASC');
    return result.rows.map(mapUserRowToBackup);
  } finally {
    client.release();
  }
}

async function buildUsersBackupSnapshot(pool, options = {}) {
  const users = await listRawUsers(pool);
  const sampleSize = Math.max(1, Math.min(20, Number.parseInt(String(options.sampleSize || '6'), 10) || 6));
  return {
    schemaVersion: 1,
    source: 'postgres.users',
    exportedAt: nowIso(),
    counts: summarizeUsers(users),
    samples: pickBackupSamples(users, sampleSize),
    users,
  };
}

function usersBackupToCsv(snapshot) {
  const users = Array.isArray(snapshot && snapshot.users) ? snapshot.users.map(mapUserRowToBackup) : [];
  const headers = [
    'id',
    'displayName',
    'firstName',
    'lastName',
    'wwid',
    'email',
    'role',
    'isAssistant',
    'canAccessMarketer',
    'canAccessAdmin',
    'canAccessManager',
    'managerOnly',
    'departmentIds',
    'status',
    'isLocked',
    'passwordHash',
    'forcePasswordReset',
    'createdAt',
    'updatedAt',
  ];
  const escape = (value) => {
    const text = String(value ?? '');
    if (!/[",\r\n]/.test(text)) return text;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const rows = users.map((user) =>
    [
      user.id,
      user.displayName,
      user.firstName,
      user.lastName,
      user.wwid,
      user.email,
      user.role,
      user.isAssistant,
      user.canAccessMarketer,
      user.canAccessAdmin,
      user.canAccessManager,
      user.managerOnly,
      JSON.stringify(user.departmentIds || []),
      user.status,
      user.isLocked,
      user.passwordHash,
      user.forcePasswordReset,
      user.createdAt,
      user.updatedAt,
    ]
      .map(escape)
      .join(','),
  );
  return [headers.join(','), ...rows].join('\n');
}

function loadUsersBackupFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function parseUsersBackupPayload(input) {
  if (Array.isArray(input)) return input.map(mapUserRowToBackup);
  const src = input && typeof input === 'object' ? input : {};
  const users = Array.isArray(src.users) ? src.users : [];
  return users.map(mapUserRowToBackup);
}

function normalizeImportUser(input) {
  const row = mapUserRowToBackup(input);
  if (!row.id || !row.wwid || !row.email) return null;
  return row;
}

function equivalentUserRecord(left, right) {
  const a = normalizeImportUser(left);
  const b = normalizeImportUser(right);
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

async function upsertBackupUser(client, user) {
  const row = normalizeImportUser(user);
  if (!row) throw new Error('Backup user is invalid.');
  await client.query(
    `INSERT INTO users (
      id, display_name, first_name, last_name, wwid, email, role,
      is_assistant, can_access_marketer, can_access_admin, can_access_manager, manager_only,
      department_ids, status, is_locked, password_hash, force_password_reset, created_at, updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,
      $8,$9,$10,$11,$12,
      $13,$14,$15,$16,$17,$18,$19
    )
    ON CONFLICT (id) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name,
      wwid = EXCLUDED.wwid,
      email = EXCLUDED.email,
      role = EXCLUDED.role,
      is_assistant = EXCLUDED.is_assistant,
      can_access_marketer = EXCLUDED.can_access_marketer,
      can_access_admin = EXCLUDED.can_access_admin,
      can_access_manager = EXCLUDED.can_access_manager,
      manager_only = EXCLUDED.manager_only,
      department_ids = EXCLUDED.department_ids,
      status = EXCLUDED.status,
      is_locked = EXCLUDED.is_locked,
      password_hash = EXCLUDED.password_hash,
      force_password_reset = EXCLUDED.force_password_reset,
      updated_at = EXCLUDED.updated_at`,
    [
      row.id,
      row.displayName,
      row.firstName,
      row.lastName,
      row.wwid,
      row.email,
      row.role,
      row.isAssistant,
      row.canAccessMarketer,
      row.canAccessAdmin,
      row.canAccessManager,
      row.managerOnly,
      JSON.stringify(row.departmentIds),
      row.status,
      row.isLocked,
      row.passwordHash,
      row.forcePasswordReset,
      row.createdAt,
      row.updatedAt,
    ],
  );
}

function buildExistingIndexes(users) {
  const byId = new Map();
  const byWwid = new Map();
  const byEmail = new Map();
  users.forEach((entry) => {
    const row = normalizeImportUser(entry);
    if (!row) return;
    byId.set(row.id, row);
    byWwid.set(row.wwid, row);
    byEmail.set(row.email, row);
  });
  return { byId, byWwid, byEmail };
}

function findExistingUserMatch(indexes, user) {
  const matches = [];
  const pushIfPresent = (candidate) => {
    if (!candidate) return;
    if (matches.some((row) => row.id === candidate.id)) return;
    matches.push(candidate);
  };
  pushIfPresent(indexes.byId.get(user.id));
  pushIfPresent(indexes.byWwid.get(user.wwid));
  pushIfPresent(indexes.byEmail.get(user.email));
  if (!matches.length) return { type: 'create', match: null };
  if (matches.length > 1) return { type: 'conflict', matches };
  return { type: 'match', match: matches[0] };
}

async function importUsersBackup(pool, payload, options = {}) {
  const apply = options.apply === true;
  const incomingUsers = parseUsersBackupPayload(payload).map(normalizeImportUser).filter(Boolean);
  const report = {
    ok: true,
    applied: apply,
    processedAt: nowIso(),
    summary: { input: incomingUsers.length, create: 0, update: 0, unchanged: 0, skipped: 0, conflict: 0 },
    creates: [],
    updates: [],
    unchanged: [],
    skipped: [],
    conflicts: [],
  };

  const duplicateKeys = { id: new Set(), wwid: new Set(), email: new Set() };
  const seen = { id: new Set(), wwid: new Set(), email: new Set() };
  incomingUsers.forEach((user) => {
    if (seen.id.has(user.id)) duplicateKeys.id.add(user.id);
    seen.id.add(user.id);
    if (seen.wwid.has(user.wwid)) duplicateKeys.wwid.add(user.wwid);
    seen.wwid.add(user.wwid);
    if (seen.email.has(user.email)) duplicateKeys.email.add(user.email);
    seen.email.add(user.email);
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existingRows = (await client.query('SELECT * FROM users ORDER BY created_at ASC')).rows.map(mapUserRowToBackup);
    const indexes = buildExistingIndexes(existingRows);

    for (const user of incomingUsers) {
      if (duplicateKeys.id.has(user.id) || duplicateKeys.wwid.has(user.wwid) || duplicateKeys.email.has(user.email)) {
        report.summary.conflict += 1;
        report.conflicts.push({ id: user.id, wwid: user.wwid, email: user.email, reason: 'duplicate-in-import-file' });
        continue;
      }

      const matchResult = findExistingUserMatch(indexes, user);
      if (matchResult.type === 'conflict') {
        report.summary.conflict += 1;
        report.conflicts.push({
          id: user.id,
          wwid: user.wwid,
          email: user.email,
          reason: 'ambiguous-existing-match',
          matches: matchResult.matches.map((entry) => ({ id: entry.id, wwid: entry.wwid, email: entry.email })),
        });
        continue;
      }

      if (matchResult.type === 'create') {
        report.summary.create += 1;
        report.creates.push({ id: user.id, wwid: user.wwid, email: user.email, role: user.role, status: user.status });
        if (apply) {
          await upsertBackupUser(client, user);
          indexes.byId.set(user.id, user);
          indexes.byWwid.set(user.wwid, user);
          indexes.byEmail.set(user.email, user);
        }
        continue;
      }

      const existing = matchResult.match;
      const desired = Object.assign({}, user, {
        id: existing.id,
        createdAt: existing.createdAt || user.createdAt,
      });
      if (equivalentUserRecord(existing, desired)) {
        report.summary.unchanged += 1;
        report.unchanged.push({ id: existing.id, wwid: existing.wwid, email: existing.email });
        continue;
      }

      report.summary.update += 1;
      report.updates.push({
        id: existing.id,
        wwid: existing.wwid,
        email: existing.email,
        matchedBy: existing.id === user.id ? 'id' : existing.wwid === user.wwid ? 'wwid' : 'email',
      });
      if (apply) {
        await upsertBackupUser(client, desired);
        indexes.byId.set(existing.id, desired);
        indexes.byWwid.set(desired.wwid, desired);
        indexes.byEmail.set(desired.email, desired);
      }
    }

    if (apply) await client.query('COMMIT');
    else await client.query('ROLLBACK');
    return report;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  mapUserRowToBackup,
  summarizeUsers,
  pickBackupSamples,
  buildUsersBackupSnapshot,
  usersBackupToCsv,
  loadUsersBackupFile,
  importUsersBackup,
};
