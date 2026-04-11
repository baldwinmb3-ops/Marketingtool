const fs = require('fs');
const path = require('path');

const { createPoolFromEnv, closePool } = require('../db.cjs');
const { compactTimestamp, createValidatedUsersBackup } = require('../backup-safety.cjs');
const { databaseConnectionInfo, databaseLooksProductionLike } = require('../db-safety.cjs');

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return '';
  return String(process.argv[idx + 1] || '').trim();
}

async function run() {
  const outDir = path.resolve(argValue('--out-dir') || path.join(process.cwd(), 'backups', 'users', 'predeploy'));
  const prefix = String(argValue('--prefix') || 'release-preflight').trim() || 'release-preflight';
  const stamp = compactTimestamp();
  fs.mkdirSync(outDir, { recursive: true });

  const pool = createPoolFromEnv();
  try {
    const backup = await createValidatedUsersBackup(pool, {
      outDir,
      prefix,
      stamp,
      dataLabel: 'users',
    });
    if (!backup.ok) {
      throw new Error(`Preflight backup validation failed: ${backup.validation.errors.join('; ')}`);
    }
    const reportPath = path.join(outDir, `${prefix}-${stamp}.report.json`);
    const connectionInfo = databaseConnectionInfo();
    const report = {
      ok: true,
      generatedAt: backup.snapshot.exportedAt,
      database: {
        host: connectionInfo.host,
        ssl: connectionInfo.ssl,
        nodeEnv: connectionInfo.nodeEnv,
        productionLike: databaseLooksProductionLike(),
      },
      counts: backup.snapshot.counts,
      samples: backup.snapshot.samples,
      files: {
        usersJson: backup.files.json,
        usersCsv: backup.files.csv,
        validation: backup.files.validation,
      },
      validation: backup.validation,
      prunedFiles: backup.prunedFiles,
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ ok: true, report: reportPath, counts: report.counts, samples: report.samples }, null, 2));
  } finally {
    await closePool(pool);
  }
}

run().catch((error) => {
  const message = String((error && error.message) || error || 'Release preflight failed');
  console.error(`Release preflight failed: ${message}`);
  process.exit(1);
});
