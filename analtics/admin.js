'use strict';
const express = require('express');
const { db } = require('../config/firebase');
const { resolveRange } = require('/utils/dateRange');

const router = express.Router();

function requireAdminKey(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_SECRET_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

/**
 * POST /api/admin/login
 * Body: { key }
 * The admin page calls this once so it can tell a wrong password from a
 * network error, then stores the key client-side to send as x-admin-key.
 */
router.post('/login', (req, res) => {
  const { key } = req.body || {};
  if (key && key === process.env.ADMIN_SECRET_KEY) {
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Incorrect admin key' });
});

/**
 * GET /api/admin/dashboard?range=today|7d|30d|all
 * Returns totals + a day-by-day breakdown for the charts.
 */
router.get('/dashboard', requireAdminKey, async (req, res) => {
  try {
    const range = ['today', '7d', '30d', 'all'].includes(req.query.range) ? req.query.range : '7d';
    const { days } = resolveRange(range);

    let dailyDocs = [];

    if (range === 'all') {
      const snap = await db.collection('dailyStats').orderBy(require('firebase-admin').firestore.FieldPath.documentId()).get();
      dailyDocs = snap.docs.map(d => ({ date: d.id, ...d.data() }));
    } else {
      // Fetch each day's doc in the range (small, bounded set — max 30 reads)
      const refs = days.map(day => db.collection('dailyStats').doc(day));
      const snaps = await db.getAll(...refs);
      dailyDocs = snaps.map((snap, i) => ({
        date: days[i],
        salesCount: snap.exists ? (snap.data().salesCount || 0) : 0,
        revenue: snap.exists ? (snap.data().revenue || 0) : 0,
        visitors: snap.exists ? (snap.data().visitors || 0) : 0
      }));
    }

    const totals = dailyDocs.reduce((acc, d) => {
      acc.salesCount += d.salesCount || 0;
      acc.revenue += d.revenue || 0;
      acc.visitors += d.visitors || 0;
      return acc;
    }, { salesCount: 0, revenue: 0, visitors: 0 });

    // Recent orders list — handy for "latest purchases" table on the admin page
    const ordersSnap = await db.collection('orders')
      .where('status', '==', 'paid')
      .orderBy('paidAt', 'desc')
      .limit(20)
      .get();
    const recentOrders = ordersSnap.docs.map(d => {
      const o = d.data();
      return {
        orderId: o.orderId,
        customerName: o.customerName,
        email: o.email,
        quantity: o.quantity,
        amount: o.amount,
        paidAt: o.paidAt ? o.paidAt.toDate().toISOString() : null
      };
    });

    res.json({
      range,
      totals,
      daily: dailyDocs.map(d => ({
        date: d.date,
        salesCount: d.salesCount || 0,
        revenue: d.revenue || 0,
        visitors: d.visitors || 0
      })),
      recentOrders
    });
  } catch (err) {
    console.error('[admin/dashboard]', err);
    res.status(500).json({ error: 'Could not load dashboard data' });
  }
});

module.exports = router;