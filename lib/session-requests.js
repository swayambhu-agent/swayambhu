export const SESSION_REQUEST_STATUSES = new Set(["pending", "fulfilled", "rejected"]);

export async function applyRequestUpdate({
  requestKey,
  existing,
  status,
  note,
  result,
  error,
  next_session,
  kv,
  emitEvent,
}) {
  if (!requestKey || !existing) {
    return { ok: false, error: "requestKey and existing request are required" };
  }
  if (!SESSION_REQUEST_STATUSES.has(status)) {
    return { ok: false, error: `Invalid status: ${status}` };
  }

  const updated = {
    ...existing,
    status,
    updated_at: new Date().toISOString(),
  };

  if (note !== undefined) updated.note = note;
  if (result !== undefined) updated.result = result;
  if (error !== undefined) updated.error = error;
  if (next_session !== undefined) updated.next_session = next_session;

  await kv.put(requestKey, updated);
  await emitEvent("session_response", {
    contact: existing.contact,
    ref: requestKey,
    status,
  });

  return {
    ok: true,
    request_id: existing.id,
    status,
    request: updated,
  };
}
