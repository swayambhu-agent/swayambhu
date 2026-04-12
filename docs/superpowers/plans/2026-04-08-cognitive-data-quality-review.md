## Summary
Overall verdict: BLOCKER

- The plan is grounded in stale code for several major tasks. `prompt:review` already exists, `scripts/seed-local-kv.mjs` already seeds it, `reviewPhase` already loads it and includes `alpha`, the S-operator text is already updated, and `eval.js` already uses the bounded salience formula.
- The proposed review-output contraction to `{ observation, assessment }` is not enough for the current runtime. `userspace.js` still uses `accomplished`, `key_findings`, `next_gap`, `narrative`, and `salience_estimate`.
- The proposed experience-schema rewrite to raw `alpha` and `pattern_scores` is not backward compatible with the current deep-reflect prompt, schema tests, dashboard API, UI, or the crash-experience writer.

## 1. Are the proposed code changes correct given actual line numbers and code shapes?
Verdict: BLOCKER

- The plan's line references are stale. `reviewPhase` is at `userspace.js:746-834`, not `~298`, and `writeMemory` is at `userspace.js:838-980`, not `~370`.
- Task 3 claims `reviewPhase` needs to start loading `prompt:review` and needs `alpha` added, but the live code already does both at `userspace.js:748-757`:
  - `const reviewPrompt = await K.kvGet("prompt:review");`
  - `` `alpha: ${JSON.stringify(evalResult.alpha || {})}` ``
- Task 3 also says the current review prompt is inline. That is only true for the fallback branch. The normal branch already builds from KV at `userspace.js:764-771`:
  - `const systemPrompt = reviewPrompt ? await K.buildPrompt(reviewPrompt, { config: defaults }) : ...`
  - `const finalSystem = reviewPrompt ? \`${systemPrompt}\n\n${evalBlock}\` : systemPrompt;`
- Task 4's "Current experience write" snippet does not match the live code. The current write path already stores structured fields at `userspace.js:929-940`:
  - `observation: reviewRecord.observation`
  - `desire_alignment: deriveDesireAlignment(evalResult.alpha || {})`
  - `pattern_delta: derivePatternDelta(evalResult)`
  - `...(reviewRecord.narrative ? { text_rendering: { narrative: reviewRecord.narrative } } : {})`
- Task 5 is already effectively implemented. `prompts/deep_reflect.md:42-53` already says patterns are descriptive only, uses `experience.observation` as canonical, and already has the refined `**Refine**` wording.
- Task 7 is also already implemented. `eval.js:94-101` currently computes:
  - `const desireAxis = computeDesireAxis(alpha, desires);`
  - `const salience = 1 - (1 - sigma) * (1 - desireAxis);`
  The plan's claimed old code `salience: sigma + l1Norm(alpha)` is no longer present in `eval.js`.
- Task 2 and Task 8 Step 1 are redundant. `scripts/seed-local-kv.mjs:149-156` already contains:
  - `await put("prompt:review", read("prompts/review.md"), "text", "Review phase system prompt — authors factual experience records");`

## 2. Does the review prompt output contract make sense? Is observation + assessment enough?
Verdict: BLOCKER

- No. It is enough for the bare minimum experience text, but not enough for the current `userspace.js` consumers.
- The current prompt contract explicitly expects the richer shape at `prompts/review.md:40-50`:
  - `observation`, `assessment`, `accomplished`, `key_findings`, `next_gap`, `narrative`
  - `salience_estimate` in degraded mode
- `autoReconcileRequests()` uses those extra fields today. At `userspace.js:199-211`, the mechanical fallback composes requester-facing text from `accomplished`, `key_findings`, and `next_gap`. At `userspace.js:260-265`, those same fields are passed into the reconcile model as `reviewSummary`.
- The planner's session continuity also uses them. At `userspace.js:546-550` and again at `userspace.js:1303-1310`, prior actions are summarized with `accomplished`, `key_findings`, and `next_gap`.
- `normalizeReview()` still preserves `narrative` and `salience_estimate` at `userspace.js:387-407`, and `writeMemory()` still uses them:
  - degraded salience fallback at `userspace.js:844-846`
  - optional audit text at `userspace.js:940`
- If the contract is reduced to only `{ observation, assessment }`, the plan also needs explicit updates for request reconciliation, planner carry-forward context, and degraded-mode salience fallback. Those tasks are missing.

## 3. Does the salience formula implementation handle edge cases (no desires, no patterns, degraded eval)?
Verdict: ISSUE

- The current implementation mostly handles the edge cases correctly.
- No active desires is handled in `eval.js:58-60`: `if (active.length === 0) return 0;`
- No desires and no patterns is handled explicitly in `eval.js:226-235`, which returns `sigma: 1`, `alpha: {}`, `desire_axis: 0`, `salience: 1`.
- No patterns but some desires is handled by passing `baseSigma: patternEntries.length === 0 ? 1 : 0` into `computeMetrics()` at `eval.js:278-285`, `eval.js:329-336`, and `eval.js:345-352`.
- Degraded eval is handled outside the formula. `eval.js:355-364` returns zeros with `eval_method: "degraded"`, and `writeMemory()` falls back to the review output at `userspace.js:844-846`:
  - `const rawSalience = evalResult.salience > 0 ? evalResult.salience : Math.min(1, Math.max(0, reviewRecord.salience_estimate || 0));`
- That means the live code is safe today, but the plan is not: if Task 3 removes `salience_estimate` from the review contract, degraded sessions lose their only current salience fallback and will default to `0`.

## 4. Does evaluateAction currently have access to desire objects for the weight computation?
Verdict: OK

- Yes. `evaluateAction` already accepts `desires` in its signature at `eval.js:196`:
  - `export async function evaluateAction(K, ledger, desires, patterns, config, signal) {`
- `computeDesireAxis()` already uses the desire objects' `source_principles` via `getSourcePrinciples()` at `eval.js:33-36` and `eval.js:58-79`.
- `computeMetrics()` already receives `desires` at `eval.js:81`, and every live call site already passes it through:
  - `eval.js:278-285`
  - `eval.js:329-336`
  - `eval.js:345-352`
- The plan item "update evaluateAction signature to accept desires and pass through" is therefore obsolete.
- Small nuance: `computeDesireAlpha()` at `eval.js:186-192` still only populates `alpha` for `served_desires` on entailed plan progress. If the intended change is broader than that, it is a different task; access to desire objects is not the blocker.

## 5. Are there backward compatibility issues with the experience schema change?
Verdict: BLOCKER

- Yes. The plan's proposed switch from `desire_alignment` / `pattern_delta` to raw `alpha` / `pattern_scores` would break current consumers.
- `prompts/deep_reflect.md` still defines the current schema at `:3-5` and uses it later:
  - `experience/ — salient experiences (\`observation\`, \`desire_alignment\`, \`pattern_delta\`, \`salience\`, optional \`text_rendering\`)`
  - `Use \`experience.desire_alignment\` as the primary signal...` at `prompts/deep_reflect.md:103-106`
- The schema test is hard-coded to the current shape. `tests/schema.test.js:26-41` requires `desire_alignment`, `pattern_delta.sigma`, `pattern_delta.scores`, and optional `text_rendering.narrative`.
- The dashboard API reads and re-exports the current fields. At `dashboard-api/worker.js:218-222` it filters experiences using `observation` / `text_rendering.narrative`, and at `dashboard-api/worker.js:354-360` it maps:
  - `surprise_score: e.pattern_delta?.sigma ?? e.surprise_score`
  - `desire_alignment: e.desire_alignment`
  - `narrative: e.text_rendering?.narrative`
- The UI also expects the current shape. `site/patron/src/components/MindTab.jsx:17-34` and `site/patron/src/components/MindTab.jsx:349-373` read `pattern_delta.sigma`, `desire_alignment.*`, and `text_rendering.narrative`.
- The crash-memory path bypasses `writeMemory()` and still writes the current schema directly at `userspace.js:1001-1014`. If only Task 4 is implemented, the store becomes mixed-schema immediately.

## 6. Any missing tasks or wrong ordering?
Verdict: ISSUE

- Several tasks should be removed or changed to verification tasks because they are already landed:
  - Task 1: `prompts/review.md` already exists.
  - Task 2: `scripts/seed-local-kv.mjs` already seeds `prompt:review`.
  - Task 5: the S-operator text is already updated.
  - Task 7: bounded salience is already in `eval.js`.
- The ordering is wrong if the schema change is still desired. The plan changes `writeMemory` in Task 4 before fixing all schema consumers. But DR dispatch reads `prompt:deep_reflect` live from KV at `userspace.js:1573-1596`, so new `experience:*` records could be written before deep-reflect instructions and downstream readers are compatible.
- Missing task: if the review contract shrinks, the plan must also update `buildMechanicalRequestFallback`, `autoReconcileRequests`, `normalizeReview`, and the planner's `priorActions` summaries in `userspace.js`.
- Missing task: if the experience schema changes, the plan must update at least `tests/schema.test.js`, `dashboard-api/worker.js`, `site/patron/src/components/MindTab.jsx`, and the crash-experience write path in `userspace.js:1001-1014`.
- Missing task: Task 6 only adds new D-operator guidance, but it does not remove the old `experience.desire_alignment` guidance or the schema list at the top of `prompts/deep_reflect.md`, so the prompt would become internally contradictory.

## 7. Is the test strategy adequate?
Verdict: ISSUE

- The current tests give a solid baseline, but the plan's proposed strategy is not adequate for the actual regression surface.
- `tests/eval.test.js` already covers important salience edge cases:
  - bootstrap/no patterns at `tests/eval.test.js:191-203`
  - no patterns but desires at `tests/eval.test.js:205-226`
  - LLM fallback and signal threading elsewhere in the file
- `tests/userspace.test.js` uses end-to-end `run()`-level tests with mocked `evaluateAction` and `callLLM`; it does not directly call private helpers. The plan's instruction to "verify writeMemory receives them" does not match the current test pattern. The live pattern is to inspect the final KV write payload, as in `tests/userspace.test.js:1318-1343`.
- Missing tests for the proposed changes:
  - degraded eval plus `review.salience_estimate` fallback
  - request auto-reconcile and planner continuity after removing `accomplished`, `key_findings`, and `next_gap`
  - schema compatibility for `desire_alignment` / `pattern_delta` consumers
  - multi-desire weighted salience cases with overlapping `source_principles`
- If the schema change remains in scope, `tests/schema.test.js` must be part of the plan. It is currently not mentioned even though it encodes the canonical experience shape.
