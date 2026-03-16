# Modification Protocol

How Swayambhu self-modifies: staging, validation, inflight management,
rollback, circuit breaker, and git sync.

All code lives in `hook-modifications.js` (KV key `hook:wake:modifications`).
Verdict processing is triggered from `hook-reflect.js`. The wake entry point
in `hook-main.js` initializes tracking and runs the circuit breaker on every
wake.

---

## Lifecycle

```
                  session reflect                deep reflect
                  can: stage                     can: stage, apply, reject,
                       withdraw                       withdraw, modify,
                       modify                         promote, rollback, defer

  ┌──────────┐      ┌──────────┐      ┌──────────┐
  │  staged   │─────▶│ inflight  │─────▶│ promoted  │
  └──────────┘      └──────────┘      └──────────┘
       │            accept    │            │
       │            Staged    │ promote    │ git sync
       │                      │            │ (code only)
       ▼                      ▼
   withdrawn/             rolled back
   rejected               (manual or
                           circuit breaker)
```

**Staged** — proposal exists in KV as `modification_staged:{id}`. Not yet
applied. Checks are evaluated each time the modification is loaded for
review.

**Inflight** — ops have been applied to KV. A snapshot of pre-modification
values is stored at `modification_snapshot:{id}` for rollback. The original
staged record is deleted.

**Promoted** — snapshot is deleted, changes are permanent. For code-type
modifications, a git sync is triggered.

There is also a **direct** path (`acceptDirect`) where deep reflect skips
staging entirely — the modification goes straight to inflight with no
intermediate staged record.

---

## Two Modification Types

### Code modifications

Standard self-modifications targeting tool code, hook code, prompts, config,
etc.

Required fields: `claims` (array of strings), `ops` (array of KV operations),
`checks` (array of check objects).

Behavior:
- Can be staged at any depth (orient, session reflect, deep reflect)
- Circuit breaker auto-rolls back on fatal error
- Git sync runs on promote
- Check results are evaluated on every load

### Wisdom modifications

Changes to yamas, niyamas, or other principle-level keys. Higher friction
by design.

Required fields: `validation` (object), `ops` (array of KV operations).
No `checks` or `claims` required.

Restrictions:
- Can only be staged by deep reflect (depth >= 1) — `stageModification`
  rejects wisdom at depth 0 (`hook-modifications.js:102`)
- Cannot use `acceptDirect` — must go through staging
  (`hook-modifications.js:228`)
- Circuit breaker skips wisdom modifications
  (`hook-modifications.js:454`)
- Git sync skips wisdom modifications (`hook-modifications.js:294`)
- Check evaluation is skipped when loading (no `checks` field)
- On `acceptStaged`, the `validation` object from the staged record is
  injected into each op's value (`hook-modifications.js:190-195`)

---

## Core Functions

### stageModification(K, request, sessionId, depth)

`hook-modifications.js:98`

Creates a staged modification record.

1. Validates type — wisdom requires `depth >= 1`
2. Validates required fields based on type (code: claims + ops + checks;
   wisdom: validation + ops)
3. Rejects if any op targets a bookkeeping key (`modification_staged:*` or
   `modification_snapshot:*`)
4. Generates ID: `m_{timestamp}_{random6}`
5. Writes `modification_staged:{id}` via `kvWritePrivileged`
6. Tracks in `activeStaged` array
7. Records karma event `modification_staged`

Returns the modification ID, or `null` on validation failure.

### acceptStaged(K, modificationId)

`hook-modifications.js:162`

Moves a staged modification to inflight by applying its ops.

1. Loads the staged record — throws if not found
2. Re-checks bookkeeping guard
3. Checks for inflight conflicts via `findInflightConflict` — throws on
   overlap
4. Snapshots current values of all target keys (value + metadata)
5. Builds write ops via `buildWriteOps` (handles `patch` op format)
6. For wisdom type: injects `validation` into each op's value object
7. Applies ops via `kvWritePrivileged`
8. Writes snapshot at `modification_snapshot:{id}`
9. Deletes the `modification_staged:{id}` record
10. Updates tracking arrays (remove from staged, add to inflight)
11. Records karma event `modification_accepted`

### acceptDirect(K, request, sessionId)

`hook-modifications.js:226`

Skips staging — creates an inflight modification directly. Used by deep
reflect's `modification_requests`.

1. Rejects wisdom type (must go through staging)
2. Validates required fields (claims, ops, checks)
3. Checks bookkeeping guard
4. Generates ID, checks for inflight conflicts (returns `null` on conflict
   instead of throwing)
5. Snapshots, applies, writes snapshot record with `type: "direct"`
6. Tracks in `activeInflight`

Key difference from `acceptStaged`: conflicts return `null` silently instead
of throwing.

### promoteInflight(K, modificationId, depth)

`hook-modifications.js:282`

Finalizes a modification — deletes the snapshot and triggers git sync.

1. Loads snapshot record (for ops/claims data)
2. Deletes `modification_snapshot:{id}`
3. Removes from `activeInflight` tracking
4. Records karma event `modification_promoted`
5. If type is not wisdom and ops exist: calls `syncToGit`

After promotion, there is no rollback path — the changes are permanent.

### rollbackInflight(K, modificationId, reason)

`hook-modifications.js:299`

Restores pre-modification state from the snapshot.

1. Loads snapshot record — returns silently if not found
2. For each snapshotted key:
   - If original value was `null`: deletes the key
   - Otherwise: restores original value and metadata via `kvWritePrivileged`
3. Deletes `modification_snapshot:{id}`
4. Removes from `activeInflight` tracking
5. Records karma event `modification_rolled_back` with reason

---

## Verdict Processing

Two separate verdict processors exist because session reflect and deep
reflect have different authority levels.

### Session reflect verdicts — processReflectVerdicts

`hook-modifications.js:365`

Called from `executeReflect` in `hook-reflect.js:97`. Operates on **staged**
modifications only.

| Verdict | Action |
|---------|--------|
| `withdraw` | Delete staged record, remove from tracking, karma `modification_withdrawn` |
| `modify` | Update staged record in-place with `updated_ops`, `updated_checks`, `updated_claims` (any subset), add `modified_at` timestamp |

Session reflect **cannot** accept, reject, promote, rollback, or defer.
It can only withdraw its own proposals or modify them.

### Deep reflect verdicts — processDeepReflectVerdicts

`hook-modifications.js:395`

Called from `applyReflectOutput` in `hook-reflect.js:223`. Full authority
over both staged and inflight modifications.

| Verdict | Action |
|---------|--------|
| `apply` | Calls `acceptStaged` — moves staged to inflight. Catches errors and records `modification_accept_failed` |
| `reject` | Delete staged record, remove from tracking, karma `modification_rejected` with reason |
| `withdraw` | Same as session reflect `withdraw` |
| `modify` | Same as session reflect `modify` — updates staged record in-place |
| `promote` | Calls `promoteInflight` — finalizes, triggers git sync |
| `rollback` | Calls `rollbackInflight` with reason `"deep_reflect_verdict"` |
| `defer` | Records karma `modification_deferred` with reason. No state change. |

### How verdicts flow through the reflection hierarchy

**Orient (depth 0):** Cannot issue verdicts. Can produce `kv_operations`
(gated by protection tier) but not modification requests or verdicts.

**Session reflect (depth 0):** Sees staged modifications with check results.
Can stage new modifications (`modification_requests`), withdraw existing
staged ones, or modify them. Cannot touch inflight modifications.
(`hook-reflect.js:96-103`)

**Deep reflect (depth >= 1):** Sees both staged and inflight modifications
with check results. Can issue any verdict. New `modification_requests` go
through `acceptDirect` (straight to inflight, no staging).
(`hook-reflect.js:237-242`)

> **NOTE:** Deep reflect's `modification_requests` use `acceptDirect`, which
> means they bypass the staging/review step entirely. The only review
> happens within the same LLM call that created them.

---

## Circuit Breaker

`hook-modifications.js:445` — `runCircuitBreaker(K)`

Called early in every wake cycle (`hook-main.js:65`), after modification
tracking is initialized but before the session runs.

### Trigger

The circuit breaker fires when a `last_danger` key exists in KV. This key
is written by the kernel (in `brainstem.js`) when a fatal error occurs
during hook execution — specifically via the hook safety tripwire system.
The value contains `{ t: <timestamp> }`.

### Behavior

1. Reads `last_danger` — returns immediately if not set
2. Iterates over all `activeInflight` modification IDs
3. For each inflight modification:
   - Skips wisdom-type modifications
   - Compares `last_danger.t` against the modification's `activated_at`
   - If the danger timestamp is **>=** the activation time: rolls back
     the modification and records `circuit_breaker_fired`
4. Deletes `last_danger` to prevent repeat rollbacks on subsequent wakes

> **NOTE:** The comparison `lastDanger.t >= new Date(record.activated_at).getTime()`
> means the circuit breaker rolls back modifications that were activated
> **at or before** the danger event — not after it. This is correct: if a
> modification was applied before the crash, it's a rollback candidate.

### What doesn't get rolled back

- Wisdom modifications (skipped explicitly)
- Promoted modifications (no snapshot exists)
- Modifications activated after the danger timestamp

---

## Git Sync

Code modifications are synced to a git repository at `/home/swayambhu/self`
on promotion. This runs on the Akash compute node via the `akash_exec` tool.

### kvToPath mapping

`hook-modifications.js:479` — Maps KV keys to file paths in the git repo:

| KV key pattern | File path |
|----------------|-----------|
| `secret:*` | `null` (never synced) |
| `prompt:*` | `prompts/{name}.md` |
| `tool:{name}:code` | `tools/{name}.js` |
| `tool:{name}:meta` | `tools/{name}.meta.json` |
| `provider:{name}:code` | `providers/{name}.js` |
| `provider:{name}:meta` | `providers/{name}.meta.json` |
| `hook:{name}:manifest` | `hooks/{name}.manifest.json` |
| `hook:{name}:code` | `hooks/{name}.js` |
| `hook:{name}:{submodule}` | `hooks/{name}-{submodule}.js` |
| `config:*` | `config/{name}.json` |
| `channel:{name}:code` | `channels/{name}.js` |
| `channel:{name}:config` | `channels/{name}.config.json` |
| `doc:*` | `docs/{name}.md` |
| `providers` | `config/providers.json` |
| `wallets` | `config/wallets.json` |

Keys that don't match any pattern return `null` and are skipped.

### syncToGit(K, modificationId, ops, claims)

`hook-modifications.js:537`

1. Maps each op's key through `kvToPath` — skips unmappable keys
2. For `delete` ops: adds path to deletes list
3. For other ops: reads the current KV value and adds `{path, content}`
   to writes list
4. If no writes or deletes: returns (nothing to sync)
5. Builds commit message: `"modification promoted: {id} — {claims joined}"`
6. Creates a `git_pending:{modificationId}` record in KV with the full
   pending payload
7. Calls `attemptGitSync`

### attemptGitSync(K, modificationId, pending)

`hook-modifications.js:579`

Builds a shell script and executes it via `akash_exec`:

1. `mkdir -p` for all required directories
2. Writes files via base64 encoding to avoid shell escaping issues
3. `rm -f` for delete paths
4. **Secret scan**: greps written files against patterns for AWS keys,
   OpenAI keys, GitHub tokens, Slack tokens, and PEM private keys. If
   found: `git checkout -- .` and exits with error
5. `git add` all affected paths
6. `git diff --cached --quiet` — if no actual changes, outputs
   `NO_CHANGES` and exits cleanly
7. `git commit` and `git push`

On success (exit code 0 or output contains `NO_CHANGES`): deletes the
`git_pending:` key and records `git_sync_ok`.

On failure: leaves the `git_pending:` key in place and records
`git_sync_failed`.

### retryPendingGitSyncs(K)

`hook-modifications.js:645`

Called on every wake (`hook-main.js:68`), before the session runs. Lists
all `git_pending:*` keys (limit 50) and retries `attemptGitSync` for each.
Failed syncs from previous sessions get retried automatically.

---

## Conflict Detection

`hook-modifications.js:319` — `findInflightConflict(K, targetKeys)`

Before any modification can become inflight (via `acceptStaged` or
`acceptDirect`), the system checks whether any currently-inflight
modification touches the same keys.

1. Iterates over `activeInflight` IDs
2. For each: loads the snapshot record and checks if any of `targetKeys`
   exist in `record.snapshots`
3. Returns `{ id, keys: overlappingKeys }` on first conflict, or `null`

This prevents two inflight modifications from touching the same key
simultaneously — which would make rollback of one corrupt the other's
snapshot.

> **NOTE:** Conflict detection only checks inflight (snapshot) keys, not
> staged modifications. Two staged modifications targeting the same key
> won't conflict until one is accepted.

---

## Check Evaluation

Checks are the verification mechanism for code-type modifications. They are
evaluated both when loading modifications for review and after application.

### evaluateCheck(K, check)

`hook-modifications.js:46`

Two check types:

**`kv_assert`** — Reads a KV key, optionally drills into a dot-path, and
evaluates a predicate:
```json
{
  "type": "kv_assert",
  "key": "config:defaults",
  "path": "orient.model",
  "predicate": "equals",
  "expected": "anthropic/claude-sonnet-4-20250514"
}
```

**`tool_call`** — Executes a tool via `K.executeAction` and optionally
asserts on the result:
```json
{
  "type": "tool_call",
  "tool": "web_fetch",
  "input": { "url": "https://example.com/health" },
  "assert": { "predicate": "exists" }
}
```

If no `assert` is provided, the check passes as long as the tool executes
without throwing.

### evaluatePredicate(value, predicate, expected)

`hook-modifications.js:34`

| Predicate | Behavior |
|-----------|----------|
| `exists` | `value !== null && value !== undefined` |
| `equals` | `value === expected` (strict equality) |
| `gt` | `typeof value === "number" && value > expected` |
| `lt` | `typeof value === "number" && value < expected` |
| `matches` | `typeof value === "string" && new RegExp(expected).test(value)` |
| `type` | `typeof value === expected` |

Unknown predicates return `false`.

### evaluateChecks(K, checks)

`hook-modifications.js:77`

Runs all checks sequentially. Returns `{ all_passed: boolean, results: [] }`.

---

## Inflight Tracking

`hook-modifications.js:7-26`

Modification state is tracked in module-level arrays:

```js
let activeStaged = [];
let activeInflight = [];
```

### initTracking(staged, inflight)

Called once per wake in `hook-main.js:59-62`. Populates the arrays from
prefix scans of `modification_staged:*` and `modification_snapshot:*` keys.
The key prefix is stripped to extract just the modification ID.

### Why module-level state?

The hook modules run in a Worker Loader isolate (or direct import in dev).
Within a single wake cycle, the isolate persists, so module-level state
is consistent for the duration of that wake. On the next wake, a fresh
isolate is created and `initTracking` is called again.

The tracking arrays are the source of truth for which modifications
`findInflightConflict`, `runCircuitBreaker`, `loadStagedModifications`,
and `loadInflightModifications` iterate over. Every stage/accept/promote/
rollback/reject/withdraw operation updates these arrays via `_trackAdd`
and `_trackRemove`.

---

## Bookkeeping Guard

`hook-modifications.js:90-94`

A safety check prevents modifications from targeting their own bookkeeping
keys. Any op with a key starting with `modification_staged:` or
`modification_snapshot:` is rejected. This is checked in both
`stageModification` and `acceptStaged`/`acceptDirect`.

Without this guard, a modification could delete its own snapshot (preventing
rollback) or create fake staged records.

---

## Wake Cycle Integration

The modification protocol integrates with the wake cycle at these points
(`hook-main.js`):

1. **Lines 55-62**: Prefix scan + `initTracking` — loads existing staged
   and inflight IDs
2. **Line 65**: `runCircuitBreaker` — auto-rollback on danger signal
3. **Line 68**: `retryPendingGitSyncs` — retry failed git pushes
4. **Lines 116-120**: If deep reflect is due, `runReflect` is called
   instead of `runSession` — deep reflect has full verdict authority
5. **Session reflect** (`executeReflect`): loads staged modifications,
   processes verdicts (withdraw/modify only), stages new requests
6. **Deep reflect** (`applyReflectOutput`): loads both staged and inflight,
   processes all verdict types, creates direct inflight modifications
