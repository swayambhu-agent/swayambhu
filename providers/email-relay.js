// Email relay provider — sends and reads email via Akash gateway.
// Follows providers/compute.js pattern (CF Access + bearer auth).
// No `export default` — required for wrapAsModule compatibility.

export const meta = {
  secrets: ["CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "EMAIL_RELAY_SECRET"],
  timeout_ms: 60000,
};

function buildHeaders(secrets, baseUrl) {
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${secrets.EMAIL_RELAY_SECRET}`,
  };

  if (baseUrl && !baseUrl.includes("localhost")) {
    headers["CF-Access-Client-Id"] = secrets.CF_ACCESS_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = secrets.CF_ACCESS_CLIENT_SECRET;
  }

  return headers;
}

async function relayCall(endpoint, body, { secrets, fetch, config }) {
  const baseUrl = config?.email?.relay_url || "https://akash.swayambhu.dev";

  const resp = await fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers: buildHeaders(secrets, baseUrl),
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

export async function sendMessage({ to, subject, body, inReplyTo, secrets, fetch, config }) {
  const data = await relayCall("/send-email", {
    to,
    subject,
    body,
    in_reply_to: inReplyTo || null,
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
    max_results: maxResults || 10,
    mark_read: markRead !== false,
  }, { secrets, fetch, config });

  return { emails: data.emails, count: data.count };
}

export async function check({ secrets, fetch, config }) {
  const data = await relayCall("/check-email", {
    max_results: 1,
    mark_read: false,
  }, { secrets, fetch, config });

  return data.count || 0;
}
