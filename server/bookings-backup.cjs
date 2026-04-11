const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { nowIso } = require('./lib.cjs');
const { bookingStatus } = require('./domain.cjs');

const DEFAULT_BOOKINGS_BACKUP_KEEP = 10;

function envInt(name, fallback) {
  const raw = Number.parseInt(String(process.env[name] || '').trim(), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function bookingsBackupRetentionCount() {
  return envInt('APP_BOOKINGS_BACKUP_KEEP', DEFAULT_BOOKINGS_BACKUP_KEEP);
}

function compactTimestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.(\d{3})Z$/, '$1Z');
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
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

function toIso(value, fallback = nowIso()) {
  const date = new Date(value || fallback);
  return Number.isNaN(date.getTime()) ? new Date(fallback).toISOString() : date.toISOString();
}

function optionalIso(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function toInt(value, fallback = 0, minimum = 0) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, parsed);
}

function rowHash(rowData) {
  return `sha256:${crypto.createHash('sha256').update(stableStringify(rowData && typeof rowData === 'object' ? rowData : {}), 'utf8').digest('hex')}`;
}

function normalizeBookingRecord(row) {
  const payload = asJson(row && (row.row_data || row.rowData), row && typeof row === 'object' ? row : {});
  const booking = payload && typeof payload === 'object' ? payload : {};
  const id = String(row && row.id ? row.id : booking.id || '').trim();
  return {
    id,
    status: bookingStatus(row && row.status ? row.status : booking.status),
    snapshotVersion: toInt(row && row.snapshot_version ? row.snapshot_version : row && row.snapshotVersion ? row.snapshotVersion : booking.snapshotVersion, 1, 1),
    revision: toInt(row && row.revision ? row.revision : booking.revision, 1, 1),
    workingByUserId: String(
      row && row.working_by_user_id
        ? row.working_by_user_id
        : row && row.workingByUserId
          ? row.workingByUserId
          : booking.workingByUserId || '',
    ).trim(),
    completedByUserId: String(
      row && row.completed_by_user_id
        ? row.completed_by_user_id
        : row && row.completedByUserId
          ? row.completedByUserId
          : booking.completedByUserId || '',
    ).trim(),
    createdAt: toIso(row && row.created_at ? row.created_at : row && row.createdAt ? row.createdAt : booking.createdAt),
    updatedAt: toIso(row && row.updated_at ? row.updated_at : row && row.updatedAt ? row.updatedAt : booking.updatedAt),
    rowHash: rowHash(booking),
    rowData: booking,
  };
}

function summarizeBookings(rows) {
  const list = Array.isArray(rows) ? rows.map(normalizeBookingRecord) : [];
  const summary = {
    total: list.length,
    byStatus: { pending: 0, working: 0, done: 0, deleted: 0 },
    snapshotVersions: { min: 0, max: 0, distinctCount: 0 },
    revisions: { min: 0, max: 0 },
    createdAtRange: { oldest: '', newest: '' },
    updatedAtRange: { oldest: '', newest: '' },
    ownerMarkers: { workingAssigned: 0, completedAssigned: 0 },
  };
  if (!list.length) return summary;

  const snapshotVersions = [];
  const revisions = [];
  const createdAtValues = [];
  const updatedAtValues = [];
  const distinctSnapshotVersions = new Set();

  list.forEach((entry) => {
    const status = bookingStatus(entry.status);
    summary.byStatus[status] = (summary.byStatus[status] || 0) + 1;
    snapshotVersions.push(entry.snapshotVersion);
    revisions.push(entry.revision);
    createdAtValues.push(entry.createdAt);
    updatedAtValues.push(entry.updatedAt);
    distinctSnapshotVersions.add(entry.snapshotVersion);
    if (entry.workingByUserId) summary.ownerMarkers.workingAssigned += 1;
    if (entry.completedByUserId) summary.ownerMarkers.completedAssigned += 1;
  });

  summary.snapshotVersions = {
    min: Math.min(...snapshotVersions),
    max: Math.max(...snapshotVersions),
    distinctCount: distinctSnapshotVersions.size,
  };
  summary.revisions = {
    min: Math.min(...revisions),
    max: Math.max(...revisions),
  };
  summary.createdAtRange = {
    oldest: createdAtValues.slice().sort()[0] || '',
    newest: createdAtValues.slice().sort().slice(-1)[0] || '',
  };
  summary.updatedAtRange = {
    oldest: updatedAtValues.slice().sort()[0] || '',
    newest: updatedAtValues.slice().sort().slice(-1)[0] || '',
  };
  return summary;
}

function trimBookingSample(entry) {
  const row = entry && typeof entry === 'object' ? entry : {};
  const data = row.rowData && typeof row.rowData === 'object' ? row.rowData : {};
  const guestName = [String(data.guestFirstName || '').trim(), String(data.guestLastName || '').trim()].filter(Boolean).join(' ').trim();
  return {
    id: String(row.id || '').trim(),
    status: bookingStatus(row.status),
    snapshotVersion: toInt(row.snapshotVersion, 1, 1),
    revision: toInt(row.revision, 1, 1),
    brandName: String(data.brandName || '').trim(),
    guestName,
    tourNumber: String(data.tourNumber || '').trim(),
    updatedAt: String(row.updatedAt || '').trim(),
    rowHash: String(row.rowHash || '').trim(),
  };
}

function sampleBookings(rows, sampleSize = 5) {
  const list = Array.isArray(rows) ? rows.map(normalizeBookingRecord) : [];
  return list.slice(0, sampleSize).map(trimBookingSample);
}

function flattenSummary(summary) {
  const src = summary && typeof summary === 'object' ? summary : {};
  const byStatus = src.byStatus && typeof src.byStatus === 'object' ? src.byStatus : {};
  const snapshotVersions = src.snapshotVersions && typeof src.snapshotVersions === 'object' ? src.snapshotVersions : {};
  const revisions = src.revisions && typeof src.revisions === 'object' ? src.revisions : {};
  const createdAtRange = src.createdAtRange && typeof src.createdAtRange === 'object' ? src.createdAtRange : {};
  const updatedAtRange = src.updatedAtRange && typeof src.updatedAtRange === 'object' ? src.updatedAtRange : {};
  const ownerMarkers = src.ownerMarkers && typeof src.ownerMarkers === 'object' ? src.ownerMarkers : {};
  return {
    total: Number(src.total) || 0,
    byStatus_pending: Number(byStatus.pending) || 0,
    byStatus_working: Number(byStatus.working) || 0,
    byStatus_done: Number(byStatus.done) || 0,
    byStatus_deleted: Number(byStatus.deleted) || 0,
    snapshotVersions_min: Number(snapshotVersions.min) || 0,
    snapshotVersions_max: Number(snapshotVersions.max) || 0,
    snapshotVersions_distinctCount: Number(snapshotVersions.distinctCount) || 0,
    revisions_min: Number(revisions.min) || 0,
    revisions_max: Number(revisions.max) || 0,
    createdAtRange_oldest: String(createdAtRange.oldest || '').trim(),
    createdAtRange_newest: String(createdAtRange.newest || '').trim(),
    updatedAtRange_oldest: String(updatedAtRange.oldest || '').trim(),
    updatedAtRange_newest: String(updatedAtRange.newest || '').trim(),
    ownerMarkers_workingAssigned: Number(ownerMarkers.workingAssigned) || 0,
    ownerMarkers_completedAssigned: Number(ownerMarkers.completedAssigned) || 0,
  };
}

function compareSummaries(actual, expected) {
  const left = flattenSummary(actual);
  const right = flattenSummary(expected);
  const keys = Array.from(new Set([...Object.keys(left), ...Object.keys(right)])).sort();
  return keys.filter((key) => String(left[key]) !== String(right[key]));
}

async function listRawBookings(pool) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT id, status, snapshot_version, revision, working_by_user_id, completed_by_user_id, created_at, updated_at, row_data FROM bookings ORDER BY created_at ASC, id ASC',
    );
    return result.rows.map(normalizeBookingRecord);
  } finally {
    client.release();
  }
}

async function buildBookingsBackupPayload(pool) {
  const bookings = await listRawBookings(pool);
  return {
    schemaVersion: 1,
    source: 'postgres.bookings',
    exportedAt: nowIso(),
    summary: summarizeBookings(bookings),
    sampleBookings: sampleBookings(bookings),
    bookings,
  };
}

function loadBookingsBackupFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function bookingIntegrityMismatches(entry) {
  const row = normalizeBookingRecord(entry);
  const payload = row.rowData && typeof row.rowData === 'object' ? row.rowData : {};
  const fields = [];
  if (String(payload.id || '').trim() !== row.id) fields.push('id');
  if (bookingStatus(payload.status) !== row.status) fields.push('status');
  if (toInt(payload.snapshotVersion, 1, 1) !== row.snapshotVersion) fields.push('snapshotVersion');
  if (toInt(payload.revision, 1, 1) !== row.revision) fields.push('revision');
  if (optionalIso(payload.createdAt) !== row.createdAt) fields.push('createdAt');
  if (optionalIso(payload.updatedAt) !== row.updatedAt) fields.push('updatedAt');
  if (String(payload.workingByUserId || '').trim() !== row.workingByUserId) fields.push('workingByUserId');
  if (String(payload.completedByUserId || '').trim() !== row.completedByUserId) fields.push('completedByUserId');
  return fields;
}

function compareBookingRows(actual, expected) {
  const reasons = [];
  if (actual.status !== expected.status) reasons.push('status');
  if (actual.snapshotVersion !== expected.snapshotVersion) reasons.push('snapshotVersion');
  if (actual.revision !== expected.revision) reasons.push('revision');
  if (actual.workingByUserId !== expected.workingByUserId) reasons.push('workingByUserId');
  if (actual.completedByUserId !== expected.completedByUserId) reasons.push('completedByUserId');
  if (actual.createdAt !== expected.createdAt) reasons.push('createdAt');
  if (actual.updatedAt !== expected.updatedAt) reasons.push('updatedAt');
  if (actual.rowHash !== expected.rowHash) reasons.push('rowHash');
  return reasons;
}

function buildComparisonReport(bookings, expectedSnapshot) {
  const actualRows = Array.isArray(bookings) ? bookings.map(normalizeBookingRecord) : [];
  const expectedRows =
    expectedSnapshot && Array.isArray(expectedSnapshot.bookings) ? expectedSnapshot.bookings.map(normalizeBookingRecord) : [];
  const actualById = new Map(actualRows.map((row) => [row.id, row]));
  const expectedById = new Map(expectedRows.map((row) => [row.id, row]));

  const missingInLive = [];
  const extraInLive = [];
  const mismatched = [];

  actualById.forEach((actual, id) => {
    const expected = expectedById.get(id);
    if (!expected) {
      missingInLive.push(id);
      return;
    }
    const reasons = compareBookingRows(actual, expected);
    if (reasons.length) {
      mismatched.push({ id, reasons });
    }
  });

  expectedById.forEach((_expected, id) => {
    if (!actualById.has(id)) {
      extraInLive.push(id);
    }
  });

  return {
    matchedCount: actualRows.length - missingInLive.length - mismatched.length,
    missingInLiveCount: missingInLive.length,
    extraInLiveCount: extraInLive.length,
    mismatchedCount: mismatched.length,
    missingInLive: missingInLive.slice(0, 10),
    extraInLive: extraInLive.slice(0, 10),
    mismatched: mismatched.slice(0, 10),
  };
}

function validateBookingsBackupPayload(payload, options = {}) {
  const src = payload && typeof payload === 'object' ? payload : {};
  const errors = [];
  const bookings = Array.isArray(src.bookings) ? src.bookings.map(normalizeBookingRecord) : [];
  const actualSummary = summarizeBookings(bookings);
  const duplicateIds = [];
  const invalidRows = [];
  const rowColumnMismatches = [];
  const seen = new Set();

  if (src.schemaVersion !== 1) {
    errors.push(`Unsupported schemaVersion: ${String(src.schemaVersion || '') || '(missing)'}`);
  }
  if (String(src.source || '').trim() !== 'postgres.bookings') {
    errors.push(`Unexpected backup source: ${String(src.source || '').trim() || '(missing)'}`);
  }
  if (!String(src.exportedAt || '').trim()) {
    errors.push('Missing exportedAt timestamp.');
  }

  bookings.forEach((entry) => {
    if (!entry.id) {
      invalidRows.push({ id: '', reason: 'missing-id' });
      return;
    }
    if (seen.has(entry.id)) {
      duplicateIds.push(entry.id);
    }
    seen.add(entry.id);
    if (String(entry.rowHash || '').trim() !== rowHash(entry.rowData)) {
      invalidRows.push({ id: entry.id, reason: 'row-hash-mismatch' });
    }
    const mismatches = bookingIntegrityMismatches(entry);
    if (mismatches.length) {
      rowColumnMismatches.push({ id: entry.id, fields: mismatches });
    }
  });

  if (duplicateIds.length) {
    errors.push(`Duplicate booking ids found in backup: ${duplicateIds.join(', ')}`);
  }
  if (invalidRows.length) {
    invalidRows.forEach((entry) => {
      errors.push(`Invalid booking backup row ${entry.id || '(missing-id)'}: ${entry.reason}`);
    });
  }
  if (rowColumnMismatches.length) {
    rowColumnMismatches.forEach((entry) => {
      errors.push(`Booking row/column mismatch for ${entry.id}: ${entry.fields.join(', ')}`);
    });
  }

  const summaryDiffs = compareSummaries(actualSummary, src.summary || {});
  summaryDiffs.forEach((key) => {
    const expected = flattenSummary(src.summary || {})[key];
    const actual = flattenSummary(actualSummary)[key];
    errors.push(`Booking summary mismatch for ${key}: expected=${String(expected)} actual=${String(actual)}`);
  });

  const expectedSnapshot = options.expectedSnapshot && typeof options.expectedSnapshot === 'object' ? options.expectedSnapshot : null;
  const comparison = expectedSnapshot ? buildComparisonReport(bookings, expectedSnapshot) : buildComparisonReport(bookings, { bookings });
  if (expectedSnapshot) {
    if ((expectedSnapshot.schemaVersion || 1) !== 1) {
      errors.push(`Unsupported live comparison schemaVersion: ${String(expectedSnapshot.schemaVersion || '') || '(missing)'}`);
    }
    const liveSummary = expectedSnapshot.summary && typeof expectedSnapshot.summary === 'object' ? expectedSnapshot.summary : {};
    compareSummaries(actualSummary, liveSummary).forEach((key) => {
      const expected = flattenSummary(liveSummary)[key];
      const actual = flattenSummary(actualSummary)[key];
      errors.push(`Live booking summary mismatch for ${key}: expected=${String(expected)} actual=${String(actual)}`);
    });
    if (comparison.missingInLiveCount > 0) {
      errors.push(`Backup contains ${comparison.missingInLiveCount} booking(s) missing in live DB.`);
    }
    if (comparison.extraInLiveCount > 0) {
      errors.push(`Live DB contains ${comparison.extraInLiveCount} booking(s) missing from backup.`);
    }
    if (comparison.mismatchedCount > 0) {
      errors.push(`Backup contains ${comparison.mismatchedCount} booking(s) that differ from live DB.`);
    }
  }

  return {
    ok: errors.length === 0,
    validatedAt: nowIso(),
    schemaVersion: src.schemaVersion,
    source: String(src.source || '').trim(),
    exportedAt: String(src.exportedAt || '').trim(),
    summary: src.summary && typeof src.summary === 'object' ? src.summary : actualSummary,
    sampleBookings: src.sampleBookings && Array.isArray(src.sampleBookings) ? src.sampleBookings : sampleBookings(bookings),
    comparison,
    integrity: {
      duplicateIds,
      invalidRows,
      rowColumnMismatches: rowColumnMismatches.slice(0, 10),
    },
    errors,
  };
}

function fileInfo(filePath) {
  const stats = fs.statSync(filePath);
  return {
    path: filePath,
    sizeBytes: stats.size,
    createdAt: stats.birthtime.toISOString(),
    modifiedAt: stats.mtime.toISOString(),
  };
}

function resolveBookingsBackupFilePaths(outDir, prefix, stamp) {
  const base = path.join(path.resolve(outDir), `${prefix}-${stamp}`);
  return {
    json: `${base}.json`,
    validation: `${base}.validation.json`,
  };
}

function ensureUniqueBookingsStamp(outDir, prefix, stamp) {
  let candidate = String(stamp || '').trim() || compactTimestamp();
  let suffix = 1;
  while (true) {
    const files = resolveBookingsBackupFilePaths(outDir, prefix, candidate);
    if (!fs.existsSync(files.json) && !fs.existsSync(files.validation)) {
      return candidate;
    }
    candidate = `${String(stamp || '').trim() || compactTimestamp()}-${String(suffix).padStart(2, '0')}`;
    suffix += 1;
  }
}

function pruneBookingsBackupSets(outDir, prefix, keep = bookingsBackupRetentionCount()) {
  const dir = path.resolve(outDir);
  if (!fs.existsSync(dir)) return [];
  const matcher = new RegExp(`^${String(prefix || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:-(\\d{8}T\\d{6}(?:\\d{3})?Z(?:-\\d+)?))(?:\\.|$)`);
  const grouped = new Map();
  fs.readdirSync(dir).forEach((name) => {
    const match = name.match(matcher);
    if (!match) return;
    const stamp = match[1];
    if (!grouped.has(stamp)) grouped.set(stamp, []);
    grouped.get(stamp).push(path.join(dir, name));
  });
  const ordered = Array.from(grouped.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  const toDelete = ordered.slice(Math.max(keep, 0));
  const removed = [];
  toDelete.forEach(([, files]) => {
    files.forEach((filePath) => {
      if (!fs.existsSync(filePath)) return;
      fs.unlinkSync(filePath);
      removed.push(filePath);
    });
  });
  return removed;
}

function validateBookingsBackupFile(filePath, options = {}) {
  const payload = loadBookingsBackupFile(filePath);
  const validation = validateBookingsBackupPayload(payload, options);
  return {
    ok: validation.ok,
    validatedAt: validation.validatedAt,
    backup: {
      schemaVersion: validation.schemaVersion,
      source: validation.source,
      exportedAt: validation.exportedAt,
      file: fileInfo(filePath),
    },
    summary: validation.summary,
    sampleBookings: validation.sampleBookings,
    comparison: validation.comparison,
    integrity: validation.integrity,
    errors: validation.errors,
  };
}

async function createValidatedBookingsBackup(pool, options = {}) {
  const outDir = path.resolve(options.outDir || path.join(process.cwd(), 'backups', 'bookings'));
  const prefix = String(options.prefix || 'bookings-export').trim() || 'bookings-export';
  const requestedStamp = String(options.stamp || compactTimestamp()).trim() || compactTimestamp();
  const keep = Math.max(1, Number.parseInt(String(options.keep || bookingsBackupRetentionCount()), 10) || bookingsBackupRetentionCount());
  fs.mkdirSync(outDir, { recursive: true });

  const backup = await buildBookingsBackupPayload(pool);
  const stamp = ensureUniqueBookingsStamp(outDir, prefix, requestedStamp);
  const files = resolveBookingsBackupFilePaths(outDir, prefix, stamp);
  fs.writeFileSync(files.json, `${JSON.stringify(backup, null, 2)}\n`, 'utf8');

  const validation = validateBookingsBackupFile(files.json, { expectedSnapshot: backup });
  fs.writeFileSync(files.validation, `${JSON.stringify(validation, null, 2)}\n`, 'utf8');
  const prunedFiles = pruneBookingsBackupSets(outDir, prefix, keep);

  return {
    ok: validation.ok,
    backup,
    validation,
    files,
    prunedFiles,
  };
}

module.exports = {
  buildBookingsBackupPayload,
  compactTimestamp,
  createValidatedBookingsBackup,
  loadBookingsBackupFile,
  validateBookingsBackupFile,
  validateBookingsBackupPayload,
};
