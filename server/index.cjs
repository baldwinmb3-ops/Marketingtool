const { createApp } = require('./app.cjs');
const { closePool } = require('./db.cjs');

const port = Number.parseInt(String(process.env.API_PORT || process.env.PORT || '8787'), 10) || 8787;
const host = process.env.API_HOST || '0.0.0.0';

async function start() {
  const { app, db } = await createApp();
  const server = app.listen(port, host, () => {
    console.log(`Marketing tool backend running on http://${host}:${port}`);
    console.log('Persistence: Postgres');
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
