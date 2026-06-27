const { kv } = require('@vercel/kv');

// Simple admin endpoint to list saved orders. Protected by a shared
// secret header so randoms can't pull your customer list.
//
//   fetch('/api/orders', { headers: { 'x-admin-key': 'YOUR_ADMIN_KEY' } })

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

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { ADMIN_KEY } = process.env;
  const suppliedKey = req.headers['x-admin-key'];

  if (!ADMIN_KEY || !suppliedKey || suppliedKey !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

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
