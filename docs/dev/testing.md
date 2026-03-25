# Test Architecture

All tests run locally with Vitest — no network, no Workers runtime, no
Cloudflare API calls. 339 tests across 4 suites.

```bash
npm test          # vitest run — all tests
```

---

## Framework

**Vitest v3.0.0** — configured in `vitest.config.js`:

```js
export default defineConfig({
  test: {
    alias: {
      "cloudflare:workers": path.resolve("__mocks__/cloudflare-workers.js"),
    },
  },
});
```

The alias maps the `cloudflare:workers` import (used by `kernel.js` for
`base class`) to a stub that exports an empty class.

---

## Mock System

### __mocks__/cloudflare-workers.js

```js
export class base class {}
```

Minimal stub. `kernel.js` extends `base class` for `ScopedKV` and
`K interface` — tests never exercise the actual CF RPC mechanism, so the
stub is sufficient.

### tests/helpers/mock-kv.js — makeKVStore(initial)

Map-based KV store that implements the Cloudflare KV API surface:

| Method | Behavior |
|--------|----------|
| `get(key, format)` | Returns stored value. If `format === "json"`: parses JSON. Otherwise returns raw string. Returns `null` for missing keys. |
| `put(key, value, opts)` | Stores string value + optional metadata from `opts.metadata` |
| `delete(key)` | Removes key and metadata |
| `list(opts)` | Returns `{ keys: [...], list_complete }`. Supports `prefix` filtering and `limit`. Keys include `name` and `metadata`. |
| `getWithMetadata(key, format)` | Returns `{ value, metadata }` with same format handling as `get` |

All methods are `vi.fn()` spies. Internal state exposed via `_store` (Map)
and `_meta` (Map) for test assertions.

### tests/helpers/mock-kernel.js — makeMockK(kvInit, opts)

Full mock of the `K interface` interface. Returns an object with every
method that hook code calls via `K.*`.

**KV operations:**
- `kvGet(key)` — reads from internal KV, parses JSON
- `kvGetWithMeta(key)` — includes metadata
- `kvList(opts)` — prefix + limit filtering
- `kvWriteSafe(key, value, metadata)` — writes with metadata
- `kvDeleteSafe(key)` — deletes key
- `kvWriteGated(op, context)` — handles `put`, `delete`, and `patch` ops
  with context-based permissions. Returns `{ok: true}` or `{ok: false, error}`.

**Agent loop:**
- `runAgentLoop()` → `{}`
- `executeToolCall()` → `{}`
- `buildToolDefinitions()` → `[]`
- `executeAction()` → `{}`
- `spawnSubplan()` → `{}`

**Communication:**
- `listBlockedComms()` → `[]`
- `processCommsVerdict()` → `{ ok: true }`

**State getters:** `getSessionId`, `getSessionCost`, `getKarma`,
`getDefaults`, `getModelsConfig`, `getDharma`, `getToolRegistry`,
`getYamas`, `getNiyamas`, `getPatronId`, `getPatronContact`,
`isPatronIdentityDisputed`, `getSessionCount` — all return values from
the `opts` parameter, with sensible defaults.

**Utilities:**
- `resolveModel(m)` — returns input as-is
- `buildPrompt(t, v)` — returns template or stringified vars
- `isSystemKey(key)` — checks against `SYSTEM_KEY_PREFIXES` and
  `SYSTEM_KEY_EXACT`
- `getSystemKeyPatterns()` — returns both lists
- `resolveContact()` → `null`
- `checkBalance()` → `{ providers: {}, wallets: {} }`
- `loadKeys(keys)` — batch loads from internal KV

Internal KV exposed via `_kv` for direct assertions.

---

## Test Suites

### tests/kernel.test.js — 171 tests

Tests the kernel (`Kernel` class) directly. Uses a `makeBrain(kvInit, opts)`
helper that constructs a real `Kernel` instance with a mock KV store
and environment.

**Core parsing and output:**
- `parseAgentOutput` (6 tests) — valid JSON, invalid JSON (raw fallback),
  empty/null content, markdown code fence extraction, JSON extraction
  from prose
- `_extractJSON` (8 tests) — code fence variants, nested braces, escaped
  quotes, real-world reflect output

**Tool system:**
- `buildToolDefinitions` (4 tests) — registry mapping, spawn_subplan
  always included, null registry handling, extraTools passthrough
- `executeToolCall` (2 tests) — spawn_subplan routing, other tool routing
- `executeAction` (2 tests) — tool code/meta loading, missing tool error
- `executeToolCall with hooks` (4 tests) — pre-validate reject/correct,
  post-validate reject, garbled arguments

**LLM and agent loop:**
- `callLLM` (6 tests) — system prompt, dharma injection, tool passing,
  toolCalls return, fallback model retry
- `callViaKernelFallback` (3 tests) — no fallback error, adapter
  execution, invalid response rejection
- `runAgentLoop` (4 tests) — single turn, tool loop, max steps, parallel
  tools
- `callLLM budget enforcement` (4 tests) — cost limit, duration limit,
  accumulation, under-budget pass
- `runAgentLoop budget handling` (2 tests) — graceful catch, non-budget
  rethrow
- `runAgentLoop parse error retry` (2 tests) — single retry on parse
  error

**KV protection:**
- `isSystemKey / isKernelOnly` (3 tests) — prefix recognition, exact key
  recognition, non-system rejection
- `kvWriteSafe` (2 tests) — blocks dharma, blocks system keys
- `kvDeleteSafe` (2 tests) — blocks dharma + system, allows non-system
- `kvWriteGated` (3 tests) — blocks immutable keys, allows system
  with snapshot, rate limit enforcement
- `Sealed namespace enforcement` (3 tests) — system key and kernel-only
  recognition, KV write blocking

**Yamas and Niyamas** (27 tests):
- `callLLM` injection of `[YAMAS]`/`[NIYAMAS]` blocks
- `kvWriteGated` deliberation requirements (200 chars yama, 100
  chars niyama)
- Model capability checks (`yama_capable`, `niyama_capable`)
- Audit trail at `{key}:audit`
- Rejects when model lacks capability
- Allows when all gates pass

**Communication gate** (20 tests):
- `resolveCommsMode` — initiating vs responding based on reply_field
- `resolveRecipient` — extraction from args via meta
- Mechanical floor — blocks person + unknown + initiating
- Model gate — queues when not `comms_gate_capable`
- LLM gate verdicts — send, block, revise
- `queueBlockedComm` record creation
- `processCommsVerdict` — send, revise_and_send, drop
- Integration with `executeToolCall` — gate approval flag lifecycle

**Hook safety:**
- `callHook` (4 tests) — null for missing, execution, miss caching, error
  swallowing
- `checkHookSafety` (4 tests) — no history pass, mixed outcomes pass,
  3 consecutive crashes tripwire, auto-restore from snapshot
- `detectPlatformKill` (2 tests) — no-op without active session,
  killed outcome injection
- `updateSessionOutcome snapshot` (3 tests) — first clean snapshot,
  dirty snapshot, skip when not dirty

**Patron identity** (5 tests):
- Identity snapshot creation on first boot
- Dispute detection on name/platform change
- Snapshot fallback during dispute

**Inbound content gate** (5 tests):
- Content redaction from unknown senders
- Quarantine under `sealed:` keys
- Karma recording for redaction
- Known sender passthrough

### tests/wake-hook.test.js — 68 tests

Tests the hook modules (`act.js`, `reflect.js`,
`kernel.js (proposal methods)`, `kernel.js (kvWriteGated)`) using `makeMockK`.

**Session flow helpers:**
- `buildOrientContext` (1 test) — JSON structure
- `evaluateTripwires` (3 tests) — effort resolution, alert conditions
- `detectCrash` (2 tests) — null without stale session, crash data return
- `writeSessionResults` (1 test) — session_schedule + session_counter
- `getBalances` (1 test) — delegates to checkBalance

**Reflection:**
- `getMaxSteps` (7 tests) — orient/reflect/deep_reflect defaults,
  per-level overrides
- `getReflectModel` (4 tests) — per-level, fallback chain
- `loadReflectPrompt` (3 tests) — depth-specific KV, default fallback
- `isReflectDue` (7 tests) — cold-start, self-scheduled, exponential
  depth formula
- `highestReflectDepthDue` (3 tests) — highest due depth, zero when none
- `applyReflectOutput` (3 tests) — kv_operations, history storage,
  depth-1 last_reflect
- `loadReflectHistory` (2 tests) — prefix list, count limit
- Default prompts (3 tests) — structure, no dharma (kernel-injected)

**Modifications:**
- `evaluatePredicate` (5 tests) — exists, equals, gt, lt, matches, type
- `runCircuitBreaker` (1 test) — no-op without last_danger
- `patch op in mock kernel` (4 tests) — replace, not found, ambiguous,
  non-string
- `kvWriteGated blocks yama/niyama` (2 tests) — system key rejection
- `acceptStaged with patch op` (1 test) — forwards to kvWriteGated

**Budget:**
- `runSession reflect_reserve_pct` (5 tests) — budgetCap passing, soft-cap
  vs hard-cap reflect skip
- `runReflect budget_multiplier` (3 tests) — multiplier application

**Communication in reflect:**
- Blocked comms in context (3 tests) — loading, `(none)` formatting,
  verdict processing
- Patron context in reflect (2 tests) — loaded and fallback

### tests/tools.test.js — 84 tests

Tests every tool and provider module by importing and calling `execute`
directly with mock dependencies.

**Module structure** (16 tests):
- Every tool exports `meta` with `timeout_ms`, `secrets`, `kv_access`
- Every tool exports `execute` function
- Every provider exports `meta` with `secrets`, `timeout_ms`
- Every provider exports a callable function (`call`/`check`)

**module structure compatibility** (16 tests):
- No `export default` in any tool file (8 tools)
- No `export default` in any provider file (4 providers)
- No `export default` in `channels/slack.js`

**Tool tests:**
- `send_slack` (1 test) — API call with token + channel
- `web_fetch` (2 tests) — fetch + truncation
- `computer` (5 tests) — command execution, custom timeout, missing
  command, fetch failure, non-ok response
- `kv_write` (2 tests) — string write, object stringify
- `kv_manifest` (4 tests) — default limit, prefix, custom limit, 500 cap
- `kv_query` (12 tests) — missing key/value errors, path navigation,
  array/object summaries, out-of-bounds, available_keys hint, bad syntax,
  small object passthrough

**Email tools:**
- `check_email` (14 tests) — empty inbox, full fetch with fields,
  max_results cap, mark_read, token/list failures, multipart extraction,
  HTML fallback
- `send_email` (15 tests) — new email, RFC 2822 headers, reply threading,
  missing field validation, Re: prefix handling, In-Reply-To/References,
  subject override, token/send failures

**Providers:**
- `provider:llm_balance` (1 test) — limit_remaining return
- `provider:wallet_balance` (1 test) — USDC balance calculation
- `provider:gmail` (10 tests) — getAccessToken, listUnread, getMessage,
  sendMessage, markAsRead, check

**Channel:**
- `channel:slack` (8 tests) — config declaration, HMAC verify, replay
  protection, parseInbound (message + command + bot + subtype), sendReply

### tests/chat.test.js — 16 tests

Tests `handleChat` from `hook-chat.js` with a mock kernel (real
`makeMockK`) and mock adapter.

**Core pipeline** (12 tests):
- Reply via adapter
- Conversation state persistence
- `/reset` refills budget, keeps messages
- `/clear` wipes state
- Budget limit enforcement
- Tool call execution mid-conversation
- History trimming (sliding window)
- Independent conversations per chatId
- Karma recording per turn
- `(no response)` fallback on max rounds
- Contact in system prompt
- Cost accumulation across tool-calling rounds

**Unknown contact filtering** (4 tests):
- Empty tools for unknown contacts
- `inbound_unknown` karma event
- Full tools for known contacts
- Allowlist filtering when configured

---

## Test Patterns

### Factory helpers

Each suite uses factory functions to create test fixtures:

- `makeBrain(kvInit, opts)` — kernel.test.js: real `Kernel` with
  mock KV
- `makeState(overrides)` — wake-hook.test.js: state object for hook
  functions
- `makeMockK(kvInit, opts)` — mock-kernel.js: mock K interface for hook
  and chat tests
- `makeAdapter()` — chat.test.js: `{ sendReply: vi.fn() }`

### Common assertions

- `expect(kv._store.get(key))` — direct KV state inspection
- `expect(fn).toHaveBeenCalledWith(...)` — mock call verification
- `expect(result).rejects.toThrow(...)` — error path testing
- `K.karmaRecord` call inspection for event logging verification

### Modification tracking

`wake-hook.test.js` calls `initTracking([], [])` in `beforeEach` to reset
the module-level `activeStaged`/`activeInflight` arrays between tests.

---

## Adding Tests

### For a new tool

1. Add module structure tests in `tools.test.js` (meta exports,
   module structure compatibility)
2. Add execution tests with a mock `fetch` and mock `kv` (if applicable)
3. If the tool has `communication` meta: add comms gate tests in
   `kernel.test.js`
4. If the tool has `inbound` meta: add inbound gate tests in
   `kernel.test.js`

### For new kernel behavior

Add tests in `kernel.test.js` using `makeBrain()`. The mock KV
supports pre-seeding via the `kvInit` parameter.

### For new hook logic

Add tests in `wake-hook.test.js` using `makeMockK()`. Pre-seed KV state
via `kvInit`, configure kernel responses via `opts`.

### For chat changes

Add tests in `chat.test.js`. The mock kernel's `callLLM` and
`resolveContact` can be overridden per-test.

---

## Known Mock Limitations

- Tool tests call `execute` directly — same pattern as the runtime, which
  uses static imports and direct function calls.
- `makeMockK.runAgentLoop` returns `{}` — tests for hook code that depends
  on specific agent loop output (e.g. reflect output parsing) must
  override this mock per-test.
- `makeMockK.resolveContact` always returns `null` — tests that need known
  contacts must override this mock.
- The `callWithCascade` three-tier provider cascade is not fully tested —
  the cascade logic involves KV reads and multiple adapter calls that
  require integration-level testing.
