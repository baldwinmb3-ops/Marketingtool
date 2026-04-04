const { createApp } = require('./app.cjs');
const { closePool } = require('./db.cjs');

const port = Number.parseInt(String(process.env.API_PORT || process.env.PORT || '8787'), 10) || 8787;
const host = process.env.API_HOST || '0.0.0.0';

function parseBootFallbackSetting(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (['1', 'true', 'yes', 'y', 'on', 'always'].includes(raw)) return true;
  if (['0', 'false', 'no', 'n', 'off', 'never'].includes(raw)) return false;
  return null;
}

function isRecoverableDatabaseBootFailure(error) {
  const message = String((error && (error.stack || error.message)) || error || '').toLowerCase();
  return [
    'exceeded the data transfer quota',
    'too many connections',
    'remaining connection slots are reserved',
    'connection terminated unexpectedly',
    'connection timeout',
    'connect timeout',
    'timed out',
    'timeout expired',
    'econnrefused',
    'enotfound',
    'econnreset',
    'etimedout',
    'server closed the connection unexpectedly',
    'the database system is starting up',
  ].some((fragment) => message.includes(fragment));
}

function shouldUseMemoryFallback(error) {
  const configured = parseBootFallbackSetting(process.env.APP_BOOT_MEMORY_FALLBACK);
  if (configured !== null) return configured;
  return isRecoverableDatabaseBootFailure(error);
}

function createMemoryFallbackPool() {
  const { newDb } = require('pg-mem');
  const mem = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pgAdapter = mem.adapters.createPg();
  return new pgAdapter.Pool();
}

async function createBootTarget() {
  const primaryRuntime = {
    mode: 'postgres',
    persistence: 'Postgres',
    degraded: false,
  };
  try {
    const { app, db } = await createApp({ runtimeInfo: primaryRuntime });
    return { app, db, runtimeInfo: primaryRuntime };
  } catch (error) {
    if (!shouldUseMemoryFallback(error)) throw error;
    const reason = String((error && error.message) || error || 'Database boot failed');
    const fallbackRuntime = {
      mode: 'memory-fallback',
      persistence: 'pg-mem (boot fallback, non-durable)',
      degraded: true,
      reason,
      fallbackTriggeredAt: new Date().toISOString(),
    };
    console.error(`Primary database boot failed, starting memory fallback: ${reason}`);
    const db = createMemoryFallbackPool();
    const { app } = await createApp({ db, seedDatabase: true, runtimeInfo: fallbackRuntime });
    return { app, db, runtimeInfo: fallbackRuntime };
  }
}

async function start() {
  const { app, db, runtimeInfo } = await createBootTarget();
  const server = app.listen(port, host, () => {
    console.log(`Marketing tool backend running on http://${host}:${port}`);
    console.log(`Persistence: ${runtimeInfo.persistence}`);
    if (runtimeInfo.degraded) {
      console.log(`Runtime mode: ${runtimeInfo.mode}`);
      console.log(`Fallback triggered at: ${runtimeInfo.fallbackTriggeredAt}`);
      console.log(`Fallback reason: ${runtimeInfo.reason}`);
    }
  });

  const shutdown = async () => {
    server.close(async () => {
      await closePool(db);
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch((error) => {
  const message = String((error && error.message) || error || 'Backend boot failed');
  console.error(`Backend boot failed: ${message}`);
  process.exit(1);
});
