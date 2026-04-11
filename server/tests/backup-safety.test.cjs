const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { newDb } = require('pg-mem');

const { closePool } = require('../db.cjs');
const { createApp } = require('../app.cjs');
const { createValidatedUsersBackup, validateUsersBackupFile } = require('../backup-safety.cjs');

function createPool() {
  const mem = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const adapter = mem.adapters.createPg();
  return new adapter.Pool();
}

test('validated backup export writes json/csv/validation files', async () => {
  const pool = createPool();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marketingtool-backup-'));
  try {
    await createApp({ db: pool, seedDatabase: true });
    const result = await createValidatedUsersBackup(pool, {
      outDir,
      prefix: 'users-export',
      stamp: '20260405T000001Z',
    });
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(result.files.json), true);
    assert.equal(fs.existsSync(result.files.csv), true);
    assert.equal(fs.existsSync(result.files.validation), true);
    const validation = validateUsersBackupFile(result.files.json, { expectedCounts: result.snapshot.counts, csvPath: result.files.csv });
    assert.equal(validation.ok, true);
    assert.equal(validation.counts.total, result.snapshot.counts.total);
  } finally {
    await closePool(pool);
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('validated backup export keeps only the most recent 10 backup sets', async () => {
  const pool = createPool();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marketingtool-backup-'));
  try {
    await createApp({ db: pool, seedDatabase: true });
    for (let index = 0; index < 12; index += 1) {
      const stamp = `20260405T0000${String(index).padStart(2, '0')}Z`;
      await createValidatedUsersBackup(pool, {
        outDir,
        prefix: 'users-export',
        stamp,
        keep: 10,
      });
    }
    const jsonFiles = fs.readdirSync(outDir).filter((name) => name.endsWith('.json') && name.includes('users-export-') && !name.endsWith('.validation.json'));
    const validationFiles = fs.readdirSync(outDir).filter((name) => name.endsWith('.validation.json') && name.includes('users-export-'));
    assert.equal(jsonFiles.length, 10);
    assert.equal(validationFiles.length, 10);
    assert.equal(jsonFiles.some((name) => name.includes('20260405T000000Z')), false);
    assert.equal(jsonFiles.some((name) => name.includes('20260405T000001Z')), false);
    assert.equal(jsonFiles.some((name) => name.includes('20260405T000011Z')), true);
  } finally {
    await closePool(pool);
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
