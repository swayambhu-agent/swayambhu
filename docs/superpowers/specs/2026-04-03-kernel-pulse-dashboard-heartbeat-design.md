# kernel:pulse + Dashboard Heartbeat

Replace 6+ independent polling loops in the dashboard SPA with a single
heartbeat driven by a kernel-written change indicator.

## Problem

The dashboard polls multiple endpoints independently (karma watch 2s,
health 10s, chats 5-10s, direct messages 10s). The DR tab doesn't
auto-update at all — requires manual browser refresh. This creates a
poor experience where data arrives on minute-scale cadences but the
user has to keep refreshing to see it.

## Design

### 1. Kernel — raw change tracking

The kernel tracks which KV keys were written during each tick via a
`this.touchedKeys` Set, reset at tick start.

Three write paths feed it:
- `kvWrite(key, value, metadata)` — all internal kernel writes
- Tool-scoped KV — `buildToolContext` creates a scoped `kv.put` wrapper
- Delete paths — `kvDeleteSafe` and internal deletes

At the end of `runTick`, after tick + deferred processing complete:

```js
const changed = this.HOOKS.pulse?.classify
  ? await this.HOOKS.pulse.classify(this.touchedKeys)
  : [];

// Best-effort — pulse write failure must not crash the tick
try {
  await this.kv.put("kernel:pulse", JSON.stringify({
    v: 1,
    n: this.pulseCounter++,
    execution_id: this.executionId,
    outcome,
    ts: Date.now(),
    changed,
  }));
} catch {}
```

The kernel owns raw change capture. It has no knowledge of what
buckets mean — it just passes `touchedKeys` to the classifier hook
and writes whatever comes back.

`kernel:pulse` is a `kernel:*` key — agent-unwritable, kernel-only.

### 2. Userspace — bucket classifier

Userspace exports a `classify` function wired into `HOOKS.pulse`.
It maps raw touched keys to semantic bucket names.

```js
const BUCKET_MAP = [
  [['session_counter', 'cache:session_ids'], 'sessions'],
  [['action:'], 'sessions'],
  [['karma:'], 'sessions'],
  [['desire:', 'samskara:', 'experience:'], 'mind'],
  [['dr:', 'reflect:', 'last_reflect'], 'reflections'],
  [['chat:', 'outbox:', 'conversation_index:'], 'chats'],
  [['contact:', 'contact_platform:'], 'contacts'],
];

function classify(touchedKeys) {
  const buckets = new Set(['health']); // always present
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

Wired in index.js:
```js
const HOOKS = {
  tick: session,
  deferred: { comms: { ... } },
  pulse: { classify },
};
```

Cognitive knowledge stays in userspace. Adding a new bucket or changing
a mapping never requires a kernel change.

### 3. Dashboard API — `/pulse` endpoint

One new lightweight endpoint:

```js
if (path === "/pulse") {
  const pulse = await env.KV.get("kernel:pulse", "json");
  return json(pulse || { v: 1, n: 0, changed: [] });
}
```

One KV read, no auth required (pulse contains no sensitive data).
The existing `/health` endpoint stays for initial page load.

### 4. Dashboard SPA — single heartbeat loop

Replace all independent `setInterval` calls with one heartbeat:

```js
let lastPulseN = 0;

async function heartbeat() {
  const pulse = await api("/pulse", patronKey);
  if (!pulse || pulse.n === lastPulseN) return;
  lastPulseN = pulse.n;

  const changed = new Set(pulse.changed);

  if (changed.has("sessions"))    refreshSessions();
  if (changed.has("health"))      refreshHealth();
  if (changed.has("mind"))        refreshMind();
  if (changed.has("reflections")) refreshReflections();
  if (changed.has("chats"))       refreshChats();
  if (changed.has("contacts"))    refreshContacts();
}
```

Adaptive interval:
- 5s normal
- 2s when a session is active (detected by `/health` returning a
  non-null `active_execution` on initial load; subsequent ticks inferred
  from pulse `n` advancing rapidly)
- 15s when browser tab is hidden (document.hidden)

Safety net: each tab does a slow background poll (60s) regardless of
pulse, to handle pulse write failures or KV eventual consistency.

In-flight guard: one boolean per resource prevents overlapping fetches.

The 1s countdown timer stays (purely cosmetic, client-side).

Removed:
- Watch button setInterval (2000ms)
- Chat list poll (10000ms)
- Selected chat poll (5000ms)
- Direct message poll (10000ms)
- Health/mind poll (10000ms)

## Pulse shape

```json
{
  "v": 1,
  "n": 47,
  "execution_id": "x_1775204762010_0mohj0",
  "outcome": "clean",
  "ts": 1775204762523,
  "changed": ["sessions", "health", "mind"]
}
```

- `v` — schema version
- `n` — monotonic pulse counter (advances every tick)
- `changed` — advisory bucket list (hint, not guarantee)

## Bucket definitions

| Bucket | Triggered by writes to | Dashboard consumer |
|--------|----------------------|-------------------|
| health | (always) | Header status bar |
| sessions | session_counter, cache:*, karma:*, action:* | Timeline tab |
| mind | desire:*, samskara:*, experience:* | Mind tab |
| reflections | dr:*, reflect:*, last_reflect | DR tab |
| chats | chat:*, outbox:*, conversation_index:* | Chats tab |
| contacts | contact:*, contact_platform:* | Contacts section |

## Design decisions

**Why not WebSockets/SSE?** Cloudflare Workers free plan has a 30s
request timeout. The kernel ticks every 60s. Push infrastructure would
add complexity for a system that updates on minute-scale cadences.

**Why not config-driven buckets?** Moving the mapping to KV changes
storage, not ownership — the kernel would still interpret cognitive
architecture. Userspace owns the semantics.

**Why `changed` is advisory.** KV is eventually consistent. A pulse
may advance before data is readable. The 60s safety-net poll handles
edge cases. Consumers treat pulse as "refetch soon", not "data exists
now".

**Why `n` instead of timestamps.** Monotonic counter avoids clock
drift and collision issues. The client just checks `n !== lastN`.

## Files touched

| File | Change |
|------|--------|
| kernel.js | touchedKeys Set, pulse write at end of runTick |
| userspace.js | Export classify function |
| index.js | Wire HOOKS.pulse.classify |
| governor/builder.js | Generate HOOKS.pulse in built index.js |
| dashboard-api/worker.js | Add /pulse endpoint |
| site/patron/index.html | Replace polling with heartbeat |
| site/patron/config.js | Add heartbeat interval config |
