# Module 3: Session Rewrite — Design Spec

> **Spec reference:** `swayambhu-cognitive-architecture.md` sections 7.1, 7.2, 8, 9, 10
> **Depends on:** Modules 1 (kernel refactor) and 2 (KV schema) — both complete
> **Adversarial review:** Three rounds with Codex. Killed approaches A (prompt-driven), B (code-driven separate contexts), C (magic tool intercept). Refined through D (shared transcript) to E (split primitive). All findings incorporated.

---

## 1. Summary

Implement the plan→act→eval→review session loop from the cognitive architecture spec. The session hook composes a new kernel primitive (`runAgentTurn`) into a phase-aware cycle that preserves the full transcript as "lived experience" while keeping phase boundaries mechanical (code-controlled, not prompt-dependent).

**Key decisions:**
- New kernel primitive `runAgentTurn` (one LLM turn + tool dispatch, no loop)
- `runAgentLoop` unchanged — existing callers unaffected
- New `session.js` hook composes phases from `runAgentTurn` and `callLLM`
- Desires/assumptions snapshotted once at session start
- Eval owns sigma, alpha, and salience from day one (stub with typed zeros in M3)
- `check_id` = assumption slug (canonical mapping)
- Circumstances refresh between cycles
- Session.js owns session schedule exclusively

---

## 2. Kernel Primitive: `runAgentTurn`

New method on the Kernel class. One LLM turn + tool dispatch. No loop, no recovery, no control-plane injections.

### Interface

```javascript
async runAgentTurn({ systemPrompt, messages, tools, model, effort, maxTokens, step, budgetCap })
```

### Behavior

1. Call `this.callLLM(...)` with the provided messages + tools
2. If response has `toolCalls`:
   - Dispatch all in parallel via `this.executeToolCall`
   - Append assistant message (with tool_calls) to `messages`
   - Append tool result messages (role: "tool", tool_call_id, content) to `messages`
3. If response has no `toolCalls`:
   - Append assistant message to `messages`
4. Return `{ response, toolResults, cost, done }`
   - `response`: raw LLM response (`{ content, toolCalls, cost, usage }`)
   - `toolResults`: array of tool results (empty if no tool calls)
   - `cost`: LLM call cost
   - `done`: `!response.toolCalls?.length` (true when model stops calling tools)

### What it does NOT do

- No loop — caller decides whether to continue
- No budget warnings injected into messages
- No parse-repair prompts
- No max-step coercion
- No `parseAgentOutput` — caller handles response content

### Exposed on K interface

Add to `buildKernelInterface()` alongside existing `runAgentLoop`, `executeToolCall`, `buildToolDefinitions`:

```javascript
runAgentTurn: (opts) => this.runAgentTurn(opts),
```

### Relationship to `runAgentLoop`

`runAgentLoop` stays unchanged. It is a convenience wrapper for simple agent loops (governor, one-off jobs, existing callers in act.js/reflect.js during migration). `runAgentTurn` is the lower-level primitive that `session.js` composes.

Optionally, `runAgentLoop` can be refactored to use `runAgentTurn` internally — but that is cleanup, not a requirement for Module 3.

---

## 3. Session Hook: `session.js`

New file. Single export: `run(K, { crashData, balances, events, schedule })`.

### Wiring

```javascript
// index.js
import * as session from './session.js';
const HOOKS = { session };
```

Kernel calls `HOOKS.session.run(K, {...})` at kernel.js:855. This is the single entry point for all session logic.

### Flow

```
1. Load config: defaults, modelsConfig
2. Snapshot slow state:
   d = K.kvList({ prefix: "desire:" }) → parse values
   m = K.kvList({ prefix: "assumption:" }) → parse values, filter expired TTLs
3. Cold start check: if d is empty → dispatch deep-reflect → return
4. Build initial circumstances (c) from events, balances, crashData
5. Build system prompt with d, m, c, principles reference
6. messages = [] (shared transcript)
7. Loop while budget remains:
   a. Budget preflight — if remaining < minReviewCost, break
   b. Plan phase → structured plan or no_action → break if no_action
   c. Act phase → tool loop until done
   d. Eval phase → mechanical σ/α computation
   e. Review phase → LLM evaluates, structured output
   f. Memory writes — μ (always), ε (if salience > τ)
   g. Refresh circumstances
8. Check if deep-reflect is due → dispatch if so
9. Update session schedule
10. Write session summary to karma
```

### Budget management

The hook tracks cost per cycle and enforces:
- **Preflight check:** Before starting a new cycle, verify `remainingBudget >= minReviewCost`. `minReviewCost` is configurable via `config:defaults` (default: estimated cost of one callLLM for review).
- **Act step cap:** `maxActSteps` (configurable, default: 20). Hard cap on runAgentTurn calls per act phase, independent of budget.
- **No budget warnings in transcript.** Budget is a circumstance injected into the system prompt, not a mid-conversation interruption.

### What moves from act.js

Session orchestration, context building, budget management, reflect dispatch. What remains in `act.js` becomes a library:
- `renderActPrompt(K, config)` — load and template `prompt:act`
- `buildToolSet(K)` — build tool definitions
- `formatContext(d, m, c)` — format desires/assumptions/circumstances for prompt

### What moves from reflect.js

`highestReflectDepthDue` scheduling check and dispatch decision. Deep-reflect implementation (`runReflect`, `applyReflectOutput`) stays in `reflect.js`.

### Schedule ownership

`session.js` is the single owner of `session_schedule`. `reflect.js` stops writing it. Deep-reflect communicates schedule preferences via its output, and `session.js` applies them.

---

## 4. Plan Phase

Single `K.callLLM` call. No tools — planning is pure reasoning.

### System prompt

The plan call uses a dedicated plan system prompt (loaded from `prompt:plan` or built by `session.js`). It includes desires, assumptions (with TTL status), and instructions to output a structured plan JSON. The same system prompt is reused across cycles (prompt-cache-friendly — static desires/assumptions, only circumstances change).

The act phase uses a different system prompt (the existing `prompt:act`, adapted) with tool instructions. The review phase uses a third system prompt with `[KERNEL EVALUATION]` and review instructions.

All three share the same `messages` array (transcript), but each `callLLM`/`runAgentTurn` call can specify its own `systemPrompt`.

### Input

The shared `messages` array. On the first cycle, the hook appends a user message prompting the plan phase:

```
[CIRCUMSTANCES]
{JSON: events, balances, recent tool outcomes, crash data, contact state}
[/CIRCUMSTANCES]

Given your desires, assumptions, and current circumstances, plan your next action.
Respond with a JSON plan object.
```

On subsequent cycles, circumstances are refreshed and the prompt says:
```
Previous action complete. Updated circumstances:
[CIRCUMSTANCES]
{...refreshed}
[/CIRCUMSTANCES]

Plan your next action, or respond with no_action if nothing precipitates.
```

### Output schema (strict validation)

```json
{
  "action": "string — what to do",
  "success": "string — measurable outcome criteria",
  "relies_on": ["assumption:slug1", "assumption:slug2"],
  "defer_if": "string — when to stop and leave for next session",
  "no_action": false
}
```

Or:
```json
{
  "no_action": true,
  "reason": "string — why nothing precipitates"
}
```

### Validation rules

- `relies_on` entries must exist in the assumption snapshot. Unknown slugs → warning in karma, stripped from plan.
- If `no_action: true`, the cycle loop ends naturally.
- Schema validation is strict (required fields, correct types). Not `parseAgentOutput`.

### Failure behavior

If the model returns invalid JSON: one retry with explicit instruction ("Respond with only a valid JSON plan object"). If still invalid: end session cleanly, karma log `{ event: "plan_parse_failure" }`, schedule next session.

### Plan appended to transcript

The plan response is appended to `messages` as an assistant message. Act and review see what was planned — this is part of the lived experience.

---

## 5. Act Phase

`runAgentTurn` loop until done (natural tool exhaustion) or `maxActSteps` reached.

### Flow

```javascript
const ledger = {
  action_id: `${sessionId}_cycle_${cycleIndex}`,
  plan: planRecord,
  tool_calls: [],
  final_text: null,
};

for (let i = 0; i < maxActSteps && withinBudget(); i++) {
  const { response, toolResults, cost, done } = await K.runAgentTurn({
    systemPrompt, messages, tools, model, step: `act_turn_${i}`, ...
  });

  // Record to structured ledger
  if (toolResults.length) {
    for (let j = 0; j < toolResults.length; j++) {
      ledger.tool_calls.push({
        tool: response.toolCalls[j].function.name,
        input: response.toolCalls[j].function.arguments,
        output: toolResults[j],
        ok: !toolResults[j].error,
      });
    }
  }

  if (done) {
    ledger.final_text = response.content;
    break;
  }
}
```

### Action ledger

The ledger is the structured record of what happened during act. Eval consumes this — structured data, not model-authored prose. This addresses the self-grading concern: the kernel reconstructs outcomes from tool results.

### Premature termination

If the model emits text without tool calls mid-action, `runAgentTurn` returns `done: true`. For Module 3, this is treated as act-complete. If this proves brittle in practice, the hook can add a one-turn follow-up — that's policy, not kernel.

### kv_operations and session_responses

The old pattern (agent outputs JSON with `kv_operations` array, code applies them post-loop) is replaced. In the new architecture:
- KV writes happen through tool calls during act (the agent calls tools that write KV)
- Session responses are emitted as events during act (the agent calls a delivery/notification tool)
- No more post-loop JSON parsing for side effects

This is intentional cleanup. The agent acts through tools, not through structured output fields.

---

## 6. Eval Phase

Mechanical computation. No LLM call.

### Input

- Action ledger (plan + tool calls + outcomes)
- Desire snapshot (d)
- Assumption snapshot (m)

### Output schema

```json
{
  "sigma": 0,
  "alpha": {},
  "salience": 0,
  "eval_method": "stub",
  "tool_outcomes": [
    { "tool": "google_docs_create", "ok": true },
    { "tool": "search_kb", "ok": true }
  ],
  "plan_success_criteria": "doc saved to Google Docs, covers 5+ key topics",
  "assumptions_relied_on": ["assumption:google-docs-accessible"],
  "candidate_check_ids": ["google-docs-accessible", "transcript-kb-populated"]
}
```

### Module 3 stub behavior

- `sigma`: 0 (no surprise computation yet)
- `alpha`: `{}` (empty affinity vector)
- `salience`: 0 (no mechanical salience yet — review estimates qualitatively)
- `eval_method`: `"stub"`
- `tool_outcomes`: extracted from action ledger
- `plan_success_criteria`: from plan record
- `assumptions_relied_on`: from plan record's `relies_on`
- `candidate_check_ids`: assumption slugs from the snapshot (whitelist for review)

### Module 5 replacement

Same interface, real values:
- `sigma`: computed via embeddings + NLI pipeline
- `alpha`: per-desire affinity scores
- `salience`: `sigma + |alpha|` (L1 norm)
- `eval_method`: `"pipeline"` or `"llm_fallback"`

No session.js changes needed when Module 5 lands.

### Eval owns salience

Eval is the single source of truth for sigma, alpha, and salience. Review receives these values — it never computes them. In M3, review sees `salience: 0` and `eval_method: "stub"`, so it estimates salience qualitatively and returns its own estimate. When M5 provides real scores, review uses those directly.

---

## 7. Review Phase

Single `K.callLLM` call. No tools.

### Input

The shared `messages` array, plus eval results injected into the **system prompt** for the review call (not as a user message in the transcript).

The review system prompt includes:
```
[KERNEL EVALUATION]
{...eval results as JSON}
[/KERNEL EVALUATION]

Review this action against ALL active desires and assumptions, not just the ones
the plan flagged. Evaluate whether the outcome advanced or opposed each desire.
Check whether relied-on assumptions held.

You may only reference check_ids from this set: {candidate_check_ids}.

Respond with a JSON review object.
```

### Why system prompt, not transcript

`[DHARMA]` and `[PRINCIPLES]` are injected via the system prompt in `callLLM`. Kernel evaluation follows the same pattern — authoritative context that the model treats as ground truth, not conversation content it might argue with.

### Output schema (strict validation)

```json
{
  "assessment": "string — summary of action outcome",
  "narrative": "string — natural language description for episodic memory",
  "salience_estimate": 0.7,
  "mu_updates": [
    { "check_id": "google-docs-accessible", "confirmed": true },
    { "check_id": "transcript-kb-populated", "confirmed": true }
  ]
}
```

### Validation rules

- `mu_updates[].check_id` must be in `candidate_check_ids` from eval. Unknown IDs → ignore + karma log.
- `salience_estimate` is the review's qualitative assessment. When `eval.salience > 0` (M5+), the hook uses `eval.salience` instead of `salience_estimate`.

### Failure behavior

Same as plan: one retry on invalid JSON, then end session cleanly.

---

## 8. Memory Writes

After review, the hook writes to memory stores.

### μ (statistical memory) — always written

For each `mu_update` in review output:

```javascript
const key = `mu:${update.check_id}`;
const existing = await K.kvGet(key);
const mu = existing || {
  check_id: update.check_id,
  confirmation_count: 0,
  violation_count: 0,
  last_checked: null,
  cumulative_surprise: 0,
};

if (update.confirmed) {
  mu.confirmation_count += 1;
} else {
  mu.violation_count += 1;
}
mu.last_checked = new Date().toISOString();
// cumulative_surprise updated by Module 4 (R operator)

await K.kvWriteSafe(key, mu);
```

`mu:*` is in the agent tier — `kvWriteSafe` works directly.

### ε (episodic memory) — conditional on salience

Salience source: `eval.salience` if > 0 (M5+), else `review.salience_estimate`.
Threshold τ: configurable via `config:defaults` (default: 0.5).

If salience > τ, write episode:

```javascript
const episode = {
  timestamp: new Date().toISOString(),
  action_taken: ledger.plan.action,
  outcome: ledger.final_text || review.assessment,
  active_assumptions: ledger.plan.relies_on,
  active_desires: Object.keys(d).map(k => k), // all active desire keys
  surprise_score: eval.sigma,       // 0 in M3 stub
  affinity_vector: eval.alpha,      // {} in M3 stub
  narrative: review.narrative,
  embedding: null,                  // M4 adds embeddings
};

await K.kvWriteSafe(`episode:${Date.now()}`, episode);
```

### Episode assembly contract

| Field | Source | M3 value |
|-------|--------|----------|
| `timestamp` | Hook (current time) | ISO string |
| `action_taken` | Ledger → plan.action | From plan |
| `outcome` | Ledger → final_text, fallback review.assessment | From act/review |
| `active_assumptions` | Ledger → plan.relies_on | From plan |
| `active_desires` | Desire snapshot keys | All active |
| `surprise_score` | Eval → sigma | 0 |
| `affinity_vector` | Eval → alpha | {} |
| `narrative` | Review → narrative | From review |
| `embedding` | None (M4) | null |

---

## 9. Circumstances Refresh

After each plan→act→eval→review cycle, circumstances must change or the next plan reasons over stale state.

### Refresh steps (between cycles)

```javascript
async function refreshCircumstances(K, previousC, ledger) {
  return {
    ...previousC,
    balances: await K.checkBalance({}),
    recent_tool_outcomes: ledger.tool_calls.map(tc => ({
      tool: tc.tool, ok: tc.ok,
    })),
    events: await drainNewEvents(K),  // any events emitted during act
    cycle_count: previousC.cycle_count + 1,
    session_cost_so_far: K.getSessionCost(),
  };
}
```

Balances are re-read (act may have spent money). Events are re-drained (act may have emitted events that trigger new circumstances). Tool outcomes from the last cycle are included so plan knows what just happened.

Desires and assumptions are NOT re-read. They are slow state snapshotted once. Only deep-reflect modifies them.

---

## 10. Cold Start

### Detection

```javascript
const desireKeys = await K.kvList({ prefix: "desire:" });
if (desireKeys.keys.length === 0) {
  // Cold start — no desires exist
}
```

### Cold start flow

1. Karma log: `{ event: "cold_start", reason: "no_desires" }`
2. Call `runReflect(K, state, 1, { coldStart: true })`
   - Deep-reflect receives `coldStart: true` in its context
   - Runs `D_p(∅, ∅)` — derives desires from principles alone
   - Writes `desire:*` keys via `kvWriteGated` with `"deep-reflect"` context
3. Schedule next session in ~60 seconds
4. Return (no act session runs)

### Changes to reflect.js

- `runReflect` accepts `coldStart` flag in context object
- When `coldStart: true`, the deep-reflect prompt focuses on `D_p(∅, ∅)`: "You have no experience and no existing desires. Derive initial desires from principles alone."
- No μ or ε to review (both empty)
- Output: `desire:*` keys only (no assumption changes on cold start)

---

## 11. Wiring Changes

### index.js

```javascript
// Before
import * as act from './act.js';
import * as reflect from './reflect.js';
const HOOKS = { act, reflect };

// After
import * as session from './session.js';
const HOOKS = { session };
```

`session.js` imports `act.js` and `reflect.js` internally.

### act.js (becomes library)

Exports helpers, not a `runAct` entry point:
- `renderActPrompt(K, config)` — load `prompt:act`, apply template vars
- `buildToolSet(K)` — call `K.buildToolDefinitions()`
- `formatDesires(d)`, `formatAssumptions(m)`, `formatCircumstances(c)` — context formatting

### reflect.js (minimal changes)

- `runReflect`: accepts `coldStart` in context, adjusts prompt accordingly
- `highestReflectDepthDue`, `isReflectDue`: unchanged
- `applyReflectOutput`: unchanged
- `executeReflect` (shallow session reflect): deprecated — replaced by in-cycle review phase
- Stops writing `session_schedule` — session.js owns it

### governor/builder.js

Add `hook:session:code` to the builder template. The governor reads this from KV and generates the import in `index.js`. `hook:act:code` and `hook:reflect:code` remain as module keys (they're still imported by session.js via the generated index).

### kernel.js

- Add `runAgentTurn` method
- Expose `runAgentTurn` on K interface in `buildKernelInterface()`
- No other changes

---

## 12. Testing Strategy

### Unit tests (new)

**`tests/session.test.js` (rewrite):**
- Cold start detection (empty desires → deep-reflect dispatch)
- Plan validation (valid plan, no_action, invalid JSON retry, schema failure)
- Act loop (tool exhaustion, maxActSteps cap, budget exhaustion)
- Eval stub output shape
- Review validation (valid review, hallucinated check_id filtering)
- μ write logic (confirmation increment, violation increment, new check_id creation)
- ε write logic (salience gating, episode assembly)
- Circumstances refresh
- Budget preflight (skip cycle when budget low)
- Multi-cycle loop (plan→act→eval→review→plan with changing circumstances)

**`tests/kernel.test.js` (additions):**
- `runAgentTurn` — single turn with tool calls, single turn without, tool error handling
- `runAgentTurn` — messages array mutation (appends correctly)
- `runAgentTurn` — cost tracking

### Integration tests

- Full session with mock LLM (deterministic responses for plan/act/review)
- Cold start → deep-reflect → desires written → next session acts
- Multi-cycle session with natural termination (no_action on cycle 2)

### What's hard to test

- Prompt authority for `[KERNEL EVALUATION]` — integration test with real LLM needed
- Budget preflight accuracy under variable LLM cost — use conservative estimates
- Multi-cycle transcript drift — test with 3+ cycles, verify review still produces valid output

---

## 13. Module Boundaries

### Module 3 delivers

- `runAgentTurn` kernel primitive
- `session.js` hook with plan→act→eval→review cycle
- Cold start detection and deep-reflect dispatch
- Structured action ledger
- Eval stub (typed zeros, same interface as real eval)
- Review phase with qualitative salience estimation
- μ writes (count increments)
- ε writes (conditional on salience, full episode assembly)
- Wiring changes (index.js, governor, K interface)
- Prompt updates (plan prompt, review prompt)
- act.js refactored to library
- reflect.js minimal changes (coldStart, schedule ownership)
- Tests for all of the above

### Module 4 (Memory architecture) adds

- Sophisticated μ update logic (R operator — rolling averages, cumulative surprise)
- Episode embedding generation
- Episode selection strategy for deep-reflect
- `cumulative_surprise` field in μ gets real updates

### Module 5 (Evaluation pipeline) adds

- Real σ/α computation replacing eval stub
- Tier 1: embedding similarity for relevance filtering
- Tier 2: NLI for entailment/contradiction
- Tier 3: LLM fallback for ambiguous cases
- `eval_method` changes from `"stub"` to `"pipeline"` or `"llm_fallback"`
- Mechanical salience replaces review's qualitative estimate

### Module 6 (Deep reflect) adds

- Full M operator: `M_{c}(μ) = m` (assumption evolution)
- Full D operator: `D_p(ε, d) = d'` (desire evolution)
- Akash compute server integration
- Complete `D_p(∅, ∅)` implementation (M3 dispatches, M6 implements fully)

### Interface contract

Eval returns `{ sigma, alpha, salience, eval_method, tool_outcomes, plan_success_criteria, assumptions_relied_on, candidate_check_ids }`. This shape is stable across M3→M5. Review works with any `eval_method` — when scores are zeros/stub, it estimates qualitatively; when scores are real, it uses them directly.

---

## 14. Adversarial Review Summary

Three rounds of Codex adversarial review shaped this design:

**Round 1:** Killed Approaches A (prompt-driven loop — no mechanical phase enforcement), B (separate contexts — review loses lived experience), C (magic tool intercept — control-plane hack, self-grading). Proposed Approach D (code-driven phases, shared transcript).

**Round 2:** Found that "make runAgentLoop composable" was wrong — transcript has control-plane junk (budget warnings, repair prompts). Proposed Approach E: split the primitive into `runAgentTurn`.

**Round 3 (final):** Found 4 high, 4 medium issues in the complete design:
- Eval→episode contract unstable → eval owns salience from day one with typed zeros
- check_id mapping missing → check_id = assumption slug, candidate whitelist
- kv_operations/session_responses dropped → intentional, everything through tools
- runAgentTurn not on K interface → added
- [KERNEL EVALUATION] as user message not authoritative → moved to review system prompt
- Circumstances refresh unspecified → explicit refresh step
- JSON failure behavior unspecified → retry once, then clean exit
- Schedule ownership conflict → session.js owns exclusively

All findings incorporated.
