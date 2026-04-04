# Akash Email Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate Gmail OAuth entirely. Replace with an HTTPS gateway on Akash that handles sending (SMTP) and reading (IMAP) using Gmail App Password.

**Architecture:** Node.js HTTP server on Akash (port 3500) with three endpoints: `/send-email` (SMTP 587), `/check-email` (IMAP 993), `/get-message` (IMAP 993). Uses `imapflow` + `mailparser` for IMAP. Raw SMTP for send. New `providers/email-relay.js` on Worker calls gateway with CF Access + bearer auth.

**Tech Stack:** Node.js (ESM), `imapflow`, `mailparser` (Akash only). Built-in `http`, `tls`, `net` for SMTP. No new Worker dependencies.

**Spec:** `docs/superpowers/specs/2026-04-04-akash-email-relay-design.md`

---

## File Structure

```
inference/
  email-gateway.mjs              — gateway service (runs on Akash)
  package.json                   — imapflow + mailparser deps

providers/
  email-relay.js                 — NEW: Worker provider (replaces gmail.js for email)

tools/
  send_email.js                  — MODIFIED: use email-relay provider
  check_email.js                 — MODIFIED: use email-relay provider

config/
  defaults.json                  — MODIFIED: add email.relay_url

scripts/
  push-secrets.sh                — MODIFIED: add EMAIL_RELAY_SECRET

tests/
  email-gateway.test.js          — gateway unit tests (SMTP + IMAP mocked)
```

---

### Task 1: Email Gateway — SMTP Send

**Files:**
- Create: `inference/email-gateway.mjs`

Build the HTTP server + SMTP send endpoint first. IMAP comes in Task 2.

- [ ] **Step 1: Implement gateway with /send-email and /health**

The SMTP sending code already works (proven in `scripts/dev-loop/comms.mjs`).
Port it into the gateway with proper error handling, timeouts, and
dot-stuffing.

```js
#!/usr/bin/env node
// Swayambhu Email Gateway — HTTPS to SMTP/IMAP bridge.
// Endpoints: POST /send-email, POST /check-email, POST /get-message, GET /health

import { createServer } from 'http';
import * as tls from 'tls';
import * as net from 'net';

const PORT = process.env.PORT || 3500;
const SECRET = process.env.EMAIL_RELAY_SECRET;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const MAX_BODY = 102400;
const SMTP_TIMEOUT = 30000;

if (!SECRET || !GMAIL_USER || !GMAIL_APP_PASSWORD) {
  console.error('Missing required env vars');
  process.exit(1);
}

// ── Auth middleware ────────────────────────────────────────

function checkAuth(req) {
  const auth = req.headers.authorization;
  return auth === `Bearer ${SECRET}`;
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) throw new Error('body too large');
  }
  return JSON.parse(body);
}

// ── SMTP ──────────────────────────────────────────────────

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

function dotStuff(text) {
  return text.replace(/^\./gm, '..');
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
    dotStuff(body),
  ].join('\r\n');

  const plainSocket = net.createConnection(587, 'smtp.gmail.com');
  await new Promise((res, rej) => {
    plainSocket.on('connect', res);
    plainSocket.on('error', rej);
    setTimeout(() => rej(new Error('SMTP connect timeout')), SMTP_TIMEOUT);
  });

  try {
    await smtpCommand(plainSocket);
    await smtpCommand(plainSocket, 'EHLO gateway');
    plainSocket.write('STARTTLS\r\n');
    await smtpCommand(plainSocket);

    const tlsSocket = tls.connect({ socket: plainSocket, servername: 'smtp.gmail.com' });
    await new Promise((res, rej) => {
      tlsSocket.on('secureConnect', res);
      tlsSocket.on('error', rej);
      setTimeout(() => rej(new Error('TLS timeout')), SMTP_TIMEOUT);
    });

    await smtpCommand(tlsSocket, 'EHLO gateway');
    await smtpCommand(tlsSocket, 'AUTH LOGIN');
    await smtpCommand(tlsSocket, Buffer.from(GMAIL_USER).toString('base64'));
    await smtpCommand(tlsSocket, Buffer.from(GMAIL_APP_PASSWORD).toString('base64'));
    await smtpCommand(tlsSocket, `MAIL FROM:<${GMAIL_USER}>`);
    await smtpCommand(tlsSocket, `RCPT TO:<${to}>`);
    await smtpCommand(tlsSocket, 'DATA');
    // DATA termination: \r\n.\r\n — smtpCommand appends \r\n after the dot
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
// IMAP endpoints added in Task 2

const server = createServer(async (req, res) => {
  const json = (status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  if (req.method === 'GET' && req.url === '/health') {
    return json(200, { ok: true });
  }

  if (!checkAuth(req)) return json(401, { ok: false, error: 'unauthorized' });

  if (req.method === 'POST' && req.url === '/send-email') {
    let payload;
    try { payload = await readBody(req); }
    catch (e) { return json(400, { ok: false, error: e.message }); }

    if (!payload.to || !payload.subject || !payload.body) {
      return json(400, { ok: false, error: 'missing to, subject, or body' });
    }

    try {
      const result = await sendViaSMTP(payload);
      console.log(`[EMAIL] Sent to ${payload.to}: ${payload.subject}`);
      json(200, { ok: true, message_id: result.message_id });
    } catch (err) {
      console.error(`[EMAIL] Send failed: ${err.message}`);
      json(err.message.includes('timeout') ? 504 : 502, { ok: false, error: err.message });
    }
    return;
  }

  // IMAP endpoints (Task 2) go here

  json(404, { ok: false, error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[EMAIL-GATEWAY] Listening on 127.0.0.1:${PORT}`);
});
```

- [ ] **Step 2: Test SMTP send locally**

```bash
# Start gateway
set -a && source .env && set +a
EMAIL_RELAY_SECRET=test-secret node inference/email-gateway.mjs

# Test
curl http://localhost:3500/health
curl -X POST http://localhost:3500/send-email \
  -H "Authorization: Bearer test-secret" \
  -H "Content-Type: application/json" \
  -d '{"to":"swami.kevala@sadhguru.org","subject":"[TESTING] Gateway SMTP","body":"Hello from gateway"}'
```

- [ ] **Step 3: Commit**

```bash
git add inference/email-gateway.mjs
git commit -m "feat: add email gateway — SMTP send endpoint"
```

---

### Task 2: Email Gateway — IMAP Read

**Files:**
- Modify: `inference/email-gateway.mjs`
- Create: `inference/package.json` (for imapflow + mailparser)

- [ ] **Step 1: Install dependencies on Akash**

```bash
cd inference
npm init -y
npm install imapflow mailparser
```

Create `inference/package.json`:
```json
{
  "name": "swayambhu-email-gateway",
  "type": "module",
  "dependencies": {
    "imapflow": "^1.0.0",
    "mailparser": "^3.0.0"
  }
}
```

- [ ] **Step 2: Add /check-email and /get-message endpoints**

Add to `email-gateway.mjs`:

```js
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

async function getImapClient() {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    logger: false,
  });
  await client.connect();
  return client;
}

async function checkEmail({ max_results = 10, mark_read = true }) {
  const client = await getImapClient();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const messages = [];
      const uids = await client.search({ seen: false }, { uid: true });
      const fetchUids = uids.slice(0, max_results);

      for (const uid of fetchUids) {
        const msg = await client.fetchOne(uid, { source: true, uid: true }, { uid: true });
        const parsed = await simpleParser(msg.source);
        messages.push({
          id: String(uid),
          from: parsed.from?.text || '',
          sender_email: parsed.from?.value?.[0]?.address || '',
          subject: parsed.subject || '',
          date: parsed.date?.toISOString() || '',
          body: parsed.text || '',
          message_id: parsed.messageId || '',
        });
        if (mark_read) {
          await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
        }
      }
      return { emails: messages, count: messages.length };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

async function getMessage({ id }) {
  const client = await getImapClient();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uid = parseInt(id, 10);
      const msg = await client.fetchOne(uid, { source: true, uid: true }, { uid: true });
      const parsed = await simpleParser(msg.source);
      return {
        id: String(uid),
        from: parsed.from?.text || '',
        to: parsed.to?.text || '',
        subject: parsed.subject || '',
        date: parsed.date?.toISOString() || '',
        body: parsed.text || '',
        message_id: parsed.messageId || '',
      };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}
```

Add HTTP routes in the server handler:

```js
if (req.method === 'POST' && req.url === '/check-email') {
  let payload;
  try { payload = await readBody(req); } catch (e) { return json(400, { ok: false, error: e.message }); }
  try {
    const result = await checkEmail(payload);
    console.log(`[EMAIL] Checked: ${result.count} unread`);
    json(200, { ok: true, ...result });
  } catch (err) {
    console.error(`[EMAIL] Check failed: ${err.message}`);
    json(502, { ok: false, error: err.message });
  }
  return;
}

if (req.method === 'POST' && req.url === '/get-message') {
  let payload;
  try { payload = await readBody(req); } catch (e) { return json(400, { ok: false, error: e.message }); }
  if (!payload.id) return json(400, { ok: false, error: 'missing id' });
  try {
    const msg = await getMessage(payload);
    json(200, { ok: true, ...msg });
  } catch (err) {
    console.error(`[EMAIL] Get message failed: ${err.message}`);
    json(502, { ok: false, error: err.message });
  }
  return;
}
```

- [ ] **Step 3: Test IMAP locally**

```bash
# Restart gateway with IMAP deps
node inference/email-gateway.mjs

# Check unread
curl -X POST http://localhost:3500/check-email \
  -H "Authorization: Bearer test-secret" \
  -H "Content-Type: application/json" \
  -d '{"max_results":5,"mark_read":false}'

# Get specific message
curl -X POST http://localhost:3500/get-message \
  -H "Authorization: Bearer test-secret" \
  -H "Content-Type: application/json" \
  -d '{"id":"12345"}'
```

- [ ] **Step 4: Commit**

```bash
git add inference/email-gateway.mjs inference/package.json
git commit -m "feat: add IMAP check-email and get-message endpoints to gateway"
```

---

### Task 3: Worker Provider

**Files:**
- Create: `providers/email-relay.js`

- [ ] **Step 1: Implement provider**

```js
// Email relay provider — sends and reads email via Akash gateway.
// Follows providers/compute.js pattern (CF Access + bearer auth).
// No `export default` — required for wrapAsModule compatibility.

export const meta = {
  secrets: ["CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "EMAIL_RELAY_SECRET"],
  timeout_ms: 60000,
};

function buildHeaders(secrets) {
  return {
    "Content-Type": "application/json",
    "CF-Access-Client-Id": secrets.CF_ACCESS_CLIENT_ID,
    "CF-Access-Client-Secret": secrets.CF_ACCESS_CLIENT_SECRET,
    "Authorization": `Bearer ${secrets.EMAIL_RELAY_SECRET}`,
  };
}

async function relayCall(endpoint, body, { secrets, fetch, config }) {
  const baseUrl = config?.email?.relay_url || "https://akash.swayambhu.dev";
  const resp = await fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers: buildHeaders(secrets),
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Email gateway ${endpoint} failed (${resp.status}): ${text}`);
  }
  const data = await resp.json();
  if (!data.ok) throw new Error(`Email gateway: ${data.error}`);
  return data;
}

// All methods use object-style: { ..., secrets, fetch, config }

export async function sendMessage({ to, subject, body, inReplyTo, secrets, fetch, config }) {
  const data = await relayCall("/send-email", {
    to, subject, body, in_reply_to: inReplyTo || null,
  }, { secrets, fetch, config });
  return { messageId: data.message_id };
}

export async function getMessage({ id, secrets, fetch, config }) {
  const data = await relayCall("/get-message", { id }, { secrets, fetch, config });
  return {
    id: data.id,
    from: data.from,
    to: data.to,
    subject: data.subject,
    date: data.date,
    body: data.body,
    messageId: data.message_id,
  };
}

export async function checkEmail({ maxResults, markRead, secrets, fetch, config }) {
  const data = await relayCall("/check-email", {
    max_results: maxResults || 10, mark_read: markRead !== false,
  }, { secrets, fetch, config });
  return { emails: data.emails, count: data.count };
}

// Provider health check — returns unread count for act context
export async function check({ secrets, fetch, config }) {
  const data = await relayCall("/check-email", {
    max_results: 1, mark_read: false,
  }, { secrets, fetch, config });
  return data.count || 0;
}
```

- [ ] **Step 2: Commit**

```bash
git add providers/email-relay.js
git commit -m "feat: add email-relay provider — full send+read via Akash gateway"
```

---

### Task 4: Update Email Tools

**Files:**
- Modify: `tools/send_email.js`
- Modify: `tools/check_email.js`

- [ ] **Step 1: Read current tools**

Read both tools to understand the exact provider call signatures
before modifying.

- [ ] **Step 2: Update send_email.js**

Change:
- `meta.secrets`: remove Gmail OAuth secrets
- `meta.provider`: change from `"gmail"` to `"email-relay"`
- `execute()`: remove `getAccessToken()` call. All provider methods
  now use object-style: `provider.getMessage({ id, secrets, fetch,
  config })` for reply threading (goes through gateway IMAP), and
  `provider.sendMessage({ to, subject, body, inReplyTo, secrets,
  fetch, config })` for send (gateway SMTP). Wrap `getMessage` in
  try/catch — if IMAP fails, send without threading.

**Important:** check how the kernel resolves `meta.provider` to the
actual provider module. Read `kernel.js` or `index.js` to understand
the injection before changing the tool.

- [ ] **Step 3: Update check_email.js**

Change:
- `meta.secrets`: remove Gmail OAuth secrets
- `meta.provider`: change from `"gmail"` to `"email-relay"`
- `execute()`: replace the three-step `listUnread()` → `getMessage()`
  → `markAsRead()` flow with a single `provider.checkEmail({
  maxResults, markRead, secrets, fetch, config })` call. The gateway
  fetches, parses, and marks read atomically. Returns `{ emails, count }`
  matching the current tool return shape.

- [ ] **Step 4: Run tests**

```bash
npm test
```

Fix any test failures from the provider switch.

- [ ] **Step 5: Commit**

```bash
git add tools/send_email.js tools/check_email.js
git commit -m "feat: switch email tools to email-relay provider (no OAuth)"
```

---

### Task 5: Config, Secrets, Cleanup

**Files:**
- Modify: `config/defaults.json`
- Modify: `scripts/push-secrets.sh`
- Modify: `scripts/seed-local-kv.mjs` (if secrets are seeded)

- [ ] **Step 1: Add relay config**

In `config/defaults.json`, add:
```json
"email": {
  "relay_url": "https://akash.swayambhu.dev"
}
```

- [ ] **Step 2: Update push-secrets.sh**

Add `EMAIL_RELAY_SECRET` to SECRETS array.
Remove `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`
(no longer needed for email — but check if google_docs still needs them).

- [ ] **Step 3: Commit**

```bash
git add config/defaults.json scripts/push-secrets.sh
git commit -m "feat: add email relay config, remove OAuth secrets for email"
```

---

### Task 6: Deploy and Test End-to-End

- [ ] **Step 1: Deploy gateway to Akash**

```bash
# Copy files
scp inference/email-gateway.mjs inference/package.json akash:/home/swayambhu/

# On Akash: install deps
cd /home/swayambhu && npm install

# Create env file
cat > /home/swayambhu/.email-gateway.env << 'EOF'
GMAIL_USER=swayambhu.agent@gmail.com
GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx
EMAIL_RELAY_SECRET=<openssl rand -hex 32>
PORT=3500
EOF
chmod 600 /home/swayambhu/.email-gateway.env

# Systemd
sudo tee /etc/systemd/system/email-gateway.service << 'EOF'
[Unit]
Description=Swayambhu Email Gateway
After=network.target
[Service]
ExecStart=/usr/bin/node /home/swayambhu/email-gateway.mjs
EnvironmentFile=/home/swayambhu/.email-gateway.env
Restart=always
User=swayambhu
[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable email-gateway
sudo systemctl start email-gateway
```

- [ ] **Step 2: Add CF tunnel route**

Route `/send-email`, `/check-email`, `/get-message`, `/health` on
`akash.swayambhu.dev` to localhost:3500. Or create `email.swayambhu.dev`.

- [ ] **Step 3: Push Worker secrets**

```bash
echo -n "$EMAIL_RELAY_SECRET" | npx wrangler secret put EMAIL_RELAY_SECRET
```

- [ ] **Step 4: Test end-to-end**

```bash
# Test gateway via tunnel
curl https://akash.swayambhu.dev/health
curl -X POST https://akash.swayambhu.dev/send-email \
  -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" \
  -d '{"to":"swami.kevala@sadhguru.org","subject":"[TESTING] E2E","body":"Works"}'

# Test via agent session
curl http://localhost:8787/__scheduled
```

---

## Summary

| Task | What | Where |
|------|------|-------|
| 1 | Gateway SMTP send | inference/email-gateway.mjs |
| 2 | Gateway IMAP read | inference/email-gateway.mjs + imapflow |
| 3 | Worker provider | providers/email-relay.js |
| 4 | Update email tools | tools/send_email.js, check_email.js |
| 5 | Config + secrets | config/defaults.json, push-secrets.sh |
| 6 | Deploy + test | Akash server ops |
