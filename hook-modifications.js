// Swayambhu Wake Hook — Modification Protocol
// Staging, inflight management, circuit breaker, verdict processing.
// KV key: hook:wake:modifications

// ── Modification tracking (hook-local state) ───────────────────

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

function generateModificationId() {
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
        return { passed, detail: `${check.key}${check.path ? '.' + check.path : ''} ${check.predicate} ${JSON.stringify(check.expected)} → actual: ${JSON.stringify(value)}` };
      }
      case "tool_call": {
        const result = await K.executeAction({
          tool: check.tool,
          input: check.input || {},
          id: `check_${check.tool}`,
        });
        if (check.assert) {
          const passed = evaluatePredicate(result, check.assert.predicate, check.assert.expected);
          return { passed, detail: `${check.tool} result ${check.assert.predicate} ${JSON.stringify(check.assert.expected)} → actual: ${JSON.stringify(result)}` };
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

const BOOKKEEPING_PREFIXES = ['modification_staged:', 'modification_snapshot:'];

function opsTargetBookkeeping(ops) {
  return ops.find(op => BOOKKEEPING_PREFIXES.some(p => op.key.startsWith(p)));
}

// ── Staging ─────────────────────────────────────────────────

export async function stageModification(K, request, sessionId, depth = 0) {
  const type = request.type || 'code';

  // Wisdom can only be staged by deep reflect (depth >= 1)
  if (type === 'wisdom' && depth < 1) {
    await K.karmaRecord({ event: "modification_invalid", reason: "wisdom can only be staged by deep reflect" });
    return null;
  }

  // Validate required fields based on type
  if (type === 'code') {
    if (!request.claims?.length || !request.ops?.length || !request.checks?.length) {
      await K.karmaRecord({ event: "modification_invalid", reason: "missing required fields (claims, ops, checks)" });
      return null;
    }
  } else if (type === 'wisdom') {
    if (!request.validation || !request.ops?.length) {
      await K.karmaRecord({ event: "modification_invalid", reason: "missing required fields (validation, ops)" });
      return null;
    }
  } else {
    if (!request.claims?.length || !request.ops?.length || !request.checks?.length) {
      await K.karmaRecord({ event: "modification_invalid", reason: "missing required fields (claims, ops, checks)" });
      return null;
    }
  }

  const bad = opsTargetBookkeeping(request.ops);
  if (bad) {
    await K.karmaRecord({ event: "modification_invalid", reason: `ops target bookkeeping key: ${bad.key}` });
    return null;
  }
  const id = generateModificationId();
  await K.kvWritePrivileged([{
    op: "put",
    key: `modification_staged:${id}`,
    value: {
      id,
      type,
      claims: request.claims,
      ops: request.ops,
      checks: request.checks,
      validation: request.validation,
      staged_at: new Date().toISOString(),
      staged_by_session: sessionId,
      staged_by_depth: depth,
    },
  }]);
  _trackAdd('activeStaged', id);
  await K.karmaRecord({ event: "modification_staged", modification_id: id, claims: request.claims });
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

export async function acceptStaged(K, modificationId) {
  const record = await K.kvGet(`modification_staged:${modificationId}`);
  if (!record) throw new Error(`No staged modification: ${modificationId}`);

  const bad = opsTargetBookkeeping(record.ops);
  if (bad) {
    await K.karmaRecord({ event: "modification_invalid", modification_id: modificationId, reason: `ops target bookkeeping key: ${bad.key}` });
    throw new Error(`Modification ops target bookkeeping key: ${bad.key}`);
  }

  const targetKeys = record.ops.map(op => op.key);
  const conflict = await findInflightConflict(K, targetKeys);
  if (conflict) {
    await K.karmaRecord({ event: "modification_conflict", modification_id: modificationId, conflicting_modification: conflict.id, overlapping_keys: conflict.keys });
    throw new Error(`Conflict with inflight ${conflict.id} on keys: ${conflict.keys.join(", ")}`);
  }

  // Snapshot current values before applying
  const snapshots = {};
  for (const key of targetKeys) {
    const { value, metadata } = await K.kvGetWithMeta(key);
    snapshots[key] = { value: value !== null ? value : null, metadata };
  }

  // Build write ops
  const writeOps = buildWriteOps(record.ops);

  // For wisdom type: inject validation from staged record into op values
  if (record.type === 'wisdom' && record.validation) {
    for (const op of writeOps) {
      if (op.value && typeof op.value === 'object') {
        op.value.validation = record.validation;
      }
    }
  }

  // Apply ops via privileged writes
  await K.kvWritePrivileged(writeOps);

  // Write snapshot record
  await K.kvWritePrivileged([{
    op: "put",
    key: `modification_snapshot:${modificationId}`,
    value: {
      ...record,
      snapshots,
      activated_at: new Date().toISOString(),
    },
  }]);

  // Delete staged record
  await K.kvWritePrivileged([{ op: "delete", key: `modification_staged:${modificationId}` }]);
  _trackRemove('activeStaged', modificationId);
  _trackAdd('activeInflight', modificationId);

  // Refresh defaults if ops touch config:defaults
  if (targetKeys.some(k => k === "config:defaults")) {
    // Config auto-refreshed by kernel after privileged write
  }

  await K.karmaRecord({ event: "modification_accepted", modification_id: modificationId, target_keys: targetKeys });
  return modificationId;
}

export async function acceptDirect(K, request, sessionId) {
  // Wisdom must go through staging — no same-session accept
  if (request.type === 'wisdom') {
    await K.karmaRecord({ event: "modification_invalid", reason: "wisdom cannot use acceptDirect — must be staged" });
    return null;
  }

  if (!request.claims?.length || !request.ops?.length || !request.checks?.length) {
    await K.karmaRecord({ event: "modification_invalid", reason: "missing required fields (claims, ops, checks)" });
    return null;
  }
  const bad = opsTargetBookkeeping(request.ops);
  if (bad) {
    await K.karmaRecord({ event: "modification_invalid", reason: `ops target bookkeeping key: ${bad.key}` });
    return null;
  }
  const id = generateModificationId();
  const targetKeys = request.ops.map(op => op.key);

  const conflict = await findInflightConflict(K, targetKeys);
  if (conflict) {
    await K.karmaRecord({ event: "modification_conflict", modification_id: id, conflicting_modification: conflict.id, overlapping_keys: conflict.keys });
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

  // Write snapshot record
  await K.kvWritePrivileged([{
    op: "put",
    key: `modification_snapshot:${id}`,
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

  await K.karmaRecord({ event: "modification_accepted", modification_id: id, target_keys: targetKeys });
  return id;
}

export async function promoteInflight(K, modificationId, depth) {
  const record = await K.kvGet(`modification_snapshot:${modificationId}`);
  await K.kvWritePrivileged([{ op: "delete", key: `modification_snapshot:${modificationId}` }]);
  _trackRemove('activeInflight', modificationId);
  await K.karmaRecord({
    event: "modification_promoted",
    modification_id: modificationId,
    target_keys: record?.ops?.map(op => op.key),
    depth,
  });

  // Best-effort git sync — never throws; skip for wisdom
  if (record?.type !== 'wisdom' && record?.ops) {
    await syncToGit(K, modificationId, record.ops, record.claims);
  }
}

export async function rollbackInflight(K, modificationId, reason) {
  const record = await K.kvGet(`modification_snapshot:${modificationId}`);
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

  await K.kvWritePrivileged([{ op: "delete", key: `modification_snapshot:${modificationId}` }]);
  _trackRemove('activeInflight', modificationId);
  await K.karmaRecord({ event: "modification_rolled_back", modification_id: modificationId, reason });
}

export async function findInflightConflict(K, targetKeys) {
  for (const id of activeInflight) {
    const record = await K.kvGet(`modification_snapshot:${id}`);
    if (!record?.snapshots) continue;
    const overlap = targetKeys.filter(k => k in record.snapshots);
    if (overlap.length > 0) return { id: record.id, keys: overlap };
  }
  return null;
}

// ── Loading ─────────────────────────────────────────────────

export async function loadStagedModifications(K) {
  const result = {};
  for (const id of activeStaged) {
    const record = await K.kvGet(`modification_staged:${id}`);
    if (!record) continue;
    // For wisdom type: skip check evaluation (no checks field)
    if (record.type === 'wisdom') {
      result[record.id] = { record, check_results: null };
      continue;
    }
    const checkResults = await evaluateChecks(K, record.checks || []);
    result[record.id] = { record, check_results: checkResults };
  }
  return result;
}

export async function loadInflightModifications(K) {
  const result = {};
  for (const id of activeInflight) {
    const record = await K.kvGet(`modification_snapshot:${id}`);
    if (!record) continue;
    // For wisdom type: skip check evaluation (no checks field)
    if (record.type === 'wisdom') {
      result[record.id] = { record, check_results: null };
      continue;
    }
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
        await K.kvWritePrivileged([{ op: "delete", key: `modification_staged:${v.modification_id}` }]);
        _trackRemove('activeStaged', v.modification_id);
        await K.karmaRecord({ event: "modification_withdrawn", modification_id: v.modification_id });
        break;
      case "modify": {
        const record = await K.kvGet(`modification_staged:${v.modification_id}`);
        if (record) {
          await K.kvWritePrivileged([{
            op: "put",
            key: `modification_staged:${v.modification_id}`,
            value: {
              ...record,
              ...(v.updated_ops ? { ops: v.updated_ops } : {}),
              ...(v.updated_checks ? { checks: v.updated_checks } : {}),
              ...(v.updated_claims ? { claims: v.updated_claims } : {}),
              modified_at: new Date().toISOString(),
            },
          }]);
          await K.karmaRecord({ event: "modification_modified", modification_id: v.modification_id });
        }
        break;
      }
    }
  }
}

export async function processDeepReflectVerdicts(K, verdicts, depth) {
  for (const v of verdicts || []) {
    switch (v.verdict) {
      case "apply":
        try { await acceptStaged(K, v.modification_id); }
        catch (err) { await K.karmaRecord({ event: "modification_accept_failed", modification_id: v.modification_id, error: err.message }); }
        break;
      case "reject":
        await K.kvWritePrivileged([{ op: "delete", key: `modification_staged:${v.modification_id}` }]);
        _trackRemove('activeStaged', v.modification_id);
        await K.karmaRecord({ event: "modification_rejected", modification_id: v.modification_id, reason: v.reason });
        break;
      case "withdraw":
        await K.kvWritePrivileged([{ op: "delete", key: `modification_staged:${v.modification_id}` }]);
        _trackRemove('activeStaged', v.modification_id);
        await K.karmaRecord({ event: "modification_withdrawn", modification_id: v.modification_id });
        break;
      case "modify": {
        const record = await K.kvGet(`modification_staged:${v.modification_id}`);
        if (record) {
          await K.kvWritePrivileged([{
            op: "put",
            key: `modification_staged:${v.modification_id}`,
            value: {
              ...record,
              ...(v.updated_ops ? { ops: v.updated_ops } : {}),
              ...(v.updated_checks ? { checks: v.updated_checks } : {}),
              ...(v.updated_claims ? { claims: v.updated_claims } : {}),
              modified_at: new Date().toISOString(),
            },
          }]);
          await K.karmaRecord({ event: "modification_modified", modification_id: v.modification_id });
        }
        break;
      }
      case "promote":
        await promoteInflight(K, v.modification_id, depth);
        break;
      case "rollback":
        await rollbackInflight(K, v.modification_id, v.reason || "deep_reflect_verdict");
        break;
      case "defer":
        await K.karmaRecord({ event: "modification_deferred", modification_id: v.modification_id, reason: v.reason });
        break;
    }
  }
}

// ── Circuit breaker ────────────────────────────────────────

export async function runCircuitBreaker(K) {
  const lastDanger = await K.kvGet("last_danger");
  if (!lastDanger) return;

  for (const id of [...activeInflight]) {
    const record = await K.kvGet(`modification_snapshot:${id}`);
    if (!record?.activated_at) continue;

    // Only auto-rollback code modifications on fatal error
    if (record.type === 'wisdom') continue;

    if (lastDanger.t >= new Date(record.activated_at).getTime()) {
      await rollbackInflight(K, record.id, "circuit_breaker");
      await K.karmaRecord({ event: "circuit_breaker_fired", modification_id: record.id });
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

export async function syncToGit(K, modificationId, ops, claims) {
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

    const message = `modification promoted: ${modificationId}` +
      (claims?.length ? ` — ${claims.join('; ')}` : '');

    const pending = {
      modification_id: modificationId,
      writes,
      deletes,
      message,
      created_at: new Date().toISOString(),
    };

    await K.kvWritePrivileged([{
      op: 'put',
      key: `git_pending:${modificationId}`,
      value: pending,
    }]);

    await attemptGitSync(K, modificationId, pending);
  } catch (err) {
    await K.karmaRecord({ event: 'git_sync_error', modification_id: modificationId, error: err.message });
  }
}

export async function attemptGitSync(K, modificationId, pending) {
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
      id: `git_sync_${modificationId}`,
    });

    if (result?.ok && (result?.exit_code === 0 || result?.output?.includes('NO_CHANGES'))) {
      await K.kvWritePrivileged([{ op: 'delete', key: `git_pending:${modificationId}` }]);
      await K.karmaRecord({
        event: 'git_sync_ok',
        modification_id: modificationId,
        files: allPaths,
      });
    } else {
      await K.karmaRecord({
        event: 'git_sync_failed',
        modification_id: modificationId,
        error: result?.output?.slice(0, 500) || 'unknown',
      });
    }
  } catch (err) {
    await K.karmaRecord({ event: 'git_sync_error', modification_id: modificationId, error: err.message });
  }
}

export async function retryPendingGitSyncs(K) {
  const list = await K.kvList({ prefix: 'git_pending:', limit: 50 });
  for (const { name } of list.keys) {
    const pending = await K.kvGet(name);
    if (!pending) continue;
    const modificationId = name.slice('git_pending:'.length);
    await attemptGitSync(K, modificationId, pending);
  }
}
