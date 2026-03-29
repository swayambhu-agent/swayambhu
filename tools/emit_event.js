export const meta = {
  kv_access: "none",
  timeout_ms: 5000,
  secrets: [],
};

export async function execute({ type, contact, content, attachments, K }) {
  if (!type) return { error: "type is required" };

  const payload = {};
  if (contact) payload.contact = contact;
  if (content) payload.content = content;
  if (attachments) payload.attachments = attachments;

  const result = await K.emitEvent(type, payload);
  return result;
}
