export const meta = {
  kv_access: "none",
  timeout_ms: 5000,
  secrets: [],
};

// Chat-only tool: signal that the conversation has an actionable request.
// Emits a chat_message event and advances the session schedule.
export async function execute({ summary, K, _chatContext }) {
  if (!_chatContext) return { error: "trigger_session can only be called from chat" };

  const { channel, userId, contact, convKey, chatConfig } = _chatContext;

  // Emit event for the session to pick up
  await K.emitEvent("chat_message", {
    source: { channel, user_id: userId },
    contact_name: contact?.name || userId,
    contact_approved: !!contact?.approved,
    summary: summary || "(no summary)",
    ref: convKey,
  });

  // Advance session schedule
  const advanceSecs = chatConfig?.session_advance_seconds
    ?? (chatConfig?.session_advance_minutes ? chatConfig.session_advance_minutes * 60 : 30);
  const schedule = await K.kvGet("session_schedule");
  if (schedule?.next_session_after) {
    const sessionAt = new Date(schedule.next_session_after).getTime();
    const advanceTo = Date.now() + advanceSecs * 1000;
    if (sessionAt > advanceTo) {
      await K.kvWriteSafe("session_schedule", {
        ...schedule,
        next_session_after: new Date(advanceTo).toISOString(),
      });
    }
  }

  return { ok: true, message: "Session triggered" };
}
