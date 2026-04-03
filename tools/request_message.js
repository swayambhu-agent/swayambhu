export const meta = {
  kv_access: "none",
  timeout_ms: 5000,
  secrets: [],
};

export async function execute({ contact, intent, content, K }) {
  if (!contact || !intent || !content) {
    return { error: "contact, intent, and content are required" };
  }

  // Validate contact exists
  const contactRecord = await K.kvGet(`contact:${contact}`);
  if (!contactRecord) {
    return { error: `Unknown contact: ${contact}. Use a contact slug, not a platform ID.` };
  }

  await K.emitEvent("comms_request", { contact, intent, content });

  return { ok: true, contact, intent };
}
