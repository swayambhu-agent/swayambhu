# Two-Worker Architecture: Execution Plan

## Context

Swayambhu currently uses Cloudflare's Worker Loader API (closed beta) to dynamically load hook, tool, and provider code from KV into isolated workers. This blocks adoption: Worker Loader is invite-only, will likely be a paid feature ($5/mo), and may take a year+ to reach public beta.

We're restructuring into two workers on the GA free tier:
- **Runtime Worker** — statically compiled kernel + tools + hooks + providers
- **Governor Worker** — reads approved code from KV, builds and deploys runtime via CF API

Key design decisions (from conversation):
- Code proposals replace the proposal protocol (no snapshots, no inflight, no dual rollback)
- `hook-protect.js` logic moves into kernel (immutable safety)
- `hook-main.js` splits: orchestration → kernel, session policy → `act.js`
- `hook-reflect.js` → `reflect.js` (nearly unchanged)
- `kernel.js (proposal methods)` (694 lines) → proposal methods in kernel.js (~150 lines)
- Config/prompts/wisdom stay in KV (no deployment needed for changes)
- Governor is the single authority for code rollback (version-based)

**Critical finding**: `kernel-dev.js` already implements the target pattern as a subclass — direct imports, no Worker Loader, scoped KV via wrapper functions. The migration promotes this pattern to be canonical.

## Errata — Issues Found During Scrutiny

These issues are addressed inline in the phases below, but listed here for visibility:

1. **`buildKernelInterface()` must filter sealed: keys** — KernelRPC blocks `sealed:*` in kvGet/kvGetWithMeta/loadKeys. The K interface must do the same. Without this, hook code could read quarantined content.

2. **`callHook()` (validate, validate_result, parse_repair)** — currently loads optional hook-tools from KV and runs in isolates. Plan didn't address this. Fix: look up in TOOLS first, call directly if found, otherwise return null (same as kernel-dev.js).

3. **`checkHookSafety()` can't reset KV hook code** — in the new architecture there's no hook code in KV to delete/restore. Fix: on 3 consecutive crashes, signal governor (write `deploy:rollback_requested` to KV) and run minimal fallback. Governor's cron picks up the signal.

4. **`updateSessionOutcome()` last_good_hook snapshot is obsolete** — Worker versions replace it. Fix: remove snapshot logic, keep only session history update.

5. **Tool grants security regression** — if agent modifies tool code including meta exports, grants change implicitly. Fix: kernel reads `kernel:tool_grants` from KV first (patron-controlled, kernel-only), falls back to module extraction only if KV is empty. Governor does NOT update `kernel:tool_grants`. New tool grants require patron intervention.

6. **Governor reads kernel.js from KV at a kernel-only key** — stored at `kernel:source:kernel.js` and `kernel:source:hook-chat.js` by the seed script. CF Workers can't access their own source files at runtime, so embedding is impractical. Immutability is enforced by the `kernel:*` prefix — the agent can't write to `kernel:*` keys through any path (kvWriteSafe, kvWriteGated, kvWriteGated, and proposals all block it). This is consistent: ALL source code lives in KV, with prefix-based protection levels. Kernel source has the strongest protection.

7. **Circuit breaker gap** — between Phase 3 (removed from hooks) and Phase 4 (governor created), there's no crash auto-recovery for code proposals. Acceptable for local dev (code changes are manual), but the plan should keep a minimal crash-detection-and-fallback in kernel.js (which already exists as `checkHookSafety` → `runMinimalFallback`).

8. **Hook code KV keys for governor** — need explicit naming. Governor reads act.js source from `hook:act:code` and reflect.js source from `hook:reflect:code`. Seed script updated accordingly.

9. **Proposal mechanics belong in the kernel** — they control the proposal/review mechanism (structural safety, same category as kvWriteGated and the communication gate). If mutable, the agent could bypass review. So proposals.js doesn't exist as a separate file — its ~150 lines become methods on the Kernel class in kernel.js. reflect.js calls `K.createProposal()`, `K.loadProposals()`, `K.processProposalVerdicts()`. This keeps the immutable/mutable boundary clean: kernel.js = immutable, everything else = mutable.

10. **Proposals are code-only** — the proposal system only handles executable code changes (`tool:*:code`, `hook:*:code`, `provider:*:code`, `channel:*:code`). Config, prompt, wisdom, and skill changes continue through existing KV write tiers (kvWriteSafe, kvWriteGated, kvWriteGated) and take effect on the next session without deployment. reflect.js must route these differently: code targets → createProposal(), non-code targets → direct KV write.

11. **`getMaxSteps()` cross-dependency** — currently in hook-reflect.js but used by both act.js (act max_steps) and reflect.js (reflect max_steps). Move to kernel.js as a utility method — it's a mechanical config lookup, not policy. Same for `getReflectModel()`.

12. **Non-code changes lose multi-session review** — conscious tradeoff. Currently the proposal protocol reviews all changes (code + config). In the new system, only code changes get multi-session review via proposals. Config/prompt changes go through KV write tiers directly. This is acceptable because: config changes are immediately reversible (agent or deep reflect can write a correction), KV write tiers have validation gates (deliberation for yamas/niyamas, model capability checks), and the blast radius is smaller (config doesn't crash the worker the way bad code does).

## Files Reference

**Core (to refactor):**
- `kernel.js` (2274 lines) — current kernel with Worker Loader
- `kernel-dev.js` (317 lines) — already implements target pattern as subclass
- `hook-main.js` (362 lines) — wake flow + session policy
- `hook-reflect.js` (485 lines) — reflection hierarchy
- `kernel.js (proposal methods)` (694 lines) — proposal protocol (to simplify)
- `hook-protect.js` (87 lines) — KV gating (to move into kernel)

**Unchanged (tools/providers/channels):**
- `tools/*.js` — 10 tools, already work with direct imports
- `providers/*.js` — 4 providers, already work with direct imports
- `channels/slack.js` — already works with direct imports

**Config/tests/scripts:**
- `wrangler.toml`, `wrangler.dev.toml` — need Worker Loader removal
- `tests/kernel.test.js` (104 tests), `tests/wake-hook.test.js` (62 tests), `tests/tools.test.js` (100 tests), `tests/chat.test.js` (12 tests)
- `tests/helpers/mock-kernel.js` — KernelRPC mock (defines the K interface contract)
- `scripts/seed-local-kv.mjs` — KV seeding
- `scripts/start.sh` — dev startup

---

## Phase 1: Create kernel.js (merge kernel.js + kernel-dev.js)

**Goal**: Single Kernel class with direct-import execution, no Worker Loader dependency.

**Approach**: Start from `kernel.js`, merge in `kernel-dev.js` overrides, remove Worker Loader code.

### Create `kernel.js`

**Remove from kernel.js:**
- `import { WorkerEntrypoint } from "cloudflare:workers"` (line 15)
- `ScopedKV` class (lines 19-51) — replaced by `_buildScopedKV()` from kernel-dev.js:215-247
- `KernelRPC` class (lines 58-139) — replaced by `buildKernelInterface()` (new method)
- `_activeBrain` module-level singleton (line 55)
- `export default { scheduled, fetch }` block (lines 142-247) — moves to index.js
- `wrapAsModule()`, `wrapAsModuleWithProvider()`, `wrapChannelAdapter()` (lines 1414-1493)
- `runInIsolate()` (lines 1497-1534)
- `enable_ctx_exports` compat flag dependency

**Replace with kernel-dev.js patterns:**
- `_invokeHookModules()` (line 1076) → call `this.HOOKS.act.wake(K, input)` directly (kernel-dev.js:143-153)
- `_loadTool()` (line 1360) → return from `this.TOOLS[toolName]` (kernel-dev.js:173-179)
- `_executeTool()` (line 1374) → direct function call (kernel-dev.js:198-211)
- `executeAdapter()` (line 1238) → direct provider call (kernel-dev.js:184-193)
- `callWithCascade()` (line 1657) → use compiled provider, fall back to hardcoded direct OpenRouter call (merge kernel-dev.js:252-302 as fallback tier)

**Add new:**
- Constructor accepts `{ ctx, TOOLS, HOOKS, PROVIDERS, CHANNELS }` — dependency injection
- `_buildScopedKV(toolName, kvAccess)` — from kernel-dev.js:215-247
- `_buildToolGrantsFromModules()` — from kernel-dev.js:156-167, used as FALLBACK only when `kernel:tool_grants` not in KV
- `buildKernelInterface()` — returns K object matching KernelRPC API surface (see `tests/helpers/mock-kernel.js` for the wake hook contract + `callLLM` for hook-chat.js). **Must include sealed: key filtering** in kvGet, kvGetWithMeta, and loadKeys (matching KernelRPC lines 68-70, 73-74, 112-114). All methods async (hooks await them). Note: mock-kernel.js doesn't include `callLLM` because wake hooks don't call it directly — but hook-chat.js does, so `buildKernelInterface()` must include it.
- `kvWriteGated(op)` — moved from hook-protect.js (kernel safety, immutable)

**Replace `callHook()`** (line 1941) — currently loads from KV + runs in isolate. New version: check if tool exists in `this.TOOLS`, call directly if found, otherwise return null. Same graceful degradation.

**Replace `checkHookSafety()`** (line 1003) — can no longer delete/restore KV hook code. New version: detect 3 consecutive crashes → write `deploy:rollback_requested` to KV (governor signal) → return false (triggers `runMinimalFallback()`). Remove `kernel:last_good_hook` restore logic.

**Replace `updateSessionOutcome()`** (line 1106) — remove `kernel:last_good_hook` snapshot logic and `kernel:hook_dirty` check. Keep only: update `kernel:last_sessions` history.

**Replace `runScheduled()`** (line 950) — remove manifest/KV code loading (lines 960-977). Simplified: detectPlatformKill → checkHookSafety → if safe, call executeHook directly (no modules argument needed since hooks are statically compiled).

**Tool grants loading** — `loadEagerConfig()` reads `kernel:tool_grants` from KV first. Only if empty, falls back to `_buildToolGrantsFromModules()`. This preserves patron control: `kernel:tool_grants` is a kernel-only key the agent cannot modify.

**Keep unchanged:** All safety gates (kvWriteSafe, kvWriteGated, communicationGate, inbound gate), callLLM + dharma injection, runAgentLoop, budget enforcement, karma, session management, patron identity, alerting.

### Create `index.js` (entry point)

Static file importing all modules and wiring them to the kernel:

```javascript
import { Kernel } from './kernel.js';
import { handleChat } from './hook-chat.js';
import * as act from './act.js';      // Phase 2
import * as reflect from './reflect.js'; // Phase 2
import * as send_slack from './tools/send_slack.js';
// ... all tools, providers, channels

const TOOLS = { send_slack, web_fetch, ... };
const PROVIDERS = { 'provider:llm': llm, ... };
const CHANNELS = { slack: slackAdapter };
const HOOKS = { act, reflect };

export default {
  async scheduled(event, env, ctx) {
    const kernel = new Kernel(env, { ctx, TOOLS, HOOKS, PROVIDERS, CHANNELS });
    await kernel.runScheduled();
  },
  async fetch(request, env, ctx) {
    // Channel routing with direct adapter calls (from kernel-dev.js:56-113)
  },
};
```

**Note**: During Phase 1, `act` and `reflect` still point to the current hook-main.js and hook-reflect.js (they work because the K interface is backward-compatible). Renaming happens in Phase 2.

### Update wrangler configs

- `wrangler.toml`: `main = "index.js"`, remove `[[worker_loaders]]`, remove `enable_ctx_exports` from compat flags
- `wrangler.dev.toml`: `main = "index.js"`, same removals

### Update tests

- `tests/kernel.test.js`: import from `kernel.js`, update `makeBrain()` to pass TOOLS/PROVIDERS where tool execution tests need them
- `tests/helpers/mock-kernel.js`: add `kvWriteGated` to the mock interface

### Delete

- `kernel.js`
- `kernel-dev.js`

**Verify**: `npm test` passes (all 278 tests). `start.sh --reset-all-state --wake` works.

---

## Phase 2: Extract act.js and reflect.js

**Goal**: Split hook-main.js into kernel orchestration + act.js session policy. Rename hook-reflect.js to reflect.js.

### Create `act.js`

Extract from hook-main.js:
- `runSession(K, state, context, config)` (lines 155-230) — the core session: build prompt, run agent loop, apply KV ops, trigger reflect
- `buildOrientContext(context)` (lines 232-244) — context builder
- `writeSessionResults(K, config, opts)` (lines 248-273) — post-session bookkeeping
- `getBalances(K, state)` (line 325-327) — balance helper
- `summarizeKarma(karma)` (lines 277-321) — karma summary

Note: `runSession` currently calls `kvWriteGated` from hook-protect.js. In the new architecture, it calls `K.kvWriteGated()` (kernel method added in Phase 1). Also calls `executeReflect` from hook-reflect.js — in Phase 2 this becomes an import from reflect.js.

### Move to kernel.js

From hook-main.js:
- `wake()` orchestration (lines 18-131) → becomes body of kernel's `runWake()` method, called by `executeHook()`. This is the timing check, crash detection, effort eval, and dispatch to act vs reflect.
- `detectCrash(K)` (lines 136-151) → kernel method `_detectCrash()`
- `evaluateTripwires(config, liveData)` (lines 329-350) → kernel static method
- `getMaxSteps(state, role, depth)` and `getReflectModel(state, depth)` from hook-reflect.js → kernel utility methods (mechanical config lookups used by both act.js and reflect.js — avoids cross-dependency between the two)

**Important sequencing note**: The current `wake()` calls `initTracking()`, `runCircuitBreaker()`, and `retryPendingGitSyncs()` from kernel.js (proposal methods). In Phase 2, these calls remain in the kernel's `runWake()` as imports from kernel.js (proposal methods) (which still exists until Phase 3). In Phase 3, these calls are removed when the proposal protocol is replaced by proposals.

The kernel's wake flow calls `this.HOOKS.act.runSession()` for act sessions and `this.HOOKS.reflect.runReflect()` for deep reflect.

### Create `reflect.js`

Copy hook-reflect.js with these changes:
- Remove `import { kvWriteGated } from './hook-protect.js'` → use `K.kvWriteGated(op)` instead
- Keep `import { ... } from './kernel.js (proposal methods)'` temporarily (updated in Phase 3)
- Remove Worker Loader default export (lines 354-361 of hook-main.js — but this is in hook-main, not hook-reflect. hook-reflect has no default export, so no change needed)

### Update index.js

Change imports from `hook-main.js` / `hook-reflect.js` to `act.js` / `reflect.js`.

### Update tests

- `tests/wake-hook.test.js`: split tests — orchestration tests (wake timing, crash detection, tripwires) test kernel methods; session tests import from act.js; reflect tests import from reflect.js

### Delete

- `hook-main.js`
- `hook-protect.js`
- `hook-reflect.js` (superseded by reflect.js — nothing imports it after this phase)

**Verify**: `npm test` passes. `start.sh --wake` works.

---

## Phase 3: Simplify proposal protocol to proposal system

**Goal**: Replace kernel.js (proposal methods) (694 lines) with proposal methods in kernel.js (~150 lines).

### Add proposal methods to kernel.js

Proposal mechanics are kernel methods (immutable safety — controls how code changes are reviewed):
- `createProposal(request, sessionId, depth)` — writes `proposal:{id}` to KV with status "proposed"
- `loadProposals(statusFilter)` — reads proposals from KV, optionally filtered by status
- `updateProposalStatus(id, newStatus, metadata)` — status transitions
- `processProposalVerdicts(verdicts, depth)` — handle accept/reject/modify/withdraw verdicts from reflect

These are exposed through the K interface as `K.createProposal()`, `K.loadProposals()`, etc.

**Proposal KV schema:**
```json
{
  "id": "p_...",
  "targets": ["tool:kv_query"],
  "changes": { "tool:kv_query": { "op": "replace", "code": "..." } },
  "claims": ["Add caching"],
  "checks": [{ "type": "kv_assert", ... }],
  "proposed_by": "s_xxx",
  "proposed_at": "...",
  "status": "proposed"
}
```

Statuses: `proposed` → `accepted` → `deploying` → `deployed` → `stable` (or `failed`)

**What's eliminated vs kernel.js (proposal methods):**
- `initTracking()` / module-level mutable state (proposals read from KV each time)
- `acceptStaged()` / `acceptDirect()` (governor applies accepted proposals)
- `promoteInflight()` / `rollbackInflight()` / `findInflightConflict()` (governor handles)
- `runCircuitBreaker()` (governor's crash watchdog)
- `syncToGit()` / `attemptGitSync()` / `retryPendingGitSyncs()` (governor handles git)
- Snapshot/inflight tracking entirely

**What's kept (simplified):**
- `evaluateChecks()` / `evaluatePredicate()` — useful for reflect to verify proposal preconditions. Can stay in proposals.js or move to reflect.js.

### Update reflect.js

- Remove `import { ... } from './kernel.js (proposal methods)'` — proposal methods are now on K (kernel)
- `executeReflect()` (session reflect): calls `K.loadProposals('proposed')` instead of `loadStagedModifications(K)`. Verdicts use `K.processProposalVerdicts()`.
- `runReflect()` (deep reflect): same pattern. Verdicts are simpler — "accept" means set status to accepted (governor deploys later), not "execute KV writes immediately"
- `applyReflectOutput()`: replace `processDeepReflectVerdicts()` with new `processProposalVerdicts()`. Remove snapshot/inflight terminology.
- Remove proposal_requests → route by target: code keys (`tool:*:code`, `hook:*:code`, `provider:*:code`, `channel:*:code`) become `K.createProposal()` calls; non-code keys (config, prompts, wisdom, skills) continue as direct KV writes via `K.kvWriteGated()` or `K.kvWriteGated()`

### Update kernel.js wake orchestration

- Remove the `initTracking()` call and staged/snapshot prefix scans
- Remove `runCircuitBreaker()` call (governor handles this)
- Remove `retryPendingGitSyncs()` call (governor handles this)

### Update seed script

- `scripts/seed-local-kv.mjs`:
  - Remove `hook:wake:manifest`, `hook:wake:proposals`, `hook:wake:protect` seeding
  - Remove `hook:wake:code` (was hook-main.js source)
  - Add `hook:act:code` ← seeds act.js source (governor reads this key)
  - Change `hook:wake:reflect` → `hook:reflect:code` ← seeds reflect.js source
  - Proposal mechanics are kernel methods — no separate file to seed
  - Add `kernel:source:kernel.js` ← seeds kernel.js source (governor reads this, agent can't modify kernel:* keys)
  - Add `kernel:source:hook-chat.js` ← seeds hook-chat.js source (same protection)
  - Keep tool/provider/channel/config/prompt seeding unchanged
  - Remove `kernel:last_good_hook` from any seeding (obsolete)

### Update tests

- `tests/wake-hook.test.js`: remove all proposal protocol tests (staging, inflight, circuit breaker, git sync, predicate evaluation, conflict detection). Add proposal system tests.

### Delete

- `kernel.js (proposal methods)`

**Verify**: `npm test` passes. `start.sh --reset-all-state --wake` works.

---

## Phase 4: Governor worker

**Goal**: Create the governor worker that builds and deploys the runtime.

### Create governor directory

**`governor/wrangler.toml`:**
```toml
name = "swayambhu-governor"
main = "worker.js"
compatibility_date = "2025-06-01"
compatibility_flags = ["nodejs_compat"]

[[kv_namespaces]]
binding = "KV"
id = "05720444f9654ed4985fb67af4aea24d"

# Secrets: CF_API_TOKEN, CF_ACCOUNT_ID
```

**`governor/worker.js`** — entry point with:
- `fetch` handler: POST `/deploy` triggers build+deploy, POST `/rollback` triggers rollback
- `scheduled` handler: crash watchdog (reads `kernel:last_sessions`, 3+ crashes → rollback)

**`governor/builder.js`** — generates `index.js` from KV contents:
- Reads all `tool:*:code` keys → generates tool imports
- Reads `hook:act:code` (act.js source), `hook:reflect:code` (reflect.js source)
- Reads `provider:*:code` → generates provider imports
- Reads `channel:*:code` → generates channel imports
- Generates the full index.js entry point string

**`governor/deployer.js`** — CF Workers API integration:
- Multipart module upload to CF Workers API
- `PUT /accounts/{account_id}/workers/scripts/{script_name}`
- **Immutable files from KV kernel-only keys**: kernel.js (`kernel:source:kernel.js`), hook-chat.js (`kernel:source:hook-chat.js`). Agent can't modify `kernel:*` keys. Proposal mechanics are kernel methods, not a separate file.
- **Mutable files from KV**: tools, providers, channels, act.js (`hook:act:code`), reflect.js (`hook:reflect:code`)
- **Generated**: index.js (by builder.js)
- Records deployment in KV: `deploy:version:{id}`, `deploy:current`, `deploy:history`
- Does NOT update `kernel:tool_grants` — patron-only

**Governor deployment flow:**
1. Read accepted proposals from KV (status = "accepted")
2. Apply proposal changes to KV code keys (update `tool:*:code` etc.)
3. Mark proposals as "deploying"
4. Build runtime via builder.js
5. Deploy via deployer.js
6. Mark proposals as "deployed"
7. Record version manifest (which proposals, code hashes)
8. On crash rollback: restore KV code keys from version manifest, redeploy previous version, mark proposals as "failed"

### Runtime → Governor signaling

**KV flag** — after reflect processes proposal verdicts and any are accepted, runtime writes `deploy:pending` to KV. Governor's cron (already running for crash watchdog) checks this flag each cycle.

No service binding or HTTP needed. Both workers communicate solely through the shared KV namespace. This means zero configuration between workers, resilience if either is temporarily down, and no latency concern (proposals already took sessions to review — one more minute is nothing).

### Create governor tests

- `tests/governor.test.js`: test builder.js (index.js generation), proposal processing, version tracking, rollback logic

### Update start.sh

- Add optional `--governor` flag to start governor worker alongside kernel
- Not needed for normal dev (index.js is hand-written locally)

**Verify**: Governor tests pass. Manual test: `curl localhost:GOVERNOR_PORT/deploy` triggers a build cycle.

---

## Phase 5: Cleanup and docs

### Delete remaining old files

- `kernel.js` (deleted in Phase 1)
- `kernel-dev.js` (deleted in Phase 1)
- `hook-main.js` (deleted in Phase 2)
- `hook-protect.js` (deleted in Phase 2)
- `hook-reflect.js` (deleted in Phase 2)
- `kernel.js (proposal methods)` (deleted in Phase 3)

### Update CLAUDE.md

- New code layout table (kernel.js, act.js, reflect.js, governor/)
- Remove Worker Loader references
- Update wake hook module table
- Update proposal protocol section → proposal system
- Add governor section

### Update prompts

- `prompt:reflect` and `prompt:reflect:1` reference proposal_requests, proposal_verdicts, staged/inflight terminology. Update to use proposal terminology.

### Final verification

1. `npm test` — all tests pass
2. `start.sh --reset-all-state --wake` — clean reset + successful wake cycle
3. `start.sh --wake` — preserving state + successful wake cycle
4. Chat via Slack webhook works
5. Dashboard API works (reads same KV)
6. Governor build+deploy works (manual test)

---

## Phase Dependencies

```
Phase 1 (kernel.js) → Phase 2 (act.js/reflect.js) → Phase 3 (proposals.js) → Phase 5 (cleanup)
                                                                ↓
                                                    Phase 4 (governor) → Phase 5
```

Phase 4 (governor) can start after Phase 1 since it's new code, but needs Phase 3's proposal schema to be finalized.

## Estimated File Sizes

| New File | Lines | Source |
|----------|-------|--------|
| kernel.js | ~1950 | kernel.js - Worker Loader + kernel-dev.js overrides + wake orchestration + kvWriteGated + proposal methods (~150 lines) |
| index.js | ~60 | Entry point wiring |
| act.js | ~150 | hook-main.js session logic |
| reflect.js | ~450 | hook-reflect.js (minor changes) |
| governor/worker.js | ~150 | New |
| governor/builder.js | ~100 | New |
| governor/deployer.js | ~150 | New |

## Files Deleted

| File | Lines | Replacement |
|------|-------|-------------|
| kernel.js | 2274 | kernel.js |
| kernel-dev.js | 317 | Merged into kernel.js |
| hook-main.js | 362 | kernel.js (orchestration) + act.js (session) |
| hook-protect.js | 87 | kernel.js (kvWriteGated method) |
| kernel.js (proposal methods) | 694 | kernel.js (proposal methods) |
| hook-reflect.js | 485 | reflect.js |
| **Total removed** | **4219** | |
| **Total new** | **~3010** | |
