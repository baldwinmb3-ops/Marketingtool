const { URL } = require('url');

function envBool(name, fallback = false) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return !!fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(raw)) return false;
  return !!fallback;
}

function buildConnectionStringFromEnv() {
  const host = process.env.PGHOST || '127.0.0.1';
  const port = Number.parseInt(String(process.env.PGPORT || '5432'), 10) || 5432;
  const user = process.env.PGUSER || 'postgres';
  const password = process.env.PGPASSWORD || 'postgres';
  const database = process.env.PGDATABASE || 'marketingtool';
  return (
    process.env.DATABASE_URL ||
    `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`
  );
}

function hostLooksLocal(hostname) {
  const host = String(hostname || '').trim().toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function parseConnectionHost(connectionString) {
  try {
    const parsed = new URL(String(connectionString || ''));
    return String(parsed.hostname || '').trim().toLowerCase();
  } catch {
    return '';
  }
}

function databaseConnectionInfo() {
  const connectionString = buildConnectionStringFromEnv();
  const host = parseConnectionHost(connectionString);
  const ssl = envBool('APP_DB_SSL', false) || envBool('DATABASE_SSL', false);
  const nodeEnv = String(process.env.NODE_ENV || '').trim().toLowerCase();
  return {
    connectionString,
    host,
    ssl,
    nodeEnv,
    isLocalHost: hostLooksLocal(host),
  };
}

function databaseLooksProductionLike() {
  const info = databaseConnectionInfo();
  return info.nodeEnv === 'production' || info.ssl || (!!info.host && !info.isLocalHost);
}

function normalizeSeedMode(value) {
  const key = String(value || '').trim().toLowerCase();
  if (key === 'never' || key === 'off' || key === 'false') return 'never';
  if (key === 'force' || key === 'always') return 'force';
  if (key === 'if-empty' || key === 'on' || key === 'true') return 'if-empty';
  return 'auto';
}

function resolvedBootSeedMode() {
  const mode = normalizeSeedMode(process.env.APP_DB_SEED_MODE || 'auto');
  if (mode !== 'auto') return mode;
  return databaseLooksProductionLike() ? 'never' : 'if-empty';
}

function shouldSeedOnBoot(explicitValue) {
  if (typeof explicitValue === 'boolean') return explicitValue;
  const mode = resolvedBootSeedMode();
  return mode === 'force' || mode === 'if-empty';
}

function destructiveDbWriteOverrideAccepted(envName = 'APP_ALLOW_DESTRUCTIVE_DB_RESET') {
  return String(process.env[envName] || '').trim() === 'YES_I_HAVE_A_BACKUP';
}

function assertDestructiveDbWriteAllowed(action, envName = 'APP_ALLOW_DESTRUCTIVE_DB_RESET') {
  if (!databaseLooksProductionLike()) return;
  if (destructiveDbWriteOverrideAccepted(envName)) return;
  throw new Error(
    `Refusing ${String(action || 'destructive-db-write')} against a production-like database. ` +
      `Set ${envName}=YES_I_HAVE_A_BACKUP only after taking a verified backup export.`,
  );
}

module.exports = {
  buildConnectionStringFromEnv,
  databaseConnectionInfo,
  databaseLooksProductionLike,
  resolvedBootSeedMode,
  shouldSeedOnBoot,
  assertDestructiveDbWriteAllowed,
};
