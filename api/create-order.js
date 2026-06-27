const Razorpay = require('razorpay');

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET } = process.env;

  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
    console.error('Missing Razorpay credentials');
    return res.status(500).json({ error: 'Payment gateway not configured' });
  }

  const { amount, currency = 'INR', receipt, notes } = req.body || {};

  if (!amount || typeof amount !== 'number' || amount < 100) {
    return res.status(400).json({ error: 'Invalid amount. Must be at least Rs.1 (100 paise).' });
  }

  if (amount > 50000000) {
    return res.status(400).json({ error: 'Amount exceeds maximum limit.' });
  }

  try {
    const razorpay = new Razorpay({
      key_id:     RAZORPAY_KEY_ID,
      key_secret: RAZORPAY_KEY_SECRET
    });

    const order = await razorpay.orders.create({
      amount:          Math.round(amount),
      currency:        'INR',
      receipt:         (receipt || ('SMW' + Date.now())).substring(0, 40),
      notes:           notes || {},
      payment_capture: 1
    });

    return res.status(200).json({
      id:       order.id,
      amount:   order.amount,
      currency: order.currency,
      receipt:  order.receipt
    });

  } catch (err) {
    console.error('Razorpay order error:', err);
    return res.status(502).json({
      error: 'Could not create payment order. Please try again.',
      code:  err.error ? err.error.code : 'UNKNOWN'
    });
  }
};
