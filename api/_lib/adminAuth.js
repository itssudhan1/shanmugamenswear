const crypto = require('crypto');
const { kv } = require('@vercel/kv');

// ---------------------------------------------------------------------
// This module is the ONLY place admin credentials/sessions are handled.
// No secret ever gets sent to the browser except a random, meaningless
// session ID stored in an httpOnly cookie the JS on the page can't read.
// ---------------------------------------------------------------------

const SESSION_COOKIE = 'smw_admin_session';
const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12 hours
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_SECONDS = 15 * 60; // 15 min

// ---- password hashing (scrypt — built into Node, no extra dependency) ----

function hashPassword(password, saltHex) {
  const salt = Buffer.from(saltHex, 'hex');
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password, saltHex, hashHex) {
  const candidate = Buffer.from(hashPassword(password, saltHex), 'hex');
  const stored = Buffer.from(hashHex, 'hex');
  if (candidate.length !== stored.length) return false;
  return crypto.timingSafeEqual(candidate, stored);
}

// The admin password is hashed and stored in KV, seeded once from the
// ADMIN_PASS env var the first time anyone logs in. From then on,
// changing the password (via /api/admin-change-password) updates KV,
// not the env var — so it persists without a redeploy.
async function getOrSeedPasswordRecord() {
  let record = await kv.get('admin:passrecord');
  if (record && record.hash && record.salt) return record;

  const { ADMIN_PASS } = process.env;
  if (!ADMIN_PASS) {
    throw new Error('ADMIN_PASS env var is not set — cannot seed admin password');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(ADMIN_PASS, salt);
  record = { salt, hash, updatedAt: Date.now() };
  await kv.set('admin:passrecord', record);
  return record;
}

async function setPasswordRecord(newPassword) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(newPassword, salt);
  const record = { salt, hash, updatedAt: Date.now() };
  await kv.set('admin:passrecord', record);
  return record;
}

// ---- cookies ----

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx < 0) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function isSecureRequest(req) {
  const proto = req.headers['x-forwarded-proto'];
  if (proto) return proto.split(',')[0].trim() === 'https';
  const host = req.headers.host || '';
  return !(host.startsWith('localhost') || host.startsWith('127.0.0.1'));
}

function setSessionCookie(req, res, sessionId) {
  const parts = [
    `${SESSION_COOKIE}=${sessionId}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_SECONDS}`
  ];
  if (isSecureRequest(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(req, res) {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isSecureRequest(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

// ---- sessions (server-side state in KV, cookie only holds the ID) ----

async function createSession(req, res) {
  const sessionId = crypto.randomBytes(32).toString('hex');
  await kv.set(`admin:session:${sessionId}`, { createdAt: Date.now() }, { ex: SESSION_TTL_SECONDS });
  setSessionCookie(req, res, sessionId);
  return sessionId;
}

async function destroySession(req, res) {
  const cookies = parseCookies(req);
  const sessionId = cookies[SESSION_COOKIE];
  if (sessionId) await kv.del(`admin:session:${sessionId}`);
  clearSessionCookie(req, res);
}

// Returns true/false. Does NOT send a response — caller decides what to do.
async function isAuthenticated(req) {
  const cookies = parseCookies(req);
  const sessionId = cookies[SESSION_COOKIE];
  if (!sessionId) return false;
  const session = await kv.get(`admin:session:${sessionId}`);
  return !!session;
}

// Convenience guard for protected endpoints: sends 401 and returns false
// if not authenticated, so the caller can just `if (!(await requireAdmin(req,res))) return;`
async function requireAdmin(req, res) {
  const ok = await isAuthenticated(req);
  if (!ok) {
    res.status(401).json({ error: 'Not authenticated' });
    return false;
  }
  return true;
}

// ---- login rate limiting (per IP, stored server-side — can't be bypassed
// by clearing localStorage like the old client-side lockout could) ----

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

async function checkRateLimit(req) {
  const ip = getClientIp(req);
  const key = `admin:loginfail:${ip}`;
  const fails = (await kv.get(key)) || 0;
  return { ip, key, fails: Number(fails), limited: Number(fails) >= MAX_LOGIN_ATTEMPTS };
}

async function recordFailedLogin(key, currentFails) {
  const next = currentFails + 1;
  await kv.set(key, next, { ex: LOGIN_WINDOW_SECONDS });
  return next;
}

async function clearFailedLogins(key) {
  await kv.del(key);
}

module.exports = {
  getOrSeedPasswordRecord,
  setPasswordRecord,
  verifyPassword,
  parseCookies,
  createSession,
  destroySession,
  isAuthenticated,
  requireAdmin,
  checkRateLimit,
  recordFailedLogin,
  clearFailedLogins,
  MAX_LOGIN_ATTEMPTS,
  LOGIN_WINDOW_SECONDS
};
