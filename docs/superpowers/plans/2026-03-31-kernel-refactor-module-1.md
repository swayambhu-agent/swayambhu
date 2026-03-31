# Kernel Refactor — Module 1: Strip Cognitive Policy

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove all cognitive-architecture-specific code from kernel.js, replacing it with generic infrastructure primitives. Target: ~1990 LOC (down from 2462).

**Architecture:** The kernel currently encodes cognitive policy (yamas/niyamas, proposal system, session type decisions, tripwire evaluation, context building). The cognitive architecture spec (section 10) defines a clean kernel/hook boundary: the kernel provides KV, LLM, tools, events, safety, and bookkeeping. Everything else moves to hooks or gets replaced with generic primitives. This refactor touches kernel.js only — hooks consume the new interface but their rewrite is Module 3.

**Tech Stack:** JavaScript (Cloudflare Workers runtime), Vitest for tests

**Spec reference:** `swayambhu-cognitive-architecture.md` sections 10.1–10.8

---

## What Gets Removed/Changed (LOC Impact)

| Section | Current LOC | After | Delta | What happens |
|---------|------------|-------|-------|--------------|
| Proposal system (createProposal, loadProposals, updateProposalStatus, processProposalVerdicts, evaluatePredicate, _evaluateCheck, _evaluateChecks, isCodeKey, CODE_KEY_PATTERNS) | ~185 | ~25 | -160 | Replaced by `stageCode()` + `signalDeploy()` |
| Yama/niyama system (loadYamasNiyamas, isYamaCapable, isNiyamaCapable, PRINCIPLE_PREFIXES, yama/niyama caching, yama/niyama injection in callLLM, deliberation gates in _gateSystem) | ~120 | ~30 | -90 | Replaced by generic `loadPrinciples()` + `[PRINCIPLES]` injection |
| Cognitive runSession (ACT_RELEVANT_EVENTS, session_request scanning, last_reflect loading, reflect schedule loading, highestReflectDepthDue, act vs reflect decision, tripwire evaluation, context building, DM handling) | ~160 | ~30 | -130 | Replaced by spec's 5-step runSession (§10.5) |
| Config utilities (getMaxSteps, getReflectModel, evaluateTripwires) | ~40 | 0 | -40 | Moved to hooks (cognitive policy) |
| Subplan system (spawnSubplan, spawn_subplan tool def, defaultSubplanPrompt) | ~75 | 0 | -75 | Removed per spec §11.1 — looping session replaces subplans |
| Budget role detection in runAgentLoop | ~15 | 0 | -15 | Caller passes budget config directly |
| Key tier hardcoding (SYSTEM_KEY_PREFIXES, KERNEL_ONLY_PREFIXES, etc.) | ~20 | ~15 | -5 | Config-driven via `kernel:key_tiers` |
| **Total** | | | **~-515** | **2462 - 515 + new code (~45) = ~1992** |

## New Code Added

| Addition | Est. LOC | Purpose |
|----------|---------|---------|
| `loadPrinciples()` | ~12 | Generic replacement for `loadYamasNiyamas()` |
| `stageCode()` + `signalDeploy()` | ~15 | Two primitives replacing proposal system |
| `_isSessionDue()` | ~8 | Extract schedule check from runSession |
| Config-driven key tier matching | ~10 | Read from `kernel:key_tiers` instead of static arrays |
| **Total new** | **~45** | |

---

### Task 1: Replace Proposal System with Code Staging Primitives

The proposal system is ~185 LOC of cognitive policy (claims, verdicts, checks, predicate evaluation). Replace with two kernel primitives: `stageCode(targetKey, code)` and `signalDeploy()`.

**Files:**
- Modify: `kernel.js:763-948` (proposal system + predicate evaluation)
- Test: `tests/kernel.test.js` (replace proposal tests with staging tests)
- Modify: `tests/proposals.test.js` (will be deleted/replaced)

**Depends on:** Nothing (standalone)

- [ ] **Step 1: Write failing tests for stageCode and signalDeploy**

In `tests/kernel.test.js`, add a new describe block:

```javascript
describe("code staging", () => {
  it("stageCode writes to code_staging: prefix", async () => {
    const kernel = createTestKernel();
    await kernel.stageCode("tool:kv_query:code", "export function execute() {}");
    const staged = await kernel.kvGet("code_staging:tool:kv_query:code");
    expect(staged).toEqual({
      code: "export function execute() {}",
      staged_at: expect.any(String),
      session_id: kernel.sessionId,
    });
  });

  it("stageCode rejects non-code keys", async () => {
    const kernel = createTestKernel();
    await expect(kernel.stageCode("config:defaults", "bad"))
      .rejects.toThrow("not a code key");
  });

  it("signalDeploy writes deploy:pending", async () => {
    const kernel = createTestKernel();
    await kernel.signalDeploy();
    const pending = await kernel.kvGet("deploy:pending");
    expect(pending).toEqual({
      requested_at: expect.any(String),
      session_id: kernel.sessionId,
    });
  });

  it("signalDeploy records karma", async () => {
    const kernel = createTestKernel();
    await kernel.signalDeploy();
    expect(kernel.karma).toContainEqual(
      expect.objectContaining({ event: "deploy_signaled" })
    );
  });

  it("stageCode records karma", async () => {
    const kernel = createTestKernel();
    await kernel.stageCode("tool:kv_query:code", "export function execute() {}");
    expect(kernel.karma).toContainEqual(
      expect.objectContaining({ event: "code_staged", target: "tool:kv_query:code" })
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/kernel.test.js -t "code staging"`
Expected: FAIL — `stageCode` and `signalDeploy` do not exist yet

- [ ] **Step 3: Implement stageCode and signalDeploy in kernel.js**

Replace the entire proposal system block (lines 763–948: `CODE_KEY_PATTERNS`, `isCodeKey`, `_generateProposalId`, `createProposal`, `loadProposals`, `updateProposalStatus`, `processProposalVerdicts`, `evaluatePredicate`, `_evaluateCheck`, `_evaluateChecks`) with:

```javascript
  // ── Code staging (two primitives — replaces proposal system) ──────

  static CODE_KEY_PATTERNS = ['tool:', 'hook:', 'provider:', 'channel:'];

  static isCodeKey(key) {
    return Kernel.CODE_KEY_PATTERNS.some(p => key.startsWith(p)) && key.endsWith(':code');
  }

  async stageCode(targetKey, code) {
    if (!Kernel.isCodeKey(targetKey)) {
      throw new Error(`"${targetKey}" is not a code key — stageCode only accepts code keys`);
    }
    const record = {
      code,
      staged_at: new Date().toISOString(),
      session_id: this.sessionId,
    };
    await this.kvWrite(`code_staging:${targetKey}`, record);
    await this.karmaRecord({ event: "code_staged", target: targetKey });
  }

  async signalDeploy() {
    await this.kvWrite("deploy:pending", {
      requested_at: new Date().toISOString(),
      session_id: this.sessionId,
    });
    await this.karmaRecord({ event: "deploy_signaled" });
  }
```

- [ ] **Step 4: Update buildKernelInterface — replace proposal methods with staging**

In `buildKernelInterface()`, remove:

```javascript
      createProposal: async (request, sessionId, depth) => kernel.createProposal(request, sessionId, depth),
      loadProposals: async (statusFilter) => kernel.loadProposals(statusFilter),
      updateProposalStatus: async (id, newStatus, metadata) => kernel.updateProposalStatus(id, newStatus, metadata),
      processProposalVerdicts: async (verdicts, depth) => kernel.processProposalVerdicts(verdicts, depth),
```

Replace with:

```javascript
      stageCode: async (targetKey, code) => kernel.stageCode(targetKey, code),
      signalDeploy: async () => kernel.signalDeploy(),
```

- [ ] **Step 5: Update kvWriteGated — code keys use stageCode, not proposals**

In `kvWriteGated()`, change the code key block (line ~531):

From:
```javascript
    // 3. Always blocked — code keys go through proposal_requests
    if (Kernel.isCodeKey(key)) {
      return { ok: false, error: `Code key "${key}" requires proposal_requests` };
    }
```

To:
```javascript
    // 3. Always blocked — code keys go through stageCode()
    if (Kernel.isCodeKey(key)) {
      return { ok: false, error: `Code key "${key}" requires K.stageCode()` };
    }
```

- [ ] **Step 6: Remove spawn_subplan from buildToolDefinitions**

Remove the `spawn_subplan` tool definition block from `buildToolDefinitions()` (lines ~1901-1918):

```javascript
    // Built-in: spawn a nested agent loop — REMOVE THIS ENTIRE BLOCK
    defs.push({
      type: 'function',
      function: {
        name: 'spawn_subplan',
        ...
      },
    });
```

- [ ] **Step 7: Remove spawnSubplan method and defaultSubplanPrompt**

Delete the `spawnSubplan` method (lines ~2083-2141) and `defaultSubplanPrompt` method (lines ~2449-2455).

Also remove from `buildKernelInterface()`:

```javascript
      spawnSubplan: async (args, depth) => kernel.spawnSubplan(args, depth),
```

And remove from `executeToolCall()`:

```javascript
    if (name === 'spawn_subplan') {
      return this.spawnSubplan(args);
    }
```

- [ ] **Step 8: Run all tests**

Run: `npm test`
Expected: Proposal-related tests fail (they test removed code). Code staging tests pass. Everything else passes.

- [ ] **Step 9: Remove/replace proposal tests**

Delete `tests/proposals.test.js`. In `tests/kernel.test.js`, find and remove any existing proposal-related tests (search for "proposal"). The new staging tests from Step 1 replace them.

Also search `tests/session.test.js` for any proposal references and remove/update as needed.

- [ ] **Step 10: Run all tests again**

Run: `npm test`
Expected: All pass

- [ ] **Step 11: Commit**

```bash
git add kernel.js tests/kernel.test.js tests/proposals.test.js tests/session.test.js
git commit -m "refactor: replace proposal system with stageCode/signalDeploy primitives

Removes ~185 LOC of cognitive policy (claims, verdicts, checks, predicate
evaluation) from the kernel. Two primitives remain: stageCode() writes to
code_staging: prefix, signalDeploy() writes deploy:pending. Governor
behavior unchanged. Also removes spawn_subplan (replaced by looping session
in cognitive architecture redesign)."
```

---

### Task 2: Replace Yama/Niyama System with Generic Principles

The kernel currently has yama/niyama-specific code: loading, caching, capability gates, deliberation requirements, LLM injection blocks, and audit trails. Replace with a generic `principle:*` system where principles are immutable (cannot be written by the agent at all).

**Files:**
- Modify: `kernel.js` (constructor, loadEagerConfig, loadYamasNiyamas, isYamaCapable, isNiyamaCapable, callLLM, _gateSystem, buildKernelInterface)
- Test: `tests/kernel.test.js`

**Depends on:** Nothing (standalone, can be done in parallel with Task 1)

- [ ] **Step 1: Write failing tests for loadPrinciples and principle injection**

```javascript
describe("principles (generic)", () => {
  it("loadPrinciples loads all principle: keys", async () => {
    const kernel = createTestKernel();
    kernel.kv._data.set("principle:honesty", JSON.stringify("Always be truthful"));
    kernel.kv._data.set("principle:kindness", JSON.stringify("Be kind to all beings"));
    kernel.kv._data.set("principle:honesty:audit", JSON.stringify([])); // should be skipped
    await kernel.loadPrinciples();
    expect(kernel.principles).toEqual({
      "principle:honesty": "Always be truthful",
      "principle:kindness": "Be kind to all beings",
    });
  });

  it("callLLM injects [PRINCIPLES] block", async () => {
    const kernel = createTestKernel();
    kernel.principles = {
      "principle:honesty": "Always be truthful",
    };
    // Mock the LLM provider to capture the system prompt
    let capturedMessages;
    kernel.PROVIDERS['provider:llm'] = {
      meta: { secrets: [] },
      call: async (req) => {
        capturedMessages = req.messages;
        return { content: "ok", usage: { prompt_tokens: 10, completion_tokens: 5 } };
      },
    };
    await kernel.callLLM({
      model: "test-model", messages: [{ role: "user", content: "hi" }],
      step: "test",
    });
    const systemMsg = capturedMessages.find(m => m.role === "system");
    expect(systemMsg.content).toContain("[PRINCIPLES]");
    expect(systemMsg.content).toContain("Always be truthful");
    expect(systemMsg.content).not.toContain("[YAMAS]");
    expect(systemMsg.content).not.toContain("[NIYAMAS]");
  });

  it("kvWriteGated rejects principle: writes as immutable", async () => {
    const kernel = createTestKernel();
    const result = await kernel.kvWriteGated(
      { op: "put", key: "principle:honesty", value: "new value" },
      "deep-reflect"
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("immutable");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/kernel.test.js -t "principles"`
Expected: FAIL — `loadPrinciples` does not exist

- [ ] **Step 3: Implement loadPrinciples**

Replace `loadYamasNiyamas()` (lines 118-131) with:

```javascript
  async loadPrinciples() {
    this.principles = {};
    const keys = await this.kvListAll({ prefix: 'principle:' });
    for (const { name: key } of keys) {
      if (key.endsWith(':audit')) continue;
      const value = await this.kvGet(key);
      if (value !== null) this.principles[key] = value;
    }
  }
```

- [ ] **Step 4: Update constructor — replace yama/niyama state with principles**

In the constructor, replace:

```javascript
    this.yamas = null;
    this.niyamas = null;
    this.lastCallModel = null;
```

With:

```javascript
    this.principles = null;
```

Remove `this.lastCallModel` — it was only needed for yama/niyama capability checks.

- [ ] **Step 5: Update loadEagerConfig**

Replace:

```javascript
    await this.loadYamasNiyamas();
```

With:

```javascript
    await this.loadPrinciples();
```

- [ ] **Step 6: Remove isYamaCapable, isNiyamaCapable, PRINCIPLE_PREFIXES**

Delete:
- `static PRINCIPLE_PREFIXES = ['yama:', 'niyama:'];` (line 64)
- `static isPrincipleKey(key)` (lines 77-79)
- `static isPrincipleAuditKey(key)` (lines 81-83)
- `isYamaCapable(modelId)` (lines 219-222)
- `isNiyamaCapable(modelId)` (lines 224-227)

- [ ] **Step 7: Simplify callLLM — generic principles injection**

In `callLLM()`, replace the yama/niyama injection block (lines 1696-1713) with:

```javascript
    // Kernel-enforced principle injection — always present
    let principlesBlock = '';
    if (this.principles && Object.keys(this.principles).length > 0) {
      const entries = Object.entries(this.principles)
        .map(([key, text]) => {
          const name = key.replace('principle:', '');
          return `[${name}]\n${text}\n[/${name}]`;
        }).join('\n');
      principlesBlock = `[PRINCIPLES]\n${entries}\n[/PRINCIPLES]\n\n`;
    }
```

- [ ] **Step 8: Simplify _gateSystem — principles are immutable**

In `_gateSystem()`, replace the yama/niyama deliberation + capability block (lines 633-647) and the principle warning block (lines 655-668) and the audit trail block (lines 694-705) and the principle reload block (lines 722-725) with a single immutable rejection at the top:

```javascript
  async _gateSystem(op) {
    const key = op.key;

    // Only put/delete/patch supported for system keys
    if (!["put", "delete", "patch"].includes(op.op)) {
      return { ok: false, error: `Unsupported op "${op.op}" for system key "${key}"` };
    }

    // Principles are immutable — agent cannot write them
    if (key.startsWith("principle:")) {
      return { ok: false, error: `Cannot write "${key}" — principles are immutable` };
    }

    // Model capabilities require deliberation
    if (key === "config:model_capabilities") {
      if (!op.deliberation || op.deliberation.length < 200) {
        return { ok: false, error: `Model capability changes require deliberation (min 200 chars, got ${op.deliberation?.length || 0})` };
      }
    }

    // Per-session limit
    if (this.privilegedWriteCount + 1 > Kernel.MAX_PRIVILEGED_WRITES) {
      return { ok: false, error: `Privileged write limit (${Kernel.MAX_PRIVILEGED_WRITES}/session) exceeded` };
    }

    // Snapshot old value
    const { value: oldValue } = await this.kvGetWithMeta(key);

    // Execute
    if (op.op === "delete") {
      await this.kv.delete(key);
    } else if (op.op === "patch") {
      const current = await this.kvGet(key);
      if (typeof current !== "string") return { ok: false, error: `patch: key "${key}" is not a string` };
      if (!current.includes(op.old_string)) return { ok: false, error: `patch: old_string not found in "${key}"` };
      if (current.indexOf(op.old_string) !== current.lastIndexOf(op.old_string)) return { ok: false, error: `patch: old_string matches multiple locations in "${key}"` };
      await this.kvWrite(key, current.replace(op.old_string, op.new_string), op.metadata);
    } else {
      await this.kvWrite(key, op.value, op.metadata);
    }

    // Karma after successful write
    await this.karmaRecord({
      event: "privileged_write", key, old_value: oldValue,
      new_value: op.value, op: op.op,
    });
    this.privilegedWriteCount++;

    // Alert on hook: key writes
    if (key.startsWith("hook:")) {
      await this.sendKernelAlert("hook_write",
        `Privileged write to ${key} in session ${this.sessionId}`);
    }

    // Auto-reload cached config
    const configKeys = ["config:defaults", "config:models", "config:tool_registry", "config:model_capabilities"];
    if (configKeys.includes(key)) {
      if (key === "config:defaults") this.defaults = await this.kvGet("config:defaults");
      if (key === "config:models") this.modelsConfig = await this.kvGet("config:models");
      if (key === "config:tool_registry") this.toolRegistry = await this.kvGet("config:tool_registry");
      if (key === "config:model_capabilities") this.modelCapabilities = await this.kvGet("config:model_capabilities");
    }

    return { ok: true };
  }
```

- [ ] **Step 9: Update buildKernelInterface — replace yama/niyama getters**

Remove:

```javascript
      getYamas: async () => kernel.yamas,
      getNiyamas: async () => kernel.niyamas,
      getMaxSteps: async (state, role, depth) => Kernel.getMaxSteps(state, role, depth),
      getReflectModel: async (state, depth) => Kernel.getReflectModel(state, depth),
```

Add:

```javascript
      getPrinciples: async () => kernel.principles,
```

- [ ] **Step 10: Update kvWriteGated — add principle: to immutable check**

In `kvWriteGated()`, update the immutable check (line ~521):

From:
```javascript
    if (key === "dharma" || Kernel.IMMUTABLE_KEYS.includes(key)) {
```

To:
```javascript
    if (key === "dharma" || key.startsWith("principle:") || Kernel.IMMUTABLE_KEYS.includes(key)) {
```

This means principle writes are rejected before reaching `_gateSystem`. The check in `_gateSystem` is belt-and-suspenders.

- [ ] **Step 11: Update kvWrite metadata defaults**

In `kvWrite()`, replace the yama/niyama entries:

```javascript
      yama:       { type: "yama", format: "text" },
      niyama:     { type: "niyama", format: "text" },
```

With:

```javascript
      principle:  { type: "principle", format: "text" },
```

- [ ] **Step 12: Remove static getMaxSteps and getReflectModel**

Delete the `getMaxSteps` static method (lines 1291-1299) and `getReflectModel` static method (lines 1301-1306). These are cognitive policy — hooks will own them.

- [ ] **Step 13: Remove static evaluateTripwires**

Delete the `evaluateTripwires` static method (lines 1266-1287). This is cognitive policy.

- [ ] **Step 14: Run all tests**

Run: `npm test`
Expected: Some yama/niyama tests will fail (test old behavior). Fix them:
- Tests referencing `kernel.yamas` / `kernel.niyamas` → use `kernel.principles`
- Tests referencing `isYamaCapable` / `isNiyamaCapable` → remove
- Tests referencing `getYamas` / `getNiyamas` on K → use `getPrinciples`
- Tests referencing `evaluateTripwires` → remove (cognitive policy)
- Tests referencing `getMaxSteps` / `getReflectModel` → remove

- [ ] **Step 15: Fix failing tests**

Update all failing tests to match the new interface. Specifically search for and update:
- `yama` and `niyama` references in test files
- `PRINCIPLE_PREFIXES` references
- `isPrincipleKey` / `isPrincipleAuditKey` references
- `lastCallModel` references
- `evaluateTripwires` references

- [ ] **Step 16: Run all tests again**

Run: `npm test`
Expected: All pass

- [ ] **Step 17: Commit**

```bash
git add kernel.js tests/kernel.test.js tests/session.test.js
git commit -m "refactor: replace yama/niyama system with generic immutable principles

loadPrinciples() replaces loadYamasNiyamas(). [PRINCIPLES] block replaces
separate [YAMAS]/[NIYAMAS] blocks in LLM injection. Principles are fully
immutable — agent cannot write principle:* keys. Removes capability gates,
deliberation requirements, and audit trails for principle modifications.
Also removes getMaxSteps, getReflectModel, evaluateTripwires (cognitive
policy moves to hooks)."
```

---

### Task 3: Simplify runSession — Remove Cognitive Orchestration

The current `runSession()` is ~190 lines of cognitive orchestration (load last_reflect, check reflect schedules, evaluate tripwires, build context, decide act vs reflect). Replace with the spec's 5-step version that hands everything to a single `session.run` hook.

**Files:**
- Modify: `kernel.js:1051-1242` (runSession method)
- Test: `tests/session.test.js`

**Depends on:** Task 2 (evaluateTripwires removed)

- [ ] **Step 1: Write failing tests for the new runSession**

```javascript
describe("simplified runSession", () => {
  it("calls HOOKS.session.run with kernel interface and infrastructure inputs", async () => {
    const kernel = createTestKernel();
    let hookArgs;
    kernel.HOOKS.session = {
      run: async (K, inputs) => { hookArgs = { K, inputs }; },
    };
    // Seed required KV state
    kernel.kv._data.set("session_schedule", JSON.stringify({
      next_session_after: new Date(Date.now() - 1000).toISOString(),
    }));
    kernel.kv._data.set("config:defaults", JSON.stringify({
      session_budget: { max_cost: 1.0 },
    }));
    await kernel.runSession();
    expect(hookArgs).toBeDefined();
    expect(hookArgs.inputs).toHaveProperty("crashData");
    expect(hookArgs.inputs).toHaveProperty("balances");
    expect(hookArgs.inputs).toHaveProperty("events");
    expect(hookArgs.inputs).toHaveProperty("schedule");
  });

  it("skips session when not due", async () => {
    const kernel = createTestKernel();
    kernel.kv._data.set("session_schedule", JSON.stringify({
      next_session_after: new Date(Date.now() + 60000).toISOString(),
    }));
    const result = await kernel.runSession();
    expect(result).toEqual({ skipped: true, reason: "not_time_yet" });
  });

  it("does NOT load last_reflect, reflect schedules, or pending requests", async () => {
    const kernel = createTestKernel();
    const kvGetCalls = [];
    const originalKvGet = kernel.kvGet.bind(kernel);
    kernel.kvGet = async (key) => {
      kvGetCalls.push(key);
      return originalKvGet(key);
    };
    kernel.HOOKS.session = { run: async () => {} };
    kernel.kv._data.set("session_schedule", JSON.stringify({
      next_session_after: new Date(Date.now() - 1000).toISOString(),
    }));
    await kernel.runSession();
    expect(kvGetCalls).not.toContain("last_reflect");
    expect(kvGetCalls.filter(k => k.startsWith("reflect:schedule:"))).toHaveLength(0);
  });

  it("does NOT call HOOKS.act.runAct or HOOKS.reflect.runReflect", async () => {
    const kernel = createTestKernel();
    kernel.HOOKS.session = { run: async () => {} };
    kernel.HOOKS.act = { runAct: vi.fn() };
    kernel.HOOKS.reflect = { runReflect: vi.fn() };
    kernel.kv._data.set("session_schedule", JSON.stringify({
      next_session_after: new Date(Date.now() - 1000).toISOString(),
    }));
    await kernel.runSession();
    expect(kernel.HOOKS.act.runAct).not.toHaveBeenCalled();
    expect(kernel.HOOKS.reflect.runReflect).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/session.test.js -t "simplified runSession"`
Expected: FAIL — current runSession calls act/reflect hooks, not session.run

- [ ] **Step 3: Implement the simplified runSession**

Replace the entire `runSession()` method (lines 1051-1242) with:

```javascript
  async runSession() {
    await this.loadEagerConfig();
    const K = this.buildKernelInterface();

    // 1. Schedule gate
    const schedule = await this.kvGet("session_schedule");
    if (!this._isSessionDue(schedule)) {
      return { skipped: true, reason: "not_time_yet" };
    }

    try {
      // 2. Infrastructure inputs
      const crashData = await this._detectCrash();
      const balances = await this.checkBalance({});
      const { processed, actContext } = await this.drainEvents(this._eventHandlers);

      // 3. Session start bookkeeping
      const count = await this.getSessionCount();
      await this.kvWriteSafe("session_counter", count + 1);
      const sessionIds = await this.kvGet("cache:session_ids") || [];
      sessionIds.push(this.sessionId);
      await this.kvWriteSafe("cache:session_ids", sessionIds);

      await this.karmaRecord({
        event: "session_start",
        session_id: this.sessionId,
        session_number: count + 1,
        scheduled_at: schedule?.next_session_after || null,
        crash_detected: !!crashData,
        balances,
      });

      // 4. Hand everything to the session hook
      const { run } = this.HOOKS.session || {};
      if (!run) throw new Error("No session.run hook configured");
      await run(K, { crashData, balances, events: actContext, schedule });

      // 5. Post-session bookkeeping
      let endBalances;
      try { endBalances = await this.checkBalance({}); } catch {}
      await this.karmaRecord({
        event: "session_end",
        session_id: this.sessionId,
        session_cost: this.sessionCost,
        llm_calls: this.sessionLLMCalls,
        elapsed_ms: this.elapsed(),
        ...(endBalances ? { balances: endBalances } : {}),
      });

      await this._writeSessionHealth("clean");
      return { ok: true };

    } catch (err) {
      await this.karmaRecord({
        event: "fatal_error",
        error: err.message,
        stack: err.stack,
      });
      await this._writeSessionHealth("error");
      return { ok: false, error: err.message };
    }
  }

  _isSessionDue(schedule) {
    const nextSession = schedule?.next_session_after;
    if (!nextSession) {
      // No valid session time — heal with default interval so we don't run every tick
      return false;
    }
    return Date.now() >= new Date(nextSession).getTime();
  }
```

- [ ] **Step 4: Remove ACT_RELEVANT_EVENTS static property**

Delete:

```javascript
  static ACT_RELEVANT_EVENTS = ['session_request', 'job_complete', 'patron_direct'];
```

The event bus (`drainEvents`) already returns `actContext` based on handler config, not a hardcoded list. Check that `drainEvents` still works without this — it uses `handlerConfig` from KV, not `ACT_RELEVANT_EVENTS`.

Wait — actually `drainEvents` does reference `ACT_RELEVANT_EVENTS` on line 265:
```javascript
      if (Kernel.ACT_RELEVANT_EVENTS.includes(event.type)) {
        actContext.push(event);
      }
```

This is cognitive policy in the kernel. The hook should decide which events are relevant. Change `drainEvents` to return ALL events, not filter:

```javascript
  async drainEvents(handlers) {
    const handlerConfig = await this.kvGet('config:event_handlers') || {};
    const listResult = await this.kvListAll({ prefix: 'event:' });
    const events = [];

    for (const { name } of listResult) {
      const val = await this.kv.get(name, 'json');
      if (val) events.push({ key: name, ...val });
    }

    if (events.length === 0) return { processed: [], actContext: events };

    const processed = [];

    for (const event of events) {
      const handlerNames = handlerConfig[event.type] || [];
      let allHandlersSucceeded = true;

      for (const handlerName of handlerNames) {
        const handlerFn = handlers[handlerName];
        if (!handlerFn) {
          await this.karmaRecord({
            event: "event_handler_unknown",
            handler: handlerName,
            event_type: event.type,
            event_key: event.key,
          });
          continue;
        }
        try {
          await handlerFn(this.buildKernelInterface(), event);
        } catch (err) {
          allHandlersSucceeded = false;
          await this.karmaRecord({
            event: "event_handler_error",
            handler: handlerName,
            event_type: event.type,
            error: err.message,
          });
        }
      }

      if (allHandlersSucceeded) {
        await this.kv.delete(event.key);
        processed.push(event);
      } else {
        const failKey = `event_fail_count:${event.key}`;
        const failCount = ((await this.kvGet(failKey)) || 0) + 1;
        if (failCount >= 3) {
          const deadKey = event.key.replace('event:', 'event_dead:');
          await this.kv.put(deadKey, JSON.stringify({ ...event, fail_count: failCount }), { expirationTtl: 604800 });
          await this.kv.delete(event.key);
          await this.kv.delete(failKey);
          await this.karmaRecord({ event: "event_dead_lettered", type: event.type, key: event.key });
        } else {
          await this.kv.put(failKey, JSON.stringify(failCount), { expirationTtl: 86400 });
        }
      }
    }

    if (events.length > 0) {
      const typeCounts = {};
      for (const e of events) typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
      await this.karmaRecord({ event: "events_drained", count: events.length, types: typeCounts });
    }

    return { processed, actContext: events };
  }
```

The key change: `actContext` now contains ALL drained events, not a filtered subset. The session hook decides which events matter.

- [ ] **Step 5: Remove karma summarization from runSession**

The `summarizeKarma` call was in the old runSession (lines 1208-1214). It's not in the new version — karma summarization is the hook's job if it wants it.

- [ ] **Step 6: Run all tests**

Run: `npm test`
Expected: Session tests that test the old act/reflect dispatch will fail. Fix them to test the new session.run interface.

- [ ] **Step 7: Fix failing session tests**

In `tests/session.test.js`:
- Replace tests that assert `HOOKS.act.runAct` gets called → assert `HOOKS.session.run` gets called
- Replace tests that check reflect depth routing → remove (hook's job)
- Replace tests that check tripwire evaluation → remove (hook's job)
- Replace tests that check context building (pending requests, DM handling) → remove (hook's job)
- Keep tests for: schedule gating, crash detection, session counter increment, karma records

- [ ] **Step 8: Run all tests**

Run: `npm test`
Expected: All pass

- [ ] **Step 9: Commit**

```bash
git add kernel.js tests/session.test.js tests/kernel.test.js
git commit -m "refactor: simplify runSession to 5-step infrastructure dispatch

Kernel no longer decides act vs reflect, loads context, evaluates tripwires,
or filters events. Single hook entry point: HOOKS.session.run receives K +
{crashData, balances, events, schedule}. drainEvents returns all events
(hook decides relevance). Removes ACT_RELEVANT_EVENTS, session_request
scanning, reflect schedule loading."
```

---

### Task 4: Config-Driven Key Tiers

Replace hardcoded `SYSTEM_KEY_PREFIXES`, `KERNEL_ONLY_PREFIXES`, etc. with config read from `kernel:key_tiers` KV key. The kernel reads this at boot — it's a kernel-only key so the agent can't modify it.

**Files:**
- Modify: `kernel.js` (static arrays, isSystemKey, isKernelOnly, kvWriteGated)
- Test: `tests/kernel.test.js`

**Depends on:** Task 1 (code key handling changed), Task 2 (principle handling changed)

- [ ] **Step 1: Write failing tests for config-driven tiers**

```javascript
describe("config-driven key tiers", () => {
  it("reads key tiers from kernel:key_tiers at boot", async () => {
    const kernel = createTestKernel();
    kernel.kv._data.set("kernel:key_tiers", JSON.stringify({
      immutable: ["dharma", "principle:*"],
      kernel_only: ["karma:*", "sealed:*", "event:*", "kernel:*"],
      protected: ["config:*", "prompt:*", "tool:*", "provider:*"],
    }));
    await kernel.loadEagerConfig();
    expect(kernel.keyTiers).toBeDefined();
    expect(kernel.keyTiers.immutable).toContain("dharma");
  });

  it("isSystemKey uses loaded tiers", async () => {
    const kernel = createTestKernel();
    kernel.keyTiers = {
      immutable: ["dharma"],
      kernel_only: ["karma:*"],
      protected: ["config:*", "custom:*"],
    };
    expect(kernel.isSystemKey("custom:foo")).toBe(true);
    expect(kernel.isSystemKey("random:foo")).toBe(false);
  });

  it("falls back to hardcoded defaults if kernel:key_tiers missing", async () => {
    const kernel = createTestKernel();
    await kernel.loadEagerConfig();
    // Should still work with defaults
    expect(kernel.isSystemKey("config:defaults")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/kernel.test.js -t "config-driven key tiers"`
Expected: FAIL — `keyTiers` not on kernel, `isSystemKey` is static

- [ ] **Step 3: Implement config-driven tiers**

Add to the constructor:

```javascript
    this.keyTiers = null;
```

Add default tiers as a static:

```javascript
  static DEFAULT_KEY_TIERS = {
    immutable: ["dharma", "principle:*", "patron:public_key"],
    kernel_only: ["karma:*", "sealed:*", "event:*", "event_dead:*", "kernel:*"],
    protected: [
      "config:*", "prompt:*", "tool:*", "provider:*", "channel:*",
      "hook:*", "contact:*", "contact_platform:*", "code_staging:*",
      "secret:*", "doc:*", "upaya:*", "prajna:*", "skill:*", "task:*",
    ],
  };
```

In `loadEagerConfig()`, add after existing loads:

```javascript
    this.keyTiers = await this.kvGet("kernel:key_tiers") || Kernel.DEFAULT_KEY_TIERS;
```

Convert `isSystemKey` and `isKernelOnly` from static to instance methods:

```javascript
  _matchesTierPattern(key, patterns) {
    for (const pattern of patterns) {
      if (pattern.endsWith('*')) {
        if (key.startsWith(pattern.slice(0, -1))) return true;
      } else {
        if (key === pattern) return true;
      }
    }
    return false;
  }

  isImmutableKey(key) {
    return this._matchesTierPattern(key, this.keyTiers?.immutable || Kernel.DEFAULT_KEY_TIERS.immutable);
  }

  isKernelOnly(key) {
    return this._matchesTierPattern(key, this.keyTiers?.kernel_only || Kernel.DEFAULT_KEY_TIERS.kernel_only);
  }

  isSystemKey(key) {
    // Protected keys + kernel-only keys + immutable keys are all "system" keys
    return this.isImmutableKey(key)
      || this.isKernelOnly(key)
      || this._matchesTierPattern(key, this.keyTiers?.protected || Kernel.DEFAULT_KEY_TIERS.protected);
  }
```

- [ ] **Step 4: Update all callers of static methods**

Replace all `Kernel.isSystemKey(key)` with `this.isSystemKey(key)` and `Kernel.isKernelOnly(key)` with `this.isKernelOnly(key)` throughout kernel.js. The main callers:

- `kvWriteSafe` — uses `Kernel.isKernelOnly` and `Kernel.isSystemKey`
- `kvDeleteSafe` — same
- `kvWriteGated` — uses `Kernel.IMMUTABLE_KEYS`, `Kernel.isKernelOnly`, `Kernel.isCodeKey`, `Kernel.isSystemKey`
- `buildKernelInterface` — exposes `isSystemKey` and `getSystemKeyPatterns`

Update `kvWriteGated` immutable check:

```javascript
    // 1. Always blocked — immutable keys
    if (this.isImmutableKey(key)) {
      return { ok: false, error: `Cannot write "${key}" — immutable` };
    }

    // 2. Always blocked — kernel-only keys
    if (this.isKernelOnly(key)) {
      return { ok: false, error: `Cannot write kernel key "${key}"` };
    }
```

Remove the old static arrays:

```javascript
  // DELETE these:
  static SYSTEM_KEY_PREFIXES = [...]
  static KERNEL_ONLY_PREFIXES = [...]
  static KERNEL_ONLY_EXACT = [...]
  static SYSTEM_KEY_EXACT = [...]
  static IMMUTABLE_KEYS = [...]
  static PRINCIPLE_PREFIXES = [...]
```

Update `buildKernelInterface` to use instance methods:

```javascript
      isSystemKey: async (key) => kernel.isSystemKey(key),
      getSystemKeyPatterns: async () => kernel.keyTiers || Kernel.DEFAULT_KEY_TIERS,
```

- [ ] **Step 5: Run all tests**

Run: `npm test`
Expected: Many tests calling `Kernel.isSystemKey()` (static) will fail. Fix them to create a kernel instance and use instance methods, or seed `kernel:key_tiers` in mock KV.

- [ ] **Step 6: Fix failing tests**

Search all test files for `Kernel.isSystemKey`, `Kernel.isKernelOnly`, `SYSTEM_KEY_PREFIXES`, `KERNEL_ONLY_PREFIXES`, `IMMUTABLE_KEYS`, and update to use instance methods on the test kernel.

- [ ] **Step 7: Run all tests**

Run: `npm test`
Expected: All pass

- [ ] **Step 8: Commit**

```bash
git add kernel.js tests/kernel.test.js tests/session.test.js
git commit -m "refactor: config-driven key tiers via kernel:key_tiers

Replaces hardcoded SYSTEM_KEY_PREFIXES, KERNEL_ONLY_PREFIXES, etc. with
tiers loaded from kernel:key_tiers KV key at boot. Falls back to
DEFAULT_KEY_TIERS if not configured. isSystemKey/isKernelOnly are now
instance methods using pattern matching. Patron can customize key
protection without kernel code changes."
```

---

### Task 5: Clean Up Remaining Cognitive References

Final sweep — remove any remaining cognitive-specific code that should live in hooks.

**Files:**
- Modify: `kernel.js` (miscellaneous cleanup)
- Modify: `kernel.js` buildKernelInterface (remove stale methods)
- Test: `tests/kernel.test.js`

**Depends on:** Tasks 1-4

- [ ] **Step 1: Remove chat seeding from executeToolCall**

The Slack DM chat seeding block in `executeToolCall()` (lines 2028-2062) is tool-specific behavior that should be a post-execution hook, not kernel code. Remove it — the `validate_result` hook or the tool itself should handle this.

Delete the entire `// ── Chat seeding` block.

- [ ] **Step 2: Remove `_budgetReserved` from constructor**

With subplans gone, `_budgetReserved` is unused. Remove from constructor:

```javascript
    this._budgetReserved = 0;
```

- [ ] **Step 3: Simplify runAgentLoop — remove role detection**

In `runAgentLoop()`, remove the role detection block (lines 2158-2164):

```javascript
    // Budget limit config — resolve role from step name
    const role = step.startsWith('reflect_depth_') ? 'deep_reflect'
      : step === 'act' ? 'act'
      : null;
    const roleConfig = role ? this.defaults?.[role] : null;
    const softPct = roleConfig?.budget_soft_limit_pct ?? 0.75;
    const hardPct = roleConfig?.budget_hard_limit_pct ?? 0.90;
    const costLimit = budgetCap ?? this.defaults?.session_budget?.max_cost;
```

Replace with the caller passing budget config directly via `budgetCap`:

```javascript
    const costLimit = budgetCap ?? this.defaults?.session_budget?.max_cost;
    const softPct = 0.75;
    const hardPct = 0.90;
```

The hook knows its own role and can pass `budgetCap` accordingly.

- [ ] **Step 4: Remove model capability check from _gateSystem**

If `config:model_capabilities` deliberation check was the last reference to model capability logic, verify and remove any remaining `modelCapabilities` references beyond the cache-refresh in `_gateSystem`. The model capability gate for `config:model_capabilities` writes can stay — it's a reasonable kernel safety check.

Actually, re-read the spec: "Principles are immutable — no capability gates needed." The model capabilities write protection is about config, not principles. Keep the deliberation gate for `config:model_capabilities` — it prevents the agent from granting itself capabilities without justification.

- [ ] **Step 5: Run all tests**

Run: `npm test`
Expected: All pass (these are small cleanup changes)

- [ ] **Step 6: Verify LOC count**

Run: `wc -l kernel.js`
Expected: ~1990 LOC (± 50). If significantly over, check for any remaining cognitive code.

- [ ] **Step 7: Commit**

```bash
git add kernel.js tests/kernel.test.js
git commit -m "refactor: final kernel cleanup — remove chat seeding, budget role detection

Removes Slack DM chat seeding from kernel (belongs in hook/tool),
removes _budgetReserved (subplans removed), simplifies runAgentLoop
budget handling (caller passes budgetCap, no role detection from step
names). Kernel is now cognitive-architecture-agnostic."
```

---

### Task 6: Verify and Document

Final verification that the kernel meets the spec and all tests pass.

**Files:**
- Modify: `CLAUDE.md` (update kernel/hook boundary docs if needed)

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All pass

- [ ] **Step 2: Verify kernel LOC**

Run: `wc -l kernel.js`
Expected: ~1990 LOC

- [ ] **Step 3: Verify kernel interface matches spec**

Check that `buildKernelInterface()` exposes exactly what §10.2 says:
- KV access (read/write with tier-based gating) ✓
- LLM calling (dharma/principle injection, budget enforcement) ✓
- Tool dispatch (tool grants, execution context, communication gating) ✓
- Event bus (emit, drain, dead-letter) ✓
- Safety (crash detection, code staging, sealed keys) ✓
- Bookkeeping (session counter, karma, session health) ✓

Verify it does NOT expose:
- Proposal methods ✓ (removed in Task 1)
- Yama/niyama-specific methods ✓ (removed in Task 2)
- Act/reflect dispatch ✓ (removed in Task 3)
- Cognitive config utilities ✓ (removed in Task 2)
- Subplan spawning ✓ (removed in Task 1)

- [ ] **Step 4: Commit final state**

```bash
git add -A
git commit -m "refactor: kernel refactor module 1 complete — cognitive-agnostic kernel

Kernel provides: KV (tier-gated), LLM (dharma+principle injection),
tools, events, safety (crash tripwire, sealed keys, code staging),
and bookkeeping. All cognitive policy (session type decisions, context
building, tripwires, proposals, yama/niyama deliberation) removed.
Single hook entry: HOOKS.session.run. ~1990 LOC, down from 2462."
```
