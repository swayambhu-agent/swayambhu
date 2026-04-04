# Akash Email Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Gmail OAuth send path with an HTTPS-to-SMTP relay on Akash so agent email never expires.

**Architecture:** Node.js HTTP server on Akash (port 3500) accepts POST /send-email, sends via SMTP STARTTLS to smtp.gmail.com:587. New `providers/email-relay.js` calls it with CF Access + bearer auth. `tools/send_email.js` updated to use new provider for sending, keeps gmail provider for reads.

**Tech Stack:** Node.js (ESM), built-in `http`, `tls`, `net` modules. No dependencies.

**Spec:** `docs/superpowers/specs/2026-04-04-akash-email-relay-design.md`

---

## File Structure

```
inference/email-relay.mjs        — relay service (runs on Akash)
providers/email-relay.js         — NEW: Worker provider for relay
tools/send_email.js              — MODIFIED: use email-relay for send
config/defaults.json             — MODIFIED: add email.relay_url
scripts/push-secrets.sh          — MODIFIED: add EMAIL_RELAY_SECRET
tests/email-relay.test.js        — unit tests for relay + provider
```

---

### Task 1: Email Relay Service

**Files:**
- Create: `inference/email-relay.mjs`

- [ ] **Step 1: Implement the relay**

```js
#!/usr/bin/env node
// Swayambhu Email Relay — HTTPS-to-SMTP bridge.
// Accepts POST /send-email, sends via SMTP STARTTLS to Gmail.
// Runs on Akash behind Cloudflare Access tunnel.

import { createServer } from 'http';
import * as tls from 'tls';
import * as net from 'net';

const PORT = process.env.PORT || 3500;
const SECRET = process.env.EMAIL_RELAY_SECRET;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const MAX_BODY = 102400; // 100KB
const SMTP_TIMEOUT = 30000;

if (!SECRET || !GMAIL_USER || !GMAIL_APP_PASSWORD) {
  console.error('Missing EMAIL_RELAY_SECRET, GMAIL_USER, or GMAIL_APP_PASSWORD');
  process.exit(1);
}

// ── SMTP helpers ──────────────────────────────────────────

function smtpCommand(socket, cmd) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeListener('data', onData);
      reject(new Error('SMTP command timeout'));
    }, SMTP_TIMEOUT);

    let response = '';
    function onData(data) {
      response += data.toString();
      if (/^\d{3} /m.test(response)) {
        clearTimeout(timer);
        socket.removeListener('data', onData);
        const code = parseInt(response.slice(0, 3), 10);
        if (code >= 400) reject(new Error(`SMTP ${code}: ${response.trim()}`));
        else resolve(response.trim());
      }
    }
    socket.on('data', onData);
    if (cmd) socket.write(cmd + '\r\n');
  });
}

// SMTP dot-stuffing: lines starting with . must be escaped as ..
function dotStuff(text) {
  return text.replace(/^\.(.)/gm, '..$1').replace(/^\.$/gm, '..');
}

async function sendViaSMTP({ to, subject, body, in_reply_to }) {
  const stuffedBody = dotStuff(body);
  const message = [
    `From: ${GMAIL_USER}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    ...(in_reply_to ? [`In-Reply-To: ${in_reply_to}`, `References: ${in_reply_to}`] : []),
    '',
    stuffedBody,
  ].join('\r\n');

  const plainSocket = net.createConnection(587, 'smtp.gmail.com');
  await new Promise((res, rej) => {
    plainSocket.on('connect', res);
    plainSocket.on('error', rej);
    setTimeout(() => rej(new Error('SMTP connect timeout')), SMTP_TIMEOUT);
  });

  try {
    await smtpCommand(plainSocket);        // greeting
    await smtpCommand(plainSocket, 'EHLO relay');
    plainSocket.write('STARTTLS\r\n');
    await smtpCommand(plainSocket);

    // Upgrade to TLS
    const tlsSocket = tls.connect({ socket: plainSocket, servername: 'smtp.gmail.com' });
    await new Promise((res, rej) => {
      tlsSocket.on('secureConnect', res);
      tlsSocket.on('error', rej);
      setTimeout(() => rej(new Error('TLS handshake timeout')), SMTP_TIMEOUT);
    });

    await smtpCommand(tlsSocket, 'EHLO relay');
    await smtpCommand(tlsSocket, 'AUTH LOGIN');
    await smtpCommand(tlsSocket, Buffer.from(GMAIL_USER).toString('base64'));
    await smtpCommand(tlsSocket, Buffer.from(GMAIL_APP_PASSWORD).toString('base64'));
    await smtpCommand(tlsSocket, `MAIL FROM:<${GMAIL_USER}>`);
    await smtpCommand(tlsSocket, `RCPT TO:<${to}>`);
    await smtpCommand(tlsSocket, 'DATA');
    // DATA termination: message + \r\n.\r\n
    const dataResp = await smtpCommand(tlsSocket, message + '\r\n.');
    await smtpCommand(tlsSocket, 'QUIT');
    tlsSocket.destroy();

    const idMatch = dataResp.match(/<[^>]+>/);
    return { message_id: idMatch ? idMatch[0] : null };
  } catch (err) {
    plainSocket.destroy();
    throw err;
  }
}

// ── HTTP server ───────────────────────────────────────────

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${SECRET}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
  }

  if (req.method === 'POST' && req.url === '/send-email') {
    let rawBody = '';
    for await (const chunk of req) {
      rawBody += chunk;
      if (rawBody.length > MAX_BODY) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'body too large (max 100KB)' }));
      }
    }

    let payload;
    try { payload = JSON.parse(rawBody); }
    catch { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'invalid JSON' })); }

    if (!payload.to || !payload.subject || !payload.body) {
      res.writeHead(400);
      return res.end(JSON.stringify({ ok: false, error: 'missing to, subject, or body' }));
    }

    try {
      const result = await sendViaSMTP(payload);
      console.log(`[EMAIL] Sent to ${payload.to}: ${payload.subject}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message_id: result.message_id }));
    } catch (err) {
      // Redact body content from SMTP errors
      const safeError = err.message.replace(payload.body, '[REDACTED]');
      console.error(`[EMAIL] Failed to ${payload.to}: ${safeError}`);
      const status = err.message.includes('timeout') ? 504 : 502;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: safeError }));
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
set -a && source .env && set +a
EMAIL_RELAY_SECRET=test-secret node inference/email-relay.mjs

# Terminal 2: test
curl http://localhost:3500/health
curl -X POST http://localhost:3500/send-email \
  -H "Authorization: Bearer test-secret" \
  -H "Content-Type: application/json" \
  -d '{"to":"swami.kevala@sadhguru.org","subject":"[TESTING] Relay test","body":"Hello from relay"}'
```

- [ ] **Step 3: Commit**

```bash
git add inference/email-relay.mjs
git commit -m "feat: add email relay — HTTPS-to-SMTP bridge for Akash"
```

---

### Task 2: Worker Provider

**Files:**
- Create: `providers/email-relay.js`

- [ ] **Step 1: Implement provider**

```js
// Email relay provider — sends email via Akash SMTP relay.
// Follows the same pattern as providers/compute.js (CF Access + bearer auth).
// No `export default` — required for wrapAsModule compatibility.

export const meta = {
  secrets: ["CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "EMAIL_RELAY_SECRET"],
  timeout_ms: 30000,
};

export async function sendMessage({ to, subject, body, inReplyTo, secrets, fetch, config }) {
  const baseUrl = config?.email?.relay_url || "https://akash.swayambhu.dev";

  const resp = await fetch(`${baseUrl}/send-email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Access-Client-Id": secrets.CF_ACCESS_CLIENT_ID,
      "CF-Access-Client-Secret": secrets.CF_ACCESS_CLIENT_SECRET,
      "Authorization": `Bearer ${secrets.EMAIL_RELAY_SECRET}`,
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
  const data = await resp.json();
  if (!data.ok) throw new Error(`Email relay: ${data.error}`);
  return { messageId: data.message_id };
}
```

- [ ] **Step 2: Commit**

```bash
git add providers/email-relay.js
git commit -m "feat: add email-relay provider — sends via Akash SMTP relay"
```

---

### Task 3: Update send_email Tool

**Files:**
- Modify: `tools/send_email.js`

- [ ] **Step 1: Read current implementation**

Read `tools/send_email.js` to understand the current flow:
- It uses `provider` (gmail) for `getAccessToken`, `getMessage`, `sendMessage`
- For replies: fetches original message, extracts `messageId`, sets `inReplyTo`

- [ ] **Step 2: Update to use email-relay for sending**

Change `tools/send_email.js` to:
1. Keep gmail provider for `getMessage` (reply threading lookup)
2. Use email-relay provider for `sendMessage`
3. Wrap `getMessage` in try/catch — if OAuth is expired, send without
   threading rather than failing

The tool's `meta.provider` changes from `"gmail"` to `"email-relay"`.
Add a separate `meta.read_provider` field for `"gmail"` (or handle
inline since the kernel injects provider by meta.provider name).

**Important:** check how the kernel injects providers into tool execute().
Read `kernel.js` buildToolDefinitions or wherever `provider` is resolved
to understand the injection mechanism before changing the tool.

- [ ] **Step 3: Run tests**

```bash
npm test
```

- [ ] **Step 4: Commit**

```bash
git add tools/send_email.js
git commit -m "feat: route email send through Akash relay, keep Gmail for reads"
```

---

### Task 4: Config and Secrets

**Files:**
- Modify: `config/defaults.json` — add `email.relay_url`
- Modify: `scripts/push-secrets.sh` — add `EMAIL_RELAY_SECRET`
- Modify: `scripts/seed-local-kv.mjs` — seed relay secret for local dev

- [ ] **Step 1: Add config**

In `config/defaults.json`:
```json
{
  "email": {
    "relay_url": "https://akash.swayambhu.dev"
  }
}
```

- [ ] **Step 2: Add to push-secrets.sh**

Add `EMAIL_RELAY_SECRET` to the SECRETS array.

- [ ] **Step 3: Commit**

```bash
git add config/defaults.json scripts/push-secrets.sh
git commit -m "feat: add email relay config and secret"
```

---

### Task 5: Deploy and Test End-to-End

- [ ] **Step 1: Deploy relay to Akash**

```bash
scp inference/email-relay.mjs akash:/home/swayambhu/email-relay.mjs

# On Akash: create env file (chmod 600)
cat > /home/swayambhu/.email-relay.env << 'EOF'
GMAIL_USER=swayambhu.agent@gmail.com
GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx
EMAIL_RELAY_SECRET=<generate with: openssl rand -hex 32>
PORT=3500
EOF
chmod 600 /home/swayambhu/.email-relay.env

# Create systemd service
sudo tee /etc/systemd/system/email-relay.service << 'EOF'
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
EOF

sudo systemctl daemon-reload
sudo systemctl enable email-relay
sudo systemctl start email-relay
```

- [ ] **Step 2: Add CF tunnel route**

Add route for `/send-email` and `/health` to `akash.swayambhu.dev`
pointing to localhost:3500. If path routing isn't supported, create
`email.swayambhu.dev` subdomain instead.

- [ ] **Step 3: Push secrets to Worker**

```bash
echo -n "$EMAIL_RELAY_SECRET" | npx wrangler secret put EMAIL_RELAY_SECRET
```

- [ ] **Step 4: Test end-to-end**

```bash
# Test relay directly
curl https://akash.swayambhu.dev/send-email \
  -H "CF-Access-Client-Id: ..." \
  -H "CF-Access-Client-Secret: ..." \
  -H "Authorization: Bearer $EMAIL_RELAY_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"to":"swami.kevala@sadhguru.org","subject":"[TESTING] E2E relay","body":"Works"}'

# Test from agent (trigger a session that sends email)
curl http://localhost:8787/__scheduled
```

- [ ] **Step 5: Commit**

```bash
git push
```

---

## Summary

| Task | What | Where |
|------|------|-------|
| 1 | Relay service | inference/email-relay.mjs (Akash) |
| 2 | Worker provider | providers/email-relay.js (Worker) |
| 3 | Update send_email tool | tools/send_email.js (Worker) |
| 4 | Config + secrets | config/defaults.json, push-secrets.sh |
| 5 | Deploy + test | Akash server ops |
