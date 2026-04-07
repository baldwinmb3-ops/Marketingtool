const { createPoolFromEnv, migrateDatabase, seedDatabase, closePool } = require('../db.cjs');
const { compactTimestamp, createValidatedUsersBackup } = require('../backup-safety.cjs');
const { assertDestructiveDbWriteAllowed } = require('../db-safety.cjs');

const force = process.argv.includes('--force');

async function run() {
  if (force) {
    assertDestructiveDbWriteAllowed('db:seed --force');
  }
  const pool = createPoolFromEnv();
  try {
    let guardBackup = null;
    if (force) {
      guardBackup = await createValidatedUsersBackup(pool, {
        outDir: 'backups/users/destructive-guard',
        prefix: 'before-seed-force',
        stamp: compactTimestamp(),
      });
      if (!guardBackup.ok) {
        throw new Error(`Mandatory pre-seed backup failed validation: ${guardBackup.validation.errors.join('; ')}`);
      }
    }
    await migrateDatabase(pool);
    const seeded = await seedDatabase(pool, { force });
    if (seeded) {
      if (force && guardBackup) {
        console.log(`Postgres seed completed (force). Backup: ${guardBackup.files.json}`);
      } else {
        console.log('Postgres seed completed.');
      }
    } else {
      console.log('Postgres seed skipped (database already initialized).');
    }
  } finally {
    await closePool(pool);
  }
}

run().catch((error) => {
  const message = String((error && error.message) || error || 'Seed failed');
  console.error(`Seed failed: ${message}`);
  process.exit(1);
});
