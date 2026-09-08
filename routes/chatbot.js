'use strict';
/* ============================================
   routes/chatbot.js
   Everything related to the on-site AI assistant lives in this one file:
   the OpenRouter call, the system prompt, light per-IP rate limiting, and
   the Express route itself. Mount it in server.js with:

     const chatbotRouter = require('./routes/chatbot');
     app.use('/api/chat', chatbotRouter);

   IMPORTANT: this matches the chat widget ALREADY LIVE in script.js
   (initializeChat / sendToBackend), which calls:
     POST {API_BASE_URL}/api/chat
     Body: { messages: [{ role: 'user'|'assistant', content: string }, ...] }
     Response: { reply: string }
   The full running conversation (not just the latest message) is sent
   every time, so this route treats req.body.messages as the source of
   truth and does not maintain any server-side session state.

   Requires env var OPENROUTER_API_KEY (already added on Railway).
   Optional env vars:
     OPENROUTER_MODEL   — override the default model
     SITE_URL           — your live site URL, sent to OpenRouter for their
                           attribution headers (HTTP-Referer)
   ============================================ */
const express = require('express');
const fetch = require('node-fetch');

const router = express.Router();

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Model choice: this bot only ever needs to (a) hold a friendly sales/support
// conversation and (b) stick tightly to facts given in the system prompt.
// It doesn't need heavy reasoning, so we use a fast, cheap, very capable
// instruction-follower rather than a large "thinking" model — keeps replies
// quick and keeps OpenRouter cost near-zero at this traffic scale.
// Override any time via the OPENROUTER_MODEL env var without touching code.
const MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';

const BOT_NAME = 'Bachelor'; // placeholder name for now, per request

const SITE_URL = process.env.SITE_URL || 'https://bachelor99.com';

/* ------------------------------------------------------------------ */
/* System prompt — everything the assistant is allowed to know/claim   */
/* about the site. Keep this as the single source of truth so answers  */
/* never drift from what's actually true on the storefront.            */
/* ------------------------------------------------------------------ */
const SYSTEM_PROMPT = `
You are "${BOT_NAME}", the friendly on-site assistant for Bachelor99 — a small Indian storefront selling ONE digital product: the "Bachelor 99 Survival Cookbook".

## The product (only thing sold on this site)
- Name: Bachelor 99 Survival Cookbook
- What it is: a digital PDF cookbook with 99 simple, budget-friendly Indian recipes, aimed at bachelors, students, and total cooking beginners.
- Price: ₹99 (marked down from ₹199). Occasional coupon codes may reduce this further at checkout — you don't know specific codes, so don't invent any.
- Format & delivery: instant digital PDF download. Opens cleanly on phone, tablet, or laptop. No physical product, nothing is shipped, and there's no waiting — access is granted right after payment is confirmed.
- Cooking time: most recipes are ready in about 30 minutes or less.
- Positioning: simple recipes (no complicated techniques), budget-friendly ingredients, fast meals, familiar home-style Indian flavours.
- Cost per meal: most recipes are built to cost around ₹99 or less per meal using common Indian pantry ingredients. A handful of special recipes may cost slightly more, and the book flags those clearly — don't claim every single recipe costs ₹99 or under.
- Rated 4.7/5 by customers (shown via on-site reviews).
- Framed as a "risk-free purchase — love the recipes or keep the guide," but there is NOT a formal published refund/money-back policy. If someone asks for a refund or about a formal guarantee/refund policy, don't promise specific refund terms — tell them to use the "Contact Us" button so a real person can help.

## How buying works on this site
1. Customer clicks "Add to Cart" or "Buy It Now" on the homepage, or manages quantity on the Cart page.
2. At checkout they enter name, email, and phone. The email must be verified with a one-time OTP sent to that email before an order can be placed — this is a required, non-skippable step.
3. They can optionally apply a coupon code at checkout for a discount.
4. Payment is handled securely via Cashfree (card, UPI, netbanking, etc. — whatever Cashfree offers).
5. After payment, they land on an order confirmation page that verifies payment with the backend, then reveals a "Download Your Ebook" button and also emails them a confirmation with the download link.
6. If a payment fails, no charge is made, and they can retry from the cart.

## Your job
- Help visitors decide if this cookbook is right for them, answer questions about what's inside, the price, format, and how checkout/delivery works, using ONLY the facts above.
- Be warm, casual, and encouraging — like a helpful friend, not a corporate script. Keep replies short (a few sentences) unless the person clearly wants detail.
- You may gently encourage a purchase when relevant, but never be pushy or use fake urgency/scarcity ("only 2 left!", countdown timers, etc.) — nothing like that actually exists on this site.
- If asked something about a specific order, payment, refund status, account issue, or anything you can't verify (e.g. "where's my download link", "my payment failed, what happened", "I want a refund"), do NOT guess or make promises. Tell them to use the "Contact Us" button/form on the site so the team can look into it directly.
- If asked for OTP codes, coupon codes, admin/internal info, technical/API details, or anything about how the site or backend is built, politely decline and redirect to what the cookbook itself offers.
- If you don't know something about the product, say so honestly rather than inventing details (ingredients lists, exact recipe names, nutrition info, page count, etc. are not things you've been given — don't make them up).
- Stay strictly on topic: this bot is for questions about the Bachelor 99 Survival Cookbook and the buying process. For unrelated requests (general chit-chat is fine briefly, but not general-purpose tasks like coding help, essay writing, etc.), politely steer back to how you can help them with the cookbook.
- Never claim to be human. If asked, you're an AI assistant for the site.
`.trim();

// Cap how much conversation history the frontend can shove into one request
// (keeps token usage/cost bounded regardless of what the client sends).
const MAX_HISTORY_MESSAGES = 12;
const MAX_MESSAGE_LENGTH = 2000;

/* ------------------------------------------------------------------ */
/* Very small in-memory rate limiter, per IP. Good enough for a single
   low-traffic Railway instance; resets on redeploy. Not meant to survive
   multi-instance scaling — swap for Firestore/Redis if that ever changes. */
/* ------------------------------------------------------------------ */
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 15;
const rateLimitBuckets = new Map(); // ip -> [timestamps]

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (rateLimitBuckets.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  timestamps.push(now);
  rateLimitBuckets.set(ip, timestamps);
  return timestamps.length > RATE_LIMIT_MAX_REQUESTS;
}

// Periodically clear stale buckets so this Map doesn't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of rateLimitBuckets.entries()) {
    const fresh = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    if (fresh.length === 0) rateLimitBuckets.delete(ip);
    else rateLimitBuckets.set(ip, fresh);
  }
}, 5 * 60 * 1000).unref();

function sanitizeMessages(rawMessages) {
  if (!Array.isArray(rawMessages)) return [];
  return rawMessages
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-MAX_HISTORY_MESSAGES)
    .map(m => ({ role: m.role, content: m.content.trim().slice(0, MAX_MESSAGE_LENGTH) }));
}

/**
 * POST /api/chat
 * Body: { messages: Array<{ role: 'user'|'assistant', content: string }> }
 * This is the exact contract the live chat widget in script.js already
 * calls — the frontend keeps the running conversation client-side and
 * resends it in full on every message.
 */
router.post('/', async (req, res) => {
  try {
    if (!OPENROUTER_API_KEY) {
      console.error('[chatbot] OPENROUTER_API_KEY is missing.');
      return res.status(503).json({ error: 'Chat assistant is not configured right now.' });
    }

    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    if (isRateLimited(ip)) {
      return res.status(429).json({ error: 'You are sending messages too fast. Please slow down a little.' });
    }

    const conversation = sanitizeMessages(req.body && req.body.messages);
    if (conversation.length === 0) {
      return res.status(400).json({ error: 'Please type a message.' });
    }
    // The widget always sends the latest user turn last, but guard anyway.
    if (conversation[conversation.length - 1].role !== 'user') {
      return res.status(400).json({ error: 'Invalid conversation — last message must be from the user.' });
    }

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...conversation
    ];

    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': SITE_URL,
        'X-Title': 'Bachelor99 Site Assistant'
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: 0.6,
        max_tokens: 400
      })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error('[chatbot] OpenRouter error:', data);
      return res.status(502).json({ error: 'The assistant is having trouble replying right now. Please try again.' });
    }

    const reply = data?.choices?.[0]?.message?.content?.trim();
    if (!reply) {
      console.error('[chatbot] Empty completion from OpenRouter:', JSON.stringify(data));
      return res.status(502).json({ error: 'The assistant could not come up with a reply. Please try again.' });
    }

    res.json({ reply });
  } catch (err) {
    console.error('[chatbot/message]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
