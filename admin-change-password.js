const {
  requireAdmin,
  getOrSeedPasswordRecord,
  verifyPassword,
  setPasswordRecord
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
    console.error('admin-change-password error:', err);
    return res.status(500).json({ error: 'Could not update password' });
  }
};
