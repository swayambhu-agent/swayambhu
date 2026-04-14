export const WORK_THREAD_KEY_PREFIX = "session_request:";
export const WORK_THREAD_LEASE_PREFIX = "session_request_lease:";

export const WORK_THREAD_STATUSES = new Set([
  "active",
  "blocked",
  "stale",
  "fulfilled",
  "rejected",
  "superseded",
  "expired",
]);

export const OPEN_WORK_THREAD_STATUSES = new Set(["active", "blocked", "stale"]);
export const CLOSED_WORK_THREAD_STATUSES = new Set(["fulfilled", "rejected", "superseded", "expired"]);

const LEGACY_STATUS_ALIASES = {
  pending: "active",
};

function nowIso() {
  return new Date().toISOString();
}

function normalizeIsoDate(value) {
  if (!value || typeof value !== "string") return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function clampPositiveNumber(value) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function normalizeConversationRef(record) {
  const ref = record?.conversation_ref ?? record?.ref ?? null;
  return typeof ref === "string" && ref.trim() ? ref.trim() : null;
}

function normalizeRequester(record) {
  const requester = record?.requester || null;
  if (requester && typeof requester === "object" && typeof requester.id === "string" && requester.id.trim()) {
    return {
      type: requester.type === "self" ? "self" : "contact",
      id: requester.id.trim(),
      ...(typeof requester.name === "string" && requester.name.trim() ? { name: requester.name.trim() } : {}),
      ...(typeof requester.platform_user_id === "string" && requester.platform_user_id.trim()
        ? { platform_user_id: requester.platform_user_id.trim() }
        : {}),
    };
  }

  const contact = typeof record?.contact === "string" && record.contact.trim() ? record.contact.trim() : null;
  const platformUserId = typeof record?.platform_user_id === "string" && record.platform_user_id.trim()
    ? record.platform_user_id.trim()
    : null;
  const source = record?.source === "self" ? "self" : "contact";
  if (source === "self") {
    return { type: "self", id: "self" };
  }
  return {
    type: "contact",
    id: contact || platformUserId || "unknown_contact",
    ...(typeof record?.contact_name === "string" && record.contact_name.trim() ? { name: record.contact_name.trim() } : {}),
    ...(platformUserId ? { platform_user_id: platformUserId } : {}),
  };
}

export function normalizeWorkThreadStatus(status) {
  const normalized = LEGACY_STATUS_ALIASES[String(status || "").trim()] || String(status || "").trim();
  return WORK_THREAD_STATUSES.has(normalized) ? normalized : "active";
}

export function isOpenWorkThreadStatus(status) {
  return OPEN_WORK_THREAD_STATUSES.has(normalizeWorkThreadStatus(status));
}

export function isClosedWorkThreadStatus(status) {
  return CLOSED_WORK_THREAD_STATUSES.has(normalizeWorkThreadStatus(status));
}

export function deriveWorkThreadScope({ conversationRef, requesterId }) {
  const req = requesterId || "unknown_requester";
  return conversationRef ? `conversation:${conversationRef}::requester:${req}` : `requester:${req}`;
}

function sanitizeScope(scope) {
  return String(scope || "")
    .replace(/[^a-zA-Z0-9:_-]+/g, "_")
    .slice(0, 220);
}

function deriveTimeboundUntil(thread) {
  if (thread?.contract_type !== "timebound") return null;
  const explicitUntil = normalizeIsoDate(thread?.timebound_until_at);
  if (explicitUntil) return explicitUntil;
  const durationHours = clampPositiveNumber(thread?.timebound_duration_hours);
  const createdAt = normalizeIsoDate(thread?.created_at) || normalizeIsoDate(thread?.updated_at);
  if (!durationHours || !createdAt) return null;
  return new Date(new Date(createdAt).getTime() + durationHours * 3600_000).toISOString();
}

export function isTimeboundElapsed(thread, now = Date.now()) {
  const until = deriveTimeboundUntil(thread);
  if (!until) return false;
  return new Date(until).getTime() <= now;
}

export function normalizeWorkThread(record, key = null) {
  const requester = normalizeRequester(record);
  const conversationRef = normalizeConversationRef(record);
  const createdAt = normalizeIsoDate(record?.created_at) || nowIso();
  const updatedAt = normalizeIsoDate(record?.updated_at) || createdAt;
  const contractType = record?.contract_type === "timebound" ? "timebound" : "one_shot";
  const defaultCompletion = contractType === "timebound" ? "best_effort_by_timebound" : "deliver_requested_output";

  return {
    ...record,
    key: key || record?.key || (record?.id ? `${WORK_THREAD_KEY_PREFIX}${record.id}` : null),
    id: String(record?.id || key?.replace(WORK_THREAD_KEY_PREFIX, "") || `req_${Date.now()}`),
    requester,
    source: requester.type,
    contact: requester.type === "contact" ? requester.id : null,
    contact_name: requester.name || null,
    platform_user_id: requester.platform_user_id || null,
    conversation_ref: conversationRef,
    ref: conversationRef,
    summary: typeof record?.summary === "string" && record.summary.trim() ? record.summary.trim() : "(no summary)",
    status: normalizeWorkThreadStatus(record?.status),
    contract_type: contractType,
    completion_condition: record?.completion_condition === "best_effort_by_timebound"
      ? "best_effort_by_timebound"
      : defaultCompletion,
    timebound_duration_hours: clampPositiveNumber(record?.timebound_duration_hours),
    timebound_until_at: normalizeIsoDate(record?.timebound_until_at),
    result: record?.result ?? null,
    note: record?.note ?? null,
    error: record?.error ?? null,
    superseded_by: record?.superseded_by ?? null,
    next_session: record?.next_session ?? null,
    created_at: createdAt,
    updated_at: updatedAt,
    last_user_signal_at: normalizeIsoDate(record?.last_user_signal_at)
      || (requester.type === "contact" ? updatedAt : null),
    last_upsert_idempotency_key: record?.last_upsert_idempotency_key || null,
  };
}

export function serializeWorkThread(thread, existing = null) {
  const normalized = normalizeWorkThread({ ...(existing || {}), ...thread }, existing?.key || thread?.key);
  const requester = normalized.requester;
  return {
    ...(existing || {}),
    id: normalized.id,
    source: requester.type,
    requester,
    contact: requester.type === "contact" ? requester.id : null,
    contact_name: requester.name || null,
    platform_user_id: requester.platform_user_id || null,
    summary: normalized.summary,
    status: normalized.status,
    contract_type: normalized.contract_type,
    completion_condition: normalized.completion_condition,
    timebound_duration_hours: normalized.timebound_duration_hours,
    timebound_until_at: normalized.timebound_until_at,
    conversation_ref: normalized.conversation_ref,
    ref: normalized.conversation_ref,
    result: normalized.result ?? null,
    note: normalized.note ?? null,
    error: normalized.error ?? null,
    superseded_by: normalized.superseded_by ?? null,
    next_session: normalized.next_session ?? null,
    created_at: normalized.created_at,
    updated_at: normalized.updated_at,
    last_user_signal_at: normalized.last_user_signal_at ?? null,
    last_upsert_idempotency_key: normalized.last_upsert_idempotency_key || null,
  };
}

export function resolveRequestContact(thread) {
  const normalized = normalizeWorkThread(thread);
  return normalized.requester?.type === "contact" ? normalized.requester.id : null;
}

function canFulfillEarly(thread, patch) {
  return Boolean(patch?.allow_early_completion);
}

export function validateWorkThreadTransition(existing, patch, now = Date.now()) {
  const current = normalizeWorkThread(existing);
  const nextStatus = patch?.status ? normalizeWorkThreadStatus(patch.status) : current.status;

  if (!WORK_THREAD_STATUSES.has(nextStatus)) {
    return { ok: false, error: `invalid_status:${nextStatus}` };
  }

  if (current.status === "fulfilled" || current.status === "rejected" || current.status === "superseded") {
    if (nextStatus !== current.status) {
      return { ok: false, error: `thread_closed:${current.status}` };
    }
    return { ok: true, status: nextStatus };
  }

  if (current.status === "expired" && nextStatus !== "expired") {
    const explicitReopen = patch?.intent === "reopen" || patch?.reopen === true;
    const hasNewBound = clampPositiveNumber(patch?.timebound_duration_hours)
      || normalizeIsoDate(patch?.timebound_until_at);
    if (!(nextStatus === "active" && explicitReopen && hasNewBound)) {
      return { ok: false, error: "expired_requires_explicit_reopen" };
    }
  }

  const merged = normalizeWorkThread({
    ...current,
    ...patch,
    status: nextStatus,
  });

  if (merged.contract_type === "timebound") {
    const hasDuration = clampPositiveNumber(merged.timebound_duration_hours);
    const hasUntil = normalizeIsoDate(merged.timebound_until_at);
    if (hasDuration && hasUntil) {
      return { ok: false, error: "timebound_requires_exactly_one_bound" };
    }
    if (!hasDuration && !hasUntil) {
      return { ok: false, error: "timebound_requires_bound" };
    }
  }

  if (nextStatus === "fulfilled"
    && merged.contract_type === "timebound"
    && merged.completion_condition === "best_effort_by_timebound"
    && !canFulfillEarly(current, patch)
    && !isTimeboundElapsed(merged, now)) {
    return { ok: false, error: "best_effort_timebound_not_yet_elapsed" };
  }

  if (nextStatus === "expired" && !isTimeboundElapsed(merged, now)) {
    return { ok: false, error: "timebound_not_elapsed" };
  }

  return { ok: true, status: nextStatus };
}

async function adapterGet(store, key) {
  if (typeof store?.kvGet === "function") return store.kvGet(key);
  if (typeof store?.get === "function") return store.get(key);
  throw new Error("Store does not support get/kvGet");
}

async function adapterPut(store, key, value) {
  if (typeof store?.kvWriteSafe === "function") return store.kvWriteSafe(key, value, { unprotected: true });
  if (typeof store?.put === "function") return store.put(key, value);
  throw new Error("Store does not support put/kvWriteSafe");
}

async function adapterDelete(store, key) {
  if (typeof store?.kvDeleteSafe === "function") return store.kvDeleteSafe(key);
  if (typeof store?.delete === "function") return store.delete(key);
  return null;
}

async function adapterList(store, prefix, limit) {
  if (typeof store?.kvList === "function") return store.kvList({ prefix, limit });
  if (typeof store?.list === "function") return store.list({ prefix, limit });
  return { keys: [] };
}

export async function listWorkThreads(store) {
  const list = await adapterList(store, WORK_THREAD_KEY_PREFIX);
  const threads = [];
  for (const entry of list.keys || []) {
    const record = await adapterGet(store, entry.name);
    if (!record) continue;
    threads.push(normalizeWorkThread(record, entry.name));
  }
  return threads;
}

export async function loadConversationWorkThreads(store, { conversationId, contact, limit = 20 } = {}) {
  const threads = await listWorkThreads(store);
  const contactId = contact?.id || contact || null;
  const filtered = threads.filter((thread) => {
    const matchesConversation = conversationId && thread.conversation_ref === conversationId;
    const matchesContact = contactId && resolveRequestContact(thread) === contactId;
    return matchesConversation || matchesContact;
  });
  filtered.sort((a, b) =>
    new Date(b.updated_at || b.created_at || 0).getTime()
    - new Date(a.updated_at || a.created_at || 0).getTime(),
  );
  return filtered.slice(0, limit);
}

function plannerStatusRank(status) {
  return ({ active: 0, blocked: 1, stale: 2 }[status] ?? 9);
}

export async function loadPlannerWorkThreads(store, defaults, events = []) {
  const scheduleIntervalMs = (defaults?.schedule?.interval_seconds || 21600) * 1000;
  const now = Date.now();
  const staleAfterMs = Math.max(60 * 60 * 1000, scheduleIntervalMs);
  const referencedKeys = new Set(
    (events || [])
      .filter((event) => event?.ref?.startsWith(WORK_THREAD_KEY_PREFIX))
      .map((event) => event.ref),
  );

  const threads = (await listWorkThreads(store))
    .filter((thread) => isOpenWorkThreadStatus(thread.status))
    .map((thread) => {
      const updatedMs = thread.updated_at ? new Date(thread.updated_at).getTime() : 0;
      const ageMs = updatedMs ? Math.max(0, now - updatedMs) : null;
      return {
        ...thread,
        from_event: referencedKeys.has(thread.key),
        stale: thread.status === "stale" || (ageMs !== null ? ageMs >= staleAfterMs : false),
        age_hours: ageMs !== null ? Number((ageMs / 3_600_000).toFixed(1)) : null,
      };
    });

  threads.sort((a, b) => {
    if (a.from_event !== b.from_event) return a.from_event ? -1 : 1;
    const rankDiff = plannerStatusRank(a.status) - plannerStatusRank(b.status);
    if (rankDiff !== 0) return rankDiff;
    return new Date(a.updated_at || a.created_at || 0).getTime()
      - new Date(b.updated_at || b.created_at || 0).getTime();
  });

  return threads.slice(0, 5);
}

export async function acquireWorkThreadScopeLease(store, { conversationRef, requesterId, ownerToken, ttlMs = 15000 }) {
  const scope = deriveWorkThreadScope({ conversationRef, requesterId });
  const key = `${WORK_THREAD_LEASE_PREFIX}${sanitizeScope(scope)}`;
  const now = Date.now();
  const existing = await adapterGet(store, key);
  if (existing?.owner_token && existing?.lease_expires && existing.lease_expires > now && existing.owner_token !== ownerToken) {
    return { ok: false, lease_key: key, scope, owner_token: existing.owner_token };
  }
  const lease = {
    scope,
    owner_token: ownerToken,
    lease_expires: now + ttlMs,
    acquired_at: now,
  };
  await adapterPut(store, key, lease);
  const verify = await adapterGet(store, key);
  if (!verify || verify.owner_token !== ownerToken) {
    return { ok: false, lease_key: key, scope, owner_token: verify?.owner_token || null };
  }
  return { ok: true, lease_key: key, scope, owner_token: ownerToken };
}

export async function releaseWorkThreadScopeLease(store, leaseKey, ownerToken) {
  if (!leaseKey) return;
  const existing = await adapterGet(store, leaseKey);
  if (existing?.owner_token && existing.owner_token !== ownerToken) return;
  await adapterDelete(store, leaseKey);
}

export async function applyWorkThreadUpdate({
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
  if (!requestKey || !existing) {
    return { ok: false, error: "requestKey and existing request are required" };
  }

  const validation = validateWorkThreadTransition(existing, {
    status,
    contract_type,
    completion_condition,
    timebound_duration_hours,
    timebound_until_at,
    allow_early_completion,
    intent,
  });
  if (!validation.ok) return validation;

  const normalized = normalizeWorkThread(existing, requestKey);
  const updated = serializeWorkThread({
    ...normalized,
    status: validation.status,
    contract_type: contract_type || normalized.contract_type,
    completion_condition: completion_condition || normalized.completion_condition,
    timebound_duration_hours: timebound_duration_hours ?? normalized.timebound_duration_hours,
    timebound_until_at: timebound_until_at ?? normalized.timebound_until_at,
    superseded_by: superseded_by ?? normalized.superseded_by,
    updated_at: nowIso(),
    ...(note !== undefined ? { note } : {}),
    ...(result !== undefined ? { result } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(next_session !== undefined ? { next_session } : {}),
  }, existing);

  await adapterPut(kv, requestKey, updated);
  const contact = resolveRequestContact(updated);
  if (emitEvent) {
    await emitEvent("session_response", {
      contact,
      requester: updated.requester || null,
      ref: requestKey,
      status: updated.status,
    });
  }

  return {
    ok: true,
    request_id: updated.id,
    status: updated.status,
    request: normalizeWorkThread(updated, requestKey),
  };
}

function buildRequester(requester) {
  if (!requester || typeof requester !== "object") return { type: "self", id: "self" };
  if (requester.type === "self") return { type: "self", id: requester.id || "self" };
  return {
    type: "contact",
    id: requester.id || "unknown_contact",
    ...(requester.name ? { name: requester.name } : {}),
    ...(requester.platform_user_id ? { platform_user_id: requester.platform_user_id } : {}),
  };
}

export async function upsertWorkThread(store, {
  requester,
  conversation_ref,
  summary,
  request_id,
  intent = "auto",
  contract_type,
  completion_condition,
  timebound_duration_hours,
  timebound_until_at,
  idempotency_key,
  allow_early_completion,
} = {}) {
  const normalizedRequester = buildRequester(requester);
  const conversationRef = typeof conversation_ref === "string" && conversation_ref.trim() ? conversation_ref.trim() : null;
  const ownerToken = idempotency_key || `${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

  const lease = await acquireWorkThreadScopeLease(store, {
    conversationRef,
    requesterId: normalizedRequester.id,
    ownerToken,
  });
  if (!lease.ok) {
    return { ok: false, error: "scope_locked", scope: lease.scope };
  }

  try {
    const threads = await listWorkThreads(store);
    const scope = deriveWorkThreadScope({ conversationRef, requesterId: normalizedRequester.id });
    const scopeThreads = threads.filter((thread) =>
      deriveWorkThreadScope({
        conversationRef: thread.conversation_ref,
        requesterId: thread.requester?.id,
      }) === scope,
    );

    const idempotentMatch = idempotency_key
      ? scopeThreads.find((thread) => thread.last_upsert_idempotency_key === idempotency_key)
      : null;
    if (idempotentMatch) {
      return { ok: true, request_id: idempotentMatch.id, request: idempotentMatch, created: false, idempotent: true };
    }

    const openThreads = scopeThreads.filter((thread) => isOpenWorkThreadStatus(thread.status));
    const byId = new Map(scopeThreads.map((thread) => [thread.id, thread]));
    const expiredThreads = scopeThreads.filter((thread) => thread.status === "expired");

    if (request_id) {
      const target = byId.get(request_id);
      if (!target) return { ok: false, error: `unknown_request:${request_id}` };
      const reopen = target.status === "expired" && intent === "reopen";
      const outcome = await applyWorkThreadUpdate({
        requestKey: target.key,
        existing: target,
        status: reopen ? "active" : target.status,
        contract_type,
        completion_condition,
        timebound_duration_hours,
        timebound_until_at,
        allow_early_completion,
        intent,
        kv: store,
        emitEvent: null,
      });
      if (!outcome.ok) return outcome;
      const persisted = serializeWorkThread({
        ...outcome.request,
        summary: summary || outcome.request.summary,
        last_user_signal_at: normalizedRequester.type === "contact" ? nowIso() : outcome.request.last_user_signal_at,
        last_upsert_idempotency_key: idempotency_key || outcome.request.last_upsert_idempotency_key,
      }, target);
      await adapterPut(store, target.key, persisted);
      return { ok: true, request_id: persisted.id, request: normalizeWorkThread(persisted, target.key), created: false };
    }

    if (intent === "new_parallel") {
      const id = `req_${Date.now()}`;
      const createdAt = nowIso();
      const thread = serializeWorkThread({
        id,
        requester: normalizedRequester,
        summary: summary || "(no summary)",
        status: "active",
        contract_type: contract_type || (timebound_duration_hours || timebound_until_at ? "timebound" : "one_shot"),
        completion_condition: completion_condition
          || ((timebound_duration_hours || timebound_until_at) ? "best_effort_by_timebound" : "deliver_requested_output"),
        timebound_duration_hours,
        timebound_until_at,
        created_at: createdAt,
        updated_at: createdAt,
        last_user_signal_at: normalizedRequester.type === "contact" ? createdAt : null,
        conversation_ref: conversationRef,
        last_upsert_idempotency_key: idempotency_key || null,
      });
      const key = `${WORK_THREAD_KEY_PREFIX}${id}`;
      await adapterPut(store, key, thread);
      return { ok: true, request_id: id, request: normalizeWorkThread(thread, key), created: true };
    }

    if (intent === "continue") {
      if (openThreads.length === 0) {
        return { ok: false, error: "no_open_threads" };
      }
      if (openThreads.length > 1) {
        return {
          ok: false,
          error: "ambiguous_open_threads",
          candidates: openThreads.map((thread) => ({
            id: thread.id,
            summary: thread.summary,
            status: thread.status,
            updated_at: thread.updated_at,
          })),
        };
      }
      const target = openThreads[0];
      const persisted = serializeWorkThread({
        ...target,
        summary: summary || target.summary,
        updated_at: nowIso(),
        last_user_signal_at: normalizedRequester.type === "contact" ? nowIso() : target.last_user_signal_at,
        last_upsert_idempotency_key: idempotency_key || target.last_upsert_idempotency_key,
      }, target);
      await adapterPut(store, target.key, persisted);
      return { ok: true, request_id: target.id, request: normalizeWorkThread(persisted, target.key), created: false };
    }

    if (intent === "reopen") {
      if (expiredThreads.length === 0) {
        return { ok: false, error: "no_expired_threads" };
      }
      if (expiredThreads.length > 1) {
        return {
          ok: false,
          error: "ambiguous_expired_threads",
          candidates: expiredThreads.map((thread) => ({
            id: thread.id,
            summary: thread.summary,
            status: thread.status,
            updated_at: thread.updated_at,
          })),
        };
      }
      const target = expiredThreads[0];
      const outcome = await applyWorkThreadUpdate({
        requestKey: target.key,
        existing: target,
        status: "active",
        contract_type,
        completion_condition,
        timebound_duration_hours,
        timebound_until_at,
        allow_early_completion,
        intent: "reopen",
        kv: store,
        emitEvent: null,
      });
      if (!outcome.ok) return outcome;
      const persisted = serializeWorkThread({
        ...outcome.request,
        summary: summary || outcome.request.summary,
        updated_at: nowIso(),
        last_user_signal_at: normalizedRequester.type === "contact" ? nowIso() : outcome.request.last_user_signal_at,
        last_upsert_idempotency_key: idempotency_key || outcome.request.last_upsert_idempotency_key,
      }, target);
      await adapterPut(store, target.key, persisted);
      return { ok: true, request_id: target.id, request: normalizeWorkThread(persisted, target.key), created: false };
    }

    if (openThreads.length === 0) {
      const id = `req_${Date.now()}`;
      const createdAt = nowIso();
      const thread = serializeWorkThread({
        id,
        requester: normalizedRequester,
        summary: summary || "(no summary)",
        status: "active",
        contract_type: contract_type || (timebound_duration_hours || timebound_until_at ? "timebound" : "one_shot"),
        completion_condition: completion_condition
          || ((timebound_duration_hours || timebound_until_at) ? "best_effort_by_timebound" : "deliver_requested_output"),
        timebound_duration_hours,
        timebound_until_at,
        created_at: createdAt,
        updated_at: createdAt,
        last_user_signal_at: normalizedRequester.type === "contact" ? createdAt : null,
        conversation_ref: conversationRef,
        last_upsert_idempotency_key: idempotency_key || null,
      });
      const key = `${WORK_THREAD_KEY_PREFIX}${id}`;
      await adapterPut(store, key, thread);
      return { ok: true, request_id: id, request: normalizeWorkThread(thread, key), created: true };
    }

    if (intent === "auto") {
      return {
        ok: false,
        error: "ambiguous_open_threads",
        candidates: openThreads.map((thread) => ({
          id: thread.id,
          summary: thread.summary,
          status: thread.status,
          updated_at: thread.updated_at,
        })),
      };
    }

    return {
      ok: false,
      error: "ambiguous_open_threads",
      candidates: openThreads.map((thread) => ({
        id: thread.id,
        summary: thread.summary,
        status: thread.status,
        updated_at: thread.updated_at,
      })),
    };
  } finally {
    await releaseWorkThreadScopeLease(store, lease.lease_key, ownerToken).catch(() => {});
  }
}

export async function reconcileWorkThreadLifecycle(store, {
  defaults = {},
  activeRequestIds = new Set(),
  scope = null,
  now = Date.now(),
} = {}) {
  const threads = await listWorkThreads(store);
  const targetThreads = scope
    ? threads.filter((thread) => deriveWorkThreadScope({
      conversationRef: thread.conversation_ref,
      requesterId: thread.requester?.id,
    }) === scope)
    : threads;

  const scheduleIntervalMs = (defaults?.schedule?.interval_seconds || 21600) * 1000;
  const staleMs = Math.max(24 * 3600_000, scheduleIntervalMs * 2);
  const changed = [];

  for (const thread of targetThreads) {
    if (!isOpenWorkThreadStatus(thread.status)) continue;
    const patch = {};

    if (thread.contract_type === "timebound" && isTimeboundElapsed(thread, now)) {
      if (thread.result != null && thread.result !== "") {
        patch.status = "fulfilled";
      } else {
        patch.status = "expired";
      }
    } else if (thread.contract_type !== "timebound") {
      const lastSignalMs = thread.last_user_signal_at ? new Date(thread.last_user_signal_at).getTime() : 0;
      const updatedMs = thread.updated_at ? new Date(thread.updated_at).getTime() : 0;
      const lastTouchMs = Math.max(lastSignalMs || 0, updatedMs || 0);
      if (!activeRequestIds.has(thread.id) && lastTouchMs > 0 && (now - lastTouchMs) >= staleMs) {
        patch.status = "stale";
      }
    }

    if (!patch.status || patch.status === thread.status) continue;
    const validation = validateWorkThreadTransition(thread, patch, now);
    if (!validation.ok) continue;
    const updated = serializeWorkThread({
      ...thread,
      status: validation.status,
      updated_at: nowIso(),
    }, thread);
    await adapterPut(store, thread.key, updated);
    changed.push({ id: thread.id, from: thread.status, to: validation.status });
  }

  return changed;
}
