# NOTE: These tests require the actual ONNX models to be available.
# They will only pass inside the Docker container or with models pre-downloaded
# via the download_models.py script. Running them without models will fail
# at import time or during the first test that calls the model.

import math
import os

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("AUTH_TOKEN", "test-secret")

from main import app  # noqa: E402 — import after env is set

AUTH = {"Authorization": "Bearer test-secret"}
WRONG_AUTH = {"Authorization": "Bearer wrong-token"}


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


class TestAuth:
    def test_rejects_missing_token(self, client):
        r = client.post("/embed", json={"texts": ["hello"]})
        assert r.status_code == 401

    def test_rejects_wrong_token(self, client):
        r = client.post("/embed", json={"texts": ["hello"]}, headers=WRONG_AUTH)
        assert r.status_code == 401

    def test_health_no_auth_required(self, client):
        r = client.get("/health")
        assert r.status_code == 200


# ---------------------------------------------------------------------------
# Embed
# ---------------------------------------------------------------------------


class TestEmbed:
    def test_single_text(self, client):
        r = client.post("/embed", json={"texts": ["hello world"]}, headers=AUTH)
        assert r.status_code == 200
        data = r.json()
        assert len(data["embeddings"]) == 1
        assert len(data["embeddings"][0]) == 384

    def test_batch(self, client):
        texts = ["first sentence", "second sentence", "third sentence"]
        r = client.post("/embed", json={"texts": texts}, headers=AUTH)
        assert r.status_code == 200
        data = r.json()
        assert len(data["embeddings"]) == 3

    def test_empty_input(self, client):
        r = client.post("/embed", json={"texts": []}, headers=AUTH)
        assert r.status_code == 200
        data = r.json()
        assert data["embeddings"] == []

    def test_embeddings_are_normalized(self, client):
        r = client.post("/embed", json={"texts": ["normalize me"]}, headers=AUTH)
        assert r.status_code == 200
        vec = r.json()["embeddings"][0]
        norm = math.sqrt(sum(v * v for v in vec))
        assert abs(norm - 1.0) < 1e-4


# ---------------------------------------------------------------------------
# NLI
# ---------------------------------------------------------------------------


class TestNLI:
    def test_entailment(self, client):
        r = client.post(
            "/nli",
            json={
                "pairs": [
                    {
                        "premise": "The cat is sleeping on the mat",
                        "hypothesis": "An animal is resting",
                    }
                ]
            },
            headers=AUTH,
        )
        assert r.status_code == 200
        data = r.json()
        assert len(data["results"]) == 1
        assert data["results"][0]["label"] == "entailment"

    def test_contradiction(self, client):
        r = client.post(
            "/nli",
            json={
                "pairs": [
                    {
                        "premise": "It is sunny outside",
                        "hypothesis": "It is raining heavily",
                    }
                ]
            },
            headers=AUTH,
        )
        assert r.status_code == 200
        data = r.json()
        assert len(data["results"]) == 1
        assert data["results"][0]["label"] == "contradiction"

    def test_batch(self, client):
        pairs = [
            {"premise": "Dogs bark", "hypothesis": "Animals make noise"},
            {"premise": "The sky is blue", "hypothesis": "The sky is green"},
        ]
        r = client.post("/nli", json={"pairs": pairs}, headers=AUTH)
        assert r.status_code == 200
        data = r.json()
        assert len(data["results"]) == 2

    def test_empty_input(self, client):
        r = client.post("/nli", json={"pairs": []}, headers=AUTH)
        assert r.status_code == 200
        data = r.json()
        assert data["results"] == []


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------


class TestHealth:
    def test_returns_model_names(self, client):
        r = client.get("/health")
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "ok"
        models = data.get("models", {})
        # Both embed and NLI model names should be present
        assert "embed" in models
        assert "nli" in models
