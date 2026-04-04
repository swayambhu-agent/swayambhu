# Akash Email Relay

## Purpose

Replace Gmail OAuth with a lightweight HTTPS-to-SMTP relay on Akash,
giving both the agent (Cloudflare Worker) and the dev loop reliable
email sending without token expiry.

## Problem

Gmail OAuth refresh tokens expire every 7 days when the Google Cloud
app is in "Testing" mode. Publishing requires Google verification
(weeks, requires privacy policy + demo video). The agent's email
silently breaks every week with no self-repair path.

## Solution

A tiny stateless HTTP service on Akash that accepts `POST /send-email`
and sends via SMTP using a Gmail App Password. The Worker calls it
over HTTPS like any other API. No OAuth, no token expiry, no new
third-party dependencies.

```
Worker (CF)                    Akash
┌──────────┐  HTTPS POST      ┌──────────────┐  SMTP 587
│ provider │ ───────────────→ │ email-relay  │ ──────────→ Gmail
│ email.js │ ← JSON response │ (port 3500)  │
└──────────┘                  └──────────────┘
```

## Akash Service

A single Node.js file (`email-relay.mjs`) running on the existing
Akash server. ~50 lines. Listens on a local port (3500), accepts
POST requests, sends via SMTP STARTTLS on port 587.

**Endpoint:** `POST /send-email`

**Request:**
```json
{
  "to": "recipient@example.com",
  "subject": "Hello",
  "body": "Message text",
  "in_reply_to": "optional — Message-ID for threading",
  "thread_id": "optional — for thread continuity"
}
```

Max body size: 100KB. Plain text only (no HTML, no attachments).

**Response:**
```json
{ "ok": true, "message_id": "<generated-id@gmail.com>", "provider": "smtp" }
```
or
```json
{ "ok": false, "error": "SMTP 535: Authentication failed" }
```

**Auth:** `Authorization: Bearer {EMAIL_RELAY_SECRET}` — a dedicated
relay secret, not a shared general-purpose key.

**Health check:** `GET /health` → `{ "ok": true }`

**Error codes:**
- 400: invalid request (missing to/subject/body, body too large)
- 401: missing or wrong bearer token
- 502: SMTP connection or send failure
- 504: SMTP timeout

**SMTP config:** reads `GMAIL_USER` and `GMAIL_APP_PASSWORD` from env
on the Akash server. Same creds the dev loop already uses.

**Process management:** run via systemd or pm2 alongside the existing
Akash compute service. Stateless — can restart anytime.

## Worker-Side Changes

**Only the send path changes.** `providers/gmail.js` stays for read
operations (getMessage, listUnread, markAsRead, check) — OAuth is
still needed for reading, but read failures don't break silently the
way send failures do.

**Modified function:** `providers/gmail.js` `sendMessage()` routes
through the relay instead of Gmail API:

```js
export async function sendMessage(token, fetchFn, { to, subject, body, inReplyTo, threadId }) {
  const relayUrl = process.env.EMAIL_RELAY_URL || 'https://akash.swayambhu.dev/send-email';
  const relaySecret = process.env.EMAIL_RELAY_SECRET;

  const resp = await fetchFn(relayUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${relaySecret}`,
    },
    body: JSON.stringify({ to, subject, body, in_reply_to: inReplyTo, thread_id: threadId }),
  });
  const data = await resp.json();
  if (!data.ok) throw new Error(data.error);
  return { messageId: data.message_id, threadId: data.thread_id };
}
```

**What doesn't change:**
- `getAccessToken()` — still used by read operations
- `getMessage()` — still used by `send_email.js` for reply threading
- `listUnread()`, `markAsRead()`, `check()` — still used by `check_email.js`
- `tools/send_email.js` — still calls `provider.getMessage()` for
  threading info, then `provider.sendMessage()`. No change needed.
- `hook-communication.js` — routes through the same adapter

**New secrets on Worker:** `EMAIL_RELAY_SECRET` (shared with relay)
**Removed secrets:** none (Gmail OAuth creds still needed for reads)

## Reply Threading

The relay supports threading via optional `in_reply_to` and
`thread_id` fields. The SMTP message includes `In-Reply-To` and
`References` headers when `in_reply_to` is provided. Gmail
automatically threads messages with matching headers.

`tools/send_email.js` already fetches the original message via
`provider.getMessage()` (Gmail API, still OAuth) to get the
Message-ID for threading. This path is unchanged — only the
final send goes through the relay.

## What About Inbound Email?

Out of scope. `check_email.js` still uses Gmail API OAuth for
reading. Read failures are visible (empty inbox) not silent (lost
message). Can be addressed later with an IMAP relay on Akash.

## What About the Dev Loop?

The dev loop (`scripts/dev-loop/comms.mjs`) already sends email via
SMTP directly (it runs on the Akash server). No change needed there.
But it could optionally use the relay too for consistency.

## Security

- Relay sits behind the existing Cloudflare Access tunnel (same as
  the compute endpoint at akash.swayambhu.dev). Worker authenticates
  via CF Access headers + relay bearer token (double auth).
- Dedicated `EMAIL_RELAY_SECRET` — not a shared general key
- Request size limit: 100KB
- Plain text only — no HTML, no MIME passthrough, no attachments
- No email content stored or logged — stateless passthrough
- Body redacted in error logs (only to/subject logged)
- Gmail App Password scoped to sending only

## Deployment

The relay runs as a systemd service on the Akash server alongside
the existing compute endpoint. Same machine, same tunnel.

```
# /etc/systemd/system/email-relay.service
[Unit]
Description=Swayambhu Email Relay
After=network.target

[Service]
ExecStart=/usr/bin/node /home/swayambhu/email-relay.mjs
Environment=GMAIL_USER=...
Environment=GMAIL_APP_PASSWORD=...
Environment=EMAIL_RELAY_SECRET=...
Environment=PORT=3500
Restart=always
User=swayambhu

[Install]
WantedBy=multi-user.target
```

The Cloudflare tunnel config routes `/send-email` and `/health` to
localhost:3500 (alongside the existing compute routes).

## Quality Lens Assessment

- **Elegance:** Clean separation — Worker does HTTPS, Akash does SMTP.
  Each side does what it's good at.
- **Generality:** Pattern works for any SMTP provider, not just Gmail.
  Could send via any email service by changing the relay config.
- **Robustness:** App passwords don't expire. SMTP is a stable protocol.
  No OAuth token lifecycle to manage.
- **Simplicity:** ~50 lines for the relay, ~20 lines for the provider
  change. No new dependencies.
- **Modularity:** Provider interface unchanged. Callers don't know or
  care that email goes through a relay.
