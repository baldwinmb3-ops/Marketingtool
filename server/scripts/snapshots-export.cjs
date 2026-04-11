const path = require('path');

const { createPoolFromEnv, closePool } = require('../db.cjs');
const { compactTimestamp, createValidatedSnapshotBackup } = require('../snapshot-backup.cjs');

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return '';
  return String(process.argv[idx + 1] || '').trim();
}

function normalizeDatasets(value) {
  const key = String(value || '').trim().toLowerCase();
  if (!key || key === 'all') return ['published', 'draft', 'history'];
  if (key === 'published' || key === 'draft' || key === 'history') return [key];
  throw new Error(`Unsupported dataset: ${String(value || '') || '(missing)'}`);
}

async function run() {
  const datasets = normalizeDatasets(argValue('--dataset') || 'all');
  const outDir = path.resolve(argValue('--out-dir') || path.join(process.cwd(), 'backups', 'snapshots'));
  const prefix = String(argValue('--prefix') || 'snapshot-export').trim() || 'snapshot-export';
  const stamp = compactTimestamp();

  const pool = createPoolFromEnv();
  try {
    const results = [];
    for (const dataset of datasets) {
      const backup = await createValidatedSnapshotBackup(pool, {
        outDir,
        prefix,
        stamp,
        dataset,
      });
      if (!backup.ok) {
        throw new Error(`${dataset} snapshot validation failed: ${backup.validation.errors.join('; ')}`);
      }
      const result = {
        dataset,
        exportedAt: backup.backup.exportedAt,
        exists: backup.backup.exists,
        files: backup.files,
        validation: {
          ok: backup.validation.ok,
          validatedAt: backup.validation.validatedAt,
        },
        prunedFiles: backup.prunedFiles,
      };
      if (dataset === 'history') {
        result.summary = backup.backup.summary;
        result.sampleEntries = backup.backup.sampleEntries;
      } else {
        result.metadata = backup.backup.metadata;
        result.payloadCounts = backup.backup.payloadCounts;
      }
      results.push(result);
    }
    console.log(JSON.stringify({ ok: true, datasets: results }, null, 2));
  } finally {
    await closePool(pool);
  }
}

run().catch((error) => {
  const message = String((error && error.message) || error || 'Snapshot export failed');
  console.error(`Snapshot export failed: ${message}`);
  process.exit(1);
});
