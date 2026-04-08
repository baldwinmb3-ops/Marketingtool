const {
  nowIso,
  toInt,
  toNum,
  normalizeStatus,
  normalizeAppRole,
  normalizeManagerTitle,
  normalizeWwid,
  normalizeEmail,
  randomId,
  hashPassword,
} = require('./lib.cjs');

function sanitizeCatalogPayload(input) {
  const src = input && typeof input === 'object' ? input : {};
  return {
    meta: src.meta && typeof src.meta === 'object' ? src.meta : {},
    brands: Array.isArray(src.brands) ? src.brands : [],
    ticketLines: Array.isArray(src.ticketLines) ? src.ticketLines : [],
    resources: Array.isArray(src.resources) ? src.resources : [],
    managerCategories: Array.isArray(src.managerCategories) ? src.managerCategories : [],
    managerEntries: Array.isArray(src.managerEntries) ? src.managerEntries : [],
    phoneDirectoryEntries: Array.isArray(src.phoneDirectoryEntries) ? src.phoneDirectoryEntries : [],
  };
}

function sanitizeQuoteLines(input) {
  const rows = Array.isArray(input) ? input : [];
  return rows
    .map((entry) => {
      const row = entry && typeof entry === 'object' ? entry : {};
      const ticketLineId = String(row.ticketLineId || row.ticket_line_id || '').trim();
      if (!ticketLineId) return null;
      const qty = Math.max(1, toInt(row.qty, 1));
      const freeQty = Math.max(0, Math.min(qty, toInt(row.freeQty, 0)));
      const extraEach = Math.max(0, toNum(row.extraEach, toNum(row.extra_each, 0)));
      return { ticketLineId, qty, freeQty, extraEach, isAddon: !!row.isAddon };
    })
    .filter(Boolean);
}

function recomputePricing(publishedPayload, quoteLines) {
  const payload = publishedPayload && typeof publishedPayload === 'object' ? publishedPayload : {};
  const sourceLines = Array.isArray(payload.ticketLines) ? payload.ticketLines : [];
  const byId = new Map();

  sourceLines.forEach((entry) => {
    const row = entry && typeof entry === 'object' ? entry : {};
    const id = String(row.id || '').trim();
    if (!id) return;
    byId.set(id, {
      retailPrice: Math.max(0, toNum(row.retailPrice, 0)),
      cmaPrice: Math.max(0, toNum(row.cmaPrice, 0)),
      active: row.active !== false,
    });
  });

  const rows = sanitizeQuoteLines(quoteLines);
  if (!rows.length) throw new Error('Quote must include at least one ticket line.');

  let retailTotal = 0;
  let costTotal = 0;
  let complimentaryValue = 0;

  rows.forEach((row) => {
    const line = byId.get(row.ticketLineId);
    if (!line || !line.active) {
      throw new Error(`Ticket line ${row.ticketLineId} is unavailable in the current snapshot.`);
    }
    retailTotal += line.retailPrice * row.qty;
    costTotal += (line.cmaPrice + row.extraEach) * row.qty;
    complimentaryValue += line.cmaPrice * row.freeQty;
  });

  retailTotal = Number(retailTotal.toFixed(2));
  costTotal = Number(costTotal.toFixed(2));
  complimentaryValue = Number(complimentaryValue.toFixed(2));
  const profit = Number(Math.max(0, retailTotal - costTotal).toFixed(2));

  return { retailTotal, costTotal, complimentaryValue, profit, computedAt: nowIso() };
}

function bookingStatus(value) {
  const key = String(value ?? '').trim().toLowerCase();
  if (key === 'working' || key === 'booked') return 'working';
  if (key === 'done') return 'done';
  if (key === 'deleted') return 'deleted';
  return 'pending';
}

function sanitizeBookingRow(input, defaults = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const base = defaults && typeof defaults === 'object' ? defaults : {};
  const id = String(src.id || base.id || randomId('booking')).trim();
  return {
    id,
    brandId: String(src.brandId || base.brandId || '').trim(),
    brandName: String(src.brandName || base.brandName || '').trim(),
    guestFirstName: String(src.guestFirstName || base.guestFirstName || '').trim(),
    guestLastName: String(src.guestLastName || base.guestLastName || '').trim(),
    showDate: String(src.showDate || src.primaryShowDate || base.showDate || '').trim(),
    showTime: String(src.showTime || src.primaryShowTime || base.showTime || '').trim(),
    primaryShowDate: String(src.primaryShowDate || src.showDate || base.primaryShowDate || '').trim(),
    primaryShowTime: String(src.primaryShowTime || src.showTime || base.primaryShowTime || '').trim(),
    backupShowDate: String(src.backupShowDate || base.backupShowDate || '').trim(),
    backupShowTime: String(src.backupShowTime || base.backupShowTime || '').trim(),
    tourNumber: String(src.tourNumber || base.tourNumber || '').trim(),
    status: bookingStatus(src.status || base.status),
    snapshotVersion: Math.max(1, toInt(src.snapshotVersion, toInt(base.snapshotVersion, 1))),
    quoteLines: sanitizeQuoteLines(src.quoteLines || base.quoteLines || []),
    clientTotals: src.clientTotals && typeof src.clientTotals === 'object' ? src.clientTotals : base.clientTotals || {},
    authoritativeTotals: src.authoritativeTotals && typeof src.authoritativeTotals === 'object' ? src.authoritativeTotals : base.authoritativeTotals || {},
    commissionProfit: Number(toNum(src.commissionProfit, toNum(base.commissionProfit, 0)).toFixed(2)),
    createdByDevice: String(src.createdByDevice || base.createdByDevice || '').trim(),
    createdByRole: String(src.createdByRole || base.createdByRole || 'marketer').trim(),
    adminName: String(src.adminName || base.adminName || '').trim(),
    adminUserId: String(src.adminUserId || base.adminUserId || '').trim(),
    adminDevice: String(src.adminDevice || base.adminDevice || '').trim(),
    workingByName: String(src.workingByName || base.workingByName || '').trim(),
    workingByUserId: String(src.workingByUserId || base.workingByUserId || '').trim(),
    workingByDevice: String(src.workingByDevice || base.workingByDevice || '').trim(),
    workingAt: String(src.workingAt || base.workingAt || ''),
    completedByName: String(src.completedByName || base.completedByName || '').trim(),
    completedByUserId: String(src.completedByUserId || base.completedByUserId || '').trim(),
    completedByDevice: String(src.completedByDevice || base.completedByDevice || '').trim(),
    completedAt: String(src.completedAt || base.completedAt || ''),
    statusAt: String(src.statusAt || base.statusAt || ''),
    createdAt: String(src.createdAt || base.createdAt || nowIso()),
    updatedAt: String(src.updatedAt || base.updatedAt || nowIso()),
    revision: Math.max(1, toInt(src.revision, toInt(base.revision, 1))),
  };
}

function bookingDebugLogsEnabled() {
  return String(process.env.BOOKING_DEBUG_LOGS || '').trim() === '1';
}

function bookingDebugLog(kind, payload) {
  if (!bookingDebugLogsEnabled()) return;
  try {
    console.error(`[BOOKING_DEBUG_BACKEND] ${String(kind || 'booking-debug')}`, JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error(`[BOOKING_DEBUG_BACKEND] ${String(kind || 'booking-debug')}`, String((err && err.message) || err || 'log-failed'));
  }
}

function bookingValidationDiagnostics(rawRequest, row, serverVersion, publishedPayload) {
  const raw = rawRequest && typeof rawRequest === 'object' ? rawRequest : {};
  const issues = [];
  const missingFields = [];
  const invalidFields = [];
  const rawSnapshotVersion = raw.snapshotVersion ?? raw.snapshot_version;
  const rawQuoteLines = Array.isArray(raw.quoteLines)
    ? raw.quoteLines
    : Array.isArray(raw.quote_lines)
      ? raw.quote_lines
      : null;

  if (rawSnapshotVersion === undefined || rawSnapshotVersion === null || String(rawSnapshotVersion).trim() === '') {
    missingFields.push('snapshotVersion');
    issues.push({ field: 'snapshotVersion', reason: 'missing', message: 'snapshotVersion is required.' });
  } else {
    const parsedSnapshotVersion = toInt(rawSnapshotVersion, NaN);
    if (!Number.isFinite(parsedSnapshotVersion) || parsedSnapshotVersion <= 0) {
      invalidFields.push('snapshotVersion');
      issues.push({ field: 'snapshotVersion', reason: 'invalid', message: `snapshotVersion must be a positive integer. Received=${String(rawSnapshotVersion)}.` });
    } else if (row.snapshotVersion !== serverVersion) {
      invalidFields.push('snapshotVersion');
      issues.push({ field: 'snapshotVersion', reason: 'stale', message: `Snapshot version mismatch. Device=${row.snapshotVersion}, server=${serverVersion}.` });
    }
  }

  if (!rawQuoteLines) {
    missingFields.push('quoteLines');
    issues.push({ field: 'quoteLines', reason: 'missing', message: 'quoteLines is required.' });
  } else if (!rawQuoteLines.length) {
    invalidFields.push('quoteLines');
    issues.push({ field: 'quoteLines', reason: 'empty', message: 'quoteLines must contain at least one ticket line.' });
  } else {
    rawQuoteLines.forEach((line, index) => {
      const rawLine = line && typeof line === 'object' ? line : null;
      const prefix = `quoteLines[${index}]`;
      if (!rawLine) {
        invalidFields.push(prefix);
        issues.push({ field: prefix, reason: 'invalid', message: 'quote line must be an object.' });
        return;
      }
      const ticketLineId = String(rawLine.ticketLineId || rawLine.ticket_line_id || '').trim();
      const qty = toInt(rawLine.qty, NaN);
      const freeQty = toInt(rawLine.freeQty ?? rawLine.free_qty, 0);
      const extraEach = toNum(rawLine.extraEach ?? rawLine.extra_each, 0);
      if (!ticketLineId) {
        invalidFields.push(`${prefix}.ticketLineId`);
        issues.push({ field: `${prefix}.ticketLineId`, reason: 'missing', message: 'ticketLineId is required.' });
      }
      if (!Number.isFinite(qty) || qty <= 0) {
        invalidFields.push(`${prefix}.qty`);
        issues.push({ field: `${prefix}.qty`, reason: 'invalid', message: `qty must be a positive integer. Received=${String(rawLine.qty)}.` });
      }
      if (!Number.isFinite(freeQty) || freeQty < 0 || (Number.isFinite(qty) && freeQty > qty)) {
        invalidFields.push(`${prefix}.freeQty`);
        issues.push({ field: `${prefix}.freeQty`, reason: 'invalid', message: `freeQty must be between 0 and qty. Received=${String(rawLine.freeQty ?? rawLine.free_qty ?? 0)}.` });
      }
      if (!Number.isFinite(extraEach) || extraEach < 0) {
        invalidFields.push(`${prefix}.extraEach`);
        issues.push({ field: `${prefix}.extraEach`, reason: 'invalid', message: `extraEach must be a non-negative number. Received=${String(rawLine.extraEach ?? rawLine.extra_each ?? 0)}.` });
      }
    });
  }

  if (rawQuoteLines && rawQuoteLines.length && !row.quoteLines.length) {
    invalidFields.push('quoteLines');
    issues.push({ field: 'quoteLines', reason: 'sanitized-empty', message: 'quoteLines were present but all lines were dropped during sanitization.' });
  }

  let pricing = null;
  if (!issues.length) {
    try {
      pricing = recomputePricing(publishedPayload, row.quoteLines);
    } catch (err) {
      invalidFields.push('quoteLines');
      issues.push({ field: 'quoteLines', reason: 'pricing-recompute-failed', message: String((err && err.message) || err || 'Pricing recompute failed.') });
    }
  }

  const uniqueMissingFields = Array.from(new Set(missingFields));
  const uniqueInvalidFields = Array.from(new Set(invalidFields));
  let reason = '';
  if (issues.some((entry) => entry.reason === 'stale')) reason = 'snapshot-stale';
  else if (uniqueMissingFields.length) reason = 'missing-required-fields';
  else if (uniqueInvalidFields.length) reason = 'invalid-fields';

  return {
    ok: issues.length === 0,
    reason,
    missingFields: uniqueMissingFields,
    invalidFields: uniqueInvalidFields,
    issues,
    pricing,
  };
}

function bookingLockFromRow(row) {
  const src = row && typeof row === 'object' ? row : {};
  const status = bookingStatus(src.status);
  if (status !== 'working' && status !== 'done') return null;
  return {
    request_id: String(src.id || ''),
    status,
    claimed_by_name: String(src.workingByName || '').trim(),
    claimed_by_user_id: String(src.workingByUserId || '').trim(),
    claimed_by_device: String(src.workingByDevice || '').trim(),
    claimed_at: String(src.workingAt || src.updatedAt || nowIso()),
    completed_by_name: String(src.completedByName || '').trim(),
    completed_by_user_id: String(src.completedByUserId || '').trim(),
    completed_by_device: String(src.completedByDevice || '').trim(),
    completed_at: String(src.completedAt || ''),
    updated_at: String(src.updatedAt || nowIso()),
  };
}

function normalizeUserOperations(input) {
  const rows = Array.isArray(input) ? input : [];
  return rows
    .map((entry) => {
      const row = entry && typeof entry === 'object' ? entry : {};
      const op = String(row.op || '').trim().toLowerCase();
      if (!['create_user', 'update_user', 'set_user_status', 'delete_user'].includes(op)) return null;
      const wwid = normalizeWwid(row.wwid);
      if (!wwid) return null;
      const forceReset = typeof row.force_password_reset === 'boolean' ? row.force_password_reset : typeof row.forcePasswordReset === 'boolean' ? row.forcePasswordReset : undefined;
      return {
        op,
        wwid,
        role: normalizeAppRole(row.role),
        status: normalizeStatus(row.status),
        displayName: String(row.display_name || row.displayName || '').trim(),
        metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
        forcePasswordReset: forceReset,
      };
    })
    .filter(Boolean);
}

function normalizeDepartmentIds(value, fallback = []) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? (() => {
          try {
            return JSON.parse(value);
          } catch {
            return fallback;
          }
        })()
      : fallback;
  if (!Array.isArray(raw)) return Array.isArray(fallback) ? fallback : [];
  const seen = new Set();
  const out = [];
  raw.forEach((entry) => {
    const id = String(entry || '').trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  });
  return out;
}

function applyUserOperation(db, op, actor, logAudit) {
  const users = Array.isArray(db.users) ? db.users : [];
  const meta = op.metadata && typeof op.metadata === 'object' ? op.metadata : {};
  const metaBool = (value, fallback = false) => {
    if (typeof value === 'boolean') return value;
    const raw = String(value ?? '').trim().toLowerCase();
    if (!raw) return !!fallback;
    if (['1', 'true', 'yes', 'y', 'on', 'active'].includes(raw)) return true;
    if (['0', 'false', 'no', 'n', 'off', 'inactive'].includes(raw)) return false;
    return !!fallback;
  };
  const localUserId = String(meta.local_user_id ?? meta.localUserId ?? '').trim();
  const previousWwid = normalizeWwid(meta.previous_wwid ?? meta.previousWwid ?? '');
  const existing = users.find((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    if (localUserId && String(entry.id || '').trim() === localUserId) return true;
    const entryWwid = normalizeWwid(entry.wwid);
    return entryWwid === op.wwid || (!!previousWwid && entryWwid === previousWwid);
  });
  const now = nowIso();
  const forceResetExplicit = typeof op.forcePasswordReset === 'boolean' ? op.forcePasswordReset : null;
  const shouldForceResetFromMeta = !!meta.temp_password;

  function applyRole(target) {
    if (op.role === 'primary_admin') {
      target.role = 'admin';
      target.isAssistant = false;
      target.canAccessMarketer = metaBool(meta.can_access_marketer ?? meta.allow_marketer_mode, false);
      target.canAccessAdmin = false;
      target.canAccessManager = metaBool(meta.can_access_manager ?? meta.allow_manager_mode, false);
      target.managerOnly = false;
      return;
    }
    if (op.role === 'assistant_admin') {
      target.role = 'admin';
      target.isAssistant = true;
      target.canAccessMarketer = metaBool(meta.can_access_marketer ?? meta.allow_marketer_mode, false);
      target.canAccessAdmin = false;
      target.canAccessManager = metaBool(meta.can_access_manager ?? meta.allow_manager_mode, false);
      target.managerOnly = false;
      return;
    }
    target.role = 'marketer';
    target.isAssistant = false;
    target.canAccessMarketer = false;
    target.canAccessAdmin = metaBool(meta.can_access_admin ?? meta.allow_admin_mode, false);
    target.canAccessManager = metaBool(meta.can_access_manager ?? meta.allow_manager_mode, false);
    target.managerOnly = metaBool(meta.manager_only, false);
  }

  function applyDepartments(target) {
    target.departmentIds = normalizeDepartmentIds(meta.department_ids ?? meta.departmentIds, target.departmentIds || []);
  }

  function applyManagerTitle(target) {
    const requestedTitle = normalizeManagerTitle(meta.manager_title ?? meta.managerTitle, '');
    target.managerTitle = target.canAccessManager ? requestedTitle || 'Manager' : '';
  }

  if (op.op === 'create_user') {
    const target = existing || { id: randomId('user'), createdAt: now, updatedAt: now, status: 'active', isLocked: false, wwid: op.wwid };
    target.wwid = op.wwid;
    target.firstName = String(meta.first_name || target.firstName || '').trim();
    target.lastName = String(meta.last_name || target.lastName || '').trim();
    target.displayName = String(op.displayName || meta.display_name || target.displayName || '').trim() || `${target.firstName} ${target.lastName}`.trim() || 'User';
    target.email = normalizeEmail(meta.work_email || meta.email || target.email || `${op.wwid.toLowerCase()}@example.local`);
    target.phone = String(meta.phone || target.phone || '').trim();
    target.passwordHash = hashPassword(String(meta.temp_password || 'Temp123A'));
    applyRole(target);
    applyManagerTitle(target);
    applyDepartments(target);
    target.status = 'active';
    target.forcePasswordReset = forceResetExplicit !== null ? forceResetExplicit : shouldForceResetFromMeta;
    target.updatedAt = now;
    if (!existing) users.push(target);
    logAudit(db, { action: 'user.create', actorUserId: actor.userId, actorName: actor.name, targetType: 'user', targetId: target.id, details: { wwid: target.wwid, role: target.role } });
    return;
  }

  if (!existing) return;

  if (op.op === 'update_user') {
    applyRole(existing);
    existing.wwid = op.wwid;
    if (Object.prototype.hasOwnProperty.call(meta, 'first_name')) existing.firstName = String(meta.first_name || '').trim();
    if (Object.prototype.hasOwnProperty.call(meta, 'last_name')) existing.lastName = String(meta.last_name || '').trim();
    if (Object.prototype.hasOwnProperty.call(meta, 'work_email') || Object.prototype.hasOwnProperty.call(meta, 'email')) existing.email = normalizeEmail(meta.work_email || meta.email);
    if (Object.prototype.hasOwnProperty.call(meta, 'phone')) existing.phone = String(meta.phone || '').trim();
    if (op.displayName || Object.prototype.hasOwnProperty.call(meta, 'display_name')) existing.displayName = String(op.displayName || meta.display_name || `${existing.firstName || ''} ${existing.lastName || ''}`).trim();
    if (meta.temp_password) existing.passwordHash = hashPassword(String(meta.temp_password));
    applyManagerTitle(existing);
    applyDepartments(existing);
    existing.forcePasswordReset = forceResetExplicit !== null ? forceResetExplicit : shouldForceResetFromMeta ? true : existing.forcePasswordReset;
    existing.updatedAt = now;
    logAudit(db, { action: 'user.update', actorUserId: actor.userId, actorName: actor.name, targetType: 'user', targetId: existing.id, details: { wwid: existing.wwid } });
    return;
  }

  if (op.op === 'set_user_status') {
    existing.status = op.status;
    existing.updatedAt = now;
    logAudit(db, { action: 'user.status', actorUserId: actor.userId, actorName: actor.name, targetType: 'user', targetId: existing.id, details: { wwid: existing.wwid, status: existing.status } });
    return;
  }

  if (op.op === 'delete_user') {
    existing.status = 'deleted';
    existing.updatedAt = now;
    logAudit(db, { action: 'user.delete', actorUserId: actor.userId, actorName: actor.name, targetType: 'user', targetId: existing.id, details: { wwid: existing.wwid } });
  }
}

async function upsertBookingRows(db, incomingRequests) {
  if (!Array.isArray(db.bookings)) db.bookings = [];
  const existingById = new Map(db.bookings.map((entry) => [String(entry.id || ''), entry]));
  const published = db.snapshots && db.snapshots.published ? db.snapshots.published : null;
  if (!published || !published.payload) {
    return { ok: false, status: 409, body: { ok: false, message: 'No published snapshot available for booking validation.' } };
  }
  const serverVersion = Math.max(1, toInt(published.version, 1));
  const nextRows = [];

  for (const request of incomingRequests) {
    const current = existingById.get(String((request && request.id) || '')) || {};
    const row = sanitizeBookingRow(request, current);
    const status = bookingStatus(row.status);
    bookingDebugLog('validator_incoming_row', {
      rawIncomingRow: request,
      currentRow: current,
      sanitizedRow: row,
      serverSnapshotVersion: serverVersion,
    });

    if (status === 'deleted') {
      row.updatedAt = nowIso();
      row.revision = Math.max(1, toInt(current.revision, 0) + 1);
      nextRows.push(row);
      continue;
    }

    const isNew = !existingById.has(row.id);
    if (isNew || status === 'pending') {
      const diagnostics = bookingValidationDiagnostics(request, row, serverVersion, published.payload);
      if (!diagnostics.ok) {
        const message = diagnostics.reason === 'snapshot-stale'
          ? `Snapshot is stale for booking ${row.id}. Device=${row.snapshotVersion}, server=${serverVersion}.`
          : `Booking ${row.id} failed validation.`;
        const body = {
          ok: false,
          reason: diagnostics.reason || 'booking-validation-failed',
          code: diagnostics.reason === 'snapshot-stale' ? 'SNAPSHOT_STALE' : 'BOOKING_VALIDATION_FAILED',
          message,
          server_snapshot_version: serverVersion,
          missing_fields: diagnostics.missingFields,
          invalid_fields: diagnostics.invalidFields,
          issues: diagnostics.issues,
          raw_incoming_row: request,
          sanitized_row: row,
        };
        bookingDebugLog('validator_rejection', body);
        return {
          ok: false,
          status: diagnostics.reason === 'snapshot-stale' ? 409 : 400,
          body,
        };
      }
      const pricing = diagnostics.pricing;
      row.authoritativeTotals = pricing;
      row.commissionProfit = pricing.profit;
    } else {
      row.authoritativeTotals = current.authoritativeTotals || {};
      row.commissionProfit = Number(toNum(current.commissionProfit, row.commissionProfit).toFixed(2));
    }

    row.updatedAt = nowIso();
    row.revision = Math.max(1, toInt(current.revision, 0) + 1);
    if (!row.createdAt) row.createdAt = nowIso();
    nextRows.push(row);
  }

  db.bookings = nextRows;
  return { ok: true, rows: db.bookings.filter((entry) => bookingStatus(entry.status) !== 'deleted') };
}

module.exports = {
  sanitizeCatalogPayload,
  sanitizeQuoteLines,
  recomputePricing,
  bookingStatus,
  sanitizeBookingRow,
  bookingLockFromRow,
  normalizeUserOperations,
  applyUserOperation,
  upsertBookingRows,
};
