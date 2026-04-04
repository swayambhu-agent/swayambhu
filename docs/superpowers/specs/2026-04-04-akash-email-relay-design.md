# Akash Email Relay

## Purpose

Replace Gmail OAuth send path with a lightweight HTTPS-to-SMTP relay
on Akash, giving the agent reliable email sending without token expiry.

## Problem

Gmail OAuth refresh tokens expire every 7 days when the Google Cloud
app is in "Testing" mode. Publishing requires Google verification.
The agent's email silently breaks every week with no self-repair path.

## Solution

A tiny stateless HTTP service on Akash that accepts `POST /send-email`
and sends via SMTP. The Worker calls it over HTTPS — same pattern as
the existing compute provider. No OAuth, no token expiry.

```
Worker (CF)                           Akash
┌──────────────────┐  HTTPS POST      ┌──────────────┐  SMTP 587
│ providers/       │  + CF Access     │ email-relay  │ ──────────→ Gmail
│ email-relay.js   │ ───────────────→ │ (port 3500)  │
│                  │ ← JSON response │              │
└──────────────────┘                  └──────────────┘
```

## Akash Relay Service

A single Node.js file (`email-relay.mjs`) on the Akash server. ~80
lines. Listens on localhost:3500, accepts POST requests, sends via
SMTP STARTTLS on port 587.

**Endpoint:** `POST /send-email`

**Request:**
```json
{
  "to": "recipient@example.com",
  "subject": "Hello",
  "body": "Message text",
  "in_reply_to": "optional — Message-ID for In-Reply-To header",
  "thread_id": "optional — for thread continuity"
}
```

Max request size: 100KB. Plain text only.

**Response:**
```json
{ "ok": true, "message_id": "<generated-id@gmail.com>" }
```
or
```json
{ "ok": false, "error": "SMTP 535: Authentication failed" }
```

**Health check:** `GET /health` → `{ "ok": true }`

**Auth:** Bearer token in Authorization header (`EMAIL_RELAY_SECRET`).
The relay also sits behind Cloudflare Access (same tunnel as compute),
so Workers must send CF Access headers too.

**Error codes:**
- 400: invalid request (missing to/subject/body, body too large)
- 401: missing or wrong bearer token
- 502: SMTP connection or send failure
- 504: SMTP timeout (30s)

**SMTP requirements:**
- STARTTLS on port 587 (port 465 blocked on Hetzner)
- AUTH LOGIN with base64-encoded user/password
- DATA termination: `\r\n.\r\n` (proper CRLF dot CRLF)
- Dot-stuffing: lines in body starting with `.` must be escaped as `..`
- Socket timeout: 30s per command, kill on timeout
- `GMAIL_USER` and `GMAIL_APP_PASSWORD` from env

**Logging:** log `to` and `subject` on success. On failure, log error
message but redact any echoed body content from SMTP errors.

## Worker-Side Changes

**New provider:** `providers/email-relay.js` — a clean, focused
provider that handles only email sending through the relay. Does NOT
modify `providers/gmail.js` — that stays as-is for read operations.

```js
// providers/email-relay.js
export const meta = {
  secrets: ["CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "EMAIL_RELAY_SECRET"],
  timeout_ms: 30000,
};

export async function sendMessage({ to, subject, body, inReplyTo, secrets, fetch, config }) {
  const baseUrl = config?.email_relay_url || "https://akash.swayambhu.dev";

  const resp = await fetch(`${baseUrl}/send-email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Access-Client-Id": secrets.CF_ACCESS_CLIENT_ID,
      "CF-Access-Client-Secret": secrets.CF_ACCESS_CLIENT_SECRET,
      "Authorization": `Bearer ${secrets.EMAIL_RELAY_SECRET}`,
    },
    body: JSON.stringify({ to, subject, body, in_reply_to: inReplyTo || null }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Email relay failed (${resp.status}): ${text}`);
  }
  const data = await resp.json();
  if (!data.ok) throw new Error(`Email relay: ${data.error}`);
  return { messageId: data.message_id };
}
```

**What changes in tools/send_email.js:**
- Switch provider from `gmail` to `email-relay` for sending
- Keep `gmail` provider for `getMessage()` (reply threading still
  needs Gmail API to fetch the original message)
- If OAuth is expired, reply threading degrades gracefully (send
  without In-Reply-To header) rather than failing entirely

**What doesn't change:**
- `providers/gmail.js` — untouched, still handles reads
- `tools/check_email.js` — still uses gmail provider
- `hook-communication.js` — routes through same adapter
- Communication pipeline — event-driven, unchanged

**Config:** `email_relay_url` in `config/defaults.json` under a new
`email` section:
```json
{
  "email": {
    "relay_url": "https://akash.swayambhu.dev"
  }
}
```

## Reply Threading

The relay supports `in_reply_to` field which sets SMTP `In-Reply-To`
and `References` headers. Gmail automatically threads messages with
matching headers.

Current flow in `tools/send_email.js`:
1. If `reply_to_id` is provided, call `gmail.getMessage()` to get
   original message's `messageId` header
2. Pass as `inReplyTo` to `sendMessage()`

**Degradation when OAuth expires:** If `getMessage()` fails (OAuth
expired), the tool should catch the error and send without threading
rather than failing entirely. The message still gets sent — it just
won't be threaded. This is a graceful degradation, not a silent
failure.

## What About Inbound Email?

Out of scope. `check_email.js` still uses Gmail OAuth. Read failures
are visible (empty inbox) not silent (lost message). Can be addressed
later with an IMAP relay or webhook.

## Security

- Behind Cloudflare Access tunnel (same as compute endpoint)
- CF Access headers required (double auth with bearer token)
- Dedicated `EMAIL_RELAY_SECRET` — not shared with other services
- Request size limit: 100KB enforced by relay
- Plain text only — no HTML, no attachments, no raw MIME
- Stateless — no email content stored
- Logs redacted — to/subject only, body never logged
- Credentials in `EnvironmentFile` with 600 permissions, not in
  systemd unit file

## Deployment

```
# /etc/systemd/system/email-relay.service
[Unit]
Description=Swayambhu Email Relay
After=network.target

[Service]
ExecStart=/usr/bin/node /home/swayambhu/email-relay.mjs
EnvironmentFile=/home/swayambhu/.email-relay.env
Restart=always
User=swayambhu

[Install]
WantedBy=multi-user.target
```

```
# /home/swayambhu/.email-relay.env (chmod 600)
GMAIL_USER=swayambhu.agent@gmail.com
GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx
EMAIL_RELAY_SECRET=generated-secret-here
PORT=3500
```

Cloudflare tunnel: route `/send-email` and `/health` on
`akash.swayambhu.dev` to `localhost:3500`. If path-based routing
isn't supported by the current tunnel config, use a separate
subdomain (e.g. `email.swayambhu.dev`).
