'use strict';
/* ============================================
   routes/coupons.js
   Coupon system backed by the "coupons" Firestore collection.
   Doc id = the coupon code itself (uppercased), so codes are unique
   automatically.

   Exports THREE things (mounted separately in server.js):
   - publicRouter   -> POST /api/coupons/validate   (used by checkout.js)
   - adminRouter    -> CRUD under /api/admin/coupons (used by admin.js page)
   - validateCouponForAmount(code, amount) -> shared helper also used by
     routes/orders.js so /api/orders/create re-validates & applies the
     discount server-side (never trusts a discount the frontend sends).
   ============================================ */
const express = require('express');
const { db } = require('../config/firebase');

function requireAdminKey(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_SECRET_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function serializeCoupon(doc) {
  const c = doc.data();
  return {
    code: doc.id,
    discountType: c.discountType,
    discountValue: c.discountValue,
    minOrder: c.minOrder || 0,
    usageLimit: c.usageLimit || 0, // 0 = unlimited
    usedCount: c.usedCount || 0,
    expiry: c.expiry || null, // "YYYY-MM-DD" or null
    active: !!c.active,
    createdAt: c.createdAt ? c.createdAt.toDate().toISOString() : null
  };
}

/**
 * Core validation logic, shared by the public /validate endpoint and
 * /api/orders/create. Returns either { valid:true, coupon, discountAmount,
 * finalAmount } or { valid:false, error }.
 */
async function validateCouponForAmount(rawCode, amount) {
  const code = (rawCode || '').trim().toUpperCase();
  if (!code) return { valid: false, error: 'Please enter a coupon code.' };

  const doc = await db.collection('coupons').doc(code).get();
  if (!doc.exists) return { valid: false, error: 'Invalid coupon code.' };

  const c = doc.data();

  if (!c.active) return { valid: false, error: 'This coupon is no longer active.' };

  if (c.expiry) {
    const expiryEnd = new Date(`${c.expiry}T23:59:59`);
    if (Date.now() > expiryEnd.getTime()) return { valid: false, error: 'This coupon has expired.' };
  }

  if (c.usageLimit && c.usageLimit > 0 && (c.usedCount || 0) >= c.usageLimit) {
    return { valid: false, error: 'This coupon has reached its usage limit.' };
  }

  if (c.minOrder && amount < c.minOrder) {
    return { valid: false, error: `This coupon needs a minimum order of \u20b9${c.minOrder}.` };
  }

  let discountAmount = c.discountType === 'percent'
    ? Math.round((amount * c.discountValue) / 100)
    : c.discountValue;
  discountAmount = Math.max(0, Math.min(discountAmount, amount));

  return {
    valid: true,
    code,
    discountType: c.discountType,
    discountValue: c.discountValue,
    discountAmount,
    finalAmount: amount - discountAmount
  };
}

/**
 * Increments a coupon's usedCount. Called once an order actually gets paid
 * (webhook / status-check paid transition) — not at order creation — so
 * abandoned checkouts don't burn through the usage limit.
 */
async function incrementCouponUsage(code) {
  if (!code) return;
  try {
    await db.collection('coupons').doc(code).update({
      usedCount: require('firebase-admin').firestore.FieldValue.increment(1)
    });
  } catch (err) {
    console.error('[coupons] failed to increment usage for', code, err.message);
  }
}

/* ------------------------------------------------------------------ */
/* Public router — mounted at /api/coupons                             */
/* ------------------------------------------------------------------ */
const publicRouter = express.Router();

/**
 * POST /api/coupons/validate
 * Body: { code, amount }
 * Used by the checkout modal's "I have a coupon code" flow to preview the
 * discount before submitting the order. /api/orders/create re-validates
 * this independently, so this endpoint is display-only / non-authoritative.
 */
publicRouter.post('/validate', async (req, res) => {
  try {
    const { code, amount } = req.body || {};
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ valid: false, error: 'Invalid order amount.' });
    }
    const result = await validateCouponForAmount(code, numericAmount);
    res.json(result);
  } catch (err) {
    console.error('[coupons/validate]', err);
    res.status(500).json({ valid: false, error: 'Could not check that coupon right now.' });
  }
});

/* ------------------------------------------------------------------ */
/* Admin router — mounted at /api/admin/coupons                        */
/* ------------------------------------------------------------------ */
const adminRouter = express.Router();
adminRouter.use(requireAdminKey);

/**
 * GET /api/admin/coupons
 * Lists every coupon, newest first.
 */
adminRouter.get('/', async (req, res) => {
  try {
    const snap = await db.collection('coupons').orderBy('createdAt', 'desc').get();
    res.json(snap.docs.map(serializeCoupon));
  } catch (err) {
    console.error('[admin/coupons:list]', err);
    res.status(500).json({ error: 'Could not load coupons' });
  }
});

/**
 * POST /api/admin/coupons
 * Body: { code, discountType: "flat"|"percent", discountValue, minOrder,
 *         usageLimit, expiry ("YYYY-MM-DD" or null) }
 * Percent discounts are capped at 99%.
 */
adminRouter.post('/', async (req, res) => {
  try {
    const { code, discountType, discountValue, minOrder, usageLimit, expiry } = req.body || {};
    const cleanCode = (code || '').trim().toUpperCase();

    if (!cleanCode) return res.status(400).json({ error: 'Coupon code is required.' });
    if (!/^[A-Z0-9_-]{3,20}$/.test(cleanCode)) {
      return res.status(400).json({ error: 'Code must be 3-20 characters: letters, numbers, - or _' });
    }
    if (!['flat', 'percent'].includes(discountType)) {
      return res.status(400).json({ error: 'discountType must be "flat" or "percent".' });
    }
    const value = Number(discountValue);
    if (!Number.isFinite(value) || value <= 0) {
      return res.status(400).json({ error: 'discountValue must be a positive number.' });
    }
    if (discountType === 'percent' && value > 99) {
      return res.status(400).json({ error: 'Percent discounts cannot exceed 99%.' });
    }

    const ref = db.collection('coupons').doc(cleanCode);
    const existing = await ref.get();
    if (existing.exists) return res.status(409).json({ error: 'A coupon with this code already exists.' });

    await ref.set({
      code: cleanCode,
      discountType,
      discountValue: value,
      minOrder: Number(minOrder) > 0 ? Number(minOrder) : 0,
      usageLimit: Number(usageLimit) > 0 ? Number(usageLimit) : 0,
      usedCount: 0,
      expiry: expiry || null,
      active: true,
      createdAt: require('firebase-admin').firestore.FieldValue.serverTimestamp()
    });

    const saved = await ref.get();
    res.status(201).json(serializeCoupon(saved));
  } catch (err) {
    console.error('[admin/coupons:create]', err);
    res.status(500).json({ error: 'Could not create coupon' });
  }
});

/**
 * PATCH /api/admin/coupons/:code
 * Body: any of { discountType, discountValue, minOrder, usageLimit, expiry, active }
 * Used both for full edits and for the quick "disable/enable" toggle.
 */
adminRouter.patch('/:code', async (req, res) => {
  try {
    const cleanCode = req.params.code.trim().toUpperCase();
    const ref = db.collection('coupons').doc(cleanCode);
    const existing = await ref.get();
    if (!existing.exists) return res.status(404).json({ error: 'Coupon not found' });

    const updates = {};
    const body = req.body || {};

    if (body.discountType !== undefined) {
      if (!['flat', 'percent'].includes(body.discountType)) {
        return res.status(400).json({ error: 'discountType must be "flat" or "percent".' });
      }
      updates.discountType = body.discountType;
    }
    if (body.discountValue !== undefined) {
      const value = Number(body.discountValue);
      if (!Number.isFinite(value) || value <= 0) {
        return res.status(400).json({ error: 'discountValue must be a positive number.' });
      }
      const type = body.discountType || existing.data().discountType;
      if (type === 'percent' && value > 99) {
        return res.status(400).json({ error: 'Percent discounts cannot exceed 99%.' });
      }
      updates.discountValue = value;
    }
    if (body.minOrder !== undefined) updates.minOrder = Number(body.minOrder) > 0 ? Number(body.minOrder) : 0;
    if (body.usageLimit !== undefined) updates.usageLimit = Number(body.usageLimit) > 0 ? Number(body.usageLimit) : 0;
    if (body.expiry !== undefined) updates.expiry = body.expiry || null;
    if (body.active !== undefined) updates.active = !!body.active;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update.' });
    }

    await ref.update(updates);
    const saved = await ref.get();
    res.json(serializeCoupon(saved));
  } catch (err) {
    console.error('[admin/coupons:update]', err);
    res.status(500).json({ error: 'Could not update coupon' });
  }
});

/**
 * DELETE /api/admin/coupons/:code
 */
adminRouter.delete('/:code', async (req, res) => {
  try {
    const cleanCode = req.params.code.trim().toUpperCase();
    await db.collection('coupons').doc(cleanCode).delete();
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/coupons:delete]', err);
    res.status(500).json({ error: 'Could not delete coupon' });
  }
});

module.exports = { publicRouter, adminRouter, validateCouponForAmount, incrementCouponUsage };