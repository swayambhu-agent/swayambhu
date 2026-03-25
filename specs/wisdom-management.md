# Implementation Spec: Wisdom Management & Proposal Protocol Unification

## Overview

Two changes:

1. **Unify mutation protocol into the Proposal Protocol.** Rename `mutation_*` → `proposal_*` across the codebase. Add a `type` field (`"code"` or `"wisdom"`) so one engine handles both code changes and wisdom entries with appropriate validation for each.

2. **Add wisdom management** using two new KV prefixes (`upaya:` and `prajna:`). Replaces the existing single `wisdom` key. Wisdom entries go through the same Proposal Protocol lifecycle as code changes, but with `validation` instead of `claims + checks`.

## Design principles

- **Upaya** (discernment about the world) is available during act sessions — it informs action.
- **Prajna** (self-knowledge) is available during deep reflect sessions — it informs introspection.
- **Deep reflect knows about both** — it's the only place wisdom gets written, and upaya context may be relevant when reviewing how act sessions went.
- **No pre-loading.** The agent has kv_query available and decides when to query wisdom. No template vars, no forced injection.
- **One protocol, two modes.** Code proposals require `claims + checks` and enable circuit breaker + git sync. Wisdom proposals require `validation` and skip both.
- **No code-level schema enforcement.** The wisdom JSON schema is a prompt convention. Validation criteria are evaluated by the reviewing deep reflect, not mechanically.

## The Proposal Protocol

### Lifecycle (applies to both code and wisdom)

```
staged ──accept──→ inflight ──promote──→ promoted
  │                   │
  ├──reject───→ ∅     ├──rollback──→ (restore snapshot)
  ├──withdraw─→ ∅     │
  ├──modify───→ staged │
  └──defer────→ staged └──defer──→ inflight
```

### KV prefixes

```
proposal_staged:{id}     — proposed change, not yet active
proposal_snapshot:{id}   — saved previous state for rollback
```

### States

| State | Meaning |
|---|---|
| **staged** | Proposed, not yet active. Awaiting review by a subsequent deep reflect. |
| **inflight** | Active, snapshot held. The change is live but reversible. |
| **promoted** | Validated, snapshot deleted. Permanent. |

### Verdicts

| Verdict | Applies to | Meaning |
|---|---|---|
| **accept** | staged | Activate it (becomes inflight) |
| **reject** | staged | Discard it |
| **withdraw** | staged | Take back your own proposal |
| **modify** | staged | Edit before accepting |
| **defer** | staged or inflight | Not enough data yet, revisit next time |
| **promote** | inflight | Validated, delete snapshot |
| **rollback** | inflight | Revert to snapshot |

### Leveling

Every promoted proposal has a **level** equal to the reflect depth that promoted it:

- Depth-1 reflect promotes a proposal → level 1
- Depth-2 reflect promotes a proposal → level 2

**Authority rule (prompt-enforced):** Before modifying, rolling back, or deleting any promoted entry — code or wisdom — check whether it was promoted by a higher-depth reflect than your current depth. If so:
- Do NOT touch the entry
- Flag it as needing review at the next higher-depth session
- Defer with a reason explaining why you think it should be reconsidered

This is prompt-enforced, not mechanically gated. The single source of truth for levels is the karma log — the `proposal_promoted` event records the proposal ID, target keys, and promoting depth. Deep reflect checks karma before modifying any promoted entry.

Human input (from chats, emails, patron feedback) is treated as evidence, not authority. Deep reflect evaluates human input alongside karma logs and other signals when proposing or reviewing proposals. Humans are a source, not an override — the agent is the authority on its own wisdom and configuration.

### Two modes

#### Code proposals (`type: "code"`)

For system config, prompts, tools, providers — changes that could brick the agent.

```json
{
  "type": "code",
  "claims": ["What this proposal achieves"],
  "ops": [
    {"op": "put", "key": "config:defaults", "value": {"act": {"effort": "medium"}}}
  ],
  "checks": [
    {"type": "kv_assert", "key": "config:defaults", "path": "act.effort", "predicate": "equals", "expected": "medium"}
  ]
}
```

- Signal mechanism: `claims` + `checks` (mechanical: `kv_assert`, `tool_call`)
- Circuit breaker: yes — auto-rollback on fatal error
- Git sync: yes — promoted proposals sync to repo
- Who can propose: session reflect (staged) or deep reflect (direct/inflight)

#### Wisdom proposals (`type: "wisdom"`)

For upaya and prajna entries — accumulated understanding that should be earned.

```json
{
  "type": "wisdom",
  "validation": "Observed in 4 sessions where 'urgent' requests turned out to be flexible. Would be falsified by genuine time-critical situations being missed.",
  "ops": [
    {"op": "put", "key": "upaya:timing:urgency", "value": {
      "text": "Urgency is usually manufactured. Real emergencies are obvious.",
      "type": "upaya",
      "created": "2026-03-14T10:30:00Z",
      "sources": [
        {"session": "s_abc123", "depth": 1, "turn": 3, "topic": "client escalation turned out to be non-urgent"},
        {"session": "s_def456", "depth": 1, "turn": 5, "topic": "rush deployment request was actually flexible by a week"}
      ]
    }}
  ]
}
```

- Signal mechanism: `validation` field (evaluated by reviewing deep reflect)
- Circuit breaker: no — bad wisdom can't crash the system
- Git sync: no — wisdom is runtime-only
- Who can propose: deep reflect only

## Changes required

### 1. Rename `mutation_*` → `proposal_*` across codebase

This is a mechanical rename. Every occurrence of:
- `mutation_staged:` → `proposal_staged:`
- `mutation_rollback:` → `proposal_snapshot:`

And in code identifiers:
- `stageMutation` → `stageProposal`
- `applyStaged` → `acceptStaged` (aligns with verdict name)
- `applyDirect` → `acceptDirect`
- `promoteInflight` → `promoteInflight` (unchanged)
- `rollbackInflight` → `rollbackInflight` (unchanged)
- `findInflightConflict` → `findInflightConflict` (unchanged)
- `loadStagedMutations` → `loadStagedProposals`
- `loadInflightMutations` → `loadInflightProposals`
- `processReflectVerdicts` → `processReflectVerdicts` (unchanged)
- `processDeepReflectVerdicts` → `processDeepReflectVerdicts` (unchanged)
- `runCircuitBreaker` → `runCircuitBreaker` (unchanged)
- `generateMutationId` → `generateProposalId`
- `BOOKKEEPING_PREFIXES` updated to `['proposal_staged:', 'proposal_snapshot:']`

**Files affected:**
- `kernel.js` — `SYSTEM_KEY_PREFIXES`, `kvWriteGated`, karma event names
- `kernel.js (kvWriteGated)` — `SYSTEM_KEY_PREFIXES`
- `kernel.js (proposal methods)` → rename file to `kernel.js (proposal methods)` — all function names, KV key references, karma event names
- `reflect.js` — imports, function calls
- `act.js` — imports, function calls
- `prompts/deep-reflect.md` — terminology throughout
- `prompts/reflect.md` — terminology
- `prompts/act.md` — terminology
- `docs/doc-mutation-guide.md` → rename to `docs/doc-proposal-guide.md`
- `tests/kernel.test.js` — all references
- `tests/wake-hook.test.js` — all references
- `scripts/seed-local-kv.mjs` — KV key references if any

Karma event names update:
- `mutation_staged` → `proposal_staged`
- `mutation_applied` → `proposal_accepted`
- `mutation_promoted` → `proposal_promoted`
- `mutation_rolled_back` → `proposal_rolled_back`
- `mutation_rejected` → `proposal_rejected`
- `mutation_deferred` → `proposal_deferred`
- `mutation_withdrawn` → `proposal_withdrawn`
- `mutation_modified` → `proposal_modified`
- `mutation_conflict` → `proposal_conflict`
- `mutation_invalid` → `proposal_invalid`
- `mutation_blocked` → `proposal_blocked`
- `circuit_breaker_fired` → `circuit_breaker_fired` (unchanged)

### 2. Add `type` field to proposal protocol

In `kernel.js (proposal methods)` (formerly kernel.js (proposal methods)):

**`stageProposal()`** — updated signature to accept `depth`:
```js
// Before
export async function stageMutation(K, request, sessionId)
// After
export async function stageProposal(K, request, sessionId, depth = 0)
```

Callers must pass depth: session reflect passes 0, deep reflect passes its current depth.

Staged record structure:
```js
value: {
  id,
  type: request.type || 'code',  // default to 'code' for backwards compat
  claims: request.claims,        // required for code, ignored for wisdom
  ops: request.ops,
  checks: request.checks,        // required for code, ignored for wisdom
  validation: request.validation, // required for wisdom, ignored for code
  staged_at: new Date().toISOString(),
  staged_by_session: sessionId,
  staged_by_depth: depth,
}
```

**Validation on stage:**
- `type: "code"` requires `claims` and `checks` (existing behavior)
- `type: "wisdom"` requires `validation` field, does not require `claims` or `checks`

**`stageProposal()`** — reject wisdom from session reflect:
```js
// Wisdom can only be staged by deep reflect (depth >= 1)
// Session reflect (depth 0) should flag observations in note_to_future_self instead
if (request.type === 'wisdom' && depth < 1) {
  await K.karmaRecord({ event: "proposal_invalid", reason: "wisdom can only be staged by deep reflect" });
  return null;
}
```

**`acceptDirect()`** — reject wisdom:
```js
// Wisdom must go through staging — no same-session accept
// The proposing session and validating session must be different
if (request.type === 'wisdom') {
  await K.karmaRecord({ event: "proposal_invalid", reason: "wisdom cannot use acceptDirect — must be staged" });
  return null;
}
```

**`runCircuitBreaker()`** — skip wisdom proposals:
```js
// Only auto-rollback code proposals on fatal error
if (record.type === 'wisdom') continue;
```

**`promoteInflight()`** — updated signature to accept `depth`, include it in karma:
```js
// Before
export async function promoteInflight(K, mutationId)
// After
export async function promoteInflight(K, proposalId, depth)
```

**`processDeepReflectVerdicts()`** — updated signature to accept `depth` and pass it through:
```js
// Before
export async function processDeepReflectVerdicts(K, verdicts)
// After
export async function processDeepReflectVerdicts(K, verdicts, depth)
```

Required so it can pass `depth` to `promoteInflight` when processing promote verdicts.

The karma event must record depth and target keys for leveling:
```js
await K.karmaRecord({
  event: "proposal_promoted",
  proposal_id: proposalId,
  target_keys: record.ops.map(op => op.key),
  depth,
});
```

**`acceptStaged()`** — for wisdom proposals, inject `validation` from the staged record into the op's value before writing to the live key:
```js
if (record.type === 'wisdom' && record.validation) {
  for (const op of writeOps) {
    if (op.value && typeof op.value === 'object') {
      op.value.validation = record.validation;
    }
  }
}
```
This ensures the live entry has `validation` from the moment it goes inflight, not only after promotion.

**`syncToGit()` / `promoteInflight()`** — skip git sync for wisdom:
```js
if (record?.type !== 'wisdom' && record?.ops) {
  await syncToGit(K, proposalId, record.ops, record.claims);
}
```

### 3. Update protected keys

**kernel.js:**
```js
// Remove 'wisdom' from exact keys
static SYSTEM_KEY_EXACT = ['providers', 'wallets'];

// Add upaya: and prajna: to prefix list (forces all writes through kvWriteGated / Proposal Protocol)
static SYSTEM_KEY_PREFIXES = [
  'prompt:', 'config:', 'tool:', 'provider:', 'secret:',
  'proposal_staged:', 'proposal_snapshot:', 'hook:', 'git_pending:',
  'yama:', 'niyama:',
  'upaya:', 'prajna:',
];
```

**kernel.js (kvWriteGated)** — Same changes to both `SYSTEM_KEY_EXACT` and `SYSTEM_KEY_PREFIXES`.

This ensures upaya/prajna entries can only be written through the Proposal Protocol — `kv_operations` from reflect output will be blocked by the protection gate, just like attempts to write prompts or config directly.

**Do NOT add `upaya:` or `prajna:` to `PRINCIPLE_PREFIXES`.** That array (`['yama:', 'niyama:']`) gates the deliberation + model capability checks in `kvWriteGated`. Wisdom entries should not require deliberation — the Proposal Protocol's staging lifecycle provides the signal mechanism instead.

### 4. Update deep reflect prompt (prompts/deep-reflect.md)

Remove the `{{wisdom}}` template section (lines 14-17 of deep-reflect.md):
```markdown
<!-- DELETE from here -->
## Your accumulated wisdom

{{wisdom}}
<!-- DELETE to here (inclusive — remove the blank line after {{wisdom}}) -->
```

Replace all "mutation" terminology with "proposal" throughout the prompt.

Add the following section after the "What to do" heading:

```markdown
## Your wisdom

You maintain two kinds of wisdom in KV, accumulated through experience and reflection:

- **Prajna** (`prajna:*`) — self-knowledge. Understanding of your own patterns, tendencies, strengths, and blind spots.
- **Upaya** (`upaya:*`) — discernment about the world. Transferable judgment about how situations work, how people behave, when to act and when to wait.

**Before you begin reflecting, query your `prajna:*` entries to ground your reflection in accumulated self-knowledge. Also query `upaya:*` entries relevant to the sessions you're reviewing.**

Wisdom goes through the same Proposal Protocol as code changes, but with `type: "wisdom"`. You propose wisdom in one session; a different session validates it. You don't grade your own homework.

To stage a new wisdom entry, include a proposal request with `type: "wisdom"`:

```json
{
  "type": "wisdom",
  "validation": "Observed in 4 sessions where 'urgent' requests turned out to be flexible. Would be falsified by genuine time-critical situations being missed.",
  "ops": [
    {"op": "put", "key": "upaya:timing:urgency", "value": {
      "text": "Urgency is usually manufactured. Real emergencies are obvious.",
      "type": "upaya",
      "created": "2026-03-14T10:30:00Z",
      "sources": [
        {"session": "s_abc123", "depth": 1, "turn": 3, "topic": "client escalation turned out to be non-urgent"},
        {"session": "s_def456", "depth": 1, "turn": 5, "topic": "rush deployment request was actually flexible by a week"}
      ]
    }}
  ]
}
```

The `validation` field replaces `claims + checks` for wisdom. It's a natural-language statement of what evidence supports this wisdom and what would falsify it. When you review staged wisdom in a subsequent session, evaluate the validation against recent karma.

Note: `validation` lives on the proposal request (like `claims` for code), not duplicated inside the op's value. The engine stores it on the staged record. When a wisdom proposal is accepted, the engine injects `validation` from the staged record into the live entry's JSON value. Single source of truth during staging; embedded in the entry once live.

### When to write wisdom

Write upaya when you identify:
- A pattern in how situations, people, or contexts work
- A judgment call that succeeded or failed and carries a transferable lesson
- A pattern observed in human feedback (chats, emails, patron corrections)
- A general principle that would serve across many different situations

Write prajna when you identify:
- A recurring pattern in your own reasoning or behavior
- A bias or blind spot that affected outcomes
- A strength to leverage more deliberately
- An insight about how your own processes work or fail

Do NOT write wisdom for:
- One-off events unlikely to recur
- Facts or data (those belong in notes)
- Restatements of yamas or niyamas
- Domain-specific technical knowledge (belongs in notes)

The test: would a wise person carry this understanding regardless of what domain they're working in? If yes, it's upaya. If it's only useful in a specific technical context, it's a note.

### Wisdom key naming

Use descriptive, hierarchical keys. You manage the taxonomy yourself.

Upaya examples:
```
upaya:communication:less-is-more
upaya:timing:urgency
upaya:trust:earned
upaya:action:reversibility
upaya:people:listening
```

Prajna examples:
```
prajna:reasoning:complexity-bias
prajna:reasoning:confidence
prajna:communication:overexplaining
prajna:resource:time-estimation
```

### Wisdom schema

Every live wisdom entry is stored as JSON (validation is injected by the engine at accept time):

```json
{
  "text": "What people ask for and what they need are often different things.",
  "type": "upaya",
  "created": "2026-03-14T10:30:00Z",
  "updated": "2026-04-01T10:00:00Z",
  "validation": "Observed in 3+ sessions where stated request diverged from actual need. Would be falsified by consistent alignment between requests and underlying needs.",
  "sources": [
    {"session": "s_abc123", "depth": 1, "turn": 3, "topic": "user asked for quick fix, needed architecture"},
    {"session": "s_def456", "depth": 1, "turn": 7, "topic": "budget question masking resource concern"}
  ]
}
```

Fields:
- `text` — the wisdom itself, concise and actionable
- `type` — "upaya" or "prajna"
- `created` — when first written
- `updated` — when last modified
- `validation` — what evidence supports this and what would falsify it
- `sources` — array of sessions that contributed to this wisdom
  - `session` — session ID (karma key)
  - `depth` — reflect depth level (0, 1, 2, …)
  - `turn` — specific turn within the session where the insight crystallized
  - `topic` — brief description of what that session/turn contributed

### Wisdom maintenance

Each deep reflect session should:
- Review all staged wisdom proposals — issue verdicts (accept, reject, modify, defer)
- Review all inflight wisdom proposals — issue verdicts (promote, rollback, defer)
- Consolidate overlapping promoted entries
- Delete promoted wisdom no longer applicable
- Verify no entry contains domain-specific technical knowledge (move to notes)
- Verify upaya entries are about the world, prajna entries are about yourself
- Verify upaya entries remain aligned with your yamas (outer principles govern outer wisdom)
- Verify prajna entries remain aligned with your niyamas (inner principles govern inner wisdom)
```

### 5. Update deep reflect output schema

In the deep reflect prompt's "What to produce" section, rename `mutation_requests` → `proposal_requests` and `mutation_verdicts` → `proposal_verdicts`. Update the example to show both code and wisdom types:

```json
{
  "reflection": "...",
  "note_to_future_self": "...",
  "kv_operations": [],

  "proposal_requests": [
    {
      "type": "code",
      "claims": ["Update act effort to medium"],
      "ops": [{"op": "put", "key": "config:defaults", "value": {"act": {"effort": "medium"}}}],
      "checks": [{"type": "kv_assert", "key": "config:defaults", "path": "act.effort", "predicate": "equals", "expected": "medium"}]
    },
    {
      "type": "wisdom",
      "validation": "...",
      "ops": [{"op": "put", "key": "upaya:timing:urgency", "value": {"text": "...", "type": "upaya", "created": "...", "sources": [{"session": "...", "depth": 1, "turn": 3, "topic": "..."}]}}]
    }
  ],

  "proposal_verdicts": [
    {"proposal_id": "m_...", "verdict": "accept"},
    {"proposal_id": "m_...", "verdict": "reject", "reason": "..."},
    {"proposal_id": "m_...", "verdict": "promote"},
    {"proposal_id": "m_...", "verdict": "rollback", "reason": "..."},
    {"proposal_id": "m_...", "verdict": "defer", "reason": "need more sessions"},
    {"proposal_id": "m_...", "verdict": "modify", "updated_ops": []}
  ],

  "next_reflect": {},
  "next_wake_config": {}
}
```

### 6. Update session reflect prompt and output schema (prompts/reflect.md)

Rename `mutation_requests` → `proposal_requests` and `mutation_verdicts` → `proposal_verdicts` throughout.

Add wisdom awareness:

```markdown
Your wisdom is stored across two KV prefixes: `upaya:*` (discernment about
the world) and `prajna:*` (self-knowledge). You don't write wisdom here —
that happens in deep reflect. But if this session revealed a pattern worth
crystallizing, flag it in `note_to_future_self`.
```

Update the protected keys reference to remove mention of wisdom.

### 7. Update act prompt (prompts/act.md)

Add upaya awareness after the tools section:

```markdown
Your `upaya:*` keys contain accumulated wisdom about the external world —
discernment about situations, people, timing, and action. Begin by querying
your upaya entries relevant to your current task via `kv_query`.
```

Rename any `mutation_requests` references to `proposal_requests`.

Update the protected keys line to remove mention of wisdom:
```markdown
Protected keys (prompts, config) require proposal_requests via reflect.
```

### 8. Remove `{{wisdom}}` template var from reflect.js

In `gatherReflectContext` (reflect.js), remove the wisdom loading:
```js
// DELETE this line
const wisdom = await K.kvGet("wisdom");
```

And remove `wisdom` from the `templateVars` object.

### 9. Add staged/inflight context to deep reflect template vars

In `gatherReflectContext` (reflect.js), the existing code already loads staged and inflight proposals (formerly mutations). These now include both code and wisdom types automatically — no separate wisdom loading needed.

Rename the template vars:
- `stagedMutations` → `stagedProposals`
- `inflightMutations` → `inflightProposals`

Update corresponding template sections in deep-reflect.md:
```markdown
## Staged proposals (awaiting review)

{{stagedProposals}}

## Inflight proposals (active, snapshot held)

{{inflightProposals}}
```

The existing `loadStagedProposals()` and `loadInflightProposals()` functions (renamed from mutation equivalents) will return both code and wisdom proposals since they both use the same `proposal_staged:` and `proposal_snapshot:` prefixes.

Note: the current deep-reflect.md template uses `{{candidateMutations}}` but the code provides `inflightMutations` — these don't match (pre-existing bug). The rename to `{{inflightProposals}}` / `inflightProposals` fixes this by making both sides consistent.

### 10. Update seed script

In `scripts/seed-local-kv.mjs`, remove:
```js
await put("wisdom", "", "text", "Accumulated insights from past reflections — grows over time");
```

Remove `wisdom` from default_load_keys:
```js
// Before
memory: { default_load_keys: ["wisdom", "config:models", "config:resources"], ... }
// After
memory: { default_load_keys: ["config:models", "config:resources"], ... }
```

### 11. Update git sync mapping

In `kernel.js (proposal methods)`, remove the old wisdom mapping from `kvToPath`:
```js
// DELETE this line
if (key === 'wisdom') return 'wisdom.md';
```

### 12. Update hook manifest

Hook keys use the direct-key architecture (no manifest):
- `hook:act:code` — act.js source
- `hook:reflect:code` — reflect.js source
- Proposal mechanics and kvWriteGated are in kernel.js (no separate hook keys)

Update imports in `act.js` and `reflect.js` accordingly.

## What NOT to change

- **No new tools.** kv_query already supports arbitrary keys.
- **No schema enforcement in code.** Prompt convention only.
- **No kernel-level validation of wisdom.** The reviewing deep reflect evaluates validation criteria, not the kernel.
- **Upaya and prajna are system-protected prefixes.** All writes go through the Proposal Protocol — no direct `kv_operations` bypass.

## Architecture context

Updated hierarchy:

| Layer | Outer | Inner | Protection |
|---|---|---|---|
| Principles | Yama (conduct) | Niyama (discipline) | Kernel-enforced friction |
| Wisdom | Upaya (discernment) | Prajna (self-knowledge) | Proposal Protocol (wisdom mode) |
| Record | Karma | | Append-only |

- Dharma is immutable (kernel-blocked)
- Yamas require deliberation + capable model (kernel-enforced)
- Niyamas require deliberation + capable model (kernel-enforced)
- Code changes go through Proposal Protocol with claims + checks, circuit breaker, git sync
- Wisdom goes through Proposal Protocol with validation, no circuit breaker, no git sync
- Karma is append-only record

## Files to modify

| File | Change |
|---|---|
| `kernel.js` | Remove `wisdom` from `SYSTEM_KEY_EXACT`; add `upaya:`, `prajna:` to `SYSTEM_KEY_PREFIXES`; do NOT add them to `PRINCIPLE_PREFIXES` (no deliberation gate); rename all `mutation_*` → `proposal_*` in prefixes, method names, karma events |
| `kernel.js (kvWriteGated)` | Remove `wisdom` from `SYSTEM_KEY_EXACT`; add `upaya:`, `prajna:` to `SYSTEM_KEY_PREFIXES`; rename `mutation_*` → `proposal_*` in prefixes |
| `kernel.js (proposal methods)` | Rename file → `kernel.js (proposal methods)`; rename all functions, KV keys, karma events; add `type` field handling; skip circuit breaker + git sync for wisdom type |
| `reflect.js` | Update imports from hook-proposals; rename function calls; remove `wisdom` loading from `gatherReflectContext`; rename template vars; pass `depth` to `stageProposal`, `processDeepReflectVerdicts`, and callers of `promoteInflight` |
| `act.js` | Update imports from hook-proposals; rename function calls |
| `hook-chat.js` | Remove `K.kvGet("wisdom")` loading; optionally add upaya awareness to chat context |
| `prompts/deep-reflect.md` | Remove `{{wisdom}}` section; add wisdom management instructions; rename all mutation → proposal terminology; update output schema |
| `prompts/act.md` | Add upaya awareness; rename mutation → proposal; remove wisdom from protected keys |
| `prompts/reflect.md` | Add wisdom awareness; rename mutation → proposal; remove wisdom from protected keys; update output schema |
| `scripts/seed-local-kv.mjs` | Remove wisdom seed; remove from default_load_keys; update any mutation references |
| `docs/agent/proposal-guide.md` | Update all terminology |
| `tests/kernel.test.js` | Rename all `mutation_*` references |
| `tests/wake-hook.test.js` | Rename all `mutation_*` references |
| Hook manifest | Update `kernel.js (proposal methods)` → `kernel.js (proposal methods)` mapping |
