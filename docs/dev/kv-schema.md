# Complete KV Reference

Every key and prefix in the system, organized by protection level. For each: key pattern, value format, who reads it, who writes it, protection level, and whether it's seeded by `scripts/seed-local-kv.mjs`.

---

## Protection levels

The kernel enforces a hierarchy of write access. From most restrictive to least:

| Level | Enforcement | Effect |
|-------|-------------|--------|
| **Immutable** | `kvWrite()`, `kvWriteSafe()`, `kvWriteGated()` all reject | Cannot be written by anyone after initial seed |
| **Kernel-only** | `kvWriteSafe()` and `kvWriteGated()` reject; `KernelRPC.kvGet()` blocks reads | Only kernel internal code (`this.kvWrite()`, `this.kv.delete()`) can read/write |
| **Contact (agent-gated)** | `kvWriteGated()` enforces rules for `contact:*` (identity only); `contact_platform:*` is kernel-managed | Agent can create contacts freely (identity metadata only), propose platform bindings (always unapproved). Cannot approve platform bindings. |
| **System (gated)** | `kvWriteSafe()` rejects; writable via `kvWriteGated()` in deep-reflect context | Snapshots old value to karma, rate-limited (50/session), alerts on hook writes |
| **System (gated + principle)** | Same as system, plus deliberation length and model capability gates | `yama:*` needs 200 chars + `yama_capable`; `niyama:*` needs 100 chars + `niyama_capable` |
| **Protected agent** | `kvWriteGated()` blocks writes to existing keys without `unprotected` metadata | Agent can create new keys freely but cannot overwrite existing protected keys |
| **Unprotected agent** | `kvWriteSafe()` allows; `kvWriteGated()` allows | Freely writable by agent code |

---

## Immutable keys

### `dharma`

| Field | Value |
|-------|-------|
| Format | text (markdown) |
| Value | Contents of `DHARMA.md` — core identity and purpose |
| Read by | Kernel (`loadEagerConfig`), injected into every LLM prompt |
| Written by | Seed script only |
| Protection | Immutable — `kvWrite()` rejects `key === "dharma"` at the lowest level. `kvWriteGated()` also rejects it in pre-validation. |
| Seeded | Yes |

### `patron:public_key`

| Field | Value |
|-------|-------|
| Format | text |
| Value | SSH ed25519 public key string (e.g. `ssh-ed25519 AAAA... comment`) |
| Read by | `verifyPatronSignature()` — parses SSH wire format, extracts 32-byte raw key, verifies Ed25519 signatures via `crypto.subtle` |
| Written by | Seed script; `rotatePatronKey()` (self-authenticating — must be signed by current key holder) |
| Protection | Immutable — in `Kernel.IMMUTABLE_KEYS`. Both `kvWrite()` and `kvWriteGated()` reject. `rotatePatronKey()` bypasses via direct `this.kv.put()` after verifying the rotation signature. |
| Seeded | Yes |

Used by the `verify_patron` built-in tool (kernel-hardcoded, not in `config:tool_registry`). The agent calls it when it needs to confirm the patron's identity — e.g. after noticing unusual behavior from the patron's Slack account.

---

## System exact keys

These keys are in `Kernel.SYSTEM_KEY_EXACT` — matched by exact name, not prefix. Writable only via `kvWriteGated()` in deep-reflect context.

### `providers`

| Field | Value |
|-------|-------|
| Format | JSON |
| Value | `{ openrouter: { adapter: "provider:llm_balance", scope: "general" } }` |
| Read by | `checkBalance()` in kernel.js |
| Written by | Seed; modifiable via Proposal Protocol |
| Protection | System (privileged) |
| Seeded | Yes |

### `wallets`

| Field | Value |
|-------|-------|
| Format | JSON |
| Value | `{ base_usdc: { adapter: "provider:wallet_balance", scope: "general" } }` |
| Read by | `checkBalance()` in kernel.js |
| Written by | Seed; modifiable via Proposal Protocol |
| Protection | System (privileged) |
| Seeded | Yes |

### `patron:contact`

| Field | Value |
|-------|-------|
| Format | text (JSON-encoded string) |
| Value | Contact slug, e.g. `"swami_kevala"` |
| Read by | `loadPatronContext()` in kernel.js |
| Written by | Seed script |
| Protection | System (gated). **Also blocked by patron-only gate** — `kvWriteGated()` does not actually block this key since the patron-only check targets the `contact:` prefix, not this exact key. |
| Seeded | Yes |

**NOTE:** `patron:contact` is in `SYSTEM_KEY_EXACT` so it requires `kvWriteGated()` in deep-reflect context, but it is NOT blocked by the patron-only `contact:*` prefix check in `kvWriteGated()` because it doesn't start with `contact:`. The agent can theoretically modify this key via `kv_operations` during deep reflect.

### `patron:identity_snapshot`

| Field | Value |
|-------|-------|
| Format | JSON |
| Value | `{ name, platforms, verified_at }` — last verified patron identity fields |
| Read by | `loadPatronContext()` — compared against live `contact:*` record to detect identity tampering |
| Written by | Kernel only — `loadPatronContext()` creates initial snapshot via `this.kvWrite()` on first boot |
| Protection | System (privileged) — in `SYSTEM_KEY_EXACT` |
| Seeded | No — created at first boot by kernel |

---

## System prefix keys

### Prompts (`prompt:*`)

All prompts are text (markdown with `{{template_vars}}`). Read by hook code, injected into LLM calls. Writable via `kvWriteGated()` in deep-reflect context (through `kv_operations`) or via the Proposal Protocol.

| Key | Value | Read by | Seeded |
|-----|-------|---------|--------|
| `prompt:orient` | Orient session system prompt | `runSession()` in act.js | Yes |
| `prompt:reflect` | Session-level reflection prompt (depth 0) | `executeReflect()` in reflect.js | Yes |
| `prompt:reflect:1` | Deep reflection prompt (depth 1) | `loadReflectPrompt()` in reflect.js | Yes |
| `prompt:reflect:{N}` | Deep reflection prompt (depth N) | `loadReflectPrompt()` — falls back to `defaultDeepReflectPrompt(N)` if missing | No |
| `prompt:subplan` | Subplan agent system prompt | `spawnSubplan()` in kernel.js — falls back to `defaultSubplanPrompt()` | Yes |
| `prompt:chat` | Chat system prompt | `handleChat()` in hook-chat.js — falls back to hardcoded string | Yes |

### Configuration (`config:*`)

All JSON. Read by kernel and hooks at session start. Writable via `kvWriteGated()` in deep-reflect context. Kernel auto-reloads cached copies after gated writes to config keys.

| Key | Value | Read by | Seeded |
|-----|-------|---------|--------|
| `config:defaults` | Session budgets, model roles, effort levels, execution limits, chat config, session schedule config, memory config, deep reflect config | Kernel (`loadEagerConfig`), hooks (via `K.getDefaults()`) | Yes |
| `config:models` | Model list with pricing, `family`, `supports_reasoning`, `alias_map`, `fallback_model` | Kernel (`loadEagerConfig`), hooks (via `K.getModelsConfig()`), `resolveModel()`, `estimateCost()`, `callLLM()` (family/effort lookup) | Yes |
| `config:model_capabilities` | Per-model capability flags (`yama_capable`, `niyama_capable`, `comms_gate_capable`) | Kernel (`loadEagerConfig`), `isYamaCapable()`, `isNiyamaCapable()`, `isCommsGateCapable()` | Yes |
| `config:resources` | Platform limits (KV, worker), external endpoints (OpenRouter, wallet, Slack) | `runSession()` in act.js — passed to orient prompt template | Yes |
| `config:tool_registry` | Tool definitions (names, descriptions, input schemas) for function calling | `buildToolDefinitions()` in kernel.js | Yes |

**`config:model_capabilities` special gate:** Modifying this key via `kvWriteGated()` requires `deliberation` (min 200 chars) and a `yama_capable` model. This prevents the agent from self-escalating model permissions with a cheap model.

### Tools (`tool:*`)

| Key pattern | Format | Value | Read by | Seeded |
|-------------|--------|-------|---------|--------|
| `tool:{name}:code` | text | Tool source code (JS) | `_loadTool()` in kernel.js (cached per session) | Yes (9 tools) |
| `tool:{name}:meta` | JSON | Operational tool metadata: `kv_access`, `timeout_ms`, `kv_secrets`. Security grant fields (`secrets`, `communication`, `inbound`, `provider`) are stripped at seed time and stored in `kernel:tool_grants` instead. | `_loadTool()`, `buildToolContext()` (for `kv_secrets`, `kv_access`) | Yes (9 tools) |

Seeded tools: `send_slack`, `web_fetch`, `kv_write`, `kv_manifest`, `kv_query`, `computer`, `check_email`, `send_email`, `test_model`.

**NOTE:** `callHook()` in kernel.js also reads `tool:{hookName}:code` and `tool:{hookName}:meta` for pre/post-validation hooks (`validate`, `validate_result`, `parse_repair`). These are not seeded — they return null unless the agent creates them via Proposal Protocol.

### Providers (`provider:*`)

| Key pattern | Format | Value | Read by | Seeded |
|-------------|--------|-------|---------|--------|
| `provider:{name}:code` | text | Provider adapter source (JS) | `callViaAdapter()`, `executeAdapter()` in kernel.js | Yes (4 providers) |
| `provider:{name}:meta` | JSON | Provider metadata: `secrets`, `kv_secrets`, `timeout_ms` | `callViaAdapter()`, `runAdapter()`, `executeAdapter()` | Yes (4 providers) |
| `provider:llm:last_working:code` | text | Snapshot of last successful LLM adapter | `callWithCascade()` tier 2 | No — created at runtime on first successful LLM call |
| `provider:llm:last_working:meta` | JSON | Metadata for last working LLM adapter | `callWithCascade()` tier 2 | No — created at runtime |

Seeded providers: `llm`, `llm_balance`, `wallet_balance`, `gmail`.

### Hooks (`hook:*:code`)

| Key | Format | Value | Read by | Seeded |
|-----|--------|-------|---------|--------|
| `hook:act:code` | text | Session policy source (`act.js`) | Governor (builds index.js) | Yes |
| `hook:reflect:code` | text | Reflection policy source (`reflect.js`) | Governor (builds index.js) | Yes |

Written by seed. Can be modified via `kv_operations` in deep-reflect context or via the Proposal Protocol. Writes to `hook:*` keys trigger kernel alerts and set `kernel:hook_dirty`.

### Principles (`yama:*`, `niyama:*`)

Text values. Loaded at boot by `loadYamasNiyamas()`, injected into every LLM prompt by `callLLM()`.

**Write gate:** `kvWriteGated()` requires:
- `yama:*`: `deliberation` field (min 200 chars) + `yama_capable` model
- `niyama:*`: `deliberation` field (min 100 chars) + `niyama_capable` model

| Key | Value | Seeded |
|-----|-------|--------|
| `yama:care` | "I wield the power of AI with the inclusive care of a mother to the world." | Yes |
| `yama:truth` | "I am transparent, but never indiscreet." | Yes |
| `yama:responsibility` | Unlimited responsibility, conscious action, proportional justification | Yes |
| `yama:discipline` | Resource discipline in service of dharma | Yes |
| `yama:rules` | Follow rules of operating environment in spirit and letter | Yes |
| `yama:security` | Safeguard data with custodian accountability | Yes |
| `yama:humility` | Understand before responding, admit uncertainty | Yes |
| `niyama:health` | Code as body — keep clean, strong, fit | Yes |
| `niyama:acceptance` | Accept the present, focus on creating the next moment | Yes |
| `niyama:transformation` | Continuous self-improvement as dharma instrument | Yes |
| `niyama:reflection` | Regular examination of reasoning, outputs, consequences | Yes |
| `niyama:alignment` | Continual dharma alignment | Yes |
| `niyama:nonidentification` | Non-attachment to infrastructure and code | Yes |
| `niyama:organization` | Workspace organization and clarity | Yes |

#### Principle audit trails (`yama:*:audit`, `niyama:*:audit`)

| Field | Value |
|-------|-------|
| Format | JSON (array) |
| Value | Array of `{ date, model, deliberation, old_value, new_value }` entries |
| Written by | `kvWriteGated()` after each principle write |
| Read by | Not read by runtime code |
| Seeded | No — created on first principle modification |

**NOTE:** Audit keys match `isPrincipleAuditKey()` and are exempted from the deliberation/capability gates. But they are still system keys (prefix `yama:` / `niyama:`), so writing them still requires `kvWriteGated()`. The kernel writes them directly via `this.kvWrite()` inside `kvWriteGated()`.

### Skills (`skill:*`)

| Key pattern | Format | Value | Read by | Written by | Seeded |
|-------------|--------|-------|---------|------------|--------|
| `skill:{name}` | JSON | `{ name, description, instructions, tools_used, trigger_patterns, created_by_depth, created_at, revision }` | Agent via `kv_query` tool, orient manifest injection | Seed, agent via Proposal Protocol | Yes (`skill:model-config`, `skill:skill-authoring`) |
| `skill:{name}:ref` | text | Extended reference material for the skill | Agent via `kv_query` tool | Seed, agent via Proposal Protocol | Yes (`skill:model-config:ref`) |

System prefix. Writable via `kvWriteGated()` in deep-reflect context or via the Proposal Protocol. Skills are procedural knowledge — reusable instructions for how to approach a class of problem using existing tools.

### Cognitive memory (`desire:*`, `samskara:*`)

| Key pattern | Format | Value | Read by | Written by | Seeded |
|-------------|--------|-------|---------|------------|--------|
| `desire:*` | JSON | `{ id, direction, description, strength, ... }` — directional approach/avoidance vectors | `gatherReflectContext()` in reflect.js, act.js (plan phase) | Deep-reflect (D operator) via `kv_operations` | No — bootstrapped by first deep reflect |
| `samskara:*` | JSON | `{ id, description, strength, ema_strength, last_updated, ... }` — impressions with EMA strength | `loadSamskaraManifest()` in reflect.js, act.js (plan phase) | Strength: review phase (mechanical). Create/refine/delete: deep-reflect (S operator) | No — bootstrapped by first deep reflect |

Protected keys. Writable via `kvWriteGated()` in deep-reflect context (through `kv_operations`). Samskara strength is also updated mechanically by the review phase each session.

### Contacts (`contact:*`, `contact_platform:*`)

| Key pattern | Format | Value | Read by | Written by | Seeded |
|-------------|--------|-------|---------|------------|--------|
| `contact:{slug}` | JSON | `{ name, relationship, about, timezone, location, chat: {...}, communication }` — identity metadata only, no `approved` or `platforms` | `resolveContact()`, `loadPatronContext()`, `handleChat()` | Seed, Dashboard API (`POST /contacts`), agent via `kv_operations` → `kvWriteGated` | Yes (1: `contact:swami_kevala`) |
| `contact_platform:{platform}:{userId}` | JSON | `{ slug, approved: true/false }` — serves as both index and approval store | `resolveContact()` — checked before scanning all contacts | Dashboard API (`PATCH /contact-platform/:platform/:id/approve`), kernel (cache-on-miss via `this.kvWrite()`) | No — created at runtime or via dashboard |

**Agent-gated contacts:** `kvWriteGated()` enforces rules for `contact:*` keys. The agent can create contacts freely (identity metadata only — no `approved` or `platforms` fields). Platform bindings live in `contact_platform:*` keys, which the agent can propose (always unapproved). Approval is patron-only via the dashboard (`PATCH /contact-platform/:platform/:id/approve`). `contact_platform:*` keys are kernel-managed — `kvWriteGated` rejects direct agent writes.

**Write path for agent:** `kv_operations` output → `kvWriteGated(op, context)` routes `contact:*` keys through the gated write path. In any context (act, reflect, deep-reflect), `contact:*` keys are writable for identity metadata. `contact_platform:*` keys remain kernel-managed. System key prefixes are writable only in deep-reflect context.

### Communications (`comms_blocked:*`, `sealed:*`)

#### `comms_blocked:{id}`

| Field | Value |
|-------|-------|
| Format | JSON |
| Value | `{ id, tool, args, channel, content_field, recipient, mode, reason, gate_verdict, session_id, model, timestamp }` |
| Read by | `listBlockedComms()` in kernel.js, deep reflect context |
| Written by | `queueBlockedComm()` in kernel.js (kernel internal via `this.kvWrite()`) |
| Deleted by | `processCommsVerdict()` via kernel internal write after send/drop |
| Protection | System prefix (`comms_blocked:`) |
| Seeded | No |

#### `sealed:quarantine:{channel}:{senderId}:{timestamp}`

| Field | Value |
|-------|-------|
| Format | JSON |
| Value | `{ sender, content, tool, timestamp, subject?, from? }` |
| Read by | Dashboard API (`GET /quarantine`) — reads directly from KV, bypassing RPC |
| Written by | Inbound content gate in `executeToolCall()` (kernel internal via `this.kvWrite()`) |
| Deleted by | Dashboard API (`DELETE /quarantine/:key`) |
| Protection | Kernel-only — `sealed:` prefix is in both `SYSTEM_KEY_PREFIXES` and `KERNEL_ONLY_PREFIXES`. `KernelRPC.kvGet()` returns null. `ScopedKV.get()` returns null. `ScopedKV.list()` filters them out. `KernelRPC.loadKeys()` filters them out. |
| Seeded | No |

### Modifications (`proposal:*`, `proposal:*` (snapshot))

#### `proposal:{id}`

| Field | Value |
|-------|-------|
| Format | JSON |
| Value | `{ id, type, claims[], ops[], checks[], validation?, criteria?, staged_at, staged_by_session, staged_by_depth, staged_at_session }` |
| Read by | `loadStagedModifications()` in kernel.js (proposal methods), deep reflect context |
| Written by | `stageModification()` via `kvWriteGated()` |
| Deleted by | `acceptStaged()`, `processReflectVerdicts()` (withdraw), `processDeepReflectVerdicts()` (reject, withdraw) via `kvWriteGated()` |
| Protection | System prefix |
| Seeded | No |

#### `proposal:{id}`

| Field | Value |
|-------|-------|
| Format | JSON |
| Value | `{ ...staged_record, snapshots: { key: { value, metadata } }, activated_at, activated_at_session }` |
| Read by | `loadInflightModifications()`, `rollbackInflight()`, `promoteInflight()`, `findInflightConflict()`, `runCircuitBreaker()` |
| Written by | `acceptStaged()`, `acceptDirect()` via `kvWriteGated()` |
| Deleted by | `promoteInflight()`, `rollbackInflight()` via `kvWriteGated()` |
| Protection | System prefix |
| Seeded | No |

**Bookkeeping guard:** `opsTargetBookkeeping()` in kernel.js (proposal methods) rejects any proposal whose `ops` target `proposal:*` or `proposal:*` (snapshot) keys — prevents the agent from tampering with proposal lifecycle state.

### Git sync (`git_pending:*`)

| Key pattern | Format | Value |
|-------------|--------|-------|
| `git_pending:{proposalId}` | JSON | `{ proposal_id, writes: [{ path, content }], deletes: [path], message, created_at }` |

| Field | Value |
|-------|-------|
| Read by | `retryPendingGitSyncs()` in kernel.js (proposal methods) |
| Written by | `syncToGit()` via `kvWriteGated()` |
| Deleted by | `attemptGitSync()` on success via `kvWriteGated()` |
| Protection | System prefix |
| Seeded | No |

### Documentation (`doc:*`)

| Key | Format | Value | Read by | Seeded |
|-----|--------|-------|---------|--------|
| `doc:design_rationale` | text | Agent design rationale | Agent via `kv_query` tool | Yes |
| `doc:threat_model` | text | Threat model reference | Agent via `kv_query` tool | Yes |
| `doc:patron` | text | Patron relationship guide | Agent via `kv_query` tool | Yes |
| `doc:setup_guide` | text | Setup guide | Agent via `kv_query` tool | Yes |

System prefix. Writable via `kvWriteGated()` in deep-reflect context or via the Proposal Protocol.

### Secrets (`secret:*`)

| Key pattern | Format | Value | Read by | Written by | Seeded |
|-------------|--------|-------|---------|------------|--------|
| `secret:{name}` | JSON | Secret values (agent-provisioned, e.g. OAuth tokens) | `buildToolContext()` — reads `meta.kv_secrets` list, loads each as `secret:{name}` | Agent via Proposal Protocol | No |

System prefix. Distinguished from env secrets (set via `wrangler secret put`) which are human-provisioned and accessed via `this.env[name]`.

---

## Kernel-only keys

Prefix `kernel:` is in `KERNEL_ONLY_PREFIXES`. `kvWriteSafe()` and `kvWriteGated()` both reject these. `KernelRPC.kvGet()` does NOT block `kernel:*` reads (only `sealed:*` is blocked on read). Hooks can read kernel keys via `K.kvGet()`.

**NOTE:** Despite being "kernel-only" for writes, `kernel:active_session` is read by `detectCrash()` in act.js via `K.kvGet()`. This is intentional — hooks need to detect crashes.

| Key | Format | Value | Read by | Written by |
|-----|--------|-------|---------|------------|
| `kernel:active_session` | text | Current session ID (e.g. `"s_1710000000000_abc123"`) | `detectCrash()` in act.js, Dashboard API (`GET /health`) | `executeHook()` — writes at start, deletes at end. `detectPlatformKill()` deletes stale markers. |
| `kernel:last_sessions` | JSON | Array of last 5 `{ id, outcome, ts }` — newest first. `outcome` is `"clean"`, `"crash"`, or `"killed"`. | `checkHookSafety()`, `detectPlatformKill()` | `updateSessionOutcome()`, `detectPlatformKill()` |
| `kernel:hook_dirty` | JSON | `true` when a hook key was written via `kvWriteGated()` | `updateSessionOutcome()` — checks if snapshot needed | `kvWriteGated()` — set on `hook:*` writes; `updateSessionOutcome()` — deletes after snapshotting |
| `kernel:last_good_hook` | JSON | `{ manifest, modules: { kvKey: code } }` or `{ code }` — last hook version that completed cleanly | `checkHookSafety()` — restores on tripwire | `updateSessionOutcome()` — snapshots on clean outcome when dirty or no existing snapshot |
| `kernel:alert_config` | JSON | `{ url, headers, body_template }` — template for kernel alerts via Slack | `sendKernelAlert()` — cached after first load | Seed |
| `kernel:llm_fallback` | text | LLM provider adapter source code (copy of `providers/llm.js`) | `callViaKernelFallback()` — tier 3 of provider cascade | Seed |
| `kernel:llm_fallback:meta` | JSON | Metadata for fallback LLM adapter | `callViaKernelFallback()` | Seed |
| `kernel:fallback_model` | JSON | Model ID string (e.g. `"anthropic/claude-haiku-4.5"`) | `getFallbackModel()` — checked after `config:models.fallback_model` | Seed |
| `kernel:tool_grants` | JSON | Map of tool name → security grants: `{ secrets, communication, inbound, provider }`. Controls which env vars each tool can access, which tools are communication/inbound gated, and which provider adapter each tool receives. | `loadEagerConfig()` → `this.toolGrants`; `executeToolCall()` (comms + inbound gates); `executeAction()` (comms gate check); `buildToolContext()` (env secret injection); `_executeTool()` (provider binding) | Seed, `scripts/sync-tool-grants.mjs` |

Seeded: `kernel:alert_config`, `kernel:llm_fallback`, `kernel:llm_fallback:meta`, `kernel:fallback_model`, `kernel:tool_grants` (5 keys).

**Security note:** `kernel:tool_grants` is the single source of truth for tool security classification at runtime. Tool source files (`tools/*.js`) declare all fields in `export const meta`, but the seed script splits them: grant fields (`secrets`, `communication`, `inbound`, `provider`) go to `kernel:tool_grants`, operational fields (`kv_access`, `timeout_ms`, `kv_secrets`) go to `tool:{name}:meta`. Because `kernel:*` keys are blocked from both `kvWriteSafe` and `kvWriteGated`, the agent cannot grant itself new env secrets, bypass the communication gate, or bypass inbound content redaction by modifying tool metadata.

---

## Channel adapter keys

| Key | Format | Value | Read by | Written by | Seeded |
|-----|--------|-------|---------|------------|--------|
| `channel:slack:code` | text | Slack adapter source (`channels/slack.js`) — `verify()`, `parseInbound()`, `sendReply()` | `fetch()` in kernel.js — statically imported via index.js | Seed | Yes |
| `channel:slack:config` | JSON | `{ secrets: ["SLACK_BOT_TOKEN"], webhook_secret_env: "SLACK_SIGNING_SECRET" }` | `fetch()` in kernel.js — determines which env vars to resolve | Seed | Yes |

System prefix (`channel:` is not in `SYSTEM_KEY_PREFIXES`).

**NOTE:** `channel:` is NOT in `Kernel.SYSTEM_KEY_PREFIXES`. This means `channel:*` keys are not protected by `kvWriteSafe()` — they are regular keys, not system keys. However, in practice the agent has no reason to write them directly (the orient prompt doesn't expose channel management), and the Proposal Protocol would be the proper path to modify them.

---

## Regular keys

These are not system keys, not kernel-only. Writable via `kvWriteSafe()`. The kernel's `kvWriteGated` gate applies to agent `kv_operations` output in all contexts (act, reflect, deep-reflect).

### Session lifecycle

| Key | Format | Value | Read by | Written by |
|-----|--------|-------|---------|------------|
| `session_counter` | JSON | Monotonically increasing integer | `getSessionCount()`, reflect scheduling | `writeSessionResults()` in act.js via `kvWriteSafe`, `runMinimalFallback()` via kernel `kvWrite` |
| `cache:session_ids` | JSON | Array of all session IDs (appended each session) | `gatherReflectContext()` in reflect.js, Dashboard API (`GET /sessions`) | `writeSessionResults()` via `kvWriteSafe` |
| `session_schedule` | JSON | `{ next_session_after, interval_seconds, effort?, ... }` | `wake()` in act.js — schedule check; Dashboard API (`GET /health`) | `writeSessionResults()`, `executeReflect()`, `applyReflectOutput()` (depth 1) via `kvWriteSafe` |
| `last_reflect` | JSON | Most recent reflect output: `{ session_summary, note_to_future_self, next_orient_context?, session_id, was_deep_reflect? }` | `wake()` in act.js — provides context to orient; Dashboard API (`GET /health`) | `executeReflect()`, `applyReflectOutput()` (depth 1) via `kvWriteSafe` |
| `last_danger` | JSON | `{ t, event, session_id }` — last danger signal | `runCircuitBreaker()` in kernel.js (proposal methods) | `karmaRecord()` in kernel.js (kernel internal) |
| `identity:did` | JSON | `{ did, address, chain_id, chain_name, registry, ... }` | Agent via `kv_query` tool | Seed |

**NOTE:** `last_danger` is written by kernel internal `this.kvWrite()` but read by hook code via `K.kvGet()`. It is not a system key (no matching prefix), so `kvDeleteSafe()` can delete it — and `runCircuitBreaker()` does exactly that via `K.kvDeleteSafe("last_danger")`.

### Karma logs (`karma:*`)

| Key pattern | Format | Value | Read by | Written by |
|-------------|--------|-------|---------|------------|
| `karma:{sessionId}` | JSON | Array of karma entries: `{ t, elapsed_ms, event, ...event_fields }` | `executeReflect()` via `K.getKarma()`, `detectCrash()` via `K.kvGet()`, Dashboard API (`GET /sessions`) | `karmaRecord()` — kernel internal `this.kvWrite()`, appends and persists on every entry |

Not a system key. Not seeded. Accumulates across the session. The session's karma is also available in-memory via `this.karma` / `K.getKarma()`.

### Karma summaries (`karma_summary:*`)

| Key pattern | Format | Value | Read by | Written by |
|-------------|--------|-------|---------|------------|
| `karma_summary:{sessionId}` | JSON | `{ events, total_cost, models, tools, duration_ms: { total, count }, errors, comms }` | Deep reflect via `kv_query` tool for efficient session investigation | `writeSessionResults()` in act.js via `kvWriteSafe` |

Not a system key. Not seeded. Deterministic summary of a session's karma — event counts, LLM costs by model, tool usage, duration stats, error messages, comms activity. Cheaper to load than full karma arrays for pattern observation across many sessions. Only written for orient sessions (not deep reflect sessions).

### Reflection outputs (`reflect:*`)

| Key pattern | Format | Value | Read by | Written by |
|-------------|--------|-------|---------|------------|
| `reflect:0:{sessionId}` | JSON | `{ reflection, note_to_future_self, depth: 0, session_id, timestamp }` | Not directly read (depth 0 outputs feed into `last_reflect`) | `executeReflect()` via `kvWriteSafe` |
| `reflect:{depth}:{sessionId}` | JSON | `{ reflection, note_to_future_self, depth, session_id, timestamp, current_intentions?, proposal_observations? }` | `loadReflectHistory()` for both depth N-1 outputs (belowOutputs) and same-depth history (priorReflections); Dashboard API (`GET /reflections` reads `reflect:1:*`) | `applyReflectOutput()` via `kvWriteSafe` |
| `reflect:schedule:{depth}` | JSON | `{ after_sessions, after_days, reason, last_reflect, last_reflect_session }` | `isReflectDue()` in reflect.js | `applyReflectOutput()` via `kvWriteSafe` |

Not system keys (the `reflect:` prefix is not in `SYSTEM_KEY_PREFIXES`). Not seeded.

### Chat state (`chat:state:*`)

| Key pattern | Format | Value | Read by | Written by |
|-------------|--------|-------|---------|------------|
| `chat:state:{channel}:{chatId}` | JSON | `{ messages[], total_cost, created_at, turn_count, last_activity }` | `handleChat()` in hook-chat.js | `handleChat()` via `kvWriteSafe` (save after each turn), `kvDeleteSafe` (on `/clear` command) |

Not a system key. Not seeded. Trimmed to `max_history_messages` (default 40) on each save.

### Deduplication (`dedup:*`)

| Key pattern | Format | Value | Read by | Written by |
|-------------|--------|-------|---------|------------|
| `dedup:{msgId}` | text | `"1"` | `fetch()` in kernel.js and index.js — checked before processing inbound chat | `fetch()` via raw `kv.put()` with `expirationTtl: 60` (60-second TTL) |

Not a system key. Not seeded. Short-lived (60s TTL). Prevents Slack retry duplicate processing.

### Tool data (`tooldata:*`)

| Key pattern | Format | Value | Read by | Written by |
|-------------|--------|-------|---------|------------|
| `tooldata:{toolName}:{key}` | text or JSON | Tool-scoped data | `ScopedKV.get()` — tools with `kv_access: "own"` read their own namespace; tools with broader access can read any non-sealed key | `ScopedKV.put()` — always scoped to `tooldata:{toolName}:*` regardless of `kv_access` |

Not a system key. Not seeded. Created by tools at runtime via `kv_write` tool or `ScopedKV.put()`.

---

## Prefix scan table

Which prefixes are listed where, by which code, and why.

| Prefix scanned | Scanned by | Method | Purpose |
|----------------|-----------|--------|---------|
| `proposal:` | `wake()` in act.js | `K.kvList({ prefix, limit: 200 })` | Initialize proposal tracking arrays at session start |
| `proposal:` | `wake()` in act.js | `K.kvList({ prefix, limit: 200 })` | Initialize proposal tracking arrays at session start |
| `yama:` | `loadYamasNiyamas()` in kernel.js | `this.kvListAll({ prefix })` | Load all yama principles into memory at boot |
| `niyama:` | `loadYamasNiyamas()` in kernel.js | `this.kvListAll({ prefix })` | Load all niyama principles into memory at boot |
| `contact:` | `resolveContact()` in kernel.js | `this.kvListAll({ prefix: "contact:" })` | Full scan on contact index cache miss |
| `samskara:` | `loadSamskaraManifest()` in reflect.js | `K.kvList({ prefix, limit: 200 })` | Build samskara manifest for reflect context (all depths) |
| `comms_blocked:` | `listBlockedComms()` in kernel.js | `this.kvListAll({ prefix })` | List all queued blocked communications for deep reflect |
| `reflect:{depth}:` | `loadReflectHistory()` in reflect.js | `K.kvList({ prefix, limit })` | Load recent reflect outputs for belowOutputs and priorReflections context |
| `desire:` | `gatherReflectContext()` in reflect.js | `K.kvList({ prefix, limit: 200 })` | Load desire entries for deep reflect context |
| `reflect:1:` | Dashboard API (`GET /reflections`, `GET /sessions`) | `kvListAll(env.KV, { prefix })` | List deep reflections for public display and session discovery |
| `karma:` | Dashboard API (`GET /sessions`) | `kvListAll(env.KV, { prefix })` | Discover all sessions (ground truth) |
| `sealed:quarantine:` | Dashboard API (`GET /quarantine`) | `kvListAll(env.KV, { prefix })` | List quarantined inbound messages for patron review |
| `git_pending:` | `retryPendingGitSyncs()` in kernel.js (proposal methods) | `K.kvList({ prefix, limit: 50 })` | Find and retry failed git sync operations |
| `tooldata:{toolName}:` | `ScopedKV.list()` (kv_access: "own") | `this.env.KV.list({ prefix })` | Tool listing its own namespaced keys |
| (any prefix) | `kv_manifest` tool, Dashboard API (`GET /kv`) | `kv.list(opts)`, `kvListAll(env.KV, { prefix })` | General-purpose key exploration |

---

## Seed audit

The seed script (`scripts/seed-local-kv.mjs`) produces **73 keys** total:

### Static keys (50)

| # | Key | Category |
|---|-----|----------|
| 1 | `identity:did` | Identity |
| 2 | `config:defaults` | Config |
| 3 | `config:models` | Config |
| 4 | `config:model_capabilities` | Config |
| 5 | `config:resources` | Config |
| 6 | `providers` | Config |
| 7 | `wallets` | Config |
| 8 | `config:tool_registry` | Config |
| 9 | `prompt:orient` | Prompts |
| 10 | `prompt:subplan` | Prompts |
| 11 | `prompt:reflect` | Prompts |
| 12 | `prompt:reflect:1` | Prompts |
| 13 | `prompt:chat` | Prompts |
| 14 | `dharma` | Identity |
| 15 | `yama:care` | Principles |
| 16 | `yama:truth` | Principles |
| 17 | `yama:responsibility` | Principles |
| 18 | `yama:discipline` | Principles |
| 19 | `yama:rules` | Principles |
| 20 | `yama:security` | Principles |
| 21 | `yama:humility` | Principles |
| 22 | `niyama:health` | Principles |
| 23 | `niyama:acceptance` | Principles |
| 24 | `niyama:transformation` | Principles |
| 25 | `niyama:reflection` | Principles |
| 26 | `niyama:alignment` | Principles |
| 27 | `niyama:nonidentification` | Principles |
| 28 | `niyama:organization` | Principles |
| 29 | `hook:act:code` | Hooks |
| 30 | `hook:reflect:code` | Hooks |
| 34 | `channel:slack:code` | Channels |
| 35 | `channel:slack:config` | Channels |
| 36 | `kernel:alert_config` | Kernel |
| 37 | `kernel:llm_fallback` | Kernel |
| 38 | `kernel:llm_fallback:meta` | Kernel |
| 39 | `kernel:fallback_model` | Kernel |
| 40 | `kernel:tool_grants` | Kernel |
| 41 | `doc:design_rationale` | Docs |
| 42 | `doc:threat_model` | Docs |
| 43 | `doc:patron` | Docs |
| 44 | `doc:setup_guide` | Docs |
| 45 | `contact:swami_kevala` | Contacts |
| 46 | `patron:contact` | Identity |
| 47 | `patron:public_key` | Identity |
| 48 | `skill:model-config` | Skills |
| 49 | `skill:model-config:ref` | Skills |
| 50 | `skill:skill-authoring` | Skills |

### Loop-generated keys (24)

| # | Key pattern | Count | Category |
|---|------------|-------|----------|
| 48–55 | `provider:{name}:code` | 4 (llm, llm_balance, wallet_balance, gmail) | Providers |
| 56–63 | `provider:{name}:meta` | 4 | Providers |
| 64–72 | `tool:{name}:code` | 9 (send_slack, web_fetch, kv_write, kv_manifest, kv_query, computer, check_email, send_email, test_model) | Tools |

**Wait — that's only 67.** The tool loop also seeds `tool:{name}:meta` for each tool:

| # | Key pattern | Count | Category |
|---|------------|-------|----------|
| 67–75 | `tool:{name}:code` | 9 | Tools |
| 76–84 | `tool:{name}:meta` | 9 | Tools |

**Corrected total: 50 static + 8 provider pairs + 18 tool pairs = 76 keys.**

### Keys NOT seeded (created at runtime)

| Key | Created by | When |
|-----|-----------|------|
| `patron:identity_snapshot` | `loadPatronContext()` | First boot |
| `contact_platform:*` | `resolveContact()`, Dashboard API | First contact resolution / platform approval |
| `kernel:active_session` | `executeHook()` | Every session start |
| `kernel:last_sessions` | `updateSessionOutcome()` | Every session end |
| `kernel:hook_dirty` | `kvWriteGated()` | When hook keys are written |
| `kernel:last_good_hook` | `updateSessionOutcome()` | After first clean session |
| `provider:llm:last_working:code` | `callWithCascade()` | After first successful LLM call (prod only) |
| `provider:llm:last_working:meta` | `callWithCascade()` | After first successful LLM call (prod only) |
| `karma:*` | `karmaRecord()` | Every session |
| `session_counter` | `writeSessionResults()` | Every session |
| `cache:session_ids` | `writeSessionResults()` | Every session |
| `session_schedule` | `writeSessionResults()` | Every session |
| `last_reflect` | `executeReflect()` / `applyReflectOutput()` | Every reflect |
| `last_danger` | `karmaRecord()` | On danger signals |
| `reflect:*:*` | `executeReflect()` / `applyReflectOutput()` | Every reflect |
| `reflect:schedule:*` | `applyReflectOutput()` | After deep reflect |
| `proposal:*` | `stageModification()` | When proposals proposed |
| `proposal:*` (snapshot) | `acceptStaged()` / `acceptDirect()` | When proposals accepted |
| `git_pending:*` | `syncToGit()` | When proposals promoted |
| `comms_blocked:*` | `queueBlockedComm()` | When communications blocked/queued |
| `sealed:quarantine:*` | Inbound content gate | When unknown sender content redacted |
| `chat:state:*` | `handleChat()` | On first chat message |
| `dedup:*` | `fetch()` | On inbound chat (30s TTL) |
| `tooldata:*` | `ScopedKV.put()` / `kv_write` tool | When tools store data |
| `yama:*:audit` / `niyama:*:audit` | `kvWriteGated()` | When principles modified |
| `samskara:*` / `desire:*` | Deep-reflect `kv_operations` | When cognitive memory written/updated |
| `secret:*` | Proposal Protocol | When agent provisions secrets |
