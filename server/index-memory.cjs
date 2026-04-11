const { newDb } = require('pg-mem');

const { createApp } = require('./app.cjs');
const { closePool } = require('./db.cjs');
const { assertExplicitMemoryRuntimeAllowed } = require('./db-safety.cjs');

const port = Number.parseInt(String(process.env.API_PORT || process.env.PORT || '8790'), 10) || 8790;
const host = process.env.API_HOST || '0.0.0.0';

async function start() {
  assertExplicitMemoryRuntimeAllowed('backend:memory:start');
  const mem = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pgAdapter = mem.adapters.createPg();
  const pool = new pgAdapter.Pool();
  const runtimeInfo = {
    mode: 'memory-explicit',
    persistence: 'pg-mem (explicit non-durable demo mode)',
    degraded: true,
    durable: false,
    authoritative: false,
    operatorWarning:
      'EXPLICIT pg-mem runtime is active. This backend is non-durable and must not be mistaken for authoritative Postgres state.',
  };

  const { app } = await createApp({ db: pool, seedDatabase: true, runtimeInfo });

  const server = app.listen(port, host, () => {
    console.log('!!! EXPLICIT NON-DURABLE MEMORY BACKEND ACTIVE !!!');
    console.log(`Marketing tool memory backend running on http://${host}:${port}`);
    console.log(`Persistence: ${runtimeInfo.persistence}`);
    console.log(`Runtime mode: ${runtimeInfo.mode}`);
    console.log(`Warning: ${runtimeInfo.operatorWarning}`);
  });

  const shutdown = async () => {
    server.close(async () => {
      await closePool(pool);
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch((error) => {
  const message = String((error && error.message) || error || 'Memory backend boot failed');
  console.error(`Memory backend boot failed: ${message}`);
  process.exit(1);
});
