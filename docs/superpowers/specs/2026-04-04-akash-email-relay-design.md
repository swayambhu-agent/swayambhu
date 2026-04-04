# Akash Email Gateway

## Purpose

Eliminate Gmail OAuth entirely. Replace with a lightweight HTTPS
gateway on Akash that handles both sending (SMTP) and reading (IMAP)
using a Gmail App Password. No OAuth tokens, no expiry, no Google
verification.

## Problem

Gmail OAuth refresh tokens expire every 7 days in "Testing" mode.
Google verification takes weeks. The agent's email breaks silently
every week. OAuth adds complexity for zero benefit when App Passwords
work for both SMTP and IMAP.

## Solution

A stateless HTTP service on Akash with two endpoints:

```
Worker (CF)                           Akash
┌──────────────────┐  HTTPS           ┌──────────────┐
│ providers/       │  + CF Access     │ email-gateway│
│ email-relay.js   │ ───────────────→ │ (port 3500)  │
│                  │ ← JSON          │              │
└──────────────────┘                  │  SMTP 587 ───→ Gmail (send)
                                      │  IMAP 993 ───→ Gmail (read)
                                      └──────────────┘
```

**No OAuth anywhere.** Worker secrets reduced: only CF Access creds +
relay secret. Gmail creds live only on Akash.

## Endpoints

### POST /send-email

Send a message via SMTP STARTTLS on port 587.

**Request:**
```json
{
  "to": "recipient@example.com",
  "subject": "Hello",
  "body": "Message text",
  "in_reply_to": "optional — Message-ID for threading"
}
```

**Response:**
```json
{ "ok": true, "message_id": "<id@gmail.com>" }
```

### POST /check-email

Fetch unread messages via IMAP TLS on port 993.

**Request:**
```json
{
  "max_results": 10,
  "mark_read": true
}
```

**Response:**
```json
{
  "ok": true,
  "emails": [
    {
      "id": "imap-uid",
      "from": "sender@example.com",
      "subject": "Re: Hello",
      "date": "2026-04-04T12:00:00Z",
      "body": "Reply text",
      "message_id": "<original-id@gmail.com>"
    }
  ],
  "count": 1
}
```

### POST /get-message

Fetch a single message by ID (for reply threading).

**Request:**
```json
{ "id": "imap-uid" }
```

**Response:**
```json
{
  "ok": true,
  "id": "imap-uid",
  "from": "sender@example.com",
  "to": "recipient@example.com",
  "subject": "Hello",
  "date": "2026-04-04T12:00:00Z",
  "body": "Message text",
  "message_id": "<id@gmail.com>",
  "thread_id": null
}
```

### GET /health

```json
{ "ok": true }
```

## Common

**Auth:** `Authorization: Bearer {EMAIL_RELAY_SECRET}` + CF Access
headers. Dedicated secret, not shared.

**Max request size:** 100KB.

**Error codes:** 400 (bad request), 401 (unauthorized), 502 (SMTP/IMAP
failure), 504 (timeout).

**Timeouts:** 30s per SMTP/IMAP command. HTTP request timeout 60s.

**SMTP requirements:**
- STARTTLS on port 587
- AUTH LOGIN with base64 user/password
- Proper DATA termination (`\r\n.\r\n`)
- Dot-stuffing for body lines starting with `.`

**IMAP implementation:**
Use `imapflow` library on Akash (handles IMAP protocol, MIME parsing,
UIDs, multipart extraction). Not raw IMAP — the protocol and MIME
parsing are too complex for a hand-rolled implementation. The library
runs on Akash only, not in the Worker.

```bash
# On Akash:
npm install imapflow mailparser
```

`imapflow` handles: TLS on 993, LOGIN, UID-based FETCH, flag
management, connection pooling. `mailparser` handles MIME decoding
(multipart, base64, quoted-printable, folded headers).

Message IDs are IMAP UIDs (stable across sessions, not sequence
numbers).

**Logging:** to/subject on send success. Count on check success.
Body content never logged. SMTP/IMAP errors redacted.

**Credentials:** `GMAIL_USER` + `GMAIL_APP_PASSWORD` in
`EnvironmentFile` on Akash (chmod 600). Not on the Worker.

## Worker-Side Changes

### Delete

- Remove `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`,
  `GMAIL_REFRESH_TOKEN` from Worker secrets
- Remove OAuth token refresh from `providers/gmail.js`

### New provider: `providers/email-relay.js`

Replaces gmail.js entirely. Three functions matching the gateway
endpoints:

```js
export const meta = {
  secrets: ["CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "EMAIL_RELAY_SECRET"],
  timeout_ms: 60000,
};

export async function sendMessage({ to, subject, body, inReplyTo, secrets, fetch, config }) {
  // POST to {relay_url}/send-email with CF Access + bearer auth
}

export async function checkEmail({ maxResults, markRead, secrets, fetch, config }) {
  // POST to {relay_url}/check-email
}

export async function getMessage({ id, secrets, fetch, config }) {
  // POST to {relay_url}/get-message
}
```

All three follow the `providers/compute.js` pattern: CF Access
headers + bearer token, injected `secrets` object, `config` from
defaults.

### Update tools

**`tools/send_email.js`:**
- Change `meta.provider` from `"gmail"` to `"email-relay"`
- Change `meta.secrets` — remove Gmail OAuth creds
- In `execute()`: call `provider.getMessage()` for reply threading
  (now goes through relay/IMAP instead of Gmail API/OAuth)
- Call `provider.sendMessage()` for send (relay/SMTP)

**`tools/check_email.js`:**
- Change `meta.provider` from `"gmail"` to `"email-relay"`
- Change `meta.secrets` — remove Gmail OAuth creds
- In `execute()`: call `provider.checkEmail()` instead of
  `provider.listUnread()` + `provider.getMessage()`

### Config

In `config/defaults.json`:
```json
{
  "email": {
    "relay_url": "https://akash.swayambhu.dev"
  }
}
```

## What Gets Deleted

- `providers/gmail.js` — replaced entirely by `email-relay.js`
- Gmail OAuth secrets from Worker env (`GMAIL_CLIENT_ID`,
  `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`)
- `scripts/gmail-auth.mjs` — no longer needed (no OAuth flow)
- OAuth refresh logic in any tool/provider

**Known dependency:** `tools/google_docs.js` also uses gmail.js for
Google OAuth. That tool needs separate migration (different scope,
different API). Not blocking this change — will be fixed separately.

## Deployment

Same as before — systemd service on Akash behind CF tunnel.

```
# /home/swayambhu/.email-gateway.env (chmod 600)
GMAIL_USER=swayambhu.agent@gmail.com
GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx
EMAIL_RELAY_SECRET=<openssl rand -hex 32>
PORT=3500
```

Tunnel: route `/send-email`, `/check-email`, `/get-message`, `/health`
on `akash.swayambhu.dev` to localhost:3500. If path routing isn't
available, use `email.swayambhu.dev`.

## Quality Lens Assessment

- **Elegance:** One gateway, one auth mechanism, zero OAuth. Clean.
- **Generality:** Works with any SMTP/IMAP provider, not just Gmail.
- **Robustness:** App passwords don't expire. SMTP/IMAP are stable.
- **Simplicity:** Gateway uses `imapflow` + `mailparser` for IMAP
  (proven libraries, not hand-rolled protocol parsing). SMTP is raw
  (simple enough). One provider file on Worker side. No OAuth.
- **Modularity:** Gateway owns all email transport. Worker only does
  HTTPS. Clean boundary.
