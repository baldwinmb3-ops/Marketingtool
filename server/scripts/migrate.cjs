const { createPoolFromEnv, migrateDatabase, closePool } = require('../db.cjs');

async function run() {
  const pool = createPoolFromEnv();
  try {
    await migrateDatabase(pool);
    console.log('Postgres migration completed.');
  } finally {
    await closePool(pool);
  }
}

run().catch((error) => {
  const message = String((error && error.message) || error || 'Migration failed');
  console.error(`Migration failed: ${message}`);
  process.exit(1);
});
