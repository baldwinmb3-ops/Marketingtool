const {
  nowIso,
  toInt,
  toNum,
  normalizeStatus,
  normalizeAppRole,
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

function applyUserOperation(db, op, actor, logAudit) {
  const users = Array.isArray(db.users) ? db.users : [];
  const existing = users.find((entry) => normalizeWwid(entry.wwid) === op.wwid);
  const meta = op.metadata && typeof op.metadata === 'object' ? op.metadata : {};
  const now = nowIso();
  const forceResetExplicit = typeof op.forcePasswordReset === 'boolean' ? op.forcePasswordReset : null;
  const shouldForceResetFromMeta = !!meta.temp_password;

  function applyRole(target) {
    if (op.role === 'primary_admin') {
      target.role = 'admin';
      target.isAssistant = false;
      target.canAccessMarketer = true;
      target.canAccessAdmin = false;
      target.canAccessManager = true;
      target.managerOnly = false;
      return;
    }
    if (op.role === 'assistant_admin') {
      target.role = 'admin';
      target.isAssistant = true;
      target.canAccessMarketer = true;
      target.canAccessAdmin = false;
      target.canAccessManager = true;
      target.managerOnly = false;
      return;
    }
    target.role = 'marketer';
    target.isAssistant = false;
    target.canAccessMarketer = false;
    target.canAccessAdmin = !!meta.can_access_admin;
    target.canAccessManager = !!meta.can_access_manager;
    target.managerOnly = !!meta.manager_only;
  }

  if (op.op === 'create_user') {
    const target = existing || { id: randomId('user'), createdAt: now, updatedAt: now, status: 'active', isLocked: false, wwid: op.wwid };
    target.wwid = op.wwid;
    target.firstName = String(meta.first_name || target.firstName || '').trim();
    target.lastName = String(meta.last_name || target.lastName || '').trim();
    target.displayName = String(op.displayName || meta.display_name || target.displayName || '').trim() || `${target.firstName} ${target.lastName}`.trim() || 'User';
    target.email = normalizeEmail(meta.work_email || meta.email || target.email || `${op.wwid.toLowerCase()}@example.local`);
    target.passwordHash = hashPassword(String(meta.temp_password || 'Temp123A'));
    applyRole(target);
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
    if (meta.first_name) existing.firstName = String(meta.first_name).trim();
    if (meta.last_name) existing.lastName = String(meta.last_name).trim();
    if (meta.work_email || meta.email) existing.email = normalizeEmail(meta.work_email || meta.email);
    if (op.displayName || meta.display_name) existing.displayName = String(op.displayName || meta.display_name).trim();
    if (meta.temp_password) existing.passwordHash = hashPassword(String(meta.temp_password));
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

    if (status === 'deleted') {
      row.updatedAt = nowIso();
      row.revision = Math.max(1, toInt(current.revision, 0) + 1);
      nextRows.push(row);
      continue;
    }

    const isNew = !existingById.has(row.id);
    if (isNew || status === 'pending') {
      if (row.snapshotVersion !== serverVersion) {
        return {
          ok: false,
          status: 409,
          body: {
            ok: false,
            reason: 'snapshot-stale',
            code: 'SNAPSHOT_STALE',
            message: `Snapshot is stale for booking ${row.id}. Device=${row.snapshotVersion}, server=${serverVersion}.`,
            server_snapshot_version: serverVersion,
          },
        };
      }
      const pricing = recomputePricing(published.payload, row.quoteLines);
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
