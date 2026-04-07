import { applyRequestUpdate, SESSION_REQUEST_STATUSES } from "../lib/session-requests.js";

export const meta = {
  kv_access: "read_all",
  kv_write_prefixes: ["session_request:"],
  timeout_ms: 5000,
  secrets: [],
};

export async function execute({ request_id, status, note, result, error, next_session, kv, emitEvent }) {
  if (!request_id || !status) {
    return { error: "request_id and status are required" };
  }
  if (!SESSION_REQUEST_STATUSES.has(status)) {
    return { error: `Invalid status: ${status}` };
  }

  const key = `session_request:${request_id}`;
  const existing = await kv.get(key);
  if (!existing) {
    return { error: `Unknown request: ${request_id}` };
  }

  const outcome = await applyRequestUpdate({
    requestKey: key,
    existing,
    status,
    note,
    result,
    error,
    next_session,
    kv,
    emitEvent,
  });

  if (!outcome.ok) return outcome;
  return { ok: true, request_id, status };
}
