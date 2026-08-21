const { kv } = require('@vercel/kv');
const { requireAdmin } = require('../lib/adminAuth');
const { verifyIdToken } = require('../lib/firebaseAdmin');
const { decrementStock, fetchBaseSizeStock } = require('./stock');

// Combines what used to be two separate endpoints (create-manual-order.js
// and create-whatsapp-order.js) into one — Vercel's Hobby plan caps total
// serverless functions at 12, so every route here counts. Both flows save
// an order (source:'whatsapp') and decrement stock the same way a
// Razorpay order does; they differ only in WHO can call them and HOW
// much validation is applied:
//
//   isAdmin: true  → called from admin.html's "Log WhatsApp Order" modal.
//                    Requires the admin session cookie (requireAdmin).
//                    Order id is generated here ('WA-' + timestamp).
//
//   isAdmin: false → called from checkout.html's WhatsApp-mode checkout.
//                    No login required (the customer isn't an admin) —
//                    only origin + shape/size validation. Order id is
//                    supplied by the client ('SMW' + timestamp) so it
//                    matches what's shown on the success screen and sent
//                    via WhatsApp. Idempotent: retrying the same orderId
//                    won't double-save or double-decrement.

const allowedOrigins = [
  'https://shanmugamenswear.vercel.app',
  'http://127.0.0.1:5500',
  'http://localhost:5500',
  'http://localhost:3000'
];

const MAX_ITEMS = 20;
const MAX_QTY_PER_ITEM = 20;

module.exports = async function handler(req, res) {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { isAdmin, orderId, customer, items, totals } = req.body || {};

  if (!Array.isArray(items) || !items.length || items.length > MAX_ITEMS) {
    return res.status(400).json({ error: 'items required (1-' + MAX_ITEMS + ')' });
  }
  for (const it of items) {
    const qty = parseInt(it && it.qty, 10) || 0;
    if (qty <= 0 || qty > MAX_QTY_PER_ITEM) {
      return res.status(400).json({ error: 'Invalid quantity on an item' });
    }
  }

  if (isAdmin) {
    // ── Admin-logged WhatsApp sale ──
    if (!(await requireAdmin(req, res))) return;

    try {
      const newOrderId = 'WA-' + Date.now();
      const order = {
        id: newOrderId,
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

      await kv.set('order:' + newOrderId, order);
      await kv.lpush('orders:list', newOrderId);
      await kv.incr('orders:unread');

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
      console.error('log-order (admin) error:', err);
      return res.status(500).json({ error: 'Could not create order' });
    }
  }

  // ── Customer-facing WhatsApp-mode checkout ──
  if (!orderId || typeof orderId !== 'string') {
    return res.status(400).json({ error: 'orderId required' });
  }

  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const decoded = idToken ? await verifyIdToken(idToken) : null;

  try {
    const existing = await kv.get('order:' + orderId);
    if (existing) {
      return res.status(200).json({ ok: true, order: existing, duplicate: true });
    }

    const order = {
      id: orderId,
      paymentId: 'Pending (WhatsApp)',
      date: new Date().toISOString(),
      dateStr: new Date().toLocaleString('en-IN', {
        day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
      }),
      customer: customer || {},
      items: items,
      totals: totals || {},
      status: 'pending confirmation',
      shippingStatus: 'pending',
      source: 'whatsapp',
      uid: decoded ? decoded.uid : null,
      customerEmail: (decoded && decoded.email) || (customer && customer.email) || null
    };

    await kv.set('order:' + orderId, order);
    await kv.lpush('orders:list', orderId);
    await kv.incr('orders:unread');
    if (decoded && decoded.uid) {
      await kv.lpush('orders:by-uid:' + decoded.uid, orderId);
    }

    const baseMap = await fetchBaseSizeStock();
    for (const item of items) {
      try {
        if (!item || !item.size) continue;
        const pid = item.productId != null ? item.productId : (item.id != null ? item.id : item.pid);
        if (pid == null) continue;
        const qty = parseInt(item.qty, 10) || 0;
        if (qty <= 0) continue;
        const baseQty = baseMap[pid] && baseMap[pid][item.size] != null ? baseMap[pid][item.size] : undefined;
        await decrementStock(String(pid), item.size, qty, baseQty);
      } catch (err) {
        console.error('Stock decrement failed for WhatsApp order item', item, err);
      }
    }

    return res.status(200).json({ ok: true, order });
  } catch (err) {
    console.error('log-order (customer) error:', err);
    return res.status(500).json({ error: 'Could not save order' });
  }
};
