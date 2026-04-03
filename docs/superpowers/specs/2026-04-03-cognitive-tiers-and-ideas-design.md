# Cognitive Tiers and DR Ideas

Two changes to the cognitive architecture: a three-tier value system
and a DR-produced ideas mechanism that bridges abstract desires to
concrete actions.

## Problem

Two gaps in the current architecture:

1. **Operationalization gap**: desires are abstract ("accumulate varied
   experience") and the cheap planner can't bridge them to concrete
   tool use. Result: 5-session no_action loops.

2. **Policy smuggling**: behavioral rules ("don't stay passive") have
   no home. The agent writes them as desires, which corrupts the
   desire/principle distinction.

## Design

### 1. Three-tier value system

| Tier | Name | Examples | Written by | Mutability |
|------|------|----------|------------|------------|
| Dharma | Purpose, identity | "Serve Isha's vision of inner wellbeing" | Patron | Immutable |
| Principles | Operational ethics | Truthfulness, care, security, proportionality | Patron seeds; agent can modify via DR with deliberation | High friction (kvWriteGated, 200-char deliberation) |
| Tactics | Learned policies | "Explore before concluding nothing can be done", "check email periodically" | Agent via DR | Agent-managed (same as desires) |

**Dharma** stays exactly as-is. Immutable, kernel-injected.

**Principles** stay seeded from `principles.md` but become explicitly
modifiable by DR. They already are in the code (`kvWriteGated` with
deliberation requirement) — the change is in the DR prompt, which
currently treats them as read-only context. DR should be told it can
propose principle refinements when experience warrants it.

**Tactics** are a new `tactic:*` KV prefix. They're behavioral
policies the agent creates from experience — the proper home for
things currently smuggled as desires ("break-passivity-loop",
"self-directed-inquiry"). Managed by DR's D operator alongside
desires. Injected into LLM calls by the kernel alongside principles.

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
  tactical heuristics (what to do in specific situations).
- Principles change slowly with high friction. Tactics change
  freely as the agent learns.
- Both are injected into every LLM call, but in separate blocks
  (`[PRINCIPLES]` and `[TACTICS]`).

### 2. DR ideas

DR produces a small array of concrete, tool-grounded ideas inside
`last_reflect`. These bridge the gap between abstract desires and
the cheap planner's ability to select actions.

Ideas are:
- **Concrete**: "Use kv_manifest to inventory memory structure" not
  "explore your memory"
- **Tool-grounded**: reference specific tools the agent has
- **Ephemeral**: refreshed every DR cycle, no lifecycle tracking
- **Advisory**: the planner treats them as candidates, not obligations

Shape inside `last_reflect`:
```json
{
  "session_summary": "...",
  "ideas": [
    {
      "idea": "Use kv_manifest to inventory memory under desire:, samskara:, and experience: prefixes",
      "why": "Planner has been returning no_action — this reduces uncertainty with one cheap probe",
      "tool_hints": ["kv_manifest", "kv_query"]
    },
    {
      "idea": "Use computer tool to check what software is installed on the server",
      "why": "Server capabilities are unknown — mapping them opens new action possibilities",
      "tool_hints": ["computer"]
    }
  ],
  "note_to_future_self": "..."
}
```

The planner receives ideas in a `[DR IDEAS]` section:
```
[DR IDEAS]
These are concrete action candidates from your last deep reflection.
Treat as starting points when no desire gap is otherwise clearly closable.

- Use kv_manifest to inventory memory (tools: kv_manifest, kv_query)
  Why: Planner returning no_action under uncertainty
- Use computer to check server software (tools: computer)
  Why: Server capabilities unknown
```

### 3. DR prompt changes

The deep_reflect prompt gains:

**Tactic operator** (alongside S and D operators):
```
## T operator: Tactic Management

Tactics are practical approaches learned from experience — behavioral
rules that guide action selection. Unlike principles (operational
ethics, slow-changing), tactics are situation-specific moves the
agent develops through practice.

**Create** when a pattern in experiences suggests a behavioral rule
that would improve future sessions.
**Refine** when new experience sharpens the rule.
**Retire** when the tactic is no longer useful or has been
superseded.

Format:
{ "key": "tactic:{slug}", "value": {
    "slug": "...",
    "description": "behavioral rule — when X, do Y",
    "source_principles": ["..."],
    "created_at": "ISO8601",
    "updated_at": "ISO8601"
} }
```

**Ideas section** in the output schema:
```json
{
  "kv_operations": [],
  "ideas": [
    { "idea": "...", "why": "...", "tool_hints": ["..."] }
  ],
  "reflection": "...",
  "note_to_future_self": "..."
}
```

### 4. Planner wiring

`planPhase` in userspace.js loads `last_reflect` and injects ideas:

```js
const lastReflect = await K.kvGet("last_reflect");
if (lastReflect?.ideas?.length) {
  sections.push("", "[DR IDEAS]",
    "Concrete action candidates from your last deep reflection.",
    "Treat as starting points when no desire gap is otherwise clearly closable.",
  );
  for (const idea of lastReflect.ideas) {
    const tools = idea.tool_hints?.length ? ` (tools: ${idea.tool_hints.join(", ")})` : "";
    sections.push(`- ${idea.idea}${tools}`);
    if (idea.why) sections.push(`  Why: ${idea.why}`);
  }
}
```

### 5. Kernel tactic injection

The kernel already injects `[PRINCIPLES]` in `callLLM`. Add a
`[TACTICS]` block using the same pattern — load `tactic:*` keys
at boot, inject after principles.

Tactics are a protected tier (agent writes via `kvWriteGated` in
DR context, same as desires). Add `tactic:*` to the protected
tier in `DEFAULT_KEY_TIERS`.

## Implementation scope

| File | Change |
|------|--------|
| kernel.js | Load tactics at boot, inject `[TACTICS]` in callLLM, add `tactic:*` to protected tier |
| userspace.js | planPhase loads last_reflect.ideas, applyDrResults preserves ideas + handles tactic ops |
| prompts/deep_reflect.md | Add T operator (tactics), add ideas to output schema |
| prompts/plan.md | Document [DR IDEAS] section |
| scripts/seed-local-kv.mjs | No tactic seeding (agent earns them) |
| tests/kernel.test.js | Test tactic injection |
| tests/userspace.test.js | Test idea injection into planner context |

## Design decisions

**Why not merge tactics into principles?** Different mutability,
different semantics. Principles are "how to be" (ethics). Tactics
are "what to do when" (practical moves). Collapsing them loses the
distinction between constitution and learned behavior.

**Why not give ideas lifecycle?** DR runs every 5 sessions. If an
idea is ignored for 5 sessions, DR sees that in experiences and
adjusts. The experiences ARE the lifecycle tracking.

**Why tool-grounded ideas?** Vague ideas ("explore more") are as
useless as abstract desires. The cheap planner needs specific tool
references to act. DR runs on Opus and knows the tool manifest —
it can produce concrete candidates.

**Why inject tactics into every LLM call?** Same reason as
principles — they shape all behavior, not just planning. A tactic
like "be concise in reviews" should influence the review model too.

**Why not let DR write principles directly?** It already can
(kvWriteGated with deliberation). The change is only in the prompt —
telling DR it's allowed to propose principle refinements. The
high-friction gate (200-char deliberation + capable model) stays.
