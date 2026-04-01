const crypto = require('crypto');

function nowIso() {
  return new Date().toISOString();
}

function toInt(value, fallback = 0) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function toNum(value, fallback = 0) {
  const n = Number(value ?? '');
  return Number.isFinite(n) ? n : fallback;
}

function normalizeRole(value) {
  const key = String(value ?? '').trim().toLowerCase();
  if (key === 'admin' || key === 'primary_admin' || key === 'assistant_admin') return 'admin';
  if (key === 'marketer') return 'marketer';
  if (key === 'manager') return 'manager';
  return null;
}

function normalizeAppRole(value) {
  const key = String(value ?? '').trim().toLowerCase();
  if (key === 'primary_admin' || key === 'admin') return 'primary_admin';
  if (key === 'assistant_admin' || key === 'assistant') return 'assistant_admin';
  return 'marketer';
}

function normalizeStatus(value) {
  const key = String(value ?? '').trim().toLowerCase();
  if (key === 'inactive') return 'inactive';
  if (key === 'deleted') return 'deleted';
  return 'active';
}

function normalizeWwid(value) {
  return String(value ?? '').replace(/\s+/g, '').trim().toUpperCase();
}

function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

function normalizeIdentifier(value) {
  return String(value ?? '').trim();
}

function randomId(prefix = '') {
  const token = crypto.randomUUID();
  return prefix ? `${prefix}-${token}` : token;
}

function hashPassword(password, salt = '') {
  const safePassword = String(password ?? '');
  const safeSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(safePassword, safeSalt, 64).toString('hex');
  return `${safeSalt}:${hash}`;
}

function verifyPassword(password, stored) {
  const safeStored = String(stored ?? '');
  if (!safeStored.includes(':')) return false;
  const [salt, expected] = safeStored.split(':');
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(String(password ?? ''), salt, 64).toString('hex');
  const left = Buffer.from(actual, 'hex');
  const right = Buffer.from(expected, 'hex');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

module.exports = {
  nowIso,
  toInt,
  toNum,
  normalizeRole,
  normalizeAppRole,
  normalizeStatus,
  normalizeWwid,
  normalizeEmail,
  normalizeIdentifier,
  randomId,
  hashPassword,
  verifyPassword,
};
