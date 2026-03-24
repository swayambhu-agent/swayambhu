# KV Schema, Tool Inventory & Provider Cascade

Generated 2026-03-17. Covers every KV key, tool, and provider in the codebase.

---

## 1. KV Schema

### 1.1 Identity

| Key | Stored type | Written by | Read by | Seeded | Protection |
|-----|-------------|------------|---------|--------|------------|
| `identity:did` | JSON `{ did, address, chain_id, chain_name, registry, ... }` | `scripts/seed-local-kv.mjs`, `scripts/generate-identity.js` | Agent via `kv_query` tool only — no runtime code reads this directly | Yes | System (`config:` would apply if prefix-matched, but this key is prefix `identity:` which is NOT in SYSTEM_KEY_PREFIXES — it is a regular key) |
| `dharma` | Text (markdown) | `scripts/seed-local-kv.mjs` | `kernel.js:loadEagerConfig()` → injected into every LLM call via `callLLM()` | Yes | Immutable — `kvWrite()`, `kvWriteSafe()`, and `kvWriteGated()` all reject writes to `"dharma"` |

### 1.2 Config

| Key | Stored type | Written by | Read by | Seeded | Protection |
|-----|-------------|------------|---------|--------|------------|
| `config:defaults` | JSON (models, budgets, effort levels, execution limits) | `seed-local-kv.mjs`; agent via `kvWriteGated` | `kernel.js:loadEagerConfig()`, `act.js:wake()`, `reflect.js`, `hook-chat.js:handleChat()` | Yes | System (prefix `config:`) — requires `kvWriteGated` |
| `config:models` | JSON (model list, pricing, alias_map, fallback_model) | `seed-local-kv.mjs`; agent via `kvWriteGated` | `kernel.js:loadEagerConfig()`, `act.js:wake()` | Yes | System |
| `config:model_capabilities` | JSON (yama_capable, niyama_capable, comms_gate_capable flags per model) | `seed-local-kv.mjs`; agent via `kvWriteGated` (requires deliberation ≥200 chars + yama_capable model) | `kernel.js:loadEagerConfig()`, `isYamaCapable()`, `isNiyamaCapable()`, `isCommsGateCapable()` | Yes | System + extra gate (deliberation + model capability check) |
| `config:resources` | JSON (KV limits, worker limits, OpenRouter/wallet/Slack endpoints) | `seed-local-kv.mjs` | `act.js:runSession()` | Yes | System |
| `config:tool_registry` | JSON (tool definitions for function calling) | `seed-local-kv.mjs`; agent via `kvWriteGated` | `kernel.js:loadEagerConfig()`, `buildToolDefinitions()` | Yes | System |
| `providers` | JSON (registered LLM providers with adapter bindings) | `seed-local-kv.mjs` | `kernel.js:checkBalance()` | Yes | System (exact match in `SYSTEM_KEY_EXACT`) |
| `wallets` | JSON (registered crypto wallets with adapter bindings) | `seed-local-kv.mjs` | `kernel.js:checkBalance()` | Yes | System (exact match in `SYSTEM_KEY_EXACT`) |

### 1.3 Tools

| Key pattern | Stored type | Written by | Read by | Seeded | Protection |
|-------------|-------------|------------|---------|--------|------------|
| `tool:{name}:code` | Text (JS source) | `seed-local-kv.mjs` | `kernel.js:_loadTool()`, `callHook()` | Yes (9 tools) | System (prefix `tool:`) |
| `tool:{name}:meta` | JSON (kv_access, timeout_ms — security fields stripped) | `seed-local-kv.mjs` | `kernel.js:_loadTool()`, `callHook()` | Yes (9 tools) | System |

Seeded tool names: `send_slack`, `web_fetch`, `kv_write`, `kv_manifest`, `kv_query`, `computer`, `check_email`, `send_email`, `test_model`.

### 1.4 Providers

| Key pattern | Stored type | Written by | Read by | Seeded | Protection |
|-------------|-------------|------------|---------|--------|------------|
| `provider:{name}:code` | Text (JS source) | `seed-local-kv.mjs` | `kernel.js:callViaAdapter()`, `executeAdapter()`, `_executeTool()` (for provider-bound tools) | Yes (4 providers) | System (prefix `provider:`) |
| `provider:{name}:meta` | JSON (secrets, timeout_ms) | `seed-local-kv.mjs` | `kernel.js:callViaAdapter()`, `executeAdapter()` | Yes (4 providers) | System |
| `provider:llm:last_working:code` | Text (JS source) | `kernel.js:callWithCascade()` (on success, snapshots dynamic adapter) | `kernel.js:callWithCascade()` (tier 2 fallback) | No | System |
| `provider:llm:last_working:meta` | JSON | `kernel.js:callWithCascade()` | `kernel.js:callWithCascade()` | No | System |

Seeded provider names: `llm`, `llm_balance`, `wallet_balance`, `gmail`.

### 1.5 Kernel-internal

| Key | Stored type | Written by | Read by | Seeded | Protection |
|-----|-------------|------------|---------|--------|------------|
| `kernel:tool_grants` | JSON (per-tool security grants: secrets, communication, inbound, provider) | `seed-local-kv.mjs`, `scripts/sync-tool-grants.mjs` | `kernel.js:loadEagerConfig()`, `executeToolCall()`, `executeAction()`, `_executeTool()` | Yes | Kernel-only (prefix `kernel:`) — agent cannot read or write via RPC |
| `kernel:alert_config` | JSON (Slack alert template) | `seed-local-kv.mjs` | `kernel.js:sendKernelAlert()` | Yes | Kernel-only |
| `kernel:llm_fallback` | Text (JS source — copy of providers/llm.js) | `seed-local-kv.mjs` | `kernel.js:callViaKernelFallback()` | Yes | Kernel-only |
| `kernel:llm_fallback:meta` | JSON (provider metadata) | `seed-local-kv.mjs` | `kernel.js:callViaKernelFallback()` | Yes | Kernel-only |
| `kernel:fallback_model` | JSON string (`"anthropic/claude-haiku-4.5"`) | `seed-local-kv.mjs` | `kernel.js:getFallbackModel()` | Yes | Kernel-only |
| `kernel:active_session` | Text (session ID) | `kernel.js:executeHook()` (write), `kernel.js:executeHook()` (delete) | `kernel.js:detectPlatformKill()`, `act.js:detectCrash()`, `dashboard-api:GET /health` | No | Kernel-only |
| `kernel:last_sessions` | JSON (array of last 5 sessions with outcome + timestamp) | `kernel.js:detectPlatformKill()`, `updateSessionOutcome()` | `kernel.js:checkHookSafety()` | No | Kernel-only |
| `kernel:last_good_hook` | JSON `{ manifest, modules }` or `{ code }` | `kernel.js:updateSessionOutcome()` (on clean outcome) | `kernel.js:checkHookSafety()` (for auto-restore after tripwire) | No | Kernel-only |
| `kernel:hook_dirty` | JSON boolean | `kernel.js:kvWriteGated()` (on any `hook:` write) | `kernel.js:updateSessionOutcome()` | No | Kernel-only |

### 1.6 Prompts

| Key | Stored type | Written by | Read by | Seeded | Protection |
|-----|-------------|------------|---------|--------|------------|
| `prompt:orient` | Text (markdown) | `seed-local-kv.mjs` | `act.js:runSession()`, `reflect.js:gatherReflectContext()` (passed as template var to deep reflect) | Yes | System (prefix `prompt:`) |
| `prompt:reflect` | Text (markdown) | `seed-local-kv.mjs` | `reflect.js:executeReflect()` | Yes | System |
| `prompt:reflect:1` | Text (markdown — deep reflect prompt for depth 1) | `seed-local-kv.mjs` | `reflect.js:loadReflectPrompt()`, `loadBelowPrompt()` | Yes | System |
| `prompt:reflect:{depth}` | Text (markdown — deep reflect prompt for depth N) | Agent via `kvWriteGated` | `reflect.js:loadReflectPrompt()`, `loadBelowPrompt()` | Only depth 1 | System |
| `prompt:subplan` | Text (markdown) | `seed-local-kv.mjs` | `kernel.js:spawnSubplan()` | Yes | System |
| `prompt:chat` | Text | `seed-local-kv.mjs` | `hook-chat.js:handleChat()` | Yes | System |

### 1.7 Hook Modules (Wake Cycle)

| Key | Stored type | Written by | Read by | Seeded | Protection |
|-----|-------------|------------|---------|--------|------------|
| `hook:wake:manifest` | JSON (filename → KV key mapping) | `seed-local-kv.mjs` | `kernel.js:runScheduled()`, `checkHookSafety()`, `updateSessionOutcome()` | Yes | System (prefix `hook:`) |
| `hook:wake:code` | Text (JS — act.js source) | `seed-local-kv.mjs` | Via manifest; `kernel.js:runScheduled()` (fallback if no manifest) | Yes | System |
| `hook:wake:reflect` | Text (JS — reflect.js source) | `seed-local-kv.mjs` | Via manifest | Yes | System |
| `hook:wake:proposals` | Text (JS — kernel.js (proposal methods) source) | `seed-local-kv.mjs` | Via manifest | Yes | System |
| `hook:wake:protect` | Text (JS — KV operation gating, now merged into kernel.js) | `seed-local-kv.mjs` | Via manifest | Deprecated | System |

### 1.8 Channel Adapters

| Key | Stored type | Written by | Read by | Seeded | Protection |
|-----|-------------|------------|---------|--------|------------|
| `channel:slack:code` | Text (JS — channels/slack.js source) | `seed-local-kv.mjs` | `kernel.js:fetch()` handler (prod — loads adapter from KV) | Yes | System (prefix treated as code, git-syncable) |
| `channel:slack:config` | JSON (secrets list, webhook_secret_env) | `seed-local-kv.mjs` | `kernel.js:fetch()` handler | Yes | System |

### 1.9 Contacts & Patron

| Key pattern | Stored type | Written by | Read by | Seeded | Protection |
|-------------|-------------|------------|---------|--------|------------|
| `contact:{slug}` | JSON (name, relationship, platforms, chat config, etc.) | `seed-local-kv.mjs` (swami_kevala), `dashboard-api:POST /contacts` | `kernel.js:resolveContact()`, `loadPatronContext()`, `communicationGate()` | Yes (1 contact) | System (prefix `contact:`) + patron-only via `kvWriteGated` (rejects contact: writes) |
| `contact_platform:{platform}:{userId}` | JSON `{ slug, approved }` | Dashboard API (`PATCH /contact-platform/:platform/:id/approve`), `kernel.js:resolveContact()` (cache miss) | `kernel.js:resolveContact()` | No (auto-created) | System (prefix `contact_platform:`) + patron-only |
| `patron:contact` | Text (contact slug) | `seed-local-kv.mjs` | `kernel.js:loadPatronContext()` | Yes | System (exact match in `SYSTEM_KEY_EXACT`) |
| `patron:public_key` | Text (SSH Ed25519 public key) | `seed-local-kv.mjs`; `kernel.js:rotatePatronKey()` (bypasses kvWrite guard via direct kv.put) | `kernel.js:verifyPatronSignature()` | Yes | Immutable (`IMMUTABLE_KEYS`) — only rotatePatronKey can write (direct KV binding, requires Ed25519 sig) |
| `patron:identity_snapshot` | JSON `{ name, platforms, verified_at }` | `kernel.js:loadPatronContext()` (first boot) | `kernel.js:loadPatronContext()` | No (auto-created on first boot) | System (exact match in `SYSTEM_KEY_EXACT`) |

### 1.10 Yamas & Niyamas (Operating Principles)

| Key pattern | Stored type | Written by | Read by | Seeded | Protection |
|-------------|-------------|------------|---------|--------|------------|
| `yama:{name}` | Text (principle text) | `seed-local-kv.mjs` (7 keys); agent via `kvWriteGated` | `kernel.js:loadYamasNiyamas()` → injected into every LLM call | Yes (7) | System (prefix `yama:`) + deliberation gate (min 200 chars) + yama_capable model required |
| `yama:{name}:audit` | JSON array of audit entries | `kernel.js:kvWriteGated()` (auto-created on yama write) | `kernel.js:kvWriteGated()` (appends) | No | System |
| `niyama:{name}` | Text (principle text) | `seed-local-kv.mjs` (7 keys); agent via `kvWriteGated` | `kernel.js:loadYamasNiyamas()` → injected into every LLM call | Yes (7) | System (prefix `niyama:`) + deliberation gate (min 100 chars) + niyama_capable model required |
| `niyama:{name}:audit` | JSON array of audit entries | `kernel.js:kvWriteGated()` (auto-created on niyama write) | `kernel.js:kvWriteGated()` (appends) | No | System |

Seeded yamas: `care`, `truth`, `responsibility`, `discipline`, `rules`, `security`, `humility`.
Seeded niyamas: `health`, `acceptance`, `transformation`, `reflection`, `alignment`, `nonidentification`, `organization`.

### 1.11 Session & Runtime State

| Key pattern | Stored type | Written by | Read by | Seeded | Protection |
|-------------|-------------|------------|---------|--------|------------|
| `wake_config` | JSON `{ next_wake_after, sleep_seconds, effort, ... }` | `act.js:writeSessionResults()`, `reflect.js:executeReflect()`, `applyReflectOutput()` | `act.js:wake()`, `dashboard-api:GET /health` | No | Regular (kvWriteSafe) |
| `session_counter` | JSON number | `act.js:writeSessionResults()`, `kernel.js:runMinimalFallback()` | `kernel.js:getSessionCount()`, `dashboard-api:GET /health` | No | Regular |
| `cache:session_ids` | JSON array of session ID strings | `act.js:writeSessionResults()` | `reflect.js:gatherReflectContext()`, `dashboard-api:GET /sessions` | No | Regular |
| `karma:{sessionId}` | JSON array of karma entries | `kernel.js:karmaRecord()` (appended every event) | `act.js:detectCrash()`, `reflect.js:executeReflect()` (session karma), `dashboard-api` | No | Regular (prefix `karma:` is not in SYSTEM_KEY_PREFIXES) |
| `last_reflect` | JSON (reflection output + session_id) | `reflect.js:executeReflect()` (depth 0), `applyReflectOutput()` (depth 1) | `act.js:wake()` (loads for orient context), `dashboard-api:GET /health` | No | Regular |
| `last_danger` | JSON `{ t, event, session_id }` | `kernel.js:karmaRecord()` (on DANGER_SIGNALS: fatal_error, orient_parse_error, all_providers_failed) | `kernel.js (proposal methods):runCircuitBreaker()` (read + delete) | No | Regular |

### 1.12 Reflect Output & Scheduling

| Key pattern | Stored type | Written by | Read by | Seeded | Protection |
|-------------|-------------|------------|---------|--------|------------|
| `reflect:{depth}:{sessionId}` | JSON `{ reflection, note_to_future_self, depth, session_id, timestamp }` | `reflect.js:executeReflect()` (depth 0), `applyReflectOutput()` (depth 1+) | `reflect.js:loadReflectHistory()`, `dashboard-api:GET /reflections`, `GET /sessions` | No | System (prefix `reflect:` — though it's not listed in SYSTEM_KEY_PREFIXES; metadata type is `reflect_output`) |
| `reflect:schedule:{depth}` | JSON `{ after_sessions, after_days, last_reflect, last_reflect_session, ... }` | `reflect.js:applyReflectOutput()` | `reflect.js:isReflectDue()` | No | See above |

**Note:** The `reflect:` prefix is NOT in `SYSTEM_KEY_PREFIXES`. These keys are written via `kvWriteSafe` (not `kvWriteGated`), so they're regular keys.

### 1.13 Proposal Protocol

| Key pattern | Stored type | Written by | Read by | Seeded | Protection |
|-------------|-------------|------------|---------|--------|------------|
| `proposal:{id}` | JSON (proposal request: id, type, claims, ops, checks, validation, staged metadata) | `kernel.js (proposal methods):stageModification()`, `processReflectVerdicts()` ("modify"), `processDeepReflectVerdicts()` ("modify") | `kernel.js (proposal methods):loadStagedModifications()`, `acceptStaged()`, verdict processing | No | System (prefix `proposal:`) — written via `kvWriteGated` |
| `proposal:{id}` | JSON (activated proposal: full record + snapshots of original values) | `kernel.js (proposal methods):acceptStaged()`, `acceptDirect()` | `kernel.js (proposal methods):loadInflightModifications()`, `rollbackInflight()`, `findInflightConflict()`, `promoteInflight()`, `runCircuitBreaker()` | No | System (prefix `proposal:`) — written via `kvWriteGated` |

### 1.14 Git Sync

| Key pattern | Stored type | Written by | Read by | Seeded | Protection |
|-------------|-------------|------------|---------|--------|------------|
| `git_pending:{proposalId}` | JSON `{ proposal_id, writes, deletes, message, created_at }` | `kernel.js (proposal methods):syncToGit()` | `kernel.js (proposal methods):attemptGitSync()`, `retryPendingGitSyncs()` | No | System (prefix `git_pending:`) — written via `kvWriteGated` |

### 1.15 Chat

| Key pattern | Stored type | Written by | Read by | Seeded | Protection |
|-------------|-------------|------------|---------|--------|------------|
| `chat:state:{channel}:{chatId}` | JSON `{ messages, total_cost, created_at, turn_count, last_activity }` | `hook-chat.js:handleChat()` | `hook-chat.js:handleChat()` (same function) | No | Regular (kvWriteSafe) |

### 1.16 Dedup

| Key pattern | Stored type | Written by | Read by | Seeded | Protection |
|-------------|-------------|------------|---------|--------|------------|
| `dedup:{msgId}` | Text `"1"` (TTL: 30s) | `kernel.js:fetch()`, `index.js:fetch()` | Same (dedup check) | No | Regular (direct kv.put with expirationTtl) |

### 1.17 Docs (Agent-Readable Reference)

| Key | Stored type | Written by | Read by | Seeded | Protection |
|-----|-------------|------------|---------|--------|------------|
| `doc:proposal_guide` | Text (markdown) | `seed-local-kv.mjs` | Agent via `kv_query` tool | Yes | System (prefix `doc:`) |
| `doc:architecture` | Text (markdown) | `seed-local-kv.mjs` | Agent via `kv_query` tool | Yes | System |

### 1.18 Wisdom (Communication)

| Key pattern | Stored type | Written by | Read by | Seeded | Protection |
|-------------|-------------|------------|---------|--------|------------|
| `upaya:comms:defaults` | JSON `{ text, type, created, sources }` | `seed-local-kv.mjs` | `kernel.js:loadCommsUpaya()` (prefix scan `upaya:comms:`) | Yes | System (prefix `upaya:`) |
| `upaya:comms:{topic}` | JSON | Agent via `kvWriteGated` | `kernel.js:loadCommsUpaya()` | No | System |
| `upaya:channel:{name}` | JSON | Agent via `kvWriteGated` | `kernel.js:loadCommsUpaya()` (prefix scan `upaya:channel:`) | No | System |
| `prajna:*` | JSON | Agent via `kvWriteGated` | None (prefix reserved in SYSTEM_KEY_PREFIXES and kvWrite metadata defaults, but no runtime code reads it) | No | System (prefix `prajna:`) |

### 1.19 Tool Data (Scoped Tool Storage)

| Key pattern | Stored type | Written by | Read by | Seeded | Protection |
|-------------|-------------|------------|---------|--------|------------|
| `tooldata:{toolName}:{key}` | Text or JSON | `ScopedKV.put()` (tools with `kv_access: "own"`) | `ScopedKV.get()` | No | Regular (written via direct KV binding through ScopedKV) |

### 1.20 Sealed (Kernel-Only, Agent-Unreadable)

| Key pattern | Stored type | Written by | Read by | Seeded | Protection |
|-------------|-------------|------------|---------|--------|------------|
| `sealed:quarantine:{channel}:{senderId}:{ts}` | JSON `{ sender, content, tool, timestamp, subject?, from? }` | `kernel.js:executeToolCall()` (inbound content gate — redacts content from unknown senders) | `dashboard-api:GET /quarantine` (patron-only); agent reads blocked by `ScopedKV`, `KernelRPC.kvGet()`, and `kv.list()` filter | No | Kernel-only (prefix `sealed:`) — all read paths return null for `sealed:` prefix |

### 1.21 Communication Blocked Queue

| Key pattern | Stored type | Written by | Read by | Seeded | Protection |
|-------------|-------------|------------|---------|--------|------------|
| `comms_blocked:{id}` | JSON (blocked message record: tool, args, channel, recipient, mode, reason, gate verdict, session info) | `kernel.js:queueBlockedComm()` | `kernel.js:listBlockedComms()`, `processCommsVerdict()` | No | System (prefix `comms_blocked:`) |

### 1.22 Secrets (Agent-Provisioned)

| Key pattern | Stored type | Written by | Read by | Seeded | Protection |
|-------------|-------------|------------|---------|--------|------------|
| `secret:{name}` | JSON | Agent via `kvWriteGated` (or patron); also `kv:secret:{name}` references from provider config | `kernel.js:buildToolContext()` (for tools with `kv_secrets` in meta), `runAdapter()` | No | System (prefix `secret:`) |

---

## 1.23 Seed Inventory & Orphan Check

Total keys seeded by `seed-local-kv.mjs`: **~60** (exact count depends on tool/provider files).

### Seeded keys and their runtime readers

| Seeded key | Read at runtime? | Notes |
|------------|-----------------|-------|
| `identity:did` | **No direct reader** | Available via `kv_query` tool. No source code reads this key. Informational — agent can query it. |
| `dharma` | Yes | `kernel.js:loadEagerConfig()` → injected in every LLM call |
| `config:defaults` | Yes | Multiple readers |
| `config:models` | Yes | Multiple readers |
| `config:model_capabilities` | Yes | `kernel.js:loadEagerConfig()` |
| `config:resources` | Yes | `act.js:runSession()` |
| `config:tool_registry` | Yes | `kernel.js:loadEagerConfig()`, `buildToolDefinitions()` |
| `providers` | Yes | `kernel.js:checkBalance()` |
| `wallets` | Yes | `kernel.js:checkBalance()` |
| `tool:{name}:code` (×8) | Yes | `kernel.js:_loadTool()` |
| `tool:{name}:meta` (×8) | Yes | `kernel.js:_loadTool()` |
| `provider:{name}:code` (×4) | Yes | `kernel.js:callViaAdapter()`, `executeAdapter()` |
| `provider:{name}:meta` (×4) | Yes | `kernel.js:callViaAdapter()`, `executeAdapter()` |
| `prompt:orient` | Yes | `act.js:runSession()` |
| `prompt:subplan` | Yes | `kernel.js:spawnSubplan()` |
| `prompt:reflect` | Yes | `reflect.js:executeReflect()` |
| `prompt:reflect:1` | Yes | `reflect.js:loadReflectPrompt()` |
| `prompt:chat` | Yes | `hook-chat.js:handleChat()` |
| `hook:wake:code` | Yes | Via manifest or direct |
| `hook:wake:reflect` | Yes | Via manifest |
| `hook:wake:proposals` | Yes | Via manifest |
| `hook:wake:protect` | Yes | Via manifest |
| `hook:wake:manifest` | Yes | `kernel.js:runScheduled()` |
| `channel:slack:code` | Yes | `kernel.js:fetch()` (prod path) |
| `channel:slack:config` | Yes | `kernel.js:fetch()` (prod path) |
| `kernel:tool_grants` | Yes | `kernel.js:loadEagerConfig()` |
| `kernel:alert_config` | Yes | `kernel.js:sendKernelAlert()` |
| `kernel:llm_fallback` | Yes | `kernel.js:callViaKernelFallback()` |
| `kernel:llm_fallback:meta` | Yes | `kernel.js:callViaKernelFallback()` |
| `kernel:fallback_model` | Yes | `kernel.js:getFallbackModel()` |
| `yama:*` (×7) | Yes | `kernel.js:loadYamasNiyamas()` |
| `niyama:*` (×7) | Yes | `kernel.js:loadYamasNiyamas()` |
| `contact:swami_kevala` | Yes | `kernel.js:resolveContact()`, `loadPatronContext()` |
| `patron:contact` | Yes | `kernel.js:loadPatronContext()` |
| `patron:public_key` | Yes | `kernel.js:verifyPatronSignature()` |
| `upaya:comms:defaults` | Yes | `kernel.js:loadCommsUpaya()` |
| `doc:proposal_guide` | **No direct reader** | Available via `kv_query` tool |
| `doc:architecture` | **No direct reader** | Available via `kv_query` tool |

### Orphaned seeds

Keys seeded but with no code-level reader (only accessible via `kv_query` tool):

1. **`identity:did`** — DID identity document. No runtime code reads this. Agent can query it.
2. **`doc:proposal_guide`** — Reference doc. No runtime code reads this. Agent can query it.
3. **`doc:architecture`** — Reference doc. No runtime code reads this. Agent can query it.

These are intentionally available for the agent to read via tools — they are not truly orphaned, just agent-facing reference data rather than code-consumed keys.

### Reserved prefixes (in SYSTEM_KEY_PREFIXES but no seeded keys)

- `prajna:` — Wisdom prefix. In `SYSTEM_KEY_PREFIXES` and `kvWrite` metadata defaults, but no code reads these keys and nothing is seeded. Reserved for future use.
- `secret:` — Agent-provisioned secrets. In `SYSTEM_KEY_PREFIXES`, read by `buildToolContext()` and `runAdapter()`, but nothing is seeded. Created at runtime if needed.

---

## 2. Tool Inventory

### 2.1 Dynamic Tools (from `tools/*.js`, loaded from KV)

| Tool | File | What it does | `kv_access` | Secrets (from `kernel:tool_grants`) | Gates | Provider | Sessions |
|------|------|-------------|-------------|-------------------------------------|-------|----------|----------|
| `kv_query` | `tools/kv_query.js` | Read a KV value with optional dot-bracket path navigation. Returns small values directly, summarizes large structures. | `read_all` | None | None | None | Wake, reflect, chat |
| `kv_write` | `tools/kv_write.js` | Write to tool's own scoped KV namespace (`tooldata:{toolName}:{key}`). | `own` | None | None | None | Wake, reflect, chat |
| `kv_manifest` | `tools/kv_manifest.js` | List KV keys with optional prefix filter (max 500). | `read_all` | None | None | None | Wake, reflect, chat |
| `send_slack` | `tools/send_slack.js` | Post a message to Slack via API. | `none` | `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID` | **Communication gate** (`channel: "slack"`, `recipient_type: "destination"`) | None | Wake, chat |
| `web_fetch` | `tools/web_fetch.js` | Fetch URL contents (GET or POST). Returns status + body (truncated to `max_length`). | `none` | None | None | None | Wake, reflect, chat |
| `computer` | `tools/computer.js` | Run a shell command on your Linux server. | `none` | `COMPUTER_CF_CLIENT_ID`, `COMPUTER_API_KEY` | None | None | Wake, reflect, chat |
| `check_email` | `tools/check_email.js` | Fetch unread emails from Gmail inbox. | `none` | `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` | **Inbound gate** (`channel: "email"`, redacts unknown senders, quarantines under `sealed:`) | `gmail` | Wake, chat |
| `send_email` | `tools/send_email.js` | Send email or reply via Gmail. | `none` | `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` | **Communication gate** (`channel: "email"`, `recipient_type: "person"`) | `gmail` | Wake, chat |

### 2.2 Built-in Tools (hardcoded in `kernel.js:buildToolDefinitions()`)

| Tool | What it does | Sessions |
|------|-------------|----------|
| `spawn_subplan` | Spawn a nested agent loop to handle an independent sub-task. Multiple calls execute in parallel. Respects `max_subplan_depth` (default 3). | Wake (excluded from reflect by `reflect.js` filter) |
| `verify_patron` | Verify the patron's identity by checking an Ed25519 signature against `patron:public_key`. | Wake, reflect, chat |
| `check_balance` | Check balances across all configured providers and wallets. Returns balances grouped by scope. | Wake, reflect, chat |

### 2.3 Tool Session Availability

All dynamic tools are available in all sessions by default — the tool registry (`config:tool_registry`) is loaded at boot and tools are offered to every `runAgentLoop()` / `callLLM()` call. The only exception:

- **Deep reflect (depth ≥1):** `reflect.js:runReflect()` explicitly filters out `spawn_subplan` from the tool list (`allTools.filter(t => t.function.name !== 'spawn_subplan')`).
- **Session reflect (depth 0):** `reflect.js:executeReflect()` passes `tools: []` — no tools at all.
- **Chat (unknown contacts):** `hook-chat.js:handleChat()` gives unknown contacts either no tools or only tools in `chatConfig.unknown_contact_tools` allowlist (default `[]`).

### 2.4 Communication Gate Summary

Two tools are gated by the kernel's communication gate (`kernel.js:communicationGate()`):

| Tool | Channel | Recipient type | Gate behavior |
|------|---------|---------------|---------------|
| `send_slack` | slack | destination | Mechanical floor skipped (destination, not person). LLM gate runs if model is `comms_gate_capable`. Queued if model not capable. |
| `send_email` | email | person | Mechanical floor blocks initiation to unknown recipients. LLM gate runs. Queued if model not capable. |

### 2.5 Inbound Content Gate Summary

One tool has an inbound content gate:

| Tool | Channel | Behavior |
|------|---------|----------|
| `check_email` | email | After execution, kernel scans returned emails. For each email where `sender_email` doesn't resolve to a known contact: content is replaced with `[content redacted — unknown sender]`, full content is quarantined at `sealed:quarantine:email:{sender}:{ts}`. |

---

## 3. Provider Cascade

### 3.1 Overview

The LLM provider cascade is a three-tier fallback mechanism for making LLM calls. It ensures the system can always make LLM calls even if the primary provider adapter is corrupted or broken.

**Implementation:** `kernel.js:callWithCascade()` (lines 1588–1634).

### 3.2 Tiers

| Tier | Name | KV keys | How populated | What happens on failure |
|------|------|---------|---------------|------------------------|
| 1 | **Dynamic** | `provider:llm:code`, `provider:llm:meta` | Seeded by `seed-local-kv.mjs`. Agent can modify via Proposal Protocol (`kvWriteGated`). | Falls through to Tier 2. Logs `provider_fallback` karma event. |
| 2 | **Last working** | `provider:llm:last_working:code`, `provider:llm:last_working:meta` | Auto-snapshotted by kernel on first successful Tier 1 call per session (`callWithCascade()`, lines 1593–1603). | Falls through to Tier 3. Logs `provider_fallback` karma event. |
| 3 | **Kernel fallback** | `kernel:llm_fallback`, `kernel:llm_fallback:meta` | Seeded by `seed-local-kv.mjs` (identical to `provider:llm:code` at seed time). Stored under `kernel:` prefix — agent cannot modify. | Returns `{ ok: false }`. Caller records `all_providers_failed` DANGER_SIGNAL. |

### 3.3 Cascade flow

```
callWithCascade(request, step)
  │
  ├── Tier 1: callViaAdapter("llm", request)
  │     ├── Reads provider:llm:code + provider:llm:meta from KV
  │     ├── Runs in isolate (prod) or direct call (dev)
  │     ├── On success:
  │     │     ├── Snapshots provider:llm:code → provider:llm:last_working:code (once per session)
  │     │     └── Returns { ok: true, tier: "dynamic" }
  │     └── On failure: logs provider_fallback, falls through
  │
  ├── Tier 2: callViaAdapter("llm:last_working", request)
  │     ├── Reads provider:llm:last_working:code + meta from KV
  │     ├── On success: returns { ok: true, tier: "last_working" }
  │     └── On failure: logs provider_fallback, falls through
  │
  └── Tier 3: callViaKernelFallback(request)
        ├── Reads kernel:llm_fallback + kernel:llm_fallback:meta from KV
        ├── On success: returns { ok: true, tier: "kernel_fallback" }
        └── On failure: returns { ok: false, tier: "all_failed" }
```

### 3.4 Model fallback (separate from provider cascade)

After the provider cascade fails (all 3 tiers), `callLLM()` (line 1554) attempts a **model fallback**: if the requested model differs from `getFallbackModel()` (defaults to `anthropic/claude-haiku-4.5`), it re-enters `callLLM()` with the fallback model. This re-runs the full 3-tier cascade with a different model.

```
callLLM(model=opus, ...)
  → callWithCascade() → all 3 tiers fail
  → getFallbackModel() → "anthropic/claude-haiku-4.5"
  → callLLM(model=haiku, ...) → callWithCascade() again
```

### 3.5 Dev mode override

In `index.js`, `callWithCascade()` is overridden to make a direct `fetch()` call to OpenRouter, bypassing the entire cascade. There is no tier system in dev — all calls go directly to `https://openrouter.ai/api/v1/chat/completions`.

### 3.6 Key protection boundaries

| KV key | Who can modify | Protection mechanism |
|--------|---------------|---------------------|
| `provider:llm:code` | Agent (via Proposal Protocol + `kvWriteGated`) | System key prefix `provider:` — requires privileged write |
| `provider:llm:last_working:code` | Kernel only (auto-snapshot) | System key prefix `provider:` — written by kernel's `kvWrite()` directly |
| `kernel:llm_fallback` | Patron only (seed script or manual) | Kernel-only prefix `kernel:` — `kvWriteGated` rejects kernel: writes |

This means:
- The agent **can** modify Tier 1 (dynamic adapter) — this is how it evolves its own provider code.
- The agent **cannot** modify Tier 2 (auto-snapshotted by kernel) or Tier 3 (kernel-only).
- If the agent breaks Tier 1, Tier 2 serves as automatic recovery. If both are broken, Tier 3 (human-managed) is the last resort.
