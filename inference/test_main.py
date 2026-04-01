# NOTE: These tests require the actual ONNX models to be available.
# They will only pass inside the Docker container or with models pre-downloaded.

import math
import os

os.environ.setdefault("AUTH_TOKEN", "test-secret")

from fastapi.testclient import TestClient
from main import app

client = TestClient(app)
AUTH = {"Authorization": "Bearer test-secret"}

# ── Auth ─────────────────────────────────────────────────

def test_rejects_missing_token():
    r = client.post("/embed", json={"texts": ["hello"]})
    assert r.status_code == 401

def test_rejects_wrong_token():
    r = client.post("/embed", json={"texts": ["hello"]}, headers={"Authorization": "Bearer wrong"})
    assert r.status_code == 401

def test_health_no_auth_required():
    r = client.get("/health")
    assert r.status_code == 200

# ── Embed ────────────────────────────────────────────────

def test_embed_single_text():
    r = client.post("/embed", json={"texts": ["hello world"]}, headers=AUTH)
    assert r.status_code == 200
    data = r.json()
    assert len(data["embeddings"]) == 1
    assert len(data["embeddings"][0]) == 384

def test_embed_batch():
    r = client.post("/embed", json={"texts": ["a", "b", "c"]}, headers=AUTH)
    assert r.status_code == 200
    assert len(r.json()["embeddings"]) == 3

def test_embed_empty():
    r = client.post("/embed", json={"texts": []}, headers=AUTH)
    assert r.status_code == 200
    assert r.json()["embeddings"] == []

def test_embed_normalized():
    r = client.post("/embed", json={"texts": ["test"]}, headers=AUTH)
    vec = r.json()["embeddings"][0]
    norm = math.sqrt(sum(v * v for v in vec))
    assert abs(norm - 1.0) < 1e-4

# ── NLI ──────────────────────────────────────────────────

def test_nli_entailment():
    r = client.post("/nli", json={"pairs": [
        {"id": "p1", "premise": "The cat is sleeping on the mat", "hypothesis": "An animal is resting"}
    ]}, headers=AUTH)
    assert r.status_code == 200
    assert r.json()["results"][0]["label"] == "entailment"

def test_nli_contradiction():
    r = client.post("/nli", json={"pairs": [
        {"id": "p1", "premise": "It is sunny outside", "hypothesis": "It is raining heavily"}
    ]}, headers=AUTH)
    assert r.status_code == 200
    assert r.json()["results"][0]["label"] == "contradiction"

def test_nli_batch():
    r = client.post("/nli", json={"pairs": [
        {"id": "p1", "premise": "Dogs bark", "hypothesis": "Animals make noise"},
        {"id": "p2", "premise": "The sky is blue", "hypothesis": "The sky is green"},
    ]}, headers=AUTH)
    assert len(r.json()["results"]) == 2

def test_nli_empty():
    r = client.post("/nli", json={"pairs": []}, headers=AUTH)
    assert r.json()["results"] == []

# ── Health ───────────────────────────────────────────────

def test_health():
    r = client.get("/health")
    data = r.json()
    assert data["status"] == "ok"
    assert len(data["models"]) == 2
