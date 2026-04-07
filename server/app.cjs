const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const path = require('path');

const {
  nowIso,
  toInt,
  normalizeRole,
  normalizeStatus,
  normalizeIdentifier,
  normalizeEmail,
  verifyPassword,
  hashPassword,
  randomId,
} = require('./lib.cjs');
const {
  createSeedDb,
  createPoolFromEnv,
  initDatabase,
  readDb,
  withDb,
  listUsers,
  findUserByIdentifier,
  findUserRowByIdentifier,
  mapUserToState,
  logAudit,
  logBookingEvent,
  createSessionRecord,
  getSessionRecord,
  updateSessionRecordRole,
  revokeSessionRecord,
  updateUserPassword,
} = require('./db.cjs');
const { deriveAccess, buildSessionPayload } = require('./authz.cjs');
const { latestValidatedBackup } = require('./backup-safety.cjs');
const {
  sanitizeCatalogPayload,
  recomputePricing,
  bookingStatus,
  sanitizeBookingRow,
  bookingLockFromRow,
  normalizeUserOperations,
  applyUserOperation,
  upsertBookingRows,
} = require('./domain.cjs');

const SESSION_COOKIE = 'mt_session';
const DEFAULT_SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const DEFAULT_CORS_ORIGIN_RULES = [
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'https://marketingtool-mocha.vercel.app',
  'https://marketingtool-mocha-*.vercel.app',
];

function extractSessionIdFromRequest(req) {
  const cookieSession = String((req.cookies && req.cookies[SESSION_COOKIE]) || '').trim();
  if (cookieSession) return cookieSession;

  const authHeader = String((req.headers && req.headers.authorization) || '').trim();
  if (/^Bearer\s+/i.test(authHeader)) {
    const bearer = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (bearer) return bearer;
  }

  const headerSession = String((req.headers && req.headers['x-session-id']) || '').trim();
  if (headerSession) return headerSession;

  return '';
}

function parseCookieSameSite(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'none') return 'none';
  if (raw === 'strict') return 'strict';
  return 'lax';
}

function parseTrustProxy(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (['1', 'true', 'yes', 'y', 'on'].includes(raw)) return 1;
  if (['0', 'false', 'no', 'n', 'off'].includes(raw)) return false;
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
  return String(value || '').trim();
}

function normalizeCorsOriginRule(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function parseCorsOriginRules(value) {
  const source = String(value || '').trim();
  const rawRules = source ? source.split(',') : DEFAULT_CORS_ORIGIN_RULES.slice();
  return rawRules.map((item) => normalizeCorsOriginRule(item)).filter(Boolean);
}

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function corsOriginMatches(rule, origin) {
  const normalizedRule = normalizeCorsOriginRule(rule);
  const normalizedOrigin = normalizeCorsOriginRule(origin);
  if (!normalizedRule || !normalizedOrigin) return false;
  if (normalizedRule === '*') return true;
  if (!normalizedRule.includes('*')) return normalizedRule === normalizedOrigin;
  const pattern = `^${normalizedRule.split('*').map((part) => escapeRegExp(part)).join('.*')}$`;
  return new RegExp(pattern, 'i').test(normalizedOrigin);
}

async function createApp(options = {}) {
  const app = express();
  const db = options.db || createPoolFromEnv(options.dbOptions || {});
  const ownsDbPool = !options.db;
  const runtimeInfo =
    options.runtimeInfo && typeof options.runtimeInfo === 'object' && !Array.isArray(options.runtimeInfo)
      ? options.runtimeInfo
      : {};
  const sessionTtlMs = Math.max(60_000, toInt(process.env.APP_SESSION_TTL_MS, DEFAULT_SESSION_TTL_MS));
  const cookieSameSite = parseCookieSameSite(process.env.APP_COOKIE_SAME_SITE || 'lax');
  const cookieSecureFromEnv = String(process.env.APP_COOKIE_SECURE || '').trim().toLowerCase() === 'true';
  const cookieSecure = cookieSameSite === 'none' ? true : cookieSecureFromEnv;
  const trustProxy = parseTrustProxy(process.env.APP_TRUST_PROXY);
  const corsOrigins = parseCorsOriginRules(process.env.APP_CORS_ORIGIN);
  if (trustProxy !== null) {
    app.set('trust proxy', trustProxy);
  }
  if (options.initializeDatabase !== false) {
    const initOptions = Object.prototype.hasOwnProperty.call(options, 'seedDatabase')
      ? { seed: options.seedDatabase }
      : {};
    await initDatabase(db, initOptions);
  }

  const appVersion = String(process.env.APP_VERSION || `dev-${Date.now()}`);

  function latestLocalBackupSummary() {
    try {
      const latest = latestValidatedBackup(path.join(process.cwd(), 'backups', 'users'));
      if (!latest) return null;
      return {
        exportedAt: String(latest.exportedAt || '').trim(),
        validatedAt: String(latest.validatedAt || '').trim(),
        file: String(latest.jsonPath || '').trim(),
        counts: latest.counts || {},
      };
    } catch {
      return null;
    }
  }

  function runtimeSnapshot() {
    const snapshot = {
      mode: String(runtimeInfo.mode || (ownsDbPool ? 'postgres' : 'custom')).trim() || 'custom',
      persistence: String(runtimeInfo.persistence || (ownsDbPool ? 'Postgres' : 'Custom')).trim() || 'Custom',
      degraded: !!runtimeInfo.degraded,
    };
    if (runtimeInfo.reason) snapshot.reason = String(runtimeInfo.reason);
    if (runtimeInfo.fallbackTriggeredAt) snapshot.fallbackTriggeredAt = String(runtimeInfo.fallbackTriggeredAt);
    const latestBackup = latestLocalBackupSummary();
    if (latestBackup) snapshot.latestBackup = latestBackup;
    return snapshot;
  }

  app.use(
    cors({
      credentials: true,
      origin(origin, callback) {
        if (!origin || corsOrigins.some((rule) => corsOriginMatches(rule, origin))) {
          callback(null, true);
          return;
        }
        callback(new Error('Origin not allowed by CORS'));
      },
    }),
  );
  app.use(express.json({ limit: '4mb' }));
  app.use(cookieParser(String(process.env.APP_SESSION_SECRET || 'local-dev-secret')));

  function setSessionCookie(res, sessionId) {
    res.cookie(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: cookieSameSite,
      secure: cookieSecure,
      maxAge: sessionTtlMs,
      path: '/',
    });
  }

  function clearSessionCookie(res) {
    res.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      sameSite: cookieSameSite,
      secure: cookieSecure,
      path: '/',
    });
  }

  async function createSession(userId, activeRole) {
    const session = await createSessionRecord(db, { userId, activeRole, ttlMs: sessionTtlMs });
    return session.id;
  }

  async function getSession(sessionId) {
    return getSessionRecord(db, sessionId, { ttlMs: sessionTtlMs });
  }

  async function destroySession(sessionId) {
    await revokeSessionRecord(db, sessionId);
  }

  async function authContext(req) {
    const sessionId = extractSessionIdFromRequest(req);
    const session = await getSession(sessionId);
    if (!session) return { session: null, user: null, payload: buildSessionPayload(null, null) };
    const user = session.user;
    if (!user || String(user.status || 'active').toLowerCase() !== 'active') {
      await destroySession(sessionId);
      return { session: null, user: null, payload: buildSessionPayload(null, null) };
    }
    return { session, user, payload: buildSessionPayload(user, session) };
  }

  async function attachAuth(req, _res, next) {
    try {
      req.auth = await authContext(req);
      next();
    } catch (error) {
      next(error);
    }
  }

  function requireSession(req, res, next) {
    if (!req.auth || !req.auth.payload || !req.auth.payload.isAuthenticated) {
      res.status(401).json({ ok: false, code: 'UNAUTHORIZED', message: 'Sign in is required.' });
      return;
    }
    next();
  }

  function requirePermission(permission) {
    return (req, res, next) => {
      const perms =
        req.auth && req.auth.payload && req.auth.payload.permissions && typeof req.auth.payload.permissions === 'object'
          ? req.auth.payload.permissions
          : {};
      if (!perms[permission]) {
        res.status(403).json({ ok: false, code: 'FORBIDDEN', message: `Missing permission: ${permission}` });
        return;
      }
      next();
    };
  }

  function mapUserForClient(user) {
    if (!user || typeof user !== 'object') return null;
    const status = normalizeStatus(user.status || 'active');
    const normalizedRole = normalizeRole(user.role || 'marketer');
    return {
      id: String(user.id || ''),
      name: String(user.displayName || `${user.firstName || ''} ${user.lastName || ''}`).trim() || 'User',
      firstName: String(user.firstName || '').trim(),
      lastName: String(user.lastName || '').trim(),
      wwid: String(user.wwid || '').trim(),
      workEmail: String(user.email || '').trim().toLowerCase(),
      emailOrLogin: String(user.email || '').trim().toLowerCase(),
      phoneNumber: String(user.phoneNumber || user.phone || '').trim(),
      role: normalizedRole,
      isAssistant: !!user.isAssistant,
      canAccessMarketer: !!user.canAccessMarketer,
      canAccessAdmin: !!user.canAccessAdmin,
      canAccessManager: !!user.canAccessManager,
      managerOnly: !!user.managerOnly,
      departmentIds: Array.isArray(user.departmentIds) ? user.departmentIds.map((entry) => String(entry || '').trim()).filter(Boolean) : [],
      active: status === 'active',
      status,
      isLocked: !!user.isLocked,
      forcePasswordReset: !!user.forcePasswordReset,
      createdAt: String(user.createdAt || ''),
      updatedAt: String(user.updatedAt || ''),
    };
  }

  function requestPermissions(req) {
    return req && req.auth && req.auth.payload && req.auth.payload.permissions && typeof req.auth.payload.permissions === 'object'
      ? req.auth.payload.permissions
      : {};
  }

  function managerUserOperationRestrictionMessage(userOps) {
    const list = Array.isArray(userOps) ? userOps : [];
    for (const op of list) {
      const row = op && typeof op === 'object' ? op : {};
      const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata : {};
      const role = String(row.role || '').trim().toLowerCase();
      if (!['create_user', 'update_user', 'set_user_status'].includes(String(row.op || '').trim().toLowerCase())) {
        return 'Managers can only create or update marketer accounts.';
      }
      if (role !== 'marketer') {
        return 'Managers can only sync marketer accounts.';
      }
      if (
        !!metadata.can_access_admin ||
        !!metadata.canAccessAdmin ||
        !!metadata.can_access_manager ||
        !!metadata.canAccessManager ||
        !!metadata.manager_only ||
        !!metadata.managerOnly ||
        !!metadata.is_assistant ||
        !!metadata.isAssistant
      ) {
        return 'Managers cannot grant admin or manager access while syncing marketers.';
      }
    }
    return '';
  }

  function userSupportsVerificationRole(user, requestedRole) {
    const row = user && typeof user === 'object' ? user : {};
    const baseRole = normalizeRole(row.role) || 'marketer';
    if (requestedRole === 'admin') {
      return baseRole === 'admin' || !!row.canAccessAdmin;
    }
    if (requestedRole === 'marketer') {
      return baseRole === 'marketer' || !!row.canAccessMarketer;
    }
    if (requestedRole === 'manager') {
      return !!row.canAccessManager;
    }
    return false;
  }

  async function signInCore(identifier, password, requestedRole) {
    const row = await findUserRowByIdentifier(db, identifier, requestedRole);
    if (!row) {
      return {
        status: 401,
        body: { ok: false, message: 'No active account matched this WWID/work email.' },
        user: null,
        activeRole: null,
      };
    }
    const user = mapUserToState(row);
    if (user.isLocked) {
      return {
        status: 403,
        body: { ok: false, message: 'This account is locked. Contact admin support.' },
        user: null,
        activeRole: null,
      };
    }
    if (!verifyPassword(password, user.passwordHash)) {
      return {
        status: 401,
        body: { ok: false, message: 'Password did not match.' },
        user: null,
        activeRole: null,
      };
    }
    const access = deriveAccess(user);
    if (!access.availableRoles.length) {
      return {
        status: 403,
        body: { ok: false, message: 'This account has no enabled roles.' },
        user: null,
        activeRole: null,
      };
    }
    const activeRole = requestedRole && access.availableRoles.includes(requestedRole) ? requestedRole : access.availableRoles[0];
    return { status: 200, body: { ok: true, message: `Signed in as ${activeRole}.` }, user, activeRole };
  }

  async function switchSessionRoleCore(req, requestedRole) {
    const nextRole = normalizeRole(requestedRole);
    if (!nextRole) {
      return {
        status: 400,
        body: { ok: false, message: 'Role is required.' },
        user: null,
        sessionId: '',
        payload: buildSessionPayload(null, null),
      };
    }
    const currentSession = req && req.auth && req.auth.session ? req.auth.session : null;
    const currentUser = req && req.auth && req.auth.user ? req.auth.user : null;
    if (!currentSession || !currentUser) {
      return {
        status: 401,
        body: { ok: false, message: 'Sign in is required.' },
        user: null,
        sessionId: '',
        payload: buildSessionPayload(null, null),
      };
    }

    const identifiers = [
      normalizeIdentifier(currentUser.email || ''),
      normalizeIdentifier(currentUser.wwid || ''),
      normalizeIdentifier(req && req.body && req.body.identifier),
    ].filter(Boolean);

    let targetRow = null;
    for (const identifier of identifiers) {
      targetRow = await findUserRowByIdentifier(db, identifier, nextRole);
      if (targetRow) break;
    }

    let targetUser = targetRow ? mapUserToState(targetRow) : null;
    if (!targetUser) {
      const currentAccess = deriveAccess(currentUser);
      if (Array.isArray(currentAccess.availableRoles) && currentAccess.availableRoles.includes(nextRole)) {
        targetUser = currentUser;
      }
    }
    if (!targetUser) {
      return {
        status: 403,
        body: { ok: false, message: `This account cannot switch to ${nextRole}.` },
        user: null,
        sessionId: '',
        payload: buildSessionPayload(null, null),
      };
    }

    const access = deriveAccess(targetUser);
    if (!Array.isArray(access.availableRoles) || !access.availableRoles.includes(nextRole)) {
      return {
        status: 403,
        body: { ok: false, message: `This account cannot switch to ${nextRole}.` },
        user: null,
        sessionId: '',
        payload: buildSessionPayload(null, null),
      };
    }

    const updatedSession = await updateSessionRecordRole(db, currentSession.id, nextRole);
    if (!updatedSession) {
      return {
        status: 401,
        body: { ok: false, message: 'Sign in is required.' },
        user: null,
        sessionId: '',
        payload: buildSessionPayload(null, null),
      };
    }
    const sessionId = String(updatedSession.id || currentSession.id || '').trim();
    const payload = buildSessionPayload(targetUser, { activeRole: nextRole, createdAt: updatedSession.createdAt || currentSession.createdAt || nowIso() });
    return {
      status: 200,
      body: {
        ok: true,
        message: `Switched to ${nextRole}.`,
        session: payload,
        session_id: sessionId,
        session_transport: 'cookie_or_bearer',
        session_ttl_ms: sessionTtlMs,
        available_roles: Array.isArray(payload.availableRoles) ? payload.availableRoles : [],
      },
      user: targetUser,
      sessionId,
      payload,
    };
  }

  async function verifyUserLoginStateCore(input = {}) {
    const src = input && typeof input === 'object' ? input : {};
    const requestedRole = normalizeRole(src.role) || 'marketer';
    const identifier =
      normalizeIdentifier(src.identifier || src.wwid || src.expected_wwid || src.expected_email || src.email || '') || '';
    const expectedWwid = normalizeIdentifier(src.expected_wwid || src.wwid || '') || '';
    const expectedEmail = normalizeEmail(src.expected_email || src.email || '');
    const expectedPassword = String(src.expected_password || src.password || '').trim();
    const expectedForcePasswordReset =
      typeof src.expected_force_password_reset === 'boolean' ? src.expected_force_password_reset : null;
    const row = identifier ? await findUserRowByIdentifier(db, identifier, requestedRole) : null;
    const user = row ? mapUserToState(row) : null;
    const checks = {
      user_exists: !!user,
      role_match: !!user,
      wwid_match: !expectedWwid,
      email_match: !expectedEmail,
      force_password_reset_match: expectedForcePasswordReset === null,
      password_match: !expectedPassword,
    };
    const failures = [];
    if (!user) {
      failures.push({ code: 'MISSING_USER', message: 'Cloud user was not found for this WWID/work email.' });
      return {
        ok: true,
        ready: false,
        verification_state: 'repair_required',
        message: failures[0].message,
        checks,
        failures,
        user: null,
      };
    }
    checks.role_match = userSupportsVerificationRole(user, requestedRole);
    if (!checks.role_match) {
      failures.push({ code: 'ROLE_MISMATCH', message: `Cloud account is not enabled for ${requestedRole}.` });
    }
    if (expectedWwid) {
      checks.wwid_match = String(user.wwid || '').trim().toUpperCase() === String(expectedWwid).trim().toUpperCase();
      if (!checks.wwid_match) {
        failures.push({ code: 'WWID_MISMATCH', message: 'Cloud WWID does not match the admin record.' });
      }
    }
    if (expectedEmail) {
      checks.email_match = normalizeEmail(user.email || '') === expectedEmail;
      if (!checks.email_match) {
        failures.push({ code: 'EMAIL_MISMATCH', message: 'Cloud work email does not match the admin record.' });
      }
    }
    if (expectedForcePasswordReset !== null) {
      checks.force_password_reset_match = !!user.forcePasswordReset === !!expectedForcePasswordReset;
      if (!checks.force_password_reset_match) {
        failures.push({ code: 'FORCE_RESET_MISMATCH', message: 'Cloud reset-required flag does not match the admin record.' });
      }
    }
    if (expectedPassword) {
      checks.password_match = verifyPassword(expectedPassword, user.passwordHash);
      if (!checks.password_match) {
        failures.push({ code: 'TEMP_PASSWORD_MISMATCH', message: 'Cloud temp password does not match the admin card.' });
      }
    }
    const verificationState = failures.length ? 'drift_detected' : 'cloud_ready';
    return {
      ok: true,
      ready: verificationState === 'cloud_ready',
      verification_state: verificationState,
      message: failures.length ? failures[0].message : 'Cloud login state verified.',
      checks,
      failures,
      user: {
        user_id: user.id,
        role: requestedRole,
        app_role: user.isAssistant ? 'assistant_admin' : user.role === 'admin' ? 'primary_admin' : 'marketer',
        status: user.status,
        force_password_reset: !!user.forcePasswordReset,
        first_name: user.firstName,
        last_name: user.lastName,
        display_name: user.displayName,
        work_email: user.email,
        wwid: user.wwid,
        cloud_account_state: verificationState === 'cloud_ready' ? 'ready' : 'drift',
        created_at: user.createdAt,
        updated_at: user.updatedAt,
      },
    };
  }

  app.use(attachAuth);

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'marketingtool-backend', at: nowIso(), version: appVersion, runtime: runtimeSnapshot() });
  });

  app.get('/api/users', requireSession, async (req, res, next) => {
    try {
      const permissions = requestPermissions(req);
      const canAdmin = !!permissions.manage_admin_updates;
      const canManager = !!permissions.manage_marketer_users;
      if (!canAdmin && !canManager) {
        res.status(403).json({ ok: false, code: 'FORBIDDEN', message: 'Missing permission: manage_marketer_users' });
        return;
      }
      const rows = await listUsers(db);
      let users = Array.isArray(rows) ? rows.map(mapUserForClient).filter(Boolean) : [];
      if (!canAdmin) {
        users = users.filter((user) => normalizeRole(user && user.role) === 'marketer');
      }
      res.json({ ok: true, users });
    } catch (error) {
      next(error);
    }
  });

  app.get('/version.json', (_req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.json({ ok: true, version: appVersion, updatedAt: nowIso(), runtime: runtimeSnapshot() });
  });

  app.post('/api/auth/sign-in', async (req, res, next) => {
    try {
      const identifier = normalizeIdentifier(req.body && req.body.identifier);
      const password = String((req.body && req.body.password) || '');
      const requestedRole = normalizeRole(req.body && req.body.role);
      if (!identifier || !password) {
        res.status(400).json({ ok: false, message: 'WWID/work email and password are required.' });
        return;
      }
      const signIn = await signInCore(identifier, password, requestedRole);
      if (!signIn.body.ok || !signIn.user) {
        res.status(signIn.status).json(signIn.body);
        return;
      }
      const sessionId = await createSession(signIn.user.id, signIn.activeRole);
      setSessionCookie(res, sessionId);
      await withDb(db, async (state) => {
        logAudit(state, {
          action: 'auth.sign_in',
          actorUserId: signIn.user.id,
          actorName: signIn.user.displayName,
          targetType: 'session',
          targetId: sessionId,
          details: { activeRole: signIn.activeRole },
        });
      });
      const payload = buildSessionPayload(signIn.user, { activeRole: signIn.activeRole, createdAt: nowIso() });
      res.json({ ok: true, message: signIn.body.message, session: payload, permissions: payload.permissions, session_id: sessionId, session_transport: 'cookie_or_bearer', session_ttl_ms: sessionTtlMs });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/auth/session', (req, res) => {
    if (!req.auth || !req.auth.payload || !req.auth.payload.isAuthenticated) {
      res.json({ ok: true, session: buildSessionPayload(null, null) });
      return;
    }
    res.json({ ok: true, session: req.auth.payload });
  });

  app.post('/api/auth/switch-role', requireSession, async (req, res, next) => {
    try {
      const requestedRole = normalizeRole(req.body && req.body.role);
      const result = await switchSessionRoleCore(req, requestedRole);
      if (result.sessionId) setSessionCookie(res, result.sessionId);
      if (result.status === 200 && result.user) {
        await withDb(db, async (state) => {
          logAudit(state, {
            action: 'auth.switch_role',
            actorUserId: result.user.id,
            actorName: result.user.displayName,
            targetType: 'session',
            targetId: result.sessionId,
            details: { activeRole: requestedRole },
          });
        });
      }
      res.status(result.status).json(result.body);
    } catch (error) {
      next(error);
    }
  });

  async function handleSignOut(req, res) {
    const sessionId = (req.auth && req.auth.session && String(req.auth.session.id || '').trim()) || extractSessionIdFromRequest(req);
    if (sessionId) await destroySession(sessionId);
    clearSessionCookie(res);
    res.json({ ok: true });
  }

  app.post('/api/auth/sign-out', handleSignOut);
  // Backward-compatible alias for older clients.
  app.post('/api/auth/signout', handleSignOut);

  app.get('/api/snapshots/published/latest', requireSession, requirePermission('view_catalog'), async (_req, res) => {
    const state = await readDb(db);
    const published = state.snapshots && state.snapshots.published ? state.snapshots.published : null;
    if (!published) {
      res.status(404).json({ ok: false, message: 'No published snapshot found.' });
      return;
    }
    res.json({ ok: true, metadata: { version: toInt(published.version, 1), publishedAt: published.publishedAt, updatedAt: published.updatedAt }, snapshot: published.payload });
  });

  app.get('/api/snapshots/published/:version', requireSession, requirePermission('view_catalog'), async (req, res) => {
    const version = Math.max(1, toInt(req.params.version, 0));
    const state = await readDb(db);
    const history = state.snapshots && Array.isArray(state.snapshots.history) ? state.snapshots.history : [];
    const found = history.find((entry) => toInt(entry.version, 0) === version);
    if (!found) {
      res.status(404).json({ ok: false, message: `Snapshot version ${version} was not found.` });
      return;
    }
    res.json({ ok: true, metadata: { version, publishedAt: found.publishedAt, updatedAt: found.updatedAt }, snapshot: found.payload });
  });

  app.post('/api/admin/catalog/draft', requireSession, requirePermission('manage_admin_updates'), async (req, res, next) => {
    try {
      const payload = sanitizeCatalogPayload(req.body && req.body.payload);
      await withDb(db, async (db) => {
        if (!db.snapshots || typeof db.snapshots !== 'object') db.snapshots = {};
        db.snapshots.draft = { updatedAt: nowIso(), updatedByUserId: req.auth.user.id, payload };
        logAudit(db, { action: 'catalog.draft_save', actorUserId: req.auth.user.id, actorName: req.auth.user.displayName, targetType: 'snapshot_draft', targetId: 'draft', details: {} });
      });
      res.json({ ok: true, message: 'Draft saved.' });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/admin/publish', requireSession, requirePermission('publish_catalog'), async (req, res, next) => {
    try {
      await withDb(db, async (db) => {
        if (!db.snapshots || typeof db.snapshots !== 'object') db.snapshots = {};
        const currentPublished = db.snapshots.published || { version: 0, payload: createSeedDb().snapshots.published.payload };
        const payload = req.body && req.body.payload ? sanitizeCatalogPayload(req.body.payload) : db.snapshots.draft && db.snapshots.draft.payload ? sanitizeCatalogPayload(db.snapshots.draft.payload) : sanitizeCatalogPayload(currentPublished.payload);
        const nextVersion = Math.max(1, toInt(currentPublished.version, 0) + 1);
        const stamp = nowIso();
        payload.meta = payload.meta && typeof payload.meta === 'object' ? payload.meta : {};
        payload.meta.version = nextVersion;
        payload.meta.publishedAt = stamp;
        payload.meta.updatedAt = stamp;
        const nextPublished = { version: nextVersion, publishedAt: stamp, updatedAt: stamp, publishedByUserId: req.auth.user.id, payload };
        db.snapshots.published = nextPublished;
        if (!Array.isArray(db.snapshots.history)) db.snapshots.history = [];
        db.snapshots.history.push(nextPublished);
        db.snapshots.draft = { updatedAt: stamp, updatedByUserId: req.auth.user.id, payload };
        logAudit(db, { action: 'catalog.publish', actorUserId: req.auth.user.id, actorName: req.auth.user.displayName, targetType: 'snapshot', targetId: String(nextVersion), details: { version: nextVersion } });
        res.json({ ok: true, version: nextVersion, published_at: stamp, metadata: { version: nextVersion, publishedAt: stamp, updatedAt: stamp }, snapshot: payload });
      });
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/bookings', requireSession, async (_req, res) => {
    const state = await readDb(db);
    const rows = Array.isArray(state.bookings)
      ? state.bookings.filter((row) => bookingStatus(row.status) !== 'deleted')
      : [];
    res.json({ ok: true, bookings: rows });
  });

  app.post('/api/bookings', requireSession, requirePermission('booking_create'), async (req, res, next) => {
    try {
      let responseStatus = 201;
      let responseBody = null;
      await withDb(db, async (db) => {
        if (!Array.isArray(db.bookings)) db.bookings = [];
        const published = db.snapshots && db.snapshots.published ? db.snapshots.published : null;
        if (!published || !published.payload) {
          responseStatus = 409;
          responseBody = {
            ok: false,
            code: 'NO_PUBLISHED_SNAPSHOT',
            message: 'No published snapshot is available.',
          };
          return;
        }
        const incoming = sanitizeBookingRow(req.body || {}, {});
        const serverVersion = Math.max(1, toInt(published.version, 1));
        if (incoming.snapshotVersion !== serverVersion) {
          responseStatus = 409;
          responseBody = {
            ok: false,
            code: 'SNAPSHOT_STALE',
            message: `Snapshot is stale. Device=${incoming.snapshotVersion}, server=${serverVersion}.`,
            server_snapshot_version: serverVersion,
          };
          return;
        }
        const existing = db.bookings.find((row) => String(row.id || '') === incoming.id && bookingStatus(row.status) !== 'deleted');
        if (existing) {
          responseStatus = 409;
          responseBody = { ok: false, code: 'BOOKING_EXISTS', message: 'Booking already exists.' };
          return;
        }
        const pricing = recomputePricing(published.payload, incoming.quoteLines);
        const stamp = nowIso();
        incoming.authoritativeTotals = pricing;
        incoming.commissionProfit = pricing.profit;
        incoming.status = 'pending';
        incoming.statusAt = stamp;
        incoming.createdAt = stamp;
        incoming.updatedAt = stamp;
        incoming.revision = 1;
        db.bookings.push(incoming);
        logAudit(db, { action: 'booking.create', actorUserId: req.auth.user.id, actorName: req.auth.user.displayName, targetType: 'booking', targetId: incoming.id, details: { snapshotVersion: incoming.snapshotVersion, authoritativeTotals: pricing } });
        logBookingEvent(db, {
          bookingId: incoming.id,
          eventType: 'booking.create',
          actorUserId: req.auth.user.id,
          actorName: req.auth.user.displayName,
          details: { snapshotVersion: incoming.snapshotVersion, authoritativeTotals: pricing },
        });
        responseStatus = 201;
        responseBody = { ok: true, booking: incoming };
      });
      if (responseBody) {
        res.status(responseStatus).json(responseBody);
        return;
      }
      res.status(500).json({ ok: false, message: 'Booking write completed without response payload.' });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/bookings/:id/claim', requireSession, requirePermission('booking_manage'), async (req, res, next) => {
    try {
      await withDb(db, async (db) => {
        const bookingId = String(req.params.id || '').trim();
        const rows = Array.isArray(db.bookings) ? db.bookings : [];
        const found = rows.find((row) => String(row.id || '') === bookingId && bookingStatus(row.status) !== 'deleted');
        if (!found) {
          res.status(404).json({ ok: false, reason: 'missing', message: 'Booking request was not found.' });
          return;
        }
        const status = bookingStatus(found.status);
        const actorName = String(req.auth.user.displayName || '').trim() || 'Admin';
        const actorUserId = String(req.auth.user.id || '').trim();
        const actorDevice = String((req.body && req.body.actor_device) || 'web').trim();
        if (status === 'done') {
          res.status(409).json({ ok: false, reason: 'already-done', message: 'Request is already done.', lock: bookingLockFromRow(found) });
          return;
        }
        if (status === 'working' && String(found.workingByUserId || '') && String(found.workingByUserId || '') !== actorUserId) {
          res.status(409).json({ ok: false, reason: 'owner-locked', message: `Already claimed by ${String(found.workingByName || 'another admin')}.`, lock: bookingLockFromRow(found) });
          return;
        }
        const stamp = nowIso();
        found.status = 'working';
        found.adminName = actorName;
        found.adminUserId = actorUserId;
        found.adminDevice = actorDevice;
        found.workingByName = actorName;
        found.workingByUserId = actorUserId;
        found.workingByDevice = actorDevice;
        found.workingAt = stamp;
        found.statusAt = stamp;
        found.updatedAt = stamp;
        found.revision = Math.max(1, toInt(found.revision, 1) + 1);
        logAudit(db, { action: 'booking.claim', actorUserId, actorName, targetType: 'booking', targetId: found.id, details: {} });
        logBookingEvent(db, {
          bookingId: found.id,
          eventType: 'booking.claim',
          actorUserId,
          actorName,
          details: { actorDevice },
        });
        res.json({ ok: true, message: 'Request claimed.', lock: bookingLockFromRow(found) });
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/bookings/:id/complete', requireSession, requirePermission('booking_manage'), async (req, res, next) => {
    try {
      await withDb(db, async (db) => {
        const bookingId = String(req.params.id || '').trim();
        const rows = Array.isArray(db.bookings) ? db.bookings : [];
        const found = rows.find((row) => String(row.id || '') === bookingId && bookingStatus(row.status) !== 'deleted');
        if (!found) {
          res.status(404).json({ ok: false, reason: 'missing', message: 'Booking request was not found.' });
          return;
        }
        const status = bookingStatus(found.status);
        const actorName = String(req.auth.user.displayName || '').trim() || 'Admin';
        const actorUserId = String(req.auth.user.id || '').trim();
        const actorDevice = String((req.body && req.body.actor_device) || 'web').trim();
        if (status === 'done') {
          res.status(409).json({ ok: false, reason: 'already-done', message: 'Request is already done.', lock: bookingLockFromRow(found) });
          return;
        }
        if (status !== 'working') {
          res.status(409).json({ ok: false, reason: 'missing-owner', message: 'Mark request as Working first.' });
          return;
        }
        if (String(found.workingByUserId || '') && String(found.workingByUserId || '') !== actorUserId) {
          res.status(409).json({ ok: false, reason: 'owner-only-done', message: `Only ${String(found.workingByName || 'the assigned admin')} can mark Done.`, lock: bookingLockFromRow(found) });
          return;
        }
        const stamp = nowIso();
        found.status = 'done';
        found.completedByName = actorName;
        found.completedByUserId = actorUserId;
        found.completedByDevice = actorDevice;
        found.completedAt = stamp;
        found.statusAt = stamp;
        found.updatedAt = stamp;
        found.revision = Math.max(1, toInt(found.revision, 1) + 1);
        logAudit(db, { action: 'booking.complete', actorUserId, actorName, targetType: 'booking', targetId: found.id, details: {} });
        logBookingEvent(db, {
          bookingId: found.id,
          eventType: 'booking.complete',
          actorUserId,
          actorName,
          details: { actorDevice },
        });
        res.json({ ok: true, message: 'Request marked done.', lock: bookingLockFromRow(found) });
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/bookings/:id/release', requireSession, requirePermission('booking_manage'), async (req, res, next) => {
    try {
      await withDb(db, async (db) => {
        const bookingId = String(req.params.id || '').trim();
        const rows = Array.isArray(db.bookings) ? db.bookings : [];
        const found = rows.find((row) => String(row.id || '') === bookingId && bookingStatus(row.status) !== 'deleted');
        if (!found) {
          res.status(404).json({ ok: false, reason: 'missing', message: 'Booking request was not found.' });
          return;
        }
        const status = bookingStatus(found.status);
        const actorUserId = String(req.auth.user.id || '').trim();
        if (status === 'done') {
          res.status(409).json({ ok: false, reason: 'already-done', message: 'Done requests cannot be released.' });
          return;
        }
        if (status === 'working' && String(found.workingByUserId || '') && String(found.workingByUserId || '') !== actorUserId) {
          res.status(409).json({ ok: false, reason: 'owner-only-release', message: 'Only the current owner can release this booking.' });
          return;
        }
        found.status = 'pending';
        found.adminName = '';
        found.adminUserId = '';
        found.adminDevice = '';
        found.workingByName = '';
        found.workingByUserId = '';
        found.workingByDevice = '';
        found.workingAt = '';
        found.completedByName = '';
        found.completedByUserId = '';
        found.completedByDevice = '';
        found.completedAt = '';
        found.statusAt = nowIso();
        found.updatedAt = nowIso();
        found.revision = Math.max(1, toInt(found.revision, 1) + 1);
        logAudit(db, { action: 'booking.release', actorUserId, actorName: req.auth.user.displayName, targetType: 'booking', targetId: found.id, details: {} });
        logBookingEvent(db, {
          bookingId: found.id,
          eventType: 'booking.release',
          actorUserId,
          actorName: req.auth.user.displayName,
          details: {},
        });
        res.json({ ok: true, message: 'Booking ownership released.' });
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/audit', requireSession, requirePermission('view_audit'), async (_req, res) => {
    const state = await readDb(db);
    const rows = Array.isArray(state.audit) ? state.audit.slice().reverse() : [];
    res.json({ ok: true, entries: rows.slice(0, 400) });
  });

  app.post('/api/cloud', async (req, res, next) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const actionRaw = String(body.action || '').trim().toLowerCase();
      const action = actionRaw === 'save_and_sync' ? 'save_and_send' : actionRaw;

      if (action === 'health_check') {
        res.json({ ok: true, configured: true, message: 'Cloud API reachable.' });
        return;
      }
      if (action === 'auth_lookup') {
        const identifier = normalizeIdentifier(body.identifier);
        if (!identifier) {
          res.json({ ok: true, found: false, account_state: 'missing', message: 'Identifier is required.' });
          return;
        }
        const requestedRole = normalizeRole(body.role);
        const row = await findUserRowByIdentifier(db, identifier, requestedRole);
        const user = row ? mapUserToState(row) : null;
        if (!user) {
          res.json({ ok: true, found: false, account_state: 'missing', message: 'No account matched that role and login.' });
          return;
        }
        res.json({ ok: true, found: true, account_state: 'ready', message: 'Cloud account found.', user: { role: requestedRole || 'marketer', status: user.status, force_password_reset: !!user.forcePasswordReset, cloud_account_state: 'ready', wwid: user.wwid, work_email: user.email, updated_at: user.updatedAt } });
        return;
      }
      if (action === 'verify_user_login_state') {
        const permissions = requestPermissions(req);
        const canAdmin = !!permissions.manage_admin_updates;
        const canManager = !!permissions.manage_marketer_users;
        const requestedRole = normalizeRole(body.role) || 'marketer';
        if (!canAdmin && !canManager) {
          res.status(403).json({ ok: false, message: 'Only admins and managers can verify cloud user login state.' });
          return;
        }
        if (!canAdmin && requestedRole !== 'marketer') {
          res.status(403).json({ ok: false, message: 'Managers can only verify marketer cloud login state.' });
          return;
        }
        const verification = await verifyUserLoginStateCore(body);
        res.status(200).json(verification);
        return;
      }
      if (action === 'auth_sign_in') {
        const signIn = await signInCore(normalizeIdentifier(body.identifier), String(body.password || ''), normalizeRole(body.role));
        if (!signIn.body.ok || !signIn.user) {
          res.status(200).json({ ok: false, hard_fail: true, message: signIn.body.message });
          return;
        }
        const sessionId = await createSession(signIn.user.id, signIn.activeRole);
        const payload = buildSessionPayload(signIn.user, { activeRole: signIn.activeRole, createdAt: nowIso() });
        const publicUser = payload && payload.user ? payload.user : null;
        setSessionCookie(res, sessionId);
        res.status(200).json({ ok: true, hard_fail: false, message: signIn.body.message, permissions: payload.permissions, session_id: sessionId, session_transport: 'cookie_or_bearer', session_ttl_ms: sessionTtlMs, available_roles: Array.isArray(payload.availableRoles) ? payload.availableRoles : [], user: { user_id: signIn.user.id, role: signIn.activeRole === 'admin' ? 'admin' : 'marketer', app_role: signIn.user.isAssistant ? 'assistant_admin' : signIn.user.role === 'admin' ? 'primary_admin' : 'marketer', status: signIn.user.status, force_password_reset: !!signIn.user.forcePasswordReset, first_name: signIn.user.firstName, last_name: signIn.user.lastName, display_name: signIn.user.displayName, work_email: signIn.user.email, wwid: signIn.user.wwid, cloud_account_state: 'ready', created_at: signIn.user.createdAt, updated_at: signIn.user.updatedAt, can_access_marketer: !!(publicUser && publicUser.canAccessMarketer), can_access_admin: !!(publicUser && publicUser.canAccessAdmin), can_access_manager: !!(publicUser && publicUser.canAccessManager), manager_only: !!(publicUser && publicUser.managerOnly) } });
        return;
      }
      if (action === 'auth_complete_password_reset') {
        const identifier = normalizeIdentifier(body.identifier);
        const role = normalizeRole(body.role) || 'marketer';
        const currentPassword = String(body.current_password || '').trim();
        const newPassword = String(body.new_password || '').trim();
        if (!identifier || !currentPassword || !newPassword) {
          res.status(200).json({ ok: false, message: 'Password reset details are incomplete.' });
          return;
        }
        if (!/[A-Z]/.test(newPassword) || !/\d/.test(newPassword)) {
          res.status(200).json({ ok: false, message: 'New password must include at least 1 capital letter and at least 1 number.' });
          return;
        }
        const row = await findUserRowByIdentifier(db, identifier, role);
        if (!row) {
          res.status(200).json({ ok: false, message: 'No active account matched that role + login.' });
          return;
        }
        if (!verifyPassword(currentPassword, row.password_hash || '')) {
          res.status(200).json({ ok: false, message: 'Current password did not match.' });
          return;
        }
        if (currentPassword === newPassword) {
          res.status(200).json({ ok: false, message: 'New password must be different from temporary password.' });
          return;
        }
        const newHash = hashPassword(newPassword);
        const updatedAt = nowIso();
        await updateUserPassword(db, row.id, newHash, false, updatedAt);
        const updatedRow = {
          ...row,
          password_hash: newHash,
          force_password_reset: false,
          updated_at: updatedAt,
        };
        const user = mapUserToState(updatedRow);
        const payload = buildSessionPayload(user, { activeRole: role, createdAt: nowIso() });
        const publicUser = payload && payload.user ? payload.user : null;
        res.status(200).json({
          ok: true,
          message: 'Password updated.',
          permissions: payload.permissions,
          available_roles: Array.isArray(payload.availableRoles) ? payload.availableRoles : [],
          user: {
            user_id: user.id,
            role,
            app_role: user.isAssistant ? 'assistant_admin' : user.role === 'admin' ? 'primary_admin' : 'marketer',
            status: user.status,
            force_password_reset: !!user.forcePasswordReset,
            first_name: user.firstName,
            last_name: user.lastName,
            display_name: user.displayName,
            work_email: user.email,
            wwid: user.wwid,
            cloud_account_state: 'ready',
            created_at: user.createdAt,
            updated_at: user.updatedAt,
            can_access_marketer: !!(publicUser && publicUser.canAccessMarketer),
            can_access_admin: !!(publicUser && publicUser.canAccessAdmin),
            can_access_manager: !!(publicUser && publicUser.canAccessManager),
            manager_only: !!(publicUser && publicUser.managerOnly),
          },
        });
        return;
      }
      if (!req.auth || !req.auth.payload || !req.auth.payload.isAuthenticated) {
        res.status(401).json({ ok: false, configured: true, code: 'UNAUTHORIZED', message: 'Sign in is required for this cloud action.' });
        return;
      }
      if (action === 'auth_switch_role') {
        const requestedRole = normalizeRole(body.role);
        const result = await switchSessionRoleCore(req, requestedRole);
        if (result.sessionId) setSessionCookie(res, result.sessionId);
        if (result.status === 200 && result.user) {
          await withDb(db, async (state) => {
            logAudit(state, {
              action: 'auth.switch_role',
              actorUserId: result.user.id,
              actorName: result.user.displayName,
              targetType: 'session',
              targetId: result.sessionId,
              details: { activeRole: requestedRole, source: 'cloud' },
            });
          });
        }
        res.status(result.status).json(result.body);
        return;
      }
      if (action === 'catalog_get_live' || action === 'catalog_get_stage') {
        const stage = String(body.stage || 'published').trim() || 'published';
        const state = await readDb(db);
        if (stage === 'published') {
          const p = state.snapshots && state.snapshots.published ? state.snapshots.published : null;
          if (!p) { res.status(200).json({ ok: false, message: 'No published cloud snapshot found.' }); return; }
          res.json({ ok: true, row: { stage: 'published', payload: p.payload, updated_at: p.updatedAt, updated_by: p.publishedByUserId }, message: 'Cloud catalog loaded.' });
          return;
        }
        if (stage === 'draft') {
          const d = state.snapshots && state.snapshots.draft ? state.snapshots.draft : null;
          if (!d) { res.status(200).json({ ok: false, message: 'No draft cloud snapshot found.' }); return; }
          res.json({ ok: true, row: { stage: 'draft', payload: d.payload, updated_at: d.updatedAt, updated_by: d.updatedByUserId }, message: 'Cloud draft loaded.' });
          return;
        }
      }
      if (action === 'catalog_save_stage') {
        const permissions = req.auth.payload.permissions || {};
        const stage = String(body.stage || 'draft').trim() || 'draft';
        if (stage === 'draft' && !permissions.manage_admin_updates) {
          res.status(403).json({ ok: false, reason: 'forbidden', message: 'Only admins can update draft catalog.' });
          return;
        }
        if (stage === 'booking_requests' && !permissions.booking_create && !permissions.booking_manage) {
          res.status(403).json({ ok: false, reason: 'forbidden', message: 'Missing booking write permission.' });
          return;
        }
        await withDb(db, async (db) => {
          const payload = sanitizeCatalogPayload(body.payload);
          if (stage === 'draft') {
            db.snapshots.draft = { updatedAt: nowIso(), updatedByUserId: req.auth.user.id, payload };
            res.json({ ok: true, row: { stage: 'draft', payload, updated_at: db.snapshots.draft.updatedAt, updated_by: db.snapshots.draft.updatedByUserId }, message: 'Draft saved.' });
            return;
          }
          if (stage === 'booking_requests') {
            const incoming = Array.isArray(body.payload && body.payload.requests) ? body.payload.requests : [];
            const result = await upsertBookingRows(db, incoming);
            if (!result.ok) { res.status(result.status).json(result.body); return; }
            const locks = result.rows.map(bookingLockFromRow).filter(Boolean);
            res.json({
              ok: true,
              row: { stage: 'booking_requests', payload: { meta: { source: 'booking-requests', updatedAt: nowIso(), version: 1 }, requests: result.rows }, updated_at: nowIso(), updated_by: req.auth.user.id },
              locks,
              message: 'Booking updates synced to cloud.',
            });
            return;
          }
          res.status(400).json({ ok: false, message: `Unsupported stage \"${stage}\".` });
        });
        return;
      }
      if (action === 'booking_get') {
        const state = await readDb(db);
        const requests = Array.isArray(state.bookings)
          ? state.bookings.filter((entry) => bookingStatus(entry.status) !== 'deleted')
          : [];
        const locks = requests.map(bookingLockFromRow).filter(Boolean);
        res.json({ ok: true, row: { stage: 'booking_requests', payload: { meta: { source: 'backend', updatedAt: nowIso(), version: 1 }, requests }, updated_at: nowIso(), updated_by: req.auth.user.id }, locks, message: 'Cloud booking queue loaded.' });
        return;
      }
      if (action === 'booking_save') {
        const permissions = req.auth.payload.permissions || {};
        if (!permissions.booking_create && !permissions.booking_manage) {
          res.status(403).json({ ok: false, reason: 'forbidden', message: 'Missing booking write permission.' });
          return;
        }
        await withDb(db, async (db) => {
          const incoming = Array.isArray(body.payload && body.payload.requests) ? body.payload.requests : [];
          const result = await upsertBookingRows(db, incoming);
          if (!result.ok) { res.status(result.status).json(result.body); return; }
          const locks = result.rows.map(bookingLockFromRow).filter(Boolean);
          res.json({ ok: true, row: { stage: 'booking_requests', payload: { meta: { source: 'booking-requests', updatedAt: nowIso(), version: 1 }, requests: result.rows }, updated_at: nowIso(), updated_by: req.auth.user.id }, locks, message: 'Booking updates synced to cloud.' });
        });
        return;
      }
      if (action === 'booking_claim' || action === 'booking_complete' || action === 'booking_release') {
        const permissions = req.auth.payload.permissions || {};
        if (!permissions.booking_manage) {
          res.status(403).json({ ok: false, reason: 'forbidden', message: 'Only admin can manage booking queue.' });
          return;
        }
        const requestId = String(body.request_id || '').trim();
        if (!requestId) {
          res.status(400).json({ ok: false, reason: 'missing', message: 'Request id is required.' });
          return;
        }

        await withDb(db, async (db) => {
          const rows = Array.isArray(db.bookings) ? db.bookings : [];
          const found = rows.find((entry) => String(entry.id || '') === requestId && bookingStatus(entry.status) !== 'deleted');
          if (!found) {
            res.status(200).json({ ok: false, reason: 'missing', message: 'Booking request was not found.' });
            return;
          }

          const actorName = String(req.auth.user.displayName || '').trim() || 'Admin';
          const actorUserId = String(req.auth.user.id || '').trim();
          const actorDevice = String(body.actor_device || body.device_id || 'web').trim();
          const status = bookingStatus(found.status);

          if (action === 'booking_claim') {
            if (status === 'done') {
              res.status(200).json({ ok: false, reason: 'already-done', message: 'Already marked Done.', lock: bookingLockFromRow(found) });
              return;
            }
            if (status === 'working' && String(found.workingByUserId || '') && String(found.workingByUserId || '') !== actorUserId) {
              res.status(200).json({
                ok: false,
                reason: 'owner-locked',
                message: `Already claimed by ${String(found.workingByName || 'another admin')}.`,
                lock: bookingLockFromRow(found),
              });
              return;
            }
            const stamp = nowIso();
            found.status = 'working';
            found.adminName = actorName;
            found.adminUserId = actorUserId;
            found.adminDevice = actorDevice;
            found.workingByName = actorName;
            found.workingByUserId = actorUserId;
            found.workingByDevice = actorDevice;
            found.workingAt = stamp;
            found.statusAt = stamp;
            found.updatedAt = stamp;
            found.revision = Math.max(1, toInt(found.revision, 1) + 1);
            logAudit(db, { action: 'booking.claim', actorUserId, actorName, targetType: 'booking', targetId: found.id, details: { source: 'cloud' } });
            logBookingEvent(db, {
              bookingId: found.id,
              eventType: 'booking.claim',
              actorUserId,
              actorName,
              details: { actorDevice, source: 'cloud' },
            });
            res.status(200).json({ ok: true, message: 'Request claimed.', lock: bookingLockFromRow(found) });
            return;
          }

          if (action === 'booking_complete') {
            if (status === 'done') {
              res.status(200).json({ ok: false, reason: 'already-done', message: 'Already marked Done.', lock: bookingLockFromRow(found) });
              return;
            }
            if (status !== 'working') {
              res.status(200).json({ ok: false, reason: 'missing-owner', message: 'Mark this request as Working first.' });
              return;
            }
            if (String(found.workingByUserId || '') && String(found.workingByUserId || '') !== actorUserId) {
              res.status(200).json({
                ok: false,
                reason: 'owner-only-done',
                message: `Only ${String(found.workingByName || 'the assigned admin')} can mark Done.`,
                lock: bookingLockFromRow(found),
              });
              return;
            }
            const stamp = nowIso();
            found.status = 'done';
            found.completedByName = actorName;
            found.completedByUserId = actorUserId;
            found.completedByDevice = actorDevice;
            found.completedAt = stamp;
            found.statusAt = stamp;
            found.updatedAt = stamp;
            found.revision = Math.max(1, toInt(found.revision, 1) + 1);
            logAudit(db, { action: 'booking.complete', actorUserId, actorName, targetType: 'booking', targetId: found.id, details: { source: 'cloud' } });
            logBookingEvent(db, {
              bookingId: found.id,
              eventType: 'booking.complete',
              actorUserId,
              actorName,
              details: { actorDevice, source: 'cloud' },
            });
            res.status(200).json({ ok: true, message: 'Request marked Done.', lock: bookingLockFromRow(found) });
            return;
          }

          if (status === 'done') {
            res.status(200).json({ ok: false, reason: 'already-done', message: 'Done requests cannot be released.' });
            return;
          }
          if (status === 'working' && String(found.workingByUserId || '') && String(found.workingByUserId || '') !== actorUserId) {
            res.status(200).json({ ok: false, reason: 'owner-only-release', message: 'Only the current owner can release this booking.' });
            return;
          }
          found.status = 'pending';
          found.adminName = '';
          found.adminUserId = '';
          found.adminDevice = '';
          found.workingByName = '';
          found.workingByUserId = '';
          found.workingByDevice = '';
          found.workingAt = '';
          found.completedByName = '';
          found.completedByUserId = '';
          found.completedByDevice = '';
          found.completedAt = '';
          found.statusAt = nowIso();
          found.updatedAt = nowIso();
          found.revision = Math.max(1, toInt(found.revision, 1) + 1);
          logAudit(db, { action: 'booking.release', actorUserId, actorName, targetType: 'booking', targetId: found.id, details: { source: 'cloud' } });
          logBookingEvent(db, {
            bookingId: found.id,
            eventType: 'booking.release',
            actorUserId,
            actorName,
            details: { source: 'cloud' },
          });
          res.status(200).json({ ok: true, message: 'Booking ownership cleared.' });
        });
        return;
      }
      if (action === 'save_and_send') {
        const result = await withDb(db, async (db) => {
          const permissions = req.auth.payload.permissions || {};
          if (!permissions.publish_catalog) return { status: 403, body: { ok: false, message: 'Only admins can publish snapshots.' } };
          const payload = sanitizeCatalogPayload(body.payload);
          const userOps = normalizeUserOperations(body.user_operations);
          const currentPublished = db.snapshots && db.snapshots.published ? db.snapshots.published : null;
          const nextVersion = Math.max(1, toInt(currentPublished && currentPublished.version, 0) + 1);
          const stamp = nowIso();
          payload.meta = payload.meta && typeof payload.meta === 'object' ? payload.meta : {};
          payload.meta.version = nextVersion;
          payload.meta.publishedAt = stamp;
          payload.meta.updatedAt = stamp;
          db.snapshots.published = { version: nextVersion, publishedAt: stamp, updatedAt: stamp, publishedByUserId: req.auth.user.id, payload };
          if (!Array.isArray(db.snapshots.history)) db.snapshots.history = [];
          db.snapshots.history.push(db.snapshots.published);
          db.snapshots.draft = { updatedAt: stamp, updatedByUserId: req.auth.user.id, payload };
          const actor = { userId: req.auth.user.id, name: req.auth.user.displayName };
          userOps.forEach((op) => applyUserOperation(db, op, actor, logAudit));
          logAudit(db, { action: 'catalog.save_and_send', actorUserId: req.auth.user.id, actorName: req.auth.user.displayName, targetType: 'snapshot', targetId: String(nextVersion), details: { version: nextVersion, userOperations: userOps.length } });
          return {
            status: 200,
            body: {
              ok: true,
              request_id: String(body.request_id || randomId('request')).toLowerCase(),
              message: 'Cloud synced.',
              version: nextVersion,
              published_at: stamp,
              account_readiness: { pending: 0, ready: userOps.filter((op) => op.op === 'create_user').length, failed: 0 },
              user_operations: { received: userOps.length, queued: userOps.length },
            },
          };
        });
        res.status(result.status || 200).json(result.body || { ok: false, message: 'Cloud sync failed.' });
        return;
      }
      if (action === 'apply_user_operations') {
        const result = await withDb(db, async (db) => {
          const permissions = requestPermissions(req);
          const canAdmin = !!permissions.manage_admin_updates;
          const canManager = !!permissions.manage_marketer_users;
          if (!canAdmin && !canManager) {
            return { status: 403, body: { ok: false, message: 'Only admins and managers can sync user login state.' } };
          }
          const userOps = normalizeUserOperations(body.user_operations || body.operations);
          if (!userOps.length) {
            return { status: 200, body: { ok: true, message: 'No user operations were supplied.', user_operations: { received: 0, applied: 0 } } };
          }
          if (!canAdmin) {
            const restrictionMessage = managerUserOperationRestrictionMessage(userOps);
            if (restrictionMessage) {
              return { status: 403, body: { ok: false, message: restrictionMessage } };
            }
          }
          const actor = { userId: req.auth.user.id, name: req.auth.user.displayName };
          userOps.forEach((op) => applyUserOperation(db, op, actor, logAudit));
          logAudit(db, {
            action: 'user.apply_operations',
            actorUserId: req.auth.user.id,
            actorName: req.auth.user.displayName,
            targetType: 'user',
            targetId: userOps.map((op) => op.wwid).join(','),
            details: { operations: userOps.length },
          });
          return {
            status: 200,
            body: {
              ok: true,
              message: `Applied ${userOps.length} user operation${userOps.length === 1 ? '' : 's'}.`,
              user_operations: {
                received: userOps.length,
                applied: userOps.length,
                wwids: userOps.map((op) => op.wwid),
              },
            },
          };
        });
        res.status(result.status || 200).json(result.body || { ok: false, message: 'Cloud user sync failed.' });
        return;
      }
      res.status(400).json({ ok: false, message: `Unsupported action "${actionRaw || 'unknown'}".` });
    } catch (error) {
      next(error);
    }
  });

  app.use((error, _req, res, _next) => {
    const message = String((error && error.message) || error || 'Server error');
    res.status(500).json({ ok: false, message });
  });

  return { app, db, ownsDbPool };
}

module.exports = { createApp };
