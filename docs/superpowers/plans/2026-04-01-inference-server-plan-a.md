# Plan A: Akash Inference Server — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Docker-based inference server hosting sentence-transformer (bge-small-en-v1.5) and NLI (DeBERTa-v3-base) models, deployable on Akash Network.

**Architecture:** ONNX Runtime for inference (no PyTorch in runtime). Multi-stage Docker build: builder converts HF models to ONNX, runtime is python:3.11-slim + FastAPI. Two endpoints: /embed (384-dim vectors) and /nli (entailment/contradiction/neutral classification).

**Tech Stack:** Python 3.11, FastAPI, ONNX Runtime, Optimum (build-time only), Docker, Akash SDL

**Spec:** `docs/superpowers/specs/2026-04-01-eval-memory-module-4-5-design.md` Section 2

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `inference/main.py` | Create | FastAPI app: /embed, /nli, /health endpoints |
| `inference/Dockerfile` | Create | Multi-stage build (builder + runtime) |
| `inference/requirements.txt` | Create | Runtime Python dependencies |
| `inference/test_main.py` | Create | Endpoint tests (pytest) |
| `inference/deploy.yaml` | Create | Akash SDL for deployment |
| `inference/docker-compose.yml` | Create | Local dev setup |

---

## Task 1: Create FastAPI inference server

**Files:**
- Create: `inference/main.py`
- Create: `inference/requirements.txt`

- [ ] **Step 1: Create requirements.txt**

Create `inference/requirements.txt`:

```
fastapi==0.115.12
uvicorn[standard]==0.34.0
onnxruntime==1.22.0
transformers==4.57.1
tokenizers==0.22.0
numpy==2.2.4
```

- [ ] **Step 2: Create main.py**

Create `inference/main.py`:

```python
"""Swayambhu inference server — embeddings + NLI via ONNX Runtime."""

import os
import numpy as np
from functools import lru_cache
from fastapi import FastAPI, HTTPException, Depends, Header
from pydantic import BaseModel
from transformers import AutoTokenizer
from onnxruntime import InferenceSession

app = FastAPI(title="Swayambhu Inference")

AUTH_TOKEN = os.environ.get("AUTH_TOKEN", "")
EMBED_MODEL_PATH = os.environ.get("EMBED_MODEL_PATH", "/models/embed")
NLI_MODEL_PATH = os.environ.get("NLI_MODEL_PATH", "/models/nli")

# ── Auth ─────────────────────────────────────────────────

async def verify_token(authorization: str = Header(None)):
    if not AUTH_TOKEN:
        return  # No auth configured (local dev)
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid token")
    if authorization[7:] != AUTH_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid token")

# ── Model loading ────────────────────────────────────────

@lru_cache(maxsize=1)
def get_embed_model():
    tokenizer = AutoTokenizer.from_pretrained(EMBED_MODEL_PATH)
    session = InferenceSession(
        os.path.join(EMBED_MODEL_PATH, "model.onnx"),
        providers=["CPUExecutionProvider"],
    )
    return tokenizer, session

@lru_cache(maxsize=1)
def get_nli_model():
    tokenizer = AutoTokenizer.from_pretrained(NLI_MODEL_PATH)
    session = InferenceSession(
        os.path.join(NLI_MODEL_PATH, "model.onnx"),
        providers=["CPUExecutionProvider"],
    )
    return tokenizer, session

# ── Request/Response models ──────────────────────────────

class EmbedRequest(BaseModel):
    texts: list[str]

class EmbedResponse(BaseModel):
    embeddings: list[list[float]]

class NLIPair(BaseModel):
    id: str
    premise: str
    hypothesis: str

class NLIRequest(BaseModel):
    pairs: list[NLIPair]

class NLIResult(BaseModel):
    id: str
    label: str
    scores: dict[str, float]

class NLIResponse(BaseModel):
    results: list[NLIResult]

class HealthResponse(BaseModel):
    status: str
    models: list[str]

# ── Endpoints ────────────────────────────────────────────

@app.post("/embed", response_model=EmbedResponse, dependencies=[Depends(verify_token)])
async def embed(request: EmbedRequest):
    if not request.texts:
        return EmbedResponse(embeddings=[])

    tokenizer, session = get_embed_model()
    inputs = tokenizer(
        request.texts,
        padding=True,
        truncation=True,
        max_length=512,
        return_tensors="np",
    )

    outputs = session.run(None, {k: v for k, v in inputs.items() if k in [n.name for n in session.get_inputs()]})
    # Mean pooling over token embeddings (skip [CLS] pooling for bge)
    token_embeddings = outputs[0]  # shape: (batch, seq_len, hidden_dim)
    attention_mask = inputs["attention_mask"]
    mask_expanded = np.expand_dims(attention_mask, -1).astype(np.float32)
    summed = np.sum(token_embeddings * mask_expanded, axis=1)
    counts = np.clip(mask_expanded.sum(axis=1), a_min=1e-9, a_max=None)
    embeddings = summed / counts

    # L2 normalize
    norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
    norms = np.clip(norms, a_min=1e-9, a_max=None)
    embeddings = embeddings / norms

    return EmbedResponse(embeddings=embeddings.tolist())

NLI_LABELS = ["entailment", "neutral", "contradiction"]

@app.post("/nli", response_model=NLIResponse, dependencies=[Depends(verify_token)])
async def nli(request: NLIRequest):
    if not request.pairs:
        return NLIResponse(results=[])

    tokenizer, session = get_nli_model()

    results = []
    for pair in request.pairs:
        inputs = tokenizer(
            pair.premise,
            pair.hypothesis,
            padding=True,
            truncation=True,
            max_length=512,
            return_tensors="np",
        )
        valid_inputs = {k: v for k, v in inputs.items() if k in [n.name for n in session.get_inputs()]}
        logits = session.run(None, valid_inputs)[0][0]

        # Softmax
        exp_logits = np.exp(logits - np.max(logits))
        probs = exp_logits / exp_logits.sum()

        label_idx = int(np.argmax(probs))
        scores = {NLI_LABELS[i]: float(probs[i]) for i in range(len(NLI_LABELS))}

        results.append(NLIResult(
            id=pair.id,
            label=NLI_LABELS[label_idx],
            scores=scores,
        ))

    return NLIResponse(results=results)

@app.get("/health", response_model=HealthResponse)
async def health():
    models = []
    try:
        get_embed_model()
        models.append("bge-small-en-v1.5")
    except Exception:
        pass
    try:
        get_nli_model()
        models.append("deberta-v3-base-mnli")
    except Exception:
        pass

    return HealthResponse(
        status="ok" if len(models) == 2 else "degraded",
        models=models,
    )
```

- [ ] **Step 3: Commit**

```bash
git add inference/main.py inference/requirements.txt
git commit -m "feat(m4): add inference server with /embed, /nli, /health endpoints

ONNX Runtime + FastAPI. bge-small-en-v1.5 for embeddings (384 dims),
DeBERTa-v3-base-mnli for NLI classification."
```

---

## Task 2: Create Dockerfile

**Files:**
- Create: `inference/Dockerfile`

- [ ] **Step 1: Create multi-stage Dockerfile**

Create `inference/Dockerfile`:

```dockerfile
# ── Builder: download + convert models to ONNX ──────────
FROM python:3.11-slim AS builder

ENV PIP_NO_CACHE_DIR=1 \
    HF_HOME=/tmp/hf \
    HF_HUB_DISABLE_TELEMETRY=1

RUN pip install --no-cache-dir \
    "optimum[onnxruntime]==1.27.0" \
    "transformers==4.57.1" \
    "tokenizers==0.22.0"

# Export embedding model to ONNX
RUN python3 -c "\
from optimum.onnxruntime import ORTModelForFeatureExtraction; \
from transformers import AutoTokenizer; \
from pathlib import Path; \
p = Path('/models/embed'); p.mkdir(parents=True, exist_ok=True); \
AutoTokenizer.from_pretrained('BAAI/bge-small-en-v1.5').save_pretrained(p); \
ORTModelForFeatureExtraction.from_pretrained('BAAI/bge-small-en-v1.5', export=True).save_pretrained(p); \
"

# Export NLI model to ONNX
RUN python3 -c "\
from optimum.onnxruntime import ORTModelForSequenceClassification; \
from transformers import AutoTokenizer; \
from pathlib import Path; \
p = Path('/models/nli'); p.mkdir(parents=True, exist_ok=True); \
AutoTokenizer.from_pretrained('MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli').save_pretrained(p); \
ORTModelForSequenceClassification.from_pretrained('MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli', export=True).save_pretrained(p); \
"

# ── Runtime: slim image with ONNX Runtime only ──────────
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    TOKENIZERS_PARALLELISM=false \
    OMP_NUM_THREADS=1 \
    MKL_NUM_THREADS=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY --from=builder /models /models
COPY main.py .

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--limit-concurrency", "8"]
```

- [ ] **Step 2: Commit**

```bash
git add inference/Dockerfile
git commit -m "feat(m4): add multi-stage Dockerfile for inference server

Builder stage exports HF models to ONNX. Runtime is python:3.11-slim
with onnxruntime only (no PyTorch). ~500MB final image."
```

---

## Task 3: Create tests

**Files:**
- Create: `inference/test_main.py`

- [ ] **Step 1: Create endpoint tests**

Create `inference/test_main.py`:

```python
"""Tests for inference server endpoints.

Run with: pytest inference/test_main.py -v
Requires models to be available at /models/ or EMBED_MODEL_PATH / NLI_MODEL_PATH env vars.
For CI, use a fixture that downloads models first.
"""

import os
import pytest
from fastapi.testclient import TestClient

# Set model paths for testing (override if needed)
os.environ.setdefault("EMBED_MODEL_PATH", "/models/embed")
os.environ.setdefault("NLI_MODEL_PATH", "/models/nli")
os.environ.setdefault("AUTH_TOKEN", "test-secret")

from main import app

client = TestClient(app)
HEADERS = {"Authorization": "Bearer test-secret"}

# ── Auth tests ───────────────────────────────────────────

class TestAuth:
    def test_rejects_missing_token(self):
        resp = client.post("/embed", json={"texts": ["hello"]})
        assert resp.status_code == 401

    def test_rejects_wrong_token(self):
        resp = client.post("/embed", json={"texts": ["hello"]},
                           headers={"Authorization": "Bearer wrong"})
        assert resp.status_code == 401

    def test_health_no_auth_required(self):
        resp = client.get("/health")
        assert resp.status_code == 200

# ── Embed tests ──────────────────────────────────────────

class TestEmbed:
    def test_single_text(self):
        resp = client.post("/embed", json={"texts": ["hello world"]}, headers=HEADERS)
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["embeddings"]) == 1
        assert len(data["embeddings"][0]) == 384  # bge-small-en-v1.5 dim

    def test_batch(self):
        resp = client.post("/embed",
                           json={"texts": ["hello", "world", "test"]},
                           headers=HEADERS)
        assert resp.status_code == 200
        assert len(resp.json()["embeddings"]) == 3

    def test_empty_input(self):
        resp = client.post("/embed", json={"texts": []}, headers=HEADERS)
        assert resp.status_code == 200
        assert resp.json()["embeddings"] == []

    def test_embeddings_are_normalized(self):
        import numpy as np
        resp = client.post("/embed", json={"texts": ["test"]}, headers=HEADERS)
        vec = np.array(resp.json()["embeddings"][0])
        norm = np.linalg.norm(vec)
        assert abs(norm - 1.0) < 0.01  # L2 normalized

# ── NLI tests ────────────────────────────────────────────

class TestNLI:
    def test_entailment(self):
        resp = client.post("/nli", json={"pairs": [
            {"id": "p1", "premise": "The cat is sleeping on the mat.",
             "hypothesis": "An animal is resting."}
        ]}, headers=HEADERS)
        assert resp.status_code == 200
        result = resp.json()["results"][0]
        assert result["id"] == "p1"
        assert result["label"] == "entailment"
        assert result["scores"]["entailment"] > 0.5

    def test_contradiction(self):
        resp = client.post("/nli", json={"pairs": [
            {"id": "p1", "premise": "It is sunny outside.",
             "hypothesis": "It is raining heavily."}
        ]}, headers=HEADERS)
        result = resp.json()["results"][0]
        assert result["label"] == "contradiction"
        assert result["scores"]["contradiction"] > 0.5

    def test_batch(self):
        resp = client.post("/nli", json={"pairs": [
            {"id": "p1", "premise": "A", "hypothesis": "B"},
            {"id": "p2", "premise": "C", "hypothesis": "D"},
        ]}, headers=HEADERS)
        assert len(resp.json()["results"]) == 2

    def test_empty_input(self):
        resp = client.post("/nli", json={"pairs": []}, headers=HEADERS)
        assert resp.status_code == 200
        assert resp.json()["results"] == []

# ── Health tests ─────────────────────────────────────────

class TestHealth:
    def test_returns_model_names(self):
        resp = client.get("/health")
        data = resp.json()
        assert "bge-small-en-v1.5" in data["models"]
        assert "deberta-v3-base-mnli" in data["models"]
        assert data["status"] == "ok"
```

- [ ] **Step 2: Commit**

```bash
git add inference/test_main.py
git commit -m "test(m4): add inference server endpoint tests

Auth, /embed (single, batch, empty, normalized), /nli (entailment,
contradiction, batch, empty), /health."
```

---

## Task 4: Create docker-compose and Akash SDL

**Files:**
- Create: `inference/docker-compose.yml`
- Create: `inference/deploy.yaml`

- [ ] **Step 1: Create docker-compose.yml for local dev**

Create `inference/docker-compose.yml`:

```yaml
services:
  inference:
    build: .
    ports:
      - "8080:8000"
    environment:
      - AUTH_TOKEN=test-secret
      - OMP_NUM_THREADS=1
      - TOKENIZERS_PARALLELISM=false
    deploy:
      resources:
        limits:
          memory: 3G
```

- [ ] **Step 2: Create Akash SDL**

Create `inference/deploy.yaml`:

```yaml
---
version: "2.0"

services:
  inference:
    image: ghcr.io/swayambhu-agent/inference:0.1.0
    env:
      - TOKENIZERS_PARALLELISM=false
      - OMP_NUM_THREADS=1
      - MKL_NUM_THREADS=1
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

- [ ] **Step 3: Commit**

```bash
git add inference/docker-compose.yml inference/deploy.yaml
git commit -m "feat(m4): add docker-compose and Akash SDL for inference server

Local dev: docker-compose up (port 8080).
Production: Akash deploy (1 vCPU, 3Gi RAM)."
```

---

## Task 5: Build, test, and verify locally

**Files:** None (verification only)

- [ ] **Step 1: Build the Docker image**

Run: `cd inference && docker build -t swayambhu-inference:local .`

Expected: Successful build. Builder stage downloads and converts models (~5-10 min first time). Final image ~500MB.

- [ ] **Step 2: Run the container**

Run: `docker-compose up -d`

Expected: Container starts, models load into memory (~10s).

- [ ] **Step 3: Verify /health**

Run: `curl http://localhost:8080/health`

Expected: `{"status":"ok","models":["bge-small-en-v1.5","deberta-v3-base-mnli"]}`

- [ ] **Step 4: Verify /embed**

Run: `curl -X POST http://localhost:8080/embed -H "Content-Type: application/json" -H "Authorization: Bearer test-secret" -d '{"texts":["hello world"]}'`

Expected: JSON with `embeddings` array containing one 384-element vector.

- [ ] **Step 5: Verify /nli**

Run: `curl -X POST http://localhost:8080/nli -H "Content-Type: application/json" -H "Authorization: Bearer test-secret" -d '{"pairs":[{"id":"p1","premise":"The sky is blue","hypothesis":"The sky is red"}]}'`

Expected: `{"results":[{"id":"p1","label":"contradiction","scores":{...}}]}`

- [ ] **Step 6: Run pytest inside the container**

Run: `docker-compose exec inference pytest test_main.py -v`

Expected: All tests pass.

- [ ] **Step 7: Stop and commit any fixes**

Run: `docker-compose down`

---

## Self-Review Checklist

**Spec coverage:**
- ✅ Section 2 (Akash Inference Server): All subsections covered
- ✅ Models: bge-small-en-v1.5, DeBERTa-v3-base-mnli
- ✅ Endpoints: /embed, /nli, /health
- ✅ Auth: Bearer token
- ✅ Dockerfile: multi-stage, ONNX Runtime, python:3.11-slim
- ✅ Akash SDL: 1 vCPU, 3Gi RAM
- ✅ Local dev: docker-compose

**Placeholder scan:** No TBDs. All code complete.

**Type consistency:** Request/response models match spec endpoint definitions.
