// Channel adapter: WhatsApp Business Cloud API
// Webhook: POST /channel/whatsapp (messages), GET /channel/whatsapp (verification)
// No `export default` — required for channel adapter compatibility.

export const config = {
  secrets: ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"],
  webhook_secret_env: "WHATSAPP_APP_SECRET",
};

// ── Webhook verification (GET) ─────────────────────────────────

export function verifyWebhook(url, env) {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === env.WHATSAPP_VERIFY_TOKEN) {
    return challenge;
  }
  return null;
}

// ── Signature verification (POST) ──────────────────────────────

export async function verify(headers, rawBody, env) {
  const signature = headers.get?.("X-Hub-Signature-256")
    || headers["x-hub-signature-256"];
  if (!signature || !env.WHATSAPP_APP_SECRET) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(env.WHATSAPP_APP_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
  const computed = `sha256=${hex}`;

  // Constant-time comparison
  if (computed.length !== signature.length) return false;
  const enc = new TextEncoder();
  const a = enc.encode(computed);
  const b = enc.encode(signature);
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}

// ── Parse inbound messages ─────────────────────────────────────

export function parseInbound(body) {
  if (body.object !== "whatsapp_business_account") return null;

  const entry = body.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  if (!value) return null;

  // Filter: only process messages, not statuses (delivery receipts)
  const messages = value.messages;
  if (!messages || messages.length === 0) return null;

  // Process first text message (WhatsApp rarely batches in 1:1 chat)
  const msg = messages.find(m => m.type === "text");
  if (!msg) return null;

  const text = msg.text?.body || "";
  const command = text.startsWith("/")
    ? text.slice(1).split(" ")[0]
    : null;

  return {
    chatId: msg.from,
    text,
    userId: msg.from,
    command,
    msgId: msg.id || null,
    sentTs: msg.timestamp || null,
    _phoneNumberId: value.metadata?.phone_number_id || null,
  };
}

// ── Chat key: phone number (WhatsApp DMs are always 1:1) ──────

export function resolveChatKey(inbound) {
  return inbound.userId;
}

// ── Send reply ─────────────────────────────────────────────────

export async function sendReply(chatId, text, secrets, fetchFn) {
  const phoneNumberId = secrets.WHATSAPP_PHONE_NUMBER_ID;
  const token = secrets.WHATSAPP_ACCESS_TOKEN;

  await fetchFn(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: chatId,
      type: "text",
      text: { body: text },
    }),
  });
}
