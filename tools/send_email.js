// Tool: send_email — send an email or reply to a thread via Akash email gateway.
// No `export default` — required for wrapAsModule compatibility.

export const meta = {
  secrets: ["CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "EMAIL_RELAY_SECRET"],
  kv_access: "none",
  timeout_ms: 60000,
  provider: "email-relay",
  communication: { channel: "email", recipient_field: "to", reply_field: "reply_to_id", content_field: "body", recipient_type: "person" },
};

export async function execute({ to, subject, body, reply_to_id, secrets, fetch, provider, config }) {
  if (!to) return { error: "missing required param: to" };
  if (!subject && !reply_to_id) return { error: "missing required param: subject (required unless replying)" };
  if (!body) return { error: "missing required param: body" };

  let inReplyTo = null;
  let replySubject = subject;

  // If replying, fetch the original message for threading headers.
  if (reply_to_id) {
    try {
      const original = await provider.getMessage({ id: reply_to_id, secrets, fetch, config });
      inReplyTo = original.messageId;
      if (!replySubject) {
        replySubject = original.subject.startsWith("Re:")
          ? original.subject
          : `Re: ${original.subject}`;
      }
    } catch {
      if (!replySubject) replySubject = subject || "Re:";
    }
  }

  const result = await provider.sendMessage({
    to,
    subject: replySubject,
    body,
    inReplyTo,
    secrets,
    fetch,
    config,
  });

  return { sent: true, messageId: result.messageId };
}
