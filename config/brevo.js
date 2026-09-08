'use strict';
const fetch = require('node-fetch');

const BREVO_API_KEY = process.env.BRAVO_API;
const SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || 'noreply@bachelor99.com';
const SENDER_NAME = process.env.BREVO_SENDER_NAME || 'Bachelor99 Team';

async function sendEmail({ to, toName, subject, htmlContent }) {
  if (!BREVO_API_KEY) {
    console.error('[brevo] BRAVO_API key missing — cannot send email.');
    throw new Error('Email service not configured');
  }
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'api-key': BREVO_API_KEY
    },
    body: JSON.stringify({
      sender: { name: SENDER_NAME, email: SENDER_EMAIL },
      to: [{ email: to, name: toName || to }],
      subject,
      htmlContent
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || 'Brevo email send failed';
    throw new Error(msg);
  }
  return data;
}

function otpEmailHtml(otp) {
  return `
    <div style="font-family: Arial, sans-serif; font-size:15px; color:#111;">
      <p>Your verification code for Bachelor99 is:</p>
      <p style="font-size:28px; font-weight:bold; letter-spacing:4px;">${otp}</p>
      <p>This code expires in 5 minutes. If you didn't request this, you can ignore this email.</p>
    </div>
  `;
}

function orderConfirmationHtml(name) {
  return `
    <div style="font-family: Arial, sans-serif; font-size:15px; color:#111; line-height:1.6;">
      <p>Hi ${name},</p>
      <p>Your order for the 99 Indian Meals Cookbook has been successfully confirmed! ✅</p>
      <p>Thank you for choosing Bachelor99.</p>
      <p>📖 Your eBook is ready to download:<br>
      <a href="https://ebook5n0b9c7d2f8h6j4.primefollower.in/">https://ebook5n0b9c7d2f8h6j4.primefollower.in/</a></p>
      <p>You can access your cookbook anytime using the link above.</p>
      <p>If you have any questions or need assistance, simply reply to this email.</p>
      <p>Best regards,<br>Bachelor99 Team<br>Official Customer Support</p>
    </div>
  `;
}

async function sendOtpEmail(to, otp) {
  return sendEmail({ to, subject: 'Your Bachelor99 verification code', htmlContent: otpEmailHtml(otp) });
}

async function sendOrderConfirmationEmail(to, name) {
  return sendEmail({
    to,
    toName: name,
    subject: 'Order Confirmed — Bachelor 99 Survival Cookbook',
    htmlContent: orderConfirmationHtml(name)
  });
}

module.exports = { sendOtpEmail, sendOrderConfirmationEmail };