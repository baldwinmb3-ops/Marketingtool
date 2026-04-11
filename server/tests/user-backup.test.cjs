const test = require('node:test');
const assert = require('node:assert/strict');
const { newDb } = require('pg-mem');

const { createApp } = require('../app.cjs');
const { closePool } = require('../db.cjs');
const { buildUsersBackupSnapshot, importUsersBackup } = require('../user-backup.cjs');

function withEnv(overrides, callback) {
  const keys = Object.keys(overrides || {});
  const previous = new Map();
  keys.forEach((key) => {
    previous.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    const nextValue = overrides[key];
    if (nextValue === undefined || nextValue === null) {
      delete process.env[key];
      return;
    }
    process.env[key] = String(nextValue);
  });
  return Promise.resolve()
    .then(callback)
    .finally(() => {
      keys.forEach((key) => {
        if (previous.get(key) === undefined) {
          delete process.env[key];
          return;
        }
        process.env[key] = previous.get(key);
      });
    });
}

function createPool() {
  const mem = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const adapter = mem.adapters.createPg();
  return new adapter.Pool();
}

test('user backup snapshot exports durable fields and sample users', async () => {
  const pool = createPool();
  try {
    await createApp({ db: pool, seedDatabase: true });
    const snapshot = await buildUsersBackupSnapshot(pool);
    assert.equal(snapshot.source, 'postgres.users');
    assert.equal(snapshot.counts.total >= 1, true);
    assert.equal(Array.isArray(snapshot.samples), true);
    assert.equal(Array.isArray(snapshot.users), true);
    assert.equal(typeof snapshot.users[0].passwordHash, 'string');
    assert.equal(snapshot.users[0].passwordHash.includes(':'), true);
    assert.equal(typeof snapshot.users[0].phone, 'string');
    const managerUser = snapshot.users.find((user) => user.canAccessManager);
    assert.ok(managerUser);
    assert.equal(typeof managerUser.managerTitle, 'string');
  } finally {
    await closePool(pool);
  }
});

test('user backup import dry-run and apply create and update records safely', async () => {
  const pool = createPool();
  try {
    await createApp({ db: pool, seedDatabase: true });
    const before = await buildUsersBackupSnapshot(pool);
    const existing = before.users.find((user) => user.wwid === 'MGR3001');
    assert.ok(existing);

    const payload = {
      users: [
        Object.assign({}, existing, {
          displayName: 'Manager All Access Updated',
          phone: '555-9999',
          managerTitle: 'Supervisor',
        }),
        {
          id: 'user-new-backup-1',
          displayName: 'Backup Added',
          firstName: 'Backup',
          lastName: 'Added',
          wwid: 'BKP1001',
          email: 'backup.added@example.com',
          phone: '555-1212',
          role: 'marketer',
          isAssistant: false,
          canAccessMarketer: false,
          canAccessAdmin: false,
          canAccessManager: true,
          managerTitle: 'Assistant Manager',
          managerOnly: true,
          departmentIds: ['manager-cat-hotels'],
          status: 'active',
          isLocked: false,
          passwordHash: existing.passwordHash,
          forcePasswordReset: false,
          createdAt: existing.createdAt,
          updatedAt: existing.updatedAt,
        },
      ],
    };

    const dryRun = await importUsersBackup(pool, payload, { apply: false });
    assert.equal(dryRun.summary.update, 1);
    assert.equal(dryRun.summary.create, 1);

    const afterDryRun = await buildUsersBackupSnapshot(pool);
    assert.equal(afterDryRun.users.some((user) => user.wwid === 'BKP1001'), false);
    assert.equal(afterDryRun.users.find((user) => user.wwid === 'MGR3001').displayName, existing.displayName);
    assert.equal(afterDryRun.users.find((user) => user.wwid === 'MGR3001').phone, existing.phone);
    assert.equal(afterDryRun.users.find((user) => user.wwid === 'MGR3001').managerTitle, existing.managerTitle);

    const applied = await importUsersBackup(pool, payload, { apply: true });
    assert.equal(applied.summary.update, 1);
    assert.equal(applied.summary.create, 1);

    const afterApply = await buildUsersBackupSnapshot(pool);
    const created = afterApply.users.find((user) => user.wwid === 'BKP1001');
    const updated = afterApply.users.find((user) => user.wwid === 'MGR3001');
    assert.ok(created);
    assert.ok(updated);
    assert.equal(updated.displayName, 'Manager All Access Updated');
    assert.equal(updated.phone, '555-9999');
    assert.equal(updated.managerTitle, 'Supervisor');
    assert.equal(created.phone, '555-1212');
    assert.equal(created.managerTitle, 'Assistant Manager');
    assert.equal(created.managerOnly, true);
  } finally {
    await closePool(pool);
  }
});

test('boot-time auto-seed is disabled when APP_DB_SEED_MODE=never', async () => {
  await withEnv({ APP_DB_SEED_MODE: 'never' }, async () => {
    const pool = createPool();
    try {
      await createApp({ db: pool });
      const snapshot = await buildUsersBackupSnapshot(pool);
      assert.equal(snapshot.counts.total, 0);
    } finally {
      await closePool(pool);
    }
  });
});
