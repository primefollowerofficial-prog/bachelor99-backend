'use strict';
const express = require('express');
const { db, admin } = require('../config/firebase');
const { toISTDateString } = require('../utils/daterange');

const router = express.Router();

const VALID_EVENTS = ['visit', 'product_view', 'buy_click', 'checkout_start'];

/**
 * POST /api/track/event
 * Fire-and-forget call from the frontend (script.js / checkout.js) used to
 * build the conversion funnel: visit -> product_view -> buy_click ->
 * checkout_start -> (purchase is tracked separately via dailyStats.salesCount
 * in routes/orders.js when a payment is confirmed).
 * Body: { event: "visit"|"product_view"|"buy_click"|"checkout_start", page }
 */
router.post('/event', async (req, res) => {
  try {
    const { event, page } = req.body || {};
    const safeEvent = VALID_EVENTS.includes(event) ? event : null;
    if (!safeEvent) return res.status(204).end();

    const dateKey = toISTDateString(new Date());
    const update = {
      funnel: { [safeEvent]: admin.firestore.FieldValue.increment(1) }
    };
    // Keep the existing "visitors" field working for anything already reading it.
    if (safeEvent === 'visit') {
      update.visitors = admin.firestore.FieldValue.increment(1);
      update[`visitsByPage.${page || 'unknown'}`] = admin.firestore.FieldValue.increment(1);
    }

    await db.collection('dailyStats').doc(dateKey).set(update, { merge: true });
    res.status(204).end();
  } catch (err) {
    console.error('[track/event]', err);
    res.status(204).end(); // never break the page over an analytics failure
  }
});

/**
 * POST /api/track/visit
 * Kept for backward compatibility with any old callers — same effect as
 * POST /api/track/event with { event: "visit" }.
 * Body (optional): { page: "home" | "cart" | "checkout" }
 */
router.post('/visit', async (req, res) => {
  try {
    const page = (req.body && req.body.page) || 'unknown';
    const dateKey = toISTDateString(new Date());

    await db.collection('dailyStats').doc(dateKey).set({
      visitors: admin.firestore.FieldValue.increment(1),
      [`visitsByPage.${page}`]: admin.firestore.FieldValue.increment(1),
      funnel: { visit: admin.firestore.FieldValue.increment(1) }
    }, { merge: true });

    res.status(204).end();
  } catch (err) {
    console.error('[track/visit]', err);
    res.status(204).end();
  }
});

module.exports = router;