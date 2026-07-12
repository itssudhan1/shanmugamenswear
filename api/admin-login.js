const {
  getOrSeedPasswordRecord,
  verifyPassword,
  createSession,
  checkRateLimit,
  recordFailedLogin,
  clearFailedLogins,
  MAX_LOGIN_ATTEMPTS
} = require('./_lib/adminAuth');

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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

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
    return res.status(429).json({
      error: `Too many failed attempts. Try again in a few minutes.`
    });
  }

  try {
    const record = await getOrSeedPasswordRecord();

    // Constant-time-ish check: verify password hash regardless of whether
    // the username matched, so failed attempts don't leak which field
    // was wrong via response timing.
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
    console.error('admin-login error:', err);
    return res.status(500).json({ error: 'Login failed. Please try again.' });
  }
};
