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

// ── Gmail ────────────────────────────────────────────────────

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

async function gmailAccessToken() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Missing GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, or GMAIL_REFRESH_TOKEN");
  }

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gmail token refresh failed (${resp.status}): ${text}`);
  }
  const data = await resp.json();
  return data.access_token;
}

export async function sendEmail(text, subject) {
  const to = process.env.DEVLOOP_EMAIL_TO;
  if (!to) throw new Error("Missing DEVLOOP_EMAIL_TO");

  const token = await gmailAccessToken();

  const lines = [
    `To: ${to}`,
    `Subject: ${subject || "[SWAYAMBHU-DEV] Dev Loop Report"}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    text,
  ];

  const raw = btoa(unescape(encodeURIComponent(lines.join("\r\n"))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const resp = await fetch(`${GMAIL_API}/messages/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gmail send failed (${resp.status}): ${text}`);
  }
  return resp.json();
}

export async function checkEmailReplies(since) {
  const token = await gmailAccessToken();

  // Gmail search uses YYYY/MM/DD for after: filter
  const sinceDate = new Date(since);
  const dateStr = `${sinceDate.getFullYear()}/${String(sinceDate.getMonth() + 1).padStart(2, "0")}/${String(sinceDate.getDate()).padStart(2, "0")}`;
  const q = encodeURIComponent(`subject:(DEVLOOP OR SWAYAMBHU-DEV) after:${dateStr}`);

  const listResp = await fetch(
    `${GMAIL_API}/messages?q=${q}&maxResults=50`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!listResp.ok) {
    const text = await listResp.text();
    throw new Error(`Gmail list failed (${listResp.status}): ${text}`);
  }
  const listData = await listResp.json();

  const replies = [];
  for (const entry of listData.messages || []) {
    const msgResp = await fetch(
      `${GMAIL_API}/messages/${entry.id}?format=full`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!msgResp.ok) continue;
    const msg = await msgResp.json();

    const body = extractBody(msg.payload);
    const parsed = parseReply(body);
    if (parsed) {
      replies.push({ ...parsed, source: "email", messageId: entry.id });
    }
  }
  return replies;
}

// Reused from providers/gmail.js — extract text/plain from Gmail message payload
function extractBody(payload, depth = 0) {
  if (!payload || depth > 10) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
    }
    for (const part of payload.parts) {
      if (part.parts) {
        const nested = extractBody(part, depth + 1);
        if (nested) return nested;
      }
    }
  }
  return "";
}

function decodeBase64Url(data) {
  const padded = data.replace(/-/g, "+").replace(/_/g, "/");
  return decodeURIComponent(escape(atob(padded)));
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
        await sendEmail(text, `[SWAYAMBHU-DEV] ${args.id || "Report"}`);
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
