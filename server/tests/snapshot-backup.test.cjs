const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { newDb } = require('pg-mem');

const { createApp } = require('../app.cjs');
const { closePool, withDb } = require('../db.cjs');
const { nowIso } = require('../lib.cjs');
const {
  buildSnapshotBackupPayload,
  createValidatedSnapshotBackup,
  validateSnapshotBackupFile,
} = require('../snapshot-backup.cjs');

function createPool() {
  const mem = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const adapter = mem.adapters.createPg();
  return new adapter.Pool();
}

test('published snapshot backup exports versioned metadata and payload fingerprints', async () => {
  const pool = createPool();
  try {
    await createApp({ db: pool, seedDatabase: true });
    const backup = await buildSnapshotBackupPayload(pool, 'published');
    assert.equal(backup.dataset, 'published');
    assert.equal(backup.exists, true);
    assert.equal(backup.metadata.version, 1);
    assert.equal(typeof backup.metadata.publishedByUserId, 'string');
    assert.equal(backup.payloadCounts.brands > 0, true);
    assert.equal(backup.payloadCounts.ticketLines > 0, true);
    assert.match(backup.payloadHash, /^sha256:/);
    assert.equal(Array.isArray(backup.payloadSamples.brands), true);
  } finally {
    await closePool(pool);
  }
});

test('draft snapshot backup export writes json and validation sidecar files', async () => {
  const pool = createPool();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marketingtool-snapshot-backup-'));
  try {
    await createApp({ db: pool, seedDatabase: true });
    const result = await createValidatedSnapshotBackup(pool, {
      outDir,
      prefix: 'snapshot-export',
      stamp: '20260410T000001Z',
      dataset: 'draft',
    });
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(result.files.json), true);
    assert.equal(fs.existsSync(result.files.validation), true);

    const live = await buildSnapshotBackupPayload(pool, 'draft');
    const validation = validateSnapshotBackupFile(result.files.json, { expectedSnapshot: live });
    assert.equal(validation.ok, true);
    assert.equal(validation.backup.dataset, 'draft');
    assert.equal(validation.exists, true);
    assert.equal(validation.payloadCounts.brands > 0, true);
  } finally {
    await closePool(pool);
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('snapshot validation detects live metadata mismatch without introducing restore behavior', async () => {
  const pool = createPool();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marketingtool-snapshot-backup-'));
  try {
    await createApp({ db: pool, seedDatabase: true });
    const result = await createValidatedSnapshotBackup(pool, {
      outDir,
      prefix: 'snapshot-export',
      stamp: '20260410T000002Z',
      dataset: 'published',
    });
    const live = await buildSnapshotBackupPayload(pool, 'published');
    const mismatchedLive = Object.assign({}, live, {
      metadata: Object.assign({}, live.metadata, { version: live.metadata.version + 1 }),
    });

    const validation = validateSnapshotBackupFile(result.files.json, { expectedSnapshot: mismatchedLive });
    assert.equal(validation.ok, false);
    assert.equal(validation.errors.some((message) => /metadata mismatch/i.test(message)), true);
  } finally {
    await closePool(pool);
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('snapshot history export preserves ordered append-only versions and validates against live history', async () => {
  const pool = createPool();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marketingtool-snapshot-history-backup-'));
  try {
    await createApp({ db: pool, seedDatabase: true });
    await withDb(pool, async (db) => {
      const current = db.snapshots.published;
      const stamp = nowIso();
      const payload = JSON.parse(JSON.stringify(current.payload));
      payload.meta = payload.meta && typeof payload.meta === 'object' ? payload.meta : {};
      payload.meta.version = current.version + 1;
      payload.meta.publishedAt = stamp;
      payload.meta.updatedAt = stamp;
      const next = {
        version: current.version + 1,
        publishedAt: stamp,
        updatedAt: stamp,
        publishedByUserId: 'user-admin-1',
        payload,
      };
      db.snapshots.published = next;
      db.snapshots.draft = { updatedAt: stamp, updatedByUserId: 'user-admin-1', payload };
      db.snapshots.history.push(next);
    });

    const history = await buildSnapshotBackupPayload(pool, 'history');
    assert.equal(history.dataset, 'history');
    assert.equal(history.exists, true);
    assert.equal(history.summary.totalEntries, 2);
    assert.equal(history.summary.versionsMonotonic, true);
    assert.equal(history.summary.lastVersion, 2);
    assert.equal(history.summary.latestMatchesCurrentPublished, true);

    const result = await createValidatedSnapshotBackup(pool, {
      outDir,
      prefix: 'snapshot-export',
      stamp: '20260410T000003Z',
      dataset: 'history',
    });
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(result.files.json), true);
    assert.equal(fs.existsSync(result.files.validation), true);

    const live = await buildSnapshotBackupPayload(pool, 'history');
    const validation = validateSnapshotBackupFile(result.files.json, { expectedSnapshot: live });
    assert.equal(validation.ok, true);
    assert.equal(validation.summary.totalEntries, 2);
  } finally {
    await closePool(pool);
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('snapshot history validation detects version-order damage without any restore path', async () => {
  const pool = createPool();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marketingtool-snapshot-history-backup-'));
  try {
    await createApp({ db: pool, seedDatabase: true });
    await withDb(pool, async (db) => {
      const current = db.snapshots.published;
      const stamp = nowIso();
      const payload = JSON.parse(JSON.stringify(current.payload));
      payload.meta = payload.meta && typeof payload.meta === 'object' ? payload.meta : {};
      payload.meta.version = current.version + 1;
      payload.meta.publishedAt = stamp;
      payload.meta.updatedAt = stamp;
      const next = {
        version: current.version + 1,
        publishedAt: stamp,
        updatedAt: stamp,
        publishedByUserId: 'user-admin-1',
        payload,
      };
      db.snapshots.published = next;
      db.snapshots.draft = { updatedAt: stamp, updatedByUserId: 'user-admin-1', payload };
      db.snapshots.history.push(next);
    });

    const result = await createValidatedSnapshotBackup(pool, {
      outDir,
      prefix: 'snapshot-export',
      stamp: '20260410T000004Z',
      dataset: 'history',
    });
    const payload = JSON.parse(fs.readFileSync(result.files.json, 'utf8'));
    payload.entries[1].version = payload.entries[0].version;
    fs.writeFileSync(result.files.json, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

    const validation = validateSnapshotBackupFile(result.files.json);
    assert.equal(validation.ok, false);
    assert.equal(validation.errors.some((message) => /versions are not strictly increasing|duplicate versions/i.test(message)), true);
  } finally {
    await closePool(pool);
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
