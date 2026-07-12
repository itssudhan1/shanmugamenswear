const { kv } = require('@vercel/kv');
const { requireAdmin } = require('./_lib/adminAuth');

// Admin endpoint to list saved orders. Protected by a server-side session
// cookie (see /api/admin-login.js) — no API key is ever sent to the browser.

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
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!(await requireAdmin(req, res))) return;

  try {
    const orderIds = await kv.lrange('orders:list', 0, 299);
    const orders = await Promise.all(orderIds.map((id) => kv.get('order:' + id)));
    const unread = (await kv.get('orders:unread')) || 0;

    return res.status(200).json({ orders: orders.filter(Boolean), unread });
  } catch (err) {
    console.error('orders fetch error:', err);
    return res.status(500).json({ error: 'Could not fetch orders' });
  }
};
