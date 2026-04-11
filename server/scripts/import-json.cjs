const fs = require('fs');
const path = require('path');
const {
  createPoolFromEnv,
  migrateDatabase,
  withDb,
  closePool,
} = require('../db.cjs');
const { compactTimestamp, createValidatedUsersBackup } = require('../backup-safety.cjs');
const { assertDestructiveDbWriteAllowed } = require('../db-safety.cjs');

function loadLegacyJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === 'object' ? parsed : {};
}

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return '';
  return String(process.argv[idx + 1] || '').trim();
}

function firstPositionalArg() {
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const value = String(args[index] || '').trim();
    if (!value) continue;
    if (value === '--confirm') {
      index += 1;
      continue;
    }
    if (value.startsWith('--')) continue;
    return value;
  }
  return '';
}

async function run() {
  const fileArg = firstPositionalArg() || String(process.env.LEGACY_DB_JSON_PATH || '').trim();
  if (!fileArg) {
    throw new Error('Refusing db:import-json without an explicit legacy JSON file path.');
  }
  const guard = assertDestructiveDbWriteAllowed('db:import-json', {
    confirmation: argValue('--confirm'),
  });
  const filePath = path.resolve(fileArg);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Legacy JSON file not found: ${filePath}`);
  }

  console.error('!!! LEGACY JSON IMPORT REQUESTED !!!');
  console.error(`Target host: ${guard.database.host || 'local-postgres'}`);
  console.error(`Input file: ${filePath}`);
  console.error('Scope: replace-style import of users, snapshots, bookings, booking_events, and audit data.');
  if (guard.database.productionLike) {
    console.error('Production-like target detected. Verified backup override acknowledged.');
  }

  const legacy = loadLegacyJson(filePath);
  const pool = createPoolFromEnv();
  try {
    const guardBackup = await createValidatedUsersBackup(pool, {
      outDir: 'backups/users/destructive-guard',
      prefix: 'before-db-import-json',
      stamp: compactTimestamp(),
    });
    if (!guardBackup.ok) {
      throw new Error(`Mandatory pre-import backup failed validation: ${guardBackup.validation.errors.join('; ')}`);
    }
    await migrateDatabase(pool);
    await withDb(pool, async (db) => {
      if (Array.isArray(legacy.users) && legacy.users.length) db.users = legacy.users;
      if (legacy.snapshots && typeof legacy.snapshots === 'object') db.snapshots = legacy.snapshots;
      if (Array.isArray(legacy.bookings)) db.bookings = legacy.bookings;
      if (Array.isArray(legacy.audit)) db.audit = legacy.audit;
      if (Array.isArray(legacy.bookingEvents)) db.bookingEvents = legacy.bookingEvents;
      if (!Array.isArray(db.bookingEvents)) db.bookingEvents = [];
    });
    console.log(`Legacy JSON imported into Postgres from ${filePath}. Backup: ${guardBackup.files.json}`);
  } finally {
    await closePool(pool);
  }
}

run().catch((error) => {
  const message = String((error && error.message) || error || 'Import failed');
  console.error(`Import failed: ${message}`);
  process.exit(1);
});
