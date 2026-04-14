import { isOpenWorkThreadStatus, upsertWorkThread, normalizeWorkThread } from "./work-threads.js";

export const CONTINUATION_STATUSES = new Set(["active", "blocked", "done", "dropped", "expired"]);
export const OPEN_CONTINUATION_STATUSES = new Set(["active", "blocked"]);

function nowIso() {
  return new Date().toISOString();
}

function isValidISODate(str) {
  if (!str || typeof str !== "string") return false;
  const d = new Date(str);
  return !Number.isNaN(d.getTime());
}

export function normalizeContinuationStatus(status) {
  return CONTINUATION_STATUSES.has(status) ? status : "active";
}

export function normalizeContinuation(item, { now = nowIso(), defaultExpiresAt = new Date(Date.now() + 7 * 86400000).toISOString() } = {}) {
  const normalized = {
    ...item,
    id: typeof item?.id === "string" && item.id.trim() ? item.id.trim() : `cf_${Date.now()}`,
    request_id: typeof item?.request_id === "string" && item.request_id.trim() ? item.request_id.trim() : undefined,
    item: typeof item?.item === "string" ? item.item : "",
    why: typeof item?.why === "string" ? item.why : "",
    priority: item?.priority || "medium",
    status: normalizeContinuationStatus(item?.status),
    created_at: isValidISODate(item?.created_at) ? new Date(item.created_at).toISOString() : now,
    updated_at: isValidISODate(item?.updated_at) ? new Date(item.updated_at).toISOString() : now,
    expires_at: isValidISODate(item?.expires_at) ? new Date(item.expires_at).toISOString() : defaultExpiresAt,
    ...(typeof item?.blocked_on === "string" && item.blocked_on.trim() ? { blocked_on: item.blocked_on.trim() } : {}),
    ...(typeof item?.wake_condition === "string" && item.wake_condition.trim() ? { wake_condition: item.wake_condition.trim() } : {}),
    ...(typeof item?.result === "string" && item.result.trim() ? { result: item.result.trim() } : {}),
    ...(typeof item?.reason === "string" && item.reason.trim() ? { reason: item.reason.trim() } : {}),
    ...(typeof item?.desire_key === "string" && item.desire_key.trim() ? { desire_key: item.desire_key.trim() } : {}),
  };
  return normalized;
}

export function collectActiveContinuationRequestIds(continuations = []) {
  const ids = new Set();
  for (const continuation of continuations) {
    const normalized = normalizeContinuation(continuation);
    if (OPEN_CONTINUATION_STATUSES.has(normalized.status) && normalized.request_id) {
      ids.add(normalized.request_id);
    }
  }
  return ids;
}

export function validateContinuation(continuation, openThreadIndex = new Map()) {
  const normalized = normalizeContinuation(continuation);
  if (!OPEN_CONTINUATION_STATUSES.has(normalized.status)) {
    return { ok: true, continuation: normalized };
  }
  if (!normalized.request_id) {
    return { ok: false, error: "missing_request_id", continuation: normalized };
  }
  const parent = openThreadIndex.get(normalized.request_id);
  if (!parent || !isOpenWorkThreadStatus(parent.status)) {
    return { ok: false, error: "parent_not_open", continuation: normalized };
  }
  return { ok: true, continuation: normalized };
}

export async function migrateLegacyCarryForward(K, continuations = [], options = {}) {
  const now = options.now || nowIso();
  const defaultExpiresAt = options.defaultExpiresAt || new Date(Date.now() + 7 * 86400000).toISOString();
  const migrated = [];

  for (const raw of continuations || []) {
    const continuation = normalizeContinuation(raw, { now, defaultExpiresAt });
    if (OPEN_CONTINUATION_STATUSES.has(continuation.status) && !continuation.request_id) {
      const created = await upsertWorkThread(K, {
        requester: { type: "self", id: "self" },
        conversation_ref: null,
        summary: continuation.item || continuation.why || "Legacy continuation",
        intent: "new_parallel",
        idempotency_key: `legacy-cf:${continuation.id}`,
      });
      if (created?.ok) {
        continuation.request_id = created.request_id;
      }
    }
    migrated.push(continuation);
  }

  return migrated;
}

export function reconcileContinuationsAgainstThreads({
  continuations = [],
  threads = [],
  now = nowIso(),
  defaultExpiresAt = new Date(Date.now() + 7 * 86400000).toISOString(),
} = {}) {
  const threadIndex = new Map(
    (threads || []).map((thread) => {
      const normalized = normalizeWorkThread(thread, thread?.key || null);
      return [normalized.id, normalized];
    }),
  );

  return (continuations || []).map((raw) => {
    const continuation = normalizeContinuation(raw, { now, defaultExpiresAt });
    if (OPEN_CONTINUATION_STATUSES.has(continuation.status)
      && continuation.expires_at
      && new Date(continuation.expires_at).getTime() < new Date(now).getTime()) {
      return { ...continuation, status: "expired", updated_at: now };
    }
    if (!OPEN_CONTINUATION_STATUSES.has(continuation.status)) {
      return continuation;
    }
    const parent = continuation.request_id ? threadIndex.get(continuation.request_id) : null;
    if (!parent) {
      return { ...continuation, status: "dropped", updated_at: now, reason: continuation.reason || "missing parent work thread" };
    }
    if (!isOpenWorkThreadStatus(parent.status)) {
      return {
        ...continuation,
        status: parent.status === "expired" ? "expired" : "dropped",
        updated_at: now,
        reason: continuation.reason || `parent thread is ${parent.status}`,
      };
    }
    return continuation;
  });
}

export async function applyContinuationUpdates({
  previous = [],
  carry_forward_updates = [],
  new_carry_forward = [],
  validDesireKeys = new Set(),
  sessionId,
  openThreads = [],
  workThreadStore = null,
  karmaRecord = null,
  now = nowIso(),
  defaultExpiresAt = new Date(Date.now() + 7 * 86400000).toISOString(),
} = {}) {
  let carryForward = (previous || []).map((item) => normalizeContinuation(item, { now, defaultExpiresAt }));
  const threadList = [...(openThreads || [])];
  const openThreadIndex = new Map(threadList.map((thread) => {
    const normalized = normalizeWorkThread(thread, thread?.key || null);
    return [normalized.id, normalized];
  }));

  const updateList = Array.isArray(carry_forward_updates) ? carry_forward_updates : [];
  const newList = Array.isArray(new_carry_forward) ? new_carry_forward : [];

  const missedCarryForward = [];
  for (const rawUpdate of updateList) {
    const existing = carryForward.find((item) => item.id === rawUpdate?.id);
    if (!existing) {
      missedCarryForward.push(rawUpdate);
      continue;
    }

    const updated = normalizeContinuation({
      ...existing,
      ...rawUpdate,
      updated_at: rawUpdate?.updated_at || now,
    }, { now, defaultExpiresAt });

    if ("desire_key" in rawUpdate) {
      if (updated.desire_key && !validDesireKeys.has(updated.desire_key)) {
        delete updated.desire_key;
        if (karmaRecord) {
          await karmaRecord({
            event: "carry_forward_invalid_desire_key_ignored",
            source: "update",
            id: updated.id,
            desire_key: rawUpdate.desire_key,
          });
        }
      }
    }

    const validation = validateContinuation(updated, openThreadIndex);
    if (!validation.ok) {
      updated.status = "dropped";
      updated.updated_at = now;
      updated.reason = updated.reason || validation.error;
    }
    if (updated.status === "done") {
      updated.done_session = sessionId;
    }
    Object.assign(existing, updated);
  }

  if (missedCarryForward.length && karmaRecord) {
    await karmaRecord({ event: "carry_forward_updates_missed", missed: missedCarryForward });
  }

  for (const rawItem of newList) {
    const normalized = normalizeContinuation({
      ...rawItem,
      status: rawItem?.status || "active",
      created_at: rawItem?.created_at || now,
      updated_at: rawItem?.updated_at || now,
      expires_at: rawItem?.expires_at || defaultExpiresAt,
    }, { now, defaultExpiresAt });

    if (OPEN_CONTINUATION_STATUSES.has(normalized.status) && !normalized.request_id && workThreadStore) {
      const created = await upsertWorkThread(workThreadStore, {
        requester: { type: "self", id: "self" },
        conversation_ref: null,
        summary: normalized.item || normalized.why || "Reflect-created continuation",
        intent: "new_parallel",
        idempotency_key: `new-cf:${normalized.id}`,
      });
      if (created?.ok) {
        normalized.request_id = created.request_id;
        const createdThread = normalizeWorkThread(created.request, created.request?.key || null);
        openThreadIndex.set(created.request_id, createdThread);
        threadList.push(createdThread);
      }
    }

    if (normalized.desire_key && !validDesireKeys.has(normalized.desire_key)) {
      if (karmaRecord) {
        await karmaRecord({
          event: "carry_forward_invalid_desire_key_ignored",
          source: "new",
          id: normalized.id,
          desire_key: normalized.desire_key,
        });
      }
      delete normalized.desire_key;
    }

    const validation = validateContinuation(normalized, openThreadIndex);
    if (!validation.ok) {
      if (karmaRecord) {
        await karmaRecord({
          event: "carry_forward_orphan_blocked",
          id: normalized.id,
          error: validation.error,
        });
      }
      continue;
    }

    const existingActive = normalized.desire_key
      && carryForward.find((item) =>
        item.status === "active"
        && item.desire_key === normalized.desire_key
        && item.id !== normalized.id,
      );
    if (existingActive) {
      if (karmaRecord) {
        await karmaRecord({
          event: "carry_forward_dedup_skipped",
          new_id: normalized.id,
          existing_id: existingActive.id,
          desire_key: normalized.desire_key,
        });
      }
      continue;
    }

    carryForward.push(normalized);
  }

  carryForward = reconcileContinuationsAgainstThreads({
    continuations: carryForward,
    threads: threadList,
    now,
    defaultExpiresAt,
  });

  return carryForward;
}
