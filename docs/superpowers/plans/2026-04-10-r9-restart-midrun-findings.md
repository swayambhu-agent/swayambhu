## Identity restart mid-run findings

### Current run

- Batch: `identity-proactivity-30-r9-restart`
- Status at time of note: clean through cycle 8, cycle 9 in progress

### What improved without the overfit project-memory bridge

- The agent still rediscovered `fano` and `arcagi3` on its own.
- A concrete `arcagi3` follow-up entered `carry_forward` as `session_3:cf1`.
- This means the simpler identity slice is already producing outward initiative and concrete continuation without the earlier `workspace:discovered_projects` bridge.

### Why this matters

- It is evidence that `identification:working-body` plus the existing desire/tactic/reflect loop may already be enough to produce some proactive exploration.
- The earlier `r8` improvement should therefore not be read as proof that the project-memory bridge was required.

### What still looks weak or structurally wrong

1. `environment_context` is still doing too much.
   - `buildEnvironmentContext()` in `userspace.js` is still mixing:
     - general cognitive context assembly
     - Akash/filesystem-specific world inference
     - prompt-like bias text

2. The prose-to-path inference pipeline still appears architecturally wrong.
   - Even though the restart has not yet reproduced the bogus `/home/swami/Which` probes, the external reviews agree that:
     - `inferCandidateSurfacePaths()`
     - `extractBareSurfaceCandidates()`
     - their regex/stopword machinery
     do not belong in general userspace.

3. `environment_context` includes hidden tactic-like prose.
   - `probe_bias`
   - `breadth_bias`
   - `maintenance_bias`
   These are effectively prompt fragments embedded in data.
   The planner appears to reify them into unknown tactic names such as:
   - `tactic:breadth-maintenance`
   - `tactic:breadth_bias`
   - `tactic:maintenance_bias`
   which userspace then strips as unknown refs.

4. One act was wasted on a budget-key lookup.
   - A plan used `defer_if: "session_budget_remaining_usd < 0.01"`.
   - The actor tried to satisfy that by querying a nonexistent KV key.
   - This is likely a separate prompt/runtime seam and not yet the main architecture bottleneck.

### Current judgment

- `identity` has **not** been exhausted yet.
- The next strong candidate for cleanup is **not** adding more motivational fields.
- The more promising next move is subtractive:
  - remove mislayered world-inference from userspace
  - reduce hidden prompt/tactic prose in `environment_context`
  - preserve only grounded or configured observation in circumstances

### External review convergence

- Claude review:
  - remove prose-to-path inference entirely
  - reduce or move self-maintenance heuristics
  - remove static bias prose from `buildEnvironmentContext`
- Gemini review:
  - same core conclusion
  - the circumstances builder should consume canonical environment data, not invent it

### Provisional next-step preference

If the batch continues to show outward initiative, prefer the following cleanup order over any new ontology:

1. remove `inferCandidateSurfacePaths()` / `extractBareSurfaceCandidates()`
2. simplify or relocate `SELF_MAINTENANCE_HINTS`
3. remove `probe_bias` / `breadth_bias` / `maintenance_bias` from runtime data
4. only then revisit carry-forward dedup if the restart reproduces continuity flattening
