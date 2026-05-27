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
const SCHEDULED_MIGRATION_INVALID_CODE = 'SCHEDULED_MIGRATION_INVALID';
const SCHEDULED_MIGRATION_INVALID_MESSAGE =
  'Scheduled migration blocked because the live catalog no longer matches the verified scheduled-only migration shape.';
const SCHEDULED_MIGRATION_EXPECTED_BRAND_COUNT = 90;
const SCHEDULED_MIGRATION_EXPECTED_SCHEDULED_TRUE = 21;
const SCHEDULED_MIGRATION_EXPECTED_SCHEDULED_FALSE = 69;
const SCHEDULED_MIGRATION_KEY_BRANDS = Object.freeze([
  {
    id: '',
    name: 'Myrtle Waves GA',
    expectedScheduled: false,
    expectedShowInCalendar: true,
    expectedBookingRequired: false,
  },
  {
    id: 'brand-medieval-times',
    name: 'Medieval Times',
    expectedScheduled: true,
    expectedShowInCalendar: true,
  },
  {
    id: 'brand-att-barefoot-queen-dinner-cruise',
    name: 'Barefoot Queen Riverboat Dinner Cruise',
    expectedScheduled: true,
    expectedShowInCalendar: false,
  },
  {
    id: 'brand-att-barefoot-queen-sightseeing-cruise',
    name: 'Barefoot Queen Riverboat Sightseeing Cruise',
    expectedScheduled: true,
    expectedShowInCalendar: false,
  },
]);

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

function deepClone(value) {
  return JSON.parse(JSON.stringify(value && typeof value === 'object' ? value : {}));
}

function stableJson(value) {
  try {
    return JSON.stringify(value);
  } catch (_err) {
    return '__non_json__';
  }
}

function valuesDiffer(left, right) {
  return stableJson(left) !== stableJson(right);
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

function normalizeCategoryKey(value) {
  return String(value || '').trim().toLowerCase();
}

function isShowCategory(category) {
  const key = normalizeCategoryKey(category);
  return key === 'shows' || key === 'attractions' || key === 'ga attractions';
}

function isShowsFolderCategory(category) {
  return normalizeCategoryKey(category) === 'shows';
}

function bookingIsLegacyScheduledAttractionBrandId(brandId = '') {
  const key = String(brandId || '').trim();
  return key === 'brand-att-barefoot-queen-dinner-cruise' || key === 'brand-att-barefoot-queen-sightseeing-cruise';
}

function brandHasScheduleTimes(brand) {
  const dates = normalizeScheduleDates(brand && brand.showScheduleDates);
  if (Object.keys(dates).some((dateKey) => Array.isArray(dates[dateKey]) && dates[dateKey].length > 0)) return true;
  const weekly = normalizeScheduleWeekly(brand && brand.showScheduleWeekly);
  return Object.keys(weekly).some((dayKey) => Array.isArray(weekly[dayKey]) && weekly[dayKey].length > 0);
}

function scheduledFlagFromLegacyBrand(brand) {
  const row = brand && typeof brand === 'object' ? brand : {};
  if (!isShowCategory(row.category)) return false;
  if (isShowsFolderCategory(row.category)) return true;
  if (bookingIsLegacyScheduledAttractionBrandId(row.id)) return true;
  return brandHasScheduleTimes(row);
}

function brandDerivedScheduledValue(brand) {
  const row = brand && typeof brand === 'object' ? brand : {};
  if (typeof row.scheduled === 'boolean') return !!row.scheduled;
  return scheduledFlagFromLegacyBrand(row);
}

function normalizeScheduleSlotKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const parts = raw.split('|');
  if (parts.length !== 2) return '';
  const dateKey = normalizeDateKey(parts[0]);
  const timeKey = normalizeTimeKey(parts[1]);
  return dateKey && timeKey ? `${dateKey}|${timeKey}` : '';
}

function normalizeWeeklySlotKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const parts = raw.split('|');
  if (parts.length !== 2) return '';
  const dayKey = normalizeWeekdayKey(parts[0]);
  const timeKey = normalizeTimeKey(parts[1]);
  return dayKey && timeKey ? `${dayKey}|${timeKey}` : '';
}

function normalizeCalendarPublishIntent(raw) {
  const rows = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray(raw.brand_changes)
      ? raw.brand_changes
      : raw && typeof raw === 'object'
        ? [raw]
        : [];
  const out = new Map();
  for (const entry of rows) {
    const row = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
    const brandId = String(row.brand_id || row.brandId || '').trim();
    if (!brandId) continue;
    out.set(brandId, {
      brandId,
      removedScheduleSlots: uniqueSortedStrings(
        (Array.isArray(row.removed_schedule_slots) ? row.removed_schedule_slots : row.removedScheduleSlots || []).map(
          normalizeScheduleSlotKey,
        ),
      ),
      removedWeeklySlots: uniqueSortedStrings(
        (Array.isArray(row.removed_weekly_slots) ? row.removed_weekly_slots : row.removedWeeklySlots || []).map(
          normalizeWeeklySlotKey,
        ),
      ),
      source: String(row.source || '').trim(),
      kind: String(row.kind || '').trim(),
    });
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

function diffCatalogScheduleImpact(currentPayload, incomingPayload, opts = {}) {
  const beforeSummary = buildCatalogScheduleSummary(currentPayload);
  const afterSummary = buildCatalogScheduleSummary(incomingPayload);
  const includeInternalKeys = !!(opts && opts.includeInternalKeys);
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

    // Status-only removals can legitimately mean "revert this time back to available"
    // while keeping the underlying live schedule slot intact. The destructive publish
    // guard should only block actual dated slot loss or weekly template loss.
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
      removedScheduleSlotKeys: includeInternalKeys ? removedScheduleSlotKeys.slice() : undefined,
      removedWeeklySlotKeys: includeInternalKeys ? removedWeeklySlotKeys.slice() : undefined,
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

function buildIntentMismatchBrandImpact(brandImpact, reason, extra = {}) {
  return {
    id: String((brandImpact && brandImpact.id) || '').trim(),
    name: String((brandImpact && brandImpact.name) || '').trim(),
    reason: String(reason || 'intent-mismatch').trim() || 'intent-mismatch',
    removed_schedule_slot_count: Number((brandImpact && brandImpact.removedScheduleSlotCount) || 0),
    removed_weekly_slot_count: Number((brandImpact && brandImpact.removedWeeklySlotCount) || 0),
    removed_schedule_slots_sample: Array.isArray(brandImpact && brandImpact.removedScheduleSlotsSample)
      ? brandImpact.removedScheduleSlotsSample.slice(0, 10)
      : [],
    removed_weekly_slots_sample: Array.isArray(brandImpact && brandImpact.removedWeeklySlotsSample)
      ? brandImpact.removedWeeklySlotsSample.slice(0, 10)
      : [],
    ...extra,
  };
}

function buildIntentMismatchMessage(rows) {
  const first = Array.isArray(rows) ? rows[0] : null;
  const brandName = String((first && first.name) || 'the live schedule').trim() || 'the live schedule';
  if (!first) {
    return DESTRUCTIVE_PUBLISH_BLOCKED_MESSAGE;
  }
  if (first.reason === 'missing-brand-intent') {
    return `Publish blocked because it would remove existing show dates/times on ${brandName}, but this browser did not record an explicit calendar removal for that brand. Review the live schedule and try again.`;
  }
  if (first.reason === 'brand-missing-from-incoming') {
    return `Publish blocked because it would remove existing show dates/times by omitting ${brandName} from the outgoing catalog. Reload live catalog and review the edited brand before trying again.`;
  }
  if (first.reason === 'weekly-slot-removal') {
    return `Publish blocked because it would remove existing show dates/times from weekly schedule templates on ${brandName}. Explicit calendar publishes can remove dated slots only; weekly template loss still requires a safer recovery path.`;
  }
  if (first.reason === 'all-brand-times-removed') {
    return `Publish blocked because it would clear every live show time for ${brandName}. Explicit calendar publishes can remove selected dated slots, but they cannot wipe a brand's schedule entirely.`;
  }
  if (first.reason === 'schedule-slot-not-in-intent') {
    const sample =
      Array.isArray(first.unexplained_schedule_slots_sample) && first.unexplained_schedule_slots_sample[0]
        ? ` including ${String(first.unexplained_schedule_slots_sample[0] || '').trim()}`
        : '';
    return `Publish blocked because it would remove existing show dates/times outside the explicit calendar edit for ${brandName}${sample}. Review the live schedule and try again.`;
  }
  return DESTRUCTIVE_PUBLISH_BLOCKED_MESSAGE;
}

function assessIntentionalScheduleRemovals(impact, publishIntent) {
  const affectedBrands = Array.isArray(impact && impact.affectedBrands) ? impact.affectedBrands : [];
  if (!affectedBrands.length) {
    return { allowed: true, unexplainedAffectedBrands: [], message: '' };
  }
  const intentByBrand = normalizeCalendarPublishIntent(publishIntent);
  if (!intentByBrand.size) {
    const unexplainedAffectedBrands = affectedBrands.map((brandImpact) =>
      buildIntentMismatchBrandImpact(brandImpact, 'missing-brand-intent'),
    );
    return {
      allowed: false,
      unexplainedAffectedBrands,
      message: buildIntentMismatchMessage(unexplainedAffectedBrands),
    };
  }
  const unexplainedAffectedBrands = [];
  for (const brandImpact of affectedBrands) {
    const intent = intentByBrand.get(String((brandImpact && brandImpact.id) || '').trim());
    if (!intent) {
      unexplainedAffectedBrands.push(buildIntentMismatchBrandImpact(brandImpact, 'missing-brand-intent'));
      continue;
    }
    if (!!brandImpact.missingFromIncoming || !brandImpact.afterActive) {
      unexplainedAffectedBrands.push(buildIntentMismatchBrandImpact(brandImpact, 'brand-missing-from-incoming'));
      continue;
    }
    const removedWeeklySlotKeys = Array.isArray(brandImpact.removedWeeklySlotKeys)
      ? brandImpact.removedWeeklySlotKeys
      : [];
    if (removedWeeklySlotKeys.length) {
      unexplainedAffectedBrands.push(buildIntentMismatchBrandImpact(brandImpact, 'weekly-slot-removal'));
      continue;
    }
    if (
      Number(brandImpact.beforeScheduleSlotCount || 0) > 0 &&
      Number(brandImpact.afterScheduleSlotCount || 0) === 0 &&
      Number(brandImpact.afterWeeklySlotCount || 0) === 0
    ) {
      unexplainedAffectedBrands.push(buildIntentMismatchBrandImpact(brandImpact, 'all-brand-times-removed'));
      continue;
    }
    const allowedScheduleSlots = new Set(Array.isArray(intent.removedScheduleSlots) ? intent.removedScheduleSlots : []);
    const unexplainedScheduleSlots = (
      Array.isArray(brandImpact.removedScheduleSlotKeys) ? brandImpact.removedScheduleSlotKeys : []
    ).filter((slotKey) => !allowedScheduleSlots.has(slotKey));
    if (unexplainedScheduleSlots.length) {
      unexplainedAffectedBrands.push(
        buildIntentMismatchBrandImpact(brandImpact, 'schedule-slot-not-in-intent', {
          unexplained_schedule_slots_sample: unexplainedScheduleSlots.slice(0, 10),
        }),
      );
    }
  }
  return {
    allowed: unexplainedAffectedBrands.length === 0,
    unexplainedAffectedBrands,
    message: unexplainedAffectedBrands.length ? buildIntentMismatchMessage(unexplainedAffectedBrands) : '',
  };
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
  const impact = diffCatalogScheduleImpact(currentPayload, incomingPayload, { includeInternalKeys: true });
  const intentAssessment = assessIntentionalScheduleRemovals(impact, options.publishIntent);

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
  } else if (impact.destructive && !intentAssessment.allowed) {
    block = {
      status: 409,
      code: DESTRUCTIVE_PUBLISH_BLOCKED_CODE,
      message: intentAssessment.message || DESTRUCTIVE_PUBLISH_BLOCKED_MESSAGE,
    };
  }

  return {
    currentVersion,
    baseVersion,
    impact,
    intentAssessment,
    block,
  };
}

function buildBrandMap(rows) {
  const map = new Map();
  for (const entry of Array.isArray(rows) ? rows : []) {
    const row = entry && typeof entry === 'object' ? entry : null;
    if (!row) continue;
    const id = String(row.id || '').trim();
    if (!id) continue;
    map.set(id, row);
  }
  return map;
}

function changedKeysForBrand(beforeBrand, afterBrand) {
  const before = beforeBrand && typeof beforeBrand === 'object' ? beforeBrand : {};
  const after = afterBrand && typeof afterBrand === 'object' ? afterBrand : {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return Array.from(keys).filter((key) => valuesDiffer(before[key], after[key])).sort();
}

function buildCollectionDiffSummary(beforeRows, afterRows, priceKeys = []) {
  const beforeMap = buildBrandMap(beforeRows);
  const afterMap = buildBrandMap(afterRows);
  const ids = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  let changedRows = 0;
  let priceDiffs = 0;
  for (const id of ids) {
    const before = beforeMap.get(id) || null;
    const after = afterMap.get(id) || null;
    if (!before || !after) {
      changedRows += 1;
      continue;
    }
    const changedKeys = changedKeysForBrand(before, after);
    if (changedKeys.length) {
      changedRows += 1;
      priceDiffs += changedKeys.filter((key) => priceKeys.includes(key)).length;
    }
  }
  return { changedRows, priceDiffs };
}

function findBrandByKey(rows, keyBrand) {
  const source = Array.isArray(rows) ? rows : [];
  if (keyBrand && keyBrand.id) {
    const foundById = source.find((row) => String((row && row.id) || '').trim() === String(keyBrand.id || '').trim());
    if (foundById) return foundById;
  }
  return source.find((row) => String((row && row.name) || '').trim() === String((keyBrand && keyBrand.name) || '').trim()) || null;
}

function buildScheduledMigrationKeyBrandSummary(rows) {
  const brands = Array.isArray(rows) ? rows : [];
  return SCHEDULED_MIGRATION_KEY_BRANDS.map((keyBrand) => {
    const row = findBrandByKey(brands, keyBrand);
    return {
      id: row ? String(row.id || '') : String(keyBrand.id || ''),
      name: row ? String(row.name || '') : String(keyBrand.name || ''),
      found: !!row,
      scheduled: row && typeof row.scheduled === 'boolean' ? !!row.scheduled : null,
      showInCalendar: row && typeof row.showInCalendar === 'boolean' ? !!row.showInCalendar : null,
      bookingRequired: row && typeof row.bookingRequired === 'boolean' ? !!row.bookingRequired : null,
    };
  });
}

function buildScheduledMigrationSummary(beforePayload, afterPayload) {
  const before = beforePayload && typeof beforePayload === 'object' ? beforePayload : {};
  const after = afterPayload && typeof afterPayload === 'object' ? afterPayload : {};
  const beforeBrands = Array.isArray(before.brands) ? before.brands : [];
  const afterBrands = Array.isArray(after.brands) ? after.brands : [];
  const beforeMap = buildBrandMap(beforeBrands);
  const afterMap = buildBrandMap(afterBrands);
  const ids = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  const changedBrands = [];
  let scheduledOnly = 0;
  let nonScheduledCount = 0;
  let showInCalendarDiffs = 0;
  let bookingRequiredDiffs = 0;
  let categoryDiffs = 0;
  let showScheduleDatesDiffs = 0;
  let showScheduleStatusDiffs = 0;
  let showAlertHistoryDiffs = 0;
  let showUpdateAlertDiffs = 0;

  for (const id of ids) {
    const beforeBrand = beforeMap.get(id) || null;
    const afterBrand = afterMap.get(id) || null;
    const diffKeys = changedKeysForBrand(beforeBrand, afterBrand);
    if (!diffKeys.length) continue;
    const name = String((afterBrand && afterBrand.name) || (beforeBrand && beforeBrand.name) || id).trim() || id;
    changedBrands.push({ id, name, diffKeys });
    if (diffKeys.length === 1 && diffKeys[0] === 'scheduled') {
      scheduledOnly += 1;
    } else {
      nonScheduledCount += 1;
    }
    if (diffKeys.includes('showInCalendar')) showInCalendarDiffs += 1;
    if (diffKeys.includes('bookingRequired')) bookingRequiredDiffs += 1;
    if (diffKeys.includes('category')) categoryDiffs += 1;
    if (diffKeys.includes('showScheduleDates')) showScheduleDatesDiffs += 1;
    if (diffKeys.includes('showScheduleStatus')) showScheduleStatusDiffs += 1;
    if (diffKeys.includes('showAlertHistory')) showAlertHistoryDiffs += 1;
    if (diffKeys.includes('showUpdateAlert')) showUpdateAlertDiffs += 1;
  }

  const ticketLineDiff = buildCollectionDiffSummary(before.ticketLines, after.ticketLines, ['retailPrice', 'cmaPrice']);
  const resourceDiff = buildCollectionDiffSummary(before.resources, after.resources);
  const scheduledTrueBrandNames = afterBrands
    .filter((row) => row && row.scheduled === true)
    .map((row) => String(row.name || '').trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  const scheduledFalseBrandNames = afterBrands
    .filter((row) => row && row.scheduled === false)
    .map((row) => String(row.name || '').trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  return {
    brandCount: beforeBrands.length,
    scheduledMissingBefore: beforeBrands.filter((row) => !(row && typeof row.scheduled === 'boolean')).length,
    changedBrands: changedBrands.length,
    scheduledOnly,
    nonScheduledCount,
    scheduledTrueCount: scheduledTrueBrandNames.length,
    scheduledFalseCount: scheduledFalseBrandNames.length,
    showInCalendarDiffs,
    bookingRequiredDiffs,
    categoryDiffs,
    ticketLineDiffs: ticketLineDiff.changedRows,
    priceDiffs: ticketLineDiff.priceDiffs,
    resourceDiffs: resourceDiff.changedRows,
    showScheduleDatesDiffs,
    showScheduleStatusDiffs,
    showAlertHistoryDiffs,
    showUpdateAlertDiffs,
    scheduleAlertDiffs: showScheduleDatesDiffs + showScheduleStatusDiffs + showAlertHistoryDiffs + showUpdateAlertDiffs,
    scheduledTrueBrandNames,
    scheduledFalseBrandNames,
    changedBrandIds: changedBrands.map((entry) => entry.id),
    changedBrandNames: changedBrands.map((entry) => entry.name),
    keyBrands: buildScheduledMigrationKeyBrandSummary(afterBrands),
  };
}

function validateScheduledMigrationSummary(summary) {
  const s = summary && typeof summary === 'object' ? summary : {};
  const errors = [];
  if (Number(s.brandCount || 0) !== SCHEDULED_MIGRATION_EXPECTED_BRAND_COUNT) {
    errors.push(`Expected ${SCHEDULED_MIGRATION_EXPECTED_BRAND_COUNT} brands, found ${Number(s.brandCount || 0)}.`);
  }
  if (Number(s.scheduledMissingBefore || 0) !== SCHEDULED_MIGRATION_EXPECTED_BRAND_COUNT) {
    errors.push(`Expected ${SCHEDULED_MIGRATION_EXPECTED_BRAND_COUNT} brands with scheduled missing before apply, found ${Number(s.scheduledMissingBefore || 0)}.`);
  }
  if (Number(s.changedBrands || 0) !== SCHEDULED_MIGRATION_EXPECTED_BRAND_COUNT) {
    errors.push(`Expected ${SCHEDULED_MIGRATION_EXPECTED_BRAND_COUNT} changed brands, found ${Number(s.changedBrands || 0)}.`);
  }
  if (Number(s.scheduledOnly || 0) !== SCHEDULED_MIGRATION_EXPECTED_BRAND_COUNT) {
    errors.push(`Expected ${SCHEDULED_MIGRATION_EXPECTED_BRAND_COUNT} scheduled-only brand diffs, found ${Number(s.scheduledOnly || 0)}.`);
  }
  if (Number(s.nonScheduledCount || 0) !== 0) {
    errors.push(`Expected 0 non-scheduled diffs, found ${Number(s.nonScheduledCount || 0)}.`);
  }
  if (Number(s.scheduledTrueCount || 0) !== SCHEDULED_MIGRATION_EXPECTED_SCHEDULED_TRUE) {
    errors.push(`Expected ${SCHEDULED_MIGRATION_EXPECTED_SCHEDULED_TRUE} scheduled=true brands, found ${Number(s.scheduledTrueCount || 0)}.`);
  }
  if (Number(s.scheduledFalseCount || 0) !== SCHEDULED_MIGRATION_EXPECTED_SCHEDULED_FALSE) {
    errors.push(`Expected ${SCHEDULED_MIGRATION_EXPECTED_SCHEDULED_FALSE} scheduled=false brands, found ${Number(s.scheduledFalseCount || 0)}.`);
  }
  [
    ['showInCalendarDiffs', 0],
    ['bookingRequiredDiffs', 0],
    ['categoryDiffs', 0],
    ['ticketLineDiffs', 0],
    ['priceDiffs', 0],
    ['resourceDiffs', 0],
    ['showScheduleDatesDiffs', 0],
    ['showScheduleStatusDiffs', 0],
    ['showAlertHistoryDiffs', 0],
    ['showUpdateAlertDiffs', 0],
    ['scheduleAlertDiffs', 0],
  ].forEach(([key, expected]) => {
    if (Number(s[key] || 0) !== expected) {
      errors.push(`Expected ${key}=${expected}, found ${Number(s[key] || 0)}.`);
    }
  });
  const keyBrands = Array.isArray(s.keyBrands) ? s.keyBrands : [];
  SCHEDULED_MIGRATION_KEY_BRANDS.forEach((expectedBrand) => {
    const found = keyBrands.find((entry) => {
      if (expectedBrand.id && String((entry && entry.id) || '').trim() === expectedBrand.id) return true;
      return String((entry && entry.name) || '').trim() === expectedBrand.name;
    }) || null;
    if (!found || !found.found) {
      errors.push(`Expected key brand ${expectedBrand.name} in the migration preview.`);
      return;
    }
    if (typeof expectedBrand.expectedScheduled === 'boolean' && found.scheduled !== expectedBrand.expectedScheduled) {
      errors.push(`Expected ${expectedBrand.name} scheduled=${String(expectedBrand.expectedScheduled)}, found ${String(found.scheduled)}.`);
    }
    if (typeof expectedBrand.expectedShowInCalendar === 'boolean' && found.showInCalendar !== expectedBrand.expectedShowInCalendar) {
      errors.push(`Expected ${expectedBrand.name} showInCalendar=${String(expectedBrand.expectedShowInCalendar)}, found ${String(found.showInCalendar)}.`);
    }
    if (typeof expectedBrand.expectedBookingRequired === 'boolean' && found.bookingRequired !== expectedBrand.expectedBookingRequired) {
      errors.push(`Expected ${expectedBrand.name} bookingRequired=${String(expectedBrand.expectedBookingRequired)}, found ${String(found.bookingRequired)}.`);
    }
  });
  return {
    ok: errors.length === 0,
    errors,
  };
}

function deriveScheduledMigrationPayload(publishedPayload, opts = {}) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const current = deepClone(publishedPayload && typeof publishedPayload === 'object' ? publishedPayload : {});
  current.brands = Array.isArray(current.brands) ? current.brands : [];
  current.ticketLines = Array.isArray(current.ticketLines) ? current.ticketLines : [];
  current.resources = Array.isArray(current.resources) ? current.resources : [];
  let migrated = deepClone(current);
  migrated.brands = current.brands.map((brand) => {
    const row = brand && typeof brand === 'object' ? deepClone(brand) : {};
    if (typeof row.scheduled === 'boolean') return row;
    row.scheduled = brandDerivedScheduledValue(row);
    return row;
  });
  if (typeof options.finalizePayload === 'function') {
    migrated = deepClone(options.finalizePayload(migrated));
  }
  const summary = buildScheduledMigrationSummary(current, migrated);
  const validation = validateScheduledMigrationSummary(summary);
  return {
    currentPayload: current,
    migratedPayload: migrated,
    summary,
    validation,
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
  SCHEDULED_MIGRATION_INVALID_CODE,
  SCHEDULED_MIGRATION_INVALID_MESSAGE,
  SMOKE_PUBLISH_OVERRIDE_ENV,
  normalizeScheduleDates,
  normalizeScheduleStatus,
  normalizeScheduleWeekly,
  brandDerivedScheduledValue,
  buildCatalogScheduleSummary,
  buildScheduledMigrationSummary,
  deriveScheduledMigrationPayload,
  diffCatalogScheduleImpact,
  extractCatalogBaseVersion,
  assessCatalogPublishSafety,
  buildRecoveryConfirmationToken,
  smokePublishOverrideAccepted,
  looksLikeSmokePublishActor,
  isPrimaryAdminUser,
  validateScheduledMigrationSummary,
};
