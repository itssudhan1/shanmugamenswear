const { kv } = require('@vercel/kv');
const { verifyIdToken } = require('./_lib/firebaseAdmin');
const { decrementStock, fetchBaseSizeStock } = require('./stock');

// checkout.html's WhatsApp-only mode (CHECKOUT_MODE = 'whatsapp') never
// touches Razorpay, so verify-payment.js never runs for these orders.
// This is the equivalent entry point for that flow: it saves the order
// (source:'whatsapp') so it shows up in admin's Orders tab, and reduces
// live per-size stock — same as a Razorpay order does.
//
// There's no payment signature to verify here (no payment has happened
// yet — the customer still needs to confirm/pay over WhatsApp), so this
// endpoint is intentionally more permissive than verify-payment.js. It
// still checks origin and does basic shape/size validation to keep out
// obviously junk or abusive requests.

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
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { orderId, customer, items, totals } = req.body || {};

  if (!orderId || typeof orderId !== 'string') {
    return res.status(400).json({ error: 'orderId required' });
  }
  if (!Array.isArray(items) || !items.length || items.length > MAX_ITEMS) {
    return res.status(400).json({ error: 'items required (1-' + MAX_ITEMS + ')' });
  }
  for (const it of items) {
    const qty = parseInt(it && it.qty, 10) || 0;
    if (qty <= 0 || qty > MAX_QTY_PER_ITEM) {
      return res.status(400).json({ error: 'Invalid quantity on an item' });
    }
  }

  // Best-effort: tag with the customer's account if they're signed in.
  // Not required — checkout.html already gates checkout behind login,
  // but we don't want a token hiccup to block the order from saving.
  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const decoded = idToken ? await verifyIdToken(idToken) : null;

  try {
    // Idempotent: if the browser retries (e.g. flaky connection), don't
    // double-save or double-decrement stock for the same order id.
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

    // Reduce stock, same as a Razorpay order — even though payment
    // hasn't happened yet, the item is reserved the moment the order is
    // placed, so another customer doesn't see it as available.
    const baseMap = await fetchBaseSizeStock();
    for (const item of items) {
      try {
        if (!item || !item.size) continue; // not a size-tracked item — skip
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
    console.error('create-whatsapp-order error:', err);
    return res.status(500).json({ error: 'Could not save order' });
  }
};