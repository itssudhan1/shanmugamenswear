const crypto = require('crypto');
const { kv } = require('@vercel/kv');
const { verifyIdToken } = require('./_lib/firebaseAdmin');
const { decrementStock } = require('./stock');

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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  // Authorization added so the browser can send the customer's Firebase ID
  // token (used to tag the order with their account for "My Orders").
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const { RAZORPAY_KEY_SECRET } = process.env;
  if (!RAZORPAY_KEY_SECRET) {
    console.error('Missing Razorpay secret');
    return res.status(500).json({ error: 'Payment gateway not configured' });
  }
  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    cart,
    customer,
    totals
  } = req.body || {};
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ verified: false, error: 'Missing payment fields' });
  }
  // --- THE CRITICAL CHECK ---
  // Recompute the signature server-side. Only someone holding the
  // Razorpay secret key can produce a matching value, so this can't
  // be faked by editing client-side JS.
  const generatedSignature = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(razorpay_order_id + '|' + razorpay_payment_id)
    .digest('hex');
  if (generatedSignature !== razorpay_signature) {
    console.warn('Signature mismatch for order', razorpay_order_id);
    return res.status(400).json({ verified: false, error: 'Signature verification failed' });
  }

  // Who is this? Verified server-side from the ID token — we never trust
  // a uid sent as plain JSON, since that could be spoofed to misattribute
  // an order to someone else's account.
  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const decoded = await verifyIdToken(idToken);
  if (!decoded) {
    console.warn('verify-payment: no valid customer ID token — order will not be linked to an account. Payment ID:', razorpay_payment_id);
  }

  // --- Signature is valid: this payment is real. Save the order. ---
  try {
    const existing = await kv.get('payment:' + razorpay_payment_id);

    // Real duplicate: verify-payment already fully processed this
    // payment before (e.g. the browser retried after a network blip).
    // A webhook-created stub is NOT a real duplicate — it's an empty
    // placeholder (empty items, no customer info) that the race
    // between Razorpay's webhook and this call can create. We only
    // treat it as "already done" if it was written by this same
    // handler previously.
    if (existing && existing.source !== 'webhook-recovery') {
      return res.status(200).json({ verified: true, order: existing, duplicate: true });
    }

    // If a webhook stub already exists for this payment, reuse its
    // order ID and metadata so we enrich the SAME record instead of
    // creating a second one (the admin panel's orders:list already
    // has this ID from the webhook).
    const orderId = existing ? existing.id : ('ORD-' + Date.now());
    const order = {
      id: orderId,
      razorpayOrderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
      date: existing ? existing.date : new Date().toISOString(),
      dateStr: existing ? existing.dateStr : new Date().toLocaleString('en-IN', {
        day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
      }),
      customer: customer || {},
      items: cart || [],
      totals: totals || {},
      status: 'paid',
      shippingStatus: existing ? existing.shippingStatus : 'pending',
      source: 'verify-payment',
      uid: decoded ? decoded.uid : null,
      customerEmail: (decoded && decoded.email) || (customer && customer.email) || null
    };

    await kv.set('order:' + orderId, order);
    await kv.set('payment:' + razorpay_payment_id, order);

    // Only push into the orders list / bump the unread counter for a
    // genuinely new order. If we're enriching a webhook stub, it was
    // already pushed and counted when the webhook created it.
    if (!existing) {
      await kv.lpush('orders:list', orderId);
      await kv.incr('orders:unread');
    }

    if (decoded && decoded.uid) {
      await kv.lpush('orders:by-uid:' + decoded.uid, orderId);
    }

    // --- Reduce per-size stock ---
    // Only do this the first time this order actually has real items —
    // NOT on every call. A webhook stub is created with empty items, so
    // `existing.items` being empty (or existing being absent entirely)
    // means this is the first time we're seeing the real cart. A true
    // duplicate resend (order already had items) is already caught by
    // the early "duplicate" return above, so it never reaches here.
    const alreadyHadItems = existing && existing.items && existing.items.length > 0;
    if (!alreadyHadItems && Array.isArray(cart) && cart.length) {
      await reduceStockForCart(cart);
    }

    return res.status(200).json({ verified: true, order });
  } catch (err) {
    console.error('verify-payment storage error:', err);
    // Signature WAS valid, so the payment is genuinely good even
    // though saving failed. Tell the frontend it's verified so the
    // customer isn't shown a false failure, but flag the storage issue.
    return res.status(200).json({
      verified: true,
      order: { id: 'ORD-' + Date.now(), paymentId: razorpay_payment_id, dateStr: new Date().toLocaleString('en-IN') },
      storageWarning: true
    });
  }
};

// NOTE: this assumes each cart item carries the product's catalog id
// under one of item.productId / item.id / item.pid, plus item.size and
// item.qty (matching what admin.html already displays for order items:
// it.name, it.size, it.qty). If checkout.html's cart objects use a
// different field name for the product id, update PRODUCT_ID_KEYS below
// or this will silently skip decrementing for every item.
const PRODUCT_ID_KEYS = ['productId', 'id', 'pid'];

async function reduceStockForCart(cart) {
  const baseStockMap = await fetchBaseSizeStock();
  for (const item of cart) {
    try {
      if (!item || !item.size) continue; // not a size-tracked item — skip
      const qty = parseInt(item.qty, 10) || 0;
      if (qty <= 0) continue;
      let pid = null;
      for (const k of PRODUCT_ID_KEYS) {
        if (item[k] != null) { pid = item[k]; break; }
      }
      if (pid == null) {
        console.warn('reduceStockForCart: could not find a product id on cart item', item);
        continue;
      }
      const baseQty = baseStockMap[pid] && baseStockMap[pid][item.size] != null
        ? baseStockMap[pid][item.size]
        : undefined;
      await decrementStock(String(pid), item.size, qty, baseQty);
    } catch (err) {
      // A stock-update failure should never fail the order itself —
      // the payment already succeeded. Just log it for follow-up.
      console.error('Stock decrement failed for cart item', item, err);
    }
  }
}

// Live stock (KV) only tracks ADJUSTMENTS. The starting number for a
// size that has never been sold yet lives in smw-products.js on GitHub,
// so on the very first sale of a size we fetch that file to know what
// to count down from. Cheap to call — it's a small static file, and
// only runs on the first decrement of a given size (after that, KV
// already holds the running total and this fallback is never used).
async function fetchBaseSizeStock() {
  try {
    const r = await fetch('https://shanmugamenswear.vercel.app/smw-products.js');
    if (!r.ok) return {};
    const text = await r.text();
    const match = text.match(/SMW_DEFAULT_PRODUCTS\s*=\s*(\[[\s\S]*\]);/);
    if (!match) return {};
    const products = JSON.parse(match[1]);
    const map = {};
    products.forEach(function (p) {
      if (p && p.sizeStock) map[p.id] = p.sizeStock;
    });
    return map;
  } catch (err) {
    console.error('Could not fetch base product stock for fallback:', err);
    return {};
  }
}
