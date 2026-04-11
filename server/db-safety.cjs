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

function destructiveActionConfirmationToken(action) {
  const key = String(action || 'destructive-db-write')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${key}:i-understand-this-destroys-data`;
}

function assertDestructiveActionConfirmed(action, confirmationValue) {
  const expected = destructiveActionConfirmationToken(action);
  const actual = String(confirmationValue || process.env.APP_DESTRUCTIVE_ACTION_CONFIRM || '').trim();
  if (actual === expected) {
    return { expected, actual };
  }
  throw new Error(
    `Refusing ${String(action || 'destructive-db-write')}. ` +
      `This command is destructive and requires an exact confirmation token. ` +
      `Re-run with --confirm ${expected}.`,
  );
}

function assertDestructiveDbWriteAllowed(action, options = {}) {
  const envName = String(options.envName || 'APP_ALLOW_DESTRUCTIVE_DB_RESET').trim() || 'APP_ALLOW_DESTRUCTIVE_DB_RESET';
  const confirmation = assertDestructiveActionConfirmed(action, options.confirmation);
  const info = databaseConnectionInfo();
  const productionLike = databaseLooksProductionLike();
  if (productionLike && !destructiveDbWriteOverrideAccepted(envName)) {
    throw new Error(
      `Refusing ${String(action || 'destructive-db-write')} against a production-like database (${info.host || 'unknown-host'}). ` +
        `Set ${envName}=YES_I_HAVE_A_BACKUP and re-run with --confirm ${confirmation.expected} only after taking a verified backup export.`,
    );
  }
  return {
    action: String(action || 'destructive-db-write').trim() || 'destructive-db-write',
    confirmation: confirmation.expected,
    database: {
      host: info.host,
      ssl: info.ssl,
      nodeEnv: info.nodeEnv,
      productionLike,
    },
  };
}

function explicitMemoryRuntimeOverrideAccepted(envName = 'APP_ALLOW_EXPLICIT_MEMORY_ONLY_RUNTIME') {
  return String(process.env[envName] || '').trim() === 'YES_I_UNDERSTAND_THIS_IS_NOT_DURABLE';
}

function assertExplicitMemoryRuntimeAllowed(action, envName = 'APP_ALLOW_EXPLICIT_MEMORY_ONLY_RUNTIME') {
  if (!databaseLooksProductionLike()) return;
  if (explicitMemoryRuntimeOverrideAccepted(envName)) return;
  const info = databaseConnectionInfo();
  throw new Error(
    `Refusing ${String(action || 'memory-runtime')} with a production-like database configuration (${info.host || 'unknown-host'}). ` +
      `This would start a non-durable pg-mem runtime that could be mistaken for authoritative Postgres. ` +
      `Set ${envName}=YES_I_UNDERSTAND_THIS_IS_NOT_DURABLE only for explicit emergency diagnostics.`,
  );
}

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

function shouldUseMemoryFallback(error, explicitValue = process.env.APP_BOOT_MEMORY_FALLBACK) {
  const configured = parseBootFallbackSetting(explicitValue);
  if (configured !== null) return configured;
  if (databaseLooksProductionLike()) return false;
  return isRecoverableDatabaseBootFailure(error);
}

module.exports = {
  buildConnectionStringFromEnv,
  databaseConnectionInfo,
  databaseLooksProductionLike,
  destructiveActionConfirmationToken,
  resolvedBootSeedMode,
  shouldSeedOnBoot,
  assertDestructiveActionConfirmed,
  assertDestructiveDbWriteAllowed,
  explicitMemoryRuntimeOverrideAccepted,
  assertExplicitMemoryRuntimeAllowed,
  parseBootFallbackSetting,
  isRecoverableDatabaseBootFailure,
  shouldUseMemoryFallback,
};
