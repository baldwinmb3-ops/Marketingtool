const fs = require('fs');
const path = require('path');

const { createPoolFromEnv, closePool } = require('../db.cjs');
const { validateUsersBackupFile } = require('../backup-safety.cjs');

function firstFileArg() {
  return process.argv.slice(2).find((arg) => !String(arg || '').startsWith('--')) || '';
}

async function maybeLoadLiveCounts(pool) {
  const client = await pool.connect();
  try {
    const total = await client.query('SELECT COUNT(*)::int AS count FROM users');
    const byStatus = await client.query('SELECT status, COUNT(*)::int AS count FROM users GROUP BY status ORDER BY status');
    const counts = {
      total: Number(total.rows[0] && total.rows[0].count) || 0,
      active: 0,
      inactive: 0,
      deleted: 0,
    };
    byStatus.rows.forEach((row) => {
      const status = String(row.status || '').trim().toLowerCase();
      counts[status] = Number(row.count) || 0;
    });
    return counts;
  } finally {
    client.release();
  }
}

async function run() {
  const fileArg = firstFileArg();
  if (!fileArg) {
    throw new Error('Provide a backup JSON file path. Example: npm run users:validate -- backups/users/users-export-20260405T020000Z.json');
  }
  const filePath = path.resolve(fileArg);
  const companionCsv = filePath.endsWith('.json') ? filePath.replace(/\.json$/i, '.csv') : '';
  const pool = createPoolFromEnv();
  try {
    const liveCounts = await maybeLoadLiveCounts(pool);
    const report = validateUsersBackupFile(filePath, {
      expectedCounts: liveCounts,
      csvPath: companionCsv && fs.existsSync(companionCsv) ? companionCsv : '',
    });
    report.liveCounts = liveCounts;
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } finally {
    await closePool(pool);
  }
}

run().catch((error) => {
  const message = String((error && error.message) || error || 'User backup validation failed');
  console.error(`User backup validation failed: ${message}`);
  process.exit(1);
});
