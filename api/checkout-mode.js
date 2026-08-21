const { kv } = require('@vercel/kv');
const { requireAdmin } = require('../lib/adminAuth');

// ---------------------------------------------------------------------
// Stores ONE setting in KV: whether the storefront checkout collects
// payment via Razorpay or just hands off the order to WhatsApp.
// GET is public (checkout.html needs it, unauthenticated, on every load).
// POST is admin-only (this is what changes live checkout behavior for
// every customer, so only the logged-in admin can flip it).
// ---------------------------------------------------------------------

const allowedOrigins = [
  'https://shanmugamenswear.vercel.app',
  'http://127.0.0.1:5500',
  'http://localhost:5500',
  'http://localhost:3000'
];

const SETTINGS_KEY = 'settings:checkoutMode';
const VALID_MODES = ['whatsapp', 'razorpay'];

module.exports = async function handler(req, res) {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    // Public on purpose — every visitor's checkout.html calls this.
    try {
      const mode = (await kv.get(SETTINGS_KEY)) || 'whatsapp';
      return res.status(200).json({ mode });
    } catch (err) {
      console.error('checkout-mode GET error:', err);
      // Fail safe to WhatsApp mode rather than breaking checkout entirely.
      return res.status(200).json({ mode: 'whatsapp' });
    }
  }

  if (req.method === 'POST') {
    if (!(await requireAdmin(req, res))) return; // sends 401 itself if not logged in

    const { mode } = req.body || {};
    if (!VALID_MODES.includes(mode)) {
      return res.status(400).json({ error: 'mode must be "whatsapp" or "razorpay"' });
    }
    try {
      await kv.set(SETTINGS_KEY, mode);
      return res.status(200).json({ ok: true, mode });
    } catch (err) {
      console.error('checkout-mode POST error:', err);
      return res.status(500).json({ error: 'Could not save setting' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
