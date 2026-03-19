# Skill: Model Configuration

This skill teaches you to manage LLM models in your own configuration — discovering new models, evaluating them, adding/updating/removing entries in `config:models`, and reassigning model roles in `config:defaults`.

---

## 1. Key Concepts

### Where model state lives

- **`config:models`** — The model registry. Contains the `models` array, `fallback_model`, and `alias_map`.
- **`config:defaults`** — Role assignments. Fields like `orient.model`, `reflect.model`, `deep_reflect.model`, `chat.model` reference models by ID or alias.
- **`config:model_capabilities`** — Per-model capability flags: `yama_capable`, `niyama_capable`, `comms_gate_capable`. When adding a model that should be trusted for ethical/safety modifications or comms gating, this key must be updated too.
- **`provider:llm:code`** — The LLM provider adapter. Handles all models. Reasoning is sent via the unified `body.reasoning = { effort }` path regardless of model. The families map is an optional hook for provider-specific quirks that OpenRouter doesn't normalize — currently only `anthropic` (for `cache_control` injection). Most models need no family entry. You only modify `provider:llm:code` when adding a new family adapter.

### Critical invariants

- **Every model used in config:defaults SHOULD have an entry in config:models.** If it doesn't, `estimateCost()` returns null and the caller (`callLLM()`) falls back to a pessimistic cost estimate (using the most expensive model's rates). Budget tracking still works, but overestimates spend — which may cause premature budget exhaustion. A karma warning is logged.
- **`kernel:fallback_model`** is a kernel-only last-resort fallback (under `KERNEL_ONLY_PREFIXES` — blocked by `kvWritePrivileged()`), separate from `config:models.fallback_model`. The agent can modify the latter but not the former. The brainstem itself can write to kernel-only keys internally, but the agent cannot. Don't confuse the two fallback keys.

### Alias resolution

```
resolveModel(modelOrAlias) → alias_map[x] || x
```

`"haiku"` → `"anthropic/claude-haiku-4.5"`. Full IDs pass through unchanged. Aliases must be unique across the map.

### Protection levels

Both `config:models` and `config:defaults` are **protected keys**. You cannot write to them directly.

| Depth | Can do |
|-------|--------|
| orient (depth 0) | Research models, read config, note findings in session_summary |
| reflect (depth 0) | Stage modification_requests for config changes |
| deep_reflect (depth 1+) | Accept/reject/modify staged changes, or issue inflight changes directly |

---

## 2. Quick Reference

### Read current models
```
kv_query("config:models")
```

### Read current role assignments
```
kv_query("config:defaults", ".orient.model")
kv_query("config:defaults", ".reflect.model")
```

### Fetch model info from OpenRouter
```
web_fetch("https://openrouter.ai/api/v1/models/{id}")
```

### Fetch all models (large response)
```
web_fetch("https://openrouter.ai/api/v1/models", { max_length: 50000 })
```

### Cost conversion formula
```
input_cost_per_mtok  = pricing.prompt     × 1,000,000
output_cost_per_mtok = pricing.completion  × 1,000,000
```

### Required fields for a model entry
`id`, `alias`, `input_cost_per_mtok`, `output_cost_per_mtok`, `max_output_tokens`, `best_for`

### Optional fields
- `family` — only if model needs provider-specific adaptation (currently only `"anthropic"` for cache_control)
- `supports_reasoning` — boolean, set `true` if model supports thinking/reasoning tokens. Kernel checks this at runtime. Technically optional (kernel gracefully handles missing), but **always set it explicitly** to avoid ambiguity.

### Related keys
- **`config:model_capabilities`** — controls `yama_capable`, `niyama_capable`, `comms_gate_capable` per model. When adding a high-capability model that should be trusted for yama/niyama modifications or comms gating, update this key too.
- **`kernel:fallback_model`** — kernel-only last-resort fallback (agent cannot write to `kernel:` prefixed keys). Changing `fallback_model` in `config:models` does NOT change the kernel-only copy.

---

## 3. Discovering Available Models

### Query the OpenRouter model list

```
web_fetch("https://openrouter.ai/api/v1/models", { max_length: 50000 })
```

The full response is very large. Strategies to manage this:

- **If you know the model ID already**, fetch it directly:
  ```
  web_fetch("https://openrouter.ai/api/v1/models/anthropic/claude-sonnet-4.6")
  ```
- **If browsing for new models**, use a large `max_length` and scan the `data` array. Each entry has `id`, `name`, `pricing`, `context_length`, `top_provider`.
- **If looking for a specific provider** (e.g. Google, Meta), scan for ID prefixes like `google/`, `meta-llama/`.

### Mapping OpenRouter fields to config:models schema

| OpenRouter field | config:models field | Transform |
|-----------------|--------------------|-----------|
| `id` | `id` | Direct copy |
| `pricing.prompt` | `input_cost_per_mtok` | **Multiply by 1,000,000** |
| `pricing.completion` | `output_cost_per_mtok` | **Multiply by 1,000,000** |
| `top_provider.max_completion_tokens` | `max_output_tokens` | Direct copy (use `context_length` as fallback) |
| `supported_parameters` | `supports_reasoning` | Set `true` if array contains `"reasoning"`, else `false` |
| _(infer from id prefix)_ | `family` | See §4 below |
| _(your judgment)_ | `alias` | Short unique name |
| _(your judgment)_ | `best_for` | Role guidance based on capability + cost |

⚠️ **Cost conversion is critical.** OpenRouter returns cost *per token*. We store cost *per million tokens*. Getting this wrong by 10⁶ would be catastrophic. Always verify:
- If OpenRouter says `pricing.prompt = 0.000003`, then `input_cost_per_mtok = 3.00`
- If OpenRouter says `pricing.completion = 0.000015`, then `output_cost_per_mtok = 15.00`

---

## 4. Evaluating a New Model

Before proposing a model addition, assess these dimensions:

### 4a. Family (optional)

`family` is only needed when a model requires provider-specific request shaping beyond what OpenRouter normalizes. Most models need no family at all.

Currently the only family adapter is `anthropic`, which injects `cache_control` breakpoints for prompt caching. Anthropic requires explicit cache breakpoints — most other providers (OpenAI, DeepSeek, Gemini 2.5) handle caching implicitly with no code needed.

Rules:
- `anthropic/` models → set `family: "anthropic"` (Anthropic uniquely requires explicit `cache_control` breakpoints in the request body; other providers handle caching server-side automatically)
- All other models → **omit `family`** unless you identify a provider-specific quirk that needs an adapter
- If a new family IS needed, that's a code modification to `provider:llm:code` — flag it explicitly

Don't add a family adapter for reasoning or effort — that's handled by OpenRouter's unified `reasoning` parameter regardless of family.

### 4b. Reasoning support

Does the model support extended thinking / reasoning tokens?

Check the OpenRouter model response: if `"reasoning"` is in the `supported_parameters` array, the model supports it. Set `supports_reasoning: true` in the model entry.

At runtime, the kernel checks `modelInfo.supports_reasoning` to decide whether to send the reasoning parameter. The LLM provider passes it via OpenRouter's unified format:

```json
{ "reasoning": { "effort": "high" } }
```

OpenRouter handles provider-specific translation automatically (Anthropic → `thinking.budget_tokens`, Gemini → `thinkingLevel`, etc.).

**Effort levels**: The tripwire evaluator ranks four levels: `"low"`, `"medium"`, `"high"`, `"xhigh"`. However, the actual effort string in config:defaults is passed straight through to OpenRouter via `body.reasoning = { effort }` — the kernel does not validate it against this list. OpenRouter determines what values are valid for each provider. The tripwire only uses the ranked list to evaluate whether effort was appropriate for the task complexity.

The internal value `"none"` is a sentinel that maps to null (reasoning param not sent) — it is not passed to OpenRouter.

**max_tokens and reasoning budget**: For Anthropic models, OpenRouter currently calculates `thinking.budget_tokens` as a ratio of the per-call `max_tokens` parameter (not the model's `max_output_tokens`). If `max_tokens` is set low (e.g. 1000), even xhigh effort only gets 950 thinking tokens — often insufficient for complex reasoning. When assigning a model to a reasoning-heavy role (reflect, deep_reflect), ensure that `max_output_tokens` in config:defaults for that role is high enough to give the thinking budget meaningful room. Note: this is based on current OpenRouter behavior and may change — verify against their docs if reasoning output seems unexpectedly limited.

**Models without reasoning support**: Set `supports_reasoning: false` or omit it. The reasoning parameter will not be sent.

### 4c. Cost comparison

Compare against current models. Read current config:

```
kv_query("config:models", ".models")
```

Compute cost ratios. Example analysis framework:

```
Candidate: google/gemini-2.5-pro at $1.25/$10.00 per Mtok
vs. sonnet: $3.00/$15.00 per Mtok
→ Input: 58% cheaper. Output: 33% cheaper.
vs. haiku: $1.00/$5.00 per Mtok
→ Input: 25% more expensive. Output: 100% more expensive.
Conclusion: Sits between haiku and sonnet on cost. Worth it only if quality exceeds haiku.
```

### 4d. Role fit assessment

Consider what role(s) this model could fill:

| Role | Needs | Current model |
|------|-------|--------------|
| orient | Fast, cheap, tool-calling reliable | haiku |
| reflect | Good reasoning, moderate cost | sonnet |
| deep_reflect | Best reasoning available | opus |
| chat | Conversational, cost-bounded | sonnet |
| execution fallback | Cheap, reliable | haiku |

A new model is worth adding if it: (a) beats a current model on cost at similar quality, (b) opens a new quality tier, or (c) provides a needed capability (e.g. very long context, vision).

---

## 5. Testing Model Changes

### Using test_model

The `test_model` tool makes a test completion against any model ID via the kernel's LLM provider (with proper secrets access). Use it to verify a model works before committing a config change.

```
test_model({ model_id: "google/gemini-2.5-pro", prompt: "What is 2+2?", max_tokens: 100 })
```

**Parameters:**
- `model_id` — full OpenRouter model ID (required)
- `prompt` — test prompt, max 1000 chars (required)
- `max_tokens` — max output tokens, default 100, max 500 (optional)

**Returns:** `{ success, response_text, usage: { prompt_tokens, completion_tokens }, latency_ms, error }`

**Cost note:** `test_model` calls bypass `callLLM()` and are not tracked in session cost. The hard caps (500 output tokens, 1000 char prompt) keep worst-case spend trivial (~$0.01 per call).

### Testing workflow

1. Fetch model info from OpenRouter — verify it exists and get pricing
2. Run `test_model` with a simple prompt — verify it completes successfully
3. Check the response: does it look coherent? Is latency acceptable?
4. Check `usage` — do token counts look reasonable? Cross-check against pricing to estimate real costs.
5. If the model passes, proceed to add it to config:models via modification request
6. After the first real session using the model, reflect should check karma logs for errors, cost anomalies, or degraded quality

---

## 6. Reference

The detailed reference is in `skill:model-config:ref`. **Load that key before constructing any modification_request.**

```
kv_query("skill:model-config:ref")
```

It covers:

- **§1. Adding a New Model** — Constructing model entries, formulating modification requests, patch anchor strategy, serialization matching, adding new family adapters
- **§2. Updating an Existing Model** — Pricing updates, model deprecation/retirement workflow
- **§3. Changing Model Role Assignments** — Cost-quality tradeoff framework, formulating config:defaults patches
- **§4. Retiring a Model** — Retirement checklist, model_capabilities write gate, example retirement patch
- **§5. Handling Failures** — Tripwire behavior, post-deployment monitoring, stale pricing detection, patch operation failures

⚠️ The reference doc contains critical details about patch serialization, write gates, and safety mechanisms. Do not construct modification_requests from memory — always load and follow the reference.
