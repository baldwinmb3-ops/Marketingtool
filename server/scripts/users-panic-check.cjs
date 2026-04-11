const path = require('path');
const { execFileSync } = require('child_process');

const { latestValidatedBackup } = require('../backup-safety.cjs');

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return '';
  return String(process.argv[idx + 1] || '').trim();
}

function staleHours() {
  const raw = Number.parseInt(String(process.env.APP_USER_BACKUP_STALE_HOURS || '24').trim(), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 24;
}

function readAudit(profileDir, backendBaseUrl) {
  const scriptPath = path.resolve(process.cwd(), 'scripts', 'audit-user-durability.mjs');
  const args = [scriptPath, '--browser-profile', profileDir];
  if (backendBaseUrl) {
    args.push('--backend-base-url', backendBaseUrl);
  }
  const raw = execFileSync(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(raw);
}

function buildBackupSummary(latest) {
  if (!latest) {
    return {
      exists: false,
      stale: true,
      warning: 'No validated user backup was found under backups/users.',
    };
  }
  const timestamp = String(latest.validatedAt || latest.exportedAt || '').trim();
  const ageMs = timestamp ? Date.now() - new Date(timestamp).getTime() : Number.POSITIVE_INFINITY;
  const maxAgeMs = staleHours() * 60 * 60 * 1000;
  return {
    exists: true,
    file: latest.jsonPath,
    validationFile: latest.validationPath,
    exportedAt: latest.exportedAt,
    validatedAt: latest.validatedAt,
    counts: latest.counts,
    stale: !(ageMs >= 0) || ageMs > maxAgeMs,
    ageHours: Number.isFinite(ageMs) ? Number((ageMs / (60 * 60 * 1000)).toFixed(2)) : null,
    staleThresholdHours: staleHours(),
  };
}

async function run() {
  const browserProfile = path.resolve(argValue('--browser-profile') || '.tmp_chrome_profile_live');
  const backendBaseUrl = String(argValue('--backend-base-url') || process.env.RELEASE_BACKEND_BASE_URL || '').trim();
  const audit = readAudit(browserProfile, backendBaseUrl);
  const latestBackup = buildBackupSummary(latestValidatedBackup(path.join(process.cwd(), 'backups', 'users')));
  const result = {
    ok: audit && latestBackup.exists && !latestBackup.stale,
    checkedAt: new Date().toISOString(),
    totals: {
      active: audit.summary.persistedActive,
      inactive: audit.summary.persistedInactive,
      deleted: audit.summary.persistedDeleted,
      total: audit.postgres.total,
    },
    classification: {
      persistedInDb: audit.classification.persistedInDb,
      localOnly: audit.classification.localOnly,
      queuedOnly: audit.classification.queuedOnly,
      pending: audit.summary.pending,
      persistedWithPending: audit.summary.persistedWithPending,
      dbOnly: audit.classification.dbOnly,
    },
    latestBackup,
  };
  if (!result.ok) {
    result.warning = latestBackup.exists
      ? latestBackup.stale
        ? `Latest backup is stale (${latestBackup.ageHours}h old). Run npm run users:backup now.`
        : 'Panic check found user-state drift.'
      : 'No validated backup found. Run npm run users:backup now.';
  }
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

run().catch((error) => {
  const message = String((error && error.message) || error || 'Panic check failed');
  console.error(`Panic check failed: ${message}`);
  process.exit(1);
});
