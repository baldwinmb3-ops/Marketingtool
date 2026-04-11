const path = require('path');
const { newDb } = require('pg-mem');

const { closePool, migrateDatabase } = require('../db.cjs');
const { loadUsersBackupFile, importUsersBackup, buildUsersBackupSnapshot } = require('../user-backup.cjs');

function firstFileArg() {
  return process.argv.slice(2).find((arg) => !String(arg || '').startsWith('--')) || '';
}

function createMemoryPool() {
  const mem = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const adapter = mem.adapters.createPg();
  return new adapter.Pool();
}

async function run() {
  const fileArg = firstFileArg();
  if (!fileArg) {
    throw new Error('Provide a backup JSON file path. Example: npm run users:restore:proof -- backups/users/users-export-20260405T020000Z.json');
  }
  const filePath = path.resolve(fileArg);
  const payload = loadUsersBackupFile(filePath);
  const pool = createMemoryPool();
  try {
    await migrateDatabase(pool);
    const applyReport = await importUsersBackup(pool, payload, { apply: true });
    const snapshot = await buildUsersBackupSnapshot(pool);
    const dryRunReport = await importUsersBackup(pool, payload, { apply: false });
    const result = {
      ok:
        applyReport.summary.input === snapshot.counts.total &&
        dryRunReport.summary.unchanged === snapshot.counts.total &&
        dryRunReport.summary.conflict === 0,
      file: filePath,
      applied: applyReport,
      restoredCounts: snapshot.counts,
      followupDryRun: dryRunReport.summary,
    };
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } finally {
    await closePool(pool);
  }
}

run().catch((error) => {
  const message = String((error && error.message) || error || 'Restore proof failed');
  console.error(`Restore proof failed: ${message}`);
  process.exit(1);
});
