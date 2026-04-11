const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const { destructiveActionConfirmationToken, shouldUseMemoryFallback } = require('../db-safety.cjs');

const rootDir = path.join(__dirname, '..', '..');

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

function runNode(relativePath, args = [], env = {}) {
  return spawnSync(process.execPath, [path.join(rootDir, relativePath), ...args], {
    cwd: rootDir,
    env: Object.assign({}, process.env, env),
    encoding: 'utf8',
    timeout: 15000,
  });
}

test('db:reset requires an exact destructive confirmation token', () => {
  const result = runNode('server/scripts/reset-db.cjs', [], {
    DATABASE_URL: 'postgres://user:pass@prod.example.com/marketingtool',
    APP_DB_SSL: 'true',
    APP_ALLOW_DESTRUCTIVE_DB_RESET: 'YES_I_HAVE_A_BACKUP',
  });
  assert.equal(result.status, 1);
  assert.match(`${result.stderr}\n${result.stdout}`, new RegExp(destructiveActionConfirmationToken('db:reset')));
});

test('db:seed --force requires an exact destructive confirmation token', () => {
  const result = runNode('server/scripts/seed.cjs', ['--force'], {
    DATABASE_URL: 'postgres://user:pass@prod.example.com/marketingtool',
    APP_DB_SSL: 'true',
    APP_ALLOW_DESTRUCTIVE_DB_RESET: 'YES_I_HAVE_A_BACKUP',
  });
  assert.equal(result.status, 1);
  assert.match(`${result.stderr}\n${result.stdout}`, new RegExp(destructiveActionConfirmationToken('db:seed --force')));
});

test('db:import-json refuses to run without an explicit legacy file path', () => {
  const result = runNode('server/scripts/import-json.cjs', ['--confirm', destructiveActionConfirmationToken('db:import-json')], {
    LEGACY_DB_JSON_PATH: '',
  });
  assert.equal(result.status, 1);
  assert.match(`${result.stderr}\n${result.stdout}`, /explicit legacy JSON file path/i);
});

test('db:import-json requires an exact destructive confirmation token', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marketingtool-import-json-'));
  const filePath = path.join(tempDir, 'legacy.json');
  fs.writeFileSync(filePath, '{}\n', 'utf8');
  try {
    const result = runNode('server/scripts/import-json.cjs', [filePath], {
      DATABASE_URL: 'postgres://user:pass@prod.example.com/marketingtool',
      APP_DB_SSL: 'true',
      APP_ALLOW_DESTRUCTIVE_DB_RESET: 'YES_I_HAVE_A_BACKUP',
    });
    assert.equal(result.status, 1);
    assert.match(`${result.stderr}\n${result.stdout}`, new RegExp(destructiveActionConfirmationToken('db:import-json')));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('boot memory fallback stays disabled by default for production-like databases', async () => {
  await withEnv(
    {
      DATABASE_URL: 'postgres://user:pass@prod.example.com/marketingtool',
      APP_DB_SSL: 'true',
      APP_BOOT_MEMORY_FALLBACK: '',
    },
    async () => {
      assert.equal(shouldUseMemoryFallback(new Error('ECONNREFUSED')), false);
    },
  );
});

test('boot memory fallback still allows recoverable local dev fallback by default', async () => {
  await withEnv(
    {
      DATABASE_URL: 'postgres://user:pass@127.0.0.1:5432/marketingtool',
      APP_DB_SSL: '',
      APP_BOOT_MEMORY_FALLBACK: '',
    },
    async () => {
      assert.equal(shouldUseMemoryFallback(new Error('ECONNREFUSED')), true);
    },
  );
});

test('explicit memory backend refuses production-like startup without a non-durable override', () => {
  const result = runNode('server/index-memory.cjs', [], {
    DATABASE_URL: 'postgres://user:pass@prod.example.com/marketingtool',
    APP_DB_SSL: 'true',
    APP_ALLOW_EXPLICIT_MEMORY_ONLY_RUNTIME: '',
  });
  assert.equal(result.status, 1);
  assert.match(`${result.stderr}\n${result.stdout}`, /APP_ALLOW_EXPLICIT_MEMORY_ONLY_RUNTIME/i);
});
