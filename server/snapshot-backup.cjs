const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { readDb } = require('./db.cjs');
const { nowIso } = require('./lib.cjs');

const DEFAULT_SNAPSHOT_BACKUP_KEEP = 10;
const SNAPSHOT_DATASETS = new Set(['published', 'draft', 'history']);

function envInt(name, fallback) {
  const raw = Number.parseInt(String(process.env[name] || '').trim(), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function snapshotBackupRetentionCount() {
  return envInt('APP_SNAPSHOT_BACKUP_KEEP', DEFAULT_SNAPSHOT_BACKUP_KEEP);
}

function compactTimestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.(\d{3})Z$/, '$1Z');
}

function normalizeDataset(value) {
  const key = String(value || '').trim().toLowerCase();
  return SNAPSHOT_DATASETS.has(key) ? key : null;
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

function toIso(value, fallback = nowIso()) {
  const date = new Date(value || fallback);
  return Number.isNaN(date.getTime()) ? new Date(fallback).toISOString() : date.toISOString();
}

function payloadCounts(payload) {
  const src = payload && typeof payload === 'object' ? payload : {};
  const count = (value) => (Array.isArray(value) ? value.length : 0);
  return {
    brands: count(src.brands),
    ticketLines: count(src.ticketLines),
    resources: count(src.resources),
    managerCategories: count(src.managerCategories),
    managerEntries: count(src.managerEntries),
    phoneDirectoryEntries: count(src.phoneDirectoryEntries),
  };
}

function sampleListEntries(items, sampleSize = 3) {
  const list = Array.isArray(items) ? items : [];
  return list.slice(0, sampleSize).map((entry) => {
    const row = entry && typeof entry === 'object' ? entry : {};
    return {
      id: String(row.id || '').trim(),
      name: String(row.name || row.title || row.ticketLabel || '').trim(),
    };
  });
}

function payloadSamples(payload) {
  const src = payload && typeof payload === 'object' ? payload : {};
  return {
    brands: sampleListEntries(src.brands),
    ticketLines: sampleListEntries(src.ticketLines),
    resources: sampleListEntries(src.resources),
    managerCategories: sampleListEntries(src.managerCategories),
    managerEntries: sampleListEntries(src.managerEntries),
    phoneDirectoryEntries: sampleListEntries(src.phoneDirectoryEntries),
  };
}

function payloadHash(payload) {
  return `sha256:${crypto.createHash('sha256').update(stableStringify(payload && typeof payload === 'object' ? payload : {}), 'utf8').digest('hex')}`;
}

function summarizeSnapshotMetadata(dataset, row) {
  const src = row && typeof row === 'object' ? row : null;
  if (!src) return null;
  if (dataset === 'published') {
    return {
      version: Math.max(1, Number.parseInt(String(src.version || '1'), 10) || 1),
      publishedAt: toIso(src.publishedAt),
      updatedAt: toIso(src.updatedAt),
      publishedByUserId: String(src.publishedByUserId || '').trim(),
    };
  }
  return {
    updatedAt: toIso(src.updatedAt),
    updatedByUserId: String(src.updatedByUserId || '').trim(),
  };
}

function trimHistoryEntry(entry) {
  const row = entry && typeof entry === 'object' ? entry : {};
  return {
    version: Math.max(1, Number.parseInt(String(row.version || '1'), 10) || 1),
    publishedAt: toIso(row.publishedAt),
    updatedAt: toIso(row.updatedAt),
    publishedByUserId: String(row.publishedByUserId || '').trim(),
    payloadHash: String(row.payloadHash || '').trim(),
    payloadCounts: row.payloadCounts && typeof row.payloadCounts === 'object' ? row.payloadCounts : payloadCounts(row.payload),
    payloadSamples: row.payloadSamples && typeof row.payloadSamples === 'object' ? row.payloadSamples : payloadSamples(row.payload),
  };
}

function normalizeHistoryEntry(input) {
  const row = input && typeof input === 'object' ? input : {};
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  return {
    version: Math.max(1, Number.parseInt(String(row.version || '1'), 10) || 1),
    publishedAt: toIso(row.publishedAt),
    updatedAt: toIso(row.updatedAt),
    publishedByUserId: String(row.publishedByUserId || '').trim(),
    payloadHash: payloadHash(payload),
    payloadCounts: payloadCounts(payload),
    payloadSamples: payloadSamples(payload),
    payload,
  };
}

function summarizeHistoryEntries(entries, published = null) {
  const list = Array.isArray(entries) ? entries.map(normalizeHistoryEntry) : [];
  const versions = list.map((entry) => entry.version);
  const latest = list.length ? list[list.length - 1] : null;
  const currentPublished =
    published && typeof published === 'object'
      ? {
          version: Math.max(1, Number.parseInt(String(published.version || '1'), 10) || 1),
          payloadHash: payloadHash(published.payload),
        }
      : null;
  return {
    totalEntries: list.length,
    uniqueVersions: new Set(versions).size,
    firstVersion: list.length ? list[0].version : 0,
    lastVersion: latest ? latest.version : 0,
    versionsMonotonic: versions.every((version, index) => index === 0 || version > versions[index - 1]),
    currentPublishedVersion: currentPublished ? currentPublished.version : 0,
    latestMatchesCurrentPublished: !!(
      latest &&
      currentPublished &&
      latest.version === currentPublished.version &&
      latest.payloadHash === currentPublished.payloadHash
    ),
  };
}

function sampleHistoryEntries(entries, sampleSize = 3) {
  const list = Array.isArray(entries) ? entries.map(trimHistoryEntry) : [];
  if (list.length <= sampleSize) return list;

  const indexes = [0, Math.floor((list.length - 1) / 2), list.length - 1];
  const picked = [];
  const seen = new Set();
  indexes.forEach((index) => {
    if (index < 0 || index >= list.length || seen.has(index)) return;
    seen.add(index);
    picked.push(list[index]);
  });
  return picked;
}

function buildSnapshotHistoryBackupPayloadFromState(state) {
  const snapshots = state && state.snapshots && typeof state.snapshots === 'object' ? state.snapshots : {};
  const history = Array.isArray(snapshots.history) ? snapshots.history : [];
  const entries = history.map(normalizeHistoryEntry);
  return {
    schemaVersion: 1,
    source: 'postgres.snapshot_history',
    dataset: 'history',
    exportedAt: nowIso(),
    exists: entries.length > 0,
    summary: summarizeHistoryEntries(entries, snapshots.published),
    sampleEntries: sampleHistoryEntries(entries),
    entries,
  };
}

function buildSnapshotBackupPayloadFromState(dataset, state) {
  const kind = normalizeDataset(dataset);
  if (!kind) {
    throw new Error(`Unsupported snapshot dataset: ${String(dataset || '') || '(missing)'}`);
  }
  if (kind === 'history') {
    return buildSnapshotHistoryBackupPayloadFromState(state);
  }

  const snapshots = state && state.snapshots && typeof state.snapshots === 'object' ? state.snapshots : {};
  const row = kind === 'published' ? snapshots.published : snapshots.draft;
  const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : null;
  const exists = !!row;

  return {
    schemaVersion: 1,
    source: 'postgres.snapshot',
    dataset: kind,
    exportedAt: nowIso(),
    exists,
    metadata: summarizeSnapshotMetadata(kind, row),
    payloadHash: exists ? payloadHash(payload) : '',
    payloadCounts: exists ? payloadCounts(payload) : payloadCounts(null),
    payloadSamples: exists ? payloadSamples(payload) : payloadSamples(null),
    payload: exists ? payload : null,
  };
}

async function buildSnapshotBackupPayload(pool, dataset) {
  const state = await readDb(pool);
  return buildSnapshotBackupPayloadFromState(dataset, state);
}

function compareCounts(actual, expected) {
  const keys = Array.from(new Set([...Object.keys(actual || {}), ...Object.keys(expected || {})])).sort();
  return keys.filter((key) => (Number(actual && actual[key]) || 0) !== (Number(expected && expected[key]) || 0));
}

function compareHistorySummaries(actual, expected) {
  const keys = ['totalEntries', 'uniqueVersions', 'firstVersion', 'lastVersion', 'versionsMonotonic'];
  return keys.filter((key) => {
    if (key === 'versionsMonotonic') return !!actual[key] !== !!expected[key];
    return (Number(actual[key]) || 0) !== (Number(expected[key]) || 0);
  });
}

function validateSnapshotHistoryBackupPayload(payload, options = {}) {
  const src = payload && typeof payload === 'object' ? payload : {};
  const errors = [];
  const entries = Array.isArray(src.entries) ? src.entries.map(normalizeHistoryEntry) : [];
  const actualSummary = summarizeHistoryEntries(entries);

  if (src.schemaVersion !== 1) {
    errors.push(`Unsupported schemaVersion: ${String(src.schemaVersion || '') || '(missing)'}`);
  }
  if (String(src.source || '').trim() !== 'postgres.snapshot_history') {
    errors.push(`Unexpected backup source: ${String(src.source || '').trim() || '(missing)'}`);
  }
  if (normalizeDataset(src.dataset) !== 'history') {
    errors.push(`Unsupported dataset: ${String(src.dataset || '').trim() || '(missing)'}`);
  }
  if (!String(src.exportedAt || '').trim()) {
    errors.push('Missing exportedAt timestamp.');
  }
  if (!!src.exists !== (entries.length > 0)) {
    errors.push(`Snapshot history existence mismatch: expected=${entries.length > 0} actual=${!!src.exists}`);
  }

  const summary = src.summary && typeof src.summary === 'object' ? src.summary : {};
  compareHistorySummaries(actualSummary, summary).forEach((key) => {
    errors.push(
      `Snapshot history summary mismatch for ${key}: expected=${String(summary[key]) || '0'} actual=${String(actualSummary[key]) || '0'}`,
    );
  });

  if (!actualSummary.versionsMonotonic) {
    errors.push('Snapshot history versions are not strictly increasing.');
  }
  if (actualSummary.totalEntries !== actualSummary.uniqueVersions) {
    errors.push('Snapshot history contains duplicate versions.');
  }

  entries.forEach((entry) => {
    if (!String(entry.publishedAt || '').trim()) {
      errors.push(`Snapshot history entry ${entry.version} is missing publishedAt.`);
    }
    if (!String(entry.updatedAt || '').trim()) {
      errors.push(`Snapshot history entry ${entry.version} is missing updatedAt.`);
    }
    if (!String(entry.publishedByUserId || '').trim()) {
      errors.push(`Snapshot history entry ${entry.version} is missing publishedByUserId.`);
    }
    if (!String(entry.payloadHash || '').trim()) {
      errors.push(`Snapshot history entry ${entry.version} is missing payloadHash.`);
    }
  });

  const expectedSnapshot = options.expectedSnapshot && typeof options.expectedSnapshot === 'object' ? options.expectedSnapshot : null;
  if (expectedSnapshot) {
    if (normalizeDataset(expectedSnapshot.dataset) !== 'history') {
      errors.push(
        `Dataset mismatch vs live snapshot: expected=${String(expectedSnapshot.dataset || '') || '(missing)'} actual=${String(src.dataset || '') || '(missing)'}`,
      );
    }
    const expectedEntries = Array.isArray(expectedSnapshot.entries) ? expectedSnapshot.entries.map(normalizeHistoryEntry) : [];
    if (expectedEntries.length !== entries.length) {
      errors.push(`Snapshot history entry count mismatch vs live history: expected=${expectedEntries.length} actual=${entries.length}`);
    }

    const maxLength = Math.max(entries.length, expectedEntries.length);
    for (let index = 0; index < maxLength; index += 1) {
      const actual = entries[index];
      const expected = expectedEntries[index];
      if (!actual || !expected) continue;
      if (actual.version !== expected.version) {
        errors.push(`Snapshot history version mismatch at index ${index}: expected=${expected.version} actual=${actual.version}`);
        continue;
      }
      if (actual.publishedAt !== expected.publishedAt) {
        errors.push(
          `Snapshot history publishedAt mismatch for version ${actual.version}: expected=${expected.publishedAt} actual=${actual.publishedAt}`,
        );
      }
      if (actual.updatedAt !== expected.updatedAt) {
        errors.push(
          `Snapshot history updatedAt mismatch for version ${actual.version}: expected=${expected.updatedAt} actual=${actual.updatedAt}`,
        );
      }
      if (actual.publishedByUserId !== expected.publishedByUserId) {
        errors.push(
          `Snapshot history publishedByUserId mismatch for version ${actual.version}: expected=${expected.publishedByUserId || '(missing)'} actual=${actual.publishedByUserId || '(missing)'}`,
        );
      }
      if (actual.payloadHash !== expected.payloadHash) {
        errors.push(`Snapshot history payload hash mismatch for version ${actual.version}.`);
      }
    }

    const expectedSummary = expectedSnapshot.summary && typeof expectedSnapshot.summary === 'object' ? expectedSnapshot.summary : {};
    if ((Number(summary.currentPublishedVersion) || 0) !== (Number(expectedSummary.currentPublishedVersion) || 0)) {
      errors.push(
        `Snapshot history currentPublishedVersion mismatch: expected=${Number(expectedSummary.currentPublishedVersion) || 0} actual=${Number(summary.currentPublishedVersion) || 0}`,
      );
    }
    if (
      Object.prototype.hasOwnProperty.call(summary, 'latestMatchesCurrentPublished') &&
      !!summary.latestMatchesCurrentPublished !== !!expectedSummary.latestMatchesCurrentPublished
    ) {
      errors.push(
        `Snapshot history latest/current published relationship mismatch: expected=${!!expectedSummary.latestMatchesCurrentPublished} actual=${!!summary.latestMatchesCurrentPublished}`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    validatedAt: nowIso(),
    schemaVersion: src.schemaVersion,
    source: String(src.source || '').trim(),
    dataset: 'history',
    exportedAt: String(src.exportedAt || '').trim(),
    exists: entries.length > 0,
    summary: Object.assign({}, actualSummary, {
      currentPublishedVersion: Number(summary.currentPublishedVersion) || 0,
      latestMatchesCurrentPublished: Object.prototype.hasOwnProperty.call(summary, 'latestMatchesCurrentPublished')
        ? !!summary.latestMatchesCurrentPublished
        : false,
    }),
    sampleEntries: src.sampleEntries && Array.isArray(src.sampleEntries) ? src.sampleEntries : sampleHistoryEntries(entries),
    errors,
  };
}

function validateSingleSnapshotBackupPayload(payload, options = {}) {
  const src = payload && typeof payload === 'object' ? payload : {};
  const dataset = normalizeDataset(src.dataset);
  const exists = !!src.exists;
  const errors = [];
  const actualCounts = payloadCounts(src.payload);
  const actualHash = exists ? payloadHash(src.payload) : '';

  if (src.schemaVersion !== 1) {
    errors.push(`Unsupported schemaVersion: ${String(src.schemaVersion || '') || '(missing)'}`);
  }
  if (String(src.source || '').trim() !== 'postgres.snapshot') {
    errors.push(`Unexpected backup source: ${String(src.source || '') || '(missing)'}`);
  }
  if (!dataset || dataset === 'history') {
    errors.push(`Unsupported dataset: ${String(src.dataset || '') || '(missing)'}`);
  }
  if (!String(src.exportedAt || '').trim()) {
    errors.push('Missing exportedAt timestamp.');
  }
  if (exists && !src.metadata) {
    errors.push('Snapshot metadata is missing.');
  }
  if (exists && !src.payload) {
    errors.push('Snapshot payload is missing.');
  }
  if (!exists && src.payload) {
    errors.push('Backup marked as missing snapshot but still contains payload.');
  }
  if (exists && String(src.payloadHash || '').trim() !== actualHash) {
    errors.push(`Payload hash mismatch: expected=${String(src.payloadHash || '').trim() || '(missing)'} actual=${actualHash}`);
  }

  const countDiffs = compareCounts(actualCounts, src.payloadCounts || {});
  countDiffs.forEach((key) => {
    errors.push(
      `Payload count mismatch for ${key}: expected=${Number(src.payloadCounts && src.payloadCounts[key]) || 0} actual=${Number(actualCounts[key]) || 0}`,
    );
  });

  if (exists && dataset === 'published') {
    const meta = src.metadata && typeof src.metadata === 'object' ? src.metadata : {};
    if (!(Number(meta.version) > 0)) errors.push('Published snapshot version is missing or invalid.');
    if (!String(meta.publishedAt || '').trim()) errors.push('Published snapshot publishedAt is missing.');
    if (!String(meta.updatedAt || '').trim()) errors.push('Published snapshot updatedAt is missing.');
    if (!String(meta.publishedByUserId || '').trim()) errors.push('Published snapshot publishedByUserId is missing.');
    const payloadVersion = Number(src.payload && src.payload.meta && src.payload.meta.version);
    if (Number.isFinite(payloadVersion) && Number(meta.version) !== payloadVersion) {
      errors.push(`Published snapshot version mismatch: metadata=${Number(meta.version) || 0} payload=${payloadVersion}`);
    }
  }

  if (exists && dataset === 'draft') {
    const meta = src.metadata && typeof src.metadata === 'object' ? src.metadata : {};
    if (!String(meta.updatedAt || '').trim()) errors.push('Draft snapshot updatedAt is missing.');
    if (!String(meta.updatedByUserId || '').trim()) errors.push('Draft snapshot updatedByUserId is missing.');
  }

  const expectedSnapshot = options.expectedSnapshot && typeof options.expectedSnapshot === 'object' ? options.expectedSnapshot : null;
  if (expectedSnapshot) {
    const expectedDataset = normalizeDataset(expectedSnapshot.dataset);
    if (expectedDataset !== dataset) {
      errors.push(
        `Dataset mismatch vs live snapshot: expected=${String(expectedSnapshot.dataset || '') || '(missing)'} actual=${String(src.dataset || '') || '(missing)'}`,
      );
    }
    if (!!expectedSnapshot.exists !== exists) {
      errors.push(`Snapshot existence mismatch vs live snapshot: expected=${!!expectedSnapshot.exists} actual=${exists}`);
    }
    if (exists && expectedSnapshot.exists) {
      if (String(expectedSnapshot.payloadHash || '').trim() !== String(src.payloadHash || '').trim()) {
        errors.push('Snapshot payload hash does not match current live snapshot.');
      }
      const expectedMeta = expectedSnapshot.metadata && typeof expectedSnapshot.metadata === 'object' ? expectedSnapshot.metadata : {};
      const actualMeta = src.metadata && typeof src.metadata === 'object' ? src.metadata : {};
      Object.keys(expectedMeta).forEach((key) => {
        if (String(expectedMeta[key] || '').trim() !== String(actualMeta[key] || '').trim()) {
          errors.push(
            `Snapshot metadata mismatch for ${key}: expected=${String(expectedMeta[key] || '') || '(missing)'} actual=${String(actualMeta[key] || '') || '(missing)'}`,
          );
        }
      });
    }
  }

  return {
    ok: errors.length === 0,
    validatedAt: nowIso(),
    schemaVersion: src.schemaVersion,
    source: String(src.source || '').trim(),
    dataset: dataset || String(src.dataset || '').trim(),
    exportedAt: String(src.exportedAt || '').trim(),
    exists,
    metadata: src.metadata && typeof src.metadata === 'object' ? src.metadata : null,
    payloadHash: String(src.payloadHash || '').trim(),
    payloadCounts: src.payloadCounts && typeof src.payloadCounts === 'object' ? src.payloadCounts : actualCounts,
    payloadSamples: src.payloadSamples && typeof src.payloadSamples === 'object' ? src.payloadSamples : payloadSamples(src.payload),
    errors,
  };
}

function validateSnapshotBackupPayload(payload, options = {}) {
  const dataset = normalizeDataset(payload && payload.dataset);
  if (dataset === 'history') {
    return validateSnapshotHistoryBackupPayload(payload, options);
  }
  return validateSingleSnapshotBackupPayload(payload, options);
}

function loadSnapshotBackupFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
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

function resolveSnapshotBackupFilePaths(outDir, prefix, stamp, dataset) {
  const base = path.join(path.resolve(outDir), `${prefix}-${stamp}.${dataset}`);
  return {
    json: `${base}.json`,
    validation: `${base}.validation.json`,
  };
}

function ensureUniqueSnapshotStamp(outDir, prefix, stamp, dataset) {
  let candidate = String(stamp || '').trim() || compactTimestamp();
  let suffix = 1;
  while (true) {
    const files = resolveSnapshotBackupFilePaths(outDir, prefix, candidate, dataset);
    if (!fs.existsSync(files.json) && !fs.existsSync(files.validation)) {
      return candidate;
    }
    candidate = `${String(stamp || '').trim() || compactTimestamp()}-${String(suffix).padStart(2, '0')}`;
    suffix += 1;
  }
}

function pruneSnapshotBackupSets(outDir, prefix, dataset, keep = snapshotBackupRetentionCount()) {
  const dir = path.resolve(outDir);
  if (!fs.existsSync(dir)) return [];
  const matcher = new RegExp(`^${String(prefix || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:-(\\d{8}T\\d{6}(?:\\d{3})?Z(?:-\\d+)?))\\.${dataset}(?:\\.|$)`);
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

function validateSnapshotBackupFile(filePath, options = {}) {
  const payload = loadSnapshotBackupFile(filePath);
  const validation = validateSnapshotBackupPayload(payload, options);
  const report = {
    ok: validation.ok,
    validatedAt: validation.validatedAt,
    backup: {
      schemaVersion: validation.schemaVersion,
      source: validation.source,
      dataset: validation.dataset,
      exportedAt: validation.exportedAt,
      file: fileInfo(filePath),
    },
    exists: validation.exists,
    errors: validation.errors,
  };

  if (validation.dataset === 'history') {
    report.summary = validation.summary;
    report.sampleEntries = validation.sampleEntries;
    return report;
  }

  report.metadata = validation.metadata;
  report.payloadHash = validation.payloadHash;
  report.payloadCounts = validation.payloadCounts;
  report.payloadSamples = validation.payloadSamples;
  return report;
}

async function createValidatedSnapshotBackup(pool, options = {}) {
  const dataset = normalizeDataset(options.dataset);
  if (!dataset) {
    throw new Error(`Unsupported snapshot dataset: ${String(options.dataset || '') || '(missing)'}`);
  }
  const outDir = path.resolve(options.outDir || path.join(process.cwd(), 'backups', 'snapshots'));
  const prefix = String(options.prefix || 'snapshot-export').trim() || 'snapshot-export';
  const requestedStamp = String(options.stamp || compactTimestamp()).trim() || compactTimestamp();
  const keep = Math.max(1, Number.parseInt(String(options.keep || snapshotBackupRetentionCount()), 10) || snapshotBackupRetentionCount());
  fs.mkdirSync(outDir, { recursive: true });

  const backup = await buildSnapshotBackupPayload(pool, dataset);
  const stamp = ensureUniqueSnapshotStamp(outDir, prefix, requestedStamp, dataset);
  const files = resolveSnapshotBackupFilePaths(outDir, prefix, stamp, dataset);
  fs.writeFileSync(files.json, `${JSON.stringify(backup, null, 2)}\n`, 'utf8');

  const validation = validateSnapshotBackupFile(files.json, { expectedSnapshot: backup });
  fs.writeFileSync(files.validation, `${JSON.stringify(validation, null, 2)}\n`, 'utf8');
  const prunedFiles = pruneSnapshotBackupSets(outDir, prefix, dataset, keep);

  return {
    ok: validation.ok,
    backup,
    validation,
    files,
    prunedFiles,
  };
}

module.exports = {
  buildSnapshotBackupPayload,
  buildSnapshotBackupPayloadFromState,
  compactTimestamp,
  createValidatedSnapshotBackup,
  loadSnapshotBackupFile,
  payloadCounts,
  payloadHash,
  validateSnapshotBackupFile,
  validateSnapshotBackupPayload,
};
