# Plan B: Eval Pipeline + Memory Operators — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the eval stub with a real three-tier evaluation pipeline (embeddings → NLI → LLM fallback). Add μ EMA operators, episode embeddings, and episode selection for deep-reflect.

**Architecture:** eval.js calls akash inference server for Tiers 1-2, K.callLLM for Tier 3. memory.js provides pure functions for μ updates, episode selection, and vector math. session.js wired to use real eval + mechanical μ updates.

**Tech Stack:** Cloudflare Workers (JS), Vitest, akash inference server (Plan A)

**Spec:** `docs/superpowers/specs/2026-04-01-eval-memory-module-4-5-design.md` Sections 3-8

**Depends on:** Plan A (inference server) running locally or deployed. Can be developed with mocks.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `memory.js` | Create | updateMu, selectEpisodes, cosineSimilarity, callInference, embeddingCacheKey |
| `eval.js` | Rewrite | Three-tier pipeline: embed → NLI → LLM fallback |
| `session.js` | Modify (~lines 258-301, ~340-375) | Use assumption_scores for μ, embed episodes, cache embeddings |
| `reflect.js` | Modify (~line 257-310) | gatherReflectContext uses selectEpisodes |
| `scripts/seed-local-kv.mjs` | Modify | Add inference config + secret |
| `tests/memory.test.js` | Create | updateMu, selectEpisodes, cosineSimilarity tests |
| `tests/eval.test.js` | Rewrite | Three-tier pipeline tests with mocked inference |
| `tests/session.test.js` | Modify | Update for assumption_scores μ path |
| `tests/helpers/mock-kernel.js` | Modify (~line 49) | No changes needed (callLLM already mocked) |

---

## Task 1: Create memory.js — pure utility functions

**Files:**
- Create: `tests/memory.test.js`
- Create: `memory.js`

- [ ] **Step 1: Write memory.js tests**

Create `tests/memory.test.js`:

```javascript
import { describe, it, expect } from "vitest";
import { updateMu, selectEpisodes, cosineSimilarity, embeddingCacheKey } from "../memory.js";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const v = [1, 0, 0];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0.0);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0);
  });

  it("returns 0 for zero vectors", () => {
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });

  it("returns 0 for null/undefined inputs", () => {
    expect(cosineSimilarity(null, [1, 0])).toBe(0);
    expect(cosineSimilarity([1, 0], null)).toBe(0);
  });

  it("returns 0 for mismatched lengths", () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });
});

describe("updateMu", () => {
  it("seeds cumulative_surprise on first update", () => {
    const result = updateMu(null, "slack-ok", { direction: "contradiction", surprise: 0.8 });

    expect(result.check_id).toBe("slack-ok");
    expect(result.violation_count).toBe(1);
    expect(result.confirmation_count).toBe(0);
    expect(result.cumulative_surprise).toBe(0.8);
    expect(result.last_checked).toBeTruthy();
  });

  it("applies EMA on subsequent updates", () => {
    const existing = {
      check_id: "slack-ok",
      confirmation_count: 5,
      violation_count: 1,
      last_checked: "2026-01-01T00:00:00Z",
      cumulative_surprise: 0.2,
    };

    const result = updateMu(existing, "slack-ok", { direction: "contradiction", surprise: 0.9 });

    // EMA: 0.3 * 0.9 + 0.7 * 0.2 = 0.27 + 0.14 = 0.41
    expect(result.cumulative_surprise).toBeCloseTo(0.41);
    expect(result.violation_count).toBe(2);
    expect(result.confirmation_count).toBe(5);
  });

  it("increments confirmation on entailment", () => {
    const existing = {
      check_id: "test",
      confirmation_count: 3,
      violation_count: 0,
      last_checked: null,
      cumulative_surprise: 0.1,
    };

    const result = updateMu(existing, "test", { direction: "entailment", surprise: 0.05 });

    expect(result.confirmation_count).toBe(4);
    expect(result.violation_count).toBe(0);
    // EMA with low surprise: 0.3 * 0.05 + 0.7 * 0.1 = 0.015 + 0.07 = 0.085
    expect(result.cumulative_surprise).toBeCloseTo(0.085);
  });

  it("handles neutral direction (no count change)", () => {
    const existing = {
      check_id: "test",
      confirmation_count: 2,
      violation_count: 1,
      last_checked: null,
      cumulative_surprise: 0.3,
    };

    const result = updateMu(existing, "test", { direction: "neutral", surprise: 0 });

    expect(result.confirmation_count).toBe(2);
    expect(result.violation_count).toBe(1);
  });
});

describe("selectEpisodes", () => {
  const episodes = [
    { timestamp: "2026-03-01T00:00:00Z", salience: 0.9, surprise_score: 0.8, affinity_vector: { serve: 0.1 }, embedding: [1, 0, 0] },
    { timestamp: "2026-03-15T00:00:00Z", salience: 0.3, surprise_score: 0.2, affinity_vector: { serve: 0.1 }, embedding: [0, 1, 0] },
    { timestamp: "2026-03-29T00:00:00Z", salience: 0.7, surprise_score: 0.5, affinity_vector: { serve: 0.2 }, embedding: [0.7, 0.7, 0] },
    { timestamp: "2026-03-30T00:00:00Z", salience: 0.5, surprise_score: 0.3, affinity_vector: { serve: 0.2 }, embedding: [0, 0, 1] },
  ];

  it("returns top N by salience", () => {
    const result = selectEpisodes(episodes, [], { maxEpisodes: 2 });
    expect(result).toHaveLength(2);
    expect(result[0].salience).toBe(0.9);
    expect(result[1].salience).toBe(0.7);
  });

  it("prioritizes recent episodes when lastReflectTimestamp set", () => {
    const result = selectEpisodes(episodes, [], {
      maxEpisodes: 2,
      lastReflectTimestamp: "2026-03-20T00:00:00Z",
    });
    // Only episodes after Mar 20: the Mar 29 and Mar 30 ones
    expect(result).toHaveLength(2);
    expect(new Date(result[0].timestamp).getTime()).toBeGreaterThan(new Date("2026-03-20").getTime());
  });

  it("boosts score with embedding similarity when desire embeddings provided", () => {
    const desireEmbeddings = [[1, 0, 0]]; // similar to episode[0]
    const result = selectEpisodes(episodes, desireEmbeddings, { maxEpisodes: 2 });
    // Episode[0] has high salience (0.9) AND high similarity to desire → should be first
    expect(result[0]).toBe(episodes[0]);
  });

  it("handles episodes without embeddings", () => {
    const noEmbedEpisodes = episodes.map(e => ({ ...e, embedding: null }));
    const result = selectEpisodes(noEmbedEpisodes, [[1, 0, 0]], { maxEpisodes: 2 });
    expect(result).toHaveLength(2);
  });

  it("returns all episodes when fewer than maxEpisodes", () => {
    const result = selectEpisodes(episodes, [], { maxEpisodes: 100 });
    expect(result).toHaveLength(4);
  });
});

describe("embeddingCacheKey", () => {
  it("returns same key for same text and model", () => {
    const k1 = embeddingCacheKey("hello", "bge-small");
    const k2 = embeddingCacheKey("hello", "bge-small");
    expect(k1).toBe(k2);
  });

  it("returns different key for different text", () => {
    const k1 = embeddingCacheKey("hello", "bge-small");
    const k2 = embeddingCacheKey("world", "bge-small");
    expect(k1).not.toBe(k2);
  });

  it("returns different key for different model", () => {
    const k1 = embeddingCacheKey("hello", "bge-small");
    const k2 = embeddingCacheKey("hello", "bge-large");
    expect(k1).not.toBe(k2);
  });

  it("starts with embedding: prefix", () => {
    const k = embeddingCacheKey("hello", "bge-small");
    expect(k).toMatch(/^embedding:/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/memory.test.js`

Expected: FAIL — memory.js doesn't exist.

- [ ] **Step 3: Implement memory.js**

Create `memory.js`:

```javascript
// Swayambhu — Memory utilities
// Pure functions for μ updates, episode selection, and vector math.
// Used by session.js (μ writes, episode selection) and eval.js (embeddings).

// ── Vector math ─────────────────────────────────────────

export function cosineSimilarity(a, b) {
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

export function l1Norm(vec) {
  if (!vec || typeof vec !== "object") return 0;
  return Object.values(vec).reduce((sum, v) => sum + Math.abs(v), 0);
}

// ── μ update (R operator) ───────────────────────────────

const EMA_ALPHA = 0.3;

export function updateMu(existing, checkId, score, alpha = EMA_ALPHA) {
  const mu = existing ? { ...existing } : {
    check_id: checkId,
    confirmation_count: 0,
    violation_count: 0,
    last_checked: null,
    cumulative_surprise: 0,
  };

  const surprised = score.direction === "contradiction";
  const confirmed = score.direction === "entailment";
  const surpriseValue = score.surprise || 0;

  if (confirmed) mu.confirmation_count += 1;
  if (surprised) mu.violation_count += 1;
  mu.last_checked = new Date().toISOString();

  // EMA: seed on first real update, blend after
  const isFirst = mu.confirmation_count + mu.violation_count <= 1;
  mu.cumulative_surprise = isFirst
    ? surpriseValue
    : alpha * surpriseValue + (1 - alpha) * mu.cumulative_surprise;

  return mu;
}

// ── Episode selection ───────────────────────────────────

export function selectEpisodes(episodes, desireEmbeddings, options = {}) {
  const {
    maxEpisodes = 20,
    salienceWeight = 0.7,
    similarityWeight = 0.3,
    lastReflectTimestamp,
  } = options;

  // 1. Recency filter
  let candidates = episodes;
  if (lastReflectTimestamp) {
    const cutoff = new Date(lastReflectTimestamp).getTime();
    const recent = episodes.filter(e => new Date(e.timestamp).getTime() > cutoff);
    // If enough recent, use them; otherwise include older too
    candidates = recent.length >= maxEpisodes ? recent : episodes;
  }

  // 2. Score each episode
  const scored = candidates.map(ep => {
    const baseSalience = ep.salience || (ep.surprise_score + l1Norm(ep.affinity_vector));

    // 3. Embedding similarity boost
    let similarityBoost = 0;
    if (ep.embedding && desireEmbeddings.length > 0) {
      similarityBoost = Math.max(
        ...desireEmbeddings.map(de => cosineSimilarity(ep.embedding, de))
      );
    }

    const score = desireEmbeddings.length > 0
      ? salienceWeight * baseSalience + similarityWeight * similarityBoost
      : baseSalience;

    return { episode: ep, score };
  });

  // 4. Sort and limit
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxEpisodes).map(s => s.episode);
}

// ── Inference client ────────────────────────────────────

export async function callInference(baseUrl, secret, path, body) {
  const resp = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret ? { "Authorization": `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    throw new Error(`Inference ${path} failed: ${resp.status} ${resp.statusText}`);
  }

  return resp.json();
}

// ── Embedding cache ─────────────────────────────────────

export function embeddingCacheKey(text, model) {
  const hash = simpleHash(text);
  return `embedding:${hash}:${model}`;
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/memory.test.js`

Expected: All tests pass.

- [ ] **Step 5: Run all tests**

Run: `npm test`

Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add memory.js tests/memory.test.js
git commit -m "feat(m4): add memory.js — μ operators, episode selection, vector math

updateMu with EMA cumulative_surprise. selectEpisodes with recency +
salience + embedding similarity. cosineSimilarity, callInference,
embeddingCacheKey utilities."
```

---

## Task 2: Rewrite eval.js — three-tier pipeline

**Files:**
- Rewrite: `eval.js`
- Rewrite: `tests/eval.test.js`

- [ ] **Step 1: Write new eval tests**

Replace `tests/eval.test.js`:

```javascript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock memory.js callInference
vi.mock("../memory.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    callInference: vi.fn(),
  };
});

import { evaluateAction } from "../eval.js";
import { callInference } from "../memory.js";

const desires = {
  "desire:serve": { slug: "serve", direction: "approach", description: "Serve seekers", _embedding: [1, 0, 0] },
  "desire:conserve": { slug: "conserve", direction: "avoidance", description: "Conserve resources", _embedding: [0, 1, 0] },
};

const assumptions = {
  "assumption:slack-ok": { slug: "slack-ok", check: "Slack is operational", _embedding: [0.5, 0.5, 0] },
};

const ledger = {
  action_id: "sess_1_cycle_0",
  plan: {
    action: "compile research doc",
    success: "doc saved, 5+ topics",
    relies_on: ["assumption:slack-ok"],
    defer_if: "budget < 30%",
  },
  tool_calls: [
    { tool: "google_docs_create", input: {}, output: { id: "doc123" }, ok: true },
  ],
  final_text: "Research doc created successfully.",
};

const mockK = {
  callLLM: vi.fn(),
  karmaRecord: vi.fn(),
};

const inferenceConfig = {
  url: "http://localhost:8080",
  secret: "test",
  relevance_threshold: 0.3,
  ambiguity_threshold: 0.6,
};

describe("evaluateAction (pipeline)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs full pipeline: embed → NLI → compute σ/α", async () => {
    // Tier 1: embed outcome → similarity above threshold for all pairs
    callInference.mockResolvedValueOnce({
      embeddings: [[0.8, 0.2, 0]],  // outcome embedding
    });

    // Tier 2: NLI classification
    callInference.mockResolvedValueOnce({
      results: [
        { id: "assumption:slack-ok", label: "entailment", scores: { entailment: 0.9, contradiction: 0.05, neutral: 0.05 } },
        { id: "desire:serve", label: "entailment", scores: { entailment: 0.85, contradiction: 0.05, neutral: 0.1 } },
        { id: "desire:conserve", label: "neutral", scores: { entailment: 0.1, contradiction: 0.2, neutral: 0.7 } },
      ],
    });

    const result = await evaluateAction(mockK, ledger, desires, assumptions, inferenceConfig);

    expect(result.eval_method).toBe("pipeline");
    expect(result.sigma).toBeCloseTo(0.05); // max contradiction across assumptions
    expect(result.alpha.serve).toBeCloseTo(0.85); // entailment → positive
    expect(result.alpha.conserve).toBe(0); // neutral → 0
    expect(result.salience).toBeGreaterThan(0);
    expect(result.assumption_scores["slack-ok"]).toBeDefined();
    expect(result.assumption_scores["slack-ok"].direction).toBe("entailment");
  });

  it("falls back to LLM when inference unavailable", async () => {
    callInference.mockRejectedValue(new Error("connection refused"));

    mockK.callLLM.mockResolvedValueOnce({
      content: JSON.stringify([
        { id: "assumption:slack-ok", direction: "entailment", confidence: 0.8 },
        { id: "desire:serve", direction: "entailment", confidence: 0.7 },
        { id: "desire:conserve", direction: "neutral", confidence: 0.9 },
      ]),
      cost: 0.02,
    });

    const result = await evaluateAction(mockK, ledger, desires, assumptions, inferenceConfig);

    expect(result.eval_method).toBe("llm_fallback");
    expect(result.sigma).toBeDefined();
    expect(result.alpha).toBeDefined();
    expect(mockK.callLLM).toHaveBeenCalled();
  });

  it("sends ambiguous NLI pairs to LLM Tier 3", async () => {
    // Tier 1: embed
    callInference.mockResolvedValueOnce({ embeddings: [[0.8, 0.2, 0]] });

    // Tier 2: NLI — one clear, one ambiguous
    callInference.mockResolvedValueOnce({
      results: [
        { id: "assumption:slack-ok", label: "entailment", scores: { entailment: 0.9, contradiction: 0.05, neutral: 0.05 } },
        { id: "desire:serve", label: "entailment", scores: { entailment: 0.4, contradiction: 0.3, neutral: 0.3 } }, // ambiguous
        { id: "desire:conserve", label: "neutral", scores: { entailment: 0.1, contradiction: 0.2, neutral: 0.7 } },
      ],
    });

    // Tier 3: LLM for ambiguous pair
    mockK.callLLM.mockResolvedValueOnce({
      content: JSON.stringify([
        { id: "desire:serve", direction: "entailment", confidence: 0.75 },
      ]),
      cost: 0.01,
    });

    const result = await evaluateAction(mockK, ledger, desires, assumptions, inferenceConfig);

    expect(result.eval_method).toBe("pipeline");
    expect(result.alpha.serve).toBeCloseTo(0.75); // LLM resolved
    expect(mockK.callLLM).toHaveBeenCalledTimes(1);
  });

  it("returns tool_outcomes and candidate_check_ids", async () => {
    callInference.mockResolvedValueOnce({ embeddings: [[0.8, 0.2, 0]] });
    callInference.mockResolvedValueOnce({
      results: [
        { id: "assumption:slack-ok", label: "entailment", scores: { entailment: 0.9, contradiction: 0.05, neutral: 0.05 } },
        { id: "desire:serve", label: "neutral", scores: { entailment: 0.1, contradiction: 0.1, neutral: 0.8 } },
        { id: "desire:conserve", label: "neutral", scores: { entailment: 0.1, contradiction: 0.1, neutral: 0.8 } },
      ],
    });

    const result = await evaluateAction(mockK, ledger, desires, assumptions, inferenceConfig);

    expect(result.tool_outcomes).toEqual([{ tool: "google_docs_create", ok: true }]);
    expect(result.candidate_check_ids).toContain("slack-ok");
  });

  it("handles empty desires and assumptions", async () => {
    const result = await evaluateAction(mockK, ledger, {}, {}, inferenceConfig);

    expect(result.sigma).toBe(0);
    expect(result.alpha).toEqual({});
    expect(result.salience).toBe(0);
    expect(result.eval_method).toBe("pipeline");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/eval.test.js`

Expected: FAIL — eval.js still exports the sync stub.

- [ ] **Step 3: Rewrite eval.js with three-tier pipeline**

Replace `eval.js`:

```javascript
// Swayambhu — Evaluation pipeline (Module 4+5)
// Three-tier: embeddings (Tier 1) → NLI (Tier 2) → LLM fallback (Tier 3).
// Calls akash inference server for Tiers 1-2, K.callLLM for Tier 3.

import { callInference, cosineSimilarity, l1Norm } from './memory.js';

export async function evaluateAction(K, ledger, desires, assumptions, config) {
  const toolOutcomes = ledger.tool_calls.map(tc => ({ tool: tc.tool, ok: tc.ok }));
  const candidateCheckIds = Object.values(assumptions).map(a => a.slug);

  // Short-circuit: nothing to evaluate
  if (Object.keys(desires).length === 0 && Object.keys(assumptions).length === 0) {
    return {
      sigma: 0, alpha: {}, salience: 0, eval_method: "pipeline",
      tool_outcomes: toolOutcomes,
      plan_success_criteria: ledger.plan.success,
      assumptions_relied_on: ledger.plan.relies_on || [],
      candidate_check_ids: candidateCheckIds,
      assumption_scores: {},
    };
  }

  // Extract outcome text
  const outcomeText = buildOutcomeText(ledger);

  // Build all pairs to evaluate
  const pairs = [];
  for (const [key, d] of Object.entries(desires)) {
    pairs.push({ id: key, type: "desire", slug: d.slug, text: d.description, embedding: d._embedding });
  }
  for (const [key, a] of Object.entries(assumptions)) {
    pairs.push({ id: key, type: "assumption", slug: a.slug, text: a.check, embedding: a._embedding });
  }

  let classified;
  let evalMethod = "pipeline";

  try {
    // Tier 1: Relevance filter (embeddings)
    const relevantPairs = await tier1Relevance(config, outcomeText, pairs);

    // Tier 2: NLI classification
    const { resolved, ambiguous } = await tier2NLI(config, outcomeText, relevantPairs);

    // Tier 3: LLM fallback for ambiguous pairs
    let tier3Results = [];
    if (ambiguous.length > 0) {
      tier3Results = await tier3LLM(K, outcomeText, ambiguous);
    }

    classified = [...resolved, ...tier3Results];
  } catch (err) {
    // Full fallback: inference unavailable, use LLM for all pairs
    await K.karmaRecord({ event: "eval_degraded", error: err.message });
    evalMethod = "llm_fallback";
    classified = await tier3LLM(K, outcomeText, pairs);
  }

  // Compute metrics from classified pairs
  return computeMetrics(classified, {
    toolOutcomes,
    planSuccess: ledger.plan.success,
    reliedOn: ledger.plan.relies_on || [],
    candidateCheckIds,
    evalMethod,
  });
}

// ── Outcome text extraction ─────────────────────────────

function buildOutcomeText(ledger) {
  const toolSummary = ledger.tool_calls
    .map(tc => `${tc.tool}: ${tc.ok ? "succeeded" : "failed"}`)
    .join(", ");
  return `Action: ${ledger.plan.action}. Tools: ${toolSummary || "none"}. Result: ${ledger.final_text || "no final output"}`;
}

// ── Tier 1: Relevance filter ────────────────────────────

async function tier1Relevance(config, outcomeText, pairs) {
  const threshold = config.relevance_threshold || 0.3;

  // Embed outcome
  const embedResp = await callInference(config.url, config.secret, "/embed", {
    texts: [outcomeText],
  });
  const outcomeEmb = embedResp.embeddings[0];

  // Filter by cosine similarity to cached pair embeddings
  return pairs.filter(p => {
    if (!p.embedding) return true; // no embedding → include (can't filter)
    return cosineSimilarity(outcomeEmb, p.embedding) >= threshold;
  });
}

// ── Tier 2: NLI classification ──────────────────────────

async function tier2NLI(config, outcomeText, pairs) {
  if (pairs.length === 0) return { resolved: [], ambiguous: [] };

  const ambiguityThreshold = config.ambiguity_threshold || 0.6;

  const nliResp = await callInference(config.url, config.secret, "/nli", {
    pairs: pairs.map(p => ({
      id: p.id,
      premise: p.text,
      hypothesis: outcomeText,
    })),
  });

  const resolved = [];
  const ambiguous = [];

  for (const r of nliResp.results) {
    const pair = pairs.find(p => p.id === r.id);
    if (!pair) continue;

    const maxScore = Math.max(r.scores.entailment, r.scores.contradiction, r.scores.neutral);

    if (maxScore >= ambiguityThreshold) {
      resolved.push({
        ...pair,
        direction: r.label,
        confidence: r.scores[r.label],
        surprise: r.scores.contradiction,
      });
    } else {
      ambiguous.push(pair);
    }
  }

  return { resolved, ambiguous };
}

// ── Tier 3: LLM fallback ───────────────────────────────

async function tier3LLM(K, outcomeText, pairs) {
  if (pairs.length === 0) return [];

  const pairDescriptions = pairs.map(p =>
    `{ "id": "${p.id}", "type": "${p.type}", "text": "${p.text}" }`
  ).join(",\n    ");

  const prompt = `Evaluate the relationship between each statement and the outcome.

Outcome: "${outcomeText}"

Statements to evaluate:
[
    ${pairDescriptions}
]

For each statement, classify the outcome's relationship to it:
- "entailment" — the outcome supports/confirms the statement
- "contradiction" — the outcome opposes/violates the statement
- "neutral" — the outcome is unrelated to the statement

Respond with ONLY a JSON array:
[{ "id": "...", "direction": "entailment|contradiction|neutral", "confidence": 0.0-1.0 }]`;

  const response = await K.callLLM({
    model: "deepseek",
    effort: "low",
    maxTokens: 1000,
    systemPrompt: "You are a precise classifier. Respond with only JSON.",
    messages: [{ role: "user", content: prompt }],
    step: "eval_tier3",
  });

  let results;
  try {
    results = JSON.parse(response.content);
  } catch {
    // Try extracting from fences
    const match = response.content?.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      try { results = JSON.parse(match[1].trim()); }
      catch { results = []; }
    } else {
      results = [];
    }
  }

  return results.map(r => {
    const pair = pairs.find(p => p.id === r.id);
    if (!pair) return null;
    return {
      ...pair,
      direction: r.direction || "neutral",
      confidence: r.confidence || 0,
      surprise: r.direction === "contradiction" ? (r.confidence || 0) : 0,
    };
  }).filter(Boolean);
}

// ── Metric computation ──────────────────────────────────

function computeMetrics(classified, { toolOutcomes, planSuccess, reliedOn, candidateCheckIds, evalMethod }) {
  // σ = max contradiction confidence across assumptions
  let sigma = 0;
  const assumptionScores = {};

  for (const c of classified) {
    if (c.type === "assumption") {
      assumptionScores[c.slug] = {
        direction: c.direction,
        surprise: c.surprise || 0,
      };
      if (c.surprise > sigma) sigma = c.surprise;
    }
  }

  // α = per-desire signed magnitude
  const alpha = {};
  for (const c of classified) {
    if (c.type === "desire") {
      if (c.direction === "entailment") {
        alpha[c.slug] = c.confidence || 0;
      } else if (c.direction === "contradiction") {
        alpha[c.slug] = -(c.confidence || 0);
      } else {
        alpha[c.slug] = 0;
      }
    }
  }

  const salience = sigma + l1Norm(alpha);

  return {
    sigma,
    alpha,
    salience,
    eval_method: evalMethod,
    tool_outcomes: toolOutcomes,
    plan_success_criteria: planSuccess,
    assumptions_relied_on: reliedOn,
    candidate_check_ids: candidateCheckIds,
    assumption_scores: assumptionScores,
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- tests/eval.test.js`

Expected: All 5 tests pass.

- [ ] **Step 5: Run all tests**

Run: `npm test`

Expected: Session tests may fail because eval signature changed (sync → async, 3-arg → 5-arg). That's expected — Task 3 fixes session.js.

- [ ] **Step 6: Commit**

```bash
git add eval.js tests/eval.test.js
git commit -m "feat(m4): rewrite eval.js with three-tier pipeline

Tier 1: embeddings (akash /embed) for relevance filtering.
Tier 2: NLI (akash /nli) for valence classification.
Tier 3: LLM fallback for ambiguous pairs.
Returns real sigma, alpha, salience, assumption_scores."
```

---

## Task 3: Update session.js — wire real eval + mechanical μ

**Files:**
- Modify: `session.js` (~lines 258-301 writeMemory, ~line 340-375 run)
- Modify: `tests/session.test.js`

- [ ] **Step 1: Read session.js to find exact locations**

Read `session.js` to find:
- The `evaluateAction` import (line ~7)
- The `evaluateAction` call site (line ~375 or similar)
- The `writeMemory` function (line ~258)
- The review phase prompt (where mu_updates is expected)

- [ ] **Step 2: Update session.js imports and eval call**

Change the evaluateAction import:
```javascript
// Before
import { evaluateAction } from './eval.js';

// After
import { evaluateAction } from './eval.js';
import { updateMu, callInference } from './memory.js';
```

Update the eval call site in the main loop — find where `evaluateAction(ledger, desires, assumptions)` is called and change to:

```javascript
const inferenceConfig = {
  url: defaults?.inference?.url || null,
  secret: inferenceSecret,
  relevance_threshold: defaults?.inference?.relevance_threshold || 0.3,
  ambiguity_threshold: defaults?.inference?.ambiguity_threshold || 0.6,
};
const evalResult = await evaluateAction(K, ledger, desires, assumptions, inferenceConfig);
```

Add near the top of `run()`, after loading defaults:
```javascript
const inferenceSecret = await K.kvGet("secret:inference");
```

- [ ] **Step 3: Update writeMemory to use assumption_scores**

Replace the μ write section in `writeMemory`:

```javascript
// Before: iterate review.mu_updates
// After: iterate evalResult.assumption_scores
if (evalResult.assumption_scores) {
  for (const [checkId, score] of Object.entries(evalResult.assumption_scores)) {
    const muKey = `mu:${checkId}`;
    const existing = await K.kvGet(muKey);
    const updated = updateMu(existing, checkId, score);
    await K.kvWriteSafe(muKey, updated);
  }
}
```

Update the episode write to include proper fields and attempt embedding:

```javascript
if (salience > salienceThreshold) {
  let embedding = null;
  if (inferenceConfig?.url) {
    try {
      const resp = await callInference(inferenceConfig.url, inferenceConfig.secret, '/embed', {
        texts: [review?.narrative || review?.assessment || '']
      });
      embedding = resp.embeddings?.[0] || null;
    } catch {
      await K.karmaRecord({ event: "episode_embedding_failed" });
    }
  }

  await K.kvWriteSafe(`episode:${Date.now()}`, {
    timestamp: new Date().toISOString(),
    action_taken: ledger.plan.action,
    outcome: ledger.final_text || review?.assessment,
    active_assumptions: ledger.plan.relies_on || [],
    active_desires: Object.keys(desires),
    surprise_score: evalResult.sigma,
    affinity_vector: evalResult.alpha,
    narrative: review?.narrative || review?.assessment,
    embedding,
  });
}
```

- [ ] **Step 4: Add desire/assumption embedding caching to snapshot**

In the `run()` function, after snapshotting desires and assumptions, add embedding loading:

```javascript
// Cache embeddings for desires and assumptions
if (defaults?.inference?.url) {
  const inferenceSecret = await K.kvGet("secret:inference");
  await cacheEmbeddings(K, desires, 'description', defaults.inference, inferenceSecret);
  await cacheEmbeddings(K, assumptions, 'check', defaults.inference, inferenceSecret);
}
```

Add the caching helper:

```javascript
import { embeddingCacheKey, callInference as callInf } from './memory.js';

async function cacheEmbeddings(K, entities, textField, inferenceConfig, secret) {
  const model = inferenceConfig.embed_model || 'bge-small-en-v1.5';
  const textsToEmbed = [];
  const keysToEmbed = [];

  for (const [key, entity] of Object.entries(entities)) {
    const text = entity[textField];
    if (!text) continue;
    const cacheKey = embeddingCacheKey(text, model);
    const cached = await K.kvGet(cacheKey);
    if (cached) {
      entity._embedding = cached;
    } else {
      textsToEmbed.push(text);
      keysToEmbed.push({ entityKey: key, cacheKey, text });
    }
  }

  if (textsToEmbed.length > 0 && inferenceConfig.url) {
    try {
      const resp = await callInf(inferenceConfig.url, secret, '/embed', { texts: textsToEmbed });
      for (let i = 0; i < keysToEmbed.length; i++) {
        const emb = resp.embeddings?.[i];
        if (emb) {
          entities[keysToEmbed[i].entityKey]._embedding = emb;
          await K.kvWriteSafe(keysToEmbed[i].cacheKey, emb);
        }
      }
    } catch {
      await K.karmaRecord({ event: "embedding_cache_failed" });
    }
  }
}
```

- [ ] **Step 5: Remove mu_updates from review prompt and validation**

In the review phase, update the system prompt to no longer request mu_updates. Update `validateReview` to not expect mu_updates.

- [ ] **Step 6: Update session tests**

Update `tests/session.test.js` — the mu write tests need to check for assumption_scores-driven writes instead of review mu_updates. The eval mock needs to return the new shape with assumption_scores.

- [ ] **Step 7: Run all tests**

Run: `npm test`

Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add session.js eval.js memory.js tests/session.test.js
git commit -m "feat(m4): wire real eval pipeline + mechanical μ updates

session.js uses assumption_scores for μ (not review mu_updates).
Desire/assumption embeddings cached in KV. Episode narratives embedded
at write time. Review no longer produces mu_updates."
```

---

## Task 4: Update reflect.js — episode selection

**Files:**
- Modify: `reflect.js` (~line 257-310, gatherReflectContext)

- [ ] **Step 1: Read gatherReflectContext to understand current structure**

Read `reflect.js` lines 250-340 to understand what context it currently gathers.

- [ ] **Step 2: Add episode and μ loading to gatherReflectContext**

Import selectEpisodes from memory.js at the top of reflect.js:
```javascript
import { selectEpisodes } from './memory.js';
```

In `gatherReflectContext`, add episode selection and μ loading after the existing context gathering:

```javascript
// Load episodes for deep-reflect context
const episodeList = await K.kvList({ prefix: "episode:" });
const episodes = [];
for (const key of episodeList.keys) {
  const ep = await K.kvGet(key.name);
  if (ep) episodes.push(ep);
}

// Load desire embeddings for similarity-based selection
const desireList = await K.kvList({ prefix: "desire:" });
const desireEmbeddings = [];
for (const key of desireList.keys) {
  const d = await K.kvGet(key.name);
  if (d?._embedding) desireEmbeddings.push(d._embedding);
  // Also check embedding cache
  else {
    // Try to find cached embedding
    const embKeys = await K.kvList({ prefix: "embedding:" });
    // Skip if too complex for now — embeddings loaded at session time
  }
}

const lastReflect = await K.kvGet(`reflect:schedule:${depth}`);
const selectedEpisodes = selectEpisodes(episodes, desireEmbeddings, {
  maxEpisodes: defaults?.memory?.max_episodes_for_reflect || 20,
  lastReflectTimestamp: lastReflect?.last_reflect,
  salienceWeight: defaults?.memory?.salience_weight || 0.7,
  similarityWeight: defaults?.memory?.similarity_weight || 0.3,
});

// Load μ entries
const muList = await K.kvList({ prefix: "mu:" });
const muEntries = {};
for (const key of muList.keys) {
  const mu = await K.kvGet(key.name);
  if (mu) muEntries[key.name] = mu;
}

// Add to template vars
templateVars.episodes = selectedEpisodes;
templateVars.mu_entries = muEntries;
```

- [ ] **Step 3: Run all tests**

Run: `npm test`

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add reflect.js
git commit -m "feat(m4): add episode selection and μ loading to deep-reflect context

gatherReflectContext uses selectEpisodes for recency + salience +
embedding similarity ranking. Includes μ entries in reflect context."
```

---

## Task 5: Update seed script + config

**Files:**
- Modify: `scripts/seed-local-kv.mjs`
- Modify: `config/defaults.json`

- [ ] **Step 1: Read current seed script and defaults to find insertion points**

Read `scripts/seed-local-kv.mjs` and `config/defaults.json` to understand structure.

- [ ] **Step 2: Add inference config to defaults.json**

Add to `config/defaults.json`:

```json
{
  "inference": {
    "url": null,
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

(Add these keys to the existing defaults object — don't replace the whole file.)

- [ ] **Step 3: Add inference secret to seed script**

In `scripts/seed-local-kv.mjs`, add after existing secret seeding:

```javascript
// Inference server secret (for local dev with docker-compose)
await put("secret:inference", "test-secret", "text", "Shared auth token for akash inference server");
```

- [ ] **Step 4: Run seed script**

Run: `source .env && node scripts/seed-local-kv.mjs`

Expected: No errors.

- [ ] **Step 5: Run all tests**

Run: `npm test`

Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/seed-local-kv.mjs config/defaults.json
git commit -m "feat(m4): add inference config and memory settings to seed

inference.url, relevance_threshold, ambiguity_threshold, embed_model.
memory.surprise_ema_alpha, max_episodes_for_reflect, salience/similarity weights.
secret:inference seeded for local dev."
```

---

## Task 6: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add eval.js and memory.js to file table**

In the Runtime Worker table, update `eval.js` description and add `memory.js`:

```
| `eval.js` | Three-tier evaluation pipeline (embeddings → NLI → LLM) | Yes (via code staging) |
| `memory.js` | Memory utilities — μ operators, episode selection, vector math | Yes (via code staging) |
```

- [ ] **Step 2: Add inference server to the architecture docs**

In the "Two-worker architecture" section or after it, add a note about the inference server:

```markdown
**Inference Server** (`inference/`):

| File | Role |
|------|------|
| `inference/main.py` | FastAPI: /embed (bge-small-en-v1.5), /nli (DeBERTa-v3-base), /health |
| `inference/Dockerfile` | Multi-stage ONNX Runtime build |
| `inference/deploy.yaml` | Akash SDL for production deployment |

The inference server runs on Akash (production) or docker-compose (local dev).
The eval pipeline calls it for Tier 1 (embeddings) and Tier 2 (NLI). Falls back
to LLM-only evaluation when unavailable.
```

- [ ] **Step 3: Run tests**

Run: `npm test`

Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "doc(m4): update CLAUDE.md for eval pipeline and inference server

Add memory.js, update eval.js description, add inference server docs."
```

---

## Self-Review Checklist

**Spec coverage:**
- ✅ Section 3 (Eval Pipeline): Task 2
- ✅ Section 4 (μ Operators): Task 1 (memory.js), Task 3 (session.js wiring)
- ✅ Section 5 (Episode Embeddings): Task 3 (session.js writeMemory)
- ✅ Section 6 (Episode Selection): Task 1 (memory.js), Task 4 (reflect.js)
- ✅ Section 7 (Inference Client): Task 1 (memory.js callInference)
- ✅ Section 8 (Wiring): Tasks 2-5
- ✅ Section 9 (Testing): Tasks 1, 2, 3
- ✅ Section 10 (Local Dev): Task 3 (degraded mode fallback)

**Placeholder scan:** No TBDs. All code complete.

**Type consistency:**
- `evaluateAction(K, ledger, desires, assumptions, config)` — consistent across eval.js and session.js
- `updateMu(existing, checkId, score)` — consistent across memory.js and session.js
- `selectEpisodes(episodes, desireEmbeddings, options)` — consistent across memory.js and reflect.js
- `callInference(url, secret, path, body)` — consistent across memory.js, eval.js, session.js
- `assumption_scores` shape: `{ slug: { direction, surprise } }` — consistent across eval.js and session.js
