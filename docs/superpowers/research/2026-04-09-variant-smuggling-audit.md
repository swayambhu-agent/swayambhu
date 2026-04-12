# Variant Smuggling Audit

Scope: re-audit the 4 variant-cycle outputs for field-role mismatch ("smuggling"), where cognitive text lands in the wrong container.

Series analyzed:
- `/home/swami/swayambhu/dev-loop/variant-series-2026-04-09T02-18-54-581Z/read-path-barrier`
- `/home/swami/swayambhu/dev-loop/variant-series-2026-04-09T02-18-54-581Z/write-path-support-gate`
- `/home/swami/swayambhu/dev-loop/variant-series-2026-04-09T02-18-54-581Z/hold-contracts`
- `/home/swami/swayambhu/dev-loop/variant-series-2026-04-09T02-18-54-581Z/bootstrap-engine-starter`

## Main result

The earlier finding was correct but incomplete. Smuggling did not only happen in `tactic:*`.

Strongly supported smuggling fields in this run set:
- `tactic:*`
- `last_reflect.carry_forward[*]`
- `experience.observation`
- outbound `request_message` content / patron-facing comms

Fields that looked mostly clean in this run set:
- `desire:*`
- `pattern:*` (mostly descriptive, though several are runtime/self-audit patterns rather than world-facing patterns)

## Field findings

### 1. `tactic:*` smuggling

Two distinct misuse shapes showed up:

- reflection-phase logic stored as a tactic
  - `read-path-barrier`
  - `tactic:ground-reflection-in-plan-reason-when-no-action-text-drifts`
  - this governs reflection/review, not act-time selection

- runtime/write-policy logic stored as a tactic
  - `write-path-support-gate`
  - `tactic:inspect-repeated-empty-debug-wakes`
  - this mixes:
    - scheduler policy (`idle-streak`, `circuit-breaker pressure`)
    - evidence policy (`internal_only`, `zero external anchors`)
    - wake-path plumbing (`inspect or coalesce`)

Interpretation:
- DR lacks a clean first-class channel for meta-policy/runtime suggestions
- so it stuffs them into `tactic:*`

### 2. `carry_forward` smuggling

The strongest examples were in `write-path-support-gate`:

- `s_22:cf1`
  - `If another wake arrives ... route it through monitoring/coalescing logic instead of generating another full idle-streak deliberation.`
- `session_24:cf1`
  - `Apply pattern:wake:internal-only-debug-repeat in next session ...`

These are not concrete next steps act can execute.
They are runtime-policy or metacognitive steering suggestions.

Interpretation:
- `carry_forward` is being used partly as an operational queue and partly as a policy patch channel
- that is another representational gap

### 3. `experience.observation` smuggling

This was already known, but the four-variant re-audit confirms it is broad rather than isolated.

Observed patterns:
- `observation` contains `Reason: ...`
- `observation` includes planner rationale, tactic names, desire keys, or interpretive conclusion
- repeated no-action traces become narrative/justification rather than plain observation

Interpretation:
- the system still treats `observation` as a fallback bucket for internal reasoning
- this contaminates downstream pattern/desire learning

### 4. Outbound comms smuggling

Patron-facing `request_message` content leaked internal machinery in multiple branches:

- `read-path-barrier`
  - `carry-forward`
  - `desire:...`
  - `no_action`
  - `circuit-breaker`
  - `dev_loop` / debug-probe framing

- `bootstrap-engine-starter`
  - earlier observed `Desire:` and `Carry-forward memo:` leakage

Interpretation:
- the communication boundary is still weak
- the agent can externalize internal cognitive representation directly to the patron

## What looked mostly okay

### `desire:*`

The final desire set across these runs was mostly outward-facing and not obviously used as a dumping ground for process-improvement wishes.

### `pattern:*`

Patterns were often about internal/runtime regularities rather than external world regularities, but they were still mostly descriptive rather than prescriptive.

That means:
- patterns may still be broader than ideal in some cases
- but they were not the main smuggling surface in this run set

## Architectural implication

The missing channel is broader than "a better tactic layer."

Current evidence suggests at least two missing representational slots:

1. `runtime/meta-policy suggestion`
- for DR outputs that are too broad for a tactic and too weak for code staging

2. `metacognitive continuation`
- for next-session guidance that is not a concrete act step and therefore does not belong in `carry_forward`

Without these, DR keeps overloading:
- `tactic:*`
- `carry_forward`
- freeform reflective prose
- and sometimes `code_stage_requests`
