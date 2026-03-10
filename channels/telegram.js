// Channel adapter: Telegram
// KV keys: channel:telegram:code, channel:telegram:config
// No `export default` — required for wrapChannelAdapter compatibility.

export const config = {
  secrets: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"],
  webhook_secret_env: "TELEGRAM_WEBHOOK_SECRET",
};

export function verify(headers, body, env) {
  const token = headers.get("X-Telegram-Bot-Api-Secret-Token");
  const expected = env.TELEGRAM_WEBHOOK_SECRET;
  return !!expected && token === expected;
}

export function parseInbound(body) {
  const msg = body.message;
  if (!msg?.text) return null;
  const command = msg.text.startsWith("/")
    ? msg.text.slice(1).split(" ")[0].split("@")[0]
    : null;
  return {
    chatId: String(msg.chat.id),
    text: msg.text,
    userId: String(msg.from?.id || msg.chat.id),
    command,
  };
}

export async function sendReply(chatId, text, secrets, fetchFn) {
  const url = `https://api.telegram.org/bot${secrets.TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
    }),
  });
}
