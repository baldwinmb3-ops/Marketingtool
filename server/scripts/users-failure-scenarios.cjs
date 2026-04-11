const path = require('path');
const { newDb } = require('pg-mem');

const { migrateDatabase, closePool } = require('../db.cjs');
const { latestValidatedBackup } = require('../backup-safety.cjs');
const { loadUsersBackupFile, importUsersBackup, buildUsersBackupSnapshot } = require('../user-backup.cjs');

function firstFileArg() {
  return process.argv.slice(2).find((arg) => !String(arg || '').startsWith('--')) || '';
}

function createMemoryPool() {
  const mem = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const adapter = mem.adapters.createPg();
  return new adapter.Pool();
}

async function seedPoolFromBackup(pool, payload) {
  await migrateDatabase(pool);
  await importUsersBackup(pool, payload, { apply: true });
}

async function scenarioMissingUsers(payload) {
  const pool = createMemoryPool();
  try {
    await seedPoolFromBackup(pool, payload);
    const baseline = await buildUsersBackupSnapshot(pool);
    const removed = baseline.users.slice(0, 3).map((user) => ({ id: user.id, wwid: user.wwid, email: user.email }));
    const client = await pool.connect();
    try {
      for (const entry of removed) {
        await client.query('DELETE FROM users WHERE id = $1', [entry.id]);
      }
    } finally {
      client.release();
    }
    const afterDelete = await buildUsersBackupSnapshot(pool);
    const dryRun = await importUsersBackup(pool, payload, { apply: false });
    const applied = await importUsersBackup(pool, payload, { apply: true });
    const afterApply = await buildUsersBackupSnapshot(pool);
    return {
      removed,
      countsAfterDelete: afterDelete.counts,
      dryRunSummary: dryRun.summary,
      applySummary: applied.summary,
      recovered: afterApply.counts.total === baseline.counts.total,
      countsAfterApply: afterApply.counts,
    };
  } finally {
    await closePool(pool);
  }
}

async function scenarioPartialCorruption(payload) {
  const pool = createMemoryPool();
  try {
    await seedPoolFromBackup(pool, payload);
    const baseline = await buildUsersBackupSnapshot(pool);
    const targets = baseline.users.slice(0, 2);
    const client = await pool.connect();
    try {
      for (const target of targets) {
        await client.query(
          'UPDATE users SET display_name = $1, email = $2, updated_at = NOW() WHERE id = $3',
          [`CORRUPTED ${target.displayName}`, `corrupted+${target.email}`, target.id],
        );
      }
    } finally {
      client.release();
    }
    const dryRun = await importUsersBackup(pool, payload, { apply: false });
    const applied = await importUsersBackup(pool, payload, { apply: true });
    const afterApply = await buildUsersBackupSnapshot(pool);
    const corrected = targets.every((target) => {
      const row = afterApply.users.find((user) => user.id === target.id);
      return row && row.displayName === target.displayName && row.email === target.email;
    });
    return {
      targets: targets.map((target) => ({ id: target.id, email: target.email, displayName: target.displayName })),
      dryRunSummary: dryRun.summary,
      applySummary: applied.summary,
      corrected,
    };
  } finally {
    await closePool(pool);
  }
}

async function scenarioConflict(payload) {
  const pool = createMemoryPool();
  try {
    await seedPoolFromBackup(pool, payload);
    const baseline = await buildUsersBackupSnapshot(pool);
    const target = baseline.users[0];
    const other = baseline.users.find((row) => row.id !== target.id && row.email !== target.email);
    if (!other) {
      throw new Error('Need at least two distinct users to simulate an ambiguous restore conflict.');
    }
    const conflictPayload = Object.assign({}, payload, {
      users: (Array.isArray(payload && payload.users) ? payload.users : []).map((row) => {
        if (String((row && row.id) || '') !== String(target.id || '')) return row;
        return Object.assign({}, row, { email: other.email });
      }),
    });
    const dryRun = await importUsersBackup(pool, conflictPayload, { apply: false });
    const applied = await importUsersBackup(pool, conflictPayload, { apply: true });
    return {
      target: { id: target.id, wwid: target.wwid, email: target.email },
      conflictingExistingRow: { id: other.id, wwid: other.wwid, email: other.email },
      dryRunSummary: dryRun.summary,
      applySummary: applied.summary,
      conflicts: applied.conflicts,
      conflictDetected: applied.summary.conflict > 0,
    };
  } finally {
    await closePool(pool);
  }
}

async function run() {
  const fileArg = firstFileArg();
  const latest = latestValidatedBackup(path.join(process.cwd(), 'backups', 'users'));
  const filePath = path.resolve(fileArg || (latest && latest.jsonPath) || '');
  if (!filePath) {
    throw new Error('No backup file provided and no validated backup was found under backups/users.');
  }
  const payload = loadUsersBackupFile(filePath);
  const result = {
    ok: true,
    file: filePath,
    missingUsers: await scenarioMissingUsers(payload),
    partialCorruption: await scenarioPartialCorruption(payload),
    conflicts: await scenarioConflict(payload),
  };
  console.log(JSON.stringify(result, null, 2));
}

run().catch((error) => {
  const message = String((error && error.message) || error || 'Failure scenarios failed');
  console.error(`Failure scenarios failed: ${message}`);
  process.exit(1);
});
