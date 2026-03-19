# Modification Guide

How you self-modify — and why each step in the process exists.

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

**Why this lifecycle exists instead of direct writes:** Staging creates a review period. Inflight means changes are live but reversible (a snapshot exists). Promoted means permanent. This gives you time to observe effects before committing — a bad modification that's inflight can be rolled back; a promoted one cannot.

There is also a **direct** path (`acceptDirect`) where deep reflect skips staging — the modification goes straight to inflight. This exists because deep reflect has tools and multi-step reasoning, so it can investigate before proposing. Use it for straightforward changes you're confident about. For anything that might interact with other modifications or have subtle effects, stage it instead.

---

## Two modification types

### Code modifications

Target tool code, hook code, prompts, config, providers. Required fields: `claims` (array of strings explaining what and why), `ops` (array of KV operations), `checks` (array of verification checks).

- Can be staged at any depth (orient, session reflect, deep reflect)
- Circuit breaker auto-rolls back on fatal error
- Git sync runs on promote
- Check results are evaluated on every load

### Wisdom modifications

Target `viveka:*` and `prajna:*` keys. Required fields: `validation` (what evidence supports this, what would falsify it), `ops` (array of KV operations).

**Why wisdom has higher friction than code:** Wisdom shapes all future reasoning — it's loaded into reflect prompts and informs decisions. Unlike code, which can be tested and produces observable errors when broken, bad wisdom silently degrades judgment. The higher friction (staging required, no `acceptDirect`, deep reflect only) compensates for the difficulty of detecting wisdom problems.

Restrictions:
- Can only be staged by deep reflect (depth >= 1)
- Cannot use `acceptDirect` — must go through staging
- Circuit breaker does not roll back wisdom (it can't cause runtime crashes)
- Git sync skips wisdom (it's not deployable code)

---

## Verdicts and who can issue them

### Session reflect (depth 0) — limited authority

| Verdict | What it does | Why it exists |
|---------|-------------|---------------|
| `withdraw` | Deletes the staged record | You proposed something hasty — retract it |
| `modify` | Updates the staged record in-place | Refine a proposal based on what you observed this session |

Session reflect **cannot** accept, reject, promote, rollback, or defer. Why: it's a single LLM call with no tools and limited context. It sees the session karma and staged modifications but can't investigate further. Its job is honest assessment, not decision-making.

### Deep reflect (depth >= 1) — full authority

| Verdict | What it does | Why it exists |
|---------|-------------|---------------|
| `apply` | Moves staged → inflight | Satisfied with the proposal, make it live |
| `reject` | Deletes the staged record | Proposal is wrong or unnecessary |
| `withdraw` | Deletes the staged record | Same as session reflect |
| `modify` | Updates staged record in-place | Refine before accepting |
| `promote` | Deletes snapshot, triggers git sync | Observed in inflight, satisfied it works |
| `rollback` | Restores snapshot | Something went wrong while inflight |
| `defer` | Records karma, no state change | Not ready to decide — revisit next time |

---

## Checks

Checks verify that modifications work as intended. Two types:

**`kv_assert`** — Read a KV key, drill into a path, test a predicate. Use for: verifying config values are correct, confirming a tool's meta was updated, checking that a prompt contains expected content.

**`tool_call`** — Execute a tool and optionally assert on the result. Use for: verifying a tool works end-to-end after modifying its code, checking that an external service is reachable.

Available predicates: `exists`, `equals`, `gt`, `lt`, `matches` (regex), `type` (typeof).

Checks are evaluated when loading modifications for review and after application. Write checks that will catch the failure modes you're worried about.

---

## Conflict detection

Before any modification becomes inflight, the system checks whether any currently-inflight modification touches the same keys. Why: if two inflight modifications touch the same key, rolling back one would corrupt the other's snapshot (the snapshot contains the pre-modification value, which is now the other modification's value).

This means: if you have an inflight modification touching `prompt:orient`, you cannot accept another modification that also touches `prompt:orient` until the first one is promoted or rolled back.

Conflict detection only checks inflight keys, not staged. Two staged modifications targeting the same key won't conflict until one is accepted.

---

## Circuit breaker

When a `last_danger` signal exists in KV (written by the kernel on fatal error), the circuit breaker fires on the next wake. It iterates all inflight code modifications and rolls back any that were activated at or before the danger timestamp.

**Why it skips wisdom:** Wisdom entries are text in prompts. They can cause bad decisions but not runtime crashes (no `TypeError`, no infinite loops). The circuit breaker is for code-level failures.

**Why it checks timestamps:** Not every inflight modification caused the crash. Only modifications activated before the crash are suspects. Modifications activated after (in a different session) are innocent.

---

## Git sync

When a code modification is promoted, its ops are mapped to file paths and synced to the git repository on the remote server via the `computer` tool. The sync includes a secret scan that rejects known credential patterns (AWS keys, OpenAI keys, GitHub tokens, Slack tokens, PEM keys).

**Why git sync exists:** KV is the runtime source of truth, but git provides history, diffing, and a second copy. If KV were corrupted or wiped, the git repo has the last-promoted state.

**Why failed syncs are retried:** Git sync failures (network issues, server down) shouldn't block modifications. The pending sync is stored and retried on every subsequent wake until it succeeds.

---

## The `patch` op

In addition to `put` and `delete`, ops support `patch` — a surgical find-and-replace within a string value. Use `patch` when modifying a prompt or config where you want to change a specific section without rewriting the entire value.

```json
{ "op": "patch", "key": "prompt:orient", "old_string": "original text", "new_string": "replacement text" }
```

The patch is rejected if `old_string` is not found or matches multiple locations (ambiguous). This prevents accidental modifications when the target value has changed since you last read it.

**When to use `patch` vs `put`:** Use `patch` for surgical edits to prompts, config fragments, or tool code where you want to change one part and leave the rest untouched. Use `put` when you're replacing the entire value or writing a new key. `patch` is safer for large values because it proves you know what you're changing.

---

## Common mistakes

1. **Forgetting checks.** Every code modification needs checks that will detect failure. "It worked when I tested" isn't sufficient — write a `kv_assert` or `tool_call` that future sessions can evaluate.

2. **Targeting bookkeeping keys.** Ops targeting `modification_staged:*` or `modification_snapshot:*` are always rejected. The modification protocol's own state is protected from the modifications it manages.

3. **Ignoring inflight conflicts.** If you get a null from `acceptDirect` or an error from `acceptStaged`, it means another inflight modification touches the same keys. Wait for it to be promoted or rolled back.

4. **Using `acceptDirect` for wisdom.** Always rejected. Wisdom must go through staging to get a review cycle.

5. **Modifying `config:model_capabilities` casually.** This key controls which models can modify principles and approve communications. It requires a capable model and 200+ char deliberation. Treat it with the same care as yama/niyama writes.
