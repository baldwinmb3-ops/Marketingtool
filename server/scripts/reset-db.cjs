const { createPoolFromEnv, migrateDatabase, seedDatabase, closePool } = require('../db.cjs');
const { compactTimestamp, createValidatedUsersBackup } = require('../backup-safety.cjs');
const { assertDestructiveDbWriteAllowed } = require('../db-safety.cjs');

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return '';
  return String(process.argv[idx + 1] || '').trim();
}

async function run() {
  const guard = assertDestructiveDbWriteAllowed('db:reset', {
    confirmation: argValue('--confirm'),
  });
  console.error('!!! DESTRUCTIVE DATABASE RESET REQUESTED !!!');
  console.error(`Target host: ${guard.database.host || 'local-postgres'}`);
  console.error('Scope: deletes sessions, users, snapshots, bookings, booking_events, audit_log, then reseeds.');
  if (guard.database.productionLike) {
    console.error('Production-like target detected. Verified backup override acknowledged.');
  }
  const pool = createPoolFromEnv();
  try {
    const guardBackup = await createValidatedUsersBackup(pool, {
      outDir: 'backups/users/destructive-guard',
      prefix: 'before-db-reset',
      stamp: compactTimestamp(),
    });
    if (!guardBackup.ok) {
      throw new Error(`Mandatory pre-reset backup failed validation: ${guardBackup.validation.errors.join('; ')}`);
    }
    await migrateDatabase(pool);
    await seedDatabase(pool, { force: true });
    console.log(`Database reset + seed complete. Backup: ${guardBackup.files.json}`);
  } finally {
    await closePool(pool);
  }
}

run().catch((error) => {
  const message = String((error && error.message) || error || 'DB reset failed');
  console.error(`DB reset failed: ${message}`);
  process.exit(1);
});
