import os
import numpy as np
from functools import lru_cache
from typing import List

import onnxruntime as ort
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from transformers import AutoTokenizer

app = FastAPI(title="Swayambhu Inference Server")

EMBED_MODEL_PATH = os.environ.get("EMBED_MODEL_PATH", "/models/embed")
NLI_MODEL_PATH = os.environ.get("NLI_MODEL_PATH", "/models/nli")
AUTH_TOKEN = os.environ.get("AUTH_TOKEN", "")

NLI_LABELS = ["entailment", "neutral", "contradiction"]


# ---------------------------------------------------------------------------
# Auth middleware
# ---------------------------------------------------------------------------

@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    if request.url.path == "/health":
        return await call_next(request)

    if AUTH_TOKEN:
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer ") or auth_header[7:] != AUTH_TOKEN:
            return JSONResponse(status_code=401, content={"detail": "Unauthorized"})

    return await call_next(request)


# ---------------------------------------------------------------------------
# Model loading (lazy singletons)
# ---------------------------------------------------------------------------

@lru_cache(maxsize=1)
def load_embed_model():
    session = ort.InferenceSession(
        os.path.join(EMBED_MODEL_PATH, "model.onnx"),
        providers=["CPUExecutionProvider"],
    )
    tokenizer = AutoTokenizer.from_pretrained(EMBED_MODEL_PATH)
    return session, tokenizer


@lru_cache(maxsize=1)
def load_nli_model():
    session = ort.InferenceSession(
        os.path.join(NLI_MODEL_PATH, "model.onnx"),
        providers=["CPUExecutionProvider"],
    )
    tokenizer = AutoTokenizer.from_pretrained(NLI_MODEL_PATH)
    return session, tokenizer


def get_onnx_input_names(session):
    return {inp.name for inp in session.get_inputs()}


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class EmbedRequest(BaseModel):
    texts: List[str]


class EmbedResponse(BaseModel):
    embeddings: List[List[float]]


class NLIPair(BaseModel):
    id: str
    premise: str
    hypothesis: str


class NLIResult(BaseModel):
    id: str
    label: str
    scores: dict


class NLIRequest(BaseModel):
    pairs: List[NLIPair]


class NLIResponse(BaseModel):
    results: List[NLIResult]


class HealthResponse(BaseModel):
    status: str
    models: List[str]


# ---------------------------------------------------------------------------
# Helper: mean pooling + L2 normalisation
# ---------------------------------------------------------------------------

def mean_pool_and_normalize(token_embeddings: np.ndarray, attention_mask: np.ndarray) -> np.ndarray:
    """Mean pool token embeddings (masked), then L2-normalise each row."""
    mask = attention_mask[..., np.newaxis].astype(np.float32)  # (B, T, 1)
    summed = (token_embeddings * mask).sum(axis=1)              # (B, H)
    counts = mask.sum(axis=1).clip(min=1e-9)                   # (B, 1)
    pooled = summed / counts                                    # (B, H)
    norms = np.linalg.norm(pooled, axis=1, keepdims=True).clip(min=1e-9)
    return pooled / norms


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.post("/embed", response_model=EmbedResponse)
async def embed(request: EmbedRequest):
    if not request.texts:
        raise HTTPException(status_code=422, detail="texts must not be empty")

    session, tokenizer = load_embed_model()
    valid_inputs = get_onnx_input_names(session)

    encoded = tokenizer(
        request.texts,
        padding=True,
        truncation=True,
        return_tensors="np",
    )

    # Only pass inputs that the ONNX model accepts
    onnx_inputs = {k: v for k, v in encoded.items() if k in valid_inputs}

    outputs = session.run(None, onnx_inputs)
    # outputs[0] is the last hidden state: (B, T, H)
    token_embeddings = outputs[0]
    attention_mask = encoded["attention_mask"]

    embeddings = mean_pool_and_normalize(token_embeddings, attention_mask)
    return EmbedResponse(embeddings=embeddings.tolist())


@app.post("/nli", response_model=NLIResponse)
async def nli(request: NLIRequest):
    if not request.pairs:
        raise HTTPException(status_code=422, detail="pairs must not be empty")

    session, tokenizer = load_nli_model()
    valid_inputs = get_onnx_input_names(session)

    results = []
    for pair in request.pairs:
        encoded = tokenizer(
            pair.premise,
            pair.hypothesis,
            truncation=True,
            return_tensors="np",
        )

        onnx_inputs = {k: v for k, v in encoded.items() if k in valid_inputs}
        outputs = session.run(None, onnx_inputs)

        # outputs[0] shape: (1, num_labels)
        logits = outputs[0][0].astype(np.float64)
        exp_logits = np.exp(logits - logits.max())
        probs = exp_logits / exp_logits.sum()

        scores = {label: float(probs[i]) for i, label in enumerate(NLI_LABELS)}
        label = NLI_LABELS[int(np.argmax(probs))]

        results.append(NLIResult(id=pair.id, label=label, scores=scores))

    return NLIResponse(results=results)


@app.get("/health", response_model=HealthResponse)
async def health():
    loaded_models = []
    status = "ok"

    try:
        load_embed_model()
        loaded_models.append("embed")
    except Exception:
        status = "degraded"

    try:
        load_nli_model()
        loaded_models.append("nli")
    except Exception:
        status = "degraded"

    return HealthResponse(status=status, models=loaded_models)
