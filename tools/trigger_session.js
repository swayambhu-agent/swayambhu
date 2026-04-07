export const meta = {
  kv_access: "read_all",
  kv_write_prefixes: ["session_request:", "session_schedule"],
  timeout_ms: 5000,
  secrets: [],
};

// Chat-only tool: signal that the conversation has an actionable request.
// Creates a session_request KV key (source of truth) and emits a
// session_request event (signal). The request contract is generic:
// it can represent work requested by any contact, and the same schema
// can later support self-originated work with a different source.
export async function execute({ summary, kv, emitEvent, _chatContext }) {
  if (!_chatContext) return { error: "trigger_session can only be called from chat" };

  const { userId, contact, convKey, chatConfig } = _chatContext;
  const contactSlug = contact?.id || userId;
  const requester = {
    type: "contact",
    id: contactSlug,
    name: contact?.name || userId,
    platform_user_id: userId || null,
  };

  // Create session_request KV key — source of truth
  const id = `req_${Date.now()}`;
  const request = {
    id,
    source: "contact",
    requester,
    contact: contactSlug,
    contact_name: requester.name,
    platform_user_id: requester.platform_user_id,
    summary: summary || "(no summary)",
    status: "pending",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ref: convKey,
    result: null,
    error: null,
    next_session: null,
  };
  await kv.put(`session_request:${id}`, request);

  // Emit event — signal for sessionTrigger handler
  await emitEvent("session_request", {
    contact: contactSlug,
    requester,
    ref: `session_request:${id}`,
  });

  // Advance session schedule
  const advanceSecs = chatConfig?.session_advance_seconds
    ?? (chatConfig?.session_advance_minutes ? chatConfig.session_advance_minutes * 60 : 30);
  const schedule = await kv.get("session_schedule");
  if (schedule?.next_session_after) {
    const sessionAt = new Date(schedule.next_session_after).getTime();
    const advanceTo = Date.now() + advanceSecs * 1000;
    if (sessionAt > advanceTo) {
      await kv.put("session_schedule", {
        ...schedule,
        next_session_after: new Date(advanceTo).toISOString(),
      });
    }
  }

  return { ok: true, request_id: id };
}
