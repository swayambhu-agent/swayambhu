# Akash Email Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Gmail OAuth send path with an HTTPS-to-SMTP relay on Akash so agent email never expires.

**Architecture:** Tiny Node.js HTTP server on Akash (port 3500) accepts POST /send-email, sends via SMTP STARTTLS to smtp.gmail.com:587. Worker's gmail.js sendMessage() calls the relay instead of Gmail API.

**Tech Stack:** Node.js (ESM), built-in `http`, `tls`, `net` modules. No dependencies.

**Spec:** `docs/superpowers/specs/2026-04-04-akash-email-relay-design.md`

---

## File Structure

```
inference/email-relay.mjs     — the relay service (runs on Akash)
providers/gmail.js            — MODIFIED: sendMessage() routes through relay
```

---

### Task 1: Email Relay Service

**Files:**
- Create: `inference/email-relay.mjs` (lives alongside inference server on Akash)

- [ ] **Step 1: Implement the relay**

```js
#!/usr/bin/env node
// Swayambhu Email Relay — HTTPS-to-SMTP bridge.
// Accepts POST /send-email, sends via SMTP STARTTLS to Gmail.
// Stateless, no dependencies, ~60 lines.

import { createServer } from 'http';
import * as tls from 'tls';
import * as net from 'net';

const PORT = process.env.PORT || 3500;
const SECRET = process.env.EMAIL_RELAY_SECRET;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

if (!SECRET || !GMAIL_USER || !GMAIL_APP_PASSWORD) {
  console.error('Missing EMAIL_RELAY_SECRET, GMAIL_USER, or GMAIL_APP_PASSWORD');
  process.exit(1);
}

function smtpCommand(socket, cmd) {
  return new Promise((resolve, reject) => {
    let response = '';
    const onData = (data) => {
      response += data.toString();
      if (/^\d{3} /m.test(response)) {
        socket.removeListener('data', onData);
        const code = parseInt(response.slice(0, 3), 10);
        if (code >= 400) reject(new Error(`SMTP ${code}: ${response.trim()}`));
        else resolve(response.trim());
      }
    };
    socket.on('data', onData);
    if (cmd) socket.write(cmd + '\r\n');
  });
}

async function sendViaSMTP({ to, subject, body, in_reply_to }) {
  const message = [
    `From: ${GMAIL_USER}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    ...(in_reply_to ? [`In-Reply-To: ${in_reply_to}`, `References: ${in_reply_to}`] : []),
    '',
    body,
  ].join('\r\n');

  const plainSocket = net.createConnection(587, 'smtp.gmail.com');
  await new Promise((res, rej) => { plainSocket.on('connect', res); plainSocket.on('error', rej); });

  await smtpCommand(plainSocket);
  await smtpCommand(plainSocket, 'EHLO relay');
  plainSocket.write('STARTTLS\r\n');
  await smtpCommand(plainSocket);

  const tlsSocket = tls.connect({ socket: plainSocket, servername: 'smtp.gmail.com' });
  await new Promise((res, rej) => { tlsSocket.on('secureConnect', res); tlsSocket.on('error', rej); });

  await smtpCommand(tlsSocket, 'EHLO relay');
  await smtpCommand(tlsSocket, 'AUTH LOGIN');
  await smtpCommand(tlsSocket, Buffer.from(GMAIL_USER).toString('base64'));
  await smtpCommand(tlsSocket, Buffer.from(GMAIL_APP_PASSWORD).toString('base64'));
  await smtpCommand(tlsSocket, `MAIL FROM:<${GMAIL_USER}>`);
  await smtpCommand(tlsSocket, `RCPT TO:<${to}>`);
  await smtpCommand(tlsSocket, 'DATA');
  const dataResp = await smtpCommand(tlsSocket, message + '\r\n.');
  await smtpCommand(tlsSocket, 'QUIT');
  tlsSocket.destroy();

  // Extract message ID from DATA response if available
  const idMatch = dataResp.match(/<[^>]+>/);
  return { message_id: idMatch ? idMatch[0] : null };
}

const server = createServer(async (req, res) => {
  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  // Auth
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${SECRET}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
  }

  // Send email
  if (req.method === 'POST' && req.url === '/send-email') {
    let body = '';
    for await (const chunk of req) body += chunk;

    let payload;
    try { payload = JSON.parse(body); }
    catch { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'invalid JSON' })); }

    if (!payload.to || !payload.subject || !payload.body) {
      res.writeHead(400);
      return res.end(JSON.stringify({ ok: false, error: 'missing to, subject, or body' }));
    }
    if (body.length > 102400) {
      res.writeHead(400);
      return res.end(JSON.stringify({ ok: false, error: 'body too large (max 100KB)' }));
    }

    try {
      const result = await sendViaSMTP(payload);
      console.log(`[EMAIL] Sent to ${payload.to}: ${payload.subject}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message_id: result.message_id, provider: 'smtp' }));
    } catch (err) {
      console.error(`[EMAIL] Failed: ${err.message}`);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ ok: false, error: 'not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[EMAIL-RELAY] Listening on 127.0.0.1:${PORT}`);
});
```

- [ ] **Step 2: Test locally**

```bash
# Terminal 1: start relay
EMAIL_RELAY_SECRET=test-secret GMAIL_USER=swayambhu.agent@gmail.com \
  GMAIL_APP_PASSWORD="xxxx xxxx xxxx xxxx" node inference/email-relay.mjs

# Terminal 2: test health
curl http://localhost:3500/health

# Terminal 3: test send
curl -X POST http://localhost:3500/send-email \
  -H "Authorization: Bearer test-secret" \
  -H "Content-Type: application/json" \
  -d '{"to":"swami.kevala@sadhguru.org","subject":"[TESTING] Relay test","body":"Hello from the relay"}'
```

- [ ] **Step 3: Commit**

```bash
git add inference/email-relay.mjs
git commit -m "feat: add email relay — HTTPS-to-SMTP bridge for Akash"
```

---

### Task 2: Update providers/gmail.js sendMessage

**Files:**
- Modify: `providers/gmail.js`

- [ ] **Step 1: Modify sendMessage to use relay**

Replace the Gmail API send path with a relay HTTPS call. Keep all
other functions (getAccessToken, getMessage, listUnread, markAsRead,
check) unchanged.

In `providers/gmail.js`, replace the `sendMessage` function:

```js
export async function sendMessage(token, fetchFn, { to, subject, body, inReplyTo, threadId }) {
  // Route through Akash email relay (SMTP) instead of Gmail API (OAuth)
  // The relay handles SMTP auth with App Password — no OAuth token needed
  const relayUrl = (typeof globalThis !== 'undefined' && globalThis.EMAIL_RELAY_URL)
    || 'https://akash.swayambhu.dev/send-email';
  const relaySecret = (typeof globalThis !== 'undefined' && globalThis.EMAIL_RELAY_SECRET)
    || token; // fallback: use the OAuth token as relay secret for backward compat

  const resp = await fetchFn(relayUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${relaySecret}`,
    },
    body: JSON.stringify({
      to,
      subject,
      body,
      in_reply_to: inReplyTo || null,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Email relay failed (${resp.status}): ${text}`);
  }

  const result = await resp.json();
  if (!result.ok) throw new Error(`Email relay error: ${result.error}`);
  return { messageId: result.message_id, threadId: threadId || null };
}
```

Note: relay URL and secret come from Worker env (set via wrangler
secrets). The existing `token` parameter (OAuth) is no longer used
for sending but the function signature stays the same.

- [ ] **Step 2: Add secrets to wrangler config**

Add to `scripts/push-secrets.sh` SECRETS array:
```
EMAIL_RELAY_SECRET
```

Add to `.dev.vars` or wrangler.dev.toml for local dev:
```
EMAIL_RELAY_URL=http://localhost:3500/send-email
EMAIL_RELAY_SECRET=test-secret
```

- [ ] **Step 3: Run tests**

```bash
npm test
```

Existing send_email tests should still pass (they mock the provider).

- [ ] **Step 4: Commit**

```bash
git add providers/gmail.js scripts/push-secrets.sh
git commit -m "feat: route email send through Akash relay instead of Gmail OAuth"
```

---

### Task 3: Deploy Relay to Akash

- [ ] **Step 1: Copy relay to Akash server**

```bash
scp inference/email-relay.mjs akash:/home/swayambhu/email-relay.mjs
```

- [ ] **Step 2: Create systemd service**

```bash
# On Akash server:
sudo cat > /etc/systemd/system/email-relay.service << 'EOF'
[Unit]
Description=Swayambhu Email Relay
After=network.target

[Service]
ExecStart=/usr/bin/node /home/swayambhu/email-relay.mjs
Environment=GMAIL_USER=swayambhu.agent@gmail.com
Environment=GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx
Environment=EMAIL_RELAY_SECRET=generate-a-real-secret
Environment=PORT=3500
Restart=always
User=swayambhu

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable email-relay
sudo systemctl start email-relay
```

- [ ] **Step 3: Add Cloudflare tunnel route**

Add `/send-email` and `/health` routes to the existing CF tunnel
config pointing to localhost:3500.

- [ ] **Step 4: Test end-to-end from Worker**

```bash
# Trigger a session where the agent sends email
# Or test directly:
curl https://akash.swayambhu.dev/health
curl -X POST https://akash.swayambhu.dev/send-email \
  -H "Authorization: Bearer {secret}" \
  -H "Content-Type: application/json" \
  -d '{"to":"swami.kevala@sadhguru.org","subject":"[TESTING] Relay via tunnel","body":"End-to-end test"}'
```

- [ ] **Step 5: Commit and push secrets**

```bash
bash scripts/push-secrets.sh
git push
```

---

## Summary

| Task | What | Where |
|------|------|-------|
| 1 | Email relay service | inference/email-relay.mjs (Akash) |
| 2 | Update gmail.js sendMessage | providers/gmail.js (Worker) |
| 3 | Deploy + tunnel + test | Akash server ops |
