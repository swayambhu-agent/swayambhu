// Tool: send_email — send an email or reply to a thread via Gmail.
// No `export default` — required for wrapAsModule compatibility.

export const meta = {
  secrets: ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"],
  kv_access: "none",
  timeout_ms: 15000,
  provider: "gmail",
  communication: { channel: "email", recipient_field: "to", reply_field: "reply_to_id", content_field: "body", recipient_type: "person" },
};

export async function execute({ to, subject, body, reply_to_id, secrets, fetch, provider }) {
  if (!to) return { error: "missing required param: to" };
  if (!subject && !reply_to_id) return { error: "missing required param: subject (required unless replying)" };
  if (!body) return { error: "missing required param: body" };

  const token = await provider.getAccessToken(secrets, fetch);

  let inReplyTo = null;
  let threadId = null;
  let replySubject = subject;

  // If replying, fetch the original message for threading headers.
  if (reply_to_id) {
    const original = await provider.getMessage(token, fetch, reply_to_id);
    inReplyTo = original.messageId;
    threadId = original.threadId;
    if (!replySubject) {
      replySubject = original.subject.startsWith("Re:")
        ? original.subject
        : `Re: ${original.subject}`;
    }
  }

  const result = await provider.sendMessage(token, fetch, {
    to,
    subject: replySubject,
    body,
    inReplyTo,
    threadId,
  });

  return { sent: true, messageId: result.messageId, threadId: result.threadId };
}
