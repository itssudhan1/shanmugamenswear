const { kv } = require('@vercel/kv');
const { requireAdmin } = require('./_lib/adminAuth');
const { decrementStock } = require('./stock');

// Lets the admin log a sale that happened outside the site checkout
// (WhatsApp, in-person, phone) as a real order: it shows up in the
// Orders tab tagged source:'whatsapp', gets a printable bill, and
// reduces live per-size stock exactly like a Razorpay order does.

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

  if (!(await requireAdmin(req, res))) return;

  const { customer, items, totals } = req.body || {};
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'At least one item is required' });
  }

  try {
    const orderId = 'WA-' + Date.now();
    const order = {
      id: orderId,
      date: new Date().toISOString(),
      dateStr: new Date().toLocaleString('en-IN', {
        day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
      }),
      customer: customer || {},
      items: items,
      totals: totals || {},
      status: 'paid',
      shippingStatus: 'pending',
      source: 'whatsapp'
    };

    await kv.set('order:' + orderId, order);
    await kv.lpush('orders:list', orderId);
    await kv.incr('orders:unread');

    // Reduce stock the same way a Razorpay order does. baseQty (the
    // starting number from smw-products.js) is supplied by admin.html,
    // which already has the product catalog loaded — saves us a fetch.
    for (const item of items) {
      try {
        if (!item || !item.size || item.productId == null) continue;
        const qty = parseInt(item.qty, 10) || 0;
        if (qty <= 0) continue;
        await decrementStock(String(item.productId), item.size, qty, item.baseQty);
      } catch (err) {
        console.error('Stock decrement failed for manual order item', item, err);
      }
    }

    return res.status(200).json({ ok: true, order });
  } catch (err) {
    console.error('create-manual-order error:', err);
    return res.status(500).json({ error: 'Could not create order' });
  }
};