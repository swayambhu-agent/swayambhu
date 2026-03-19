# LLM Provider System

How LLM calls are routed, how providers fail over, and how non-LLM providers work.

---

## Overview

There are two distinct provider paths in the system:

1. **LLM provider cascade** — used by `callLLM()` for all LLM inference. Three-tier failover in production, direct fetch in dev.
2. **Non-LLM providers** — used by `executeAdapter()` for balance checks and by tools via `meta.provider` for service integrations (Gmail). No cascade. Single adapter per call.

Both paths share the same execution primitive: load code + meta from KV, build a secrets context, run in a Worker Loader isolate (prod) or call directly (dev).

---

## LLM provider cascade (production)

`callWithCascade()` at `brainstem.js:1506`. Called by `callLLM()` for every LLM inference request.

```
callLLM()
│ Budget check (cost + duration)
│ Prepend dharma + principles to system prompt
│ Resolve model family + check supports_reasoning via config:models
│ Build standardized request { model, max_tokens, messages, family, effort, tools? }
│
▼
callWithCascade(request, step)
│
├─► Tier 1: Dynamic adapter
│   callViaAdapter("llm", request)
│   │ Load provider:llm:code + provider:llm:meta from KV
│   │ runAdapter() → runInIsolate() with 60s timeout
│   │
│   ├── Success:
│   │   Auto-snapshot (once per session):
│   │     Copy provider:llm:code → provider:llm:last_working:code
│   │     Copy provider:llm:meta → provider:llm:last_working:meta
│   │     Set this.lastWorkingSnapshotted = true
│   │   Return { ...result, tier: "dynamic" }
│   │
│   └── Failure:
│       Record provider_fallback karma (from: "dynamic", to: "last_working")
│       Fall through to Tier 2
│
├─► Tier 2: Last working adapter
│   callViaAdapter("llm:last_working", request)
│   │ Load provider:llm:last_working:code + meta from KV
│   │ runAdapter() → runInIsolate()
│   │
│   ├── Success: Return { ...result, tier: "last_working" }
│   │
│   └── Failure:
│       Record provider_fallback karma (from: "last_working", to: "hardcoded")
│       Fall through to Tier 3
│
├─► Tier 3: Kernel fallback
│   callViaKernelFallback(request)
│   │ Load kernel:llm_fallback + kernel:llm_fallback:meta from KV
│   │ runAdapter() → runInIsolate()
│   │
│   ├── Success: Return { ...result, tier: "kernel_fallback" }
│   │
│   └── Failure: Return { ok: false, tier: "all_failed" }
│
▼
[callWithCascade returned]
│
├── ok: true → record karma, track cost, return
│
└── ok: false →
    Model fallback (separate from provider fallback):
      getFallbackModel() → config:models.fallback_model || kernel:fallback_model
      If fallbackModel exists and differs from current model:
        Recursive callLLM() with fallbackModel, effort: "low"
      Else:
        throw "LLM call failed on all providers"
```

### Tier details

#### Tier 1: Dynamic adapter (`provider:llm:code`)

- **KV keys:** `provider:llm:code` (source), `provider:llm:meta` (metadata)
- **Protection:** System prefix — writable via `kvWritePrivileged()` only (Modification Protocol)
- **Who can modify:** The agent, via staged modifications approved by deep reflect
- **Seeded with:** `providers/llm.js` — OpenRouter chat completions adapter
- **Timeout:** `meta.timeout_ms` or 60000ms default

The agent can modify this adapter through the Modification Protocol. If a modification breaks the adapter, the cascade catches the failure and falls through.

#### Tier 2: Last working snapshot (`provider:llm:last_working:code`)

- **KV keys:** `provider:llm:last_working:code`, `provider:llm:last_working:meta`
- **Protection:** System prefix — same as Tier 1
- **Who writes:** Kernel auto-snapshots from Tier 1 on first success each session
- **Not seeded** — created at runtime after first successful LLM call

Auto-snapshot behavior: on the first successful Tier 1 call in a session, `callWithCascade()` copies the current `provider:llm:code` and `provider:llm:meta` to the `last_working` keys. The flag `this.lastWorkingSnapshotted` prevents redundant snapshots within the same session.

This means: if the agent modifies `provider:llm:code` and the modification works, the working version gets snapshotted. If the modification breaks it, the snapshot from the previous session's working version is still available.

**NOTE:** If the agent modifies `provider:llm:code` mid-session after the snapshot has already been taken, Tier 2 will still have the pre-modification version from earlier in the same session. The snapshot is taken once, not updated on each success.

#### Tier 3: Kernel fallback (`kernel:llm_fallback`)

- **KV keys:** `kernel:llm_fallback` (source), `kernel:llm_fallback:meta` (metadata)
- **Protection:** Kernel-only — `kernel:` prefix is in `KERNEL_ONLY_PREFIXES`. Both `kvPutSafe()` and `kvWritePrivileged()` reject writes to `kernel:*` keys.
- **Who can modify:** Only humans, via seed script or direct KV access
- **Seeded with:** `providers/llm.js` — identical to Tier 1's initial content
- **Purpose:** Last resort. If the agent breaks both Tier 1 and Tier 2, this human-managed copy ensures LLM access is never permanently lost.

The agent cannot modify Tier 3. It requires direct human intervention (re-seeding or manual KV write).

### Model fallback

Separate from the provider cascade. If all three provider tiers fail (cascade returns `{ ok: false }`), `callLLM()` attempts a **model-level fallback**:

```
getFallbackModel()                                brainstem.js:2029
│ Check config:models.fallback_model
│ If not found: check kernel:fallback_model
│ Return model ID or null
```

If a fallback model exists and differs from the current model, `callLLM()` recurses with:
- `model: fallbackModel`
- `effort: "low"` (forced downgrade)
- All other parameters preserved

This handles the case where the provider is fine but the specific model is down or misconfigured.

**Seeded values:**
- `config:models.fallback_model` = `"anthropic/claude-haiku-4.5"`
- `kernel:fallback_model` = `"anthropic/claude-haiku-4.5"` (same, but kernel-only protected)

The agent can modify `config:models.fallback_model` via the Modification Protocol. It cannot modify `kernel:fallback_model`.

---

## Model alias resolution

`resolveModel()` at `brainstem.js:2025`:

```js
resolveModel(modelOrAlias) {
  return this.modelsConfig?.alias_map?.[modelOrAlias] || modelOrAlias;
}
```

Looks up the input in `config:models.alias_map`. If found, returns the full model ID. If not found, returns the input unchanged (assumed to already be a full ID).

Seeded alias map:

| Alias | Full model ID |
|-------|--------------|
| `opus` | `anthropic/claude-opus-4.6` |
| `sonnet` | `anthropic/claude-sonnet-4.6` |
| `haiku` | `anthropic/claude-haiku-4.5` |
| `deepseek` | `deepseek/deepseek-v3.2` |

Resolution happens at the call site — hooks and chat code pass aliases (e.g., `"sonnet"`), and `resolveModel()` is called before the model ID reaches `callLLM()`. The model ID passed to the provider adapter is always the full ID.

### Cost estimation

`estimateCost()` at `brainstem.js:2035`:

```js
estimateCost(model, usage) {
  const modelInfo = this.modelsConfig?.models?.find(
    m => m.id === model || m.alias === model
  );
  if (!modelInfo) return null;
  return (inputTokens * modelInfo.input_cost_per_mtok
    + outputTokens * modelInfo.output_cost_per_mtok) / 1_000_000;
}
```

Looks up model in `config:models.models` by ID or alias. Uses `input_cost_per_mtok` and `output_cost_per_mtok` from the model entry. Returns `null` if model not in config (cost is then treated as 0 by `callLLM()`).

---

## The standardized request

`callLLM()` builds a standardized request object before passing it to `callWithCascade()`. It looks up the model in `config:models.models` to resolve the `family` and check `supports_reasoning`:

```js
const modelInfo = this.modelsConfig?.models?.find(
  m => m.id === model || m.alias === model
);
const family = modelInfo?.family || null;
const resolvedEffort = (effort && effort !== "none" && modelInfo?.supports_reasoning)
  ? effort : null;
```

Resulting request shape:

```js
{
  model: "anthropic/claude-haiku-4.5",      // full model ID (already resolved)
  max_tokens: 4000,                          // maxTokens param or default 1000
  messages: [                                // system + conversation messages
    { role: "system", content: "[DHARMA]...[/DHARMA]\n\n[YAMAS]...[/YAMAS]\n\n{systemPrompt}" },
    { role: "user", content: "..." },
    ...
  ],
  family: "anthropic",                       // from config:models, null if unknown model
  effort: "high",                            // pass-through if supports_reasoning, null otherwise
  tools: [...]                               // omitted if empty
}
```

The provider adapter receives this plus `{ secrets }`. It applies `family`-specific quirks (e.g., anthropic `cache_control`) and sets `body.reasoning = { effort }` for the unified OpenRouter reasoning parameter. The adapter must return:

```js
{
  content: "string",           // required (can be empty string if toolCalls present)
  usage: { prompt_tokens, completion_tokens, thinking_tokens? },
  toolCalls: [...] | null      // OpenAI-format tool calls
}
```

`runAdapter()` validates the response: if neither `content` (string) nor `toolCalls` (array with length) is present, it throws — triggering cascade fallback.

---

## Non-LLM provider paths

### Balance checks via `executeAdapter()`

`checkBalance()` at `brainstem.js:1179` iterates the `providers` and `wallets` KV records. Each entry has an `adapter` field pointing to a provider key.

```
checkBalance({ scope? })
│
├─► Read "providers" from KV
│   For each entry with an adapter:
│     executeAdapter(config.adapter, {}, secretOverrides)
│       e.g. executeAdapter("provider:llm_balance", {}, ...)
│
├─► Read "wallets" from KV
│   For each entry with an adapter:
│     executeAdapter(config.adapter, {}, secretOverrides)
│       e.g. executeAdapter("provider:wallet_balance", {}, ...)
│
└─► Return { providers: { name: { balance, scope } }, wallets: { name: { balance, scope } } }
```

`executeAdapter()` at `brainstem.js:1167`:
1. Loads `{adapterKey}:code` and `{adapterKey}:meta` from KV
2. Builds tool context (secrets from env + KV)
3. Applies secret overrides (e.g., project-scoped API keys)
4. Calls `_executeTool()` — runs in isolate (prod) or directly (dev)

**No cascade.** If the adapter fails, the error is caught by `checkBalance()` and recorded as `{ balance: null, error }`.

#### Secret overrides

`_resolveSecretOverrides()` at `brainstem.js:1217` supports `"kv:secret:key_name"` values in the provider/wallet config:

```js
// In "providers" KV record:
{ adapter: "provider:llm_balance", secrets: { API_KEY: "kv:secret:project_x_key" } }
```

The `"kv:"` prefix triggers a KV read: `kv:secret:project_x_key` → reads `secret:project_x_key` from KV. This allows different provider instances to use different credentials.

### Seeded balance providers

| KV key | Provider | Adapter | What it checks |
|--------|----------|---------|---------------|
| `providers.openrouter` | `provider:llm_balance` | `providers/llm_balance.js` | OpenRouter API key remaining credits via `GET /api/v1/auth/key` |
| `wallets.base_usdc` | `provider:wallet_balance` | `providers/wallet_balance.js` | Base USDC wallet balance via `eth_call` to USDC contract (tries 3 RPC endpoints) |

### Tool providers via `kernel:tool_grants`

Tools whose `kernel:tool_grants` entry includes a `provider` field receive
the provider module in their execution context. The provider binding is
controlled by the kernel — the agent cannot modify it.

> **NOTE:** Tool source files still declare `provider` in `export const
> meta`, but it is stripped from KV-stored `tool:{name}:meta` at seed time.
> The runtime reads provider bindings exclusively from
> `kernel:tool_grants`.

**In production** (`_executeTool` at `brainstem.js:1245`):
```js
const grant = this.toolGrants?.[toolName];
if (grant?.provider) {
  providerCode = await this.kvGet(`provider:${grant.provider}:code`);
}
return this.runInIsolate({
  moduleCode,          // tool source
  providerCode,        // provider source (if granted)
  ...
});
```

The isolate gets the tool wrapped via `wrapAsModuleWithProvider()`, which adds `import * as provider from "./provider.js"` to the tool module. The tool accesses provider functions via `ctx.provider`.

**In dev** (`_executeTool` override at `brainstem-dev.js:170`):
```js
const grant = this.toolGrants?.[toolName];
if (grant?.provider) {
  ctx.provider = PROVIDER_MODULES[`provider:${grant.provider}`];
}
return TOOL_MODULES[toolName].execute(ctx);
```

The tool gets the provider module object directly on `ctx.provider`.

#### Gmail provider wiring

Two tools have a `provider: "gmail"` grant:

| Tool | Grant `provider` | Uses |
|------|-----------------|------|
| `check_email` | `"gmail"` | `provider.getAccessToken()`, `provider.listUnread()`, `provider.getMessage()`, `provider.markAsRead()` |
| `send_email` | `"gmail"` | `provider.getAccessToken()`, `provider.getMessage()` (for reply threading), `provider.sendMessage()` |

The Gmail provider (`providers/gmail.js`) also exports a `check()` function — but this is not used by these tools. It's the balance-check path: `check()` returns the unread email count. However, Gmail is not registered in the `providers` KV record, so `checkBalance()` never calls it.

**NOTE:** The Gmail provider's `check()` function (returns unread count) is exported but never called at runtime. It's not in the `providers` KV record. If you wanted unread count in balance checks, you'd add a `gmail` entry to `providers`.

---

## Dev mode override

`DevBrainstem` at `brainstem-dev.js:249` replaces `callWithCascade()` entirely:

```js
async callWithCascade(request, step) {
  const body = {
    model: request.model,
    max_tokens: request.max_tokens,
    messages: request.messages,
  };
  // Family adapter map — same as providers/llm.js
  const families = {
    anthropic: (b) => {
      b.cache_control = { type: 'ephemeral' };
    },
  };
  const adapt = request.family ? families[request.family] : null;
  if (adapt) adapt(body);
  if (request.effort) body.reasoning = { effort: request.effort };
  if (request.tools?.length) body.tools = request.tools;

  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    // ... standard OpenRouter call with 60s timeout
  });
  // ... parse response, return { ok, content, usage, toolCalls, tier: "direct" }
}
```

Key differences from production:
- **No cascade** — single fetch, no fallback tiers
- **No isolate** — runs in the same process
- **No auto-snapshot** — `provider:llm:last_working:*` keys are never written
- **No adapter code from KV** — family adapters are inlined (same logic as `providers/llm.js`)
- **60s timeout** via `AbortController`
- **API key from env** — `this.env.OPENROUTER_API_KEY` directly, no secrets resolution
- **Tier is always `"direct"`**

For non-LLM providers, `executeAdapter()` is also overridden (`brainstem-dev.js:156`):

```js
async executeAdapter(adapterKey, input, secretOverrides) {
  const mod = PROVIDER_MODULES[adapterKey];  // imported at top of file
  const ctx = await this.buildToolContext(adapterKey, mod.meta || {}, input);
  if (secretOverrides) Object.assign(ctx.secrets, secretOverrides);
  ctx.fetch = (...args) => fetch(...args);
  const fn = mod.execute || mod.call || mod.check;
  return fn(ctx);
}
```

Direct call to the imported provider module — no KV read, no isolate. The function resolution order is `execute` → `call` → `check`.

---

## Adapter module contract

All provider adapters follow the same pattern. No `export default` (required for `wrapAsModule` compatibility).

### LLM adapter

```js
export const meta = { secrets: ["OPENROUTER_API_KEY"], timeout_ms: 60000 };

const families = {
  anthropic: (body) => {
    body.cache_control = { type: 'ephemeral' };
  },
};

export async function call({ model, messages, max_tokens, effort, family, tools, secrets, fetch }) {
  const body = { model, max_tokens, messages };
  const adapt = family ? families[family] : null;
  if (adapt) adapt(body);
  if (effort) body.reasoning = { effort };
  if (tools) body.tools = tools;
  // ... call external API ...
  return { content, usage, toolCalls };
}
```

Must export `call`. Receives the standardized request plus `secrets` and `fetch`. Must return `{ content, usage, toolCalls }`.

Reasoning uses OpenRouter's unified `reasoning` parameter — works across all providers. The `families` map handles provider-specific quirks only (currently just anthropic `cache_control`). `family` is optional on model entries — only set it when provider-specific adaptation is needed.

### Balance adapter

```js
export const meta = { secrets: ["OPENROUTER_API_KEY"], timeout_ms: 10000 };

export async function check({ secrets, fetch }) {
  // ... check balance ...
  return numericValue;  // or any serializable value
}
```

Must export `check`. Returns the balance value directly (not wrapped).

### Tool provider

```js
export const meta = { secrets: [...], timeout_ms: 15000 };

// Named exports used by tools:
export async function getAccessToken(secrets, fetchFn) { ... }
export async function listUnread(token, fetchFn, maxResults) { ... }
// etc.
```

Exports whatever functions the dependent tools need. The tool accesses them via `ctx.provider.functionName()` (dev) or `provider.functionName()` (prod, via `import * as provider`).

### How `wrapAsModule` works

In production, tool/provider source code is raw — it has named exports but no `export default`. The kernel wraps it:

```js
// wrapAsModule (brainstem.js:1282):
`${rawCode}

const _fn = typeof execute === "function" ? execute
          : typeof call === "function" ? call
          : typeof check === "function" ? check
          : null;

export default {
  async fetch(request, env) {
    const ctx = await request.json();
    ctx.fetch = fetch;
    if (env.KV_BRIDGE) ctx.kv = env.KV_BRIDGE;
    const result = await _fn(ctx);
    return Response.json({ ok: true, result });
  },
};`
```

The wrapper finds the first available function (`execute` > `call` > `check`), adds a `fetch()` handler that accepts JSON context and returns JSON result. If the module has a `provider` dependency, `wrapAsModuleWithProvider` adds `import * as provider from "./provider.js"` and puts `provider` on `ctx`.

**NOTE:** Because `_fn` resolution is `execute` → `call` → `check`, a provider that exports both `call` and `check` (like `providers/llm.js` doesn't, but hypothetically) would only use `call` when invoked via `runInIsolate`. The balance-check path works because `checkBalance()` calls `executeAdapter()` which routes through `_executeTool()` → `runInIsolate()`, and `llm_balance.js` only exports `check`.
