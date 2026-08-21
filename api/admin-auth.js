const {
  getOrSeedPasswordRecord,
  verifyPassword,
  setPasswordRecord,
  createSession,
  destroySession,
  isAuthenticated,
  requireAdmin,
  checkRateLimit,
  recordFailedLogin,
  clearFailedLogins,
  MAX_LOGIN_ATTEMPTS
} = require('../lib/adminAuth');

// Merges what used to be 4 separate endpoints (admin-login.js,
// admin-logout.js, admin-session.js, admin-change-password.js) into one —
// Vercel's Hobby plan caps total serverless functions at 12, so every
// route file counts against that.
//
//   GET  /api/admin-auth                     — session check (old admin-session.js)
//   POST /api/admin-auth {action:'login', username, password}
//   POST /api/admin-auth {action:'logout'}
//   POST /api/admin-auth {action:'change-password', currentPassword, newPassword}

const allowedOrigins = [
  'https://shanmugamenswear.vercel.app',
  'http://127.0.0.1:5500',
  'http://localhost:5500',
  'http://localhost:3000'
];

module.exports = async function handler(req, res) {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Session check (was admin-session.js) ──
  if (req.method === 'GET') {
    try {
      const authenticated = await isAuthenticated(req);
      return res.status(200).json({ authenticated });
    } catch (err) {
      console.error('admin-auth session-check error:', err);
      return res.status(200).json({ authenticated: false });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action } = req.body || {};

  // ── Login (was admin-login.js) ──
  if (action === 'login') {
    const { ADMIN_USER, ADMIN_PASS } = process.env;
    if (!ADMIN_USER || !ADMIN_PASS) {
      console.error('Missing ADMIN_USER/ADMIN_PASS env vars');
      return res.status(500).json({ error: 'Admin auth not configured' });
    }

    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    // Server-side rate limiting — replaces the old client-side lockout,
    // which was trivially bypassed by clearing localStorage.
    const { key: rlKey, fails, limited } = await checkRateLimit(req);
    if (limited) {
      return res.status(429).json({ error: 'Too many failed attempts. Try again in a few minutes.' });
    }

    try {
      const record = await getOrSeedPasswordRecord();

      // Constant-time-ish check: verify password hash regardless of
      // whether the username matched, so failed attempts don't leak
      // which field was wrong via response timing.
      const userOk = username === ADMIN_USER;
      const passOk = verifyPassword(password, record.salt, record.hash);

      if (!userOk || !passOk) {
        const newFails = await recordFailedLogin(rlKey, fails);
        const remaining = Math.max(0, MAX_LOGIN_ATTEMPTS - newFails);
        return res.status(401).json({
          error: remaining > 0 ? `Invalid credentials. ${remaining} attempt(s) left.` : 'Too many failed attempts. Try again in a few minutes.'
        });
      }

      await clearFailedLogins(rlKey);
      await createSession(req, res);
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('admin-auth login error:', err);
      return res.status(500).json({ error: 'Login failed. Please try again.' });
    }
  }

  // ── Logout (was admin-logout.js) ──
  if (action === 'logout') {
    try {
      await destroySession(req, res);
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('admin-auth logout error:', err);
      return res.status(500).json({ error: 'Logout failed' });
    }
  }

  // ── Change password (was admin-change-password.js) ──
  if (action === 'change-password') {
    if (!(await requireAdmin(req, res))) return; // sends 401 itself if not logged in

    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password required' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    try {
      const record = await getOrSeedPasswordRecord();
      if (!verifyPassword(currentPassword, record.salt, record.hash)) {
        return res.status(401).json({ error: 'Wrong current password' });
      }
      await setPasswordRecord(newPassword);
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('admin-auth change-password error:', err);
      return res.status(500).json({ error: 'Could not update password' });
    }
  }

  return res.status(400).json({ error: 'Unknown or missing action' });
};
