import { describe, it, expect } from "vitest";
import { updateSamskaraStrength, selectExperiences, cosineSimilarity, embeddingCacheKey } from "../memory.js";

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

describe("updateSamskaraStrength", () => {
  it("moves strength toward 1 on confirmation (low surprise)", () => {
    const result = updateSamskaraStrength(0.5, 0.1);
    expect(result).toBeCloseTo(0.62, 2);
  });

  it("moves strength toward 0 on violation (high surprise)", () => {
    const result = updateSamskaraStrength(0.5, 0.9);
    expect(result).toBeCloseTo(0.38, 2);
  });

  it("uses custom alpha", () => {
    const result = updateSamskaraStrength(0.5, 0.0, 0.5);
    expect(result).toBeCloseTo(0.75, 2);
  });

  it("clamps result to [0, 1]", () => {
    expect(updateSamskaraStrength(1.0, 0.0)).toBeLessThanOrEqual(1);
    expect(updateSamskaraStrength(0.0, 1.0)).toBeGreaterThanOrEqual(0);
  });

  it("returns unchanged for zero surprise with strength near 1", () => {
    const result = updateSamskaraStrength(0.95, 0.0);
    expect(result).toBeGreaterThan(0.95);
    expect(result).toBeLessThanOrEqual(1);
  });
});

describe("selectExperiences", () => {
  const experiences = [
    { timestamp: "2026-03-01T00:00:00Z", salience: 0.9, surprise_score: 0.8, affinity_vector: { serve: 0.1 }, embedding: [1, 0, 0] },
    { timestamp: "2026-03-15T00:00:00Z", salience: 0.3, surprise_score: 0.2, affinity_vector: { serve: 0.1 }, embedding: [0, 1, 0] },
    { timestamp: "2026-03-29T00:00:00Z", salience: 0.7, surprise_score: 0.5, affinity_vector: { serve: 0.2 }, embedding: [0.7, 0.7, 0] },
    { timestamp: "2026-03-30T00:00:00Z", salience: 0.5, surprise_score: 0.3, affinity_vector: { serve: 0.2 }, embedding: [0, 0, 1] },
  ];

  it("returns top N by salience", () => {
    const result = selectExperiences(experiences, [], { maxEpisodes: 2 });
    expect(result).toHaveLength(2);
    expect(result[0].salience).toBe(0.9);
    expect(result[1].salience).toBe(0.7);
  });

  it("prioritizes recent experiences when lastReflectTimestamp set", () => {
    const result = selectExperiences(experiences, [], {
      maxEpisodes: 2,
      lastReflectTimestamp: "2026-03-20T00:00:00Z",
    });
    expect(result).toHaveLength(2);
    expect(new Date(result[0].timestamp).getTime()).toBeGreaterThan(new Date("2026-03-20").getTime());
  });

  it("boosts score with embedding similarity when desire embeddings provided", () => {
    const desireEmbeddings = [[1, 0, 0]];
    const result = selectExperiences(experiences, desireEmbeddings, { maxEpisodes: 2 });
    expect(result[0]).toBe(experiences[0]);
  });

  it("handles experiences without embeddings", () => {
    const noEmbedExperiences = experiences.map(e => ({ ...e, embedding: null }));
    const result = selectExperiences(noEmbedExperiences, [[1, 0, 0]], { maxEpisodes: 2 });
    expect(result).toHaveLength(2);
  });

  it("returns all experiences when fewer than maxEpisodes", () => {
    const result = selectExperiences(experiences, [], { maxEpisodes: 100 });
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
