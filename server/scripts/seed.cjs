const { createPoolFromEnv, migrateDatabase, seedDatabase, closePool } = require('../db.cjs');

const force = process.argv.includes('--force');

async function run() {
  const pool = createPoolFromEnv();
  try {
    await migrateDatabase(pool);
    const seeded = await seedDatabase(pool, { force });
    if (seeded) {
      console.log(force ? 'Postgres seed completed (force).' : 'Postgres seed completed.');
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
