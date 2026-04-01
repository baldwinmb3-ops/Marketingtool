const { normalizeRole } = require('./lib.cjs');

function toPublicUser(user) {
  if (!user || typeof user !== 'object') return null;
  return {
    id: String(user.id || ''),
    displayName: String(user.displayName || '').trim(),
    firstName: String(user.firstName || '').trim(),
    lastName: String(user.lastName || '').trim(),
    wwid: String(user.wwid || ''),
    email: String(user.email || '').trim().toLowerCase(),
    role: normalizeRole(user.role) || 'marketer',
    isAssistant: !!user.isAssistant,
    canAccessMarketer: !!user.canAccessMarketer,
    canAccessAdmin: !!user.canAccessAdmin,
    canAccessManager: !!user.canAccessManager,
    managerOnly: !!user.managerOnly,
    status: String(user.status || 'active'),
    isLocked: !!user.isLocked,
    createdAt: String(user.createdAt || ''),
    updatedAt: String(user.updatedAt || ''),
  };
}

function deriveAccess(user) {
  const row = user && typeof user === 'object' ? user : {};
  let canAdmin = normalizeRole(row.role) === 'admin' || !!row.canAccessAdmin;
  let canMarketer = normalizeRole(row.role) === 'marketer' || normalizeRole(row.role) === 'admin' || !!row.canAccessMarketer;
  const canManager = !!row.canAccessManager;
  const managerOnly = !!row.managerOnly && !canAdmin;

  if (managerOnly) {
    canAdmin = false;
    canMarketer = false;
  }

  const availableRoles = [];
  if (canAdmin) availableRoles.push('admin');
  if (canMarketer) availableRoles.push('marketer');
  if (!availableRoles.length && canManager) availableRoles.push('manager');

  return {
    availableRoles,
    permissions: {
      publish_catalog: canAdmin,
      manage_admin_updates: canAdmin,
      manage_manager_roster: canAdmin,
      booking_create: canAdmin || canMarketer,
      booking_manage: canAdmin,
      punch_in: canManager,
      view_audit: canAdmin,
      view_catalog: canAdmin || canMarketer || canManager,
    },
  };
}

function buildSessionPayload(user, session) {
  const publicUser = toPublicUser(user);
  if (!publicUser) {
    return {
      isAuthenticated: false,
      role: null,
      availableRoles: [],
      permissions: {},
      user: null,
    };
  }

  const access = deriveAccess(publicUser);
  let activeRole = normalizeRole(session && session.activeRole);
  if (!activeRole || !access.availableRoles.includes(activeRole)) {
    activeRole = access.availableRoles[0] || null;
  }

  return {
    isAuthenticated: true,
    role: activeRole,
    availableRoles: access.availableRoles,
    permissions: access.permissions,
    user: publicUser,
    lastAuthAt: String((session && session.createdAt) || new Date().toISOString()),
  };
}

module.exports = {
  toPublicUser,
  deriveAccess,
  buildSessionPayload,
};
