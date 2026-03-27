#!/usr/bin/env node
// Generate a Gmail refresh token via Google OAuth2.
//
// Prerequisites:
//   - GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env (or environment)
//   - Google Cloud Console: OAuth consent screen configured, your email as test user
//   - Google Cloud Console: OAuth credentials (Desktop app type)
//
// Usage:
//   source .env && node scripts/gmail-auth.mjs
//
// This will:
//   1. Print a URL — open it in your browser
//   2. Sign in and grant access
//   3. Google redirects to localhost with an auth code
//   4. Script exchanges the code for a refresh token
//   5. Prints the token — paste it into .env as GMAIL_REFRESH_TOKEN

import http from "node:http";

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Error: GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set in environment.");
  console.error("Run: source .env && node scripts/gmail-auth.mjs");
  process.exit(1);
}

const PORT = 8089;
const REDIRECT_URI = `http://localhost:${PORT}`;
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/drive.file",
].join(" ");

const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
  `client_id=${encodeURIComponent(CLIENT_ID)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&response_type=code` +
  `&scope=${encodeURIComponent(SCOPES)}` +
  `&access_type=offline` +
  `&prompt=consent`;

console.log("\n=== Gmail OAuth2 Token Generator ===\n");
console.log("Open this URL in your browser:\n");
console.log(authUrl);
console.log("\nWaiting for redirect...\n");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<h2>Error: ${error}</h2><p>Check your Google Cloud Console settings.</p>`);
    console.error(`\nError from Google: ${error}`);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  // Exchange auth code for tokens
  try {
    const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }).toString(),
    });

    const data = await tokenResp.json();

    if (data.error) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<h2>Token exchange failed</h2><pre>${JSON.stringify(data, null, 2)}</pre>`);
      console.error("\nToken exchange failed:", data);
      server.close();
      process.exit(1);
    }

    const refreshToken = data.refresh_token;

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<h2>Success!</h2><p>Refresh token obtained. You can close this tab.</p>`);

    console.log("=== Success! ===\n");
    console.log("Refresh token:\n");
    console.log(refreshToken);
    console.log("\n\nUpdate your .env:");
    console.log(`  GMAIL_REFRESH_TOKEN=${refreshToken}`);
    console.log("\nFor production:");
    console.log(`  echo -n "${refreshToken}" | npx wrangler secret put GMAIL_REFRESH_TOKEN`);
    console.log();
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/html" });
    res.end(`<h2>Error</h2><pre>${err.message}</pre>`);
    console.error("\nError:", err.message);
  }

  server.close();
});

server.listen(PORT, () => {
  // Server ready, waiting for OAuth redirect
});
