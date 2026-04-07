export const meta = {
  kv_access: "read_all",
  kv_write_prefixes: ["session_request:"],
  timeout_ms: 5000,
  secrets: [],
};

const ALLOWED_STATUSES = new Set(["pending", "fulfilled", "rejected"]);

export async function execute({ request_id, status, note, result, error, next_session, kv, emitEvent }) {
  if (!request_id || !status) {
    return { error: "request_id and status are required" };
  }
  if (!ALLOWED_STATUSES.has(status)) {
    return { error: `Invalid status: ${status}` };
  }

  const key = `session_request:${request_id}`;
  const existing = await kv.get(key);
  if (!existing) {
    return { error: `Unknown request: ${request_id}` };
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

  await kv.put(key, updated);
  await emitEvent("session_response", {
    contact: existing.contact,
    ref: key,
    status,
  });

  return { ok: true, request_id, status };
}
