import { upsertWorkThread } from "../lib/work-threads.js";

export const meta = {
  kv_access: "read_all",
  kv_write_prefixes: ["session_request:", "session_request_lease:", "session_schedule"],
  timeout_ms: 5000,
  secrets: [],
};

// Chat-only tool: signal that the conversation has an actionable work thread.
// The first rollout keeps the session_request:* storage prefix and public tool
// name for compatibility, but the semantics are now "upsert work thread".
export async function execute({
  summary,
  request_id,
  intent = "auto",
  contract_type,
  completion_condition,
  timebound_duration_hours,
  timebound_until_at,
  allow_early_completion,
  kv,
  emitEvent,
  _chatContext,
}) {
  if (!_chatContext) return { error: "trigger_session can only be called from chat" };

  const { userId, contact, convKey, chatConfig, latestInboundSentTs } = _chatContext;
  const contactSlug = contact?.id || userId;
  const requester = {
    type: "contact",
    id: contactSlug,
    name: contact?.name || userId,
    platform_user_id: userId || null,
  };

  const upsert = await upsertWorkThread(kv, {
    requester,
    conversation_ref: convKey,
    summary: summary || "(no summary)",
    request_id,
    intent,
    contract_type,
    completion_condition,
    timebound_duration_hours,
    timebound_until_at,
    allow_early_completion,
    idempotency_key: `${convKey}:${latestInboundSentTs || Date.now()}:${summary || "(no summary)"}`,
  });

  if (!upsert.ok) {
    return upsert;
  }

  // Emit event — signal for sessionTrigger handler
  await emitEvent("session_request", {
    contact: contactSlug,
    requester,
    ref: `session_request:${upsert.request_id}`,
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

  return { ok: true, request_id: upsert.request_id, created: upsert.created };
}
