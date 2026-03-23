// Channel adapter: Slack
// KV keys: channel:slack:code, channel:slack:config
// No `export default` — required for wrapChannelAdapter compatibility.

export const config = {
  secrets: ["SLACK_BOT_TOKEN"],
  webhook_secret_env: "SLACK_SIGNING_SECRET",
};

export async function verify(headers, rawBody, env) {
  const timestamp = headers.get?.("X-Slack-Request-Timestamp")
    || headers["x-slack-request-timestamp"];
  const signature = headers.get?.("X-Slack-Signature")
    || headers["x-slack-signature"];
  if (!timestamp || !signature || !env.SLACK_SIGNING_SECRET) return false;

  // Reject requests older than 5 minutes (replay protection)
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (age > 300) return false;

  // HMAC-SHA256: v0:timestamp:rawBody
  const sigBasestring = `v0:${timestamp}:${rawBody}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(env.SLACK_SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(sigBasestring));
  const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
  const computed = `v0=${hex}`;

  // Constant-time comparison to prevent timing attacks
  if (computed.length !== signature.length) return false;
  const enc = new TextEncoder();
  const a = enc.encode(computed);
  const b = enc.encode(signature);
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}

export function parseInbound(body) {
  // Slack URL verification challenge — signal kernel to echo it back
  if (body.type === "url_verification") {
    return { _challenge: body.challenge };
  }

  const event = body.event;
  if (!event || event.type !== "message") return null;

  // Ignore bot messages, message_changed, etc.
  if (event.bot_id || event.subtype) return null;

  const text = event.text || "";
  const command = text.startsWith("/")
    ? text.slice(1).split(" ")[0]
    : null;

  return {
    chatId: event.channel,
    text,
    userId: event.user,
    command,
    msgId: event.client_msg_id || null,
  };
}

// Canonical chat key: DMs keyed by userId (matches send_slack targets),
// channels/groups keyed by channelId. Default for other adapters: chatId.
export function resolveChatKey(inbound) {
  if (inbound.chatId?.startsWith("D") && inbound.userId) return inbound.userId;
  return inbound.chatId;
}

export async function sendReply(chatId, text, secrets, fetchFn) {
  await fetchFn("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${secrets.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({
      channel: chatId,
      text,
    }),
  });
}
