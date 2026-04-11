const path = require('path');

const { createPoolFromEnv, closePool } = require('../db.cjs');
const { compactTimestamp, createValidatedUsersBackup } = require('../backup-safety.cjs');
const { loadUsersBackupFile, importUsersBackup } = require('../user-backup.cjs');

function firstFileArg() {
  return process.argv.slice(2).find((arg) => !String(arg || '').startsWith('--')) || '';
}

async function run() {
  const fileArg = firstFileArg();
  if (!fileArg) {
    throw new Error('Provide a backup JSON file path. Example: npm run users:import -- backups/users/users-export-20260405T020000Z.json');
  }
  const filePath = path.resolve(fileArg);
  const apply = process.argv.includes('--apply');
  const payload = loadUsersBackupFile(filePath);
  const pool = createPoolFromEnv();
  try {
    let preImportBackup = null;
    if (apply) {
      preImportBackup = await createValidatedUsersBackup(pool, {
        outDir: path.join(process.cwd(), 'backups', 'users', 'restore-guard'),
        prefix: 'before-users-import',
        stamp: compactTimestamp(),
      });
      if (!preImportBackup.ok) {
        throw new Error(`Pre-import backup validation failed: ${preImportBackup.validation.errors.join('; ')}`);
      }
    }
    const report = await importUsersBackup(pool, payload, { apply });
    if (preImportBackup) {
      report.preImportBackup = {
        exportedAt: preImportBackup.snapshot.exportedAt,
        counts: preImportBackup.snapshot.counts,
        files: preImportBackup.files,
        validation: preImportBackup.validation,
      };
    }
    console.log(JSON.stringify(report, null, 2));
    if (report.summary.conflict > 0) {
      process.exitCode = 2;
    }
  } finally {
    await closePool(pool);
  }
}

run().catch((error) => {
  const message = String((error && error.message) || error || 'User import failed');
  console.error(`User import failed: ${message}`);
  process.exit(1);
});
