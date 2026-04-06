# Review Phase Design: Experience Author in the Cognitive Cycle

Date: 2026-04-05

## Scope

This document analyzes the role of the review phase in Swayambhu's cognitive cycle:

`plan -> act -> eval -> review -> reflect`

The goal is to decide what review should do, what it should write, and how it should relate to eval and downstream memory consumers.

## Grounding Note

The requested HTTP KV endpoint was unreachable in this environment:

- `curl -s 'http://localhost:8790/kv?prefix=experience:' -H 'X-Patron-Key: test'`
- `curl -sv --max-time 3 'http://127.0.0.1:8790/kv?prefix=experience:' -H 'X-Patron-Key: test'`

Both failed to connect on 2026-04-05. To still ground this analysis in actual KV data, I read the local Miniflare KV backing store directly from `.wrangler/shared-state/v3/kv/...sqlite` and the corresponding blob files. All experience-quality claims below cite those actual `experience:*` records.

## Current Behavior

The current review phase is an LLM call in `userspace.js`, not a purely mechanical function. It loads `prompt:review` from KV, but if that key is absent it falls back to a minimal inline system prompt: `"You are a review agent. Assess the action outcome."` plus a small eval block (`userspace.js:298-319`). By contrast, plan has a full prompt file with explicit sections for tools, skills, output schema, decision logic, write boundaries, and tactics (`prompts/plan.md:1-66`).

Review currently asks the model for JSON with six fields: `assessment`, `narrative`, `salience_estimate`, `accomplished`, `key_findings`, and `next_gap` (`userspace.js:321-349`). But only `assessment` and `narrative` are preserved in the action audit record (`userspace.js:401-410`), and the experience record stores only `action_taken`, `outcome`, `surprise_score`, `salience`, `narrative`, and `embedding` (`userspace.js:462-471`). `accomplished`, `key_findings`, and `next_gap` are currently requested and then discarded.

Eval is the quantitative stage. It computes `sigma`, `alpha`, `salience`, and `pattern_scores`, where `salience = sigma + l1Norm(alpha)` (`eval.js:33-57`). It also records `plan_success_criteria` and `patterns_relied_on` in the returned eval object (`eval.js:96-107`). Review does receive `sigma`, `salience`, `tool_outcomes`, `plan_success_criteria`, and `patterns_relied_on` in its eval block, but it does not receive `alpha` even though eval computed it (`userspace.js:302-310`; `eval.js:33-57`).

Deep reflect treats experiences as the raw material for S and D. Its prompt explicitly tells it to read `experience/` and `action/`, then run the S, D, and T operators over those traces (`prompts/deep_reflect.md:3-12`, `prompts/deep_reflect.md:34-40`, `prompts/deep_reflect.md:54-127`). Session reflect has a different role: continuity, carry-forward, and next-session configuration (`prompts/reflect.md:45-129`). That means review sits between quantitative evaluation and durable memory, while reflect sits between one session and the next.

There is also an architecture mismatch. The April cognitive architecture reference says, "Review (sigma, alpha, strength updates, experience recording) is mechanical computation, not an operator" (`docs/april/COGNITIVE-ARCHITECTURE.md:24-25`). But the actual code already uses an LLM to produce qualitative review output (`userspace.js:298-377`).

## Experience Quality in Current KV

Recent experience records show three consistent issues.

First, `outcome` and `narrative` are often near-duplicates rather than distinct external vs internal representations. In `experience:1775398477095`, the `narrative` is essentially the `outcome` with a `"No action taken:"` prefix; both fields repeat the same blocking analysis, pattern references, and scheduling guidance. The same duplication appears in `experience:1775397649411`, `experience:1775396838515`, and `experience:1775394522956`.

Second, the current narrative often contains policy conclusions and scheduler advice that belong more naturally to reflect or planning continuity than to remembered experience. `experience:1775398477095` includes `"Hibernate-on-extended-block applies: leave interval_seconds: 86400 as backoff signal to kernel"` in both `outcome` and `narrative`. That is not just "what happened" or "what was noticed"; it is a forward policy recommendation.

Third, the narratives are not reliably structured around external/internal/surprise. Some records are concise and usable, such as `experience:1775383082962` (`"Performed KV scan to find patron messages; identified contact and outgoing intro message, but inbox remains empty and email unauthorized."`). But other records mix tool audit, alignment judgment, unresolved gaps, and interpretation into one long paragraph. `experience:1775384747742` says `"The low sigma (0.33) suggests moderate alignment with dharma..."`, even though review did not receive `alpha`, and the architecture intends eval to own the quantitative interpretation (`eval.js:33-57`; `userspace.js:302-310`).

These records are still useful, but they are not clean experience objects. They are freeform post-hoc summaries with weak separation between event, interpretation, surprise, and next-step implication.

## Recommendations

### 1. Is "experience author" the right framing?

Yes, with one refinement: review should be the qualitative experience author, not a second evaluator and not a session continuity layer.

That framing fits the actual pipeline better than the current architecture text. Eval already computes the numbers (`eval.js:33-57`). Deep reflect explicitly consumes experiences as the raw material for pattern and desire formation (`prompts/deep_reflect.md:3-12`, `prompts/deep_reflect.md:34-40`, `prompts/deep_reflect.md:54-83`). Session reflect handles continuity and scheduling (`prompts/reflect.md:45-129`). So review's natural role is to turn raw action traces plus eval scores into the remembered experience that later cognition reads.

Concrete recommendation: redefine review as "qualitative interpretation and experience authoring." Update the architecture language that currently describes review as purely mechanical (`docs/april/COGNITIVE-ARCHITECTURE.md:24-25`), because that no longer matches the implementation (`userspace.js:298-377`) or the downstream need for interpretable experiences.

### 2. Should review produce only the experience narrative, or also other fields?

Review should produce a structured experience package, not only one freeform narrative.

The current one-field narrative is doing too many jobs at once, which is why recent records collapse external facts, internal conclusions, surprise, and next-step reasoning into a single blob (`experience:1775398477095`, `experience:1775397649411`, `experience:1775396838515`). The requested-but-discarded fields point in the right direction: `accomplished`, `key_findings`, and `next_gap` (`userspace.js:332-335`).

Concrete recommendation: review should output:

- `external`: what happened in the world
- `internal`: what the agent noticed or concluded
- `surprise`: what was unexpected and why
- `accomplished`: compact completion summary
- `key_findings`: 1-3 retrieval-friendly factual findings
- `next_gap`: what remains unresolved
- `assessment`: optional 1-sentence overall judgment
- `narrative`: a composed text derived from the structured fields, kept for embedding/retrieval compatibility

This keeps review qualitative, but structured enough that later phases do not have to reverse-engineer the memory.

### 3. Should `key_findings` and `next_gap` be persisted?

Yes. Persist both, and persist `accomplished` too.

Right now those fields are requested and then thrown away (`userspace.js:332-335`, `userspace.js:407-410`, `userspace.js:463-470`). That is a bad trade. `key_findings` gives deep reflect and any retrieval path a compact factual index. `next_gap` captures the unresolved edge that often seeds future desire or tactic formation. `accomplished` gives a short success summary that is cheaper to scan than the full `outcome` or `narrative`.

Concrete recommendation:

- Persist `accomplished`, `key_findings`, and `next_gap` in both `action:*.review` and `experience:*`.
- Treat them as first-class memory fields, not transient generation scaffolding.

### 4. Should the review prompt be a KV-stored prompt file?

Yes.

The code already tries to load `prompt:review` (`userspace.js:300`), so the architecture already expects review to be prompt-driven. The problem is that review currently has no checked-in prompt quality comparable to plan, and therefore falls back to a one-line inline instruction when unset (`userspace.js:312-319`). Plan has a much more explicit contract (`prompts/plan.md:1-66`).

Concrete recommendation:

- Add a checked-in `prompts/review.md` source.
- Seed it into KV as `prompt:review`.
- Keep the inline fallback only as a safety net, not as the intended design.

The prompt should explicitly define review as qualitative interpretation, require the external/internal/surprise split, forbid scheduler advice except when it is itself the key finding, and remind the model that reflect owns continuity.

### 5. What is the right experience schema?

An experience has exactly two cognitive components:

1. **Observation** (objective) — what happened in the world. This is the
   raw material that feeds pattern formation. It must be purely factual,
   free of conclusions or recommendations.

2. **Valence** (subjective) — was this experience aligned or misaligned
   with my desires? Positive or negative? This is what the agent "felt"
   about what happened. Valence feeds:
   - **Tactics**: the agent creates rules that steer toward positive
     experiences and away from negative ones.
   - **Desires**: positive experience → desire for an expanded version
     of that. Negative experience → desire for the opposite (approach
     inversion, as the D operator already describes).

Everything else (key_findings, next_gap, accomplished, assessment) is
downstream analysis that DR derives from observation + valence. It does
not belong in the experience record itself.

Concrete recommendation: use this schema for `experience:*`:

```json
{
  "timestamp": "ISO8601",
  "action_taken": "string",
  "observation": "what happened — purely factual, no conclusions",
  "valence": "positive|negative|neutral",
  "valence_reason": "which desire was aligned/misaligned and why",
  "surprise_score": 0.0,
  "salience": 0.0,
  "embedding": []
}
```

Notes:

- `observation` is purely factual — what happened, not what it means.
- `valence` + `valence_reason` capture the agent's subjective response relative to desires.
- `surprise_score` and `salience` are mechanical (from eval), not authored by review.
- `embedding` is computed from `observation` for Tier 1 retrieval.
- Keep `outcome`, `surprise_score`, and `salience` so the mechanical path remains intact.
- Do not store scheduler directives or carry-forward policy here unless they are themselves the substantive experience.

### 6. How should review interact with eval?

Eval should own quantitative scoring. Review should own qualitative interpretation. The current overlap is manageable but should be tightened.

Right now eval computes `sigma`, `alpha`, `salience`, and `pattern_scores` (`eval.js:33-57`), while review receives only part of that picture (`userspace.js:302-310`). It then sometimes makes alignment-like judgments in prose anyway, as in `experience:1775384747742` ("low sigma ... moderate alignment"), which is imprecise because `alpha` was not even provided to review.

Concrete recommendation:

- Keep `sigma`, `alpha`, `salience`, and `pattern_scores` owned by eval.
- Pass `alpha` into review as part of the eval block; it is currently missing despite being central to desire-affinity interpretation (`eval.js:33-57`; `userspace.js:302-310`).
- Remove `salience_estimate` from the normal review contract. Review should not re-score salience when eval already did.
- If the degraded eval path is still needed, keep `salience_estimate` only as an emergency fallback when `eval_method === "degraded"` or eval returns unusable zeros.
- In the review prompt, explicitly instruct the model to explain the meaning of the quantitative scores, not replace them.

This division keeps the architecture coherent: eval measures; review interprets; deep reflect learns.

## Final Design Decision

Review should be the experience-authoring layer of the fast cycle.

Its job is to transform:

- raw external traces from plan/act
- quantitative interpretation from eval

into:

- a structured qualitative experience record that deep reflect can use as raw material for S, D, and T

It should not be responsible for session continuity, scheduler policy, or re-running quantitative judgment. Those belong to reflect and eval respectively.

## Implementation Implications

Without changing code in this document, the design implications are straightforward:

1. Replace the implicit review role with an explicit prompt contract in `prompt:review`.
2. Expand the persisted review fields beyond `assessment` and `narrative`.
3. Reshape the experience schema around `external`, `internal`, and `surprise`, while retaining numeric eval fields and retrieval support.
4. Pass `alpha` into review and demote `salience_estimate` to degraded-mode fallback only.
5. Update architecture docs to stop describing review as purely mechanical, since the current implementation and memory design both require qualitative experience authoring.

That is the minimal change set that makes review legible inside the cognitive architecture instead of an orphaned mini-summary step.
