'use strict';
const express = require('express');
const { db, admin } = require('../config/firebase');
const { sendOtpEmail } = require('../config/brevo');

const router = express.Router();

const OTP_TTL_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 30 * 1000;

function isValidEmail(email) {
  return /^\S+@\S+\.\S+$/.test(email);
}
function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/**
 * POST /api/otp/send
 * Body: { email }
 */
router.post('/send', async (req, res) => {
  try {
    const email = (req.body?.email || '').trim().toLowerCase();
    if (!isValidEmail(email)) return res.status(400).json({ error: 'A valid email is required.' });

    const ref = db.collection('emailOtps').doc(email);
    const snap = await ref.get();
    if (snap.exists) {
      const data = snap.data();
      if (data.lastSentAt && Date.now() - data.lastSentAt.toMillis() < RESEND_COOLDOWN_MS) {
        return res.status(429).json({ error: 'Please wait a few seconds before requesting another code.' });
      }
    }

    const otp = generateOtp();
    await ref.set({
      otp,
      verified: false,
      expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + OTP_TTL_MS),
      lastSentAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await sendOtpEmail(email, otp);
    res.json({ ok: true });
  } catch (err) {
    console.error('[otp/send]', err);
    res.status(500).json({ error: 'Could not send verification code. Please try again.' });
  }
});

/**
 * POST /api/otp/verify
 * Body: { email, otp }
 */
router.post('/verify', async (req, res) => {
  try {
    const email = (req.body?.email || '').trim().toLowerCase();
    const otp = (req.body?.otp || '').trim();
    if (!isValidEmail(email)) return res.status(400).json({ error: 'A valid email is required.' });
    if (!otp) return res.status(400).json({ error: 'Please enter the code.' });

    const ref = db.collection('emailOtps').doc(email);
    const snap = await ref.get();
    if (!snap.exists) return res.status(400).json({ error: 'Please request a new code.' });

    const data = snap.data();
    if (data.expiresAt && Date.now() > data.expiresAt.toMillis()) {
      return res.status(400).json({ error: 'This code has expired. Please request a new one.' });
    }
    if (data.otp !== otp) {
      return res.status(400).json({ error: 'Incorrect code. Please try again.' });
    }

    await ref.update({ verified: true, verifiedAt: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ ok: true, verified: true });
  } catch (err) {
    console.error('[otp/verify]', err);
    res.status(500).json({ error: 'Could not verify code. Please try again.' });
  }
});

module.exports = router;