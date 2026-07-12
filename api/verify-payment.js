const crypto = require('crypto');
const { kv } = require('@vercel/kv');
const { verifyIdToken } = require('./_lib/firebaseAdmin');

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
