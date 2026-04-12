# DR Self-Modification: Config, Prompts, and Code

## Staleness Note (2026-04-12)

This document is materially stale against the live code base.

Concrete drift:

- it describes direct DR code staging as the active architecture
- live runtime now routes governed code changes through the DR-2 lab path and
  governor handoff instead of direct DR staging
- it describes config/prompt rollback as manual-only operator action
- current architecture now includes governed post-deploy rollback design work
  in:
  - `docs/superpowers/specs/2026-04-10-dr1-dr2-self-modification-handoff-design.md`
  - `docs/superpowers/specs/2026-04-12-probationary-semantic-rollback-and-deployment-review.md`

Keep this file as historical design context, not as the current source of
truth for self-modification or rollback behavior.

## Purpose

Enable deep-reflect (DR) to modify the agent's config, prompts, and code
through the existing output format and kernel primitives. Currently DR can
only write patterns, desires, tactics, and principles. The kernel already
supports writing config/prompts (`kvWriteGated`) and staging code
(`stageCode` + `signalDeploy`), but the userspace filter in `applyDrResults`
blocks these key prefixes and DR's context tarball doesn't include the
content it would need to modify.

This is not a new architecture — it's unblocking what's already designed.

## What This Enables

DR can now:
- Fix prompts that cause behavioral problems (e.g. missing autonomous agent framing)
- Adjust config values based on observed performance (model choices, budget splits, intervals)
- Stage code fixes for tools, hooks, providers, channels (governor deploys them)
- All through the existing `kv_operations` and `code_stage_requests` output format

## What This Does NOT Change

- Act agent still cannot write protected keys
- DR still runs as an async job returning structured JSON
- Governor still handles code deployment with snapshot/rollback
- All existing safety gates remain (immutable keys, kernel-only keys, 50-write limit)
- The act/DR separation is unchanged — act observes, DR reflects and modifies

## Changes

### 1. Widen `applyDrResults` key filter (`userspace.js`)

**Current** (line ~876): filters to `pattern:*`, `desire:*`, `tactic:*`, `principle:*`

**Change:** Add `config:*` and `prompt:*` to the allowed prefixes:

```javascript
const ops = (output.kv_operations || []).filter(op =>
  op.key?.startsWith("pattern:") ||
  op.key?.startsWith("desire:") ||
  op.key?.startsWith("tactic:") ||
  op.key?.startsWith("principle:") ||
  op.key?.startsWith("config:") ||
  op.key?.startsWith("prompt:")
);
```

These keys already pass through `_gateSystem` in the kernel which enforces:
- Deep-reflect context requirement
- 50 privileged writes per session max
- Karma audit trail with before/after values (`privileged_write` event)
- Kernel alerts on hook writes
- Auto-reload of config keys after write

### 2. Add deliberation requirement for prompt writes (`kernel.js`)

**Gap:** `_gateSystem` requires 200+ char deliberation for `principle:*` and
`config:model_capabilities` but not for general `config:*` or `prompt:*` writes.
A careless prompt change can disable entire subsystems (e.g. deleting
`prompt:deep_reflect` would halt DR).

**Change:** In `_gateSystem`, add deliberation requirement for `prompt:*` writes:

```javascript
// After existing principle/capability checks:
if (key.startsWith("prompt:") && (!op.deliberation || op.deliberation.length < 200)) {
  return { blocked: true, reason: "prompt changes require 200+ char deliberation" };
}
```

### 3. Expand DR context tarball (`userspace.js`)

**Current** `dispatchDr` context_keys (line ~807):
```javascript
context_keys: [
  "pattern:*", "experience:*", "desire:*", "tactic:*",
  "action:*", "principle:*",
  "config:defaults", "config:tool_registry",
  "kernel:source_map",
  "reflect:1:*", "last_reflect",
]
```

**Change:** Add keys DR needs to reason about self-modification:
```javascript
context_keys: [
  "pattern:*", "experience:*", "desire:*", "tactic:*",
  "action:*", "principle:*",
  "config:defaults", "config:models", "config:model_capabilities",
  "config:tool_registry", "config:event_handlers",
  "prompt:plan", "prompt:act", "prompt:reflect", "prompt:communication",
  "tool:*:meta",
  "kernel:source_map",
  "reflect:1:*", "last_reflect",
]
```

Note: `prompt:deep_reflect` is already passed as the DR prompt itself. Tool
code (`tool:*:code`) is available via `kernel:source_map` references — DR
can request specific files through its code staging output if needed.

### 4. Update DR prompt (`prompts/deep_reflect.md`)

Add a new section documenting config/prompt modification capabilities:

```markdown
## Config and Prompt Modification

You can propose changes to config:* and prompt:* keys via kv_operations.

When to modify config:
- Observed performance data justifies a parameter change (e.g. model choice,
  budget split, interval timing)
- A config value contradicts observed behavior or principles

When to modify prompts:
- The agent consistently misframes its situation due to prompt wording
- A prompt is missing context the agent needs for correct reasoning
- A prompt contradicts the cognitive architecture design

Requirements:
- prompt:* changes require a deliberation field (200+ chars) explaining
  why the change is needed and what behavior it will produce
- Be conservative — small, targeted changes. Don't rewrite entire prompts.
- Changes take effect on the next session (prompts are read live from KV)

Example kv_operations:
[
  {
    "op": "patch",
    "key": "config:defaults",
    "old_string": "\"reflect_reserve_pct\": 0.33",
    "new_string": "\"reflect_reserve_pct\": 0.4"
  },
  {
    "op": "put",
    "key": "prompt:plan",
    "value": "...",
    "deliberation": "The plan prompt lacks autonomous agent framing, causing
    the planner to reason as a reactive chatbot when desires are empty. Adding
    a single paragraph establishing that desires emerge from DR, not user input.
    This prevents the 'awaiting user input' failure mode observed in sessions 1-3."
  }
]
```

Also update the existing output contract comments to include config:* and prompt:*
in the kv_operations documentation.

### 5. Rollback strategy

**Code changes:** Governor already has snapshot-based rollback triggered by
the 3-crash tripwire. No changes needed.

**Config/prompt changes:** No automatic runtime rollback. The safety gates
(deliberation, write limits, deep-reflect gating) are the primary protection.
`_gateSystem` records every protected write in karma as `privileged_write`
with `old_value` and `new_value` — this provides the data for manual rollback.

For v0.1, rollback of config/prompt changes is an **operator action** — the
dev loop detects behavioral regression, and the operator uses
`scripts/rollback-session.mjs` (or a future dashboard action) to reverse
specific session writes.

Why not automatic: bad prompts cause degraded behavior, not crashes. The
3-crash tripwire is the wrong signal. Behavioral regression detection is
the dev loop's job, not the kernel's.

## Safety Model

| Layer | Protection |
|---|---|
| **Immutable keys** | dharma, patron:public_key — never writable |
| **Kernel-only keys** | karma:*, sealed:*, kernel:* — never writable |
| **Deep-reflect gating** | config:*, prompt:* only writable in DR context |
| **Deliberation** | prompt:*, principle:*, config:model_capabilities require 200+ chars |
| **Write limit** | 50 privileged writes per session max |
| **Karma audit** | Before/after values recorded for every protected write |
| **Rollback** | `rollback-session.mjs` reverses privileged_write entries |
| **Code rollback** | Governor snapshots before deploy, 3-crash tripwire |
| **Act boundary** | Act agent cannot write protected keys — only DR |

## Files Changed

| File | Change |
|---|---|
| `userspace.js` | Widen `applyDrResults` key filter; expand `dispatchDr` context_keys |
| `kernel.js` | Add deliberation requirement for `prompt:*` in `_gateSystem` |
| `prompts/deep_reflect.md` | Document config/prompt modification capabilities |

## What's NOT in Scope

- No new tools
- No act-side changes
- No new rollback mechanism (reuse existing)
- No changes to governor pipeline
- No changes to code staging (already works)
- No `change_suggestions` field in review output (DR gets sufficient signal from experiences)
