const { kv } = require('@vercel/kv');
const { requireAdmin } = require('../lib/adminAuth');

// Live per-size stock overlay.
//
// Source of truth for the "starting" stock number is still
// smw-products.js (committed to GitHub via the admin Publish flow).
// This endpoint layers LIVE adjustments on top of that, in Vercel KV,
// so a sale (via Razorpay checkout or a manually-logged WhatsApp sale)
// can reduce stock instantly without touching GitHub:
//
//   stock:<productId>  →  KV hash, e.g. { "38": "0", "40": "3" }
//
// GET  /api/stock?ids=101,102        — public, read-only. Returns only
//                                       the products that have a live
//                                       override; anything absent means
//                                       "use the number from smw-products.js
//                                       as-is."
// POST /api/stock  {action:'set'}        — admin only. Replaces the live
//                                       hash for one product (called right
//                                       after Publish, so live stock matches
//                                       what was just committed).
// POST /api/stock  {action:'decrement'}  — admin only. Subtracts qty from
//                                       one product/size, floored at 0
//                                       (called by verify-payment.js
//                                       indirectly via direct kv access,
//                                       and by the "Log WhatsApp Sale"
//                                       admin action via this endpoint).

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const idsParam = (req.query && req.query.ids) || '';
    const ids = idsParam.split(',').map(s => s.trim()).filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: 'ids query param required' });
    try {
      const out = {};
      for (const id of ids) {
        const hash = await kv.hgetall('stock:' + id);
        if (hash && Object.keys(hash).length) {
          const norm = {};
          for (const size in hash) norm[size] = parseInt(hash[size], 10) || 0;
          out[id] = norm;
        }
      }
      return res.status(200).json({ stock: out });
    } catch (err) {
      console.error('stock GET error:', err);
      return res.status(500).json({ error: 'Could not read stock' });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!(await requireAdmin(req, res))) return;

  const { action, productId } = req.body || {};
  if (!productId) return res.status(400).json({ error: 'productId required' });

  try {
    if (action === 'set') {
      const { sizeStock } = req.body || {};
      const key = 'stock:' + productId;
      await kv.del(key);
      if (sizeStock && Object.keys(sizeStock).length) {
        const norm = {};
        for (const size in sizeStock) norm[size] = String(parseInt(sizeStock[size], 10) || 0);
        await kv.hset(key, norm);
      }
      return res.status(200).json({ ok: true });
    }

    if (action === 'decrement') {
      const { size, qty, baseQty } = req.body || {};
      if (!size || !qty) return res.status(400).json({ error: 'size and qty required' });
      const result = await decrementStock(productId, size, qty, baseQty);
      return res.status(200).json({ ok: true, newQty: result });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('stock POST error:', err);
    return res.status(500).json({ error: 'Could not update stock' });
  }
};

// Shared by this endpoint (WhatsApp sale logging) and verify-payment.js
// (Razorpay sale), so both paths reduce stock the same safe way — read
// the live value, floor at zero, write back.
//
// baseQtyFallback: if there's no live KV override yet for this size,
// this serverless function has no way to know the "starting" number —
// that only lives in smw-products.js on GitHub. Callers that already
// have the product loaded (admin.html, verify-payment.js) should pass
// the current sizeStock value here so the first-ever sale still
// subtracts from the right starting point instead of from 0.
async function decrementStock(productId, size, qty, baseQtyFallback) {
  const key = 'stock:' + productId;
  const current = await kv.hget(key, size);
  const base = current != null ? (parseInt(current, 10) || 0) : (parseInt(baseQtyFallback, 10) || 0);
  const newQty = Math.max(0, base - qty);
  await kv.hset(key, { [size]: String(newQty) });
  return newQty;
}

module.exports.decrementStock = decrementStock;

// Live stock (KV) only tracks ADJUSTMENTS. The starting number for a
// size that has never been sold yet lives in smw-products.js on GitHub,
// so on the very first sale of a size we fetch that file to know what
// to count down from. Shared by verify-payment.js (Razorpay) and
// create-whatsapp-order.js (customer-facing WhatsApp checkout) so both
// paths use the exact same fallback logic.
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
module.exports.fetchBaseSizeStock = fetchBaseSizeStock;
