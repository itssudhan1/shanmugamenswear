const { isAuthenticated } = require('./_lib/adminAuth');

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

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const authenticated = await isAuthenticated(req);
    return res.status(200).json({ authenticated });
  } catch (err) {
    console.error('admin-session error:', err);
    return res.status(200).json({ authenticated: false });
  }
};
