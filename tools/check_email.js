// Tool: check_email — fetch unread emails from Gmail.
// No `export default` — required for wrapAsModule compatibility.

export const meta = {
  secrets: ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"],
  kv_access: "none",
  timeout_ms: 15000,
  provider: "gmail",
  inbound: { channel: "email", sender_field: "sender_email", content_field: "body", result_array: "emails" },
};

export async function execute({ mark_read = true, max_results, secrets, fetch, provider }) {
  const token = await provider.getAccessToken(secrets, fetch);
  const limit = Math.min(max_results || 10, 20);
  const stubs = await provider.listUnread(token, fetch, limit);

  if (stubs.length === 0) return { emails: [], count: 0 };

  const emails = [];
  for (const stub of stubs) {
    const msg = await provider.getMessage(token, fetch, stub.id);
    emails.push({
      id: msg.id,
      threadId: msg.threadId,
      from: msg.from,
      sender_email: extractEmailAddress(msg.from),
      subject: msg.subject,
      date: msg.date,
      body: msg.body,
    });
    if (mark_read) await provider.markAsRead(token, fetch, stub.id);
  }

  return { emails, count: emails.length };
}

function extractEmailAddress(from) {
  return from.match(/<(.+)>/)?.[1] || from;
}
