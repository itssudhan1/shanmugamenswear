const crypto = require('crypto');
const { kv } = require('@vercel/kv');

// Razorpay calls THIS endpoint directly from their own servers whenever
// a payment event happens — independent of whether the customer's
// browser is even still open. This is the safety net that catches
// payments where the customer paid but closed the tab before
// verify-payment.js ever got called.
//
// Set up in: Razorpay Dashboard -> Settings -> Webhooks
//   URL:    https://shanmugamenswear.vercel.app/api/webhook
//   Secret: put the same value in RAZORPAY_WEBHOOK_SECRET env var
//   Events: payment.captured (minimum required)

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).end();
  }

  const { RAZORPAY_WEBHOOK_SECRET } = process.env;

  if (!RAZORPAY_WEBHOOK_SECRET) {
    console.error('Missing RAZORPAY_WEBHOOK_SECRET');
    return res.status(500).send('Webhook not configured');
  }

  try {
    const signature = req.headers['x-razorpay-signature'];
    const rawBody = JSON.stringify(req.body);

    const expectedSignature = crypto
      .createHmac('sha256', RAZORPAY_WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex');

    if (expectedSignature !== signature) {
      console.warn('Webhook signature mismatch');
      return res.status(400).send('Invalid signature');
    }

    const event = req.body;

    if (event.event === 'payment.captured') {
      const payment = event.payload.payment.entity;
      const paymentId = payment.id;
      const razorpayOrderId = payment.order_id;

      // If verify-payment.js already recorded this one (the normal
      // path), don't duplicate it.
      const existing = await kv.get('payment:' + paymentId);
      if (existing) {
        return res.status(200).send('OK - already recorded');
      }

      // Recovery path: Razorpay confirms this was genuinely paid, but
      // our frontend never confirmed back (closed tab, dropped
      // connection, etc). Record a minimal order so it isn't lost.
      const orderId = 'ORD-' + Date.now();
      const order = {
        id: orderId,
        razorpayOrderId: razorpayOrderId,
        paymentId: paymentId,
        date: new Date().toISOString(),
        dateStr: new Date().toLocaleString('en-IN', {
          day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
        }),
        customer: { note: 'Recovered via webhook - browser never confirmed. Check Razorpay dashboard payment notes for customer/cart details.' },
        items: [],
        totals: { total: payment.amount / 100 },
        status: 'paid',
        shippingStatus: 'pending',
        source: 'webhook-recovery'
      };

      await kv.set('order:' + orderId, order);
      await kv.set('payment:' + paymentId, order);
      await kv.lpush('orders:list', orderId);
      await kv.incr('orders:unread');

      console.log('Webhook recovered an unconfirmed order:', orderId);
    }

    return res.status(200).send('OK');
  } catch (err) {
    console.error('webhook error:', err);
    return res.status(500).send('Error');
  }
};
