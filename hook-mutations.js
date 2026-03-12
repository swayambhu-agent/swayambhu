// Swayambhu Wake Hook — Mutation Protocol
// Staging, inflight management, circuit breaker, verdict processing.
// KV key: hook:wake:mutations

// ── Mutation tracking (hook-local state) ───────────────────

let activeStaged = [];
let activeInflight = [];

export function initTracking(staged, inflight) {
  activeStaged = staged;
  activeInflight = inflight;
}

function _trackAdd(list, id) {
  const arr = list === 'activeStaged' ? activeStaged : activeInflight;
  if (!arr.includes(id)) arr.push(id);
}

function _trackRemove(list, id) {
  if (list === 'activeStaged') {
    activeStaged = activeStaged.filter(x => x !== id);
  } else {
    activeInflight = activeInflight.filter(x => x !== id);
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

// ── Bookkeeping guard ───────────────────────────────────────

const BOOKKEEPING_PREFIXES = ['mutation_staged:', 'mutation_rollback:'];

function opsTargetBookkeeping(ops) {
  return ops.find(op => BOOKKEEPING_PREFIXES.some(p => op.key.startsWith(p)));
}

// ── Staging ─────────────────────────────────────────────────

export async function stageMutation(K, request, sessionId) {
  if (!request.claims?.length || !request.ops?.length || !request.checks?.length) {
    await K.karmaRecord({ event: "mutation_invalid", reason: "missing required fields (claims, ops, checks)" });
    return null;
  }
  const bad = opsTargetBookkeeping(request.ops);
  if (bad) {
    await K.karmaRecord({ event: "mutation_invalid", reason: `ops target bookkeeping key: ${bad.key}` });
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

// ── Inflight management ─────────────────────────────────────

function buildWriteOps(ops) {
  return ops.map(op => {
    if (op.op === "patch") {
      return { op: "patch", key: op.key, old_string: op.old_string, new_string: op.new_string };
    }
    return { op: op.op || "put", key: op.key, value: op.value, metadata: op.metadata };
  });
}

export async function applyStaged(K, mutationId) {
  const record = await K.kvGet(`mutation_staged:${mutationId}`);
  if (!record) throw new Error(`No staged mutation: ${mutationId}`);

  const bad = opsTargetBookkeeping(record.ops);
  if (bad) {
    await K.karmaRecord({ event: "mutation_invalid", mutation_id: mutationId, reason: `ops target bookkeeping key: ${bad.key}` });
    throw new Error(`Mutation ops target bookkeeping key: ${bad.key}`);
  }

  const targetKeys = record.ops.map(op => op.key);
  const conflict = await findInflightConflict(K, targetKeys);
  if (conflict) {
    await K.karmaRecord({ event: "mutation_conflict", mutation_id: mutationId, conflicting_mutation: conflict.id, overlapping_keys: conflict.keys });
    throw new Error(`Conflict with inflight ${conflict.id} on keys: ${conflict.keys.join(", ")}`);
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

  // Write rollback record
  await K.kvWritePrivileged([{
    op: "put",
    key: `mutation_rollback:${mutationId}`,
    value: {
      ...record,
      snapshots,
      activated_at: new Date().toISOString(),
    },
  }]);

  // Delete staged record
  await K.kvWritePrivileged([{ op: "delete", key: `mutation_staged:${mutationId}` }]);
  _trackRemove('activeStaged', mutationId);
  _trackAdd('activeInflight', mutationId);

  // Refresh defaults if ops touch config:defaults
  if (targetKeys.some(k => k === "config:defaults")) {
    // Config auto-refreshed by kernel after privileged write
  }

  await K.karmaRecord({ event: "mutation_applied", mutation_id: mutationId, target_keys: targetKeys });
  return mutationId;
}

export async function applyDirect(K, request, sessionId) {
  if (!request.claims?.length || !request.ops?.length || !request.checks?.length) {
    await K.karmaRecord({ event: "mutation_invalid", reason: "missing required fields (claims, ops, checks)" });
    return null;
  }
  const bad = opsTargetBookkeeping(request.ops);
  if (bad) {
    await K.karmaRecord({ event: "mutation_invalid", reason: `ops target bookkeeping key: ${bad.key}` });
    return null;
  }
  const id = generateMutationId();
  const targetKeys = request.ops.map(op => op.key);

  const conflict = await findInflightConflict(K, targetKeys);
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

  // Write rollback record
  await K.kvWritePrivileged([{
    op: "put",
    key: `mutation_rollback:${id}`,
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
  _trackAdd('activeInflight', id);

  await K.karmaRecord({ event: "mutation_applied", mutation_id: id, target_keys: targetKeys });
  return id;
}

export async function promoteInflight(K, mutationId) {
  const record = await K.kvGet(`mutation_rollback:${mutationId}`);
  await K.kvWritePrivileged([{ op: "delete", key: `mutation_rollback:${mutationId}` }]);
  _trackRemove('activeInflight', mutationId);
  await K.karmaRecord({ event: "mutation_promoted", mutation_id: mutationId });

  // Best-effort git sync — never throws
  if (record?.ops) {
    await syncToGit(K, mutationId, record.ops, record.claims);
  }
}

export async function rollbackInflight(K, mutationId, reason) {
  const record = await K.kvGet(`mutation_rollback:${mutationId}`);
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

  await K.kvWritePrivileged([{ op: "delete", key: `mutation_rollback:${mutationId}` }]);
  _trackRemove('activeInflight', mutationId);
  await K.karmaRecord({ event: "mutation_rolled_back", mutation_id: mutationId, reason });
}

export async function findInflightConflict(K, targetKeys) {
  for (const id of activeInflight) {
    const record = await K.kvGet(`mutation_rollback:${id}`);
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

export async function loadInflightMutations(K) {
  const result = {};
  for (const id of activeInflight) {
    const record = await K.kvGet(`mutation_rollback:${id}`);
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
        try { await applyStaged(K, v.mutation_id); }
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
        await promoteInflight(K, v.mutation_id);
        break;
      case "rollback":
        await rollbackInflight(K, v.mutation_id, v.reason || "deep_reflect_verdict");
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

  for (const id of [...activeInflight]) {
    const record = await K.kvGet(`mutation_rollback:${id}`);
    if (!record?.activated_at) continue;

    if (lastDanger.t >= new Date(record.activated_at).getTime()) {
      await rollbackInflight(K, record.id, "circuit_breaker");
      await K.karmaRecord({ event: "circuit_breaker_fired", mutation_id: record.id });
    }
  }

  // Clear the danger signal — it's been processed. Leaving it around
  // causes repeat rollbacks on every subsequent wake.
  await K.kvDeleteSafe("last_danger");
}

// ── Git sync ────────────────────────────────────────────────

const GIT_REPO = '/home/swayambhu/self';

const SECRET_PATTERNS = [
  'sk-[a-zA-Z0-9]{20,}',
  'AKIA[A-Z0-9]{16}',
  '-----BEGIN (RSA |EC )?PRIVATE KEY',
  'ghp_[a-zA-Z0-9]{36}',
  'xoxb-[a-zA-Z0-9-]{50,}',
].join('|');

export function kvToPath(key) {
  if (key.startsWith('secret:')) return null;

  if (key.startsWith('prompt:')) return `prompts/${key.slice(7)}.md`;

  if (key.startsWith('tool:')) {
    const rest = key.slice(5);
    if (rest.endsWith(':code')) return `tools/${rest.slice(0, -5)}.js`;
    if (rest.endsWith(':meta')) return `tools/${rest.slice(0, -5)}.meta.json`;
    return null;
  }

  if (key.startsWith('provider:')) {
    const rest = key.slice(9);
    if (rest.endsWith(':code')) return `providers/${rest.slice(0, -5)}.js`;
    if (rest.endsWith(':meta')) return `providers/${rest.slice(0, -5)}.meta.json`;
    return null;
  }

  if (key.startsWith('hook:')) {
    const rest = key.slice(5);
    if (rest.endsWith(':manifest')) return `hooks/${rest.slice(0, -9)}.manifest.json`;
    const parts = rest.split(':');
    if (parts.length === 2) {
      return parts[1] === 'code' ? `hooks/${parts[0]}.js` : `hooks/${parts[0]}-${parts[1]}.js`;
    }
    return null;
  }

  if (key.startsWith('config:')) return `config/${key.slice(7)}.json`;

  if (key.startsWith('channel:')) {
    const rest = key.slice(8);
    if (rest.endsWith(':code')) return `channels/${rest.slice(0, -5)}.js`;
    if (rest.endsWith(':config')) return `channels/${rest.slice(0, -7)}.config.json`;
    return null;
  }

  if (key.startsWith('doc:')) return `docs/${key.slice(4)}.md`;

  if (key === 'wisdom') return 'wisdom.md';
  if (key === 'providers') return 'config/providers.json';
  if (key === 'wallets') return 'config/wallets.json';

  return null;
}

function formatForFile(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export async function syncToGit(K, mutationId, ops, claims) {
  try {
    const writes = [];
    const deletes = [];

    for (const op of ops) {
      const path = kvToPath(op.key);
      if (!path) continue;
      if (op.op === 'delete') {
        deletes.push(path);
        continue;
      }
      const value = await K.kvGet(op.key);
      if (value == null) continue;
      writes.push({ path, content: formatForFile(value) });
    }

    if (writes.length === 0 && deletes.length === 0) return;

    const message = `mutation promoted: ${mutationId}` +
      (claims?.length ? ` — ${claims.join('; ')}` : '');

    const pending = {
      mutation_id: mutationId,
      writes,
      deletes,
      message,
      created_at: new Date().toISOString(),
    };

    await K.kvWritePrivileged([{
      op: 'put',
      key: `git_pending:${mutationId}`,
      value: pending,
    }]);

    await attemptGitSync(K, mutationId, pending);
  } catch (err) {
    await K.karmaRecord({ event: 'git_sync_error', mutation_id: mutationId, error: err.message });
  }
}

export async function attemptGitSync(K, mutationId, pending) {
  try {
    const dirs = new Set();
    for (const w of pending.writes) {
      const dir = w.path.split('/').slice(0, -1).join('/');
      if (dir) dirs.add(dir);
    }

    const lines = ['set -e', `cd ${GIT_REPO}`];

    if (dirs.size > 0) lines.push(`mkdir -p ${[...dirs].join(' ')}`);

    // Write files via base64 to avoid shell escaping issues
    for (const w of pending.writes) {
      lines.push(`printf '%s' '${toBase64(w.content)}' | base64 -d > '${w.path}'`);
    }

    // Delete files
    for (const d of pending.deletes) {
      lines.push(`rm -f '${d}'`);
    }

    // Secret scan on written files
    const writePaths = pending.writes.map(w => `'${w.path}'`);
    if (writePaths.length > 0) {
      lines.push(
        `if grep -rlE '${SECRET_PATTERNS}' ${writePaths.join(' ')} 2>/dev/null; then` +
        ` echo "SECRET_DETECTED"; git checkout -- .; exit 1; fi`
      );
    }

    // Stage, commit, push
    const allPaths = [...pending.writes.map(w => w.path), ...pending.deletes];
    lines.push(`git add ${allPaths.map(p => `'${p}'`).join(' ')}`);
    // --allow-empty handles case where file content unchanged
    lines.push(`git diff --cached --quiet && echo "NO_CHANGES" && exit 0`);
    lines.push(`git commit -m '${pending.message.replace(/'/g, "'\\''")}'`);
    lines.push(`git push`);

    const script = lines.join('\n');

    const result = await K.executeAction({
      tool: 'akash_exec',
      input: { command: script, timeout: 30 },
      id: `git_sync_${mutationId}`,
    });

    if (result?.ok && (result?.exit_code === 0 || result?.output?.includes('NO_CHANGES'))) {
      await K.kvWritePrivileged([{ op: 'delete', key: `git_pending:${mutationId}` }]);
      await K.karmaRecord({
        event: 'git_sync_ok',
        mutation_id: mutationId,
        files: allPaths,
      });
    } else {
      await K.karmaRecord({
        event: 'git_sync_failed',
        mutation_id: mutationId,
        error: result?.output?.slice(0, 500) || 'unknown',
      });
    }
  } catch (err) {
    await K.karmaRecord({ event: 'git_sync_error', mutation_id: mutationId, error: err.message });
  }
}

export async function retryPendingGitSyncs(K) {
  const list = await K.kvList({ prefix: 'git_pending:', limit: 50 });
  for (const { name } of list.keys) {
    const pending = await K.kvGet(name);
    if (!pending) continue;
    const mutationId = name.slice('git_pending:'.length);
    await attemptGitSync(K, mutationId, pending);
  }
}
