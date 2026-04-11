const path = require('path');

const { createPoolFromEnv, closePool } = require('../db.cjs');
const { compactTimestamp, createValidatedBookingsBackup } = require('../bookings-backup.cjs');

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return '';
  return String(process.argv[idx + 1] || '').trim();
}

async function run() {
  const outDir = path.resolve(argValue('--out-dir') || path.join(process.cwd(), 'backups', 'bookings'));
  const prefix = String(argValue('--prefix') || 'bookings-export').trim() || 'bookings-export';
  const stamp = compactTimestamp();

  const pool = createPoolFromEnv();
  try {
    const backup = await createValidatedBookingsBackup(pool, {
      outDir,
      prefix,
      stamp,
    });
    if (!backup.ok) {
      throw new Error(`Bookings backup validation failed: ${backup.validation.errors.join('; ')}`);
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          exportedAt: backup.backup.exportedAt,
          summary: backup.backup.summary,
          sampleBookings: backup.backup.sampleBookings,
          files: backup.files,
          validation: {
            ok: backup.validation.ok,
            validatedAt: backup.validation.validatedAt,
            comparison: backup.validation.comparison,
            integrity: backup.validation.integrity,
          },
          prunedFiles: backup.prunedFiles,
        },
        null,
        2,
      ),
    );
  } finally {
    await closePool(pool);
  }
}

run().catch((error) => {
  const message = String((error && error.message) || error || 'Bookings export failed');
  console.error(`Bookings export failed: ${message}`);
  process.exit(1);
});
