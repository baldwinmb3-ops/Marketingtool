const fs = require('fs');
const path = require('path');

const { createPoolFromEnv, closePool } = require('../db.cjs');
const { createValidatedUsersBackup } = require('../backup-safety.cjs');

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return '';
  return String(process.argv[idx + 1] || '').trim();
}

function compactTimestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

async function run() {
  const outDir = path.resolve(argValue('--out-dir') || path.join(process.cwd(), 'backups', 'users'));
  const prefix = String(argValue('--prefix') || 'users-export').trim() || 'users-export';
  fs.mkdirSync(outDir, { recursive: true });

  const pool = createPoolFromEnv();
  try {
    const backup = await createValidatedUsersBackup(pool, {
      outDir,
      prefix,
      stamp: compactTimestamp(),
    });
    if (!backup.ok) {
      throw new Error(`Backup validation failed: ${backup.validation.errors.join('; ')}`);
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          exportedAt: backup.snapshot.exportedAt,
          counts: backup.snapshot.counts,
          files: backup.files,
          validation: {
            ok: backup.validation.ok,
            validatedAt: backup.validation.validatedAt,
            counts: backup.validation.counts,
            includes: backup.validation.includes,
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
  const message = String((error && error.message) || error || 'User export failed');
  console.error(`User export failed: ${message}`);
  process.exit(1);
});
