# Module 6: Deep Reflect on Akash — Design Spec

> **Spec reference:** `swayambhu-cognitive-architecture.md` sections 4.2, 7.2, 7.3
> **Depends on:** Modules 1-5 (complete), async-jobs infrastructure (`specs/async-jobs.md`, `tools/start_job.js`, `tools/collect_jobs.js`, `/job-complete` handler)
> **Adversarial review:** One round with Codex. Key finding: the async-jobs spec already provides the infrastructure. Module 6 is a job type + prompts + wiring, not new infrastructure.

---

## 1. Summary

Move deep-reflect from running inside the CF Worker (via K.runAgentLoop, ~$0.50/run) to running as a `cc_analysis` async job on akash via Claude Code CLI (zero marginal cost on subscription). Add structured M and D operator prompts. Wire session.js to dispatch and collect deep-reflect results through the existing async-jobs system.

**Key decisions:**
- Deep-reflect dispatches via existing `start_job` tool (cc_analysis type)
- Results stored in KV, applied by the next session via `applyReflectOutput` (store-only callback, session applies — matching async-jobs spec)
- M and D operators are explicit prompt phases with structured JSON output
- **No cold start special case.** When `d = ∅`, the first session orients from principles + circumstances. The absence of desires is a circumstance. The orientation is the first experience. Deep-reflect derives d_1 from real experience, not ceremony.
- Timeout configurable via `config:defaults.deep_reflect.ttl_minutes` (default 60, max as needed)
- Zero new infrastructure — uses existing `start_job`, `collect_jobs`, `/job-complete` callback
- Zero kernel changes

---

## 2. Deep-Reflect as CC Analysis Job

### Dispatch

When deep-reflect is due, the session dispatches it via `start_job`:

```javascript
await K.executeToolCall({
  function: {
    name: "start_job",
    arguments: JSON.stringify({
      type: "cc_analysis",
      prompt: buildDeepReflectPrompt(depth),
      context_keys: [
        "mu:*",
        "experience:*",
        "desire:*",
        "assumption:*",
        "principle:*",
        "config:defaults",
        "reflect:schedule:*",
      ],
      include_code: false,
    }),
  },
});
```

The `start_job` tool:
1. Packs all context_keys from KV into a tarball
2. Adds `prompt.txt` with the M/D operator prompt
3. Transfers to akash, starts `claude -p "$(cat prompt.txt)" --output-format json`
4. Writes `job:{id}` to KV with `status: "running"`
5. Returns immediately

### Context Delivery

The tarball unpacks into the job workdir:
```
/home/swayambhu/jobs/{job_id}/
  prompt.txt           # M/D operator prompt
  mu/                  # mu:* entries as JSON files
    slack-ok.json
    google-docs.json
  experience/          # experience:* entries
    1711352400000.json
  desire/              # desire:* entries
    serve.json
    conserve.json
  assumption/          # assumption:* entries
    slack-ok.json
  principle/           # principle:* entries
    care.json
    responsibility.json
  config/
    defaults.json
  reflect/
    schedule/
      1.json
```

Claude Code CLI runs in this workdir with `--add-dir .` so it can read all context files. The prompt references the directory structure.

### Timeout

`start_job` writes `ttl_minutes` to the job record. `collect_jobs` checks TTL and marks expired jobs. Default: 60 minutes. Configurable via `config:defaults.deep_reflect.ttl_minutes`.

The CC invocation has no hard wall-clock timeout — `--max-turns` limits agentic turns (default: unlimited for deep analysis). The TTL in the job record is the safety net. If the process hangs, it gets marked expired on the next `collect_jobs` call.

For hard process kill, the nohup wrapper can include `timeout`:
```bash
timeout ${TTL_SECONDS}s claude -p "$(cat prompt.txt)" --output-format json
```

`start_job` already supports this via the command template. The `cc_analysis` command template in `config:defaults.jobs` controls the exact invocation.

---

## 3. M and D Operator Prompts

The prompt is the cognitive architecture content — what makes this deep-reflect and not a generic analysis.

### Prompt Structure

```
You are running deep-reflect for Swayambhu, a self-improving agent.

Read the context files in this directory:
- mu/ — statistical memory (confirmation/violation counts, cumulative surprise per check)
- experience/ — salient experiences (narratives, surprise scores, affinity vectors)
- desire/ — current desires (directional vectors the agent pursues)
- assumption/ — current assumptions (cached heuristics with TTL)
- principle/ — immutable principles (the agent's dharma)
- config/defaults.json — current configuration
- reflect/schedule/ — when each depth last ran

Run two operators in sequence:

## PHASE 1 — M operator: Assumption Evolution

Review μ (statistical memory). For each mu entry:
- High confirmation_count + low cumulative_surprise → this pattern is stable. Create a new assumption or extend an existing assumption's TTL.
- High violation_count + high cumulative_surprise → this pattern is broken. Expire the assumption (delete it or shorten TTL) so the act loop is forced to check actual state.
- New patterns: look for circumstances where the agent repeatedly checks something that could be assumed. Create new assumptions where cost(state_check) × frequency > cost(risk_of_wrong_assumption).

For new/extended assumptions, output:
{ "key": "assumption:{slug}", "value": { "slug": "...", "check": "...", "confidence": 0.0-1.0, "ttl_expires": "ISO8601", "source": "statistical", "created_at": "ISO8601" } }

For expired assumptions, output:
{ "key": "assumption:{slug}", "op": "delete" }

## PHASE 2 — D operator: Desire Evolution

Review ε (experiences) through the immutable lens of principles.
- Strengthen desires that experiences validate through principles
- Weaken or retire desires that experiences show are unproductive or misaligned with principles
- Create new desires if experiences + principles reveal unmet directional needs
- Each desire must trace to at least one principle (source_principles field)

For new/modified desires:
{ "key": "desire:{slug}", "value": { "slug": "...", "direction": "approach|avoidance", "description": "...", "source_principles": ["..."], "created_at": "ISO8601", "updated_at": "ISO8601" } }

For retired desires:
{ "key": "desire:{slug}", "op": "delete" }

## Output Format

Respond with ONLY a JSON object:
{
  "kv_operations": [
    // All assumption and desire changes from Phase 1 and Phase 2
  ],
  "reflection": "Narrative summary of what changed and why",
  "note_to_future_self": "What to pay attention to in the next deep-reflect",
  "next_reflect": {
    "after_sessions": 20,
    "after_days": 7
  }
}

Only output kv_operations for desire:* and assumption:* keys. Do not modify any other keys.
```

### No Cold Start Special Case

The cold start ceremony (`D_p(∅, ∅)` — synchronous in-Worker deep-reflect) is eliminated. When `d = ∅`:

1. The plan prompt handles it naturally: "If you have no desires yet, orient: observe your environment, understand your situation, act from principles. The absence of desires is itself a circumstance."
2. The first session orients — reads environment, observes available tools/resources/patron, notices the absence of desires and assumptions
3. That orientation is the first experience, written to `experience:0`
4. Deep-reflect runs (async, normal path), reads the first experience + principles, derives `d_1` organically

**What gets deleted from existing code:**
- `coldStartPrompt()` in reflect.js
- `isColdStart` handling in `runReflect`
- The `if (Object.keys(desires).length === 0)` cold start branch in session.js
- The synchronous `runReflectInWorker` fallback (no longer needed for cold start)

**What changes:**
- Plan prompt updated to handle `d = ∅` gracefully
- `highestReflectDepthDue` returns depth 1 on session 0 (already does this — triggers deep-reflect after first session)

The yogic model: awareness precedes desire. The agent arrives with awareness (principles + circumstances), not with wants. Desires crystallize from awareness meeting reality.

### Prompt Stored in KV

The prompt is stored as `prompt:deep_reflect` in KV (seeded by seed script). This allows the agent to iterate on its own deep-reflect prompt via proposals — the same pattern as `prompt:act` and `prompt:reflect`.

---

## 4. Result Collection and Application

### Callback Flow (existing)

1. Claude Code CLI finishes → writes `output.json` in workdir
2. The nohup wrapper curls `/job-complete/{id}` with exit_code
3. Handler updates `job:{id}` status, emits `job_complete` event, advances session schedule
4. Next session starts, sees `job_complete` event in drained events

### Session Applies Result

In session.js, when processing events at session start, check for deep-reflect job completions:

```javascript
// In session.js run(), after draining events
for (const event of events) {
  if (event.type === "job_complete") {
    const job = await K.kvGet(`job:${event.source.job_id}`);
    if (job?.type === "cc_analysis" && job.config?.deep_reflect) {
      await applyDeepReflectResult(K, job, state);
    }
  }
}
```

### applyDeepReflectResult

Reads `job_result:{id}` from KV (or reads `output.json` from akash workdir via computer tool), then calls the existing `applyReflectOutput` with the parsed result.

```javascript
async function applyDeepReflectResult(K, job, state) {
  // Read structured result
  let result = await K.kvGet(`job_result:${job.id}`);

  if (!result?.result) {
    // Result not yet in KV — read from workdir via computer tool
    // (collect_jobs may not have transferred it yet)
    await K.karmaRecord({ event: "deep_reflect_result_missing", job_id: job.id });
    return;
  }

  const output = result.result;

  // Validate: only allow desire:* and assumption:* in kv_operations
  if (output.kv_operations) {
    output.kv_operations = output.kv_operations.filter(op => {
      const key = op.key;
      return key.startsWith("desire:") || key.startsWith("assumption:");
    });
  }

  // Apply via existing applyReflectOutput (handles schedule, records, karma)
  await applyReflectOutput(K, state, 1, output, { fromJob: job.id });

  await K.karmaRecord({
    event: "deep_reflect_applied",
    job_id: job.id,
    operations: output.kv_operations?.length || 0,
  });
}
```

**Trust boundary:** kv_operations are filtered to only `desire:*` and `assumption:*` keys. Even though `applyReflectOutput` uses `kvWriteGated("deep-reflect")` (which allows all protected keys), the pre-filter ensures the external CC job can only modify what the M and D operators should produce.

**Stale check:** The job record includes `created_at`. If the result is older than N sessions (configurable), skip application and log to karma. This prevents a delayed result from clobbering fresher state.

---

## 5. reflect.js Changes

### runReflect — dispatch instead of run locally

```javascript
export async function runReflect(K, state, depth, context) {
  const { defaults } = state;

  // Dispatch as async job if configured
  const jobsConfig = defaults?.jobs;
  if (jobsConfig?.base_url) {
    return dispatchDeepReflect(K, state, depth);
  }

  // Fallback: no job runner configured → run in-Worker (current behavior)
  return runReflectInWorker(K, state, depth, context);
}
```

`runReflectInWorker` is the current `runReflect` logic (K.runAgentLoop). Renamed but unchanged. This is the fallback when akash is unavailable. No cold start branch — the first session orients normally and deep-reflect runs after.

### dispatchDeepReflect

```javascript
async function dispatchDeepReflect(K, state, depth) {
  const prompt = await K.kvGet("prompt:deep_reflect") || defaultDeepReflectPrompt(depth);

  const result = await K.executeToolCall({
    id: `dr_dispatch_${Date.now()}`,
    function: {
      name: "start_job",
      arguments: JSON.stringify({
        type: "cc_analysis",
        prompt,
        context_keys: [
          "mu:*", "experience:*", "desire:*", "assumption:*",
          "principle:*", "config:defaults", `reflect:schedule:${depth}`,
        ],
      }),
    },
  });

  if (result?.ok) {
    // Mark this job as deep-reflect in the job record
    const jobRecord = await K.kvGet(`job:${result.job_id}`);
    if (jobRecord) {
      jobRecord.config.deep_reflect = true;
      jobRecord.config.depth = depth;
      await K.kvWriteSafe(`job:${result.job_id}`, jobRecord);
    }

    await K.karmaRecord({
      event: "deep_reflect_dispatched",
      job_id: result.job_id,
      depth,
      context_files: result.context_files,
    });
  } else {
    // Dispatch failed — fall back to in-Worker
    await K.karmaRecord({ event: "deep_reflect_dispatch_failed", error: result?.error });
    return runReflectInWorker(K, state, depth, {});
  }
}
```

### Depth cascade

Current reflect runs depth 2 then depth 1 in sequence. For async jobs, dispatch each due depth as a separate job. The session checks each depth independently:

```javascript
// In session.js, replace single highestReflectDepthDue call:
const maxDepth = defaults?.execution?.max_reflect_depth || 1;
for (let d = maxDepth; d >= 1; d--) {
  if (await isReflectDue(K, state, d)) {
    await runReflect(K, state, d, {});
  }
}
```

Each depth is independent — if depth 2 is dispatched as a job and depth 1 runs in-Worker, that's fine. They read from the same KV state but write to different key spaces (reflect:schedule:{depth}).

---

## 6. session.js Changes

### Delete cold start branch

Remove the entire `if (Object.keys(desires).length === 0)` block in session.js. The plan prompt handles `d = ∅` naturally.

### Event processing — collect deep-reflect results

Add to the event processing at session start (before the main plan-act loop):

```javascript
// Process deep-reflect job completions
for (const event of events) {
  if (event.type === "job_complete") {
    const job = await K.kvGet(`job:${event.source?.job_id}`);
    if (job?.config?.deep_reflect) {
      await applyDeepReflectResult(K, job, state);
      // Re-snapshot desires/assumptions (deep-reflect may have changed them)
      desires = await loadDesires(K);
      assumptions = await loadAssumptions(K);
    }
  }
}
```

After applying deep-reflect results, re-snapshot desires and assumptions since they may have changed.

### Dispatch changes

Replace the current reflect dispatch at the end of the session loop:

```javascript
// Old:
const reflectDepth = await highestReflectDepthDue(K, state);
if (reflectDepth > 0) {
  await runReflect(K, state, reflectDepth, {});
}

// New:
const maxDepth = defaults?.execution?.max_reflect_depth || 1;
for (let d = maxDepth; d >= 1; d--) {
  if (await isReflectDue(K, state, d)) {
    await runReflect(K, state, d, {});
  }
}
```

---

## 7. Config Changes

### config:defaults additions

```json
{
  "deep_reflect": {
    "ttl_minutes": 60,
    "max_stale_sessions": 5
  },
  "jobs": {
    "cc_model": "opus"
  }
}
```

- `ttl_minutes`: How long a deep-reflect job can run before being marked expired (default 60, configurable up to whatever you need)
- `max_stale_sessions`: If more than this many sessions have passed since dispatch, skip applying the result
- `cc_model`: Which Claude model to use (passed to `claude --model`)

### prompt:deep_reflect

New KV key seeded by the seed script. Contains the M/D operator prompt from Section 3. Can be modified by the agent via proposals.

---

## 8. What Changes, What Stays

### Modified files
- `reflect.js` — runReflect dispatches to akash (except cold start), add dispatchDeepReflect, rename current logic to runReflectInWorker
- `session.js` — process deep-reflect job_complete events, re-snapshot after apply, per-depth dispatch
- `scripts/seed-local-kv.mjs` — seed `prompt:deep_reflect`
- `config/defaults.json` — add deep_reflect.ttl_minutes, jobs.cc_model

### New files
- None. Zero new files.

### Unchanged
- `kernel.js` — zero changes
- `eval.js`, `memory.js`, `act.js` — unchanged
- `index.js` — job-complete handler already works
- `tools/start_job.js` — already supports cc_analysis type
- `tools/collect_jobs.js` — already handles TTL expiry
- `applyReflectOutput` — reused for applying results (same kv_operations format)

---

## 9. Testing Strategy

### Unit tests

**tests/reflect.test.js (additions):**
- dispatchDeepReflect: verifies executeToolCall called with start_job, correct context_keys
- Fallback: verifies runReflectInWorker called when dispatch fails
- Cold start deleted: no special case tests needed

**tests/session.test.js (additions):**
- Deep-reflect job_complete event: verifies applyDeepReflectResult called
- Re-snapshot after apply: verifies desires/assumptions reloaded
- Stale result: verifies skipped when max_stale_sessions exceeded
- Trust boundary: verifies non-desire/assumption kv_operations filtered out

### Integration tests

- Full flow: dispatch → callback → next session applies
- Requires running akash compute target (or mock)

---

## 10. Local Development

### Without akash

Deep-reflect falls back to in-Worker `runReflectInWorker` (current behavior). This is the default when `jobs.base_url` is not configured. No behavior change from Modules 1-5.

### With akash

Set `config:defaults.jobs.base_url` to the akash URL. Deep-reflect dispatches as a job. Results arrive via callback and are applied in the next session.

### Testing the dispatch flow locally

Mock `start_job` in tests. For manual testing, use `--set deep_reflect.ttl_minutes=5` with the start script to test TTL behavior.

---

## 11. Adversarial Review Summary

Codex found 14 issues in the original design (separate job runner service). The revised design addresses all of them by building on the existing async-jobs infrastructure:

- ~~SSRF/command injection~~ → uses existing `start_job` with its auth/sanitization
- ~~Incomplete callback~~ → store-only callback (existing), session applies via `applyReflectOutput`
- ~~Conflicts with async-jobs spec~~ → now builds on it, not against it
- ~~Stale-result race~~ → `max_stale_sessions` check before apply
- ~~File access~~ → tarball context delivery (existing `start_job` mechanism)
- ~~Callback reliability~~ → existing fallback: `collect_jobs` + TTL expiry
- ~~Concurrency~~ → existing `start_job` concurrency check
- ~~No subprocess timeout~~ → `timeout` in command template + TTL safety net
- ~~No fallback~~ → falls back to in-Worker `runReflectInWorker`
- ~~Depth cascade~~ → separate dispatch per depth
- ~~Trust boundary~~ → kv_operations filtered to desire:*/assumption:* only

**Post-Codex refinement:** Eliminated cold start special case entirely. When `d = ∅`, the first session orients from principles + circumstances. The orientation is the first experience. Deep-reflect derives desires from real experience, not ceremony. The yogic model: awareness precedes desire.
