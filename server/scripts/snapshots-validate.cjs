const path = require('path');

const { createPoolFromEnv, closePool } = require('../db.cjs');
const { buildSnapshotBackupPayload, loadSnapshotBackupFile, validateSnapshotBackupFile } = require('../snapshot-backup.cjs');

function firstFileArg() {
  return process.argv.slice(2).find((arg) => !String(arg || '').startsWith('--')) || '';
}

async function run() {
  const fileArg = firstFileArg();
  if (!fileArg) {
    throw new Error(
      'Provide a snapshot backup JSON file path. Example: npm run snapshots:validate -- backups/snapshots/snapshot-export-20260410T020000Z.published.json',
    );
  }

  const filePath = path.resolve(fileArg);
  const payload = loadSnapshotBackupFile(filePath);
  const dataset = String(payload && payload.dataset || '').trim();

  const pool = createPoolFromEnv();
  try {
    const expectedSnapshot = await buildSnapshotBackupPayload(pool, dataset);
    const report = validateSnapshotBackupFile(filePath, { expectedSnapshot });
    if (dataset === 'history') {
      report.liveSnapshot = {
        exists: expectedSnapshot.exists,
        summary: expectedSnapshot.summary,
        sampleEntries: expectedSnapshot.sampleEntries,
      };
    } else {
      report.liveSnapshot = {
        exists: expectedSnapshot.exists,
        metadata: expectedSnapshot.metadata,
        payloadHash: expectedSnapshot.payloadHash,
        payloadCounts: expectedSnapshot.payloadCounts,
      };
    }
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } finally {
    await closePool(pool);
  }
}

run().catch((error) => {
  const message = String((error && error.message) || error || 'Snapshot validation failed');
  console.error(`Snapshot validation failed: ${message}`);
  process.exit(1);
});
