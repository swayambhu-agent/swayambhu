// Gmail API adapter — token refresh, list/get/send/modify messages.
// No `export default` — required for wrapAsModule compatibility.

export const meta = {
  secrets: ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"],
  timeout_ms: 15000,
};

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export async function getAccessToken(secrets, fetchFn) {
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

export async function listUnread(token, fetchFn, maxResults = 10) {
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

export async function getMessage(token, fetchFn, id) {
  const resp = await fetchFn(
    `${API}/messages/${id}?format=full`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gmail get message failed (${resp.status}): ${text}`);
  }
  const msg = await resp.json();
  const headers = msg.payload?.headers || [];
  const hdr = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || "";

  return {
    id: msg.id,
    threadId: msg.threadId,
    from: hdr("From"),
    to: hdr("To"),
    subject: hdr("Subject"),
    date: hdr("Date"),
    messageId: hdr("Message-ID"),
    body: extractBody(msg.payload),
  };
}

export async function sendMessage(token, fetchFn, { to, subject, body, inReplyTo, threadId }) {
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

export async function markAsRead(token, fetchFn, id) {
  const resp = await fetchFn(`${API}/messages/${id}/modify`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ removeLabelIds: ["UNREAD"] }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gmail markAsRead failed (${resp.status}): ${text}`);
  }
}

// Provider pattern — returns unread count for act context.
export async function check({ secrets, fetch: fetchFn }) {
  const token = await getAccessToken(secrets, fetchFn);
  const messages = await listUnread(token, fetchFn, 1);
  // listUnread with maxResults=1 still returns resultSizeEstimate
  const countResp = await fetchFn(
    `${API}/messages?q=${encodeURIComponent("is:unread")}&maxResults=1`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const countData = await countResp.json();
  return countData.resultSizeEstimate || 0;
}

// ── Helpers ──────────────────────────────────────────────────

function extractBody(payload, depth = 0) {
  if (!payload || depth > 10) return "";

  // Simple text/plain body
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  // Multipart — recurse into parts, prefer text/plain
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
    }
    // Fallback: try text/html
    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body?.data) {
        return stripHtml(decodeBase64Url(part.body.data));
      }
    }
    // Nested multipart
    for (const part of payload.parts) {
      if (part.parts) {
        const nested = extractBody(part, depth + 1);
        if (nested) return nested;
      }
    }
  }

  // Fallback: html body at top level
  if (payload.mimeType === "text/html" && payload.body?.data) {
    return stripHtml(decodeBase64Url(payload.body.data));
  }

  return "";
}

function decodeBase64Url(data) {
  const padded = data.replace(/-/g, "+").replace(/_/g, "/");
  return decodeURIComponent(escape(atob(padded)));
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
