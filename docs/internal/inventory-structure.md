# Structural Inventory — Swayambhu Codebase

Generated 2026-03-17. Covers every file in the project.

---

## 1. File Manifest

### Kernel

| File | Purpose | Exports | Imports | Imported by |
|------|---------|---------|---------|-------------|
| `brainstem.js` | Production kernel — all hardcoded primitives, safety, alerting, hook dispatch, LLM cascade, agent loop, tool execution, communication gate, inbound gate, KV write tiers, patron verification | `class ScopedKV` (WorkerEntrypoint), `class KernelRPC` (WorkerEntrypoint), `class Brainstem`, `default` (fetch+scheduled handlers) | `cloudflare:workers` (WorkerEntrypoint), `./hook-chat.js` (handleChat) | `brainstem-dev.js` |
| `brainstem-dev.js` | Dev-mode kernel subclass — direct imports instead of CF isolates, direct OpenRouter fetch instead of adapter cascade | `default` (fetch+scheduled handlers), `class DevBrainstem` (implicit) | `./brainstem.js` (Brainstem), `./hook-main.js` (wake), `./hook-chat.js` (handleChat), `./channels/slack.js`, all `./tools/*.js`, all `./providers/*.js` | None (entry point via `wrangler.dev.toml`) |

### Hook Modules (Wake Cycle Policy Layer)

| File | Purpose | KV Key | Exports | Imports | Imported by |
|------|---------|--------|---------|---------|-------------|
| `hook-main.js` | Wake flow entry point — session control, crash detection, orient session, balance checking, tripwire evaluation | `hook:wake:code` | `wake`, `detectCrash`, `runSession`, `buildOrientContext`, `writeSessionResults`, `getBalances`, `evaluateTripwires`, `default` (Worker Loader export) | `./hook-protect.js` (applyKVOperation), `./hook-modifications.js` (initTracking, runCircuitBreaker, retryPendingGitSyncs), `./hook-reflect.js` (executeReflect, runReflect, highestReflectDepthDue, getMaxSteps) | `brainstem-dev.js` |
| `hook-reflect.js` | Reflection system — session reflect (depth 0), deep reflect (recursive depth 1+), scheduling, default prompts | `hook:wake:reflect` | `executeReflect`, `runReflect`, `gatherReflectContext`, `applyReflectOutput`, `loadReflectPrompt`, `loadBelowPrompt`, `loadReflectHistory`, `getReflectModel`, `getMaxSteps`, `isReflectDue`, `highestReflectDepthDue`, `defaultReflectPrompt`, `defaultDeepReflectPrompt` | `./hook-protect.js` (applyKVOperation), `./hook-modifications.js` (loadStagedModifications, loadInflightModifications, stageModification, acceptDirect, processReflectVerdicts, processDeepReflectVerdicts) | `hook-main.js` |
| `hook-modifications.js` | Modification Protocol — staging, inflight management, conflict detection, circuit breaker, verdict processing, git sync | `hook:wake:modifications` | `initTracking`, `evaluatePredicate`, `evaluateCheck`, `evaluateChecks`, `stageModification`, `acceptStaged`, `acceptDirect`, `promoteInflight`, `rollbackInflight`, `findInflightConflict`, `loadStagedModifications`, `loadInflightModifications`, `processReflectVerdicts`, `processDeepReflectVerdicts`, `runCircuitBreaker`, `kvToPath`, `syncToGit`, `attemptGitSync`, `retryPendingGitSyncs` | None (standalone) | `hook-main.js`, `hook-reflect.js` |
| `hook-protect.js` | KV operation protection gate — blocks writes to system/protected keys | `hook:wake:protect` | `applyKVOperation` | None (standalone, leaf module) | `hook-main.js`, `hook-reflect.js` |

### Chat System

| File | Purpose | Exports | Imports | Imported by |
|------|---------|---------|---------|-------------|
| `hook-chat.js` | Platform-agnostic chat session pipeline — conversation state, budget tracking, tool-calling loop, contact resolution | `handleChat` | None | `brainstem.js`, `brainstem-dev.js` |

### Channel Adapters

| File | Purpose | Exports | Imports | Imported by |
|------|---------|---------|---------|-------------|
| `channels/slack.js` | Slack channel adapter — webhook verification (HMAC-SHA256), inbound parsing, reply sending | `config`, `verify`, `parseInbound`, `sendReply` | None | `brainstem-dev.js` |

### Tools

| File | Purpose | Exports | Imports | Imported by |
|------|---------|---------|---------|-------------|
| `tools/kv_query.js` | Read a KV value with optional dot-bracket path navigation | `meta` (kv_access: "read_all"), `execute` | None | `brainstem-dev.js`, `scripts/seed-local-kv.mjs` |
| `tools/kv_write.js` | Write to tool's own scoped KV namespace | `meta` (kv_access: "own"), `execute` | None | `brainstem-dev.js`, `scripts/seed-local-kv.mjs` |
| `tools/kv_manifest.js` | List KV keys with optional prefix filter | `meta` (kv_access: "read_all"), `execute` | None | `brainstem-dev.js`, `scripts/seed-local-kv.mjs` |
| `tools/send_slack.js` | Post a message to Slack via API | `meta` (secrets: SLACK_BOT_TOKEN/CHANNEL_ID, communication gate), `execute` | None | `brainstem-dev.js`, `scripts/seed-local-kv.mjs` |
| `tools/web_fetch.js` | Fetch URL contents | `meta`, `execute` | None | `brainstem-dev.js`, `scripts/seed-local-kv.mjs` |
| `tools/akash_exec.js` | Run shell command on Akash Linux server | `meta` (secrets: AKASH_CF_CLIENT_ID/API_KEY), `execute` | None | `brainstem-dev.js`, `scripts/seed-local-kv.mjs` |
| `tools/check_email.js` | Fetch unread emails from Gmail | `meta` (secrets: GMAIL_*, provider: "gmail", inbound gate), `execute` | None | `brainstem-dev.js`, `scripts/seed-local-kv.mjs` |
| `tools/send_email.js` | Send email or reply via Gmail | `meta` (secrets: GMAIL_*, provider: "gmail", communication gate), `execute` | None | `brainstem-dev.js`, `scripts/seed-local-kv.mjs` |

### Provider Adapters

| File | Purpose | Exports | Imports | Imported by |
|------|---------|---------|---------|-------------|
| `providers/llm.js` | OpenRouter LLM adapter — chat completions API call | `meta` (secrets: OPENROUTER_API_KEY), `call` | None | `brainstem-dev.js`, `scripts/seed-local-kv.mjs` |
| `providers/llm_balance.js` | OpenRouter balance check | `meta` (secrets: OPENROUTER_API_KEY), `check` | None | `brainstem-dev.js`, `scripts/seed-local-kv.mjs` |
| `providers/wallet_balance.js` | Base chain USDC balance check via RPC | `meta` (secrets: WALLET_ADDRESS), `check` | None | `brainstem-dev.js`, `scripts/seed-local-kv.mjs` |
| `providers/gmail.js` | Gmail API adapter — token refresh, list/get/send/modify messages | `meta`, `getAccessToken`, `listUnread`, `getMessage`, `sendMessage`, `markAsRead`, `check` | None | `brainstem-dev.js`, `scripts/seed-local-kv.mjs` |

### Dashboard

| File | Purpose | Exports | Imports | Imported by |
|------|---------|---------|---------|-------------|
| `dashboard-api/worker.js` | Stateless KV reader for operator dashboard — health, sessions, KV browse, reflections, quarantine, contacts | `default` (fetch handler) | None | None (entry point via `dashboard-api/wrangler.toml`) |
| `site/operator/index.html` | Operator dashboard SPA (HTML/JS) | N/A | N/A | N/A |
| `site/operator/config.js` | Dashboard timezone/locale/truncation/polling config | `window.DASHBOARD_CONFIG` | N/A | `site/operator/index.html` |
| `site/index.html` | Landing page (static) | N/A | N/A | N/A |
| `site/reflections/index.html` | Public reflections viewer (static) | N/A | N/A | N/A |

### Scripts

| File | Purpose | Exports | Imports | Imported by |
|------|---------|---------|---------|-------------|
| `scripts/shared.mjs` | Shared Miniflare factory — KV namespace ID and persist path | `root`, `getKV`, `dispose` | `miniflare` | All other scripts |
| `scripts/seed-local-kv.mjs` | Fast local KV seeder — seeds all config, tools, providers, prompts, hooks, contacts, dharma, yamas, niyamas, wisdom | None (side-effect) | `./shared.mjs`, `fs`, `path`, `url`, all tools/*.js, all providers/*.js | `scripts/start.sh` |
| `scripts/read-kv.mjs` | Inspect local KV — list keys or read specific value | None (CLI) | `./shared.mjs` | Manual use |
| `scripts/rollback-session.mjs` | Undo last session's KV changes — karma-guided rollback with dry-run and confirmation | None (CLI) | `./shared.mjs`, `readline` | Manual use |
| `scripts/dump-sessions.mjs` | Print all session reflections and tool registry | None (CLI) | `./shared.mjs` | Manual use |
| `scripts/reset-wake-timer.mjs` | Reset wake_config.next_wake_after to the past | None (CLI) | `./shared.mjs` | `scripts/start.sh` |
| `scripts/generate-identity.js` | Generate Ed25519 DID keypair for did:ethr | `generateIdentity` (internal), `kvPayload` (internal) | `ethers`, `./shared.mjs` (optional) | Manual use |
| `scripts/patron-sign.mjs` | Sign a message or rotation request with patron Ed25519 key | None (CLI) | `fs`, `node:crypto`, `path`, `os` | Manual use |
| `scripts/sync-tool-grants.mjs` | Sync kernel:tool_grants from tool source files without full re-seed | None (CLI) | `./shared.mjs`, `path`, `url`, all tools/*.js | Manual use |
| `scripts/dev-serve.mjs` | Zero-cache static file server for dashboard SPA, with /wake proxy | None (side-effect) | `http`, `fs`, `path`, `url` | `scripts/start.sh` |
| `scripts/start.sh` | Start dev environment — kill stale workers, seed/reset, start all 3 services, wait, optionally trigger wake | N/A (bash) | `scripts/seed-local-kv.mjs`, `scripts/reset-wake-timer.mjs`, `scripts/dev-serve.mjs`, `wrangler` | Manual use |

### Prompts

| File | Purpose | KV Key | Used by |
|------|---------|--------|---------|
| `prompts/orient.md` | Orient session system prompt — shapes waking behavior | `prompt:orient` | `hook-main.js` → `runSession()` |
| `prompts/reflect.md` | Session-level reflection prompt (depth 0) | `prompt:reflect` | `hook-reflect.js` → `executeReflect()` |
| `prompts/deep-reflect.md` | Deep reflection prompt (depth 1) — alignment, patterns, structures | `prompt:reflect:1` | `hook-reflect.js` → `runReflect()` |
| `prompts/subplan.md` | Subplan agent system prompt template | `prompt:subplan` | `brainstem.js` → `spawnSubplan()` |
| `DHARMA.md` | Core identity and purpose — immutable | `dharma` | `brainstem.js` → kernel-injected into every LLM call |

### Tests

| File | Purpose | Test count | Imports |
|------|---------|------------|---------|
| `tests/brainstem.test.js` | Kernel logic — KV tiers, tool execution, LLM calls, agent loop, communication gate, inbound gate, patron verification, hook safety | ~104 | `brainstem.js`, `tests/helpers/mock-kv.js` |
| `tests/wake-hook.test.js` | Wake flow, reflect, modifications, circuit breaker, git sync | ~62 | `hook-main.js`, `hook-reflect.js`, `hook-modifications.js`, `hook-protect.js`, `tests/helpers/mock-kernel.js` |
| `tests/tools.test.js` | Tool/provider execute(), module structure, meta field validation | ~100 | All `tools/*.js`, all `providers/*.js` |
| `tests/chat.test.js` | Chat system — conversation flow, budgets, commands, unknown contacts | ~12 | `hook-chat.js`, `tests/helpers/mock-kernel.js` |
| `tests/helpers/mock-kv.js` | In-memory KV store mock (Map-backed) | N/A | `vitest` |
| `tests/helpers/mock-kernel.js` | Full KernelRPC mock with all methods stubbed | N/A | `vitest`, `tests/helpers/mock-kv.js` |

### Config

| File | Purpose |
|------|---------|
| `wrangler.toml` | Production CF Worker config — brainstem.js entry, KV binding, cron trigger (* * * * *), Worker Loader binding |
| `wrangler.dev.toml` | Dev CF Worker config — brainstem-dev.js entry, KV binding, cron trigger |
| `dashboard-api/wrangler.toml` | Dashboard API Worker config — OPERATOR_KEY var, KV binding |
| `package.json` | ES module project — vitest + ethers devDeps, wrangler dep |
| `vitest.config.js` | Vitest config — aliases `cloudflare:workers` to `__mocks__/cloudflare-workers.js` |
| `__mocks__/cloudflare-workers.js` | Stub: exports empty `WorkerEntrypoint` class for test environment |

### Documentation (not inventoried in detail — markdown files)

| Path | Purpose |
|------|---------|
| `docs/dev/architecture.md` | Dev architecture overview |
| `docs/dev/chat-system.md` | Chat system documentation |
| `docs/dev/communication-gating.md` | Communication gate documentation |
| `docs/dev/kv-schema.md` | KV key schema reference |
| `docs/dev/modification-protocol.md` | Modification Protocol documentation |
| `docs/dev/provider-cascade.md` | LLM provider cascade documentation |
| `docs/dev/reflection-system.md` | Reflection system documentation |
| `docs/dev/scripts-reference.md` | Scripts reference |
| `docs/dev/tools-reference.md` | Tools reference |
| `docs/dev/testing.md` | Testing guide |
| `docs/dev/entry-points.md` | Entry points documentation |
| `docs/dev/adding-a-channel.md` | How to add a channel adapter |
| `docs/dev/dashboard.md` | Dashboard documentation |
| `docs/doc-architecture.md` | System architecture (seeded into KV as `doc:architecture`) |
| `docs/doc-modification-guide.md` | Modification Protocol guide (seeded into KV as `doc:modification_guide`) |
| `docs/user/*.md` | End-user documentation (setup, config, security, operations, what-is) |
| `specs/*.md` | Design specs (chunked-content-reader, communication-gating, patron-awareness, wisdom-management) |
| `skills/akash-terminal.md` | Akash terminal skill spec |

---

## 2. Dependency Graph

```mermaid
graph TD
    subgraph Kernel
        BS[brainstem.js]
        BSD[brainstem-dev.js]
    end

    subgraph Hooks
        HM[hook-main.js]
        HR[hook-reflect.js]
        HMod[hook-modifications.js]
        HP[hook-protect.js]
        HC[hook-chat.js]
    end

    subgraph "Channel Adapters"
        CS[channels/slack.js]
    end

    subgraph Tools
        T_KQ[tools/kv_query.js]
        T_KW[tools/kv_write.js]
        T_KM[tools/kv_manifest.js]
        T_SS[tools/send_slack.js]
        T_WF[tools/web_fetch.js]
        T_AE[tools/akash_exec.js]
        T_CE[tools/check_email.js]
        T_SE[tools/send_email.js]
    end

    subgraph Providers
        P_LLM[providers/llm.js]
        P_LB[providers/llm_balance.js]
        P_WB[providers/wallet_balance.js]
        P_GM[providers/gmail.js]
    end

    subgraph Dashboard
        DA[dashboard-api/worker.js]
    end

    subgraph Scripts
        SH[scripts/shared.mjs]
        SEED[scripts/seed-local-kv.mjs]
        RKV[scripts/read-kv.mjs]
        RB[scripts/rollback-session.mjs]
        DS[scripts/dump-sessions.mjs]
        RWT[scripts/reset-wake-timer.mjs]
        GI[scripts/generate-identity.js]
        PS[scripts/patron-sign.mjs]
        STG[scripts/sync-tool-grants.mjs]
        DVS[scripts/dev-serve.mjs]
    end

    subgraph Tests
        TB[tests/brainstem.test.js]
        TW[tests/wake-hook.test.js]
        TT[tests/tools.test.js]
        TC[tests/chat.test.js]
        MK[tests/helpers/mock-kv.js]
        MKR[tests/helpers/mock-kernel.js]
    end

    %% Kernel deps
    BS --> HC
    BSD --> BS
    BSD --> HM
    BSD --> HC
    BSD --> CS
    BSD --> T_KQ & T_KW & T_KM & T_SS & T_WF & T_AE & T_CE & T_SE
    BSD --> P_LB & P_WB & P_GM

    %% Hook dependency chain (no cycles)
    HM --> HP
    HM --> HMod
    HM --> HR
    HR --> HP
    HR --> HMod

    %% Scripts deps
    SEED --> SH
    RKV --> SH
    RB --> SH
    DS --> SH
    RWT --> SH
    STG --> SH

    %% Test deps
    TB --> BS & MK
    TW --> HM & HR & HMod & HP & MKR
    TT --> T_KQ & T_KW & T_KM & T_SS & T_WF & T_AE & T_CE & T_SE & P_LLM & P_LB & P_WB & P_GM
    TC --> HC & MKR
    MKR --> MK
```

---

## 3. Entry Points

### 3.1 Cron Trigger (Scheduled) — Wake Cycle

**Config:** `[triggers] crons = ["* * * * *"]` in both `wrangler.toml` and `wrangler.dev.toml`

The cron fires every minute. The hook checks `wake_config.next_wake_after` and returns early if it's not time yet.

#### Production call chain (`brainstem.js`)

```
CF Cron trigger
  → export default.scheduled(event, env, ctx)
    → new Brainstem(env, {ctx})
    → brain.runScheduled()
      → brain.detectPlatformKill()          // check for stale kernel:active_session
      → brain.checkHookSafety()             // 3-consecutive-failure tripwire
      → brain.kvGet("hook:wake:manifest")   // load module manifest
      → brain.executeHook(modules, mainModule)
        → brain.kvPut("kernel:active_session", sessionId)
        → brain._invokeHookModules(modules, mainModule)
          → [CF Worker Loader isolate]
            → hook-main.js default.fetch()
              → wake(K, input)               // K = env.KERNEL (KernelRPC binding)
                → K.kvGet("wake_config")     // check if time to wake
                → detectCrash(K)             // check stale active_session
                → initTracking(staged, inflight)
                → runCircuitBreaker(K)       // rollback on last_danger
                → retryPendingGitSyncs(K)
                → getBalances(K, state)      // K.checkBalance()
                → highestReflectDepthDue(K, state)
                → evaluateTripwires(config, {balances})
                ─── IF reflectDepth > 0 ───
                → runReflect(K, state, depth, context)  // recursive depth cascade
                  → K.runAgentLoop(...)                 // deep reflect with tools
                  → applyReflectOutput(K, ...)          // KV ops, verdicts, schedule
                  → runReflect(K, state, depth-1, ...)  // recurse down
                ─── ELSE (normal session) ───
                → runSession(K, state, context, config)
                  → K.buildPrompt(orientPrompt, ...)
                  → K.buildToolDefinitions()
                  → K.runAgentLoop(...)                 // orient with tools
                  → applyKVOperation(K, op)             // for each kv_operation
                  → executeReflect(K, state, ...)       // session reflect (depth 0)
                  → writeSessionResults(K, output, config)
        → brain.updateSessionOutcome(outcome)
        → brain.kv.delete("kernel:active_session")
```

#### Dev call chain (`brainstem-dev.js`)

```
CF Cron trigger (or curl /__scheduled)
  → export default.scheduled(event, env, ctx)
    → new DevBrainstem(env, {ctx})
    → brain.runScheduled()                  // inherited from Brainstem
      → brain.executeHook(modules, mainModule)
        → brain._invokeHookModules()        // OVERRIDDEN in DevBrainstem
          → brain.loadEagerConfig()
          → DevBrainstem._buildToolGrants()
          → wake(brain, {sessionId})        // direct call, no isolate
            → (same wake flow as above, but K = brain directly)
            → K methods resolve to DevBrainstem.getSessionId(), etc.
```

#### Key differences prod vs dev:
- **Prod:** Hook runs in CF Worker Loader isolate, K = KernelRPC (RPC bridge)
- **Dev:** Hook called directly, K = DevBrainstem instance (has same methods)
- **Prod:** Tools/providers run in isolates via `runInIsolate()`
- **Dev:** Tools/providers called directly from imported modules

### 3.2 Fetch Handler (HTTP) — Chat Path

**Route:** `POST /channel/:channel`

#### Production call chain (`brainstem.js`)

```
HTTP POST /channel/slack
  → export default.fetch(request, env, ctx)
    → new Brainstem(env, {ctx})
    → brain.kvGet("channel:slack:code")       // load adapter from KV
    → brain.runInIsolate({action: "verify"})   // HMAC verification in isolate
    → brain.runInIsolate({action: "parse"})    // parse inbound message
    → [challenge response if _challenge]
    → [dedup check via dedup:{msgId}]
    → Response("OK", 200)                      // return immediately
    → ctx.waitUntil(async () => {
        → brain.loadEagerConfig()
        → brain.runInIsolate({action: "send"}) // adapter.sendReply
        → handleChat(brain, channel, inbound, adapter)
          → brain.kvGet(convKey)               // load/init conversation
          → [handle commands: /reset, /clear]
          → brain.resolveContact(channel, userId)
          → brain.buildToolDefinitions()       // known contacts get tools
          → brain.callLLM({...})               // tool-calling loop
            → [dharma + yamas/niyamas injected]
            → brain.callWithCascade(request, step)
          → brain.executeToolCall(tc)          // per tool call
            → [communication gate check]
            → brain.executeAction({tool, input})
              → brain._loadTool(name)          // from KV
              → brain._executeTool(...)        // in isolate
            → [inbound content gate]
          → adapter.sendReply(chatId, reply)
          → brain.kvPutSafe(convKey, conv)     // save state
      })
```

#### Dev call chain (`brainstem-dev.js`)

```
HTTP POST /channel/slack
  → export default.fetch(request, env, ctx)
    → new DevBrainstem(env, {ctx})
    → CHANNEL_ADAPTERS[channel]               // direct import, not KV
    → slackAdapter.parseInbound(body)         // direct call, no isolate
    → [skip verification in dev]
    → Response("OK", 200)
    → ctx.waitUntil(async () => {
        → brain.loadEagerConfig()
        → DevBrainstem._buildToolGrants()
        → handleChat(brain, channel, inbound, adapter)
          → (same flow, but tool execution is direct, not isolate)
      })
```

### 3.3 Dashboard API (HTTP)

**Entry:** `dashboard-api/worker.js` on port 8790

```
HTTP request
  → export default.fetch(request, env)
    → [CORS preflight → 204]
    → [GET /reflections → public, no auth — reads reflect:1:* keys]
    → [auth check via X-Operator-Key header]
    → GET /health        → session_counter, wake_config, last_reflect, active_session
    → GET /sessions      → karma:* keys, reflect:1:* keys, cache:session_ids
    → GET /kv            → kvListAll with optional ?prefix
    → GET /kv/multi      → batch read by ?keys=k1,k2,k3
    → GET /kv/:key       → single key read
    → GET /quarantine    → sealed:quarantine:* keys
    → POST /contacts     → create contact record + index entries
    → DELETE /quarantine/:key → delete quarantine entry
```

### 3.4 Dashboard SPA (HTTP)

**Entry:** `scripts/dev-serve.mjs` on port 3001

```
HTTP request
  → POST /wake          → proxied to http://localhost:8787/__scheduled
  → GET /*              → static file from site/ directory (no-cache)
```

### 3.5 Test-Scheduled Endpoint (Dev Only)

**Route:** `GET /__scheduled` (enabled by `--test-scheduled` wrangler flag)

Triggers the `scheduled()` handler manually — same as a cron trigger. This is the primary way to trigger a wake cycle during development.

### 3.6 Summary of All Triggers

| Trigger | Route/Mechanism | Handler | Code Path |
|---------|----------------|---------|-----------|
| Cron (every minute) | CF `scheduled` event | `brainstem.js` or `brainstem-dev.js` `scheduled()` | Wake cycle |
| HTTP webhook | `POST /channel/:channel` | `brainstem.js` or `brainstem-dev.js` `fetch()` | Chat path |
| Manual wake | `GET /__scheduled` (dev) | Same as cron | Wake cycle |
| Dashboard API | Various HTTP routes | `dashboard-api/worker.js` `fetch()` | KV reads, contact management |
| Dashboard SPA | Static + `/wake` proxy | `scripts/dev-serve.mjs` | Static files, wake proxy |
