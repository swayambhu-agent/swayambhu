import {
  WORK_THREAD_STATUSES,
  normalizeWorkThread,
  normalizeWorkThreadStatus,
  resolveRequestContact as resolveWorkThreadContact,
  applyWorkThreadUpdate,
} from "./work-threads.js";

export const SESSION_REQUEST_STATUSES = new Set(["pending", ...WORK_THREAD_STATUSES]);

export function resolveRequestContact(request) {
  return resolveWorkThreadContact(request);
}

export function normalizeSessionRequest(request, key = null) {
  return normalizeWorkThread(request, key);
}

export async function applyRequestUpdate({
  requestKey,
  existing,
  status,
  note,
  result,
  error,
  next_session,
  contract_type,
  completion_condition,
  timebound_duration_hours,
  timebound_until_at,
  superseded_by,
  allow_early_completion,
  intent,
  kv,
  emitEvent,
}) {
  const normalizedStatus = normalizeWorkThreadStatus(status);
  if (!SESSION_REQUEST_STATUSES.has(String(status || "").trim()) && !WORK_THREAD_STATUSES.has(normalizedStatus)) {
    return { ok: false, error: `Invalid status: ${status}` };
  }

  return applyWorkThreadUpdate({
    requestKey,
    existing,
    status: normalizedStatus,
    note,
    result,
    error,
    next_session,
    contract_type,
    completion_condition,
    timebound_duration_hours,
    timebound_until_at,
    superseded_by,
    allow_early_completion,
    intent,
    kv,
    emitEvent,
  });
}
