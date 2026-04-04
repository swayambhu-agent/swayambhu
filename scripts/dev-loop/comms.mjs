// Comms adapter for the dev loop.
// Sends approval requests and checks for replies via Slack and Gmail.
// Separate from the agent's comms tools — this is CI/CD infrastructure messaging.

// ── Pure functions ──────────────────────────────────────────

export function formatApprovalMessage({ id, summary, blastRadius, evidence, challengeResult }) {
  const lines = [
    `[DEVLOOP] Approval request: ${id}`,
    "",
    `Summary: ${summary}`,
  ];
  if (blastRadius) lines.push(`Blast radius: ${blastRadius}`);
  if (evidence) lines.push(`Evidence: ${evidence}`);
  if (challengeResult) lines.push(`Challenge result: ${challengeResult}`);
  lines.push("");
  lines.push(`Reply with: APPROVE ${id}`);
  lines.push(`        or: REJECT ${id} <reason>`);
  return lines.join("\n");
}

const REPLY_RE = /^\s*(APPROVE|REJECT)\s+(devloop-[\w-]+)(?:\s+(.+))?\s*$/i;

export function parseReply(text) {
  if (!text) return null;
  // Check each line — reply might be buried in an email thread
  for (const line of text.split("\n")) {
    const m = line.match(REPLY_RE);
    if (m) {
      return {
        id: m[2],
        action: m[1].toUpperCase(),
        reason: m[3]?.trim() || null,
      };
    }
  }
  return null;
}

// ── Slack ────────────────────────────────────────────────────

export async function sendSlack(text) {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL_ID;
  if (!token || !channel) throw new Error("Missing SLACK_BOT_TOKEN or SLACK_CHANNEL_ID");

  const resp = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ channel, text }),
  });
  const data = await resp.json();
  if (!data.ok) throw new Error(`Slack postMessage failed: ${data.error}`);
  return data;
}

export async function checkSlackReplies(since) {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL_ID;
  if (!token || !channel) throw new Error("Missing SLACK_BOT_TOKEN or SLACK_CHANNEL_ID");

  const oldest = typeof since === "string"
    ? String(new Date(since).getTime() / 1000)
    : String(since);

  const resp = await fetch(
    `https://slack.com/api/conversations.history?channel=${channel}&oldest=${oldest}&limit=100`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const data = await resp.json();
  if (!data.ok) throw new Error(`Slack conversations.history failed: ${data.error}`);

  const replies = [];
  for (const msg of data.messages || []) {
    const parsed = parseReply(msg.text);
    if (parsed) {
      replies.push({ ...parsed, source: "slack", ts: msg.ts });
    }
  }
  return replies;
}

// ── Email via SMTP (Gmail App Password) ─────────────────────
// Uses raw SMTP over TLS to smtp.gmail.com:465.
// Requires: GMAIL_USER (email address) + GMAIL_APP_PASSWORD (app password).
// No OAuth, no token expiry.

import * as tls from "tls";

function smtpCommand(socket, cmd) {
  return new Promise((resolve, reject) => {
    let response = "";
    const onData = (data) => {
      response += data.toString();
      // SMTP responses end with \r\n and start with a 3-digit code
      if (/^\d{3} /m.test(response) || /^\d{3}-/m.test(response) && /^\d{3} /m.test(response)) {
        socket.removeListener("data", onData);
        const code = parseInt(response.slice(0, 3), 10);
        if (code >= 400) reject(new Error(`SMTP ${code}: ${response.trim()}`));
        else resolve(response.trim());
      }
    };
    socket.on("data", onData);
    if (cmd) socket.write(cmd + "\r\n");
  });
}

export async function sendEmail(text, subject) {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  const rubric = JSON.parse((await import("fs")).readFileSync(
    new URL("rubric.json", import.meta.url), "utf8"));
  const to = process.env.DEVLOOP_EMAIL_TO || rubric.notifications?.email_to;
  const subjectPrefix = rubric.notifications?.email_subject_prefix || "[SWAYAMBHU-DEV]";
  if (!user || !pass) throw new Error("Missing GMAIL_USER or GMAIL_APP_PASSWORD");
  if (!to) throw new Error("Missing DEVLOOP_EMAIL_TO or notifications.email_to in rubric.json");

  const subj = subject || `${subjectPrefix} Dev Loop Report`;
  const message = [
    `From: ${user}`,
    `To: ${to}`,
    `Subject: ${subj}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    text,
  ].join("\r\n");

  const net = await import("net");
  return new Promise((resolve, reject) => {
    // Use port 587 with STARTTLS (port 465 direct TLS is often blocked)
    const plainSocket = net.createConnection(587, "smtp.gmail.com", async () => {
      try {
        await smtpCommand(plainSocket); // greeting
        await smtpCommand(plainSocket, "EHLO devloop");
        // Upgrade to TLS
        plainSocket.write("STARTTLS\r\n");
        await smtpCommand(plainSocket);
        const tlsSocket = tls.connect({ socket: plainSocket, servername: "smtp.gmail.com" });
        await new Promise((res, rej) => {
          tlsSocket.on("secureConnect", res);
          tlsSocket.on("error", rej);
        });
        await smtpCommand(tlsSocket, "EHLO devloop");
        await smtpCommand(tlsSocket, "AUTH LOGIN");
        await smtpCommand(tlsSocket, Buffer.from(user).toString("base64"));
        await smtpCommand(tlsSocket, Buffer.from(pass).toString("base64"));
        await smtpCommand(tlsSocket, `MAIL FROM:<${user}>`);
        await smtpCommand(tlsSocket, `RCPT TO:<${to}>`);
        await smtpCommand(tlsSocket, "DATA");
        await smtpCommand(tlsSocket, message + "\r\n.");
        await smtpCommand(tlsSocket, "QUIT");
        tlsSocket.destroy();
        resolve({ sent: true, to, subject: subj });
      } catch (err) {
        plainSocket.destroy();
        reject(err);
      }
    });
    plainSocket.on("error", reject);
    setTimeout(() => { plainSocket.destroy(); reject(new Error("SMTP timeout")); }, 30000);
  });
}

// Email is send-only for the dev loop. Approval replies come via Slack.
export async function checkEmailReplies(_since) {
  return [];
}

// ── CLI entry point ──────────────────────────────────────────

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (command === "send") {
    const args = parseCliArgs(rest);
    const channels = (args.channel || "slack").split(",");
    const text = formatApprovalMessage({
      id: args.id || "devloop-unknown",
      summary: args.body || "(no summary)",
    });

    for (const ch of channels) {
      if (ch === "slack") {
        await sendSlack(text);
        console.log("Sent to Slack");
      } else if (ch === "email") {
        await sendEmail(text, args.id ? `[SWAYAMBHU-DEV] ${args.id}` : undefined);
        console.log("Sent to Email");
      } else {
        console.error(`Unknown channel: ${ch}`);
      }
    }
  } else if (command === "check") {
    const args = parseCliArgs(rest);
    const since = args.since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const [slackReplies, emailReplies] = await Promise.allSettled([
      checkSlackReplies(since),
      checkEmailReplies(since),
    ]);

    const replies = [];
    if (slackReplies.status === "fulfilled") replies.push(...slackReplies.value);
    if (emailReplies.status === "fulfilled") replies.push(...emailReplies.value);

    console.log(JSON.stringify(replies, null, 2));
  } else {
    console.error("Usage: comms.mjs send --channel slack,email --id devloop-123 --body \"summary\"");
    console.error("       comms.mjs check --since \"2026-04-04T12:00:00Z\"");
    process.exit(1);
  }
}

function parseCliArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--") && i + 1 < args.length) {
      result[args[i].slice(2)] = args[++i];
    }
  }
  return result;
}

// Run CLI if executed directly
const isMain = process.argv[1] && (
  process.argv[1].endsWith("/comms.mjs") ||
  process.argv[1].endsWith("\\comms.mjs")
);
if (isMain) main().catch((e) => { console.error(e.message); process.exit(1); });
