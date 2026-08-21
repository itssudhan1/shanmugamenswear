const { kv } = require('@vercel/kv');
const { verifyIdToken } = require('../lib/firebaseAdmin');

// Customer-facing endpoint (account.html) — returns only the signed-in
// customer's own orders. Protected by their Firebase ID token, not the
// admin session cookie (see orders.js for the admin equivalent).
module.exports = async function handler(req, res) {
  const allowedOrigins = [
    'https://shanmugamenswear.vercel.app',
    'http://127.0.0.1:5500',
    'http://localhost:5500',
    'http://localhost:3000'
  ];
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const decoded = await verifyIdToken(idToken);
  if (!decoded) {
    return res.status(401).json({ error: 'Not signed in' });
  }

  try {
    const orderIds = await kv.lrange('orders:by-uid:' + decoded.uid, 0, 199);
    const orders = await Promise.all(orderIds.map((id) => kv.get('order:' + id)));
    return res.status(200).json({ orders: orders.filter(Boolean) });
  } catch (err) {
    console.error('my-orders fetch error:', err);
    return res.status(500).json({ error: 'Could not fetch your orders' });
  }
};
