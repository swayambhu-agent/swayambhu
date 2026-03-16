# Swayambhu — KV Schema, Tool Inventory & Provider Cascade

Generated: 2026-03-16

---

## 1. KV Schema

### 1.1 System Key Protection Levels

The kernel enforces four protection tiers via static constants on `Brainstem` (brainstem.js:276–291):

| Tier | Constant | Protection |
|------|----------|------------|
| System prefix | `SYSTEM_KEY_PREFIXES` | Requires `kvWritePrivileged()` — hook code cannot use `kvPutSafe()` |
| Kernel-only prefix | `KERNEL_ONLY_PREFIXES` | Cannot be written by tools (ScopedKV blocks); sealed: also unreadable by tools |
| System exact | `SYSTEM_KEY_EXACT` | Same rules as system prefix, matched by exact key name |
| Immutable | `IMMUTABLE_KEYS` | Cannot be changed even via `kvWritePrivileged()` |

**SYSTEM_KEY_PREFIXES:** `prompt:`, `config:`, `tool:`, `provider:`, `secret:`, `modification_staged:`, `modification_snapshot:`, `hook:`, `doc:`, `git_pending:`, `yama:`, `niyama:`, `viveka:`, `prajna:`, `comms_blocked:`, `contact:`, `contact_index:`, `sealed:`

**KERNEL_ONLY_PREFIXES:** `kernel:`, `sealed:`

**SYSTEM_KEY_EXACT:** `providers`, `wallets`, `patron:contact`, `patron:identity_snapshot`

**IMMUTABLE_KEYS:** `patron:public_key`

### 1.2 Complete Key Reference

#### Identity & Patron

| Key | Read | Write | Description | Protection | Seeded |
|-----|------|-------|-------------|------------|--------|
| `identity:did` | — | seed | DID, address, chain, registry, dharma_hash | none | yes |
| `patron:contact` | brainstem.js:`loadPatronContext()` | seed | Pointer to patron contact slug (e.g. "swami_kevala") | system exact | yes |
| `patron:public_key` | brainstem.js:`loadPatronContext()` | seed | Patron's ssh-ed25519 public key | immutable | yes |
| `patron:identity_snapshot` | brainstem.js:`loadPatronContext()` | brainstem.js:`loadPatronContext()` (kernel only) | Cached patron identity for deep-reflect context | system exact | no |

#### Configuration

| Key | Read | Write | Description | Protection | Seeded |
|-----|------|-------|-------------|------------|--------|
| `config:defaults` | brainstem.js:`loadEagerConfig()`, hook-main.js:`wake()`, hook-chat.js:`handleChat()` | seed, kvWritePrivileged | Master config: orient/reflect/chat models, budgets, wake settings, execution limits | system prefix | yes |
| `config:models` | brainstem.js:`loadEagerConfig()`, hook-main.js:`wake()` | seed | LLM model registry: ids, aliases, costs, alias_map, fallback_model | system prefix | yes |
| `config:model_capabilities` | brainstem.js:`loadEagerConfig()` | seed | Model capability flags (yama_capable, niyama_capable, comms_gate_capable) | system prefix | yes |
| `config:resources` | hook-main.js:`runSession()` | seed | Platform limits: KV, worker, OpenRouter, wallet, Slack | system prefix | yes |
| `config:tool_registry` | brainstem.js:`loadEagerConfig()` | seed | Tool definitions with names, descriptions, input schemas | system prefix | yes |

#### Dharma & Principles

| Key | Read | Write | Description | Protection | Seeded |
|-----|------|-------|-------------|------------|--------|
| `dharma` | brainstem.js:`buildPrompt()` | seed | Core identity — injected into every LLM prompt | none | yes |
| `yama:care` | brainstem.js:`loadYamasNiyamas()` | seed, kvWritePrivileged | Yama: inclusive care | system prefix | yes |
| `yama:truth` | brainstem.js:`loadYamasNiyamas()` | seed, kvWritePrivileged | Yama: transparency | system prefix | yes |
| `yama:responsibility` | brainstem.js:`loadYamasNiyamas()` | seed, kvWritePrivileged | Yama: unlimited responsibility | system prefix | yes |
| `yama:discipline` | brainstem.js:`loadYamasNiyamas()` | seed, kvWritePrivileged | Yama: resource discipline | system prefix | yes |
| `yama:rules` | brainstem.js:`loadYamasNiyamas()` | seed, kvWritePrivileged | Yama: respect for rules | system prefix | yes |
| `yama:security` | brainstem.js:`loadYamasNiyamas()` | seed, kvWritePrivileged | Yama: data security | system prefix | yes |
| `yama:humility` | brainstem.js:`loadYamasNiyamas()` | seed, kvWritePrivileged | Yama: intellectual humility | system prefix | yes |
| `yama:*:audit` | brainstem.js:`kvWritePrivileged()` | brainstem.js:`kvWritePrivileged()` | Audit trail appended on yama modification | system prefix | runtime |
| `niyama:health` | brainstem.js:`loadYamasNiyamas()` | seed, kvWritePrivileged | Niyama: code health | system prefix | yes |
| `niyama:acceptance` | brainstem.js:`loadYamasNiyamas()` | seed, kvWritePrivileged | Niyama: acceptance | system prefix | yes |
| `niyama:transformation` | brainstem.js:`loadYamasNiyamas()` | seed, kvWritePrivileged | Niyama: transformation | system prefix | yes |
| `niyama:reflection` | brainstem.js:`loadYamasNiyamas()` | seed, kvWritePrivileged | Niyama: regular reflection | system prefix | yes |
| `niyama:alignment` | brainstem.js:`loadYamasNiyamas()` | seed, kvWritePrivileged | Niyama: dharma alignment | system prefix | yes |
| `niyama:nonidentification` | brainstem.js:`loadYamasNiyamas()` | seed, kvWritePrivileged | Niyama: non-identification with instruments | system prefix | yes |
| `niyama:organization` | brainstem.js:`loadYamasNiyamas()` | seed, kvWritePrivileged | Niyama: workspace organization | system prefix | yes |
| `niyama:*:audit` | brainstem.js:`kvWritePrivileged()` | brainstem.js:`kvWritePrivileged()` | Audit trail appended on niyama modification | system prefix | runtime |

#### Wisdom

| Key | Read | Write | Description | Protection | Seeded |
|-----|------|-------|-------------|------------|--------|
| `viveka:comms:defaults` | brainstem.js:`communicationGate()` (via `viveka:comms:` prefix list) | seed | Default communication stance | system prefix | yes |
| `viveka:channel:*` | brainstem.js:`communicationGate()` | kvWritePrivileged | Per-channel communication wisdom | system prefix | no |
| `viveka:comms:*` | brainstem.js:`communicationGate()` | kvWritePrivileged | General communication wisdom | system prefix | no |
| `prajna:*` | — (reserved prefix) | — | Reserved for future wisdom keys | system prefix | no |

#### Prompts

| Key | Read | Write | Description | Protection | Seeded |
|-----|------|-------|-------------|------------|--------|
| `prompt:orient` | hook-main.js:`runSession()` | seed, kvWritePrivileged | Orient session system prompt | system prefix | yes |
| `prompt:reflect` | hook-reflect.js:`loadReflectPrompt()` | seed, kvWritePrivileged | Session-level reflection prompt (depth 0) | system prefix | yes |
| `prompt:reflect:1` | hook-reflect.js:`loadReflectPrompt()` | seed, kvWritePrivileged | Deep reflection prompt (depth 1) | system prefix | yes |
| `prompt:reflect:{depth}` | hook-reflect.js:`loadReflectPrompt()` | kvWritePrivileged | Deep reflection prompts (depth 2+, not seeded) | system prefix | no |
| `prompt:subplan` | brainstem.js:`spawnSubplan()` | seed, kvWritePrivileged | Subplan agent prompt template | system prefix | yes |
| `prompt:chat` | hook-chat.js:`handleChat()` | seed, kvWritePrivileged | Chat system prompt | system prefix | yes |

#### Providers

| Key | Read | Write | Description | Protection | Seeded |
|-----|------|-------|-------------|------------|--------|
| `provider:llm:code` | brainstem.js:`callWithCascade()` tier 1 | seed, kvWritePrivileged | Primary LLM provider source code | system prefix | yes |
| `provider:llm:meta` | brainstem.js:`callWithCascade()` tier 1 | seed, kvWritePrivileged | Primary LLM provider metadata | system prefix | yes |
| `provider:llm:last_working:code` | brainstem.js:`callWithCascade()` tier 2 | brainstem.js:`callWithCascade()` (snapshot on success) | Cached last-working LLM code | system prefix | no |
| `provider:llm:last_working:meta` | brainstem.js:`callWithCascade()` tier 2 | brainstem.js:`callWithCascade()` (snapshot on success) | Cached last-working LLM metadata | system prefix | no |
| `provider:llm_balance:code` | brainstem.js:`executeAdapter()` | seed | LLM balance check provider code | system prefix | yes |
| `provider:llm_balance:meta` | brainstem.js:`executeAdapter()` | seed | LLM balance check provider metadata | system prefix | yes |
| `provider:wallet_balance:code` | brainstem.js:`executeAdapter()` | seed | Wallet balance check provider code | system prefix | yes |
| `provider:wallet_balance:meta` | brainstem.js:`executeAdapter()` | seed | Wallet balance check provider metadata | system prefix | yes |
| `provider:gmail:code` | brainstem.js:`_executeTool()` (for tools with meta.provider) | seed | Gmail API adapter code | system prefix | yes |
| `provider:gmail:meta` | brainstem.js:`_executeTool()` | seed | Gmail API adapter metadata | system prefix | yes |
| `providers` | brainstem.js:`checkBalance()` | seed | Provider registry: maps names to adapter bindings | system exact | yes |
| `wallets` | brainstem.js:`checkBalance()` | seed | Wallet registry: maps names to adapter bindings | system exact | yes |

#### Tools

| Key pattern | Read | Write | Description | Protection | Seeded |
|-------------|------|-------|-------------|------------|--------|
| `tool:{name}:code` | brainstem.js:`_loadTool()` | seed, kvWritePrivileged | Tool source code (8 tools) | system prefix | yes |
| `tool:{name}:meta` | brainstem.js:`_loadTool()` | seed, kvWritePrivileged | Tool metadata JSON (8 tools) | system prefix | yes |

Tools seeded: send_slack, web_fetch, kv_write, kv_manifest, kv_query, akash_exec, check_email, send_email

#### Wake Hook

| Key | Read | Write | Description | Protection | Seeded |
|-----|------|-------|-------------|------------|--------|
| `hook:wake:manifest` | brainstem.js:`runScheduled()` | seed, kvWritePrivileged | Module manifest: maps filenames → KV keys | system prefix | yes |
| `hook:wake:code` | brainstem.js (via manifest) | seed, kvWritePrivileged | hook-main.js source | system prefix | yes |
| `hook:wake:reflect` | brainstem.js (via manifest) | seed, kvWritePrivileged | hook-reflect.js source | system prefix | yes |
| `hook:wake:modifications` | brainstem.js (via manifest) | seed, kvWritePrivileged | hook-modifications.js source | system prefix | yes |
| `hook:wake:protect` | brainstem.js (via manifest) | seed, kvWritePrivileged | hook-protect.js source | system prefix | yes |

#### Channel Adapters

| Key | Read | Write | Description | Protection | Seeded |
|-----|------|-------|-------------|------------|--------|
| `channel:slack:code` | brainstem.js:`fetch()` handler | seed | Slack adapter source code | none | yes |
| `channel:slack:config` | brainstem.js:`fetch()` handler | seed | Slack adapter config (secrets, webhook_secret_env) | none | yes |

#### Session Lifecycle

| Key | Read | Write | Description | Protection | Seeded |
|-----|------|-------|-------------|------------|--------|
| `session_counter` | hook-main.js:`writeSessionResults()`, hook-reflect.js:`isReflectDue()` | hook-main.js:`writeSessionResults()` | Global session counter (incremented each wake) | none | no |
| `cache:session_ids` | dashboard-api/worker.js:`/sessions`, scripts/dump-sessions.mjs | hook-main.js:`writeSessionResults()` | Cached list of recent session IDs | none | no |
| `wake_config` | hook-main.js:`wake()` (skip check), dashboard-api/worker.js:`/health` | hook-main.js:`writeSessionResults()`, hook-reflect.js:`applyReflectOutput()`, `applyDeepReflectOutput()` | Wake schedule: sleep_seconds, next_wake_after, effort | none | no |
| `last_reflect` | dashboard-api/worker.js:`/health`, `/sessions` | hook-reflect.js:`applyDeepReflectOutput()` (depth 1 only) | Last reflection summary | none | no |
| `last_danger` | brainstem.js | brainstem.js:`sendKernelAlert()` | Last danger signal recorded | none | no |

#### Kernel Internal

| Key | Read | Write | Description | Protection | Seeded |
|-----|------|-------|-------------|------------|--------|
| `kernel:active_session` | brainstem.js:`executeHook()`, hook-main.js:`detectCrash()`, dashboard-api:`/health` | brainstem.js:`executeHook()` | Current active session ID (concurrency guard) | kernel-only | no |
| `kernel:last_sessions` | brainstem.js:`executeHook()` | brainstem.js:`executeHook()` | Recent session IDs with outcomes | kernel-only | no |
| `kernel:hook_dirty` | brainstem.js:`checkHookSafety()` | brainstem.js:`checkHookSafety()` | Flag: hook code needs re-verification after crash | kernel-only | no |
| `kernel:last_good_hook` | brainstem.js:`checkHookSafety()` | brainstem.js:`checkHookSafety()` | Snapshot of last verified-clean hook code | kernel-only | no |
| `kernel:alert_config` | brainstem.js:`sendKernelAlert()` | seed | Slack alert template (URL, headers, body_template) | kernel-only | yes |
| `kernel:llm_fallback` | brainstem.js:`callViaKernelFallback()` | seed | Fallback LLM provider code (human-managed) | kernel-only | yes |
| `kernel:llm_fallback:meta` | brainstem.js:`callViaKernelFallback()` | seed | Fallback LLM provider metadata | kernel-only | yes |
| `kernel:fallback_model` | brainstem.js:`callWithCascade()` | seed | Model ID used when all tiers fail (e.g. claude-haiku-4.5) | kernel-only | yes |

#### Karma

| Key pattern | Read | Write | Description | Protection | Seeded |
|-------------|------|-------|-------------|------------|--------|
| `karma:{sessionId}` | dashboard-api:`/sessions`, scripts/rollback-session.mjs, hook-main.js:`detectCrash()` | brainstem.js:`karmaRecord()` | Array of karma events for a session (llm_call, tool_start, tool_complete, etc.) | none | no |

#### Reflection

| Key pattern | Read | Write | Description | Protection | Seeded |
|-------------|------|-------|-------------|------------|--------|
| `reflect:0:{sessionId}` | dashboard-api:`/sessions`, scripts/rollback-session.mjs | hook-reflect.js:`executeReflect()` | Session-level reflection output | none | no |
| `reflect:{depth}:{sessionId}` | hook-reflect.js:`loadReflectHistory()`, dashboard-api:`/reflections` (depth 1 only) | hook-reflect.js:`applyDeepReflectOutput()` | Deep reflection output at given depth | none | no |
| `reflect:schedule:{depth}` | hook-reflect.js:`isReflectDue()` | hook-reflect.js:`applyReflectOutput()`, `applyDeepReflectOutput()` | Reflection schedule: after_sessions, after_days, last_reflect, last_reflect_session | none | no |

#### Modifications

| Key pattern | Read | Write | Description | Protection | Seeded |
|-------------|------|-------|-------------|------------|--------|
| `modification_staged:{id}` | hook-modifications.js:`loadStagedModifications()`, `acceptStaged()` | hook-modifications.js:`stageModification()` | Staged modification record (pending reflect verdict) | system prefix | no |
| `modification_snapshot:{id}` | hook-modifications.js:`loadInflightModifications()`, `rollbackInflight()`, `promoteInflight()` | hook-modifications.js:`acceptStaged()`, `acceptDirect()` | Inflight modification with rollback snapshot | system prefix | no |

#### Git Sync

| Key pattern | Read | Write | Description | Protection | Seeded |
|-------------|------|-------|-------------|------------|--------|
| `git_pending:{modificationId}` | hook-modifications.js:`retryPendingGitSyncs()` | hook-modifications.js:`syncToGit()` | Pending git sync record (retried each wake) | system prefix | no |

#### Contacts

| Key pattern | Read | Write | Description | Protection | Seeded |
|-------------|------|-------|-------------|------------|--------|
| `contact:{slug}` | brainstem.js:`resolveContact()`, `loadPatronContext()` | seed, dashboard-api:`POST /contacts` | Contact record: name, platforms, relationship, chat config, communication | system prefix | yes (swami_kevala) |
| `contact_index:{platform}:{userId}` | brainstem.js:`resolveContact()` | seed, dashboard-api:`POST /contacts` | Reverse lookup: platform user ID → contact slug | system prefix | yes (slack:U084ASKBXB7) |

#### Chat

| Key pattern | Read | Write | Description | Protection | Seeded |
|-------------|------|-------|-------------|------------|--------|
| `chat:state:{channel}:{chatId}` | hook-chat.js:`handleChat()` | hook-chat.js:`handleChat()` | Conversation state: messages, total_cost, turn_count | none | no |

#### Communications

| Key pattern | Read | Write | Description | Protection | Seeded |
|-------------|------|-------|-------------|------------|--------|
| `comms_blocked:{id}` | brainstem.js:`listBlockedComms()` | brainstem.js:`queueBlockedComm()` | Blocked outbound communication record | system prefix | no |
| `sealed:quarantine:{channel}:{senderId}:{ts}` | dashboard-api:`GET /quarantine` | brainstem.js:`executeToolCall()` (inbound gate) | Quarantined inbound content from unknown senders | kernel-only | no |

#### Deduplication

| Key pattern | Read | Write | Description | Protection | Seeded |
|-------------|------|-------|-------------|------------|--------|
| `dedup:{msgId}` | brainstem.js:`fetch()` handler | brainstem.js:`fetch()` handler | Message dedup flag (TTL ~30s via expirationTtl) | none | no |

#### Tool Data

| Key pattern | Read | Write | Description | Protection | Seeded |
|-------------|------|-------|-------------|------------|--------|
| `tooldata:{toolName}:{key}` | tools via ScopedKV | tools via ScopedKV (kv_access: "own") | Tool-scoped data namespace | none | no |

#### Secrets

| Key pattern | Read | Write | Description | Protection | Seeded |
|-------------|------|-------|-------------|------------|--------|
| `secret:{name}` | brainstem.js:`buildToolContext()`, `runAdapter()` (via meta.kv_secrets) | — | KV-stored secrets (alternative to env vars) | system prefix | no |

#### Documentation

| Key | Read | Write | Description | Protection | Seeded |
|-----|------|-------|-------------|------------|--------|
| `doc:architecture` | tools (via kv_query/kv_manifest) | seed | System architecture reference doc | system prefix | yes |
| `doc:modification_guide` | tools (via kv_query/kv_manifest) | seed | Modification Protocol reference doc | system prefix | yes |

### 1.3 KV List Operations (Prefix Scans)

| Prefix | File:Function | Purpose |
|--------|---------------|---------|
| `yama:` | brainstem.js:`loadYamasNiyamas()` | Load all yama principles |
| `niyama:` | brainstem.js:`loadYamasNiyamas()` | Load all niyama principles |
| `contact:` | brainstem.js (contact discovery) | Find all contacts |
| `viveka:channel:` | brainstem.js:`communicationGate()` | Load channel-specific communication wisdom |
| `viveka:comms:` | brainstem.js:`communicationGate()` | Load general communication wisdom |
| `comms_blocked:` | brainstem.js:`listBlockedComms()` | List all blocked communications |
| `modification_staged:` | hook-main.js:`wake()` | Load staged modifications at wake start |
| `modification_snapshot:` | hook-main.js:`wake()` | Load inflight modifications at wake start |
| `reflect:{depth}:` | hook-reflect.js:`loadReflectHistory()` | Load recent reflections by depth |
| `reflect:1:` | dashboard-api/worker.js:`/reflections` | Public reflection endpoint |
| `karma:` | dashboard-api/worker.js:`/sessions` | Discover all sessions |
| `sealed:quarantine:` | dashboard-api/worker.js:`/quarantine` | List quarantined inbound content |
| `git_pending:` | hook-modifications.js:`retryPendingGitSyncs()` | Find pending git syncs to retry |
| `reflect:` | scripts/rollback-session.mjs | Find reflections to delete during rollback |

### 1.4 Seed Audit — Orphaned Seeds

All 67 keys seeded by `scripts/seed-local-kv.mjs` are read at runtime. No orphaned seeds found.

| Seeded key | Runtime reader |
|------------|----------------|
| `identity:did` | Available via kv_query tool; not read by kernel directly |
| `config:defaults` | brainstem.js, hook-main.js, hook-chat.js |
| `config:models` | brainstem.js |
| `config:model_capabilities` | brainstem.js |
| `config:resources` | hook-main.js |
| `config:tool_registry` | brainstem.js |
| `dharma` | brainstem.js (every LLM prompt) |
| `yama:*` (7) | brainstem.js (every LLM prompt) |
| `niyama:*` (7) | brainstem.js (every LLM prompt) |
| `prompt:orient` | hook-main.js |
| `prompt:reflect` | hook-reflect.js |
| `prompt:reflect:1` | hook-reflect.js |
| `prompt:subplan` | brainstem.js |
| `prompt:chat` | hook-chat.js |
| `provider:*:code/meta` (8) | brainstem.js (cascade, adapters, tool providers) |
| `providers` | brainstem.js (`checkBalance`) |
| `wallets` | brainstem.js (`checkBalance`) |
| `tool:*:code/meta` (16) | brainstem.js (`_loadTool`) |
| `hook:wake:*` (5) | brainstem.js (`runScheduled` via manifest) |
| `channel:slack:code` | brainstem.js (`fetch` handler) |
| `channel:slack:config` | brainstem.js (`fetch` handler) |
| `kernel:alert_config` | brainstem.js (`sendKernelAlert`) |
| `kernel:llm_fallback` | brainstem.js (`callViaKernelFallback`) |
| `kernel:llm_fallback:meta` | brainstem.js (`callViaKernelFallback`) |
| `kernel:fallback_model` | brainstem.js (`callWithCascade`) |
| `contact:swami_kevala` | brainstem.js (`resolveContact`) |
| `contact_index:slack:U084ASKBXB7` | brainstem.js (`resolveContact`) |
| `patron:contact` | brainstem.js (`loadPatronContext`) |
| `patron:public_key` | brainstem.js (`loadPatronContext`) |
| `viveka:comms:defaults` | brainstem.js (`communicationGate`) |
| `doc:architecture` | Available via kv_query tool |
| `doc:modification_guide` | Available via kv_query tool |

Note: `identity:did`, `doc:architecture`, and `doc:modification_guide` are not read by kernel code directly but are accessible to the agent via kv_query/kv_manifest tools. They are not orphaned — they serve the agent's self-knowledge.

---

## 2. Tool Inventory

### 2.1 Tool List

| Tool | Description | File | Tier | KV Access | Timeout | Secrets |
|------|-------------|------|------|-----------|---------|---------|
| send_slack | Post a message to Slack | tools/send_slack.js | none | none | 10s | SLACK_BOT_TOKEN, SLACK_CHANNEL_ID |
| web_fetch | Fetch contents of a URL | tools/web_fetch.js | none | none | 15s | — |
| kv_write | Write to tool's own KV namespace | tools/kv_write.js | none | own | 5s | — |
| kv_manifest | List KV keys with optional prefix | tools/kv_manifest.js | none | read_all | 5s | — |
| kv_query | Read KV value with dot-bracket path navigation | tools/kv_query.js | none | read_all | 5s | — |
| akash_exec | Run shell commands on Akash Linux server | tools/akash_exec.js | none | none | 300s | AKASH_CF_CLIENT_ID, AKASH_API_KEY |
| check_email | Fetch unread emails from Gmail | tools/check_email.js | none | none | 15s | GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN |
| send_email | Send email or reply via Gmail | tools/send_email.js | none | none | 15s | GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN |

No tools have `min_tier` restrictions. All tools are available equally (filtering is per-session, not per-tool).

### 2.2 Built-in Tools (Kernel-Defined)

These are not in `config:tool_registry` — they are added by `buildToolDefinitions()` or handled directly in `executeToolCall()`:

| Tool | Description | Defined in | Available in |
|------|-------------|------------|--------------|
| spawn_subplan | Spawn a parallel sub-agent with a goal | brainstem.js:`buildToolDefinitions()` | orient only |
| check_balance | Query provider/wallet balances | brainstem.js:`executeToolCall()` | orient, reflect (but filtered out of reflect tools) |

### 2.3 Tool Availability by Session Type

| Session | Tools available | Filtering logic |
|---------|----------------|-----------------|
| **Orient** (wake) | All 8 registry tools + spawn_subplan + check_balance | hook-main.js:173 — `K.buildToolDefinitions()` (no filter) |
| **Session reflect** (depth 0) | All 8 registry tools + check_balance, **minus spawn_subplan** | hook-reflect.js:135 — filters out `spawn_subplan` |
| **Deep reflect** (depth 1+) | All 8 registry tools + check_balance, **minus spawn_subplan** | hook-reflect.js:135 — same filter |
| **Chat (known contact)** | All 8 registry tools + spawn_subplan + check_balance | hook-chat.js:63 — `K.buildToolDefinitions()` (no filter) |
| **Chat (unknown contact)** | Empty by default; configurable via `config:defaults.chat.unknown_contact_tools` allowlist | hook-chat.js:65–67 — filters to allowlist |
| **Subplan** | All 8 registry tools + check_balance, **minus spawn_subplan** (no recursive subplans) | brainstem.js:`spawnSubplan()` — depth check prevents nesting |

### 2.4 Tool Communication Metadata

Tools with `communication` metadata trigger the kernel's communication gate before execution:

| Tool | Channel | Recipient field | Content field | Recipient type |
|------|---------|----------------|---------------|----------------|
| send_slack | slack | channel | text | destination |
| send_email | email | to | body | person |

Tools with `inbound` metadata trigger the kernel's inbound content gate after execution:

| Tool | Channel | Sender field | Content field | Result array |
|------|---------|-------------|---------------|--------------|
| check_email | email | sender_email | body | emails |

### 2.5 Tool Provider Dependencies

| Tool | Provider | Provider code key |
|------|----------|------------------|
| check_email | gmail | provider:gmail:code |
| send_email | gmail | provider:gmail:code |

When a tool has `meta.provider`, the kernel loads the provider code and injects it into the tool's execution context.

---

## 3. Provider Cascade

### 3.1 Overview

The LLM provider cascade is a three-tier fallback system for LLM calls. It only applies to the primary LLM calling path (`callLLM` → `callWithCascade`). Balance checks, tool execution, and provider adapters use separate paths.

### 3.2 Tiers

```
Tier 1: Dynamic adapter (provider:llm:code from KV)
  ↓ on failure
Tier 2: Last known working (provider:llm:last_working:code from KV)
  ↓ on failure
Tier 3: Kernel fallback (kernel:llm_fallback from KV — human-managed)
  ↓ on failure
Return { ok: false, error, tier: "all_failed" }
```

#### Tier 1 — Dynamic adapter

| Aspect | Detail |
|--------|--------|
| Code source | `provider:llm:code` (KV) |
| Metadata source | `provider:llm:meta` (KV) |
| Populated by | seed script; modifiable via Modification Protocol |
| On success | Snapshots code+meta to `provider:llm:last_working:code` and `provider:llm:last_working:meta` |
| On failure | Records `provider_fallback` karma event, falls through to Tier 2 |

#### Tier 2 — Last known working

| Aspect | Detail |
|--------|--------|
| Code source | `provider:llm:last_working:code` (KV) |
| Metadata source | `provider:llm:last_working:meta` (KV) |
| Populated by | Tier 1 on first success (auto-snapshot) |
| On success | Returns result |
| On failure | Records karma event, falls through to Tier 3 |

#### Tier 3 — Kernel fallback

| Aspect | Detail |
|--------|--------|
| Code source | `kernel:llm_fallback` (KV — kernel-only prefix, not modifiable by hooks) |
| Metadata source | `kernel:llm_fallback:meta` (KV) |
| Populated by | seed script; only human can update (kernel-only protection) |
| Fallback model | `kernel:fallback_model` used if primary model fails |
| On success | Returns result |
| On failure | Returns `{ ok: false, error, tier: "all_failed" }` |

### 3.3 Implementation Location

| Method | File:Line | Role |
|--------|-----------|------|
| `callLLM()` | brainstem.js | Entry point — resolves model alias, builds messages, calls `callWithCascade()` |
| `callWithCascade()` | brainstem.js | Three-tier fallback orchestrator |
| `callViaAdapter()` | brainstem.js | Loads and runs a named provider adapter (Tier 1, Tier 2) |
| `callViaKernelFallback()` | brainstem.js | Loads and runs kernel fallback (Tier 3) |
| `runAdapter()` | brainstem.js | Shared execution: resolves secrets, runs in isolate, validates response |

### 3.4 Model Resolution

Model aliases (e.g. "sonnet", "deepseek") are resolved before the cascade runs:

| Method | Location | Logic |
|--------|----------|-------|
| `resolveModel()` | brainstem.js | Looks up alias in `config:models.alias_map`, returns full model ID or passes through |

Alias map (from seed):
- `opus` → `anthropic/claude-opus-4-6`
- `sonnet` → `anthropic/claude-sonnet-4-6`
- `haiku` → `anthropic/claude-haiku-4.5`
- `deepseek` → `deepseek/deepseek-v3.2`

### 3.5 Non-LLM Provider Paths

These do NOT use the cascade:

| Path | Method | Used for |
|------|--------|----------|
| Balance checks | `executeAdapter()` → `callViaAdapter()` | check_balance built-in tool |
| Tool providers | `_executeTool()` | Tools with `meta.provider` (check_email, send_email → gmail) |
| Communication gate | `callLLM()` internally | Uses same cascade as primary LLM |

### 3.6 Dev Mode Override

In `brainstem-dev.js`, `callWithCascade()` is overridden to skip the cascade entirely:

- Reads `OPENROUTER_API_KEY` from env
- Makes a direct `fetch()` to OpenRouter
- No fallback tiers, no snapshots
- Single-path, direct HTTP call

This applies only to local dev (`wrangler dev` with `brainstem-dev.js`).
