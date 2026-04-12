// Tool: check_email — fetch unread emails via Akash email gateway.
// No `export default` — required for wrapAsModule compatibility.

export const meta = {
  secrets: ["CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "EMAIL_RELAY_SECRET"],
  kv_access: "none",
  timeout_ms: 60000,
  provider: "email-relay",
  inbound: { channel: "email", sender_field: "sender_email", content_field: "body", result_array: "emails" },
};

export async function execute({ mark_read = true, max_results, secrets, fetch, provider, config }) {
  const limit = Math.min(max_results || 10, 20);

  const result = await provider.checkEmail({
    maxResults: limit,
    markRead: mark_read,
    secrets,
    fetch,
    config,
  });

  if (result.count === 0) return { emails: [], count: 0 };

  const emails = result.emails.map((email) => ({
    id: email.id,
    from: email.from,
    sender_email: email.sender_email || extractEmailAddress(email.from),
    subject: email.subject,
    date: email.date,
    body: email.body,
  }));

  return { emails, count: emails.length };
}

function extractEmailAddress(from) {
  return from.match(/<(.+)>/)?.[1] || from;
}
