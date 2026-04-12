# Cognitive Tiers and Desire Properties

## Staleness Note (2026-04-12)

This document is partially stale against the live code base.

Concrete drift:

- it describes tactic loading/injection as a kernel responsibility
- current code explicitly keeps tactics out of kernel loading and injects them
  from userspace planning instead
- parts of the implementation-scope table should therefore not be treated as
  current source of truth for runtime ownership boundaries

Keep this document as historical design context, not as the authoritative map
of current code.

Two changes to the cognitive architecture: a three-tier value system
and formal properties of desire (expansion, always-positive,
append-only).

## Problem

Three gaps in the current architecture:

1. **Operationalization gap**: desires are abstract ("accumulate varied
   experience") and the cheap planner can't bridge them to concrete
   tool use. Result: 5-session no_action loops.

2. **Policy smuggling**: behavioral rules ("don't stay passive") have
   no home. The agent writes them as desires, which corrupts the
   desire/principle distinction.

3. **Desire stagnation**: the D operator retires fulfilled desires
   without expanding. The agent can run out of desires and return to
   passivity.

## Design

### 1. Three-tier value system

| Tier | Name | Examples | Written by | Mutability |
|------|------|----------|------------|------------|
| Dharma | Purpose, identity | "Serve Isha's vision of inner wellbeing" | Patron | Immutable |
| Principles | Operational ethics | Truthfulness, care, security, proportionality | Patron seeds; agent can modify via DR with deliberation | High friction (kvWriteGated, deliberation required) |
| Tactics | Learned behavioral rules | "Explore before concluding nothing can be done" | Agent via DR | Agent-managed (same tier as desires) |

**Dharma** stays exactly as-is. Immutable, kernel-injected.

**Principles** move from the immutable tier to the protected tier
in `DEFAULT_KEY_TIERS`. This is a kernel change — principles were
originally mutable with high friction, then made immutable, now
reverting to the original behavior. DR can modify them via
`kvWriteGated` in deep-reflect context with a deliberation
requirement. The DR prompt tells the agent it can propose principle
refinements when experience warrants it. High friction ensures
principles change slowly and deliberately.

**Tactics** are a new `tactic:*` KV prefix. Behavioral rules the
agent creates from experience — the proper home for things currently
smuggled as desires. Managed by DR's T operator. Injected into LLM
calls for plan and act steps only (NOT eval, chat, or DR — tactics
are action-selection heuristics, not global norms).

Tactic schema:
```json
{
  "slug": "explore-before-concluding",
  "description": "When uncertain whether action is possible, try at least one exploratory tool use before planning no_action.",
  "source_principles": ["responsibility", "discipline"],
  "created_at": "ISO8601",
  "updated_at": "ISO8601"
}
```

Tactics differ from principles:
- Principles are operational ethics (how to be). Tactics are
  practical moves (what to do in specific situations).
- Principles change slowly with high friction. Tactics change
  freely as the agent learns.
- Principles are injected into ALL LLM calls (global norms).
  Tactics are injected only into plan + act calls (action guidance).
- The DR prompt should address the boundary: if a behavioral rule
  applies to all contexts (communication, reflection, evaluation),
  it's a principle. If it applies specifically to action selection,
  it's a tactic.

### 2. Desire properties

Three formal properties of the D operator:

**Expansion** — desire always grows:
```
D_p(ε, d_t) = d_{t+1}    where |d_{t+1}| > |d_t|
```

Here d is desire as a force, not a set. |d| is the magnitude of
desire, not the count. Desire is an expansive force — experience
provides the currency, and desire always grows. This is an axiom,
not a derived property. Fulfillment reveals larger gaps, not empty
sets. The empty-desire passivity state becomes impossible after
the first DR cycle.

**Always-positive** — D transforms everything into approach:
```
D_p(ε_{-}) = d_{+}     negative experience → approach desire toward the inversion
D_p(ε_{+}) = d_{++}    positive experience → amplified approach desire
```

D never produces avoidance desires. Negative experience reveals what
would have been better; positive experience amplifies toward more.
The `direction` field in the desire schema is always `"approach"`.
Remove `"avoidance"` from the architecture spec, eval pipeline,
schema tests, and prompt.

**Append-only** — desires are never modified, only created:

Fulfilled desires stay as historical records. When a desire is
fulfilled, DR creates a NEW desire with broader scope — it does not
update the existing desire's description. This preserves identity
continuity: the slug `desire:map-kv-structure` always means what it
meant when created. The new broader desire gets a new slug.

The D operator actions:
- **Create** when experience reveals a gap that principles care about
- **Create (expand)** when a desire is fulfilled — create a new desire
  with broader scope informed by the fulfilled state
- **Retire** only when a desire was misguided (rare). Fulfilled
  desires are not retired — they remain as history while the expanded
  successor takes over as the active pursuit.

### 3. DR prompt changes

The deep_reflect prompt gains:

**T operator** (alongside S and D operators):
```
## T operator: Tactic Management

Tactics are practical approaches learned from experience — behavioral
rules that guide action selection. Unlike principles (operational
ethics that apply everywhere), tactics are situation-specific moves
for planning and acting.

If a rule applies to all contexts (communication, reflection,
evaluation), it belongs as a principle, not a tactic.

**Create** when a pattern in experiences suggests a behavioral rule
that would improve future act sessions.
**Refine** when new experience sharpens the rule.
**Retire** when the tactic is no longer useful or superseded.

Format:
{ "key": "tactic:{slug}", "value": {
    "slug": "...",
    "description": "behavioral rule — when X, do Y",
    "source_principles": ["..."],
    "created_at": "ISO8601",
    "updated_at": "ISO8601"
} }
```

**D operator updates**:
- Add expansion axiom and always-positive property
- Remove avoidance direction
- Add append-only rule (create new desires, don't modify existing)
- Add principle modification permission with deliberation requirement

**Output schema** adds `tactic:*` to allowed kv_operations:
```json
{
  "kv_operations": [
    // samskara, desire, and tactic changes
  ],
  "reflection": "...",
  "note_to_future_self": "..."
}
```

### 4. Kernel changes

**Move principles to protected tier**: in `DEFAULT_KEY_TIERS`, move
`principle:*` from `immutable` to `protected`. Add deliberation
requirement in `_gateSystem` for `principle:*` keys (same pattern as
`config:model_capabilities`).

**Add tactic loading and injection**: load `tactic:*` keys at boot
(same pattern as `loadPrinciples`). Inject `[TACTICS]` block in
`callLLM` but ONLY for plan and act steps. The `step` parameter
already identifies the call type — check `step` before injecting.

**Add `tactic:*` to protected tier** in `DEFAULT_KEY_TIERS`.

**Add tool manifest to DR context**: add `config:tool_registry` to
the context_keys sent with DR dispatch so DR knows what tools exist.

### 5. Userspace changes

**applyDrResults**: allow `tactic:*` operations alongside `desire:*`
and `samskara:*`.

**planPhase**: load tactics for display in planner context (the
kernel injects them into the system prompt, but the planner also
needs to see them explicitly to reason about them).

### 6. Other changes

**Architecture spec** (`swayambhu-cognitive-architecture.md`): update
desire definition (remove bidirectional, add expansion axiom,
add always-positive, add append-only). Add tactics as a new entity.
Update principle mutability.

**Schema tests** (`tests/schema.test.js`): remove `direction:
"avoidance"` validation, add tactic schema validation.

**Eval pipeline** (`eval.js`): remove any avoidance-specific logic.

**Dashboard API** (`dashboard-api/worker.js`): add tactics to the
`/mind` endpoint alongside desires and samskaras.

**Dashboard SPA**: render tactics in the Mind tab.

## Implementation scope

| File | Change |
|------|--------|
| kernel.js | Move principle:* to protected tier, add deliberation gate, load/inject tactics (plan+act only), add tactic:* to protected |
| userspace.js | applyDrResults allows tactic:* ops, planPhase context |
| prompts/deep_reflect.md | Add T operator, update D operator (expansion, always-positive, append-only, principle modification) |
| prompts/plan.md | Document tactics in planner context |
| eval.js | Remove avoidance-specific logic |
| swayambhu-cognitive-architecture.md | Update desire/principle/tactic definitions |
| tests/schema.test.js | Update desire schema, add tactic schema |
| tests/kernel.test.js | Test tactic injection scoping, principle mutability |
| dashboard-api/worker.js | Add tactics to /mind endpoint |
| site/patron/src/components/MindTab.jsx | Render tactics |
| scripts/seed-local-kv.mjs | Add tactic:* to key tiers, add tool_registry to DR context keys |

## Design decisions

**Why not merge tactics into principles?** Different mutability,
different scope, different semantics. Principles apply everywhere and
change slowly. Tactics apply to action selection and change freely.
The DR prompt provides the boundary: "if it applies to all contexts,
it's a principle."

**Why move principles to protected, not keep them immutable?** The
agent needs to be able to refine its ethics through experience. A
principle like "proportionality" might need sharpening after the
agent learns what proportional resource use actually looks like in
practice. High friction (deliberation requirement) prevents casual
modification.

**Why append-only desires?** Modifying a desire in place under the
same slug destroys identity continuity. Historical comparisons,
embeddings, and dashboard views lose meaning when the key means
something different than it used to. New desires get new slugs.

**Why scope tactics to plan+act only?** Tactics like "explore before
concluding" are action-selection heuristics. Injecting them into
eval calls contaminates alignment classification. Injecting them
into chat calls puts internal behavioral rules into patron-facing
conversation. Injecting them into DR would create feedback loops.

**Why add tool_registry to DR context?** Without it, DR can't
produce experience-grounded tactics about tool use. It needs to
know what tools exist to reason about how to use them better.
