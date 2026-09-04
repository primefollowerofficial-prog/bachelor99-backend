'use strict';
const fetch = require('node-fetch');
const crypto = require('crypto');

const CASHFREE_ENV = (process.env.CASHFREE_ENV || 'sandbox').toLowerCase();
const BASE_URL = CASHFREE_ENV === 'production'
  ? 'https://api.cashfree.com/pg'
  : 'https://sandbox.cashfree.com/pg';

const API_VERSION = '2023-08-01';

function headers() {
  return {
    'Content-Type': 'application/json',
    'x-client-id': process.env.CASHFREE_APP_ID,
    'x-client-secret': process.env.CASHFREE_SECRET_KEY,
    'x-api-version': API_VERSION
  };
}

/**
 * Creates a Cashfree order and returns { paymentSessionId, cfOrderId }
 */
async function createOrder({ orderId, amount, customerName, email, phone }) {
  const body = {
    order_id: orderId,
    order_amount: amount,
    order_currency: 'INR',
    customer_details: {
      customer_id: orderId, // Cashfree requires a customer_id; order-scoped id is fine here
      customer_name: customerName,
      customer_email: email,
      customer_phone: phone
    },
    order_meta: {
      return_url: `${process.env.RETURN_URL_BASE}?order_id={order_id}`,
      notify_url: process.env.WEBHOOK_URL
    }
  };

  const res = await fetch(`${BASE_URL}/orders`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body)
  });

  const data = await res.json();
  if (!res.ok) {
    const msg = data && (data.message || data.error) ? (data.message || data.error) : 'Cashfree order creation failed';
    throw new Error(msg);
  }

  return {
    paymentSessionId: data.payment_session_id,
    cfOrderId: data.cf_order_id
  };
}

/**
 * Fetches the latest status of an order directly from Cashfree.
 * Returns the raw Cashfree order object (has "order_status": ACTIVE | PAID | EXPIRED | ...)
 */
async function getOrderStatus(orderId) {
  const res = await fetch(`${BASE_URL}/orders/${encodeURIComponent(orderId)}`, {
    method: 'GET',
    headers: headers()
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data && (data.message || data.error) ? (data.message || data.error) : 'Could not fetch order status';
    throw new Error(msg);
  }
  return data;
}

/**
 * Verifies that a webhook actually came from Cashfree using the
 * x-webhook-signature + x-webhook-timestamp headers and the raw request body.
 * rawBody must be the exact, unparsed request body string.
 */
function verifyWebhookSignature({ signature, timestamp, rawBody }) {
  if (!signature || !timestamp || !rawBody) return false;
  const secret = process.env.CASHFREE_SECRET_KEY;
  const signedPayload = timestamp + rawBody;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

module.exports = { createOrder, getOrderStatus, verifyWebhookSignature, CASHFREE_ENV };