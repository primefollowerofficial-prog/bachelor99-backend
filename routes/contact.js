'use strict';
/* ============================================
   routes/contact.js
   Handles the "Contact Us" form. Every submission is saved to the
   "contactMessages" Firestore collection so it can be viewed from an
   admin dashboard later.
   ============================================ */
const express = require('express');
const { db, admin } = require('../config/firebase');

const router = express.Router();

function isValidEmail(email) {
  return /^\S+@\S+\.\S+$/.test(email);
}

/**
 * POST /api/contact
 * Body: { name, email, message }
 */
router.post('/', async (req, res) => {
  try {
    const { name, email, message } = req.body || {};

    const cleanName = (name || '').trim();
    const cleanEmail = (email || '').trim().toLowerCase();
    const cleanMessage = (message || '').trim();

    if (!cleanName) return res.status(400).json({ error: 'Name is required.' });
    if (!isValidEmail(cleanEmail)) return res.status(400).json({ error: 'A valid email is required.' });
    if (!cleanMessage) return res.status(400).json({ error: 'Message is required.' });
    if (cleanMessage.length > 2000) return res.status(400).json({ error: 'Message is too long.' });

    await db.collection('contactMessages').add({
      name: cleanName,
      email: cleanEmail,
      message: cleanMessage,
      status: 'new', // new | read | replied — handy for an admin dashboard later
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[contact]', err);
    res.status(500).json({ error: 'Could not send your message. Please try again.' });
  }
});

module.exports = router;