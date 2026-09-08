'use strict';
require('dotenv').config();

const express = require('express');
const cors = require('cors');

const ordersRouter = require('./routes/orders');
const trackRouter = require('./routes/track');
const adminRouter = require('./routes/admin');
const contactRouter = require('./routes/contact');
const messagesRouter = require('./routes/messages');
const otpRouter = require('./routes/otp');
const chatbotRouter = require('./routes/chatbot');
const { publicRouter: couponsPublicRouter, adminRouter: couponsAdminRouter } = require('./routes/coupons');

const app = express();
const PORT = process.env.PORT || 3000;

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    // Allow non-browser requests (curl, server-to-server) with no origin header
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  }
}));

// The Cashfree webhook needs the RAW body to verify the signature,
// so it must be mounted with express.raw() BEFORE the global JSON parser.
app.use('/api/orders/webhook', express.raw({ type: '*/*' }));

// Everything else gets normal JSON parsing.
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'bachelor99-backend' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.use('/api/orders', ordersRouter);
app.use('/api/track', trackRouter);
app.use('/api/admin', adminRouter);
app.use('/api/admin/messages', messagesRouter);
app.use('/api/admin/coupons', couponsAdminRouter);
app.use('/api/coupons', couponsPublicRouter);
app.use('/api/contact', contactRouter);
app.use('/api/otp', otpRouter);
app.use('/api/chat', chatbotRouter);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Central error handler
app.use((err, req, res, next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Bachelor99 backend running on port ${PORT} (Cashfree env: ${process.env.CASHFREE_ENV || 'sandbox'})`);
});
