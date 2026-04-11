const { createApp } = require('./app.cjs');
const { closePool } = require('./db.cjs');
const { databaseConnectionInfo, databaseLooksProductionLike, isRecoverableDatabaseBootFailure, shouldUseMemoryFallback } = require('./db-safety.cjs');

const port = Number.parseInt(String(process.env.API_PORT || process.env.PORT || '8787'), 10) || 8787;
const host = process.env.API_HOST || '0.0.0.0';

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
    durable: true,
    authoritative: true,
  };
  try {
    const { app, db } = await createApp({ runtimeInfo: primaryRuntime });
    return { app, db, runtimeInfo: primaryRuntime };
  } catch (error) {
    if (databaseLooksProductionLike() && isRecoverableDatabaseBootFailure(error)) {
      if (!shouldUseMemoryFallback(error)) {
        const info = databaseConnectionInfo();
        throw new Error(
          `Primary database boot failed for production-like host ${info.host || 'unknown-host'}, and non-durable memory fallback is disabled by default. ` +
            `Set APP_BOOT_MEMORY_FALLBACK=true only for explicit emergency diagnostics.`,
        );
      }
    }
    if (!shouldUseMemoryFallback(error)) throw error;
    const reason = String((error && error.message) || error || 'Database boot failed');
    const fallbackRuntime = {
      mode: 'memory-fallback',
      persistence: 'pg-mem (boot fallback, non-durable)',
      degraded: true,
      durable: false,
      authoritative: false,
      reason,
      fallbackTriggeredAt: new Date().toISOString(),
      operatorWarning:
        'NON-DURABLE pg-mem boot fallback is active. This runtime is not authoritative production truth and must not be used for destructive or restore decisions.',
    };
    console.error('!!! NON-DURABLE MEMORY FALLBACK ACTIVE !!!');
    console.error(`Primary database boot failed, starting memory fallback: ${reason}`);
    console.error('This backend is NOT authoritative Postgres state.');
    console.error('Do not run restore/import/reset/seed decisions against this runtime.');
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
    if (runtimeInfo.degraded || runtimeInfo.authoritative === false) {
      console.log('Operator warning: this runtime is non-durable and non-authoritative.');
      console.log(`Runtime mode: ${runtimeInfo.mode}`);
      if (runtimeInfo.fallbackTriggeredAt) console.log(`Fallback triggered at: ${runtimeInfo.fallbackTriggeredAt}`);
      if (runtimeInfo.reason) console.log(`Fallback reason: ${runtimeInfo.reason}`);
      if (runtimeInfo.operatorWarning) console.log(`Warning: ${runtimeInfo.operatorWarning}`);
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
