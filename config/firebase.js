'use strict';
const admin = require('firebase-admin');

if (!admin.apps.length) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;

  let privateKey = process.env.FIREBASE_PRIVATE_KEY || '';

  // 1. Trim surrounding whitespace
  privateKey = privateKey.trim();

  // 2. If the whole value got wrapped in quotes when pasted into Railway
  //    (value literally starts AND ends with a " character), strip them.
  if (
    (privateKey.startsWith('"') && privateKey.endsWith('"')) ||
    (privateKey.startsWith("'") && privateKey.endsWith("'"))
  ) {
    privateKey = privateKey.slice(1, -1);
  }

  // 3. Railway stores env vars as single-line strings, so real newlines get
  //    escaped as literal "\n" text — convert those back to real newlines.
  privateKey = privateKey.replace(/\\n/g, '\n');

  // 4. Sanity check: a valid PEM key must contain these markers after the
  //    steps above. If it doesn't, fail loudly with a clear message instead
  //    of letting firebase-admin throw a generic "Invalid PEM" error.
  const hasBegin = privateKey.includes('-----BEGIN PRIVATE KEY-----');
  const hasEnd = privateKey.includes('-----END PRIVATE KEY-----');

  if (!projectId || !clientEmail || !privateKey) {
    console.error('[firebase] Missing FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY env vars.');
  } else if (!hasBegin || !hasEnd) {
    console.error('[firebase] FIREBASE_PRIVATE_KEY does not look like a valid PEM key.');
    console.error('[firebase] Expected it to contain "-----BEGIN PRIVATE KEY-----" and "-----END PRIVATE KEY-----".');
    console.error('[firebase] First 40 chars of what was received:', JSON.stringify(privateKey.slice(0, 40)));
    console.error('[firebase] Last 40 chars of what was received:', JSON.stringify(privateKey.slice(-40)));
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey
    })
  });
}

const db = admin.firestore();

module.exports = { admin, db };