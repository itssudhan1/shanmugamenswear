const { kv } = require('@vercel/kv');
const { requireAdmin } = require('../lib/adminAuth');

// Referenced by admin.html (updateShipStatus / deleteOrder) but wasn't
// among the files originally reviewed — added here, protected the same
// way as /api/orders.js.

const VALID_STATUSES = ['pending', 'dispatched', 'delivered', 'cancelled'];

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
  res.setHeader('Access-Control-Allow-Methods', 'PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'PATCH' && req.method !== 'DELETE') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!(await requireAdmin(req, res))) return;

  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Order id required' });

  try {
    const order = await kv.get('order:' + id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (req.method === 'PATCH') {
      const { shippingStatus } = req.body || {};
      if (!VALID_STATUSES.includes(shippingStatus)) {
        return res.status(400).json({ error: 'Invalid shipping status' });
      }
      order.shippingStatus = shippingStatus;
      await kv.set('order:' + id, order);
      if (order.paymentId) await kv.set('payment:' + order.paymentId, order);
      return res.status(200).json({ ok: true, order });
    }

    // DELETE
    await kv.del('order:' + id);
    if (order.paymentId) await kv.del('payment:' + order.paymentId);
    await kv.lrem('orders:list', 0, id);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('order-update error:', err);
    return res.status(500).json({ error: 'Could not update order' });
  }
};
