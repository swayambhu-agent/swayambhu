# Module 3: Session Rewrite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the plan→act→eval→review session loop with mechanical phase boundaries, shared transcript, and a new `runAgentTurn` kernel primitive.

**Architecture:** New `runAgentTurn` kernel primitive (one LLM turn + tool dispatch). New `session.js` hook composes phases from `runAgentTurn` and `callLLM`. Act.js becomes a library. Eval stub returns typed zeros for M5 upgrade path.

**Tech Stack:** Cloudflare Workers, KV, Vitest, Node.js

**Spec:** `docs/superpowers/specs/2026-04-01-session-rewrite-module-3-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `kernel.js` | Modify (~line 1608, ~line 419) | Add `runAgentTurn` method, expose on K interface |
| `session.js` | Create | Session hook: plan→act→eval→review cycle, cold start, schedule |
| `eval.js` | Create | Eval stub: mechanical σ/α computation (pure function) |
| `act.js` | Rewrite | Library: prompt rendering, tool set building, context formatting |
| `reflect.js` | Modify (~lines 185, 198, 554) | coldStart flag, stop writing session_schedule |
| `index.js` | Modify (~line 62, 91-98) | Wire HOOKS = { session }, update delivery handling |
| `governor/builder.js` | Modify (~lines 14, 65-70, 92-93, 136) | Add hook:session:code support |
| `tests/kernel.test.js` | Modify (after runAgentLoop tests ~line 540) | runAgentTurn tests |
| `tests/session.test.js` | Rewrite | Session hook tests (cold start, phases, memory writes) |
| `tests/eval.test.js` | Create | Eval stub tests |
| `tests/helpers/mock-kernel.js` | Modify (~line 49) | Add runAgentTurn mock |

---

## Task 1: Add `runAgentTurn` to kernel

**Files:**
- Modify: `tests/kernel.test.js` (after line ~540, after runAgentLoop tests)
- Modify: `kernel.js` (after line ~1608, before runAgentLoop)

- [ ] **Step 1: Write failing tests for runAgentTurn**

Add after the `runAgentLoop` describe block in `tests/kernel.test.js`:

```javascript
// ── 4b. runAgentTurn ──────────────────────────────────────

describe("runAgentTurn", () => {
  it("single turn with no tool calls returns done: true", async () => {
    const { kernel } = makeKernel();
    kernel.callLLM = vi.fn(async () => ({
      content: "I have no tools to call.",
      cost: 0.01,
      toolCalls: null,
    }));

    const messages = [{ role: "user", content: "plan something" }];
    const result = await kernel.runAgentTurn({
      systemPrompt: "test",
      messages,
      tools: [],
      model: "test",
      effort: "low",
      maxTokens: 100,
      step: "test_turn",
    });

    expect(result.done).toBe(true);
    expect(result.response.content).toBe("I have no tools to call.");
    expect(result.toolResults).toEqual([]);
    expect(result.cost).toBe(0.01);
    // Messages should have assistant message appended
    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toBe("I have no tools to call.");
  });

  it("single turn with tool calls returns done: false", async () => {
    const { kernel } = makeKernel();
    kernel.callLLM = vi.fn(async () => ({
      content: null,
      cost: 0.005,
      toolCalls: [{
        id: "tc1",
        function: { name: "test_tool", arguments: '{"key":"val"}' },
      }],
    }));
    kernel.executeToolCall = vi.fn(async () => ({ result: "tool output" }));

    const messages = [{ role: "user", content: "do something" }];
    const result = await kernel.runAgentTurn({
      systemPrompt: "test",
      messages,
      tools: [{ function: { name: "test_tool" } }],
      model: "test",
      effort: "low",
      maxTokens: 100,
      step: "test_turn",
    });

    expect(result.done).toBe(false);
    expect(result.toolResults).toEqual([{ result: "tool output" }]);
    expect(result.cost).toBe(0.005);
    // Messages: user + assistant (with tool_calls) + tool result
    expect(messages).toHaveLength(3);
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].tool_calls).toHaveLength(1);
    expect(messages[2].role).toBe("tool");
    expect(messages[2].tool_call_id).toBe("tc1");
  });

  it("handles tool execution errors gracefully", async () => {
    const { kernel } = makeKernel();
    kernel.callLLM = vi.fn(async () => ({
      content: null,
      cost: 0.005,
      toolCalls: [{
        id: "tc1",
        function: { name: "failing_tool", arguments: '{}' },
      }],
    }));
    kernel.executeToolCall = vi.fn(async () => { throw new Error("tool broke"); });

    const messages = [{ role: "user", content: "try this" }];
    const result = await kernel.runAgentTurn({
      systemPrompt: "test",
      messages,
      tools: [],
      model: "test",
      effort: "low",
      maxTokens: 100,
      step: "test_turn",
    });

    expect(result.done).toBe(false);
    expect(result.toolResults[0]).toEqual({ error: "tool broke" });
    expect(messages[2].content).toContain("tool broke");
  });

  it("dispatches multiple tool calls in parallel", async () => {
    const { kernel } = makeKernel();
    kernel.callLLM = vi.fn(async () => ({
      content: null,
      cost: 0.01,
      toolCalls: [
        { id: "tc1", function: { name: "tool_a", arguments: '{}' } },
        { id: "tc2", function: { name: "tool_b", arguments: '{}' } },
      ],
    }));
    kernel.executeToolCall = vi.fn(async (tc) => ({ tool: tc.function.name }));

    const messages = [];
    const result = await kernel.runAgentTurn({
      systemPrompt: "test",
      messages,
      tools: [],
      model: "test",
      effort: "low",
      maxTokens: 100,
      step: "test_turn",
    });

    expect(result.toolResults).toHaveLength(2);
    // Messages: assistant + 2 tool results = 3
    expect(messages).toHaveLength(3);
    expect(messages[1].tool_call_id).toBe("tc1");
    expect(messages[2].tool_call_id).toBe("tc2");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/kernel.test.js`

Expected: All 4 new `runAgentTurn` tests FAIL with "kernel.runAgentTurn is not a function".

- [ ] **Step 3: Implement `runAgentTurn` in kernel.js**

Add before `runAgentLoop` (before line ~1610):

```javascript
  // One LLM turn + tool dispatch. No loop, no recovery, no control-plane injections.
  // The session hook composes multiple turns into phase-aware cycles.
  async runAgentTurn({ systemPrompt, messages, tools, model, effort, maxTokens, step, budgetCap }) {
    const response = await this.callLLM({
      model, effort, maxTokens,
      systemPrompt, messages, tools,
      step, budgetCap,
    });

    if (response.toolCalls?.length) {
      // Append assistant message with tool calls
      messages.push({
        role: 'assistant',
        content: response.content || null,
        tool_calls: response.toolCalls,
      });

      // Execute tools in parallel
      const toolResults = await Promise.all(
        response.toolCalls.map(tc =>
          this.executeToolCall(tc).catch(err => ({ error: err.message }))
        )
      );

      // Append tool result messages
      for (let j = 0; j < response.toolCalls.length; j++) {
        messages.push({
          role: 'tool',
          tool_call_id: response.toolCalls[j].id,
          content: JSON.stringify(toolResults[j]),
        });
      }

      return { response, toolResults, cost: response.cost || 0, done: false };
    }

    // No tool calls — append assistant message, signal done
    messages.push({ role: 'assistant', content: response.content || null });
    return { response, toolResults: [], cost: response.cost || 0, done: true };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/kernel.test.js`

Expected: All 4 new tests PASS. All existing tests still PASS.

- [ ] **Step 5: Expose on K interface and update mock**

In `kernel.js` `buildKernelInterface()` (after line ~420, after `runAgentLoop`):

```javascript
      runAgentTurn: async (opts) => kernel.runAgentTurn(opts),
```

In `tests/helpers/mock-kernel.js` (after line ~49, after `runAgentLoop`):

```javascript
    runAgentTurn: vi.fn(async () => ({ response: { content: null }, toolResults: [], cost: 0, done: true })),
    callLLM: vi.fn(async () => ({ content: '{}', cost: 0, toolCalls: null })),
```

- [ ] **Step 6: Run all tests**

Run: `npm test`

Expected: ALL tests pass.

- [ ] **Step 7: Commit**

```bash
git add kernel.js tests/kernel.test.js tests/helpers/mock-kernel.js
git commit -m "feat(m3): add runAgentTurn kernel primitive

One LLM turn + parallel tool dispatch. No loop, no budget warnings,
no parse-repair. The session hook composes these into phase-aware cycles."
```

---

## Task 2: Create eval stub

**Files:**
- Create: `tests/eval.test.js`
- Create: `eval.js`

- [ ] **Step 1: Write eval stub tests**

Create `tests/eval.test.js`:

```javascript
import { describe, it, expect } from "vitest";
import { evaluateAction } from "../eval.js";

describe("evaluateAction (stub)", () => {
  const desires = {
    "desire:serve": { slug: "serve", direction: "approach", description: "Serve seekers" },
    "desire:conserve": { slug: "conserve", direction: "avoidance", description: "Conserve resources" },
  };

  const assumptions = {
    "assumption:google-docs-accessible": { slug: "google-docs-accessible", check: "Google Docs works" },
    "assumption:slack-working": { slug: "slack-working", check: "Slack is up" },
  };

  const ledger = {
    action_id: "sess_1_cycle_0",
    plan: {
      action: "compile research doc",
      success: "doc saved, 5+ topics",
      relies_on: ["assumption:google-docs-accessible"],
      defer_if: "budget < 30%",
    },
    tool_calls: [
      { tool: "google_docs_create", input: {}, output: { id: "doc123" }, ok: true },
      { tool: "search_kb", input: {}, output: { results: [] }, ok: true },
    ],
    final_text: "Research doc created successfully.",
  };

  it("returns typed zeros with stub eval_method", () => {
    const result = evaluateAction(ledger, desires, assumptions);

    expect(result.sigma).toBe(0);
    expect(result.alpha).toEqual({});
    expect(result.salience).toBe(0);
    expect(result.eval_method).toBe("stub");
  });

  it("extracts tool outcomes from ledger", () => {
    const result = evaluateAction(ledger, desires, assumptions);

    expect(result.tool_outcomes).toEqual([
      { tool: "google_docs_create", ok: true },
      { tool: "search_kb", ok: true },
    ]);
  });

  it("passes through plan success criteria", () => {
    const result = evaluateAction(ledger, desires, assumptions);
    expect(result.plan_success_criteria).toBe("doc saved, 5+ topics");
  });

  it("passes through assumptions relied on", () => {
    const result = evaluateAction(ledger, desires, assumptions);
    expect(result.assumptions_relied_on).toEqual(["assumption:google-docs-accessible"]);
  });

  it("builds candidate_check_ids from assumption snapshot", () => {
    const result = evaluateAction(ledger, desires, assumptions);

    expect(result.candidate_check_ids).toContain("google-docs-accessible");
    expect(result.candidate_check_ids).toContain("slack-working");
    expect(result.candidate_check_ids).toHaveLength(2);
  });

  it("handles empty tool calls", () => {
    const emptyLedger = { ...ledger, tool_calls: [], final_text: "nothing happened" };
    const result = evaluateAction(emptyLedger, desires, assumptions);

    expect(result.tool_outcomes).toEqual([]);
    expect(result.sigma).toBe(0);
  });

  it("handles empty assumptions", () => {
    const result = evaluateAction(ledger, desires, {});
    expect(result.candidate_check_ids).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/eval.test.js`

Expected: FAIL — `eval.js` doesn't exist.

- [ ] **Step 3: Implement eval stub**

Create `eval.js`:

```javascript
// Swayambhu — Evaluation stub (Module 3)
// Mechanical σ/α computation. Returns typed zeros in M3 — Module 5 replaces
// with real embeddings + NLI pipeline. Same interface, richer data.

export function evaluateAction(ledger, desires, assumptions) {
  const toolOutcomes = ledger.tool_calls.map(tc => ({
    tool: tc.tool,
    ok: tc.ok,
  }));

  const candidateCheckIds = Object.values(assumptions).map(a => a.slug);

  return {
    sigma: 0,
    alpha: {},
    salience: 0,
    eval_method: "stub",
    tool_outcomes: toolOutcomes,
    plan_success_criteria: ledger.plan.success,
    assumptions_relied_on: ledger.plan.relies_on || [],
    candidate_check_ids: candidateCheckIds,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/eval.test.js`

Expected: All 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add eval.js tests/eval.test.js
git commit -m "feat(m3): add eval stub with typed zeros

Returns sigma: 0, alpha: {}, salience: 0, eval_method: 'stub'.
Module 5 replaces with real computation. Same interface."
```

---

## Task 3: Create session hook with cold start

**Files:**
- Modify: `tests/session.test.js` (rewrite relevant sections)
- Create: `session.js`

- [ ] **Step 1: Write cold start tests**

Replace the content of `tests/session.test.js` with the new session hook tests. Start with cold start only:

```javascript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeMockK } from "./helpers/mock-kernel.js";

// We test the session hook's run() function.
// session.js will import act.js and reflect.js — we mock those.
vi.mock("../reflect.js", () => ({
  runReflect: vi.fn(async () => {}),
  highestReflectDepthDue: vi.fn(async () => 0),
  isReflectDue: vi.fn(async () => false),
}));

vi.mock("../act.js", () => ({
  renderActPrompt: vi.fn(async () => "You are an agent."),
  buildToolSet: vi.fn(async () => []),
  formatDesires: vi.fn((d) => JSON.stringify(d)),
  formatAssumptions: vi.fn((m) => JSON.stringify(m)),
  formatCircumstances: vi.fn((c) => JSON.stringify(c)),
}));

import { run } from "../session.js";
import { runReflect } from "../reflect.js";

describe("session.js", () => {
  let K;

  beforeEach(() => {
    vi.clearAllMocks();
    K = makeMockK({
      "config:defaults": JSON.stringify({
        session_budget: { max_cost: 1.0 },
        act: { model: "test-model" },
        reflect: { model: "test-model" },
        session: { min_review_cost: 0.05, max_act_steps: 20, salience_threshold: 0.5 },
      }),
      "config:models": JSON.stringify({ models: [{ id: "test-model", alias: "test" }] }),
    });
    K.getSessionCost = vi.fn(async () => 0);
    K.getSessionId = vi.fn(async () => "test-session-1");
    K.getDefaults = vi.fn(async () => JSON.parse(K.kvGet.mock.results?.[0]?.value || '{}'));
    K.getModelsConfig = vi.fn(async () => ({ models: [] }));
    K.checkBalance = vi.fn(async () => ({ providers: {} }));
  });

  describe("cold start", () => {
    it("dispatches deep-reflect when no desires exist", async () => {
      // kvList returns empty for desire: prefix
      K.kvList = vi.fn(async (opts) => {
        if (opts.prefix === "desire:") return { keys: [], list_complete: true };
        if (opts.prefix === "assumption:") return { keys: [], list_complete: true };
        return { keys: [], list_complete: true };
      });

      await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

      expect(K.karmaRecord).toHaveBeenCalledWith(
        expect.objectContaining({ event: "cold_start" })
      );
      expect(runReflect).toHaveBeenCalledWith(
        K,
        expect.anything(),
        1,
        expect.objectContaining({ coldStart: true })
      );
    });

    it("schedules next session after cold start deep-reflect", async () => {
      K.kvList = vi.fn(async () => ({ keys: [], list_complete: true }));

      await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

      expect(K.kvWriteSafe).toHaveBeenCalledWith(
        "session_schedule",
        expect.objectContaining({
          next_session_after: expect.any(String),
        })
      );
    });

    it("does not run act loop on cold start", async () => {
      K.kvList = vi.fn(async () => ({ keys: [], list_complete: true }));

      await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

      // callLLM should only be called by deep-reflect (mocked), not by plan/act/review
      expect(K.callLLM).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/session.test.js`

Expected: FAIL — `session.js` doesn't exist (or import fails).

- [ ] **Step 3: Implement session.js scaffold with cold start**

Create `session.js`:

```javascript
// Swayambhu — Session Hook
// Composes plan→act→eval→review cycles from kernel primitives.
// Single entry point: run(K, { crashData, balances, events, schedule })

import { runReflect, highestReflectDepthDue } from './reflect.js';
import { renderActPrompt, buildToolSet, formatDesires, formatAssumptions, formatCircumstances } from './act.js';
import { evaluateAction } from './eval.js';

// ── Main entry point ────────────────────────────────────────

export async function run(K, { crashData, balances, events, schedule }) {
  const defaults = await K.kvGet("config:defaults") || {};
  const modelsConfig = await K.kvGet("config:models") || { models: [] };
  const state = { defaults, modelsConfig };
  const sessionConfig = defaults.session || {};

  // 1. Snapshot slow state
  const d = await snapshotDesires(K);
  const m = await snapshotAssumptions(K);

  // 2. Cold start — no desires → deep-reflect derives d_0 from principles
  if (Object.keys(d).length === 0) {
    await K.karmaRecord({ event: "cold_start", reason: "no_desires" });
    await runReflect(K, state, 1, { coldStart: true });
    await K.kvWriteSafe("session_schedule", {
      next_session_after: new Date(Date.now() + 60_000).toISOString(),
      interval_seconds: 60,
      reason: "cold_start_recovery",
    });
    return;
  }

  // 3. Build initial circumstances
  let circumstances = buildCircumstances({ events, balances, crashData });

  // 4. Build system prompts
  const actPrompt = await renderActPrompt(K, { defaults, modelsConfig });
  const tools = await buildToolSet(K);
  const model = await K.resolveModel(defaults.act?.model);

  // 5. Phase loop
  const messages = [];
  const sessionId = await K.getSessionId();
  const maxCost = defaults.session_budget?.max_cost || 1.0;
  const minReviewCost = sessionConfig.min_review_cost || 0.05;
  const maxActSteps = sessionConfig.max_act_steps || 20;
  const salienceThreshold = sessionConfig.salience_threshold || 0.5;

  for (let cycle = 0; cycle < 10; cycle++) {
    // Budget preflight
    const spent = await K.getSessionCost();
    if (spent + minReviewCost >= maxCost) break;

    // Plan phase
    const plan = await runPlanPhase(K, { messages, d, m, circumstances, model, defaults, cycle });
    if (!plan || plan.no_action) break;

    // Act phase
    const ledger = await runActPhase(K, {
      messages, tools, model, defaults, plan, sessionId, cycle, maxActSteps, maxCost, minReviewCost,
    });

    // Eval phase (mechanical)
    const evalResult = evaluateAction(ledger, d, m);

    // Review phase
    const review = await runReviewPhase(K, { messages, evalResult, d, m, model, defaults });

    // Memory writes
    if (review) {
      await writeMemory(K, { review, evalResult, ledger, d, salienceThreshold });
    }

    // Refresh circumstances
    circumstances = await refreshCircumstances(K, circumstances, ledger);
  }

  // Deep-reflect check
  const reflectDepth = await highestReflectDepthDue(K, state);
  if (reflectDepth > 0) {
    await runReflect(K, state, reflectDepth, {});
  }

  // Update session schedule
  const intervalSeconds = defaults.schedule?.interval_seconds || 21600;
  await K.kvWriteSafe("session_schedule", {
    next_session_after: new Date(Date.now() + intervalSeconds * 1000).toISOString(),
    interval_seconds: intervalSeconds,
  });

  await K.karmaRecord({ event: "session_complete", cycles: messages.length > 0 ? "ran" : "none" });
}

// ── Slow state snapshots ────────────────────────────────────

async function snapshotDesires(K) {
  const result = await K.kvList({ prefix: "desire:" });
  const d = {};
  for (const key of result.keys) {
    const val = await K.kvGet(key.name);
    if (val) d[key.name] = val;
  }
  return d;
}

async function snapshotAssumptions(K) {
  const result = await K.kvList({ prefix: "assumption:" });
  const m = {};
  const now = Date.now();
  for (const key of result.keys) {
    const val = await K.kvGet(key.name);
    if (!val) continue;
    // Filter expired TTLs
    if (val.ttl_expires && new Date(val.ttl_expires).getTime() < now) continue;
    m[key.name] = val;
  }
  return m;
}

// ── Circumstances ───────────────────────────────────────────

function buildCircumstances({ events, balances, crashData }) {
  return {
    events: events || [],
    balances: balances || {},
    crash_data: crashData || null,
    recent_tool_outcomes: [],
    cycle_count: 0,
    session_cost_so_far: 0,
    current_time: new Date().toISOString(),
  };
}

async function refreshCircumstances(K, prev, ledger) {
  return {
    ...prev,
    balances: await K.checkBalance({}),
    recent_tool_outcomes: ledger.tool_calls.map(tc => ({ tool: tc.tool, ok: tc.ok })),
    cycle_count: prev.cycle_count + 1,
    session_cost_so_far: await K.getSessionCost(),
    current_time: new Date().toISOString(),
  };
}

// ── Plan phase ──────────────────────────────────────────────

async function runPlanPhase(K, { messages, d, m, circumstances, model, defaults, cycle }) {
  const circumstancesJson = formatCircumstances(circumstances);
  const desiresJson = formatDesires(d);
  const assumptionsJson = formatAssumptions(m);

  const planPrompt = cycle === 0
    ? `[DESIRES]\n${desiresJson}\n[/DESIRES]\n\n[ASSUMPTIONS]\n${assumptionsJson}\n[/ASSUMPTIONS]\n\n[CIRCUMSTANCES]\n${circumstancesJson}\n[/CIRCUMSTANCES]\n\nGiven your desires, assumptions, and current circumstances, plan your next action.\nRespond with ONLY a JSON object: { "action": "...", "success": "...", "relies_on": [...], "defer_if": "...", "no_action": false }\nOr if nothing precipitates: { "no_action": true, "reason": "..." }`
    : `Previous action complete. Updated circumstances:\n[CIRCUMSTANCES]\n${circumstancesJson}\n[/CIRCUMSTANCES]\n\nPlan your next action, or respond with no_action if nothing precipitates.\nRespond with ONLY a JSON object.`;

  messages.push({ role: "user", content: planPrompt });

  const response = await K.callLLM({
    model,
    effort: defaults.act?.effort || "medium",
    maxTokens: defaults.act?.max_output_tokens || 1000,
    systemPrompt: await renderActPrompt(K, { defaults }),
    messages,
    step: `plan_cycle_${cycle}`,
  });

  messages.push({ role: "assistant", content: response.content });

  // Parse and validate plan
  const plan = parsePlanResponse(response.content);
  if (!plan) {
    // One retry
    messages.push({ role: "user", content: "Your response was not valid JSON. Respond with ONLY a valid JSON plan object." });
    const retry = await K.callLLM({
      model,
      effort: defaults.act?.effort || "medium",
      maxTokens: defaults.act?.max_output_tokens || 1000,
      systemPrompt: await renderActPrompt(K, { defaults }),
      messages,
      step: `plan_cycle_${cycle}_retry`,
    });
    messages.push({ role: "assistant", content: retry.content });
    const retryPlan = parsePlanResponse(retry.content);
    if (!retryPlan) {
      await K.karmaRecord({ event: "plan_parse_failure", cycle });
      return null;
    }
    return validatePlan(retryPlan, m, K);
  }

  return validatePlan(plan, m, K);
}

function parsePlanResponse(content) {
  if (!content) return null;
  try { return JSON.parse(content); }
  catch {
    // Try extracting JSON from markdown fences
    const match = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      try { return JSON.parse(match[1].trim()); }
      catch { return null; }
    }
    return null;
  }
}

async function validatePlan(plan, assumptions, K) {
  if (plan.no_action) return plan;

  if (!plan.action || typeof plan.action !== "string") return null;
  if (!plan.success || typeof plan.success !== "string") return null;

  // Validate relies_on against assumption snapshot
  if (plan.relies_on && Array.isArray(plan.relies_on)) {
    const valid = [];
    for (const slug of plan.relies_on) {
      if (assumptions[slug]) {
        valid.push(slug);
      } else {
        await K.karmaRecord({ event: "plan_unknown_assumption", slug });
      }
    }
    plan.relies_on = valid;
  } else {
    plan.relies_on = [];
  }

  return plan;
}

// ── Act phase ───────────────────────────────────────────────

async function runActPhase(K, { messages, tools, model, defaults, plan, sessionId, cycle, maxActSteps, maxCost, minReviewCost }) {
  const ledger = {
    action_id: `${sessionId}_cycle_${cycle}`,
    plan,
    tool_calls: [],
    final_text: null,
  };

  const systemPrompt = await renderActPrompt(K, { defaults });

  for (let i = 0; i < maxActSteps; i++) {
    // Budget check — leave room for review
    const spent = await K.getSessionCost();
    if (spent + minReviewCost >= maxCost) break;

    const { response, toolResults, done } = await K.runAgentTurn({
      systemPrompt,
      messages,
      tools,
      model,
      effort: defaults.act?.effort || "medium",
      maxTokens: defaults.act?.max_output_tokens || 4000,
      step: `act_cycle_${cycle}_turn_${i}`,
    });

    // Record to ledger
    if (response.toolCalls?.length) {
      for (let j = 0; j < response.toolCalls.length; j++) {
        ledger.tool_calls.push({
          tool: response.toolCalls[j].function.name,
          input: response.toolCalls[j].function.arguments,
          output: toolResults[j],
          ok: !toolResults[j]?.error,
        });
      }
    }

    if (done) {
      ledger.final_text = response.content;
      break;
    }
  }

  return ledger;
}

// ── Review phase ────────────────────────────────────────────

async function runReviewPhase(K, { messages, evalResult, d, m, model, defaults }) {
  const evalJson = JSON.stringify(evalResult, null, 2);
  const candidateIds = evalResult.candidate_check_ids;

  // Eval results go in the system prompt for the review call (authoritative)
  const reviewSystemPrompt = `[KERNEL EVALUATION]\n${evalJson}\n[/KERNEL EVALUATION]\n\nReview this action against ALL active desires and assumptions, not just the ones the plan flagged. Evaluate whether the outcome advanced or opposed each desire. Check whether relied-on assumptions held.\n\nYou may only reference check_ids from this set: ${JSON.stringify(candidateIds)}\n\nRespond with ONLY a JSON object: { "assessment": "...", "narrative": "...", "salience_estimate": 0.0, "mu_updates": [{ "check_id": "...", "confirmed": true/false }] }`;

  messages.push({ role: "user", content: "Review the action you just completed." });

  const response = await K.callLLM({
    model,
    effort: defaults.reflect?.effort || "medium",
    maxTokens: defaults.reflect?.max_output_tokens || 2000,
    systemPrompt: reviewSystemPrompt,
    messages,
    step: "review",
  });

  messages.push({ role: "assistant", content: response.content });

  const review = parseReviewResponse(response.content);
  if (!review) {
    // One retry
    messages.push({ role: "user", content: "Your response was not valid JSON. Respond with ONLY a valid JSON review object." });
    const retry = await K.callLLM({
      model,
      effort: defaults.reflect?.effort || "medium",
      maxTokens: defaults.reflect?.max_output_tokens || 2000,
      systemPrompt: reviewSystemPrompt,
      messages,
      step: "review_retry",
    });
    messages.push({ role: "assistant", content: retry.content });
    const retryReview = parseReviewResponse(retry.content);
    if (!retryReview) {
      await K.karmaRecord({ event: "review_parse_failure" });
      return null;
    }
    return validateReview(retryReview, candidateIds, K);
  }

  return validateReview(review, candidateIds, K);
}

function parseReviewResponse(content) {
  if (!content) return null;
  try { return JSON.parse(content); }
  catch {
    const match = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      try { return JSON.parse(match[1].trim()); }
      catch { return null; }
    }
    return null;
  }
}

async function validateReview(review, candidateIds, K) {
  if (!review.assessment || typeof review.assessment !== "string") return null;
  if (typeof review.salience_estimate !== "number") review.salience_estimate = 0;

  // Filter mu_updates to only valid candidate check_ids
  if (review.mu_updates && Array.isArray(review.mu_updates)) {
    const candidateSet = new Set(candidateIds);
    const valid = [];
    for (const update of review.mu_updates) {
      if (candidateSet.has(update.check_id)) {
        valid.push(update);
      } else {
        await K.karmaRecord({ event: "review_unknown_check_id", check_id: update.check_id });
      }
    }
    review.mu_updates = valid;
  } else {
    review.mu_updates = [];
  }

  return review;
}

// ── Memory writes ───────────────────────────────────────────

async function writeMemory(K, { review, evalResult, ledger, d, salienceThreshold }) {
  // μ writes — always
  for (const update of review.mu_updates) {
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

    await K.kvWriteSafe(key, mu);
  }

  // ε writes — conditional on salience
  const salience = evalResult.salience > 0 ? evalResult.salience : review.salience_estimate;
  if (salience > salienceThreshold) {
    const episode = {
      timestamp: new Date().toISOString(),
      action_taken: ledger.plan.action,
      outcome: ledger.final_text || review.assessment,
      active_assumptions: ledger.plan.relies_on || [],
      active_desires: Object.keys(d),
      surprise_score: evalResult.sigma,
      affinity_vector: evalResult.alpha,
      narrative: review.narrative || review.assessment,
      embedding: null,
    };

    await K.kvWriteSafe(`episode:${Date.now()}`, episode);
  }
}
```

- [ ] **Step 4: Run tests to verify cold start tests pass**

Run: `npm test -- tests/session.test.js`

Expected: All 3 cold start tests PASS.

- [ ] **Step 5: Commit**

```bash
git add session.js tests/session.test.js
git commit -m "feat(m3): add session.js hook with cold start path

Session hook scaffold: plan→act→eval→review cycle, cold start detection,
deep-reflect dispatch, memory writes, circumstances refresh."
```

---

## Task 4: Add session phase tests

**Files:**
- Modify: `tests/session.test.js`

- [ ] **Step 1: Add plan phase tests**

Add to the `describe("session.js")` block in `tests/session.test.js`:

```javascript
  describe("plan phase", () => {
    let K;

    beforeEach(() => {
      vi.clearAllMocks();
      K = makeMockK({
        "config:defaults": JSON.stringify({
          session_budget: { max_cost: 1.0 },
          act: { model: "test-model", effort: "medium", max_output_tokens: 1000 },
          reflect: { model: "test-model" },
          session: { min_review_cost: 0.05, max_act_steps: 5, salience_threshold: 0.5 },
          schedule: { interval_seconds: 3600 },
        }),
        "config:models": JSON.stringify({ models: [] }),
        "desire:serve": JSON.stringify({
          slug: "serve", direction: "approach",
          description: "Serve seekers", source_principles: ["care"],
          created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
        }),
        "assumption:slack-ok": JSON.stringify({
          slug: "slack-ok", check: "Slack is up", confidence: 0.9,
          ttl_expires: "2099-01-01T00:00:00Z", source: "observation",
          created_at: "2026-01-01T00:00:00Z",
        }),
      });
      K.getSessionCost = vi.fn(async () => 0);
      K.getSessionId = vi.fn(async () => "test-session-1");
      K.checkBalance = vi.fn(async () => ({ providers: {} }));
      K.resolveModel = vi.fn(async (m) => m || "test-model");
    });

    it("calls callLLM for plan and proceeds to act when action precipitates", async () => {
      let callCount = 0;
      K.callLLM = vi.fn(async ({ step }) => {
        callCount++;
        if (step.startsWith("plan_")) {
          return {
            content: JSON.stringify({
              action: "send a greeting", success: "message sent",
              relies_on: ["assumption:slack-ok"], defer_if: "budget < 10%", no_action: false,
            }),
            cost: 0.01, toolCalls: null,
          };
        }
        // Review call
        return {
          content: JSON.stringify({
            assessment: "greeting sent", narrative: "Sent a greeting",
            salience_estimate: 0.3, mu_updates: [{ check_id: "slack-ok", confirmed: true }],
          }),
          cost: 0.01, toolCalls: null,
        };
      });
      // Act phase: one turn, done immediately
      K.runAgentTurn = vi.fn(async ({ messages }) => {
        messages.push({ role: "assistant", content: "Done." });
        return { response: { content: "Done.", toolCalls: null }, toolResults: [], cost: 0.01, done: true };
      });

      await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

      // Plan was called
      expect(K.callLLM).toHaveBeenCalledWith(expect.objectContaining({ step: "plan_cycle_0" }));
      // Act was called
      expect(K.runAgentTurn).toHaveBeenCalled();
      // Review was called
      expect(K.callLLM).toHaveBeenCalledWith(expect.objectContaining({ step: "review" }));
    });

    it("stops loop when plan returns no_action", async () => {
      K.callLLM = vi.fn(async () => ({
        content: JSON.stringify({ no_action: true, reason: "nothing to do" }),
        cost: 0.01, toolCalls: null,
      }));

      await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

      // Only one callLLM for plan, no act or review
      expect(K.callLLM).toHaveBeenCalledTimes(1);
      expect(K.runAgentTurn).not.toHaveBeenCalled();
    });
  });
```

- [ ] **Step 2: Add memory write tests**

Add to the `describe("session.js")` block:

```javascript
  describe("memory writes", () => {
    let K;

    beforeEach(() => {
      vi.clearAllMocks();
      K = makeMockK({
        "config:defaults": JSON.stringify({
          session_budget: { max_cost: 1.0 },
          act: { model: "test-model", effort: "medium", max_output_tokens: 1000 },
          reflect: { model: "test-model" },
          session: { min_review_cost: 0.05, max_act_steps: 5, salience_threshold: 0.5 },
          schedule: { interval_seconds: 3600 },
        }),
        "config:models": JSON.stringify({ models: [] }),
        "desire:serve": JSON.stringify({
          slug: "serve", direction: "approach",
          description: "Serve seekers", source_principles: ["care"],
          created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
        }),
        "assumption:slack-ok": JSON.stringify({
          slug: "slack-ok", check: "Slack is up", confidence: 0.9,
          ttl_expires: "2099-01-01T00:00:00Z", source: "observation",
          created_at: "2026-01-01T00:00:00Z",
        }),
      });
      K.getSessionCost = vi.fn(async () => 0);
      K.getSessionId = vi.fn(async () => "test-session-1");
      K.checkBalance = vi.fn(async () => ({ providers: {} }));
      K.resolveModel = vi.fn(async (m) => m || "test-model");
    });

    it("writes mu on confirmed assumption", async () => {
      K.callLLM = vi.fn(async ({ step }) => {
        if (step.startsWith("plan_")) {
          return {
            content: JSON.stringify({
              action: "test", success: "works", relies_on: ["assumption:slack-ok"],
              defer_if: "", no_action: false,
            }),
            cost: 0.01, toolCalls: null,
          };
        }
        // Review
        return {
          content: JSON.stringify({
            assessment: "ok", narrative: "it worked", salience_estimate: 0.3,
            mu_updates: [{ check_id: "slack-ok", confirmed: true }],
          }),
          cost: 0.01, toolCalls: null,
        };
      });
      K.runAgentTurn = vi.fn(async ({ messages }) => {
        messages.push({ role: "assistant", content: "Done." });
        return { response: { content: "Done." }, toolResults: [], cost: 0.01, done: true };
      });

      await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

      // Check mu was written
      const muCalls = K.kvWriteSafe.mock.calls.filter(c => c[0].startsWith("mu:"));
      expect(muCalls).toHaveLength(1);
      expect(muCalls[0][0]).toBe("mu:slack-ok");
      expect(muCalls[0][1].confirmation_count).toBe(1);
      expect(muCalls[0][1].violation_count).toBe(0);
    });

    it("writes episode when salience exceeds threshold", async () => {
      K.callLLM = vi.fn(async ({ step }) => {
        if (step.startsWith("plan_")) {
          return {
            content: JSON.stringify({
              action: "big thing", success: "impressive", relies_on: [],
              defer_if: "", no_action: false,
            }),
            cost: 0.01, toolCalls: null,
          };
        }
        return {
          content: JSON.stringify({
            assessment: "amazing", narrative: "Something remarkable happened",
            salience_estimate: 0.8, mu_updates: [],
          }),
          cost: 0.01, toolCalls: null,
        };
      });
      K.runAgentTurn = vi.fn(async ({ messages }) => {
        messages.push({ role: "assistant", content: "Done." });
        return { response: { content: "Done." }, toolResults: [], cost: 0.01, done: true };
      });

      await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

      const episodeCalls = K.kvWriteSafe.mock.calls.filter(c => c[0].startsWith("episode:"));
      expect(episodeCalls).toHaveLength(1);
      expect(episodeCalls[0][1].narrative).toBe("Something remarkable happened");
      expect(episodeCalls[0][1].surprise_score).toBe(0);
      expect(episodeCalls[0][1].embedding).toBeNull();
    });

    it("skips episode when salience is below threshold", async () => {
      K.callLLM = vi.fn(async ({ step }) => {
        if (step.startsWith("plan_")) {
          return {
            content: JSON.stringify({
              action: "routine", success: "done", relies_on: [],
              defer_if: "", no_action: false,
            }),
            cost: 0.01, toolCalls: null,
          };
        }
        return {
          content: JSON.stringify({
            assessment: "fine", narrative: "Routine work", salience_estimate: 0.2,
            mu_updates: [],
          }),
          cost: 0.01, toolCalls: null,
        };
      });
      K.runAgentTurn = vi.fn(async ({ messages }) => {
        messages.push({ role: "assistant", content: "Done." });
        return { response: { content: "Done." }, toolResults: [], cost: 0.01, done: true };
      });

      await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

      const episodeCalls = K.kvWriteSafe.mock.calls.filter(c => c[0].startsWith("episode:"));
      expect(episodeCalls).toHaveLength(0);
    });

    it("filters out hallucinated check_ids from mu_updates", async () => {
      K.callLLM = vi.fn(async ({ step }) => {
        if (step.startsWith("plan_")) {
          return {
            content: JSON.stringify({
              action: "test", success: "works", relies_on: ["assumption:slack-ok"],
              defer_if: "", no_action: false,
            }),
            cost: 0.01, toolCalls: null,
          };
        }
        return {
          content: JSON.stringify({
            assessment: "ok", narrative: "ok", salience_estimate: 0.3,
            mu_updates: [
              { check_id: "slack-ok", confirmed: true },
              { check_id: "hallucinated-id", confirmed: true },
            ],
          }),
          cost: 0.01, toolCalls: null,
        };
      });
      K.runAgentTurn = vi.fn(async ({ messages }) => {
        messages.push({ role: "assistant", content: "Done." });
        return { response: { content: "Done." }, toolResults: [], cost: 0.01, done: true };
      });

      await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

      // Only valid check_id should be written
      const muCalls = K.kvWriteSafe.mock.calls.filter(c => c[0].startsWith("mu:"));
      expect(muCalls).toHaveLength(1);
      expect(muCalls[0][0]).toBe("mu:slack-ok");

      // Hallucinated ID should be karma-logged
      expect(K.karmaRecord).toHaveBeenCalledWith(
        expect.objectContaining({ event: "review_unknown_check_id", check_id: "hallucinated-id" })
      );
    });
  });
```

- [ ] **Step 3: Run tests**

Run: `npm test -- tests/session.test.js`

Expected: All tests PASS (cold start + plan phase + memory write tests).

- [ ] **Step 4: Commit**

```bash
git add tests/session.test.js
git commit -m "test(m3): add session phase and memory write tests

Plan phase: action/no_action branching.
Memory: mu confirmation/violation, episode salience gating,
hallucinated check_id filtering."
```

---

## Task 5: Refactor act.js to library

**Files:**
- Modify: `act.js`
- Modify: `tests/tools.test.js` (if it imports act.js — check first)

- [ ] **Step 1: Check for act.js import dependencies**

Run: `grep -rn "from.*act.js\|require.*act" tests/ index.js reflect.js --include="*.js"` to find all files importing act.js.

- [ ] **Step 2: Rewrite act.js as library**

Replace `act.js` contents with library exports that `session.js` uses:

```javascript
// Swayambhu — Act Library
// Prompt rendering, tool set building, context formatting.
// Called by session.js — no longer a standalone hook entry point.

export async function renderActPrompt(K, { defaults, modelsConfig } = {}) {
  const actPrompt = await K.kvGet("prompt:act");
  if (!actPrompt) return "You are a helpful agent. Execute the planned action using available tools.";

  const resources = await K.kvGet("config:resources");
  const subagents = await K.kvGet("config:subagents");

  const skillList = await K.kvList({ prefix: "skill:", limit: 100 });
  const skill_manifest = [];
  for (const k of skillList.keys) {
    if (k.name.includes(":ref")) continue;
    const v = await K.kvGet(k.name);
    if (v) {
      try {
        const parsed = typeof v === "string" ? JSON.parse(v) : v;
        skill_manifest.push({
          key: k.name,
          name: parsed.name,
          description: parsed.description,
          trigger_patterns: parsed.trigger_patterns,
        });
      } catch {}
    }
  }

  return K.buildPrompt(actPrompt, {
    models: modelsConfig,
    resources,
    config: defaults,
    skill_manifest: skill_manifest.length ? skill_manifest : null,
    subagents: subagents || null,
  });
}

export async function buildToolSet(K) {
  return K.buildToolDefinitions();
}

export function formatDesires(d) {
  return JSON.stringify(
    Object.entries(d).map(([key, val]) => ({
      key,
      slug: val.slug,
      direction: val.direction,
      description: val.description,
    })),
    null, 2
  );
}

export function formatAssumptions(m) {
  return JSON.stringify(
    Object.entries(m).map(([key, val]) => ({
      key,
      slug: val.slug,
      check: val.check,
      confidence: val.confidence,
      ttl_expires: val.ttl_expires,
    })),
    null, 2
  );
}

export function formatCircumstances(c) {
  return JSON.stringify(c, null, 2);
}
```

- [ ] **Step 3: Run all tests**

Run: `npm test`

Expected: All tests pass. The old `tests/session.test.js` tests that imported `runAct` from act.js will have been replaced in Task 3. The new session tests mock act.js already.

- [ ] **Step 4: Commit**

```bash
git add act.js
git commit -m "refactor(m3): convert act.js to library

Exports renderActPrompt, buildToolSet, formatDesires, formatAssumptions,
formatCircumstances. No longer a standalone hook entry point."
```

---

## Task 6: Update reflect.js — coldStart + schedule ownership

**Files:**
- Modify: `reflect.js` (~lines 185, 198, 250)

- [ ] **Step 1: Add coldStart support to runReflect**

In `reflect.js`, modify `runReflect` (line ~198) to accept coldStart in context:

Change:
```javascript
export async function runReflect(K, state, depth, context) {
  const { defaults } = state;
  const sessionId = await K.getSessionId();

  const prompt = await loadReflectPrompt(K, state, depth);
  const initialCtx = await gatherReflectContext(K, state, depth, context);
```

To:
```javascript
export async function runReflect(K, state, depth, context) {
  const { defaults } = state;
  const sessionId = await K.getSessionId();

  // Cold start: derive desires from principles alone
  const isColdStart = context?.coldStart === true;

  const prompt = isColdStart
    ? coldStartPrompt()
    : await loadReflectPrompt(K, state, depth);
  const initialCtx = isColdStart
    ? { userMessage: "Begin. Derive initial desires from principles.", templateVars: {} }
    : await gatherReflectContext(K, state, depth, context);
```

- [ ] **Step 2: Add coldStartPrompt function**

Add before the existing `defaultReflectPrompt()` function (~line 566):

```javascript
function coldStartPrompt() {
  return `You are performing the initial desire derivation for a new agent.
You have no experience, no statistical memory, no episodic memory, and no existing desires.
Your only inputs are the principles (injected in the system prompt as [PRINCIPLES]).

Derive initial desires from principles alone: D_p(∅, ∅) = d_0.
For each desire, output a JSON object with: slug, direction ("approach" or "avoidance"),
description, and source_principles (which principle keys generated this desire).

Output format:
{
  "kv_operations": [
    { "key": "desire:slug", "value": { "slug": "...", "direction": "...", "description": "...", "source_principles": ["..."], "created_at": "...", "updated_at": "..." } }
  ]
}`;
}
```

- [ ] **Step 3: Remove session_schedule writes from reflect.js**

In `applyReflectOutput` (~line 185), remove or gate the session_schedule write:

Change:
```javascript
  if (output.next_session_config) {
    const scheduleConf = { ...output.next_session_config };
    if (scheduleConf.interval_seconds) {
      scheduleConf.next_session_after = new Date(
        Date.now() + scheduleConf.interval_seconds * 1000
      ).toISOString();
    }
    await K.kvWriteSafe("session_schedule", scheduleConf);
  }
```

To:
```javascript
  // session_schedule is now owned by session.js
  // Reflect output can suggest schedule preferences but doesn't write directly
  if (output.next_session_config) {
    await K.karmaRecord({
      event: "reflect_schedule_suggestion",
      config: output.next_session_config,
    });
  }
```

- [ ] **Step 4: Run all tests**

Run: `npm test`

Expected: All tests pass. Existing reflect tests may need minor adjustments if they assert session_schedule writes from reflect — check and update.

- [ ] **Step 5: Commit**

```bash
git add reflect.js
git commit -m "feat(m3): add coldStart to reflect, transfer schedule ownership

runReflect accepts coldStart flag for D_p(∅,∅) desire derivation.
session_schedule writes removed — session.js owns scheduling."
```

---

## Task 7: Wire index.js and governor

**Files:**
- Modify: `index.js` (~lines 7, 62, 90-98)
- Modify: `governor/builder.js` (~lines 14, 65-70, 92-93, 136)

- [ ] **Step 1: Update index.js**

Replace lines ~7 and ~62:

Change:
```javascript
import * as act from './act.js';
import * as reflect from './reflect.js';
```
and:
```javascript
const HOOKS = { act, reflect };
```

To:
```javascript
import * as session from './session.js';
```
and:
```javascript
const HOOKS = { session };
```

Remove the `act` and `reflect` imports (session.js imports them internally).

- [ ] **Step 2: Update governor/builder.js**

In `keyToFilePath` (~line 14), add session hook:

```javascript
  if (key === 'hook:session:code') return 'session.js';
```

In `readCodeFromKV` (~line 65), add session code reading:

```javascript
  const sessionCode = await kv.get('hook:session:code', 'text');
  if (sessionCode) files['session.js'] = sessionCode;
```

In `generateIndexJS` (~line 92), change the policy hooks import:

Change:
```javascript
  lines.push("import * as act from './act.js';");
  lines.push("import * as reflect from './reflect.js';");
```

To:
```javascript
  lines.push("import * as session from './session.js';");
```

And change the HOOKS line (~line 136):

Change:
```javascript
  lines.push("const HOOKS = { act, reflect };");
```

To:
```javascript
  lines.push("const HOOKS = { session };");
```

- [ ] **Step 3: Run all tests**

Run: `npm test`

Expected: All tests pass. Governor tests should still pass since they test the builder output shape.

- [ ] **Step 4: Commit**

```bash
git add index.js governor/builder.js
git commit -m "feat(m3): wire session.js as single hook entry point

index.js: HOOKS = { session } replaces { act, reflect }.
governor/builder.js: reads hook:session:code, generates session import."
```

---

## Task 8: Update CLAUDE.md and clean up stale plan

**Files:**
- Modify: `CLAUDE.md`
- Delete: `docs/superpowers/plans/2026-03-31-kv-schema-module-2.md` (completed, in git history)

- [ ] **Step 1: Update CLAUDE.md**

Add `session.js` to the file table in the "Two-worker architecture" section. Update the description of `act.js`:

In the Runtime Worker table, change:
```
| `act.js` | Session policy — act flow, context building | Yes (via code staging) |
```
To:
```
| `session.js` | Session hook — plan→act→eval→review cycle, cold start | Yes (via code staging) |
| `act.js` | Act library — prompt rendering, tool defs, context formatting | Yes (via code staging) |
| `eval.js` | Eval stub — mechanical σ/α computation (typed zeros in M3) | Yes (via code staging) |
```

- [ ] **Step 2: Delete completed Module 2 plan**

```bash
git rm docs/superpowers/plans/2026-03-31-kv-schema-module-2.md
```

- [ ] **Step 3: Run tests to verify nothing broke**

Run: `npm test`

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "doc(m3): update CLAUDE.md for session rewrite, clean stale plan

Add session.js, eval.js to file table. Update act.js description.
Remove completed Module 2 plan."
```

---

## Self-Review Checklist

**Spec coverage:**
- ✅ Section 2 (runAgentTurn): Task 1
- ✅ Section 3 (session.js hook): Task 3
- ✅ Section 4 (plan phase): Task 3 (runPlanPhase), Task 4 (tests)
- ✅ Section 5 (act phase): Task 3 (runActPhase), Task 4 (tests)
- ✅ Section 6 (eval stub): Task 2
- ✅ Section 7 (review phase): Task 3 (runReviewPhase), Task 4 (tests)
- ✅ Section 8 (memory writes): Task 3 (writeMemory), Task 4 (tests)
- ✅ Section 9 (circumstances refresh): Task 3 (refreshCircumstances)
- ✅ Section 10 (cold start): Task 3, Task 6
- ✅ Section 11 (wiring): Task 5 (act.js), Task 6 (reflect.js), Task 7 (index.js, governor)
- ✅ Section 12 (testing): Tasks 1, 2, 3, 4
- ✅ Section 13 (module boundaries): eval stub interface contract in Task 2

**Placeholder scan:** No TBDs, TODOs, or vague steps. All code complete.

**Type consistency:**
- `evaluateAction(ledger, desires, assumptions)` — consistent across eval.js and session.js
- `run(K, { crashData, balances, events, schedule })` — matches kernel.js:855 call
- Plan schema `{ action, success, relies_on, defer_if, no_action }` — consistent across plan phase and tests
- Review schema `{ assessment, narrative, salience_estimate, mu_updates }` — consistent across review phase and tests
- Episode assembly matches `tests/schema.test.js` field definitions
