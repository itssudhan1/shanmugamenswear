const { kv } = require('@vercel/kv');

// Lets the admin panel update shipping status or delete an order.
// Protected by the same x-admin-key used by /api/orders.
//
//   PATCH /api/order-update   body: { id, shippingStatus }
//   DELETE /api/order-update  body: { id }

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
  res.setHeader('Access-Control-Allow-Methods', 'PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { ADMIN_KEY } = process.env;
  const suppliedKey = req.headers['x-admin-key'];

  if (!ADMIN_KEY || !suppliedKey || suppliedKey !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { id, shippingStatus } = req.body || {};

  if (!id) {
    return res.status(400).json({ error: 'Missing order id' });
  }

  try {
    if (req.method === 'PATCH') {
      const validStatuses = ['pending', 'dispatched', 'delivered', 'cancelled'];
      if (!validStatuses.includes(shippingStatus)) {
        return res.status(400).json({ error: 'Invalid shippingStatus' });
      }

      const order = await kv.get('order:' + id);
      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }

      order.shippingStatus = shippingStatus;
      await kv.set('order:' + id, order);
      // keep the payment-keyed copy in sync too, since verify-payment
      // and the webhook both write through that key as well
      if (order.paymentId) {
        await kv.set('payment:' + order.paymentId, order);
      }

      return res.status(200).json({ success: true, order });
    }

    if (req.method === 'DELETE') {
      const order = await kv.get('order:' + id);
      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }

      await kv.del('order:' + id);
      if (order.paymentId) {
        await kv.del('payment:' + order.paymentId);
      }
      await kv.lrem('orders:list', 0, id);

      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('order-update error:', err);
    return res.status(500).json({ error: 'Could not update order' });
  }
};
