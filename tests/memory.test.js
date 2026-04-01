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
    // EMA: 0.3 * 0.05 + 0.7 * 0.1 = 0.015 + 0.07 = 0.085
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
    expect(result).toHaveLength(2);
    expect(new Date(result[0].timestamp).getTime()).toBeGreaterThan(new Date("2026-03-20").getTime());
  });

  it("boosts score with embedding similarity when desire embeddings provided", () => {
    const desireEmbeddings = [[1, 0, 0]];
    const result = selectEpisodes(episodes, desireEmbeddings, { maxEpisodes: 2 });
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
