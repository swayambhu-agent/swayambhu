# Prompt: Design the model-config skill for Swayambhu

Use this prompt in a fresh Claude conversation to design the skill.

---

## Your task

Design an Agent Skill called `model-config` for an autonomous agent called Swayambhu. This skill teaches the agent how to research, evaluate, add, update, and select LLM models in its own configuration. The agent will use this skill when it hears about new model releases, notices a model performing poorly, wants to optimize costs, or needs to evaluate whether a different model would serve better for a specific role.

The output should be a single KV value (JSON object) matching the skill schema below, with the `instructions` field containing the full SKILL.md-style markdown body. The instructions should be detailed enough that an agent with no prior knowledge of model configuration could follow them to successfully add a new model.

---

## What Swayambhu is

Swayambhu is an autonomous agent that runs on a wake/reflect cycle. It wakes up, orients itself (decides what to do), acts using tools, then reflects on what happened. Reflections at depth 0 happen every session. Deep reflections (depth 1+) happen periodically and can modify the agent's own configuration, prompts, and code.

All state lives in a KV store. The agent reads and writes KV keys. Some keys are protected (config, prompts, principles) and can only be changed through the Modification Protocol — a staged review process where reflect proposes changes and deep reflect accepts/rejects them.

The agent calls LLMs via OpenRouter. It has a `web_fetch` tool for HTTP requests and `kv_query` / `kv_manifest` tools for reading its own state.

---

## Skill schema

```json
{
  "name": "model-config",
  "description": "Research, evaluate, add, update, or remove LLM models in config:models. Use when new models are released, pricing changes, a model underperforms, or cost optimization is needed. Covers OpenRouter API discovery, schema validation, test calls, and model role assignment.",
  "instructions": "... (the full markdown body — this is the main deliverable) ...",
  "tags": ["infrastructure", "self-maintenance"],
  "tools_used": ["web_fetch", "kv_query", "kv_manifest"],
  "trigger_patterns": [
    "new model released",
    "model performing poorly",
    "cost optimization",
    "model selection",
    "update config:models",
    "cheaper model",
    "better model"
  ],
  "created_by_depth": null,
  "created_at": null,
  "revision": 1
}
```

---

## The config:models schema (current state)

This is what `config:models` looks like in KV. The skill must teach the agent to maintain this structure:

```json
{
  "models": [
    {
      "id": "anthropic/claude-opus-4.6",
      "alias": "opus",
      "family": "anthropic",
      "effort_map": {
        "low": "low",
        "medium": "medium",
        "high": "high",
        "max": "max"
      },
      "input_cost_per_mtok": 5.00,
      "output_cost_per_mtok": 25.00,
      "max_output_tokens": 128000,
      "best_for": "Strategy, novel situations, full situational awareness, deep reflection"
    },
    {
      "id": "anthropic/claude-sonnet-4.6",
      "alias": "sonnet",
      "family": "anthropic",
      "effort_map": { "low": "low", "medium": "medium", "high": "high", "max": "max" },
      "input_cost_per_mtok": 3.00,
      "output_cost_per_mtok": 15.00,
      "max_output_tokens": 64000,
      "best_for": "Writing, moderate reasoning, reflection, subplan planning"
    },
    {
      "id": "anthropic/claude-haiku-4.5",
      "alias": "haiku",
      "family": "anthropic",
      "effort_map": { "low": "low", "medium": "medium", "high": "high", "max": "max" },
      "input_cost_per_mtok": 1.00,
      "output_cost_per_mtok": 5.00,
      "max_output_tokens": 64000,
      "best_for": "Simple tasks, classification, condition evaluation, cheap execution"
    },
    {
      "id": "deepseek/deepseek-v3.2",
      "alias": "deepseek",
      "family": "deepseek",
      "input_cost_per_mtok": 0.10,
      "output_cost_per_mtok": 0.10,
      "max_output_tokens": 64000,
      "best_for": "Cheap dev testing — tool wiring, orient flow, KV ops, prompt rendering"
    }
  ],
  "fallback_model": "anthropic/claude-haiku-4.5",
  "alias_map": {
    "opus": "anthropic/claude-opus-4.6",
    "sonnet": "anthropic/claude-sonnet-4.6",
    "haiku": "anthropic/claude-haiku-4.5",
    "deepseek": "deepseek/deepseek-v3.2"
  }
}
```

### Field reference

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Full OpenRouter model ID (e.g. `anthropic/claude-opus-4.6`) |
| `alias` | yes | Short name used in config:defaults (e.g. `opus`) |
| `family` | yes | Provider family — determines how LLM requests are adapted |
| `effort_map` | no | Maps effort levels to provider-specific parameters. Anthropic uses `thinking.effort`, DeepSeek uses `reasoning_effort`. Omit if provider doesn't support effort. |
| `input_cost_per_mtok` | yes | Cost per million input tokens (USD) |
| `output_cost_per_mtok` | yes | Cost per million output tokens (USD) |
| `max_output_tokens` | yes | Maximum output tokens the model supports |
| `best_for` | yes | Human-readable guidance for when to use this model |

### How aliases resolve at runtime

```javascript
resolveModel(modelOrAlias) {
  return this.modelsConfig?.alias_map?.[modelOrAlias] || modelOrAlias;
}
```

If `orient.model` is set to `"haiku"`, the kernel resolves it to `"anthropic/claude-haiku-4.5"` via `alias_map`. Full model IDs pass through unchanged.

---

## The config:defaults model selection fields

These fields in `config:defaults` control which model is used for each role:

```json
{
  "orient": {
    "model": "anthropic/claude-haiku-4.5",
    "effort": "low",
    "max_output_tokens": 4000
  },
  "reflect": {
    "model": "anthropic/claude-sonnet-4.6",
    "effort": "medium",
    "max_output_tokens": 1000
  },
  "deep_reflect": {
    "model": "anthropic/claude-opus-4.6",
    "effort": "high",
    "max_output_tokens": 4000,
    "budget_multiplier": 3.0
  },
  "chat": {
    "model": "sonnet",
    "effort": "low",
    "max_cost_per_conversation": 0.50,
    "max_tool_rounds": 5,
    "max_output_tokens": 1000
  },
  "session_budget": {
    "max_cost": 0.15,
    "max_duration_seconds": 600,
    "reflect_reserve_pct": 0.33
  },
  "execution": {
    "fallback_model": "anthropic/claude-haiku-4.5"
  }
}
```

Model values can be either a full ID or an alias from `alias_map`.

---

## Family-specific LLM adaptations

The LLM provider adapts requests based on the model's `family` field:

**anthropic family:**
```javascript
body.cache_control = { type: 'ephemeral' };
if (effort) {
  body.thinking = { type: 'adaptive', effort: effortValue };
  body.provider = { require_parameters: true };
}
```

**deepseek family:**
```javascript
if (effort) body.reasoning_effort = effort;
```

When adding a new model family, the agent needs to know it must also update the LLM provider adapter to handle that family's specific parameters. This is a code modification (tool code lives in KV at `tool:llm:code`... actually the provider lives at `provider:llm:code`).

---

## How cost estimation works

```javascript
estimateCost(model, usage) {
  const modelInfo = this.modelsConfig?.models?.find(
    m => m.id === model || m.alias === model
  );
  if (!modelInfo) return null;
  return (inputTokens * modelInfo.input_cost_per_mtok
    + outputTokens * modelInfo.output_cost_per_mtok) / 1_000_000;
}
```

If a model isn't in `config:models`, cost estimation returns null and the session can't track spend. This means **every model used must have an entry in config:models**.

---

## Available tools

The agent has these tools available during orient sessions:

| Tool | What it does |
|------|-------------|
| `web_fetch` | HTTP GET/POST to any URL. Returns `{status, body}`. Body truncated at 10k chars by default (configurable via `max_length`). |
| `kv_query` | Read a KV value. Supports dot-path drilling (e.g. `kv_query("config:models", ".alias_map")`). |
| `kv_manifest` | List KV keys by prefix (e.g. `kv_manifest("config:")`). |
| `spawn_subplan` | Spawn a nested agent with its own tool access. Useful for parallelizing research. |
| `check_balance` | Check OpenRouter and wallet balances. |

There is NO `web_search` tool. The agent can only fetch specific URLs.

---

## OpenRouter API reference

The skill should teach the agent how to discover model information from OpenRouter:

### List all models
```
GET https://openrouter.ai/api/v1/models
```
Returns `{ data: [{ id, name, pricing: { prompt, completion }, context_length, top_provider: { max_completion_tokens }, ... }] }`.

Pricing is in dollars per token (not per million tokens). To convert:
- `pricing.prompt * 1_000_000` = `input_cost_per_mtok`
- `pricing.completion * 1_000_000` = `output_cost_per_mtok`

### Get a specific model
```
GET https://openrouter.ai/api/v1/models/{model_id}
```
Same shape as individual entries in the list response. Useful when the agent already knows the model ID.

### Check generation stats
```
GET https://openrouter.ai/api/v1/auth/key
Headers: Authorization: Bearer {OPENROUTER_API_KEY}
```
Returns rate limits and usage for the current key. Useful for checking if a model is accessible.

---

## Modification Protocol

The agent cannot directly write to `config:models` or `config:defaults` — these are protected keys. Changes must go through modification requests.

### During orient (depth 0 session)

Orient CANNOT modify config directly. If orient determines a model change is needed, it notes this in `session_summary` for reflect to pick up.

### During reflect (depth 0)

Reflect can stage a modification:

```json
{
  "modification_requests": [{
    "claims": ["Add new model X to config:models with correct pricing"],
    "ops": [
      {"op": "patch", "key": "config:models",
       "old_string": "\"fallback_model\"",
       "new_string": "...new model entry...\n  \"fallback_model\""}
    ],
    "checks": [
      {"type": "kv_assert", "key": "config:models", "path": "alias_map.newAlias", "predicate": "exists"}
    ]
  }]
}
```

This gets staged for deep reflect to review.

### During deep reflect (depth 1+)

Deep reflect can:
- Accept staged model changes (they become active immediately)
- Reject them (with reason)
- Modify the ops before accepting
- Also propose its own model changes which apply immediately as inflight

Deep reflect has full tool access and can do its own research (web_fetch to OpenRouter) before issuing verdicts.

### Patch operations

For surgical edits to JSON stored in KV, use `patch`:

```json
{"op": "patch", "key": "config:models",
 "old_string": "\"output_cost_per_mtok\": 25.00",
 "new_string": "\"output_cost_per_mtok\": 20.00"}
```

The patch fails if `old_string` is not found or is ambiguous (appears more than once). For adding a new model to the array, patch in the new entry before a known anchor string.

For wholesale replacement, use `put` — but this replaces the entire value, so you must include the complete updated config:models object.

---

## What the instructions should cover

The skill instructions (the markdown body) should be a complete, step-by-step guide covering these scenarios:

### 1. Discovering what models are available
- How to query OpenRouter's model list API
- How to filter/search for relevant models (the response is large — teach the agent to use `max_length` strategically or look for specific model IDs)
- How to interpret the response fields and map them to the config:models schema

### 2. Evaluating a new model
- What to look for: pricing, context window, output token limits, provider support
- How to determine the `family` — check if an existing family adapter handles it, or if a new one is needed
- How to determine `effort_map` — does the model support effort/reasoning parameters?
- How to assess `best_for` — what role(s) could this model fill?
- Cost comparison against current models (calculate cost ratios)

### 3. Adding a new model
- Construct the model entry with all required fields
- Add to both `models` array and `alias_map`
- Formulate the modification request with appropriate checks
- Handle the case where a new family is needed (flag for provider code update)

### 4. Updating an existing model
- When pricing changes, update cost fields
- When a model is deprecated, plan migration (update config:defaults references first, then remove)
- Use patch ops for surgical updates vs put for larger changes

### 5. Changing model role assignments
- How to evaluate whether a different model should be used for orient/reflect/deep_reflect/chat
- Cost-quality tradeoff framework: what to consider
- How to formulate the config:defaults modification
- How to set up checks that validate the change worked (e.g. "parse error rate should not increase")

### 6. Testing before committing

This is the critical safety step. The agent MUST verify a model works BEFORE proposing any config modification that depends on it. The workflow is:

1. Use `test_model` tool to make a real completion call to the candidate model
2. Verify it returns a valid response, check token usage
3. Only THEN formulate the modification request to add it to config:models / config:defaults

This "try before you buy" pattern prevents bricking — a bad model ID or unsupported model never makes it into config because the test fails before the modification is proposed. No circuit breaker or rollback needed.

The `test_model` tool does not exist yet. The skill should:
- Describe what it needs: takes a model ID (full OpenRouter ID) and a simple prompt, calls OpenRouter via the existing LLM provider, returns success/failure, response snippet, and token usage
- Recommend the agent create this tool as a prerequisite (or describe it clearly enough that the skill-authoring skill can create it)
- Make clear that without this tool, the skill CANNOT safely add new models — the agent should not skip this step and fall back to "add it and hope the circuit breaker catches failures"

This principle generalizes: any modification that could brick the agent (break the LLM call path, corrupt config:defaults, etc.) should be tested against reality before the modification is proposed, not after.

### 7. Handling failure
- What happens if a model is added but doesn't work (circuit breaker rolls back on fatal errors)
- What if pricing data from OpenRouter is stale or wrong
- How to verify costs empirically from karma logs after a few sessions

### 8. Removing a model
- Check that no config:defaults role references the model being removed
- Remove from both `models` array and `alias_map`
- Consider whether the fallback_model needs updating

---

## Important constraints the skill must communicate

1. **Every model used must be in config:models** — otherwise cost estimation breaks and the session can't track spend.

2. **Alias conflicts** — aliases must be unique. Don't reuse an alias that already maps to a different model.

3. **Family must match a provider adapter** — if the family string doesn't match an existing adapter in the LLM provider code, calls will fail. Currently supported: `anthropic`, `deepseek`. Adding a new family requires a code modification to the provider.

4. **No direct OpenRouter access from orient** — `web_fetch` doesn't have `OPENROUTER_API_KEY` in its secrets grant. The agent can fetch OpenRouter's public endpoints (model list, pricing — no auth needed) but cannot make authenticated completion calls through `web_fetch`. The `test_model` tool solves this by routing through the kernel's LLM provider with proper secrets access.

5. **Test before you modify, not after** — the agent must call `test_model` to verify a model works BEFORE proposing any modification that depends on it. This prevents bricking. Never add a model to config and rely on the circuit breaker to catch failures — that's recovery, not prevention.

4. **Config changes are protected** — orient proposes, reflect stages, deep reflect accepts. The skill should make clear which actions happen at which depth.

5. **Patch ops must be unambiguous** — `old_string` must appear exactly once in the target value. For JSON, this means being specific enough that the string isn't repeated.

6. **Cost conversion** — OpenRouter returns per-token pricing, config:models uses per-million-token pricing. Getting this wrong by 6 orders of magnitude would be bad.

---

## Style guidance

- Write the instructions as if talking to a competent but context-limited agent that may be running at low effort
- Be concrete: include exact URLs, exact JSON field names, exact tool call patterns
- Include example tool calls showing inputs and expected outputs
- Include "what can go wrong" notes for tricky steps
- Keep total length under 400 lines — this needs to fit in context when activated
- Structure with clear headers so the agent can jump to the relevant section
- Don't be chatty — every sentence should be actionable or provide critical context
