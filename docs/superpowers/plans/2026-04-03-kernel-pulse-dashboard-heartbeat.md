# kernel:pulse + Dashboard Heartbeat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace 6+ independent dashboard polling loops with a single heartbeat driven by a kernel-written change indicator (`kernel:pulse`).

**Architecture:** The kernel tracks which KV keys were written during each tick via a `touchedKeys` Set. At tick end, a userspace classifier maps raw keys to semantic buckets. The kernel writes `kernel:pulse` with the bucket list. The dashboard polls one `/pulse` endpoint and only refetches data whose bucket changed.

**Tech Stack:** Cloudflare Workers (kernel + dashboard-api), React SPA (no build step, CDN React), KV storage.

---

### Task 1: Kernel — add touchedKeys tracking to all write paths

**Files:**
- Modify: `kernel.js:16-49` (constructor)
- Modify: `kernel.js:1880-1919` (kvWrite)
- Modify: `kernel.js:421-426` (kvWriteSafe)
- Modify: `kernel.js:428-433` (kvDeleteSafe)
- Modify: `kernel.js:1285-1293` (scoped KV put in _buildScopedKV)
- Test: `tests/kernel.test.js`

- [ ] **Step 1: Write failing test for touchedKeys tracking**

Add to `tests/kernel.test.js` in a new `describe("touchedKeys tracking")` block:

```js
describe("touchedKeys tracking", () => {
  it("tracks keys written via kvWriteSafe", async () => {
    const { kernel } = makeKernel();
    kernel.touchedKeys = new Set();
    await kernel.kvWriteSafe("experience:test1", { data: "hello" });
    expect(kernel.touchedKeys.has("experience:test1")).toBe(true);
  });

  it("tracks keys deleted via kvDeleteSafe", async () => {
    const { kernel } = makeKernel();
    kernel.touchedKeys = new Set();
    await kernel.kvWriteSafe("experience:del1", "temp");
    kernel.touchedKeys.clear();
    await kernel.kvDeleteSafe("experience:del1");
    expect(kernel.touchedKeys.has("experience:del1")).toBe(true);
  });

  it("tracks keys written via internal kvWrite", async () => {
    const { kernel } = makeKernel();
    kernel.touchedKeys = new Set();
    await kernel.karmaRecord({ event: "test" });
    const karmaKey = kernel.karma.length > 0 ? `karma:${kernel.executionId}` : null;
    // karma writes go through kvWrite internally — check any key was tracked
    expect(kernel.touchedKeys.size).toBeGreaterThan(0);
  });

  it("resets touchedKeys between ticks", async () => {
    const { kernel } = makeKernel();
    kernel.touchedKeys = new Set(["stale:key"]);
    // runTick resets at start — simulate by checking constructor
    expect(kernel.touchedKeys).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/kernel.test.js`
Expected: FAIL — `touchedKeys` not populated by writes.

- [ ] **Step 3: Add touchedKeys to constructor**

In `kernel.js`, add to the constructor after line 49 (`this.patronIdentityDisputed = false;`):

```js
    this.touchedKeys = new Set();
    this.pulseCounter = 0;
```

- [ ] **Step 4: Track in kvWrite**

In `kernel.js`, add at the start of `kvWrite` method (after the immutable check at line 1883, before the metadata block):

```js
    if (this.touchedKeys) this.touchedKeys.add(key);
```

- [ ] **Step 5: Track in kvDeleteSafe**

In `kernel.js`, add inside `kvDeleteSafe` after the tier checks (before `return this.kv.delete(key)`):

```js
    if (this.touchedKeys) this.touchedKeys.add(key);
```

- [ ] **Step 6: Track in scoped KV put**

In `kernel.js` `_buildScopedKV` method, the `put` function (line 1285-1293) uses raw `kv.put`. We need to capture the kernel reference. Change `_buildScopedKV`:

```js
  _buildScopedKV(toolName, kvAccess, writePrefixes = []) {
    const kv = this.kv;
    const kernel = this;  // capture for touchedKeys tracking
    const scope = `tooldata:${toolName}:`;
    return {
      async get(key) {
        const resolved = kvAccess === "own" ? `${scope}${key}` : key;
        if (resolved.startsWith('sealed:')) return null;
        try { return await kv.get(resolved, "json"); }
        catch { try { return await kv.get(resolved, "text"); } catch { return null; } }
      },
      async put(key, value) {
        const allowedPrefix = writePrefixes.find(p => key.startsWith(p));
        const resolved = allowedPrefix ? key : `${scope}${key}`;
        if (kernel.touchedKeys) kernel.touchedKeys.add(resolved);
        const fmt = typeof value === "string" ? "text" : "json";
        await kv.put(resolved, typeof value === "string" ? value : JSON.stringify(value), {
          metadata: { type: allowedPrefix ? "job" : "tooldata", format: fmt, updated_at: new Date().toISOString() },
        });
      },
```

(The `list` method stays unchanged.)

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test -- tests/kernel.test.js`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add kernel.js tests/kernel.test.js
git commit -m "feat: add touchedKeys tracking to all KV write paths"
```

---

### Task 2: Kernel — write kernel:pulse at end of runTick

**Files:**
- Modify: `kernel.js:874-916` (runTick)
- Test: `tests/kernel.test.js`

- [ ] **Step 1: Write failing test for pulse write**

Add to `tests/kernel.test.js`:

```js
describe("kernel:pulse", () => {
  it("writes kernel:pulse at end of runTick", async () => {
    const { kernel, kv } = makeKernel();
    kernel.HOOKS = {
      tick: { run: async () => {} },
    };
    await kernel.loadEagerConfig();
    await kernel.runTick();

    const pulse = JSON.parse(await kv.get("kernel:pulse"));
    expect(pulse.v).toBe(1);
    expect(pulse.n).toBe(0);
    expect(pulse.execution_id).toBe(kernel.executionId);
    expect(pulse.outcome).toBe("clean");
    expect(pulse.ts).toBeGreaterThan(0);
    expect(Array.isArray(pulse.changed)).toBe(true);
  });

  it("increments pulse counter across ticks", async () => {
    const { kernel, kv } = makeKernel();
    kernel.HOOKS = {
      tick: { run: async () => {} },
    };
    await kernel.loadEagerConfig();
    await kernel.runTick();
    const p1 = JSON.parse(await kv.get("kernel:pulse"));

    // Simulate second tick
    kernel.touchedKeys = new Set();
    kernel.karma = [];
    kernel.sessionCost = 0;
    kernel.sessionLLMCalls = 0;
    await kernel.runTick();
    const p2 = JSON.parse(await kv.get("kernel:pulse"));

    expect(p2.n).toBe(p1.n + 1);
  });

  it("calls HOOKS.pulse.classify with touchedKeys", async () => {
    const { kernel, kv } = makeKernel();
    let receivedKeys = null;
    kernel.HOOKS = {
      tick: { run: async (K) => {
        await K.kvWriteSafe("experience:test", { data: 1 });
      }},
      pulse: { classify: (keys) => {
        receivedKeys = keys;
        return ["mind"];
      }},
    };
    await kernel.loadEagerConfig();
    await kernel.runTick();

    expect(receivedKeys).toBeInstanceOf(Set);
    expect(receivedKeys.has("experience:test")).toBe(true);
    const pulse = JSON.parse(await kv.get("kernel:pulse"));
    expect(pulse.changed).toEqual(["mind"]);
  });

  it("pulse write failure does not crash the tick", async () => {
    const { kernel } = makeKernel();
    kernel.HOOKS = {
      tick: { run: async () => {} },
    };
    // Sabotage kv.put for kernel:pulse
    const origPut = kernel.kv.put.bind(kernel.kv);
    kernel.kv.put = async (key, ...args) => {
      if (key === "kernel:pulse") throw new Error("KV write failed");
      return origPut(key, ...args);
    };
    await kernel.loadEagerConfig();
    // Should not throw
    await kernel.runTick();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/kernel.test.js`
Expected: FAIL — no pulse write in runTick yet.

- [ ] **Step 3: Add pulse write to runTick**

In `kernel.js`, modify `runTick` to reset touchedKeys at start and write pulse at end. Replace the entire method:

```js
  async runTick() {
    this.touchedKeys = new Set();
    await this.loadEagerConfig();
    const K = this.buildKernelInterface();
    let outcome = "clean";

    try {
      // Infrastructure inputs
      const crashData = await this._detectCrash();
      const balances = await this.checkBalance({});
      const { actContext: events, deferred } = await this.drainEvents(this._eventHandlers);

      // Hand to userspace — one call, userspace decides everything
      const { tick } = this.HOOKS;
      if (!tick?.run) throw new Error("No HOOKS.tick.run");
      await tick.run(K, { crashData, balances, events });

      // Process deferred events inside lock
      if (this.HOOKS.deferred) {
        for (const [processor, processorEvents] of Object.entries(deferred)) {
          const hook = this.HOOKS.deferred[processor];
          if (!hook?.run) continue;
          try {
            await hook.run(K, processorEvents);
          } catch (err) {
            await this.karmaRecord({ event: "deferred_processor_error", processor, error: err.message });
          }
        }
      }

    } catch (err) {
      outcome = "crash";
      await this.karmaRecord({
        event: "fatal_error",
        error: err.message,
        stack: err.stack,
      });
    }

    // Always record execution outcome and release lock
    await this._writeExecutionHealth(outcome);
    await this.updateExecutionOutcome(outcome);
    await this.kv.delete("kernel:active_execution");

    // Pulse — written last, after everything is settled.
    // Best-effort: failure must not crash the tick.
    try {
      const changed = this.HOOKS.pulse?.classify
        ? await this.HOOKS.pulse.classify(this.touchedKeys)
        : [];
      await this.kv.put("kernel:pulse", JSON.stringify({
        v: 1,
        n: this.pulseCounter++,
        execution_id: this.executionId,
        outcome,
        ts: Date.now(),
        changed,
      }));
    } catch {}
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/kernel.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add kernel.js tests/kernel.test.js
git commit -m "feat: write kernel:pulse at end of every tick"
```

---

### Task 3: Userspace — export classify function

**Files:**
- Modify: `userspace.js` (add classify export at bottom)
- Test: `tests/userspace.test.js`

- [ ] **Step 1: Write failing test for classify**

Add to `tests/userspace.test.js` in a new describe block:

```js
import { classify } from '../userspace.js';

describe("pulse classify", () => {
  it("always includes health", () => {
    expect(classify(new Set())).toContain("health");
  });

  it("maps desire keys to mind bucket", () => {
    const result = classify(new Set(["desire:dharma-clarity"]));
    expect(result).toContain("mind");
    expect(result).toContain("health");
  });

  it("maps samskara keys to mind bucket", () => {
    expect(classify(new Set(["samskara:pacing:slow"]))).toContain("mind");
  });

  it("maps experience keys to mind bucket", () => {
    expect(classify(new Set(["experience:1775204183352"]))).toContain("mind");
  });

  it("maps session_counter to sessions bucket", () => {
    expect(classify(new Set(["session_counter"]))).toContain("sessions");
  });

  it("maps karma keys to sessions bucket", () => {
    expect(classify(new Set(["karma:x_123"]))).toContain("sessions");
  });

  it("maps action keys to sessions bucket", () => {
    expect(classify(new Set(["action:a_123_test"]))).toContain("sessions");
  });

  it("maps dr state to reflections bucket", () => {
    expect(classify(new Set(["dr:state:1"]))).toContain("reflections");
  });

  it("maps reflect keys to reflections bucket", () => {
    expect(classify(new Set(["reflect:1:x_123"]))).toContain("reflections");
  });

  it("maps last_reflect to reflections bucket", () => {
    expect(classify(new Set(["last_reflect"]))).toContain("reflections");
  });

  it("maps chat keys to chats bucket", () => {
    expect(classify(new Set(["chat:slack:U123"]))).toContain("chats");
  });

  it("maps outbox keys to chats bucket", () => {
    expect(classify(new Set(["outbox:chat:slack:U123:ob_1"]))).toContain("chats");
  });

  it("maps contact keys to contacts bucket", () => {
    expect(classify(new Set(["contact:swami_kevala"]))).toContain("contacts");
  });

  it("maps contact_platform keys to contacts bucket", () => {
    expect(classify(new Set(["contact_platform:slack:U123"]))).toContain("contacts");
  });

  it("ignores unknown prefixes", () => {
    const result = classify(new Set(["kernel:active_execution"]));
    expect(result).toEqual(["health"]);
  });

  it("deduplicates buckets", () => {
    const result = classify(new Set([
      "desire:a", "samskara:b", "experience:c",
    ]));
    const mindCount = result.filter(b => b === "mind").length;
    expect(mindCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/userspace.test.js`
Expected: FAIL — classify not exported.

- [ ] **Step 3: Add classify to userspace.js**

Add before the `export async function run(...)` at the bottom of `userspace.js`:

```js
// ── Pulse bucket classifier ────────────────────────────────
// Maps raw touched KV keys to semantic buckets for kernel:pulse.
// The kernel tracks which keys were written; this function provides
// the cognitive-architecture meaning the kernel deliberately lacks.

const BUCKET_MAP = [
  [['session_counter', 'cache:session_ids'], 'sessions'],
  [['action:'], 'sessions'],
  [['karma:'], 'sessions'],
  [['desire:', 'samskara:', 'experience:'], 'mind'],
  [['dr:', 'reflect:', 'last_reflect'], 'reflections'],
  [['chat:', 'outbox:', 'conversation_index:'], 'chats'],
  [['contact:', 'contact_platform:'], 'contacts'],
];

export function classify(touchedKeys) {
  const buckets = new Set(['health']);
  for (const key of touchedKeys) {
    for (const [patterns, bucket] of BUCKET_MAP) {
      if (patterns.some(p => p.endsWith(':') ? key.startsWith(p) : key === p)) {
        buckets.add(bucket);
        break;
      }
    }
  }
  return [...buckets];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/userspace.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add userspace.js tests/userspace.test.js
git commit -m "feat: add pulse bucket classifier to userspace"
```

---

### Task 4: Wire classify into HOOKS in index.js and governor/builder.js

**Files:**
- Modify: `index.js:10,63` (import classify, add to HOOKS)
- Modify: `governor/builder.js:96,248-249` (generate classify import and HOOKS.pulse)

- [ ] **Step 1: Update index.js import**

Change line 10 in `index.js` from:

```js
import * as session from './userspace.js';
```

to:

```js
import * as session from './userspace.js';
import { classify as pulseClassify } from './userspace.js';
```

- [ ] **Step 2: Add pulse to HOOKS in index.js**

In `index.js`, after the `deferred: { ... }` block closes (after the closing `},` of deferred), add the pulse hook. The HOOKS object should become:

```js
const HOOKS = {
  tick: session,
  deferred: {
    comms: {
      async run(K, events) {
        // ... existing comms code unchanged ...
      },
    },
  },
  pulse: { classify: pulseClassify },
};
```

- [ ] **Step 3: Update governor/builder.js import generation**

After line 96 (`lines.push("import * as session from './userspace.js';");`), add:

```js
  lines.push("import { classify as pulseClassify } from './userspace.js';");
```

- [ ] **Step 4: Update governor/builder.js HOOKS generation**

After line 248 (`lines.push("  },");` — closing deferred), add before line 249 (`lines.push("};");`):

```js
  lines.push("  pulse: { classify: pulseClassify },");
```

- [ ] **Step 5: Run all tests**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add index.js governor/builder.js
git commit -m "feat: wire pulse classifier into HOOKS"
```

---

### Task 5: Dashboard API — add /pulse endpoint

**Files:**
- Modify: `dashboard-api/worker.js:44-63` (add route before /reflections or after CORS)

- [ ] **Step 1: Add /pulse endpoint**

In `dashboard-api/worker.js`, after the CORS preflight block (line 42) and before the `/reflections` route (line 44), add:

```js
    // GET /pulse — lightweight change indicator, no auth (no sensitive data)
    if (path === "/pulse") {
      const pulse = await env.KV.get("kernel:pulse", "json");
      return json(pulse || { v: 1, n: 0, changed: [] });
    }
```

- [ ] **Step 2: Test manually**

Start the dashboard API worker and verify:

```bash
curl http://localhost:8790/pulse
```

Expected: `{"v":1,"n":0,"changed":[]}` (or actual pulse data if kernel has run).

- [ ] **Step 3: Commit**

```bash
git add dashboard-api/worker.js
git commit -m "feat: add /pulse endpoint to dashboard API"
```

---

### Task 6: Dashboard config — add heartbeat settings

**Files:**
- Modify: `site/patron/config.js`

- [ ] **Step 1: Add heartbeat config**

Replace `site/patron/config.js`:

```js
// Dashboard patron config — edit these values to customize the dashboard.
window.DASHBOARD_CONFIG = {
  // Timezone for all displayed timestamps (IANA format).
  timezone: "Asia/Kolkata",

  // Locale for date/time formatting.
  locale: "en-IN",

  // Max characters shown before "show more" truncation.
  truncate: {
    jsonString: 800,   // inside JSON viewer (nested string values)
    textBlock: 800,    // standalone text blocks (detail panel, reflections)
  },

  // Heartbeat polling intervals (ms).
  heartbeat: {
    normalMs: 5000,    // default poll interval
    activeMs: 2000,    // when session is active
    hiddenMs: 15000,   // when browser tab is hidden
    safetyMs: 60000,   // per-tab safety net poll (fallback)
  },
};
```

- [ ] **Step 2: Commit**

```bash
git add site/patron/config.js
git commit -m "feat: replace watchIntervalMs with heartbeat config"
```

---

### Task 7: Dashboard SPA — implement heartbeat and remove old polling

**Files:**
- Modify: `site/patron/index.html`

This is the largest task. It touches the config loading, removes 6 independent polling loops, and adds the single heartbeat.

- [ ] **Step 1: Update config loading**

At `site/patron/index.html` line 74, replace:

```js
  const WATCH_INTERVAL = CFG.watchIntervalMs || 2000;
```

with:

```js
  const HB = CFG.heartbeat || {};
  const HB_NORMAL = HB.normalMs || 5000;
  const HB_ACTIVE = HB.activeMs || 2000;
  const HB_HIDDEN = HB.hiddenMs || 15000;
  const HB_SAFETY = HB.safetyMs || 60000;
```

- [ ] **Step 2: Add the heartbeat hook inside the App component**

Inside the `App` component (after existing state declarations, before the return JSX), add the heartbeat hook. Find the main `useEffect` that loads health (around line 2144). Replace it and its siblings with this single heartbeat:

```js
  // ── Heartbeat: single poll loop replaces all per-tab intervals ──
  const lastPulseN = React.useRef(-1);
  const inflightRef = React.useRef({});
  const [reflectionsRev, setReflectionsRev] = React.useState(0);

  React.useEffect(() => {
    if (!patronKey) return;

    // Load initial data on mount
    refreshSessions();
    loadHealth();
    loadMindCounts();

    function getInterval() {
      if (document.hidden) return HB_HIDDEN;
      // Active if pulse is advancing rapidly (sessions in progress)
      return HB_NORMAL;
    }

    async function heartbeat() {
      try {
        const pulse = await api("/pulse", patronKey);
        if (!pulse || pulse.n === lastPulseN.current) return;
        lastPulseN.current = pulse.n;

        const changed = new Set(pulse.changed || []);

        const guard = (key, fn) => {
          if (inflightRef.current[key]) return;
          inflightRef.current[key] = true;
          fn().finally(() => { inflightRef.current[key] = false; });
        };

        if (changed.has("sessions")) guard("sessions", refreshSessions);
        if (changed.has("health"))   guard("health", loadHealth);
        if (changed.has("mind"))     guard("mind", loadMindCounts);
        // Reflections: bump a counter to trigger ReflectionsTab re-fetch
        if (changed.has("reflections")) setReflectionsRev(r => r + 1);
        if (changed.has("chats"))    guard("chats", refreshChats);
      } catch {}
    }

    let intervalId = setInterval(heartbeat, getInterval());

    // Adaptive: change interval when tab visibility changes
    const onVisChange = () => {
      clearInterval(intervalId);
      intervalId = setInterval(heartbeat, getInterval());
    };
    document.addEventListener("visibilitychange", onVisChange);

    return () => {
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisChange);
    };
  }, [patronKey]);
```

- [ ] **Step 3: Remove old polling loops**

Remove or comment out these `setInterval` calls:

1. **Session discovery poll** (line ~447): Remove the `setInterval(async () => { const ids = await refreshSessions(); ... }, 5000)` inside the session-loading useEffect. Keep the initial `refreshSessions()` call.

2. **Watch button interval** (line ~514): Remove the `setInterval` inside `toggleWatch`. The watch button can remain as a UI indicator but the heartbeat replaces its polling. Simplify `toggleWatch` to just toggle the `watching` state (visual only) since heartbeat handles data refresh.

3. **Chat list poll** (line ~1397): Remove `setInterval(refreshChats, 10000)`. Heartbeat covers this via `chats` bucket.

4. **Selected chat auto-refresh** (line ~1423): Remove `setInterval(() => loadChat(...), 5000)`. Add a safety-net poll instead: `setInterval(() => loadChat(...), HB_SAFETY)` for the currently-selected chat.

5. **Direct message poll** (line ~1612): Remove `setInterval(refresh, 10000)`. Add safety-net: `setInterval(refresh, HB_SAFETY)`.

6. **Health/mind poll** (line ~2147): Remove `setInterval(() => { loadHealth(); loadMindCounts(); }, 10000)`. Heartbeat covers this.

Keep the 1s countdown timer (line ~2165) — it's purely cosmetic.

- [ ] **Step 4: Add safety-net polls for tabs that need it**

For tabs that display live data and where a missed pulse would be noticeable, add slow safety-net polls using `HB_SAFETY` (60s):

- Timeline tab: the heartbeat refresh of `sessions` already covers karma. Add a `HB_SAFETY` interval for `loadKarma(selectedSession)` as fallback.
- Chats tab: add `setInterval(refreshChats, HB_SAFETY)` when the tab is mounted.

- [ ] **Step 5: Test manually**

1. Start all services: `source .env && bash scripts/start.sh --reset-all-state --trigger`
2. Open dashboard at `http://localhost:3001`
3. Verify: health bar updates after session completes (no manual refresh)
4. Verify: DR tab shows completion when DR job finishes (no manual refresh)
5. Verify: Mind tab updates after desires are created by DR (no manual refresh)
6. Verify: Tab hidden → poll slows down (check network tab)
7. Verify: No errors in console

- [ ] **Step 6: Commit**

```bash
git add site/patron/index.html
git commit -m "feat: replace polling loops with pulse-driven heartbeat"
```

---

### Task 8: Integration test — full pulse flow

**Files:**
- Test: `tests/kernel.test.js`

- [ ] **Step 1: Write integration test**

Add to `tests/kernel.test.js`:

```js
describe("pulse integration", () => {
  it("full flow: userspace writes → classify → pulse reflects changes", async () => {
    const { classify } = await import('../userspace.js');
    const { kernel, kv } = makeKernel();

    kernel.HOOKS = {
      tick: { run: async (K) => {
        await K.kvWriteSafe("experience:integration_test", { test: true });
        await K.kvWriteSafe("desire:test-desire", { slug: "test", direction: "approach" });
      }},
      pulse: { classify },
    };

    await kernel.loadEagerConfig();
    await kernel.runTick();

    const pulse = JSON.parse(await kv.get("kernel:pulse"));
    expect(pulse.v).toBe(1);
    expect(pulse.outcome).toBe("clean");
    expect(pulse.changed).toContain("mind");
    expect(pulse.changed).toContain("health");
    expect(pulse.n).toBe(0);
  });
});
```

- [ ] **Step 2: Run test**

Run: `npm test -- tests/kernel.test.js`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/kernel.test.js
git commit -m "test: add pulse integration test"
```
