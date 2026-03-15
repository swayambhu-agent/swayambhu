// Tool: check_email — fetch unread emails from Gmail.
// No `export default` — required for wrapAsModule compatibility.

export const meta = {
  secrets: ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"],
  kv_access: "none",
  timeout_ms: 15000,
  inbound: { channel: "email", sender_field: "sender_email", content_field: "body", result_array: "emails" },
};

export async function execute({ mark_read, max_results, secrets, fetch }) {
  // Dynamic import won't work in KV-loaded modules — inline the provider calls.
  const token = await getAccessToken(secrets, fetch);
  const limit = Math.min(max_results || 10, 20);
  const stubs = await listUnread(token, fetch, limit);

  if (stubs.length === 0) return { emails: [], count: 0 };

  const emails = [];
  for (const stub of stubs) {
    const msg = await getMessage(token, fetch, stub.id);
    emails.push({
      id: msg.id,
      threadId: msg.threadId,
      from: msg.from,
      sender_email: extractEmailAddress(msg.from),
      subject: msg.subject,
      date: msg.date,
      body: msg.body,
    });
    if (mark_read) await markAsRead(token, fetch, stub.id);
  }

  return { emails, count: emails.length };
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

async function listUnread(token, fetchFn, maxResults) {
  const q = encodeURIComponent("is:unread");
  const resp = await fetchFn(
    `${API}/messages?q=${q}&maxResults=${maxResults}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gmail list failed (${resp.status}): ${text}`);
  }
  const data = await resp.json();
  return data.messages || [];
}

async function getMessage(token, fetchFn, id) {
  const resp = await fetchFn(
    `${API}/messages/${id}?format=full`,
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
    id: msg.id,
    threadId: msg.threadId,
    from: hdr("From"),
    subject: hdr("Subject"),
    date: hdr("Date"),
    messageId: hdr("Message-ID"),
    body: extractBody(msg.payload),
  };
}

async function markAsRead(token, fetchFn, id) {
  await fetchFn(`${API}/messages/${id}/modify`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ removeLabelIds: ["UNREAD"] }),
  });
}

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
      if (part.mimeType === "text/html" && part.body?.data) {
        return stripHtml(decodeBase64Url(part.body.data));
      }
    }
    for (const part of payload.parts) {
      if (part.parts) {
        const nested = extractBody(part, depth + 1);
        if (nested) return nested;
      }
    }
  }
  if (payload.mimeType === "text/html" && payload.body?.data) {
    return stripHtml(decodeBase64Url(payload.body.data));
  }
  return "";
}

function decodeBase64Url(data) {
  const padded = data.replace(/-/g, "+").replace(/_/g, "/");
  return decodeURIComponent(escape(atob(padded)));
}

function extractEmailAddress(from) {
  return from.match(/<(.+)>/)?.[1] || from;
}

function stripHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
