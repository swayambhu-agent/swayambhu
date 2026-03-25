# Testing Strategy

## Layers

### Layer 0: Unit tests (`npm test`)

Fast, no network, no Workers runtime. Uses vitest with mock KV and mock fetch.

**What's tested:**
- Kernel logic (kernel.test.js): parseAgentOutput, buildPrompt, budget
  enforcement, karma recording, tool definitions, session management
- Session hook (wake-hook.test.js): orient context, reflect scheduling, proposal
  system, circuit breaker, tripwire evaluation
- Tools (tools.test.js): each tool's execute() with mock context, module
  structure validation

**What it catches:** Logic bugs, regressions, contract violations between
kernel and hook, broken tool modules.

**Run:** `npm test`

### Layer 1: Dev integration (`wrangler dev -c wrangler.dev.toml`)

Real LLM calls via OpenRouter, direct tool execution (statically imported), real KV.

**What's tested:**
- Full session: orient → tool calls → reflect → session results
- Tool execution with real network (Telegram, web fetch, balance checks)
- KV read/write through actual Wrangler miniflare

**What it catches:** Prompt bugs, LLM interaction issues, tool context
wiring, KV serialization problems.

**Run:**
```bash
source .env && bash scripts/start.sh --reset-all-state --trigger
```

### Layer 2: Prod integration (`wrangler dev` with `wrangler.toml`)

Full runtime with statically compiled modules, provider cascade. Closest
to production.

**What's tested:**
- Static import wiring of all modules
- ScopedKV scoping behavior
- Provider cascade (tier 1 → tier 2 → tier 3 fallback)
- K interface between kernel and hook modules

**What it catches:** Import wiring issues, provider cascade failures,
module integration problems.

**Run:**
```bash
node scripts/seed-local-kv.mjs
source .env
npx wrangler dev --test-scheduled --persist-to .wrangler/shared-state
curl http://localhost:8787/__scheduled
```

## Test helpers

Shared mocks live in `tests/helpers/`:

- `mock-kv.js` — `makeKVStore(initial)`: in-memory KV with get/put/delete/list
- `mock-kernel.js` — `makeMockK(kvInit, opts)`: full KernelRPC mock with
  KV, karma, agent loop, and state getters

## Adding tests

- Tool tests go in `tests/tools.test.js`
- Kernel tests go in `tests/kernel.test.js` (imports from `kernel.js`)
- Session hook tests go in `tests/wake-hook.test.js` (imports from `act.js`, `reflect.js`)
- Use shared helpers from `tests/helpers/` for mocks
