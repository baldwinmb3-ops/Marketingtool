const { toInt, normalizeRole, normalizeStatus } = require('./lib.cjs');

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAY_KEY_RE = /^[0-6]$/;
const SMOKE_PUBLISH_OVERRIDE_ENV = 'APP_ALLOW_SMOKE_PUBLISH';

const DESTRUCTIVE_PUBLISH_BLOCKED_CODE = 'DESTRUCTIVE_PUBLISH_BLOCKED';
const DESTRUCTIVE_PUBLISH_BLOCKED_MESSAGE =
  'Publish blocked because it would remove existing show dates/times. Use explicit restore mode if this is intentional disaster recovery.';
const PUBLISH_BASE_VERSION_REQUIRED_CODE = 'PUBLISH_BASE_VERSION_REQUIRED';
const PUBLISH_BASE_VERSION_REQUIRED_MESSAGE =
  'Publish blocked because the base catalog version is missing. Refresh cloud data and try again.';
const PUBLISH_BASE_VERSION_STALE_CODE = 'PUBLISH_BASE_VERSION_STALE';
const PUBLISH_BASE_VERSION_STALE_MESSAGE =
  'Publish blocked because your admin catalog is behind the live catalog. Refresh cloud data and try again.';
const PUBLISH_BASE_VERSION_INVALID_CODE = 'PUBLISH_BASE_VERSION_INVALID';
const PUBLISH_BASE_VERSION_INVALID_MESSAGE =
  'Publish blocked because the base catalog version is invalid. Refresh cloud data and try again.';
const SMOKE_PUBLISH_BLOCKED_CODE = 'SMOKE_PUBLISH_BLOCKED';
const SMOKE_PUBLISH_BLOCKED_MESSAGE =
  'Smoke-test admin accounts cannot publish the live catalog in production unless explicitly enabled.';

function normalizeDateKey(value) {
  const dateKey = String(value || '').trim();
  return DATE_KEY_RE.test(dateKey) ? dateKey : '';
}

function normalizeTimeKey(value) {
  return String(value || '').trim().slice(0, 40);
}

function normalizeWeekdayKey(value) {
  const dayKey = String(value || '').trim();
  return WEEKDAY_KEY_RE.test(dayKey) ? dayKey : '';
}

function normalizeStatusValue(value) {
  return String(value || '').trim().toLowerCase().slice(0, 40);
}

function uniqueSortedStrings(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).filter(Boolean))).sort();
}

function normalizeScheduleDates(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [rawDateKey, rawTimes] of Object.entries(src)) {
    const dateKey = normalizeDateKey(rawDateKey);
    if (!dateKey) continue;
    const cleanTimes = uniqueSortedStrings((Array.isArray(rawTimes) ? rawTimes : []).map(normalizeTimeKey));
    if (cleanTimes.length) out[dateKey] = cleanTimes;
  }
  return out;
}

function normalizeScheduleStatus(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [rawDateKey, rawRow] of Object.entries(src)) {
    const dateKey = normalizeDateKey(rawDateKey);
    if (!dateKey) continue;
    const row = rawRow && typeof rawRow === 'object' && !Array.isArray(rawRow) ? rawRow : {};
    const cleanRow = {};
    for (const [rawTimeKey, rawStatus] of Object.entries(row)) {
      const timeKey = normalizeTimeKey(rawTimeKey);
      const status = normalizeStatusValue(rawStatus);
      if (!timeKey || !status) continue;
      cleanRow[timeKey] = status;
    }
    if (Object.keys(cleanRow).length) out[dateKey] = cleanRow;
  }
  return out;
}

function normalizeScheduleWeekly(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [rawDayKey, rawTimes] of Object.entries(src)) {
    const dayKey = normalizeWeekdayKey(rawDayKey);
    if (!dayKey) continue;
    const cleanTimes = uniqueSortedStrings((Array.isArray(rawTimes) ? rawTimes : []).map(normalizeTimeKey));
    if (cleanTimes.length) out[dayKey] = cleanTimes;
  }
  return out;
}

function buildBrandScheduleState(brand) {
  const row = brand && typeof brand === 'object' ? brand : {};
  const id = String(row.id || '').trim();
  if (!id) return null;
  const name = String(row.name || '').trim() || id;
  const active = row.active !== false;
  const scheduleDates = normalizeScheduleDates(row.showScheduleDates);
  const scheduleStatus = normalizeScheduleStatus(row.showScheduleStatus);
  const scheduleWeekly = normalizeScheduleWeekly(row.showScheduleWeekly);
  const scheduleSlotKeys = [];
  const statusEntryKeys = [];
  const weeklySlotKeys = [];

  for (const [dateKey, times] of Object.entries(scheduleDates)) {
    for (const timeKey of times) {
      scheduleSlotKeys.push(`${dateKey}|${timeKey}`);
    }
  }
  for (const [dateKey, statusRow] of Object.entries(scheduleStatus)) {
    for (const timeKey of Object.keys(statusRow)) {
      statusEntryKeys.push(`${dateKey}|${timeKey}`);
    }
  }
  for (const [dayKey, times] of Object.entries(scheduleWeekly)) {
    for (const timeKey of times) {
      weeklySlotKeys.push(`${dayKey}|${timeKey}`);
    }
  }

  return {
    id,
    name,
    active,
    scheduleSlotKeys: uniqueSortedStrings(scheduleSlotKeys),
    statusEntryKeys: uniqueSortedStrings(statusEntryKeys),
    weeklySlotKeys: uniqueSortedStrings(weeklySlotKeys),
    scheduleSlotCount: scheduleSlotKeys.length,
    statusEntryCount: statusEntryKeys.length,
    weeklySlotCount: weeklySlotKeys.length,
  };
}

function buildCatalogScheduleSummary(payload) {
  const brands = Array.isArray(payload && payload.brands) ? payload.brands : [];
  const byId = new Map();
  let totalScheduleSlots = 0;
  let totalStatusEntries = 0;
  let totalWeeklySlots = 0;
  let scheduledBrandCount = 0;
  let statusBrandCount = 0;
  let weeklyBrandCount = 0;
  let activeScheduledBrandCount = 0;

  for (const brand of brands) {
    const state = buildBrandScheduleState(brand);
    if (!state) continue;
    byId.set(state.id, state);
    totalScheduleSlots += state.scheduleSlotCount;
    totalStatusEntries += state.statusEntryCount;
    totalWeeklySlots += state.weeklySlotCount;
    if (state.scheduleSlotCount > 0) {
      scheduledBrandCount += 1;
      if (state.active) activeScheduledBrandCount += 1;
    }
    if (state.statusEntryCount > 0) statusBrandCount += 1;
    if (state.weeklySlotCount > 0) weeklyBrandCount += 1;
  }

  return {
    counts: {
      totalScheduleSlots,
      totalStatusEntries,
      totalWeeklySlots,
      scheduledBrandCount,
      statusBrandCount,
      weeklyBrandCount,
      activeScheduledBrandCount,
    },
    byId,
    brands: Array.from(byId.values()),
  };
}

function subtractKeys(beforeKeys, afterKeys) {
  const afterSet = new Set(Array.isArray(afterKeys) ? afterKeys : []);
  return (Array.isArray(beforeKeys) ? beforeKeys : []).filter((key) => !afterSet.has(key));
}

function summarizeScheduleCounts(summary) {
  const counts = summary && summary.counts && typeof summary.counts === 'object' ? summary.counts : {};
  return {
    totalScheduledSlots: Number(counts.totalScheduleSlots) || 0,
    totalStatusEntries: Number(counts.totalStatusEntries) || 0,
    totalWeeklySlots: Number(counts.totalWeeklySlots) || 0,
    scheduledBrandCount: Number(counts.scheduledBrandCount) || 0,
    statusBrandCount: Number(counts.statusBrandCount) || 0,
    weeklyBrandCount: Number(counts.weeklyBrandCount) || 0,
    activeScheduledBrandCount: Number(counts.activeScheduledBrandCount) || 0,
  };
}

function diffCatalogScheduleImpact(currentPayload, incomingPayload) {
  const beforeSummary = buildCatalogScheduleSummary(currentPayload);
  const afterSummary = buildCatalogScheduleSummary(incomingPayload);
  const affectedBrands = [];

  for (const currentBrand of beforeSummary.brands) {
    if (!currentBrand.active) continue;
    if (!(currentBrand.scheduleSlotCount > 0 || currentBrand.weeklySlotCount > 0)) continue;
    const nextBrand = afterSummary.byId.get(currentBrand.id) || null;
    const removedScheduleSlotKeys =
      !nextBrand || !nextBrand.active
        ? currentBrand.scheduleSlotKeys.slice()
        : subtractKeys(currentBrand.scheduleSlotKeys, nextBrand.scheduleSlotKeys);
    const removedStatusEntryKeys =
      !nextBrand || !nextBrand.active
        ? currentBrand.statusEntryKeys.slice()
        : subtractKeys(currentBrand.statusEntryKeys, nextBrand.statusEntryKeys);
    const removedWeeklySlotKeys =
      !nextBrand || !nextBrand.active
        ? currentBrand.weeklySlotKeys.slice()
        : subtractKeys(currentBrand.weeklySlotKeys, nextBrand.weeklySlotKeys);

    // Status-only removals can legitimately revert a live slot back to available.
    // Only real dated-slot loss or weekly-template loss should trip the destructive guard.
    if (!removedScheduleSlotKeys.length && !removedWeeklySlotKeys.length) continue;

    affectedBrands.push({
      id: currentBrand.id,
      name: currentBrand.name,
      missingFromIncoming: !nextBrand,
      beforeActive: currentBrand.active,
      afterActive: !!(nextBrand && nextBrand.active),
      beforeScheduleSlotCount: currentBrand.scheduleSlotCount,
      afterScheduleSlotCount: nextBrand ? nextBrand.scheduleSlotCount : 0,
      beforeStatusEntryCount: currentBrand.statusEntryCount,
      afterStatusEntryCount: nextBrand ? nextBrand.statusEntryCount : 0,
      beforeWeeklySlotCount: currentBrand.weeklySlotCount,
      afterWeeklySlotCount: nextBrand ? nextBrand.weeklySlotCount : 0,
      removedScheduleSlotCount: removedScheduleSlotKeys.length,
      removedStatusEntryCount: removedStatusEntryKeys.length,
      removedWeeklySlotCount: removedWeeklySlotKeys.length,
      removedScheduleSlotsSample: removedScheduleSlotKeys.slice(0, 25),
      removedStatusEntriesSample: removedStatusEntryKeys.slice(0, 25),
      removedWeeklySlotsSample: removedWeeklySlotKeys.slice(0, 25),
    });
  }

  return {
    before: summarizeScheduleCounts(beforeSummary),
    after: summarizeScheduleCounts(afterSummary),
    affectedBrands,
    destructive: affectedBrands.length > 0,
  };
}

function extractCatalogBaseVersion(payload, explicitBaseVersion) {
  const candidates = [explicitBaseVersion];
  const meta = payload && payload.meta && typeof payload.meta === 'object' ? payload.meta : {};
  candidates.push(
    meta.baseSnapshotVersion,
    meta.base_snapshot_version,
    meta.lastPublishedCatalogVersion,
    meta.last_published_catalog_version,
    meta.version,
  );
  for (const candidate of candidates) {
    const parsed = toInt(candidate, 0);
    if (parsed > 0) return parsed;
  }
  return 0;
}

function assessCatalogPublishSafety(options = {}) {
  const currentPublished = options.currentPublished && typeof options.currentPublished === 'object' ? options.currentPublished : null;
  const incomingPayload = options.incomingPayload && typeof options.incomingPayload === 'object' ? options.incomingPayload : {};
  const currentPayload =
    currentPublished && currentPublished.payload && typeof currentPublished.payload === 'object'
      ? currentPublished.payload
      : {};
  const currentVersion = Math.max(
    1,
    toInt(currentPublished && currentPublished.version, toInt(currentPayload && currentPayload.meta && currentPayload.meta.version, 1)),
  );
  const baseVersion = extractCatalogBaseVersion(incomingPayload, options.explicitBaseVersion);
  const impact = diffCatalogScheduleImpact(currentPayload, incomingPayload);

  let block = null;
  if (baseVersion <= 0) {
    block = {
      status: 409,
      code: PUBLISH_BASE_VERSION_REQUIRED_CODE,
      message: PUBLISH_BASE_VERSION_REQUIRED_MESSAGE,
    };
  } else if (baseVersion < currentVersion) {
    block = {
      status: 409,
      code: PUBLISH_BASE_VERSION_STALE_CODE,
      message: PUBLISH_BASE_VERSION_STALE_MESSAGE,
    };
  } else if (baseVersion > currentVersion) {
    block = {
      status: 409,
      code: PUBLISH_BASE_VERSION_INVALID_CODE,
      message: PUBLISH_BASE_VERSION_INVALID_MESSAGE,
    };
  } else if (impact.destructive) {
    block = {
      status: 409,
      code: DESTRUCTIVE_PUBLISH_BLOCKED_CODE,
      message: DESTRUCTIVE_PUBLISH_BLOCKED_MESSAGE,
    };
  }

  return {
    currentVersion,
    baseVersion,
    impact,
    block,
  };
}

function buildRecoveryConfirmationToken(sourceVersion, target = 'published') {
  const safeVersion = Math.max(1, toInt(sourceVersion, 0));
  const safeTarget = String(target || 'published').trim().toLowerCase() === 'draft' ? 'draft' : 'published';
  return `catalog-restore-${safeTarget}-v${safeVersion}:i-understand-this-overwrites-live-catalog`;
}

function smokePublishOverrideAccepted(envName = SMOKE_PUBLISH_OVERRIDE_ENV) {
  return String(process.env[envName] || '').trim() === 'YES_I_UNDERSTAND_SMOKE_USERS_CAN_PUBLISH';
}

function looksLikeSmokePublishActor(user) {
  const row = user && typeof user === 'object' ? user : {};
  const fields = [
    row.id,
    row.name,
    row.displayName,
    row.firstName,
    row.lastName,
    row.email,
    row.workEmail,
    row.emailOrLogin,
    row.wwid,
  ];
  return fields.some((value) => String(value || '').trim().toLowerCase().includes('smoke'));
}

function isPrimaryAdminUser(user) {
  const row = user && typeof user === 'object' ? user : {};
  return (
    normalizeRole(row.role) === 'admin' &&
    !row.isAssistant &&
    normalizeStatus(row.status || 'active') === 'active' &&
    !looksLikeSmokePublishActor(row)
  );
}

module.exports = {
  DESTRUCTIVE_PUBLISH_BLOCKED_CODE,
  DESTRUCTIVE_PUBLISH_BLOCKED_MESSAGE,
  PUBLISH_BASE_VERSION_REQUIRED_CODE,
  PUBLISH_BASE_VERSION_REQUIRED_MESSAGE,
  PUBLISH_BASE_VERSION_STALE_CODE,
  PUBLISH_BASE_VERSION_STALE_MESSAGE,
  PUBLISH_BASE_VERSION_INVALID_CODE,
  PUBLISH_BASE_VERSION_INVALID_MESSAGE,
  SMOKE_PUBLISH_BLOCKED_CODE,
  SMOKE_PUBLISH_BLOCKED_MESSAGE,
  SMOKE_PUBLISH_OVERRIDE_ENV,
  normalizeScheduleDates,
  normalizeScheduleStatus,
  normalizeScheduleWeekly,
  buildCatalogScheduleSummary,
  diffCatalogScheduleImpact,
  extractCatalogBaseVersion,
  assessCatalogPublishSafety,
  buildRecoveryConfirmationToken,
  smokePublishOverrideAccepted,
  looksLikeSmokePublishActor,
  isPrimaryAdminUser,
};
