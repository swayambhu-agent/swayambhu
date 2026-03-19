# Entry Points and Call Chains

Five entry points into the system. This document traces each from the external trigger through to the final side effects.

---

## 1. Cron trigger (wake cycle)

**Trigger:** Cloudflare cron `* * * * *` (every minute) fires `scheduled()`.

**Source:** `brainstem.js:141` (prod), `brainstem-dev.js:48` (dev).

### Production call chain

```
Cloudflare cron trigger
│
▼
scheduled(event, env, ctx)                          brainstem.js:142
│ new Brainstem(env, { ctx })
│
▼
brain.runScheduled()                                brainstem.js:881
│
├─► detectPlatformKill()                            brainstem.js:920
│   │ Read kernel:active_session
│   │ If stale → prepend { outcome: "killed" } to kernel:last_sessions
│   │ Delete kernel:active_session
│   │
│
├─► checkHookSafety()                               brainstem.js:934
│   │ Read kernel:last_sessions
│   │ If last 3 are crash/killed:
│   │   Delete all hook:wake:* keys
│   │   Try restore from kernel:last_good_hook
│   │   If restored → delete snapshot (anti-loop), alert, return true
│   │   If no snapshot → alert, return false
│   │ Else return true
│   │
│
├─► Load hook modules                               brainstem.js:893
│   │ Read hook:wake:manifest
│   │ If manifest:
│   │   Read each KV key in manifest → modules map
│   │   mainModule = "main" (or first key)
│   │ Else:
│   │   Read hook:wake:code → single module
│   │
│
▼
[modules loaded?]
├─ YES → brain.executeHook(modules, mainModule)     brainstem.js:979
│         │
│         ├─► Write kernel:active_session = sessionId
│         │
│         ├─► _invokeHookModules(modules, mainModule) brainstem.js:1007
│         │   │ Set _activeBrain = this
│         │   │ env.LOADER.get() → create Worker Loader isolate
│         │   │   modules: hook source code from KV
│         │   │   env.KERNEL: this.ctx.exports.KernelRPC({})
│         │   │ POST https://internal/wake { sessionId }
│         │   │
│         │   ▼ (inside isolate)
│         │   hook-main.js default export fetch()   hook-main.js:278
│         │   │ K = env.KERNEL (KernelRPC binding)
│         │   │
│         │   ▼
│         │   wake(K, input)                        hook-main.js:18
│         │   │
│         │   ├─► Sleep check                       hook-main.js:44
│         │   │   Read wake_config → check next_wake_after
│         │   │   Return { skipped: true } if not time
│         │   │
│         │   ├─► detectCrash(K)                    hook-main.js:136
│         │   │   Read kernel:active_session
│         │   │   If stale and ≠ current → read karma:{staleId}, return crash data
│         │   │
│         │   ├─► initTracking()                    hook-modifications.js:10
│         │   │   Scan modification_staged:* and modification_snapshot:* prefixes
│         │   │   Populate in-memory tracking arrays
│         │   │
│         │   ├─► runCircuitBreaker(K)              hook-modifications.js:445
│         │   │   Read last_danger
│         │   │   For each inflight code modification activated before danger:
│         │   │     rollbackInflight() → restore snapshot, delete modification_snapshot:*
│         │   │   Delete last_danger via kvDeleteSafe
│         │   │
│         │   ├─► retryPendingGitSyncs(K)           hook-modifications.js:645
│         │   │   Scan git_pending:* → retry each via computer
│         │   │
│         │   ├─► getBalances(K, state)              hook-main.js:249
│         │   │   K.checkBalance({}) → iterate providers + wallets → executeAdapter for each
│         │   │
│         │   ├─► Reload config:defaults, config:models, config:tool_registry
│         │   │
│         │   ├─► highestReflectDepthDue(K, state)  hook-reflect.js:364
│         │   │   Check reflect:schedule:{depth} for each depth from max down to 1
│         │   │   Return highest due depth, or 0
│         │   │
│         │   ├─► evaluateTripwires(config, { balances }) hook-main.js:253
│         │   │   Evaluate alert conditions → possibly escalate effort level
│         │   │
│         │   ├─► Record session_start karma
│         │   │
│         │   ▼
│         │   [reflectDepth > 0?]
│         │   │
│         │   ├── YES ──► DEEP REFLECT PATH
│         │   │           runReflect(K, state, depth, context) hook-reflect.js:119
│         │   │           │ Load prompt:reflect:{depth} or default
│         │   │           │ Gather context (orient prompt, staged/inflight mods, blocked comms, patron info)
│         │   │           │ Build tools (all except spawn_subplan)
│         │   │           │ K.runAgentLoop({ tools, model: deep_reflect model, ... })
│         │   │           │   └─► LLM + tool loop (see agent loop below)
│         │   │           │ applyReflectOutput():
│         │   │           │   Apply kv_operations via protection gate
│         │   │           │   Process modification_verdicts (apply/reject/promote/rollback/etc.)
│         │   │           │   Process comms_verdicts (send/revise_and_send/drop)
│         │   │           │   Apply modification_requests via acceptDirect()
│         │   │           │   Save reflect schedule + output
│         │   │           │   If depth == 1: write last_reflect + wake_config
│         │   │           │
│         │   │           │ [depth > 1?] → cascade: runReflect(K, state, depth-1, context)
│         │   │
│         │   └── NO ───► ORIENT PATH
│         │               runSession(K, state, context, config) hook-main.js:155
│         │               │ Read prompt:orient, config:resources
│         │               │ Build system prompt from template
│         │               │ Build orient context (balances, last_reflect, effort, crash data, time)
│         │               │ Resolve orient model
│         │               │ Build tool definitions
│         │               │ Calculate orient budget cap (reserve for reflect)
│         │               │
│         │               │ K.runAgentLoop({ tools, model: orient model, ... })
│         │               │   └─► LLM + tool loop (see agent loop below)
│         │               │
│         │               │ Apply kv_operations via applyKVOperation (protection gate)
│         │               │
│         │               │ [budget not fully exhausted?]
│         │               │   executeReflect(K, state, step)    hook-reflect.js:14
│         │               │   │ Read prompt:reflect
│         │               │   │ Get karma (strip request payloads) + session cost
│         │               │   │ K.runAgentLoop({ tools: [], maxSteps: 1, model: reflect model })
│         │               │   │ Save last_reflect + reflect:0:{sessionId}
│         │               │   │ Apply kv_operations via protection gate
│         │               │   │ Process modification_verdicts (withdraw, modify only)
│         │               │   │ Stage modification_requests
│         │               │   │ Apply next_wake_config if present
│         │               │
│         │               │ writeSessionResults()
│         │               │   Save wake_config, increment session_counter, append cache:session_ids
│         │
│         ├─► [catch] If hook crashed:
│         │   outcome = "crash"
│         │   Record hook_execution_error karma
│         │   runMinimalFallback()                   brainstem.js:1066
│         │   │ Alert, load eager config
│         │   │ Override defaults to { max_cost: 0.50, max_duration_seconds: 120 }
│         │   │ runAgentLoop({ hardcoded recovery prompt, maxSteps: 3 })
│         │   │ Discard kv_operations
│         │   │ Increment session_counter
│         │
│         ├─► updateSessionOutcome(outcome)          brainstem.js:1037
│         │   Prepend to kernel:last_sessions (keep 5)
│         │   If "clean":
│         │     If kernel:hook_dirty or no kernel:last_good_hook:
│         │       Snapshot all hook modules to kernel:last_good_hook
│         │       Delete kernel:hook_dirty
│         │
│         └─► Delete kernel:active_session
│
└─ NO → brain.wake()                                 brainstem.js:1112
          runMinimalFallback() + updateSessionOutcome("clean")
```

### Dev call chain differences

```
DevBrainstem.scheduled()                            brainstem-dev.js:48
│ new DevBrainstem(env, { ctx })
│ brain.runScheduled()                              (inherited from Brainstem)
│   ...same flow through detectPlatformKill, checkHookSafety, load modules...
│
│ _invokeHookModules() override                     brainstem-dev.js:136
│   this.loadEagerConfig()
│   wake(this, { sessionId })                       ← direct call, no isolate
│     K = this (DevBrainstem instance)
│     K.getSessionId() → this.sessionId             ← getter bridge, not RPC
│     K.callLLM() → base class callLLM()
│       callWithCascade() override                  brainstem-dev.js:222
│         Direct fetch to OpenRouter (no cascade, no isolate)
│     K.executeToolCall() → base class executeToolCall()
│       executeAction() → _executeTool() override   brainstem-dev.js:170
│         Direct call to TOOL_MODULES[name].execute(ctx) (no isolate)
│       callHook() override → returns null          brainstem-dev.js:274
│         (validate/validate_result hooks never run in dev)
```

**Key dev differences:**
- No Worker Loader isolates — all code runs in same process
- `callWithCascade()` → direct OpenRouter fetch, 60s timeout, no provider cascade
- `callHook()` → returns null (no pre/post-validation hooks)
- `_executeTool()` → calls imported module directly
- `executeAdapter()` → calls imported provider directly
- Webhook signature verification skipped for inbound chat

---

## 2. HTTP fetch handler (chat)

**Trigger:** HTTP POST to `/channel/:channel` (e.g., Slack sends webhook to `/channel/slack`).

**Source:** `brainstem.js:147` (prod), `brainstem-dev.js:53` (dev).

### Production call chain

```
POST /channel/slack
│
▼
fetch(request, env, ctx)                            brainstem.js:147
│ Match /channel/(\w+) — if no match or not POST → 404
│ new Brainstem(env, { ctx })
│
├─► Load adapter from KV                            brainstem.js:158
│   Read channel:slack:code → adapterCode
│   Read channel:slack:config → adapterConfig
│   If no code → 404
│
├─► Read raw body (text, for HMAC)                  brainstem.js:164
│
├─► Verify webhook signature (in isolate)           brainstem.js:175
│   Collect env vars from adapterConfig.secrets + webhook_secret_env
│   runInIsolate({ action: "verify", headers, rawBody, env_vars })
│   │ wrapChannelAdapter(adapterCode) → adds default export with verify/parse/send dispatch
│   │ verify(headers, rawBody, env_vars)            channels/slack.js:10
│   │   Check X-Slack-Request-Timestamp (reject > 5 min → replay protection)
│   │   HMAC-SHA256: v0:timestamp:rawBody with SLACK_SIGNING_SECRET
│   │   Constant-time comparison
│   │   Return { ok: true/false }
│   If !ok → 401 Unauthorized
│
├─► Parse JSON body                                  brainstem.js:186
│   If invalid JSON → 400
│
├─► Parse inbound message (in isolate)               brainstem.js:191
│   runInIsolate({ action: "parse", body })
│   │ parseInbound(body)                             channels/slack.js:42
│   │   url_verification → return { _challenge }
│   │   event.type !== "message" → return null
│   │   Ignore bot_id, subtype
│   │   Return { chatId, text, userId, command, msgId }
│   If no inbound → 200 OK (ignored event type)
│
├─► Challenge response                               brainstem.js:201
│   If _challenge → respond with { challenge } JSON
│
├─► Deduplication                                    brainstem.js:209
│   If msgId: check dedup:{msgId} in KV
│   If seen → 200 OK (duplicate)
│   Write dedup:{msgId} = "1" with 30s TTL
│
├─► Build adapter secrets                            brainstem.js:217
│
├─► Return 200 OK immediately                       brainstem.js:244
│
└─► ctx.waitUntil(background work)                   brainstem.js:223
    │
    ├─► brain.loadEagerConfig()                      brainstem.js:312
    │   Load config:defaults, config:models, config:model_capabilities,
    │   dharma, config:tool_registry, yamas/niyamas, patron context
    │
    ├─► Build adapter.sendReply()                    brainstem.js:228
    │   Wraps runInIsolate({ action: "send", chatId, text, secrets })
    │   │ sendReply(chatId, text, secrets, fetch)    channels/slack.js:68
    │   │   POST https://slack.com/api/chat.postMessage
    │
    ▼
    handleChat(brain, channel, inbound, adapter)     hook-chat.js:8
    │
    ├─► Load conversation state                      hook-chat.js:13
    │   Read chat:state:slack:{chatId} or init new { messages: [], total_cost: 0, ... }
    │
    ├─► Handle commands                              hook-chat.js:21
    │   "/reset" → zero cost, preserve history, reply "Budget refilled"
    │   "/clear" → delete state, reply "Conversation cleared"
    │
    ├─► Load config                                  hook-chat.js:33
    │   Get defaults (K.getDefaults())
    │   Resolve contact (K.resolveContact(channel, userId))
    │   Merge: chatDefaults ← contactConfig overrides
    │
    ├─► Budget check                                 hook-chat.js:39
    │   If total_cost >= max_cost_per_conversation → reply "Budget reached"
    │
    ├─► Build system prompt                          hook-chat.js:46
    │   Read prompt:chat from KV (or fallback hardcoded string)
    │   Append contact context if resolved
    │
    ├─► Append user message to conversation          hook-chat.js:56
    │
    ├─► Resolve model + tools                        hook-chat.js:59
    │   Known contact → full tool set (buildToolDefinitions)
    │   Unknown contact → empty tools (or unknown_contact_tools allowlist)
    │   Log inbound_unknown karma for unknown contacts
    │
    ├─► Tool-calling loop (max_tool_rounds, default 5) hook-chat.js:78
    │   for each round:
    │     K.callLLM({ model, effort, systemPrompt, messages, tools })
    │       ├─► Dharma + principles prepended (kernel-enforced)
    │       └─► callWithCascade (3-tier provider cascade in prod)
    │     If toolCalls:
    │       Add assistant message with tool_calls
    │       Execute all in parallel: K.executeToolCall(tc)
    │         ├─► Communication gate (if tool has meta.communication)
    │         ├─► callHook('validate', ...) — pre-validation
    │         ├─► executeAction → _executeTool (in isolate)
    │         ├─► callHook('validate_result', ...) — post-validation
    │         └─► Inbound content gate (if tool has meta.inbound)
    │       Add tool result messages
    │       continue
    │     Else:
    │       reply = response.content
    │       Add assistant message
    │       break
    │
    ├─► Send reply                                   hook-chat.js:119
    │   adapter.sendReply(chatId, reply)
    │   │ → runInIsolate → sendReply → POST to Slack API
    │
    ├─► Trim + save state                            hook-chat.js:122
    │   Increment turn_count
    │   Trim messages to max_history_messages (default 40)
    │   Save to chat:state:slack:{chatId} via kvPutSafe
    │
    └─► Record chat_turn karma                       hook-chat.js:130
```

### Dev call chain differences

```
POST /channel/slack
│
▼
DevBrainstem fetch(request, env, ctx)                brainstem-dev.js:53
│ Match /channel/(\w+)
│ new DevBrainstem(env, { ctx })
│ Load adapter from CHANNEL_ADAPTERS (inline import, not KV)
│
├─► Skip webhook verification entirely               brainstem-dev.js:69
│   (no verify call in dev)
│
├─► Parse: slackAdapter.parseInbound(body)           (direct call, no isolate)
│
├─► Challenge, dedup same as prod
│
├─► Return 200 immediately
│
└─► ctx.waitUntil(background)
    │ brain.loadEagerConfig()
    │ adapter.sendReply = slackAdapter.sendReply()   (direct call, no isolate)
    │ handleChat(brain, channel, inbound, adapter)   (same flow)
    │   K.executeToolCall → _executeTool override    (direct call, no isolate)
    │   K.callLLM → callWithCascade override         (direct OpenRouter fetch)
    │   K.callHook → returns null                    (hooks disabled)
```

**NOTE:** In dev mode, the entire verification step is skipped. Any POST to `/channel/slack` with valid JSON is processed. This means malformed or forged webhook payloads won't be rejected.

---

## 3. Dashboard API

**Separate Cloudflare Worker.** Source: `dashboard-api/worker.js`. Shares the same KV namespace as brainstem.

**Wrangler config:** `dashboard-api/wrangler.toml`. Dev port 8790. `OPERATOR_KEY` is `"test"` in dev (set as `[vars]`), overridden by secret in prod.

### Auth model

- `GET /reflections` — **public, no auth**
- `OPTIONS` on any path — CORS preflight, no auth
- All other routes — require `X-Operator-Key` header matching `env.OPERATOR_KEY`

### Routes

```
OPTIONS *                               → 204 with CORS headers

GET /reflections                        → public (no auth)
│ kvListAll(prefix: "reflect:1:")
│ Filter out reflect:1:schedule*
│ Sort newest first, take 20
│ Return { session_id, timestamp, reflection, note_to_future_self } for each

GET /health                             → auth required
│ Parallel read: session_counter, wake_config, last_reflect,
│   kernel:active_session, session
│ Return { sessionCounter, wakeConfig, lastReflect, session }

GET /sessions                           → auth required
│ Parallel: kvListAll(karma:*), kvListAll(reflect:1:*), cache:session_ids
│ Cross-reference karma keys with reflect:1:* to tag session type
│ Return { sessions: [{ id, type: "orient"|"deep_reflect", ts }] }

GET /kv?prefix=                         → auth required
│ kvListAll with optional prefix filter
│ Return { keys: [{ key, metadata }] }

GET /kv/multi?keys=k1,k2               → auth required
│ Batch read: split comma-separated keys, parallel getWithMetadata
│ JSON-parse if format metadata says json
│ Return { key1: value1, key2: value2, ... }

GET /kv/:key                            → auth required
│ getWithMetadata(key, "text")
│ JSON-parse if format metadata says json
│ Return { key, value, type: "json"|"text" }

GET /quarantine                         → auth required
│ kvListAll(prefix: "sealed:quarantine:")
│ Return { items: [{ key, sender, content, tool, timestamp, ... }] }
│ NOTE: Dashboard reads sealed:* keys directly from KV — no RPC gate.
│ This is the ONLY way to see quarantined content.

POST /contacts                          → auth required
│ Validate: requires slug, name, platforms (object)
│ Check for existing contact (409 if exists)
│ Write contact:{slug} directly to KV
│ Write contact_index:{platform}:{userId} for each platform
│ Return { ok, slug, contact }

DELETE /quarantine/:key                  → auth required
│ Validate key starts with "sealed:quarantine:"
│ Delete from KV
│ Return { ok: true }
```

**NOTE:** The dashboard reads `kernel:active_session` and `sealed:quarantine:*` directly from KV. The brainstem's `KernelRPC.kvGet()` blocks `sealed:*` reads, but the dashboard doesn't go through RPC — it uses `env.KV` directly. This is by design: the dashboard is operator-only, and quarantine content is intended for patron review.

**NOTE:** `GET /health` reads a key called `session` (plain text). This key is never written by any code in the codebase. The result is `null` and falls through to `activeSession` via the `||` operator, so it's harmless but dead.

---

## 4. Dashboard SPA

**Static site** served by `scripts/dev-serve.mjs` (port 3001 in dev). Source files in `site/`.

### Pages

| Path | File | Description |
|------|------|-------------|
| `/` | `site/index.html` | Landing/redirect |
| `/reflections/` | `site/reflections/index.html` | Public reflections page — fetches `GET /reflections` from dashboard API |
| `/operator/` | `site/operator/index.html` | Authenticated operator dashboard — React SPA via Babel in-browser transform |

### Operator dashboard (`/operator/`)

Single-file React SPA loaded via CDN (React 18, Babel standalone, Tailwind CSS, marked.js, highlight.js). No build step.

The SPA:
- Prompts for operator key on load (stored in memory)
- Sends `X-Operator-Key` header with every API request
- Hardcodes API base URL to `http://localhost:8790` for dev
- Fetches `/health`, `/sessions`, `/kv`, `/kv/:key`, `/kv/multi`, `/quarantine`

### Dev server (`scripts/dev-serve.mjs`)

Minimal Node.js HTTP server. Serves `site/` directory with `Cache-Control: no-store` on every response.

Special route: `POST /wake` proxies to `http://localhost:8787/__scheduled` (triggers a wake cycle from the SPA).

**NOTE:** In production, the SPA would need a different API base URL. The `localhost:8790` is hardcoded in the operator HTML.

---

## 5. Manual triggers

### `scripts/start.sh`

One-script dev startup. Runs everything needed for local development.

```
source .env && bash scripts/start.sh [options]

Options:
  --wake                    Trigger wake cycle after services start
  --reset-all-state         Wipe .wrangler/shared-state/, re-seed from scratch
  --yes                     Skip confirmation prompt
  --set path=value          Override config:defaults value after seeding (repeatable)
```

Execution flow:
1. Kill stale processes: `pkill -f workerd`, `pkill -f dev-serve.mjs`
2. Wait for ports 8787, 8790, 3001 to free (15s timeout)
3. If `--reset-all-state`:
   - Confirm (unless `--yes`)
   - `rm -rf .wrangler/shared-state`
   - `node scripts/seed-local-kv.mjs`
   - Apply `--set` overrides via Miniflare (read `config:defaults`, deep-set paths, write back)
4. Else:
   - `node scripts/reset-wake-timer.mjs` (set `wake_config.next_wake_after` to past)
5. Start brainstem: `npx wrangler dev -c wrangler.dev.toml --test-scheduled --persist-to .wrangler/shared-state`
6. Start dashboard API: `cd dashboard-api && npx wrangler dev --port 8790 --persist-to ../.wrangler/shared-state`
7. Start dashboard SPA: `node scripts/dev-serve.mjs 3001`
8. Wait for brainstem and dashboard API to respond
9. If `--wake`: `curl http://localhost:8787/__scheduled`
10. Print service URLs, wait for Ctrl+C
11. On exit: kill all process groups

### `curl http://localhost:8787/__scheduled`

Triggers a wake cycle manually. Wrangler's `--test-scheduled` flag enables this endpoint. This is the same code path as the cron trigger — `scheduled()` → `runScheduled()`.

### `node scripts/seed-local-kv.mjs`

Seeds all 69 keys into local KV via Miniflare API (no wrangler subprocess). Takes ~2s. See `docs/dev/kv-schema.md` for the full key list.

### `node scripts/read-kv.mjs [key-or-prefix]`

Inspects local KV store via Miniflare:

```bash
node scripts/read-kv.mjs                   # list all keys
node scripts/read-kv.mjs karma:            # list keys with prefix (trailing colon)
node scripts/read-kv.mjs karma:s_123_abc   # read a specific key's value
node scripts/read-kv.mjs --json karma:s_1  # raw JSON output (for piping)
```

Logic: if the argument doesn't end with `:`, try reading as an exact key first. If not found (or ends with `:`), list keys with that prefix.

### `node scripts/rollback-session.mjs`

Undoes the most recent wake session's KV changes by reading its karma log and reversing `privileged_write` entries.

```bash
node scripts/rollback-session.mjs            # roll back with confirmation
node scripts/rollback-session.mjs --dry-run  # show what would be undone
node scripts/rollback-session.mjs --yes      # skip confirmation
```

### `node scripts/dump-sessions.mjs`

Prints session summaries by reading `cache:session_ids`, then for each session reading `reflect:0:{id}`. Shows session summary, note to future self, and flags budget exceeded / parse errors.

Also prints the current tool registry at the end.

### `node scripts/reset-wake-timer.mjs`

Sets `wake_config.next_wake_after` to `"2020-01-01T00:00:00Z"` so the next wake cycle isn't skipped. Called automatically by `start.sh` when not resetting state. Uses `process.exit(0)` to force-exit because `mf.dispose()` can hang.

### `node scripts/generate-identity.js`

Generates a DID keypair via ethers. Used once during initial setup. Not part of the normal dev workflow.

---

## Agent loop detail

Referenced by both the wake cycle and chat call chains. `runAgentLoop()` at `brainstem.js:1819`.

```
runAgentLoop({ systemPrompt, initialContext, tools, model, effort,
               maxTokens, maxSteps, step, budgetCap })
│
├─► Build messages: [{ role: "user", content: initialContext }]
│
├─► for i = 0..maxSteps:
│   │
│   ├─► callLLM({ model, effort, maxTokens, systemPrompt, messages, tools, step, budgetCap })
│   │   │ Budget check (cost + duration)
│   │   │ Prepend dharma + yamas + niyamas to systemPrompt
│   │   │ Build messages array with system message
│   │   │ callWithCascade(request, step)
│   │   │   Prod: tier 1 (dynamic adapter) → tier 2 (last working) → tier 3 (kernel fallback)
│   │   │   Dev: direct OpenRouter fetch
│   │   │ Record karma
│   │   │ Track sessionCost, sessionLLMCalls, lastCallModel
│   │   │ Return { content, usage, cost, toolCalls }
│   │
│   ├─► [toolCalls?]
│   │   YES:
│   │     messages.push({ role: "assistant", content, tool_calls })
│   │     Execute ALL tools in parallel:
│   │       Promise.all(toolCalls.map(tc => executeToolCall(tc)))
│   │         │ Parse args from function.arguments (JSON string)
│   │         │ Special cases: spawn_subplan → spawnSubplan(), check_balance → checkBalance()
│   │         │ Load tool meta
│   │         │ Communication gate (if meta.communication)
│   │         │   Mechanical floor → model gate → LLM gate
│   │         │   Block/queue → queueBlockedComm, return error
│   │         │   Revise → modify args
│   │         │   Send → proceed
│   │         │ callHook('validate', { tool, args, schema })
│   │         │ executeAction({ tool, input, id })
│   │         │   _loadTool → _executeTool (isolate in prod, direct in dev)
│   │         │ callHook('validate_result', { tool, args, result })
│   │         │ Inbound content gate (if meta.inbound)
│   │         │   Resolve sender contact
│   │         │   Unknown → quarantine content, redact
│   │     messages.push({ role: "tool", tool_call_id, content: JSON.stringify(result) }) for each
│   │     continue
│   │
│   │   NO (text response):
│   │     parseAgentOutput(content)
│   │       JSON.parse → extract from markdown fences → find {} or [] → parse_repair hook → { parse_error, raw }
│   │     If parse_error and first failure:
│   │       Inject retry message, continue (burns one step)
│   │     Else:
│   │       return parsed output
│   │
├─► [maxSteps exhausted]
│   messages.push("Maximum steps reached. Produce your final output now.")
│   callLLM({ ...no tools... })  ← forces text output
│   parseAgentOutput, return
│
└─► [catch Budget exceeded]
    Return { budget_exceeded: true, reason }
```
