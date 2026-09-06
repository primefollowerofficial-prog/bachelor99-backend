'use strict';
const express = require('express');
const { db, admin } = require('../config/firebase');
const { resolveRange, toISTDateString } = require('../utils/daterange');

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
 * Fetches each dailyStats doc covered by `range` (or all of them for 'all').
 * Returns an array of { date, salesCount, revenue, visitors, funnel }.
 */
async function fetchDailyDocs(range, days) {
  if (range === 'all') {
    const snap = await db.collection('dailyStats').orderBy(admin.firestore.FieldPath.documentId()).get();
    return snap.docs.map(d => {
      const data = d.data();
      return {
        date: d.id,
        salesCount: data.salesCount || 0,
        revenue: data.revenue || 0,
        visitors: data.visitors || 0,
        funnel: data.funnel || {}
      };
    });
  }
  const refs = days.map(day => db.collection('dailyStats').doc(day));
  const snaps = await db.getAll(...refs);
  return snaps.map((snap, i) => {
    const data = snap.exists ? snap.data() : {};
    return {
      date: days[i],
      salesCount: data.salesCount || 0,
      revenue: data.revenue || 0,
      visitors: data.visitors || 0,
      funnel: data.funnel || {}
    };
  });
}

/**
 * Sums quantity + distinct customer emails from paid orders in the range.
 * dailyStats doesn't track per-customer info, so this reads the orders
 * collection directly (bounded — small store, fine to scan all paid orders).
 */
async function fetchOrderAggregates(range) {
  let query = db.collection('orders').where('status', '==', 'paid');
  if (range !== 'all') {
    const { startDate } = resolveRange(range);
    query = query.where('paidAt', '>=', admin.firestore.Timestamp.fromDate(startDate));
  }
  const snap = await query.get();
  let ebooksSold = 0;
  const emails = new Set();
  snap.docs.forEach(d => {
    const o = d.data();
    ebooksSold += o.quantity || 0;
    if (o.email) emails.add(o.email);
  });
  return { ebooksSold, customers: emails.size };
}

/**
 * GET /api/admin/dashboard?range=today|7d|30d|all
 * Returns KPI totals + a day-by-day breakdown for the charts + recent orders.
 */
router.get('/dashboard', requireAdminKey, async (req, res) => {
  try {
    const range = ['today', '7d', '30d', 'all'].includes(req.query.range) ? req.query.range : '7d';
    const { days } = resolveRange(range);

    const [dailyDocs, orderAgg, todaySnap] = await Promise.all([
      fetchDailyDocs(range, days),
      fetchOrderAggregates(range),
      db.collection('dailyStats').doc(toISTDateString(new Date())).get()
    ]);

    const base = dailyDocs.reduce((acc, d) => {
      acc.salesCount += d.salesCount || 0;
      acc.revenue += d.revenue || 0;
      acc.visitors += d.visitors || 0;
      return acc;
    }, { salesCount: 0, revenue: 0, visitors: 0 });

    const totals = {
      ...base,
      customers: orderAgg.customers,
      ebooksSold: orderAgg.ebooksSold,
      averageOrderValue: base.salesCount > 0 ? Math.round(base.revenue / base.salesCount) : 0,
      conversionRate: base.visitors > 0 ? Number(((base.salesCount / base.visitors) * 100).toFixed(2)) : 0,
      todayRevenue: todaySnap.exists ? (todaySnap.data().revenue || 0) : 0
    };

    // Recent orders list — handy for the "Recent Orders" table
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
        couponCode: o.couponCode || null,
        paidAt: o.paidAt ? o.paidAt.toDate().toISOString() : null
      };
    });

    res.json({
      range,
      totals,
      daily: dailyDocs.map(d => ({
        date: d.date,
        salesCount: d.salesCount,
        revenue: d.revenue,
        visitors: d.visitors
      })),
      recentOrders
    });
  } catch (err) {
    console.error('[admin/dashboard]', err);
    res.status(500).json({ error: 'Could not load dashboard data' });
  }
});

/**
 * GET /api/admin/funnel?range=today|7d|30d|all
 * Aggregates the visit -> product_view -> buy_click -> checkout_start ->
 * purchase funnel across the selected range.
 */
router.get('/funnel', requireAdminKey, async (req, res) => {
  try {
    const range = ['today', '7d', '30d', 'all'].includes(req.query.range) ? req.query.range : '7d';
    const { days } = resolveRange(range);
    const dailyDocs = await fetchDailyDocs(range, days);

    const totals = dailyDocs.reduce((acc, d) => {
      acc.visitors += d.visitors || 0;
      acc.product_view += (d.funnel && d.funnel.product_view) || 0;
      acc.buy_click += (d.funnel && d.funnel.buy_click) || 0;
      acc.checkout_start += (d.funnel && d.funnel.checkout_start) || 0;
      acc.purchases += d.salesCount || 0;
      return acc;
    }, { visitors: 0, product_view: 0, buy_click: 0, checkout_start: 0, purchases: 0 });

    const conversionRate = totals.visitors > 0
      ? Number(((totals.purchases / totals.visitors) * 100).toFixed(2))
      : 0;

    res.json({
      range,
      steps: [
        { label: 'Visitors', value: totals.visitors },
        { label: 'Viewed Product', value: totals.product_view },
        { label: 'Clicked Buy Now', value: totals.buy_click },
        { label: 'Started Checkout', value: totals.checkout_start },
        { label: 'Payment Successful', value: totals.purchases }
      ],
      conversionRate
    });
  } catch (err) {
    console.error('[admin/funnel]', err);
    res.status(500).json({ error: 'Could not load funnel data' });
  }
});

module.exports = router;