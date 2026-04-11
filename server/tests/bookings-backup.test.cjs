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
  buildBookingsBackupPayload,
  createValidatedBookingsBackup,
  validateBookingsBackupFile,
} = require('../bookings-backup.cjs');

function createPool() {
  const mem = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const adapter = mem.adapters.createPg();
  return new adapter.Pool();
}

test('bookings backup exports booking rows with comparison-ready summary data', async () => {
  const pool = createPool();
  try {
    await createApp({ db: pool, seedDatabase: true });
    const backup = await buildBookingsBackupPayload(pool);
    assert.equal(backup.source, 'postgres.bookings');
    assert.equal(backup.summary.total >= 2, true);
    assert.equal(backup.summary.byStatus.pending >= 1, true);
    assert.equal(backup.summary.byStatus.working >= 1, true);
    assert.equal(Array.isArray(backup.sampleBookings), true);
    assert.equal(Array.isArray(backup.bookings), true);
    assert.match(backup.bookings[0].rowHash, /^sha256:/);
    assert.equal(typeof backup.bookings[0].rowData, 'object');
  } finally {
    await closePool(pool);
  }
});

test('bookings backup export writes json and validation sidecar files without restore behavior', async () => {
  const pool = createPool();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marketingtool-bookings-backup-'));
  try {
    await createApp({ db: pool, seedDatabase: true });
    const result = await createValidatedBookingsBackup(pool, {
      outDir,
      prefix: 'bookings-export',
      stamp: '20260410T000005000Z',
    });
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(result.files.json), true);
    assert.equal(fs.existsSync(result.files.validation), true);
    assert.equal(result.validation.comparison.mismatchedCount, 0);
    assert.equal(result.validation.comparison.extraInLiveCount, 0);
    assert.equal(result.validation.comparison.missingInLiveCount, 0);
  } finally {
    await closePool(pool);
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('bookings validation reports live drift for future proof-restore planning', async () => {
  const pool = createPool();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marketingtool-bookings-backup-'));
  try {
    await createApp({ db: pool, seedDatabase: true });
    const result = await createValidatedBookingsBackup(pool, {
      outDir,
      prefix: 'bookings-export',
      stamp: '20260410T000006000Z',
    });

    await withDb(pool, async (db) => {
      const target = db.bookings.find((entry) => String(entry.id || '') === 'seed-booking-pending-1');
      target.status = 'done';
      target.completedByUserId = 'user-admin-1';
      target.completedByName = 'Primary Admin';
      target.completedAt = nowIso();
      target.updatedAt = nowIso();
    });

    const live = await buildBookingsBackupPayload(pool);
    const validation = validateBookingsBackupFile(result.files.json, { expectedSnapshot: live });
    assert.equal(validation.ok, false);
    assert.equal(validation.comparison.mismatchedCount >= 1, true);
    assert.equal(validation.errors.some((message) => /differ from live DB/i.test(message)), true);
  } finally {
    await closePool(pool);
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
