export const meta = {
  secrets: ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"],
  kv_access: "none",
  timeout_ms: 10000,
  communication: { channel: "whatsapp", recipient_field: "to", reply_field: null, content_field: "text", recipient_type: "phone_number" },
};

export async function execute({ to, text, secrets, fetch }) {
  const phoneNumberId = secrets.WHATSAPP_PHONE_NUMBER_ID;
  const resp = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${secrets.WHATSAPP_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });
  return resp.json();
}
