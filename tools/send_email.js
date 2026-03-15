// Tool: send_email — send an email or reply to a thread via Gmail.
// No `export default` — required for wrapAsModule compatibility.

export const meta = {
  secrets: ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"],
  kv_access: "none",
  timeout_ms: 15000,
  communication: { channel: "email", recipient_field: "to", reply_field: "reply_to_id", content_field: "body", recipient_type: "person" },
};

export async function execute({ to, subject, body, reply_to_id, secrets, fetch }) {
  if (!to) return { error: "missing required param: to" };
  if (!subject && !reply_to_id) return { error: "missing required param: subject (required unless replying)" };
  if (!body) return { error: "missing required param: body" };

  const token = await getAccessToken(secrets, fetch);

  let inReplyTo = null;
  let threadId = null;
  let replySubject = subject;

  // If replying, fetch the original message for threading headers.
  if (reply_to_id) {
    const original = await getMessage(token, fetch, reply_to_id);
    inReplyTo = original.messageId;
    threadId = original.threadId;
    if (!replySubject) {
      replySubject = original.subject.startsWith("Re:")
        ? original.subject
        : `Re: ${original.subject}`;
    }
  }

  const result = await sendMessage(token, fetch, {
    to,
    subject: replySubject,
    body,
    inReplyTo,
    threadId,
  });

  return { sent: true, messageId: result.messageId, threadId: result.threadId };
}

// ── Gmail API helpers (inlined from providers/gmail.js) ──────

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

async function getAccessToken(secrets, fetchFn) {
  const resp = await fetchFn("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: secrets.GMAIL_CLIENT_ID,
      client_secret: secrets.GMAIL_CLIENT_SECRET,
      refresh_token: secrets.GMAIL_REFRESH_TOKEN,
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

async function getMessage(token, fetchFn, id) {
  const resp = await fetchFn(
    `${API}/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=Message-ID`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gmail get failed (${resp.status}): ${text}`);
  }
  const msg = await resp.json();
  const headers = msg.payload?.headers || [];
  const hdr = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || "";
  return {
    threadId: msg.threadId,
    subject: hdr("Subject"),
    messageId: hdr("Message-ID"),
  };
}

async function sendMessage(token, fetchFn, { to, subject, body, inReplyTo, threadId }) {
  const lines = [];
  lines.push(`To: ${to}`);
  lines.push(`Subject: ${subject}`);
  lines.push("MIME-Version: 1.0");
  lines.push("Content-Type: text/plain; charset=UTF-8");
  if (inReplyTo) {
    lines.push(`In-Reply-To: ${inReplyTo}`);
    lines.push(`References: ${inReplyTo}`);
  }
  lines.push("");
  lines.push(body);

  const raw = btoa(unescape(encodeURIComponent(lines.join("\r\n"))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const payload = { raw };
  if (threadId) payload.threadId = threadId;

  const resp = await fetchFn(`${API}/messages/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gmail send failed (${resp.status}): ${text}`);
  }
  const result = await resp.json();
  return { messageId: result.id, threadId: result.threadId };
}
