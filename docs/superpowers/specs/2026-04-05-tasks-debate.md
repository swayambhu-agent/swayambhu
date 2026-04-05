# Tasks vs Desire-Driven Planning — Debate Record

## Context

The cognitive architecture uses desires, patterns, tactics, and experiences.
"Tasks" (explicit work items carried between sessions) were an early concept
that was removed in favor of desire-driven planning. The dev loop's CC analyst
reintroduced tasks to solve a real problem: the agent kept re-diagnosing
the same issues instead of picking up where it left off.

Question: Should the architecture have explicit tasks/continuations, or is
that a design regression?

---

## Round 1 — Codex Position

**Tasks are architecturally correct and NOT a regression.**

Core argument: Desires operate at the wrong temporal resolution for
inter-session continuity. "Fix the email relay config" is not a desire —
it's working memory. Every cognitive architecture with discrete episodes
needs something to bridge episodes.

Key points:
- `note_to_future_self` is free text the planner may not attend to reliably
- Desires are long-term vectors ("serve patron") — they can't encode
  "respond to the Slack message from 2 hours ago"
- 5+ sessions of re-diagnosis is empirical evidence of the gap
- Tasks aren't a parallel authority — they're "memoized planning outputs"
  (cached results of a previous session's planning applied to desires)

BUT: current framing is wrong. Tasks should be framed as cached plans
subordinate to desires, not a separate authority. Should carry desire_key
linking to which desire they serve.

Evidence that would change Codex's mind:
1. Planner reliably reconstructs right action from desires+patterns+note alone
2. Tasks measurably confuse the planner (two-masters problem observed)
3. Structured note_to_future_self achieves same result with less machinery

---

## Round 2 — Claude Counterargument + Codex Response

### Claude's counter:
1. "Memoized planning" creates two planning paths — fresh (generative) vs
   cached (prescriptive). Creates inertia toward stale plans.
2. The re-diagnosis problem is a symptom of weak reflect→plan handoff,
   not evidence tasks are needed. Fix the real problem instead.
3. Tasks shift behavior from emergent to directive-following.
4. Simpler middle ground: structured note_to_future_self.

### Codex response:
1. Current injection is soft ("priorities to consider") — whether LLM
   treats it as directive is empirical, not theoretical.
2. Proposed fixes (better note, better experiences, faster patterns)
   operate at different timescales. Tasks fill zero-lag gap that none
   of those cover.
3. Tasks are weakest signal in plan context — come after desires, patterns,
   tactics, circumstances. Emergence preserved as primary driver.
4. "Structured note_to_future_self with carry_forward" ≈ tasks. This is
   a naming objection, not architectural.

### Codex concessions:
- "Task" is wrong word. "Continuation" better expresses what they are.
- Need TTL/max-age to prevent staleness.
- DR should explicitly prune them.

---

## Agreements after R2

- Agent needs inter-session continuity for specific intentions
- Desires are wrong temporal resolution for this
- Free-text note_to_future_self is insufficient
- Mechanism should be subordinate to desires, not parallel authority
- Lifecycle management (TTL, pruning) essential
- "Structured note_to_future_self" ≈ "tasks" (naming difference)

## Remaining tension for R3

- Does the LLM actually behave differently based on framing?
- Should these be separately injected or embedded in last_reflect context?
- Should each item reference the desire it serves?
- What's the right implementation?

---

## Round 3 — Final Resolution

### What the current code actually does

Before choosing a design, it is worth being precise about the present
mechanics:

- `prompts/reflect.md` explicitly asks session reflect to:
  - read `last_reflect.tasks` if present
  - emit `task_updates`
  - emit `new_tasks`
  - treat deep reflect as the place that will "review and prune" them
- `reflect.js` session reflect implements exactly that model:
  - loads `prevLastReflect?.tasks`
  - applies `task_updates`
  - appends `new_tasks`
  - writes the merged array back to `last_reflect.tasks`
- `userspace.js` does **not** pass `last_reflect` directly into the planner.
  The planner gets only the prompt variables from `loadPlanVars(...)`
  plus a synthetic user-message section assembled in `planPhase(...)`.
- In `planPhase(...)`, pending tasks are extracted from
  `last_reflect.tasks` and injected as a separate prompt block:
  `[CARRY-FORWARD TASKS] (from last session's reflect — priorities to
  consider, desires remain the authority)`.
- `prompts/plan.md` itself contains no concept of tasks, continuations,
  or `last_reflect`.
- `prompts/deep_reflect.md` does **not** currently mention tasks or define
  pruning rules, even though `prompts/reflect.md` says DR will review and
  prune them.
- `reflect.js` depth-1 deep-reflect can persist `output.tasks` back into
  `last_reflect`, and records tasks dropped relative to the prior set.
  So the runtime supports DR-owned pruning/rewrite.
- But the prompt that is supposed to drive that behavior does not ask for
  it yet.
- There is also a second DR application path in `userspace.js`
  (`applyDrResults`) that overwrites `last_reflect` without carrying
  tasks forward at all. That means the current architecture is not merely
  philosophically unsettled; it is implementation-inconsistent.

That matters because Round 3 is not deciding between cleanly implemented
options. It is deciding how to simplify and regularize a partially split
implementation.

### 1. What is the right implementation?

**Recommendation: C, but specifically "B with explicit schema and planner
extraction."**

Do not keep the current model as-is. But do not collapse everything back
into free-form prose either.

The right implementation is:

- one continuity container in `last_reflect`
- inside it, a structured list of carry-forward items
- planner reads those items from `last_reflect` and renders them into its
  own context
- no separate conceptual object called "tasks" in the architecture

In other words: architecturally, Claude is right that there should not be
two concepts when one will do. Operationally, Codex is right that a
structured carry-forward mechanism is necessary because free text alone is
not reliable enough.

So the best answer is not A and not pure B as "just bury them in
`note_to_future_self`". It is:

- keep structured carry-forward items
- store them as part of `last_reflect`
- make them the only explicit continuity mechanism
- treat `note_to_future_self` as unstructured orientation

Why this is the right fit for the code:

- The current system already uses `last_reflect` as the continuity anchor.
- Session reflect already knows how to update structured items.
- Planner already consumes an extracted summary, not raw JSON.
- The separate `[CARRY-FORWARD TASKS]` block is already evidence that
  planner benefits from explicit rendering.
- What is wrong is not the existence of structure. What is wrong is having
  two names and two partially overlapping stories: "note to future self"
  and "tasks".

Therefore the clean architecture is:

- `note_to_future_self`: free-text orientation
- `carry_forward`: structured continuations

That removes the conceptual split while preserving the real behavioral
benefit.

### 2. Does the LLM behave differently with "tasks" vs "continuations" vs embedded items?

**Yes, but mostly because of prompt position and framing, not the noun by
itself.**

Grounded in the current code:

- The planner never sees raw `last_reflect`; it sees prompt sections.
- Therefore LLM behavior is determined by:
  - whether a dedicated section exists
  - where that section appears
  - how directive the surrounding language is
  - whether the items look like commands or context

Three likely effects:

1. **"Tasks" nudges imperative follow-through.**
   A labeled block called `[CARRY-FORWARD TASKS]` with bullet items like
   `- [high] do X` is more likely to be interpreted as a to-do list. That
   increases continuation fidelity, but also increases stale-plan inertia.

2. **"Continuations" or "carry-forward items" better communicates
   subordination.**
   Those labels imply "unfinished threads from prior reasoning" rather than
   "instructions you must obey". That is closer to the intended
   architecture stated in Round 2.

3. **Embedding them only inside prose weakens retrieval.**
   If the same content is buried in `note_to_future_self`, the model must
   first identify that those lines are operationally salient, then parse
   them back into discrete candidate actions. That is exactly the failure
   mode the current task mechanism was introduced to mitigate.

So yes, wording matters. But the stronger effect is structural salience:

- separate labeled section > JSON blob hidden in larger object > prose note

Conclusion:

- Avoid the word `tasks` in planner-facing framing.
- Do not rely on prose-only embedding.
- Use a structured field with planner-side rendering under a softer label
  like `[CARRY-FORWARD]` or `[OPEN CONTINUATIONS]`.

### 3. Separate injection vs embedded in `last_reflect`

**Separate injection is better for the planner, but it should be derived
from `last_reflect`, not modeled as a second memory object.**

This question becomes clearer once the actual code path is stated plainly:

- `userspace.js` reads `last_reflect`
- extracts pending items
- injects them as a separate prompt section

So "embedded vs separate injection" is really asking whether planner
should:

- inspect raw `last_reflect` itself, or
- receive a planner-specific rendering of the salient subset

The second is better.

Reasons grounded in the current prompt design:

- `prompts/plan.md` is intentionally minimal and action-selective. It asks
  the model to choose a single action from desires, patterns, and
  circumstances.
- Dumping all of `last_reflect` into that context would mix reflective
  narrative, emotional orientation, operational hints, and structured
  carry-forwards in one blob.
- The current extracted block already performs useful compression:
  only pending items are shown, and only their action-relevant fields are
  rendered.

So the planner should **not** "find them inside `last_reflect`
naturally." That would be weaker prompt engineering than what exists now.

But the separate injection should be understood as a **view**, not a
separate store:

- store once in `last_reflect.carry_forward`
- render separately into planner context

That gives the best of both:

- one source of truth
- one planner-optimized presentation

### 4. Should each item reference which desire it serves?

**Yes, but make it optional and weakly coupled.**

Round 1 was directionally correct here, but mandatory desire linkage is too
strong for the current reflect pipeline.

Why optional linkage is the right compromise:

- Planner's primary authority is still `[DESIRES]`.
- If a carry-forward item names a supporting desire, it helps the planner
  decide whether the item is still worth acting on.
- That is especially useful when the carry-forward text is concrete but the
  underlying reason has faded.

However, making desire linkage required is a mistake because the current
reflect prompt and session evidence may not always support a confident
mapping:

- `prompts/reflect.md` asks for concrete follow-up based on session karma.
- Some items arise from local operational state: retry a tool failure,
  answer a pending contact, revisit a blocked write-protected change.
- In those cases reflect may know the next step without confidently knowing
  which `desire:*` record best grounds it.

So the right schema is:

- `desire_key`: optional
- if known, include exact `desire:*` key
- if unknown, omit it
- planner should treat linked items as more grounded, not as the only valid
  ones

This preserves usefulness without creating fake precision.

### 5. What is the lifecycle? TTL, pruning rules, max count

**A structured continuity mechanism only works if it decays aggressively.**

Today, lifecycle is underspecified:

- session reflect can mark items `done` or `dropped`
- `reflect.js` can accept DR-pruned task lists
- but `prompts/deep_reflect.md` does not actually instruct DR to perform
  that pruning
- `userspace.js` planner currently includes every item whose status is not
  `"done"`; even `"dropped"` would still pass the filter

That last point is important. The filter is currently:

- `filter(t => t.status !== "done")`

So dropped items are still "pending" from the planner's perspective unless
some later process removes them entirely. This is a concrete bug in the
current semantics.

Recommended lifecycle:

1. **Statuses**
   - `active`: eligible for planner injection
   - `done`: completed, retained briefly for reflection history only
   - `dropped`: explicitly dead, never planner-visible
   - `expired`: aged out, never planner-visible

2. **TTL**
   - default TTL: 7 days
   - urgent/time-sensitive items: explicit shorter TTL if reflect knows it
   - items older than TTL become `expired` unless refreshed by reflect/DR

3. **Refresh rule**
   - if a later session makes concrete progress but does not finish the
     item, reflect can bump `updated_at` and preserve it
   - if no session mentions it and no evidence supports it, let it expire

4. **Deep-reflect pruning**
   - every DR cycle should review all active carry-forward items
   - remove items that are stale, superseded, duplicated, or no longer
     aligned with current desires/patterns

5. **Max count**
   - hard cap at 5 active items injected into planner
   - prefer 3
   - DR should compress or merge related items before they reach the cap

6. **Planner inclusion rule**
   - only inject items with status `active`
   - sort by priority, then recency

7. **Done-item retention**
   - keep `done` items in `last_reflect` only briefly if needed for
     continuity/audit, then let DR remove them

This keeps the planner focused and prevents continuity from becoming a
permanent backlog manager.

### Final answer to the five questions

1. **Right implementation:** not A. Use a single structured carry-forward
   mechanism inside `last_reflect`, separate from free-text
   `note_to_future_self`. This is effectively B, but with an explicit field
   rather than burying structure inside prose.
2. **LLM behavior:** yes, models react differently. The biggest lever is
   structured salience and framing, not the noun alone. "Tasks" sounds more
   imperative; "carry-forward" or "continuations" is better.
3. **Separate injection vs embedded:** keep separate planner injection, but
   as a rendering of `last_reflect` rather than a second concept/store.
4. **Reference desire:** yes, optionally. Helpful when known; harmful if
   forced.
5. **Lifecycle:** explicit statuses, 7-day TTL by default, DR pruning every
   cycle, hard cap of 5 active items, planner sees only `active`.

### RECOMMENDATION

Adopt **structured carry-forward continuations in `last_reflect` as the
single continuity mechanism**, and retire the architectural term "tasks" in
planner-facing language.

Implementation steps:

1. Rename `last_reflect.tasks` to `last_reflect.carry_forward` in prompts
   and code, with item wording changed from "task" to "continuation" or
   "carry-forward item".
2. Keep `note_to_future_self` as unstructured orientation only; do not use
   it as the primary vehicle for action carry-over.
3. Preserve planner-side extraction/injection, but rename the section from
   `[CARRY-FORWARD TASKS]` to `[CARRY-FORWARD]` or `[OPEN CONTINUATIONS]`
   and explicitly frame items as context subordinate to desires.
4. Extend the item schema to include:
   - `id`
   - `item` or `continuation`
   - `why`
   - `priority`
   - `status`
   - `created_at`
   - `updated_at`
   - `expires_at`
   - optional `desire_key`
5. Change planner filtering from "not done" to `status === "active"` so
   dropped items never re-enter prompt context.
6. Update `prompts/reflect.md` so session reflect creates, updates, and
   closes carry-forward items using the new schema.
7. Update `prompts/deep_reflect.md` to explicitly review, prune, merge,
   expire, and re-ground carry-forward items each DR cycle.
8. Make DR the owner of lifecycle hygiene: expire stale items, cap active
   count at 5, merge duplicates, and remove items no longer supported by
   current desires/patterns.
9. Fix the inconsistent DR application path so any depth-1 DR writeback to
   `last_reflect` preserves and manages carry-forward items instead of
   silently dropping them.
10. Treat this as a continuity cache, not a second planner: desires remain
    the authority, carry-forward items are memoized local context for the
    next action-selection pass.
