const fs = require('fs');
const path = require('path');

const { nowIso, toInt, normalizeIdentifier, normalizeEmail, normalizeWwid } = require('../lib.cjs');
const { createPoolFromEnv, closePool, readDb, withDb, logAudit } = require('../db.cjs');
const { databaseConnectionInfo, databaseLooksProductionLike } = require('../db-safety.cjs');
const { sanitizeCatalogPayload } = require('../domain.cjs');
const {
  buildCatalogScheduleSummary,
  buildRecoveryConfirmationToken,
  diffCatalogScheduleImpact,
  isPrimaryAdminUser,
} = require('../catalog-publish-guard.cjs');

const defaultRecoveryRoot = path.resolve(__dirname, '..', '..', 'backups', 'recovery');

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return '';
  return String(process.argv[index + 1] || '').trim();
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function csvValues(flag) {
  const raw = String(argValue(flag) || '').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
}

function deepClone(value, fallback = null) {
  if (value === undefined) return fallback;
  return JSON.parse(JSON.stringify(value));
}

function normalizeTarget(value) {
  return String(value || '').trim().toLowerCase() === 'published' ? 'published' : 'draft';
}

function findSnapshotHistoryVersion(state, version) {
  const history = state && state.snapshots && Array.isArray(state.snapshots.history) ? state.snapshots.history : [];
  return history.find((entry) => Number(entry && entry.version) === Number(version)) || null;
}

function summaryScheduledBrands(summary) {
  const brands = Array.isArray(summary && summary.brands) ? summary.brands : [];
  return brands
    .filter((brand) => Number(brand.scheduleSlotCount) > 0 || Number(brand.statusEntryCount) > 0)
    .map((brand) => ({
      id: String(brand.id || ''),
      name: String(brand.name || brand.id || ''),
      scheduleSlotCount: Number(brand.scheduleSlotCount) || 0,
      statusEntryCount: Number(brand.statusEntryCount) || 0,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function summarizeSnapshotEntry(entry) {
  const payload = entry && entry.payload && typeof entry.payload === 'object' ? entry.payload : {};
  const summary = buildCatalogScheduleSummary(payload);
  return {
    version: Math.max(1, toInt(entry && entry.version, toInt(payload && payload.meta && payload.meta.version, 1))),
    publishedAt: String((entry && entry.publishedAt) || (payload && payload.meta && payload.meta.publishedAt) || ''),
    counts: summary.counts,
    scheduledBrands: summaryScheduledBrands(summary),
  };
}

function assertExpectations(snapshotSummary) {
  const expectedTotalSlots = toInt(argValue('--expect-total-slots'), 0);
  const expectedBrandCount = toInt(argValue('--expect-scheduled-brand-count'), 0);
  const expectedBrandIds = csvValues('--expect-brand-ids');
  const actualBrandIds = new Set(
    (snapshotSummary && Array.isArray(snapshotSummary.scheduledBrands) ? snapshotSummary.scheduledBrands : []).map((brand) =>
      String(brand.id || ''),
    ),
  );
  const errors = [];

  if (expectedTotalSlots > 0 && Number(snapshotSummary && snapshotSummary.counts && snapshotSummary.counts.totalScheduleSlots) !== expectedTotalSlots) {
    errors.push(`Expected ${expectedTotalSlots} total schedule slots, found ${Number(snapshotSummary && snapshotSummary.counts && snapshotSummary.counts.totalScheduleSlots) || 0}.`);
  }
  if (expectedBrandCount > 0 && Number(snapshotSummary && snapshotSummary.counts && snapshotSummary.counts.scheduledBrandCount) !== expectedBrandCount) {
    errors.push(`Expected ${expectedBrandCount} scheduled brands, found ${Number(snapshotSummary && snapshotSummary.counts && snapshotSummary.counts.scheduledBrandCount) || 0}.`);
  }
  if (expectedBrandIds.length) {
    const missingIds = expectedBrandIds.filter((brandId) => !actualBrandIds.has(brandId));
    const unexpectedIds = Array.from(actualBrandIds).filter((brandId) => !expectedBrandIds.includes(brandId));
    if (missingIds.length) errors.push(`Missing expected scheduled brand ids: ${missingIds.join(', ')}`);
    if (unexpectedIds.length) errors.push(`Found unexpected scheduled brand ids: ${unexpectedIds.join(', ')}`);
  }
  return errors;
}

function requireDatabaseUrl() {
  const connectionString = String(process.env.DATABASE_URL || '').trim();
  if (!connectionString) {
    throw new Error('DATABASE_URL is required for catalog snapshot recovery. This task environment is missing required secrets.');
  }
  return connectionString;
}

function resolveActorUser(state, options = {}) {
  const users = Array.isArray(state && state.users) ? state.users : [];
  const actorUserId = String(options.actorUserId || '').trim();
  const actorIdentifier = normalizeIdentifier(options.actorIdentifier || '');
  if (!actorUserId && !actorIdentifier) return null;
  return (
    users.find((user) => {
      const row = user && typeof user === 'object' ? user : {};
      if (actorUserId && String(row.id || '').trim() === actorUserId) return true;
      if (!actorIdentifier) return false;
      const identifiers = [
        normalizeWwid(row.wwid),
        normalizeEmail(row.email),
        normalizeIdentifier(row.email),
        normalizeIdentifier(row.wwid),
      ].filter(Boolean);
      return identifiers.includes(actorIdentifier);
    }) || null
  );
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function latestRecoveryPackage(baseDir = defaultRecoveryRoot) {
  const root = path.resolve(baseDir);
  if (!fs.existsSync(root)) return '';
  const entries = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('recovery-package-'))
    .map((entry) => ({
      fullPath: path.join(root, entry.name),
      mtimeMs: fs.statSync(path.join(root, entry.name)).mtimeMs,
    }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  return entries[0] ? entries[0].fullPath : '';
}

function resolveRecoveryPackageDir(input, baseDir = defaultRecoveryRoot) {
  const candidate = String(input || '').trim();
  const fallback = candidate ? candidate : latestRecoveryPackage(baseDir);
  const resolved = fallback ? path.resolve(fallback) : '';
  if (!resolved) {
    throw new Error('Provide a recovery package directory or export one first.');
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`Recovery package directory not found: ${resolved}`);
  }
  return resolved;
}

function loadBackupPackageInfo(input) {
  const packageDir = resolveRecoveryPackageDir(input);
  const manifestPath = path.join(packageDir, 'manifest', 'recovery-package.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Recovery package manifest not found: ${manifestPath}`);
  }
  const manifest = readJson(manifestPath);
  return {
    packageDir,
    packageId: String((manifest && manifest.packageId) || ''),
    exportedAt: String((manifest && manifest.generatedAt) || ''),
  };
}

async function applyRestore(pool, state, options) {
  const sourceVersion = Math.max(1, toInt(options.sourceVersion, 0));
  const target = normalizeTarget(options.target);
  const actor = resolveActorUser(state, options);
  if (!actor) {
    throw new Error('Provide --actor-user-id or --actor-identifier for a Primary Admin before applying a restore.');
  }
  if (!isPrimaryAdminUser(actor)) {
    throw new Error(`Restore mode is limited to Primary Admin accounts. "${String(actor.displayName || actor.id || 'unknown-user')}" is not eligible.`);
  }

  const expectedConfirmationToken = buildRecoveryConfirmationToken(sourceVersion, target);
  const confirmationToken = String(options.confirmation || '').trim();
  if (confirmationToken !== expectedConfirmationToken) {
    throw new Error(`Restore confirmation token mismatch. Re-run with --confirm ${expectedConfirmationToken}.`);
  }

  if (!String(options.backupPackageDir || '').trim()) {
    throw new Error('Provide --backup-package-dir <path> before applying a restore so the current recovery export is explicit.');
  }
  const backupInfo = loadBackupPackageInfo(options.backupPackageDir);
  const sourceSnapshot = findSnapshotHistoryVersion(state, sourceVersion);
  if (!(sourceSnapshot && sourceSnapshot.payload)) {
    throw new Error(`Snapshot version ${sourceVersion} was not found.`);
  }

  const currentPublished = state && state.snapshots && state.snapshots.published ? state.snapshots.published : null;
  const currentPayload = currentPublished && currentPublished.payload && typeof currentPublished.payload === 'object' ? currentPublished.payload : {};
  const restoredPayload = sanitizeCatalogPayload(deepClone(sourceSnapshot.payload, {}));
  const recoveryImpact = diffCatalogScheduleImpact(currentPayload, restoredPayload);
  const previousPublishedVersion = Math.max(1, toInt(currentPublished && currentPublished.version, 0));
  const scheduleCounts = {
    before: recoveryImpact.before,
    after: recoveryImpact.after,
  };

  const result = await withDb(pool, async (db) => {
    if (!db.snapshots || typeof db.snapshots !== 'object') db.snapshots = {};
    const auditDetails = {
      recoveryMode: true,
      sourceVersion,
      previousPublishedVersion,
      scheduleCounts,
      affectedBrands: recoveryImpact.affectedBrands,
      backupPackageDir: backupInfo.packageDir,
      backupPackageId: backupInfo.packageId,
      target,
    };

    if (target === 'draft') {
      db.snapshots.draft = {
        updatedAt: nowIso(),
        updatedByUserId: actor.id,
        payload: restoredPayload,
      };
      logAudit(db, {
        action: 'catalog.restore_snapshot_draft',
        actorUserId: actor.id,
        actorName: actor.displayName,
        targetType: 'snapshot_draft',
        targetId: 'draft',
        details: auditDetails,
      });
      return {
        ok: true,
        target,
        sourceVersion,
        previousPublishedVersion,
        restoredVersion: previousPublishedVersion,
        scheduleCounts,
        affectedBrands: recoveryImpact.affectedBrands,
        backup: backupInfo,
      };
    }

    const nextVersion = Math.max(1, previousPublishedVersion + 1);
    const stamp = nowIso();
    restoredPayload.meta = restoredPayload.meta && typeof restoredPayload.meta === 'object' ? restoredPayload.meta : {};
    restoredPayload.meta.version = nextVersion;
    restoredPayload.meta.publishedAt = stamp;
    restoredPayload.meta.updatedAt = stamp;
    const publishedPayload = sanitizeCatalogPayload(deepClone(restoredPayload, {}));
    const draftPayload = sanitizeCatalogPayload(deepClone(restoredPayload, {}));
    db.snapshots.published = {
      version: nextVersion,
      publishedAt: stamp,
      updatedAt: stamp,
      publishedByUserId: actor.id,
      payload: publishedPayload,
    };
    if (!Array.isArray(db.snapshots.history)) db.snapshots.history = [];
    db.snapshots.history.push(db.snapshots.published);
    db.snapshots.draft = {
      updatedAt: stamp,
      updatedByUserId: actor.id,
      payload: draftPayload,
    };
    logAudit(db, {
      action: 'catalog.restore_snapshot_publish',
      actorUserId: actor.id,
      actorName: actor.displayName,
      targetType: 'snapshot',
      targetId: String(nextVersion),
      details: {
        ...auditDetails,
        restoredVersion: nextVersion,
        publishedAt: stamp,
      },
    });
    return {
      ok: true,
      target,
      sourceVersion,
      previousPublishedVersion,
      restoredVersion: nextVersion,
      publishedAt: stamp,
      scheduleCounts,
      affectedBrands: recoveryImpact.affectedBrands,
      backup: backupInfo,
    };
  });

  return {
    actor: {
      id: String(actor.id || ''),
      displayName: String(actor.displayName || ''),
      wwid: String(actor.wwid || ''),
    },
    ...result,
  };
}

async function run() {
  requireDatabaseUrl();
  const sourceVersion = Math.max(1, toInt(argValue('--source-version') || argValue('--version'), 0));
  if (sourceVersion <= 0) {
    throw new Error('Provide --source-version <number>.');
  }
  const target = normalizeTarget(argValue('--target') || 'draft');
  const apply = hasFlag('--apply');
  const info = databaseConnectionInfo();
  const productionLike = databaseLooksProductionLike();
  const pool = createPoolFromEnv();
  try {
    const beforeState = await readDb(pool);
    const sourceSnapshot = findSnapshotHistoryVersion(beforeState, sourceVersion);
    if (!(sourceSnapshot && sourceSnapshot.payload)) {
      throw new Error(`Snapshot version ${sourceVersion} was not found in snapshot_history.`);
    }

    const currentPublished = beforeState && beforeState.snapshots && beforeState.snapshots.published ? beforeState.snapshots.published : null;
    const sourceSummary = summarizeSnapshotEntry(sourceSnapshot);
    const currentSummary = summarizeSnapshotEntry(currentPublished || {});
    const impact = diffCatalogScheduleImpact(
      currentPublished && currentPublished.payload && typeof currentPublished.payload === 'object' ? currentPublished.payload : {},
      sourceSnapshot.payload,
    );
    const expectationErrors = assertExpectations(sourceSummary);

    const report = {
      ok: expectationErrors.length === 0,
      dryRun: !apply,
      target,
      sourceSnapshot: sourceSummary,
      currentPublished: currentSummary,
      impact: {
        before: impact.before,
        after: impact.after,
        affectedBrands: impact.affectedBrands,
      },
      database: {
        host: info.host,
        ssl: !!info.ssl,
        nodeEnv: info.nodeEnv,
        productionLike,
      },
      verificationErrors: expectationErrors,
      expectedConfirmationToken: buildRecoveryConfirmationToken(sourceVersion, target),
      generatedAt: nowIso(),
    };

    if (!apply) {
      console.log(JSON.stringify(report, null, 2));
      if (expectationErrors.length) process.exitCode = 1;
      return;
    }

    const applied = await applyRestore(pool, beforeState, {
      sourceVersion,
      target,
      confirmation: argValue('--confirm'),
      backupPackageDir: argValue('--backup-package-dir'),
      actorUserId: argValue('--actor-user-id'),
      actorIdentifier: argValue('--actor-identifier'),
    });
    const afterState = await readDb(pool);
    const afterTargetSnapshot =
      target === 'published'
        ? afterState && afterState.snapshots ? afterState.snapshots.published : null
        : afterState && afterState.snapshots ? afterState.snapshots.draft : null;

    console.log(
      JSON.stringify(
        {
          ...report,
          ok: expectationErrors.length === 0 && !!(applied && applied.ok),
          dryRun: false,
          applied,
          afterTarget: summarizeSnapshotEntry(
            target === 'published'
              ? afterTargetSnapshot
              : {
                  version: sourceVersion,
                  payload: afterTargetSnapshot && afterTargetSnapshot.payload,
                  publishedAt: afterTargetSnapshot && afterTargetSnapshot.updatedAt,
                },
          ),
        },
        null,
        2,
      ),
    );
  } finally {
    await closePool(pool);
  }
}

run().catch((error) => {
  const message = String((error && error.message) || error || 'Catalog snapshot restore failed');
  console.error(`Catalog snapshot restore failed: ${message}`);
  process.exit(1);
});
