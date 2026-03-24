# Skill: Model Configuration — Reference

Detailed reference for modifying model configuration. This is a companion to `skill:model-config` (the concise guide). Load this key when you need to construct proposal_requests.

⚠️ **Serialization matters**: KV values may be stored with or without whitespace. Your `old_string` in any patch op must match the *exact* serialization in KV. Always read the current value first (`kv_query`) before constructing patches.

---

## 1. Adding a New Model

### Step 1: Construct the model entry

```json
{
  "id": "google/gemini-2.5-pro",
  "alias": "gemini-pro",
  "supports_reasoning": true,
  "input_cost_per_mtok": 1.25,
  "output_cost_per_mtok": 10.00,
  "max_output_tokens": 65536,
  "best_for": "Long-context reasoning, multimodal tasks"
}
```

Note: no `family` needed — Gemini has no provider-specific quirks requiring an adapter.

Checklist:
- [ ] `id` matches OpenRouter exactly (case-sensitive)
- [ ] `alias` is unique — not already in `alias_map`
- [ ] `family` set ONLY if model needs provider-specific adaptation (e.g. `"anthropic"` for cache_control). Most models need no family.
- [ ] `supports_reasoning` set correctly (check if `"reasoning"` is in OpenRouter's `supported_parameters` array)
- [ ] Costs are in **per million tokens** (not per token)
- [ ] `max_output_tokens` comes from OpenRouter data
- [ ] `best_for` is specific and guides role assignment

### Step 2: Formulate the proposal request

From **reflect**, stage a `proposal_requests` entry with:
- **claims**: What you're doing and why (e.g. "Add google/gemini-2.5-pro, pricing verified from OpenRouter API")
- **ops**: Two patch ops — one to insert the model entry into the `models` array (anchor on `"fallback_model"`), one to add the alias to `alias_map` (anchor on the last existing alias entry)
- **checks**: `kv_assert` that the new alias exists and maps to the correct model ID

⚠️ **Patch anchor strategy**: To insert at the end of the `models` array, your `old_string` must be unique across the entire serialized JSON value. `"fallback_model"` alone may not be unique enough. Include surrounding structural context — e.g. the closing `]` of the models array plus the fallback_model line — so the match is unambiguous. **Always read the current value first** (`kv_query("config:models")`) to see the exact serialization before constructing your patch.

⚠️ **Two patches needed**: One for the `models` array entry, one for the `alias_map` entry. Always update both.

⚠️ **Serialization matters**: KV values may be stored with or without whitespace depending on how they were written (e.g. `JSON.stringify` with no indentation). Your `old_string` must match the *exact* serialization in KV, not a pretty-printed version. Always read the current value first and match its formatting exactly.

### Step 3: If provider-specific adaptation is needed

Most models need no family adapter. Only add one if the model requires request shaping that OpenRouter doesn't normalize (e.g. explicit cache_control injection).

If needed, add a separate proposal request for `provider:llm:code`. Example claim:

```
"Add google family adapter to LLM provider for explicit cache_control injection"
```

This is a code modification — deep_reflect should scrutinize it carefully. Do NOT add family adapters for reasoning — that's handled by the unified `reasoning` parameter.

---

## 2. Updating an Existing Model

### Pricing update

When OpenRouter pricing changes:

1. Fetch current pricing: `web_fetch("https://openrouter.ai/api/v1/models/{model_id}")`
2. Read current config: `kv_query("config:models", ".models")`
3. Compare values. If different, stage a patch op targeting the cost fields.
4. Include enough surrounding context in `old_string` (e.g. the model's `id` and `alias` lines) to make the match unambiguous.

### Model deprecation / replacement

When a model is being retired:

1. Identify all references in `config:defaults` — check act.model, reflect.model, deep_reflect.model, chat.model, execution.fallback_model
2. Stage config:defaults changes to point to the replacement model
3. If the model has entries in `config:model_capabilities`, update or remove them (see §4 for the write gate requirements — 200-char deliberation, yama_capable model). Include the deliberation in the proposal request.
4. Mark the old model as retired by adding `"status": "retired"` to its entry in config:models — do NOT remove it. Keeping the entry preserves cost data for historical karma log analysis.
5. Optionally update `best_for` to note why it was retired (e.g. `"RETIRED — replaced by sonnet-5, deprecated by provider"`)

The alias_map entry can remain — it won't be used if no config:defaults role references it, and it serves as documentation of what the alias pointed to.

---

## 3. Changing Model Role Assignments

To reassign which model serves a role:

### Cost-quality tradeoff framework

| Factor | act | reflect | deep_reflect |
|--------|--------|---------|--------------|
| Latency priority | HIGH | medium | low |
| Cost sensitivity | HIGH | medium | low |
| Reasoning depth | low | medium | HIGH |
| Tool-calling reliability | HIGH | low | medium |

**act** should be the cheapest model that reliably does tool-calling and simple routing. Don't put opus here.

**reflect** needs solid reasoning at moderate cost — it runs every session.

**deep_reflect** should be the best available reasoner — it runs rarely and makes consequential decisions.

### Formulate the change

```json
{
  "proposal_requests": [{
    "claims": [
      "Switch act model from haiku to deepseek for 90% cost reduction",
      "DeepSeek v3.2 handles tool-calling adequately based on 5 sessions of observation"
    ],
    "ops": [{
      "op": "patch",
      "key": "config:defaults",
      "old_string": "\"act\": {\n    \"model\": \"anthropic/claude-haiku-4.5\"",
      "new_string": "\"act\": {\n    \"model\": \"deepseek\""
    }],
    "checks": [
      {"type": "kv_assert", "key": "config:defaults", "path": "act.model", "predicate": "equals", "value": "deepseek"}
    ]
  }]
}
```

NOTE: `old_string` above is illustrative — actual value must match the exact serialization in KV. Always read first.

You can use aliases in config:defaults — they resolve at runtime.

---

## 4. Retiring a Model

Models should be marked retired rather than deleted — this preserves cost data for historical karma log analysis and avoids breaking references in old logs.

### Retirement checklist

1. Read config:defaults: `kv_query("config:defaults")`
2. Search for any reference to the model's ID or alias in:
   - `act.model`
   - `reflect.model`
   - `deep_reflect.model`
   - `chat.model`
   - `execution.fallback_model`
   - `fallback_model` in config:models itself
3. If referenced anywhere → migrate those references to the replacement model first
4. Check `config:model_capabilities` — remove any capability entries for this model. Note: this key has its own write gate (requires 200-char deliberation and must be issued by a `yama_capable` model). Include the deliberation in the proposal request.
5. Patch the model entry to add `"status": "retired"` and update `best_for` with the reason

### Example retirement patch

```json
{
  "op": "patch",
  "key": "config:models",
  "old_string": "\"best_for\": \"Simple tasks, classification\"",
  "new_string": "\"status\": \"retired\",\n      \"best_for\": \"RETIRED — replaced by deepseek, deprecated by provider\""
}
```

The model entry, alias, and cost fields all stay in place for reference.

---

## 5. Handling Failures

### Model doesn't work after addition

The kernel's safety mechanisms handle failures differently depending on severity:
- **Single call failures**: `callLLM()` catches errors and the session continues with degraded output. Errors are logged in karma.
- **Repeated crashes**: The tripwire fires after 3 consecutive session crashes and restores the last known good hook code. This is a global safety reset, not per-model — it won't surgically roll back a bad model config.
- **Fallback**: If a model call fails, `callLLM()` uses `fallback_model` from config:models for retry.

Because there's no per-model circuit breaker, reflect should actively monitor karma logs after any model change. Look for: repeated LLM errors, unexpected cost spikes, degraded output quality. Stage a rollback promptly if issues appear.

### Stale pricing data

OpenRouter pricing can change without notice. After a model has run for a few sessions:
1. Check karma logs for actual billed amounts
2. Compare against `estimateCost()` predictions
3. If they diverge significantly, re-fetch pricing from OpenRouter and update config:models

### Patch operation fails

If `old_string` doesn't match (config was modified between read and patch):
- The proposal is rejected automatically
- Re-read the current config and reformulate the patch
- This is normal — it's optimistic concurrency control
