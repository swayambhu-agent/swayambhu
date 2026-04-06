# Session Timeout Robustness Plan

Date: 2026-04-05

This rewrite is grounded in the current source at:

- [kernel.js](/home/swami/swayambhu/repo/kernel.js)
- [userspace.js](/home/swami/swayambhu/repo/userspace.js)
- [eval.js](/home/swami/swayambhu/repo/eval.js)
- [memory.js](/home/swami/swayambhu/repo/memory.js)
- [observe.mjs](/home/swami/swayambhu/repo/scripts/dev-loop/observe.mjs)

Design target: one session-level abort controller in `kernel.js`, plus one child controller per act cycle in `userspace.js`. Leaf network calls use passed signals when available and safe local timeouts when not.

## Fix 1: `callInference` signal support in `memory.js`

Rationale

`callInference()` is currently a bare `fetch()` in [memory.js](/home/swami/swayambhu/repo/memory.js). That means inference requests can hang until the worker dies. The current embedding write path in [userspace.js](/home/swami/swayambhu/repo/userspace.js) works around this with a local `Promise.race`, but that only covers one call site and leaves the underlying request lifecycle fragmented.

Test spec

- Add a `memory.js` test that stubs `fetch` and asserts `callInference()` passes a signal when the caller does not provide one.
- Add a `memory.js` test that passes an explicit `AbortController().signal` and asserts that exact signal reaches `fetch`.
- Update the `writeMemory()` test path in `userspace` to assert embedding timeout is reported from `AbortError`, with no remaining `Promise.race`.

Exact diff

```diff
diff --git a/memory.js b/memory.js
@@
-export async function callInference(baseUrl, secret, path, body) {
+export async function callInference(baseUrl, secret, path, body, signal = AbortSignal.timeout(20_000)) {
   const resp = await fetch(`${baseUrl}${path}`, {
     method: "POST",
+    signal,
     headers: {
       "Content-Type": "application/json",
       ...(secret ? { "Authorization": `Bearer ${secret}` } : {}),
     },
     body: JSON.stringify(body),
   });
```

```diff
diff --git a/userspace.js b/userspace.js
@@
   if (salience > salienceThreshold) {
     let embedding = null;
     if (inferenceConfig) {
       try {
-        // 30s timeout prevents cold-start inference latency from exhausting session budget.
-        // Promise.race abandons the await; CF runtime cancels the in-flight request when the worker completes.
-        const embedTimeout = new Promise((_, reject) =>
-          setTimeout(() => reject(new Error("embedding_timeout")), 30000)
-        );
-        const resp = await Promise.race([
-          callInference(inferenceConfig.url, inferenceConfig.secret, '/embed', {
-            texts: [review?.narrative || review?.assessment || ledger.final_text || '']
-          }),
-          embedTimeout,
-        ]);
+        const resp = await callInference(inferenceConfig.url, inferenceConfig.secret, '/embed', {
+          texts: [review?.narrative || review?.assessment || ledger.final_text || '']
+        });
         embedding = resp.embeddings?.[0] || null;
       } catch (err) {
-        const event = err?.message === "embedding_timeout"
+        const event = err?.name === "AbortError"
           ? "experience_embedding_timeout"
           : "experience_embedding_failed";
         await K.karmaRecord({ event });
       }
     }
```

Verification step

- Re-read [memory.js](/home/swami/swayambhu/repo/memory.js) and confirm the pre-change function signature is exactly `callInference(baseUrl, secret, path, body)`.
- Re-read [userspace.js](/home/swami/swayambhu/repo/userspace.js) and confirm the current embedding block still contains the `Promise.race` timeout workaround before editing.
- Sanity-check the after-state JS: default parameter syntax is valid, `signal` is a valid `fetch` init key, and `err?.name === "AbortError"` is valid optional chaining.

## Fix 2: `callLLM` signal support in `kernel.js`

Rationale

The session abort chain is useless unless `callLLM()` can actually receive and propagate a signal. Today [kernel.js](/home/swami/swayambhu/repo/kernel.js) drops all abort context: `buildKernelInterface()` exposes only `callLLM(opts)`, `callWithCascade()` hands providers a raw `fetch`, and `_hardcodedLLMFallback()` only has its local 60s timer.

Test spec

- Add a kernel test that calls `K.callLLM({ ..., signal })` through the interface and asserts the provider receives the same signal.
- Add a kernel test that aborts the provided signal while tier 1 is in flight and asserts the request rejects with `AbortError`.
- Add a kernel test for `_hardcodedLLMFallback()` showing either the parent signal or the existing 60s timeout can abort the request.

Exact diff

```diff
diff --git a/kernel.js b/kernel.js
@@
   buildKernelInterface() {
     const kernel = this;
     return {
       // LLM
       callLLM: async (opts) => kernel.callLLM(opts),
+      sessionAbortSignal: kernel.sessionAbortController?.signal || null,
@@
-  async callLLM({ model, effort, maxTokens, systemPrompt, messages, tools, step, budgetCap, json }) {
+  async callLLM({ model, effort, maxTokens, systemPrompt, messages, tools, step, budgetCap, json, signal }) {
@@
-    const result = await this.callWithCascade(request, step);
+    const result = await this.callWithCascade(request, step, signal);
@@
       const fallbackModel = await this.getFallbackModel();
       const resolvedFallback = this.resolveModel(fallbackModel);
       if (fallbackModel && resolvedModel !== resolvedFallback) {
         return this.callLLM({ model: fallbackModel, effort: "low", maxTokens,
-          systemPrompt, messages, tools, step, budgetCap });
+          systemPrompt, messages, tools, step, budgetCap, signal });
       }
       throw new Error(`LLM call failed on all providers: ${result.error}`);
@@
-  async callWithCascade(request, step) {
+  async callWithCascade(request, step, signal) {
@@
-      const result = await fn({ ...request, secrets, fetch: (...args) => fetch(...args) });
+      const result = await fn({
+        ...request,
+        secrets,
+        signal,
+        fetch: (input, init = {}) => fetch(input, {
+          ...init,
+          signal: init.signal || signal,
+        }),
+      });
@@
-      const result = await this._hardcodedLLMFallback(request, step);
+      const result = await this._hardcodedLLMFallback(request, step, signal);
       return result;
@@
-  async _hardcodedLLMFallback(request, step) {
+  async _hardcodedLLMFallback(request, step, signal) {
     const body = {
       model: request.model,
       max_tokens: request.max_tokens,
       messages: request.messages,
     };
     if (request.effort) body.reasoning = { effort: request.effort };
     if (request.tools?.length) body.tools = request.tools;
 
     const controller = new AbortController();
+    const abortFromParent = () => controller.abort(signal?.reason);
+    if (signal) {
+      if (signal.aborted) controller.abort(signal.reason);
+      else signal.addEventListener("abort", abortFromParent, { once: true });
+    }
     const timeout = setTimeout(() => controller.abort(), 60_000);
     let resp, data;
     try {
       resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
         method: "POST",
         signal: controller.signal,
@@
       data = await resp.json();
     } finally {
       clearTimeout(timeout);
+      if (signal && !signal.aborted) signal.removeEventListener("abort", abortFromParent);
     }
```

Verification step

- Re-read [kernel.js](/home/swami/swayambhu/repo/kernel.js) and confirm `callLLM()` currently returns `{ content, usage, cost, toolCalls, finish_reason }`.
- Confirm the current `callWithCascade()` provider path still injects `fetch: (...args) => fetch(...args)` before editing.
- Sanity-check the after-state JS: destructured `signal` in `callLLM()` is valid, `fetch(input, { ...init, signal: init.signal || signal })` is valid, and `_hardcodedLLMFallback()` still preserves the existing 60s timeout controller.

## Fix 3: Session wall-clock abort in `kernel.js`

Rationale

`runTick()` in [kernel.js](/home/swami/swayambhu/repo/kernel.js) currently has no session abort controller at all. It only relies on `callLLM()` budget checks using `this.elapsed()`, which does not stop stuck fetches, stuck eval, or any non-LLM wait. The session-level controller needs to be created in `runTick()`, stored on the kernel instance, exposed through `K`, and cleaned up in `finally`. This is also the right place to move the fallback wall-clock default from `120` to `720`.

Test spec

- Add a kernel test that sets no `session_budget.max_duration_seconds`, runs `runTick()`, and asserts the session controller is armed for `720_000` ms.
- Add a kernel test that aborts the session signal mid-tick and asserts the existing `catch` path records `fatal_error` and marks the outcome as `crash`.
- Add a kernel test that asserts `this.sessionAbortController` is cleared after `runTick()` finishes or crashes.

Exact diff

```diff
diff --git a/kernel.js b/kernel.js
@@
   async runTick() {
     this.touchedKeys = new Set();
     await this.loadEagerConfig();
-    const K = this.buildKernelInterface();
+    const maxDurationSeconds = this.defaults?.session_budget?.max_duration_seconds || 720;
+    this.sessionAbortController = new AbortController();
+    const sessionTimeout = setTimeout(() => this.sessionAbortController.abort(), maxDurationSeconds * 1000);
+    const K = this.buildKernelInterface();
     let outcome = "clean";
 
     try {
@@
       if (!tick?.run) throw new Error("No HOOKS.tick.run");
       await tick.run(K, { crashData, balances, events });
 
     } catch (err) {
       outcome = "crash";
       await this.karmaRecord({
         event: "fatal_error",
         error: err.message,
         stack: err.stack,
       });
+    } finally {
+      clearTimeout(sessionTimeout);
+      this.sessionAbortController = null;
     }
@@
   async runMinimalFallback() {
@@
     const hardcodedPrompt = `You are Swayambhu in recovery mode. Your session hook has been reset due to repeated failures. Check your balances and report your status. Do not attempt complex operations.`;
 
     await this.loadEagerConfig();
-    this.defaults = { session_budget: { max_cost: 0.50, max_duration_seconds: 120 } };
+    this.defaults = { session_budget: { max_cost: 0.50, max_duration_seconds: 720 } };
     await this.karmaRecord({ event: "act_start", mode: "recovery" });
```

Verification step

- Re-read [kernel.js](/home/swami/swayambhu/repo/kernel.js) and confirm the current `runTick()` has no `finally` block before editing.
- Confirm the only in-file `120` second session default is the recovery-mode `this.defaults` assignment at [kernel.js](/home/swami/swayambhu/repo/kernel.js).
- Sanity-check the after-state JS: `sessionTimeout` is in scope for `finally`, `K` is built after `this.sessionAbortController` exists, and the `catch` block still treats `AbortError` like any other fatal crash.

## Fix 4: Eval/review child abort in `userspace.js`

Rationale

The second level of the design belongs in [userspace.js](/home/swami/swayambhu/repo/userspace.js): one child controller per cycle, linked to `K.sessionAbortSignal`, with its own 120s timeout budget. The current act loop awaits eval, review, then memory writes serially with no abort linkage. On abort, the cycle should record karma, skip `writeMemory()`, and continue gracefully instead of taking down the whole session.

Test spec

- Add a `userspace` test where `evaluateAction()` never resolves; abort the child signal and assert the cycle records `eval_review_aborted`, skips `writeMemory()`, and continues.
- Add a `userspace` test where `reviewPhase()` hangs; assert the same degraded behavior.
- Add a `userspace` test that aborts the parent `K.sessionAbortSignal` and confirms the child controller aborts immediately.

Exact diff

```diff
diff --git a/userspace.js b/userspace.js
@@
-async function reviewPhase(K, { ledger, evalResult, defaults }) {
+async function reviewPhase(K, { ledger, evalResult, defaults, signal }) {
@@
   const response = await K.callLLM({
     model,
     effort: defaults?.reflect?.effort || "medium",
     maxTokens,
     systemPrompt: finalSystem,
     messages: [{ role: "user", content: userContent }],
     tools: [],
     step: "review",
+    signal,
     json: true,
   });
@@
     const retry = await K.callLLM({
       model,
       effort: defaults?.reflect?.effort || "medium",
       maxTokens: maxTokens * 2,
       systemPrompt: finalSystem,
@@
       ],
       tools: [],
       step: "review_retry",
+      signal,
       json: true,
     });
@@
   for (let cycle = 0; cycle < maxCycles; cycle++) {
@@
     // 6b. Plan phase
     const plan = await planPhase(K, { desires, patterns, circumstances, priorActions, defaults, modelsConfig, carryForwardItems });
     if (!plan) break; // parse failure
+    const cycleAbortController = new AbortController();
+    const abortFromSession = () => cycleAbortController.abort(K.sessionAbortSignal?.reason);
+    const cycleTimeout = setTimeout(() => cycleAbortController.abort(), 120_000);
+    if (K.sessionAbortSignal) {
+      if (K.sessionAbortSignal.aborted) cycleAbortController.abort(K.sessionAbortSignal.reason);
+      else K.sessionAbortSignal.addEventListener("abort", abortFromSession, { once: true });
+    }
+    try {
     if (plan.no_action) {
       await K.karmaRecord({ event: "plan_no_action", reason: plan.reason, cycle });
@@
       const noActionLedger = {
         action_id: `a_${Date.now()}_noaction`,
         plan,
         tool_calls: [],
         final_text: plan.reason,
       };
-      const evalResult = await evaluateAction(K, noActionLedger, desires, patterns, inferenceConfig || {});
+      const evalResult = await evaluateAction(K, noActionLedger, desires, patterns, inferenceConfig || {}, cycleAbortController.signal);
       const syntheticReview = {
         assessment: "no_action",
         narrative: `No action taken: ${plan.reason}`,
         salience_estimate: evalResult.salience || 0,
       };
       await writeMemory(K, { ledger: noActionLedger, evalResult, review: syntheticReview, desires, patterns, inferenceConfig, executionId, sessionNumber: sessionCount + 1, cycle });
 
       break;
     }
@@
     const ledger = await actPhase(K, {
       plan, systemPrompt, messages, tools, model, effort, maxTokens, defaults,
     });
 
     // 6d. Eval phase
-    const evalResult = await evaluateAction(K, ledger, desires, patterns, inferenceConfig || {});
+    const evalResult = await evaluateAction(K, ledger, desires, patterns, inferenceConfig || {}, cycleAbortController.signal);
 
     // 6e. Review phase
-    const review = await reviewPhase(K, { ledger, evalResult, defaults });
+    const review = await reviewPhase(K, { ledger, evalResult, defaults, signal: cycleAbortController.signal });
 
     // 6f. Memory writes
     await writeMemory(K, { ledger, evalResult, review, desires, patterns, inferenceConfig, executionId, sessionNumber: sessionCount + 1, cycle });
 
     cyclesRun++;
+    } catch (err) {
+      if (err?.name === "AbortError") {
+        await K.karmaRecord({ event: "eval_review_aborted", cycle });
+        continue;
+      }
+      throw err;
+    } finally {
+      clearTimeout(cycleTimeout);
+      if (K.sessionAbortSignal && !K.sessionAbortSignal.aborted) {
+        K.sessionAbortSignal.removeEventListener("abort", abortFromSession);
+      }
+    }
 
     // 6g. Record outcome for planner
     priorActions.push({
```

Verification step

- Re-read [userspace.js](/home/swami/swayambhu/repo/userspace.js) and confirm `reviewPhase()` currently takes no `signal`.
- Confirm the current main act loop directly awaits `evaluateAction()`, `reviewPhase()`, and `writeMemory()` with no local `try/catch` around those three steps.
- Sanity-check the after-state JS: the `try/catch/finally` wraps the cycle body, `continue` inside `catch` still runs the `finally`, and `writeMemory()` is skipped on `AbortError` because it sits after the awaited eval/review calls.

## Fix 5: Dev loop observe restart on timeout in `observe.mjs`

Rationale

[scripts/dev-loop/observe.mjs](/home/swami/swayambhu/repo/scripts/dev-loop/observe.mjs) already has a `restartServices()` helper, but `pollForNewSession()` currently throws immediately on timeout. That leaves the loop in a dead-worker state even though the recovery primitive already exists.

Test spec

- Add a `dev-loop` test where `readSessionIds()` never returns a new session and assert `restartServices()` is called before the thrown error.
- Add a second test where a session ID appears but never reaches `kernel:last_executions`, and assert the same restart-before-throw behavior.

Exact diff

```diff
diff --git a/scripts/dev-loop/observe.mjs b/scripts/dev-loop/observe.mjs
@@
   if (!newId) {
     process.stdout.write("\n");
+    await restartServices();
     throw new Error(`No new session started within ${timeoutMs / 1000}s`);
   }
@@
   process.stdout.write("\n");
+  await restartServices();
   throw new Error(
     `Session ${newId} started but did not complete within ${timeoutMs / 1000}s`,
   );
 }
```

Verification step

- Re-read [observe.mjs](/home/swami/swayambhu/repo/scripts/dev-loop/observe.mjs) and confirm both timeout branches currently throw without a restart.
- Sanity-check the after-state JS: both inserted `await restartServices()` lines are inside the `async` function and immediately precede the existing throws.

## Fix 6: `eval.js` `classifyWithLLM` bug

Rationale

This is a concrete shape mismatch. In [eval.js](/home/swami/swayambhu/repo/eval.js), `classifyWithLLM()` does `JSON.parse(response.text)`. In [kernel.js](/home/swami/swayambhu/repo/kernel.js), `callLLM()` returns:

```js
const response = { content: result.content, usage: result.usage, cost, toolCalls: result.toolCalls, finish_reason: result.finish_reason };
```

So the current eval code is reading a property that `callLLM()` does not return.

Test spec

- Add an `eval.js` test that stubs `K.callLLM()` to return `{ content: "[...]" }` and asserts `classifyWithLLM()` parses it successfully.
- Add an `eval.js` test that passes an abort signal through `evaluateAction()` and asserts both inference tiers and the LLM fallback receive that signal.

Exact diff

```diff
diff --git a/eval.js b/eval.js
@@
-async function classifyWithLLM(K, pairs, outcomeText) {
+async function classifyWithLLM(K, pairs, outcomeText, signal) {
@@
   const response = await K.callLLM({
     model: "deepseek",
     effort: "low",
     maxTokens: 1000,
     systemPrompt: "You are a precise classifier. Respond with only JSON.",
     messages: [{ role: "user", content: prompt }],
     step: "eval_tier3",
+    signal,
   });
 
-  const parsed = JSON.parse(response.text);
+  const parsed = JSON.parse(response.content);
   const pairMap = Object.fromEntries(pairs.map(p => [p.id, p]));
@@
-export async function evaluateAction(K, ledger, desires, patterns, config) {
+export async function evaluateAction(K, ledger, desires, patterns, config, signal) {
@@
-    const embedResp = await callInference(config.url, config.secret, "/embed", {
+    const embedResp = await callInference(config.url, config.secret, "/embed", {
       texts: [outcomeText],
-    });
+    }, signal);
@@
-    const nliResp = await callInference(config.url, config.secret, "/nli", {
+    const nliResp = await callInference(config.url, config.secret, "/nli", {
       pairs: relevant.map(p => ({ id: p.id, premise: p.text, hypothesis: outcomeText })),
-    });
+    }, signal);
@@
     let llmClassified = [];
     if (ambiguous.length > 0) {
-      llmClassified = await classifyWithLLM(K, ambiguous, outcomeText);
+      llmClassified = await classifyWithLLM(K, ambiguous, outcomeText, signal);
     }
@@
   } catch (_err) {
     // ── Full LLM fallback ──
     try {
-      const llmClassified = await classifyWithLLM(K, pairs, outcomeText);
+      const llmClassified = await classifyWithLLM(K, pairs, outcomeText, signal);
       return computeMetrics(llmClassified, { ...baseResult, eval_method: "llm_fallback" });
     } catch (_fallbackErr) {
```

Verification step

- Re-read [eval.js](/home/swami/swayambhu/repo/eval.js) and confirm the current line is exactly `const parsed = JSON.parse(response.text);`.
- Re-read [kernel.js](/home/swami/swayambhu/repo/kernel.js) and confirm `callLLM()` really returns `response.content`, not `response.text`.
- Sanity-check the after-state JS: the new `signal` parameter is threaded consistently, and `JSON.parse(response.content)` matches the actual current return shape from `callLLM()`.

## Execution order

1. Fix 1 first, so inference calls have a uniform abort contract and `writeMemory()` stops using `Promise.race`.
2. Fix 2 next, so the kernel can actually pass abort signals into provider calls and hardcoded fallback.
3. Fix 3 after that, to create and expose the session-level wall-clock controller and move the fallback duration default to `720`.
4. Fix 6 before Fix 4 lands if you want the eval layer cleanly threaded in one pass; it carries both the `response.content` bug fix and the `evaluateAction(..., signal)` plumbing.
5. Fix 4 then wires the per-cycle child controller on top of the now-signal-aware eval/review stack.
6. Fix 5 last; it is independent and low risk.
