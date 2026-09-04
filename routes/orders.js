'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db, admin } = require('../config/firebase');
const cashfree = require('../config/cashfree');
const { toISTDateString } = require('/utils/dateRange');

const router = express.Router();

const PRICE_PER_UNIT = Number(process.env.PRICE_PER_UNIT || 99);
const DOWNLOAD_URL = process.env.EBOOK_DOWNLOAD_URL || '';

function isValidEmail(email) {
  return /^\S+@\S+\.\S+$/.test(email);
}
function isValidPhone(phone) {
  return /^\d{10}$/.test(phone);
}

/**
 * POST /api/orders/create
 * Body: { firstName, lastName, email, phone, quantity, marketingOptIn }
 * Creates a Firestore "pending" order, then a matching Cashfree order,
 * and returns the paymentSessionId the frontend needs to open Cashfree checkout.
 */
router.post('/create', async (req, res) => {
  try {
    const { firstName, lastName, email, phone, quantity, marketingOptIn } = req.body || {};

    const fName = (firstName || '').trim();
    const lName = (lastName || '').trim();
    const qty = Math.max(1, parseInt(quantity, 10) || 1);

    if (!fName) return res.status(400).json({ error: 'First name is required.' });
    if (!lName) return res.status(400).json({ error: 'Last name is required.' });
    if (!isValidEmail(email || '')) return res.status(400).json({ error: 'A valid email is required.' });
    if (!isValidPhone((phone || '').replace(/\D/g, ''))) return res.status(400).json({ error: 'A valid 10-digit phone number is required.' });

    const cleanPhone = phone.replace(/\D/g, '');
    const customerName = `${fName} ${lName}`.trim();
    const amount = PRICE_PER_UNIT * qty; // server is the source of truth for price
    const orderId = `BC99-${Date.now()}-${uuidv4().slice(0, 8)}`;
    const nowDate = new Date();

    // 1. Write pending order to Firestore first
    await db.collection('orders').doc(orderId).set({
      orderId,
      firstName: fName,
      lastName: lName,
      customerName,
      email: email.trim().toLowerCase(),
      phone: cleanPhone,
      quantity: qty,
      amount,
      marketingOptIn: !!marketingOptIn,
      status: 'pending',
      cfOrderId: null,
      paymentSessionId: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      dateKey: toISTDateString(nowDate) // used for fast admin-dashboard bucketing
    });

    // 2. Create the matching order with Cashfree
    let cfResult;
    try {
      cfResult = await cashfree.createOrder({ orderId, amount, customerName, email, phone: cleanPhone });
    } catch (cfErr) {
      await db.collection('orders').doc(orderId).update({
        status: 'failed',
        failureReason: cfErr.message,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      throw cfErr;
    }

    // 3. Save Cashfree references back onto the order
    await db.collection('orders').doc(orderId).update({
      cfOrderId: cfResult.cfOrderId,
      paymentSessionId: cfResult.paymentSessionId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({
      orderId,
      paymentSessionId: cfResult.paymentSessionId,
      mode: cashfree.CASHFREE_ENV
    });
  } catch (err) {
    console.error('[orders/create]', err);
    res.status(500).json({ error: err.message || 'Could not start checkout. Please try again.' });
  }
});

/**
 * POST /api/orders/webhook
 * Cashfree calls this after a payment attempt. This is the ONLY place
 * an order is ever marked "paid" — never trust the frontend for this.
 * Mounted with express.raw() in server.js so req.body is the raw Buffer.
 */
router.post('/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-webhook-signature'];
    const timestamp = req.headers['x-webhook-timestamp'];
    const rawBody = req.body.toString('utf8');

    const isValid = cashfree.verifyWebhookSignature({ signature, timestamp, rawBody });
    if (!isValid) {
      console.warn('[webhook] Invalid signature — ignoring.');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const payload = JSON.parse(rawBody);
    const orderId = payload?.data?.order?.order_id;
    const paymentStatus = payload?.data?.payment?.payment_status; // SUCCESS | FAILED | ...

    if (!orderId) return res.status(400).json({ error: 'Missing order_id in webhook payload' });

    const orderRef = db.collection('orders').doc(orderId);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) {
      console.warn(`[webhook] Unknown order_id: ${orderId}`);
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderSnap.data();
    const newStatus = paymentStatus === 'SUCCESS' ? 'paid' : (paymentStatus ? 'failed' : order.status);

    // Avoid double-processing if Cashfree retries the same webhook
    if (order.status !== 'paid' && newStatus === 'paid') {
      await orderRef.update({
        status: 'paid',
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // Roll up daily stats for the admin dashboard
      const statsRef = db.collection('dailyStats').doc(order.dateKey);
      await statsRef.set({
        salesCount: admin.firestore.FieldValue.increment(order.quantity || 1),
        revenue: admin.firestore.FieldValue.increment(order.amount || 0)
      }, { merge: true });
    } else if (newStatus === 'failed' && order.status !== 'failed' && order.status !== 'paid') {
      await orderRef.update({
        status: 'failed',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[orders/webhook]', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

/**
 * GET /api/orders/status/:orderId
 * Used by thankyou.html to poll whether payment succeeded.
 * Double-checks with Cashfree directly in case the webhook hasn't arrived yet.
 */
router.get('/status/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const orderRef = db.collection('orders').doc(orderId);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) return res.status(404).json({ error: 'Order not found' });

    let order = orderSnap.data();

    // If still pending, ask Cashfree directly (webhook may be delayed)
    if (order.status === 'pending') {
      try {
        const cfOrder = await cashfree.getOrderStatus(orderId);
        if (cfOrder.order_status === 'PAID' && order.status !== 'paid') {
          await orderRef.update({
            status: 'paid',
            paidAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
          const statsRef = db.collection('dailyStats').doc(order.dateKey);
          await statsRef.set({
            salesCount: admin.firestore.FieldValue.increment(order.quantity || 1),
            revenue: admin.firestore.FieldValue.increment(order.amount || 0)
          }, { merge: true });
          order.status = 'paid';
        } else if (['EXPIRED', 'TERMINATED'].includes(cfOrder.order_status) && order.status === 'pending') {
          await orderRef.update({ status: 'failed', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
          order.status = 'failed';
        }
      } catch (pollErr) {
        console.warn('[orders/status] Cashfree poll failed:', pollErr.message);
      }
    }

    res.json({
      orderId: order.orderId,
      status: order.status, // pending | paid | failed
      customerName: order.customerName,
      quantity: order.quantity,
      amount: order.amount,
      downloadUrl: order.status === 'paid' ? DOWNLOAD_URL : null
    });
  } catch (err) {
    console.error('[orders/status]', err);
    res.status(500).json({ error: 'Could not check order status' });
  }
});

module.exports = router;