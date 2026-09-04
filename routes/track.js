'use strict';
const express = require('express');
const { db, admin } = require('../config/firebase');
const { toISTDateString } = require('/utils/dateRange');

const router = express.Router();

/**
 * POST /api/track/visit
 * Fire-and-forget call from script.js on page load. Increments a simple
 * per-day visit counter used by the admin dashboard.
 * Body (optional): { page: "home" | "cart" | "checkout" }
 */
router.post('/visit', async (req, res) => {
  try {
    const page = (req.body && req.body.page) || 'unknown';
    const dateKey = toISTDateString(new Date());

    await db.collection('dailyStats').doc(dateKey).set({
      visitors: admin.firestore.FieldValue.increment(1),
      [`visitsByPage.${page}`]: admin.firestore.FieldValue.increment(1)
    }, { merge: true });

    res.status(204).end();
  } catch (err) {
    console.error('[track/visit]', err);
    // Never break the page over an analytics failure
    res.status(204).end();
  }
});

module.exports = router;