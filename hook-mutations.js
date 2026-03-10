// Swayambhu Wake Hook — Mutation Protocol
// Staging, candidate management, circuit breaker, verdict processing.
// KV key: hook:wake:mutations

// ── Mutation tracking (hook-local state) ───────────────────

let activeStaged = [];
let activeCandidates = [];

export function initTracking(staged, candidates) {
  activeStaged = staged;
  activeCandidates = candidates;
}

function _trackAdd(list, id) {
  const arr = list === 'activeStaged' ? activeStaged : activeCandidates;
  if (!arr.includes(id)) arr.push(id);
}

function _trackRemove(list, id) {
  if (list === 'activeStaged') {
    activeStaged = activeStaged.filter(x => x !== id);
  } else {
    activeCandidates = activeCandidates.filter(x => x !== id);
  }
}

function generateMutationId() {
  return `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── Predicate evaluation ────────────────────────────────────

export function evaluatePredicate(value, predicate, expected) {
  switch (predicate) {
    case "exists": return value !== null && value !== undefined;
    case "equals": return value === expected;
    case "gt": return typeof value === "number" && value > expected;
    case "lt": return typeof value === "number" && value < expected;
    case "matches": return typeof value === "string" && new RegExp(expected).test(value);
    case "type": return typeof value === expected;
    default: return false;
  }
}

export async function evaluateCheck(K, check) {
  try {
    switch (check.type) {
      case "kv_assert": {
        let value = await K.kvGet(check.key);
        if (check.path && value != null) {
          value = check.path.split(".").reduce((o, k) => o?.[k], value);
        }
        const passed = evaluatePredicate(value, check.predicate, check.expected);
        return { passed, detail: `${check.key}${check.path ? '.' + check.path : ''} ${check.predicate} ${JSON.stringify(check.expected)} \u2192 actual: ${JSON.stringify(value)}` };
      }
      case "tool_call": {
        const result = await K.executeAction({
          tool: check.tool,
          input: check.input || {},
          id: `check_${check.tool}`,
        });
        if (check.assert) {
          const passed = evaluatePredicate(result, check.assert.predicate, check.assert.expected);
          return { passed, detail: `${check.tool} result ${check.assert.predicate} ${JSON.stringify(check.assert.expected)} \u2192 actual: ${JSON.stringify(result)}` };
        }
        return { passed: true, detail: `${check.tool} executed successfully` };
      }
      default:
        return { passed: false, detail: `unknown check type: ${check.type}` };
    }
  } catch (err) {
    return { passed: false, detail: `check error: ${err.message}` };
  }
}

export async function evaluateChecks(K, checks) {
  const results = [];
  for (const check of checks) {
    results.push(await evaluateCheck(K, check));
  }
  return {
    all_passed: results.every(r => r.passed),
    results,
  };
}

// ── Staging ─────────────────────────────────────────────────

export async function stageMutation(K, request, sessionId) {
  if (!request.claims?.length || !request.ops?.length || !request.checks?.length) {
    await K.karmaRecord({ event: "mutation_invalid", reason: "missing required fields (claims, ops, checks)" });
    return null;
  }
  const id = generateMutationId();
  await K.kvWritePrivileged([{
    op: "put",
    key: `mutation_staged:${id}`,
    value: {
      id,
      claims: request.claims,
      ops: request.ops,
      checks: request.checks,
      staged_at: new Date().toISOString(),
      staged_by_session: sessionId,
    },
  }]);
  _trackAdd('activeStaged', id);
  await K.karmaRecord({ event: "mutation_staged", mutation_id: id, claims: request.claims });
  return id;
}

// ── Candidate management ────────────────────────────────────

function buildWriteOps(ops) {
  return ops.map(op => {
    if (op.op === "patch") {
      return { op: "patch", key: op.key, old_string: op.old_string, new_string: op.new_string };
    }
    return { op: op.op || "put", key: op.key, value: op.value, metadata: op.metadata };
  });
}

export async function applyStagedAsCandidate(K, mutationId) {
  const record = await K.kvGet(`mutation_staged:${mutationId}`);
  if (!record) throw new Error(`No staged mutation: ${mutationId}`);

  const targetKeys = record.ops.map(op => op.key);
  const conflict = await findCandidateConflict(K, targetKeys);
  if (conflict) {
    await K.karmaRecord({ event: "mutation_conflict", mutation_id: mutationId, conflicting_mutation: conflict.id, overlapping_keys: conflict.keys });
    throw new Error(`Conflict with candidate ${conflict.id} on keys: ${conflict.keys.join(", ")}`);
  }

  // Snapshot current values before applying
  const snapshots = {};
  for (const key of targetKeys) {
    const { value, metadata } = await K.kvGetWithMeta(key);
    snapshots[key] = { value: value !== null ? value : null, metadata };
  }

  // Apply ops via privileged writes
  const writeOps = buildWriteOps(record.ops);
  await K.kvWritePrivileged(writeOps);

  // Write candidate record
  await K.kvWritePrivileged([{
    op: "put",
    key: `mutation_candidate:${mutationId}`,
    value: {
      ...record,
      snapshots,
      activated_at: new Date().toISOString(),
    },
  }]);

  // Delete staged record
  await K.kvWritePrivileged([{ op: "delete", key: `mutation_staged:${mutationId}` }]);
  _trackRemove('activeStaged', mutationId);
  _trackAdd('activeCandidates', mutationId);

  // Refresh defaults if ops touch config:defaults
  if (targetKeys.some(k => k === "config:defaults")) {
    // Config auto-refreshed by kernel after privileged write
  }

  await K.karmaRecord({ event: "mutation_applied", mutation_id: mutationId, target_keys: targetKeys });
  return mutationId;
}

export async function applyDirectAsCandidate(K, request, sessionId) {
  if (!request.claims?.length || !request.ops?.length || !request.checks?.length) {
    await K.karmaRecord({ event: "mutation_invalid", reason: "missing required fields (claims, ops, checks)" });
    return null;
  }
  const id = generateMutationId();
  const targetKeys = request.ops.map(op => op.key);

  const conflict = await findCandidateConflict(K, targetKeys);
  if (conflict) {
    await K.karmaRecord({ event: "mutation_conflict", mutation_id: id, conflicting_mutation: conflict.id, overlapping_keys: conflict.keys });
    return null;
  }

  const snapshots = {};
  for (const key of targetKeys) {
    const { value, metadata } = await K.kvGetWithMeta(key);
    snapshots[key] = { value: value !== null ? value : null, metadata };
  }

  // Apply ops via privileged writes
  const writeOps = buildWriteOps(request.ops);
  await K.kvWritePrivileged(writeOps);

  // Write candidate record
  await K.kvWritePrivileged([{
    op: "put",
    key: `mutation_candidate:${id}`,
    value: {
      id,
      claims: request.claims,
      ops: request.ops,
      checks: request.checks,
      snapshots,
      staged_by_session: sessionId,
      activated_at: new Date().toISOString(),
    },
  }]);
  _trackAdd('activeCandidates', id);

  await K.karmaRecord({ event: "mutation_applied", mutation_id: id, target_keys: targetKeys });
  return id;
}

export async function promoteCandidate(K, mutationId) {
  await K.kvWritePrivileged([{ op: "delete", key: `mutation_candidate:${mutationId}` }]);
  _trackRemove('activeCandidates', mutationId);
  await K.karmaRecord({ event: "mutation_promoted", mutation_id: mutationId });
}

export async function rollbackCandidate(K, mutationId, reason) {
  const record = await K.kvGet(`mutation_candidate:${mutationId}`);
  if (!record) return;

  // Restore snapshotted values via privileged writes
  const restoreOps = [];
  for (const [key, snapshot] of Object.entries(record.snapshots || {})) {
    if (snapshot.value === null) {
      restoreOps.push({ op: "delete", key });
    } else {
      restoreOps.push({ op: "put", key, value: snapshot.value, metadata: snapshot.metadata || {} });
    }
  }
  if (restoreOps.length) await K.kvWritePrivileged(restoreOps);

  await K.kvWritePrivileged([{ op: "delete", key: `mutation_candidate:${mutationId}` }]);
  _trackRemove('activeCandidates', mutationId);
  await K.karmaRecord({ event: "mutation_rolled_back", mutation_id: mutationId, reason });
}

export async function findCandidateConflict(K, targetKeys) {
  for (const id of activeCandidates) {
    const record = await K.kvGet(`mutation_candidate:${id}`);
    if (!record?.snapshots) continue;
    const overlap = targetKeys.filter(k => k in record.snapshots);
    if (overlap.length > 0) return { id: record.id, keys: overlap };
  }
  return null;
}

// ── Loading ─────────────────────────────────────────────────

export async function loadStagedMutations(K) {
  const result = {};
  for (const id of activeStaged) {
    const record = await K.kvGet(`mutation_staged:${id}`);
    if (!record) continue;
    const checkResults = await evaluateChecks(K, record.checks || []);
    result[record.id] = { record, check_results: checkResults };
  }
  return result;
}

export async function loadCandidateMutations(K) {
  const result = {};
  for (const id of activeCandidates) {
    const record = await K.kvGet(`mutation_candidate:${id}`);
    if (!record) continue;
    const checkResults = await evaluateChecks(K, record.checks || []);
    result[record.id] = { record, check_results: checkResults };
  }
  return result;
}

// ── Verdict processing ──────────────────────────────────────

export async function processReflectVerdicts(K, verdicts) {
  for (const v of verdicts || []) {
    switch (v.verdict) {
      case "withdraw":
        await K.kvWritePrivileged([{ op: "delete", key: `mutation_staged:${v.mutation_id}` }]);
        _trackRemove('activeStaged', v.mutation_id);
        await K.karmaRecord({ event: "mutation_withdrawn", mutation_id: v.mutation_id });
        break;
      case "modify": {
        const record = await K.kvGet(`mutation_staged:${v.mutation_id}`);
        if (record) {
          await K.kvWritePrivileged([{
            op: "put",
            key: `mutation_staged:${v.mutation_id}`,
            value: {
              ...record,
              ...(v.updated_ops ? { ops: v.updated_ops } : {}),
              ...(v.updated_checks ? { checks: v.updated_checks } : {}),
              ...(v.updated_claims ? { claims: v.updated_claims } : {}),
              modified_at: new Date().toISOString(),
            },
          }]);
          await K.karmaRecord({ event: "mutation_modified", mutation_id: v.mutation_id });
        }
        break;
      }
    }
  }
}

export async function processDeepReflectVerdicts(K, verdicts) {
  for (const v of verdicts || []) {
    switch (v.verdict) {
      case "apply":
        try { await applyStagedAsCandidate(K, v.mutation_id); }
        catch (err) { await K.karmaRecord({ event: "mutation_apply_failed", mutation_id: v.mutation_id, error: err.message }); }
        break;
      case "reject":
        await K.kvWritePrivileged([{ op: "delete", key: `mutation_staged:${v.mutation_id}` }]);
        _trackRemove('activeStaged', v.mutation_id);
        await K.karmaRecord({ event: "mutation_rejected", mutation_id: v.mutation_id, reason: v.reason });
        break;
      case "withdraw":
        await K.kvWritePrivileged([{ op: "delete", key: `mutation_staged:${v.mutation_id}` }]);
        _trackRemove('activeStaged', v.mutation_id);
        await K.karmaRecord({ event: "mutation_withdrawn", mutation_id: v.mutation_id });
        break;
      case "modify": {
        const record = await K.kvGet(`mutation_staged:${v.mutation_id}`);
        if (record) {
          await K.kvWritePrivileged([{
            op: "put",
            key: `mutation_staged:${v.mutation_id}`,
            value: {
              ...record,
              ...(v.updated_ops ? { ops: v.updated_ops } : {}),
              ...(v.updated_checks ? { checks: v.updated_checks } : {}),
              ...(v.updated_claims ? { claims: v.updated_claims } : {}),
              modified_at: new Date().toISOString(),
            },
          }]);
          await K.karmaRecord({ event: "mutation_modified", mutation_id: v.mutation_id });
        }
        break;
      }
      case "promote":
        await promoteCandidate(K, v.mutation_id);
        break;
      case "rollback":
        await rollbackCandidate(K, v.mutation_id, v.reason || "deep_reflect_verdict");
        break;
      case "defer":
        await K.karmaRecord({ event: "mutation_deferred", mutation_id: v.mutation_id, reason: v.reason });
        break;
    }
  }
}

// ── Circuit breaker ────────────────────────────────────────

export async function runCircuitBreaker(K) {
  const lastDanger = await K.kvGet("last_danger");
  if (!lastDanger) return;

  for (const id of [...activeCandidates]) {
    const record = await K.kvGet(`mutation_candidate:${id}`);
    if (!record?.activated_at) continue;

    if (lastDanger.t >= new Date(record.activated_at).getTime()) {
      await rollbackCandidate(K, record.id, "circuit_breaker");
      await K.karmaRecord({ event: "circuit_breaker_fired", mutation_id: record.id });
    }
  }

  // Clear the danger signal — it's been processed. Leaving it around
  // causes repeat rollbacks on every subsequent wake.
  await K.kvDeleteSafe("last_danger");
}
