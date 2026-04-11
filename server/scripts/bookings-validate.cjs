const path = require('path');

const { createPoolFromEnv, closePool } = require('../db.cjs');
const { buildBookingsBackupPayload, validateBookingsBackupFile } = require('../bookings-backup.cjs');

function firstFileArg() {
  return process.argv.slice(2).find((arg) => !String(arg || '').startsWith('--')) || '';
}

async function run() {
  const fileArg = firstFileArg();
  if (!fileArg) {
    throw new Error('Provide a bookings backup JSON file path. Example: npm run bookings:validate -- backups/bookings/bookings-export-20260410T020000000Z.json');
  }

  const filePath = path.resolve(fileArg);
  const pool = createPoolFromEnv();
  try {
    const expectedSnapshot = await buildBookingsBackupPayload(pool);
    const report = validateBookingsBackupFile(filePath, { expectedSnapshot });
    report.liveBookings = {
      summary: expectedSnapshot.summary,
      sampleBookings: expectedSnapshot.sampleBookings,
    };
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } finally {
    await closePool(pool);
  }
}

run().catch((error) => {
  const message = String((error && error.message) || error || 'Bookings validation failed');
  console.error(`Bookings validation failed: ${message}`);
  process.exit(1);
});
