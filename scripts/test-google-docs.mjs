#!/usr/bin/env node
// Quick test: create a Google Doc via Service Account JWT auth.
// Usage: set -a && source .env && set +a && node scripts/test-google-docs.mjs

import * as crypto from "crypto";

const SA_EMAIL = process.env.GOOGLE_SA_CLIENT_EMAIL;
const SA_KEY = process.env.GOOGLE_SA_PRIVATE_KEY;

if (!SA_EMAIL || !SA_KEY) {
  console.error("Missing GOOGLE_SA_CLIENT_EMAIL or GOOGLE_SA_PRIVATE_KEY in env");
  process.exit(1);
}

// ── JWT auth ──────────────────────────────────────────────

async function getToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: SA_EMAIL,
    scope: "https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const b64url = (obj) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");
  const unsigned = b64url(header) + "." + b64url(claims);

  // Normalize escaped newlines from .env
  const pem = SA_KEY.replace(/\\n/g, "\n");
  const sig = crypto.sign("SHA256", Buffer.from(unsigned), {
    key: pem,
    padding: crypto.constants.RSA_PKCS1_PADDING,
  });
  const jwt = unsigned + "." + sig.toString("base64url");

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token exchange failed (${resp.status}): ${text}`);
  }
  return (await resp.json()).access_token;
}

// ── Test ──────────────────────────────────────────────────

console.log("Service account:", SA_EMAIL);
console.log("Getting access token...");
const token = await getToken();
console.log("Token obtained ✓");

console.log("Creating test document...");
const createResp = await fetch("https://docs.googleapis.com/v1/documents", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${token}`,
  },
  body: JSON.stringify({ title: "[TEST] Swayambhu Dev Loop Test Doc" }),
});

if (!createResp.ok) {
  const err = await createResp.text();
  console.error(`Create failed (${createResp.status}): ${err}`);
  process.exit(1);
}

const doc = await createResp.json();
console.log("Document created ✓");
console.log("  ID:", doc.documentId);
console.log("  URL:", `https://docs.google.com/document/d/${doc.documentId}`);

// Insert test content
console.log("Inserting content...");
const insertResp = await fetch(
  `https://docs.googleapis.com/v1/documents/${doc.documentId}:batchUpdate`,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({
      requests: [{
        insertText: {
          location: { index: 1 },
          text: "This document was created by the Swayambhu dev loop test.\n\nTimestamp: " + new Date().toISOString(),
        },
      }],
    }),
  },
);

if (!insertResp.ok) {
  const err = await insertResp.text();
  console.error(`Insert failed (${insertResp.status}): ${err}`);
} else {
  console.log("Content inserted ✓");
}

// Share with patron
const PATRON_EMAIL = "swami.kevala@sadhguru.org";
console.log(`Sharing with ${PATRON_EMAIL}...`);
const shareResp = await fetch(
  `https://www.googleapis.com/drive/v3/files/${doc.documentId}/permissions`,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({
      role: "writer",
      type: "user",
      emailAddress: PATRON_EMAIL,
    }),
  },
);

if (!shareResp.ok) {
  const err = await shareResp.text();
  console.error(`Share failed (${shareResp.status}): ${err}`);
} else {
  console.log("Shared ✓");
}

console.log("\nDone! Check:", `https://docs.google.com/document/d/${doc.documentId}`);
