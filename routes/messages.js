'use strict';
/* ============================================
   routes/messages.js
   Admin-only endpoints for reviewing "Contact Us" submissions saved by
   routes/contact.js into the "contactMessages" Firestore collection.
   Mounted at /api/admin/messages in server.js.
   ============================================ */
const express = require('express');
const { db } = require('../config/firebase');

const router = express.Router();

// Same pattern as routes/admin.js's requireAdminKey.
function requireAdminKey(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_SECRET_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

/**
 * GET /api/admin/messages
 * Returns every contact message, newest first, with the Firestore doc id
 * included so the admin page can mark individual messages read/replied.
 */
router.get('/', requireAdminKey, async (req, res) => {
  try {
    const snap = await db.collection('contactMessages').orderBy('createdAt', 'desc').limit(200).get();
    const messages = snap.docs.map(d => {
      const m = d.data();
      return {
        id: d.id,
        name: m.name || '',
        email: m.email || '',
        message: m.message || '',
        status: m.status || 'new',
        createdAt: m.createdAt ? m.createdAt.toDate().toISOString() : null
      };
    });
    res.json(messages);
  } catch (err) {
    console.error('[admin/messages]', err);
    res.status(500).json({ error: 'Could not load messages' });
  }
});

/**
 * PATCH /api/admin/messages/:id
 * Body: { status: "read" | "replied" }
 */
router.patch('/:id', requireAdminKey, async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!['new', 'read', 'replied'].includes(status)) {
      return res.status(400).json({ error: 'status must be one of: new, read, replied' });
    }
    const ref = db.collection('contactMessages').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Message not found' });

    await ref.update({ status });
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/messages:update]', err);
    res.status(500).json({ error: 'Could not update message' });
  }
});

module.exports = router;