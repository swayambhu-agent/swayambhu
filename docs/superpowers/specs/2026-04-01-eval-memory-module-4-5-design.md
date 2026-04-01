# Module 4+5: Evaluation & Memory — Design Spec

> **Spec reference:** `swayambhu-cognitive-architecture.md` sections 5, 6, 7.3
> **Depends on:** Modules 1-3 (complete). Replaces eval stub from Module 3.
> **Adversarial review:** One round with Codex on the initial design (Workers AI path), one infrastructure consult (Docker/Akash). Findings incorporated — switched from Workers AI to akash-hosted models.

---

## 1. Summary

Replace the eval stub with a real three-tier evaluation pipeline (embeddings → NLI → LLM fallback). Build an akash inference server hosting sentence-transformer and NLI models. Add proper μ operators with EMA-based cumulative surprise. Add episode embeddings and selection for deep-reflect.

**Key decisions:**
- Akash-hosted ONNX Runtime inference server (Docker, FastAPI, bge-small-en-v1.5 + DeBERTa-v3-base)
- Real three-tier pipeline: embeddings for relevance, NLI for valence, LLM for ambiguous edge cases
- Eval's mechanical `assumption_scores` replaces review's `mu_updates` as single source of truth for μ
- Episode narratives embedded at write time via akash /embed endpoint
- Episode selection for deep-reflect by recency + salience + embedding similarity
- Zero kernel changes beyond one passthrough line

---

## 2. Akash Inference Server

A single Docker container hosting both models, deployed on Akash Network.

### Models

| Model | Purpose | Format | Size |
|-------|---------|--------|------|
| BAAI/bge-small-en-v1.5 | Sentence embeddings (384 dims) | ONNX | ~90MB |
| MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli | NLI classification | ONNX | ~350MB |

### Endpoints

**POST /embed**
```json
// Request
{ "texts": ["text one", "text two"] }

// Response
{ "embeddings": [[0.1, 0.2, ...], [0.3, 0.4, ...]] }
```

**POST /nli**
```json
// Request
{ "pairs": [
    { "id": "p1", "premise": "Slack is working", "hypothesis": "Message delivered successfully" },
    { "id": "p2", "premise": "Conserve resources", "hypothesis": "Spent $50 on API calls" }
  ]
}

// Response
{ "results": [
    { "id": "p1", "label": "entailment", "scores": { "entailment": 0.92, "contradiction": 0.03, "neutral": 0.05 } },
    { "id": "p2", "label": "contradiction", "scores": { "entailment": 0.05, "contradiction": 0.88, "neutral": 0.07 } }
  ]
}
```

**GET /health**
```json
{ "status": "ok", "models": ["bge-small-en-v1.5", "deberta-v3-base-mnli"] }
```

### Tech Stack

- **Runtime:** ONNX Runtime (CPU) — no PyTorch in runtime image
- **Server:** FastAPI + uvicorn (1 worker, concurrency limit 8)
- **Build:** Multi-stage Docker (builder converts HF models to ONNX, runtime is slim)
- **Base image:** python:3.11-slim
- **Auth:** Shared secret via `Authorization: Bearer {token}` header. Token stored in Worker's env as `AKASH_INFERENCE_SECRET`.

### Dockerfile (multi-stage)

```dockerfile
FROM python:3.11-slim AS builder

ENV PIP_NO_CACHE_DIR=1 HF_HOME=/tmp/hf HF_HUB_DISABLE_TELEMETRY=1

RUN pip install --no-cache-dir \
    "optimum[onnxruntime]" "transformers" "tokenizers"

RUN python -c "
from optimum.onnxruntime import ORTModelForFeatureExtraction, ORTModelForSequenceClassification
from transformers import AutoTokenizer
from pathlib import Path

for name, cls, path in [
    ('BAAI/bge-small-en-v1.5', ORTModelForFeatureExtraction, '/models/embed'),
    ('MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli', ORTModelForSequenceClassification, '/models/nli'),
]:
    p = Path(path)
    p.mkdir(parents=True, exist_ok=True)
    AutoTokenizer.from_pretrained(name).save_pretrained(p)
    model = cls.from_pretrained(name, from_transformers=True) if 'Sequence' in cls.__name__ else cls.from_pretrained(name, file_name='onnx/model.onnx')
    model.save_pretrained(p)
"

FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 TOKENIZERS_PARALLELISM=false OMP_NUM_THREADS=1

RUN pip install --no-cache-dir \
    fastapi uvicorn[standard] onnxruntime transformers tokenizers numpy

WORKDIR /app
COPY --from=builder /models /models
COPY inference/ /app/

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--limit-concurrency", "8"]
```

### Akash SDL

```yaml
version: "2.0"
services:
  inference:
    image: ghcr.io/swayambhu-agent/inference:0.1.0
    env:
      - TOKENIZERS_PARALLELISM=false
      - OMP_NUM_THREADS=1
      - AUTH_TOKEN=${AKASH_INFERENCE_SECRET}
    expose:
      - port: 8000
        as: 80
        to:
          - global: true
        http_options:
          max_body_size: 2097152
          read_timeout: 60000
          send_timeout: 60000

profiles:
  compute:
    inference:
      resources:
        cpu:
          units: 1.0
        memory:
          size: 3Gi
        storage:
          size: 2Gi
  placement:
    akash:
      pricing:
        inference:
          denom: uakt
          amount: 100

deployment:
  inference:
    akash:
      profile: inference
      count: 1
```

### File structure (new directory)

```
inference/
  main.py          # FastAPI app with /embed, /nli, /health
  Dockerfile       # Multi-stage build
  deploy.yaml      # Akash SDL
  requirements.txt # Runtime deps only
```

---

## 3. Eval Pipeline — Replacing the Stub

`eval.js` becomes async and takes K for LLM fallback access. It calls the akash inference server for Tiers 1-2.

### Signature

```javascript
// Before (Module 3 stub)
export function evaluateAction(ledger, desires, assumptions)

// After
export async function evaluateAction(K, ledger, desires, assumptions, config)
```

`config` contains `{ inferenceUrl, inferenceSecret, relevanceThreshold, ambiguityThreshold }` loaded from `config:defaults`.

### Pipeline

**Step 1: Extract outcome text**

Combine `ledger.final_text` with a summary of tool outcomes:
```
"Action: {plan.action}. Tools called: {tool1} (ok), {tool2} (failed). Result: {final_text}"
```

**Step 2: Tier 1 — Relevance filter (akash /embed)**

- Embed the outcome text
- For each desire and assumption, use cached embeddings (passed in via `desires[key]._embedding` and `assumptions[key]._embedding`)
- Compute cosine similarity
- Filter to pairs above `relevanceThreshold` (default 0.3)
- Output: relevant (desire, outcome) and (assumption, outcome) pairs

If akash is unreachable: skip Tier 1, send all pairs to Tier 2. Log degraded mode to karma.

**Step 3: Tier 2 — Valence classification (akash /nli)**

- Send all relevant pairs to `/nli`
- Each pair has a stable ID (e.g., `desire:serve` or `assumption:slack-ok`)
- Classification: entailment / contradiction / neutral + confidence scores
- Output: per-pair direction and magnitude

If akash is unreachable: fall through to Tier 3 for all pairs.

**Step 4: Tier 3 — LLM fallback (K.callLLM)**

- For pairs where NLI confidence < `ambiguityThreshold` (default 0.6), OR when Tier 2 is unavailable
- One batched K.callLLM call with structured prompt
- Each pair gets: direction (entailment/contradiction/neutral) + confidence (0-1)
- Prompt demands JSON array, validated per-row, invalid rows default to neutral/0

**Step 5: Compute metrics**

```javascript
sigma = max(surprise across all assumption pairs)  // contradiction confidence
alpha = { desire_slug: signed_magnitude }           // entailment → +, contradiction → -
salience = sigma + L1_norm(alpha)
```

### Return shape

```javascript
{
  sigma: 0.85,
  alpha: { "serve": 0.6, "conserve": -0.3 },
  salience: 1.75,
  eval_method: "pipeline",  // or "llm_fallback" or "degraded"
  tool_outcomes: [{ tool: "...", ok: true }],
  plan_success_criteria: "...",
  assumptions_relied_on: ["assumption:..."],
  candidate_check_ids: ["slug1", "slug2"],
  assumption_scores: {
    "google-docs-accessible": { direction: "entailment", surprise: 0.05 },
    "slack-working": { direction: "contradiction", surprise: 0.9 }
  }
}
```

Same interface shape as the Module 3 stub + `assumption_scores`. Session.js doesn't change structurally — it just gets real values now.

---

## 4. μ Operators

### Single source of truth

Eval's `assumption_scores` drives μ updates. Review's `mu_updates` field is removed. Review does qualitative assessment for the narrative, but mechanical scores come from eval.

### R operator: updateMu

```javascript
function updateMu(existing, checkId, score) {
  const mu = existing || {
    check_id: checkId,
    confirmation_count: 0,
    violation_count: 0,
    last_checked: null,
    cumulative_surprise: 0,
  };

  const surprised = score.direction === "contradiction";
  const surpriseValue = surprised ? score.surprise : 0;

  mu.confirmation_count += surprised ? 0 : 1;
  mu.violation_count += surprised ? 1 : 0;
  mu.last_checked = new Date().toISOString();

  // EMA: new = α * current + (1 - α) * previous
  // On first update (cumulative_surprise === 0 and no history), seed with observed value
  const alpha = 0.3;
  mu.cumulative_surprise = mu.confirmation_count + mu.violation_count <= 1
    ? surpriseValue
    : alpha * surpriseValue + (1 - alpha) * mu.cumulative_surprise;

  return mu;
}
```

### Session.js writeMemory change

```javascript
// Before (Module 3): iterate review.mu_updates
// After: iterate evalResult.assumption_scores
for (const [checkId, score] of Object.entries(evalResult.assumption_scores)) {
  const key = `mu:${checkId}`;
  const existing = await K.kvGet(key);
  const updated = updateMu(existing, checkId, score);
  await K.kvWriteSafe(key, updated);
}
```

### Review output change

Review no longer produces `mu_updates`. Its output schema becomes:

```json
{
  "assessment": "string",
  "narrative": "string",
  "salience_estimate": 0.7
}
```

`salience_estimate` is still produced as a fallback for when eval can't compute salience (degraded mode). When `eval.salience > 0`, the hook uses eval's value.

---

## 5. Episode Embeddings

At episode write time, embed the narrative via the akash /embed endpoint.

### Flow

```javascript
// In session.js writeMemory, when writing an episode:
let embedding = null;
try {
  const resp = await callInference(config.inferenceUrl, config.inferenceSecret, '/embed', {
    texts: [review.narrative]
  });
  embedding = resp.embeddings[0];  // 384-dim float array
} catch {
  // Embedding failure is non-fatal — episode still written
  await K.karmaRecord({ event: "episode_embedding_failed" });
}

const episode = {
  timestamp: new Date().toISOString(),
  action_taken: ledger.plan.action,
  outcome: ledger.final_text || review.assessment,
  active_assumptions: ledger.plan.relies_on || [],
  active_desires: Object.keys(d),
  surprise_score: evalResult.sigma,
  affinity_vector: evalResult.alpha,
  narrative: review.narrative,
  embedding,  // 384-dim array or null
};
```

### Desire/assumption embedding cache

Embeddings cached in KV as `embedding:{content_hash}:{model_id}`. Not keyed by slug — keyed by hash of the text being embedded + model identifier. This prevents stale cache when text changes without slug change.

```javascript
function embeddingCacheKey(text, model) {
  // Simple hash — not cryptographic, just cache key
  const hash = simpleHash(text);
  return `embedding:${hash}:${model}`;
}
```

At session start, when snapshotting desires/assumptions:
1. For each desire, compute hash of `description`
2. Check KV for cached embedding
3. If missing, call akash /embed, cache result
4. Attach `_embedding` to the desire object for Tier 1 use

Same for assumptions (hash of `check` field).

---

## 6. Episode Selection for Deep-Reflect

### Function: selectEpisodes

```javascript
function selectEpisodes(episodes, desireEmbeddings, options) {
  const { maxEpisodes = 20, salienceWeight = 0.7, similarityWeight = 0.3, lastReflectTimestamp } = options;

  // 1. Recency filter — episodes since last deep-reflect
  let candidates = lastReflectTimestamp
    ? episodes.filter(e => new Date(e.timestamp) > new Date(lastReflectTimestamp))
    : episodes;

  // If not enough recent episodes, include older ones
  if (candidates.length < maxEpisodes) {
    const older = episodes.filter(e => !candidates.includes(e));
    candidates = [...candidates, ...older];
  }

  // 2. Score each episode
  const scored = candidates.map(ep => {
    let score = ep.salience || (ep.surprise_score + l1Norm(ep.affinity_vector));

    // 3. Embedding similarity boost (if embeddings available)
    if (ep.embedding && desireEmbeddings.length > 0) {
      const maxSim = Math.max(...desireEmbeddings.map(de => cosineSimilarity(ep.embedding, de)));
      score = salienceWeight * score + similarityWeight * maxSim;
    }

    return { episode: ep, score };
  });

  // 4. Sort by score descending, take top N
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxEpisodes).map(s => s.episode);
}
```

### Integration with reflect.js

`gatherReflectContext` calls `selectEpisodes` to load relevant episodes:

```javascript
// In gatherReflectContext:
const allEpisodes = await loadAllEpisodes(K);  // kvList prefix "episode:"
const desireEmbeddings = await loadDesireEmbeddings(K);
const lastReflect = await K.kvGet("reflect:schedule:1");

const selectedEpisodes = selectEpisodes(allEpisodes, desireEmbeddings, {
  maxEpisodes: defaults.memory?.max_episodes_for_reflect || 20,
  lastReflectTimestamp: lastReflect?.last_reflect,
});

// Include in deep-reflect context
templateVars.episodes = selectedEpisodes;
templateVars.mu_entries = await loadAllMu(K);
```

### Utility: cosineSimilarity

```javascript
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
```

---

## 7. Inference Client

A shared helper for calling the akash server from eval.js and session.js.

```javascript
async function callInference(baseUrl, secret, path, body) {
  const resp = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${secret}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    throw new Error(`Inference ${path} failed: ${resp.status} ${resp.statusText}`);
  }

  return resp.json();
}
```

Configuration from `config:defaults`:
```json
{
  "inference": {
    "url": "https://inference.swayambhu.akash.network",
    "relevance_threshold": 0.3,
    "ambiguity_threshold": 0.6
  }
}
```

Secret from `env.AKASH_INFERENCE_SECRET` — passed through kernel to hooks. Need to add to K interface:

```javascript
// In buildKernelInterface:
getInferenceConfig: async () => ({
  url: env.AKASH_INFERENCE_URL || null,
  secret: env.AKASH_INFERENCE_SECRET || null,
}),
```

This is the only kernel change — a config passthrough, not an inference capability.

---

## 8. Wiring Changes

### kernel.js (minimal)

Add to `buildKernelInterface()`:
```javascript
getInferenceConfig: async () => ({
  url: env.AKASH_INFERENCE_URL || null,
  secret: env.AKASH_INFERENCE_SECRET || null,
}),
```

### eval.js (rewrite)

- Async, takes K + config
- Three-tier pipeline calling akash + K.callLLM
- Returns `assumption_scores` alongside σ/α/salience
- Graceful degradation when akash unreachable

### session.js (modifications)

- Pass K to evaluateAction: `await evaluateAction(K, ledger, desires, assumptions, evalConfig)`
- Load inference config at session start: `const inferenceConfig = await K.getInferenceConfig()`
- Cache desire/assumption embeddings during snapshot
- writeMemory uses `assumption_scores` for μ (not review's mu_updates)
- Episode writes call akash /embed for narrative embedding

### memory.js (new file)

- `updateMu(existing, checkId, score)` — EMA update logic
- `selectEpisodes(episodes, desireEmbeddings, options)` — ranking + selection
- `cosineSimilarity(a, b)` — vector math
- `callInference(url, secret, path, body)` — HTTP client
- `embeddingCacheKey(text, model)` — cache key generation
- Pure functions + one HTTP helper, easy to test

### reflect.js (modifications)

- `gatherReflectContext` calls `selectEpisodes` for episode loading
- Includes μ entries in deep-reflect context

### Review output schema change

Remove `mu_updates` from review. Keep `assessment`, `narrative`, `salience_estimate`.

### Config additions

```json
{
  "inference": {
    "url": "https://inference.swayambhu.akash.network",
    "relevance_threshold": 0.3,
    "ambiguity_threshold": 0.6,
    "embed_model": "bge-small-en-v1.5"
  },
  "memory": {
    "surprise_ema_alpha": 0.3,
    "max_episodes_for_reflect": 20,
    "salience_weight": 0.7,
    "similarity_weight": 0.3
  }
}
```

### Env vars (wrangler.toml)

```toml
[vars]
AKASH_INFERENCE_URL = "https://inference.swayambhu.akash.network"

# In .dev.vars or secrets:
# AKASH_INFERENCE_SECRET = "..."
```

---

## 9. Testing Strategy

### Unit tests

**tests/eval.test.js (rewrite):**
- Tier 1: relevance filtering with mock embeddings (cosine similarity math)
- Tier 2: NLI classification with mock responses
- Tier 3: LLM fallback for ambiguous pairs
- Full pipeline: all tiers with mock akash + mock K
- Degraded mode: akash unreachable → LLM-only
- sigma/alpha/salience computation from classified pairs
- assumption_scores shape and content

**tests/memory.test.js (new):**
- updateMu: first update (seed), subsequent updates (EMA), confirmation/violation counting
- selectEpisodes: recency filter, salience ranking, embedding similarity boost, limit
- cosineSimilarity: zero vectors, identical vectors, orthogonal vectors
- embeddingCacheKey: same text → same key, different text → different key

**tests/session.test.js (updates):**
- writeMemory uses assumption_scores not mu_updates
- Episode writes include embedding (mock inference)
- Review output no longer has mu_updates

### Integration tests

- Inference server: /embed returns 384-dim vectors, /nli returns valid classifications
- Full eval pipeline with running inference server (docker-compose for local testing)
- End-to-end session with real eval values flowing through μ and ε

### Inference server tests

**inference/test_main.py:**
- /embed: single text, batch, empty input
- /nli: single pair, batch, empty input
- /health: returns model names
- Auth: rejected without token

---

## 10. Local Development

### Without akash inference server

Eval degrades gracefully:
- Tier 1 skipped (no embeddings available)
- Tier 2 skipped (no NLI available)
- Tier 3 handles everything via K.callLLM (same as current LLM-based operation)
- `eval_method` returns `"llm_fallback"`
- Episodes written with `embedding: null`

This means local dev works exactly like today (LLM-only eval) without any akash dependency. The inference server improves quality and reduces cost in production.

### With inference server (docker-compose)

```yaml
services:
  inference:
    build: ./inference
    ports:
      - "8080:8000"
    environment:
      - AUTH_TOKEN=test-secret
```

Set `AKASH_INFERENCE_URL=http://localhost:8080` and `AKASH_INFERENCE_SECRET=test-secret` in `.env`.

---

## 11. Module 6 Compatibility

Module 6 (deep-reflect on akash) uses the same inference server. Deep-reflect can:
- Call /embed for episode retrieval queries
- Call /nli for assumption validation
- Run on the same akash deployment or a separate one

The eval interface (`evaluateAction(K, ...)`) stays the same. Module 6 adds the M and D operators that consume μ and ε — exactly what this module makes real.

---

## 12. Adversarial Review Summary

**Initial design (Workers AI):** Codex found 8 issues — ungoverned K.ai passthrough, missing AI binding, breaking eval signature, Tier 2+3 collapse, stale embedding cache, competing μ sources, unmetered budget, CF lock-in.

**Revised design (Akash):** All issues addressed:
- No K.ai passthrough → config passthrough only (`getInferenceConfig`)
- No AI binding needed → plain HTTP fetch to akash
- Eval signature change managed with test updates
- Real three-tier pipeline (embeddings + NLI + LLM fallback)
- Embedding cache keyed by content hash + model, not slug
- Single μ source (eval's assumption_scores)
- Inference server is self-hosted fixed cost, no per-call metering needed
- Module 6 uses same akash infra

**Docker/Akash consult:** ONNX Runtime over PyTorch, python:3.11-slim base, multi-stage build, 1 vCPU / 3Gi RAM, FastAPI + uvicorn.
