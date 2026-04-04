#!/usr/bin/env node
// Swayambhu Email Gateway — HTTPS to SMTP/IMAP bridge.
// Eliminates Gmail OAuth: uses App Password for both send and read.
//
// Endpoints:
//   POST /send-email   — send via SMTP STARTTLS (port 587)
//   POST /check-email  — fetch unread via IMAP TLS (port 993)
//   POST /get-message  — fetch single message via IMAP
//   GET  /health       — liveness check
//
// Auth: Authorization: Bearer {EMAIL_RELAY_SECRET}
// Runs behind Cloudflare Access tunnel on Akash.
//
// Env: GMAIL_USER, GMAIL_APP_PASSWORD, EMAIL_RELAY_SECRET, PORT (default 3500)

import { createServer } from "http";
import * as tls from "tls";
import * as net from "net";

const PORT = process.env.PORT || 3500;
const SECRET = process.env.EMAIL_RELAY_SECRET;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const MAX_BODY = 102400; // 100KB
const SMTP_TIMEOUT = 30000;

if (!SECRET || !GMAIL_USER || !GMAIL_APP_PASSWORD) {
  console.error("Missing EMAIL_RELAY_SECRET, GMAIL_USER, or GMAIL_APP_PASSWORD");
  process.exit(1);
}

// ── HTTP helpers ──────────────────────────────────────────

function checkAuth(req) {
  return req.headers.authorization === `Bearer ${SECRET}`;
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) throw new Error("body too large (max 100KB)");
  }
  return JSON.parse(body);
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// ── SMTP ──────────────────────────────────────────────────

function smtpCommand(socket, cmd) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeListener("data", onData);
      reject(new Error("SMTP command timeout"));
    }, SMTP_TIMEOUT);

    let response = "";
    function onData(data) {
      response += data.toString();
      if (/^\d{3} /m.test(response)) {
        clearTimeout(timer);
        socket.removeListener("data", onData);
        const code = parseInt(response.slice(0, 3), 10);
        if (code >= 400) reject(new Error(`SMTP ${code}: ${response.trim()}`));
        else resolve(response.trim());
      }
    }
    socket.on("data", onData);
    if (cmd) socket.write(cmd + "\r\n");
  });
}

// SMTP dot-stuffing: lines starting with . must be escaped as ..
function dotStuff(text) {
  return text.replace(/^\./gm, "..");
}

async function sendViaSMTP({ to, subject, body, in_reply_to }) {
  const message = [
    `From: ${GMAIL_USER}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    ...(in_reply_to
      ? [`In-Reply-To: ${in_reply_to}`, `References: ${in_reply_to}`]
      : []),
    "",
    dotStuff(body),
  ].join("\r\n");

  const plainSocket = net.createConnection(587, "smtp.gmail.com");
  await new Promise((res, rej) => {
    plainSocket.on("connect", res);
    plainSocket.on("error", rej);
    setTimeout(() => rej(new Error("SMTP connect timeout")), SMTP_TIMEOUT);
  });

  try {
    await smtpCommand(plainSocket); // greeting
    await smtpCommand(plainSocket, "EHLO gateway");
    plainSocket.write("STARTTLS\r\n");
    await smtpCommand(plainSocket);

    const tlsSocket = tls.connect({
      socket: plainSocket,
      servername: "smtp.gmail.com",
    });
    await new Promise((res, rej) => {
      tlsSocket.on("secureConnect", res);
      tlsSocket.on("error", rej);
      setTimeout(() => rej(new Error("TLS timeout")), SMTP_TIMEOUT);
    });

    await smtpCommand(tlsSocket, "EHLO gateway");
    await smtpCommand(tlsSocket, "AUTH LOGIN");
    await smtpCommand(tlsSocket, Buffer.from(GMAIL_USER).toString("base64"));
    await smtpCommand(tlsSocket, Buffer.from(GMAIL_APP_PASSWORD).toString("base64"));
    await smtpCommand(tlsSocket, `MAIL FROM:<${GMAIL_USER}>`);
    await smtpCommand(tlsSocket, `RCPT TO:<${to}>`);
    await smtpCommand(tlsSocket, "DATA");
    // DATA termination: \r\n.\r\n — smtpCommand appends \r\n after the dot
    const dataResp = await smtpCommand(tlsSocket, message + "\r\n.");
    await smtpCommand(tlsSocket, "QUIT");
    tlsSocket.destroy();

    const idMatch = dataResp.match(/<[^>]+>/);
    return { message_id: idMatch ? idMatch[0] : null };
  } catch (err) {
    plainSocket.destroy();
    throw err;
  }
}

// ── IMAP (loaded lazily — requires imapflow + mailparser) ─

let ImapFlow, simpleParser;

async function loadImap() {
  if (!ImapFlow) {
    const imapMod = await import("imapflow");
    const parserMod = await import("mailparser");
    ImapFlow = imapMod.ImapFlow;
    simpleParser = parserMod.simpleParser;
  }
}

async function getImapClient() {
  await loadImap();
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    logger: false,
  });
  await client.connect();
  return client;
}

async function parseMessage(source) {
  const parsed = await simpleParser(source);
  return {
    from: parsed.from?.text || "",
    sender_email: parsed.from?.value?.[0]?.address || "",
    to: parsed.to?.text || "",
    subject: parsed.subject || "",
    date: parsed.date?.toISOString() || "",
    body: parsed.text || "",
    message_id: parsed.messageId || "",
  };
}

async function imapCheckEmail({ max_results = 10, mark_read = true }) {
  const client = await getImapClient();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = await client.search({ seen: false }, { uid: true });
      const fetchUids = uids.slice(0, max_results);
      const emails = [];

      for (const uid of fetchUids) {
        try {
          const msg = await client.fetchOne(uid, { source: true }, { uid: true });
          const parsed = await parseMessage(msg.source);
          emails.push({ id: String(uid), ...parsed });
          // Mark read after successful parse
          if (mark_read) {
            await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
          }
        } catch (err) {
          // Skip messages that fail to parse — leave them unread
          console.error(`[EMAIL] Failed to parse UID ${uid}: ${err.message}`);
        }
      }

      return { emails, count: emails.length };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

async function imapGetMessage({ id }) {
  const uid = parseInt(id, 10);
  if (!uid || uid < 1) throw new Error("invalid message id");

  const client = await getImapClient();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const msg = await client.fetchOne(uid, { source: true }, { uid: true });
      const parsed = await parseMessage(msg.source);
      return { id: String(uid), ...parsed };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

// ── HTTP server ───────────────────────────────────────────

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return json(res, 200, { ok: true });
  }

  if (!checkAuth(req)) {
    return json(res, 401, { ok: false, error: "unauthorized" });
  }

  // ── SMTP send ──
  if (req.method === "POST" && req.url === "/send-email") {
    let payload;
    try {
      payload = await readBody(req);
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message });
    }
    if (!payload.to || !payload.subject || !payload.body) {
      return json(res, 400, { ok: false, error: "missing to, subject, or body" });
    }

    try {
      const result = await sendViaSMTP(payload);
      console.log(`[EMAIL] Sent to ${payload.to}: ${payload.subject}`);
      json(res, 200, { ok: true, message_id: result.message_id });
    } catch (err) {
      console.error(`[EMAIL] Send failed to ${payload.to}: ${err.message}`);
      const status = err.message.includes("timeout") ? 504 : 502;
      json(res, status, { ok: false, error: err.message });
    }
    return;
  }

  // ── IMAP check ──
  if (req.method === "POST" && req.url === "/check-email") {
    let payload;
    try {
      payload = await readBody(req);
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message });
    }

    try {
      const result = await imapCheckEmail(payload);
      console.log(`[EMAIL] Checked inbox: ${result.count} unread`);
      json(res, 200, { ok: true, ...result });
    } catch (err) {
      console.error(`[EMAIL] Check failed: ${err.message}`);
      json(res, 502, { ok: false, error: err.message });
    }
    return;
  }

  // ── IMAP get single message ──
  if (req.method === "POST" && req.url === "/get-message") {
    let payload;
    try {
      payload = await readBody(req);
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message });
    }
    if (!payload.id) {
      return json(res, 400, { ok: false, error: "missing id" });
    }

    try {
      const msg = await imapGetMessage(payload);
      json(res, 200, { ok: true, ...msg });
    } catch (err) {
      console.error(`[EMAIL] Get message failed: ${err.message}`);
      json(res, 502, { ok: false, error: err.message });
    }
    return;
  }

  json(res, 404, { ok: false, error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[EMAIL-GATEWAY] Listening on 127.0.0.1:${PORT}`);
});
