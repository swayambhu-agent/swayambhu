import { describe, it, expect } from "vitest";

// ── Schema validators ──────────────────────────────────────
// Lightweight validation for cognitive architecture entities.
// These are the canonical shapes — if a field is missing or
// wrong-typed, the test catches it before it hits KV.

function validateDesire(d) {
  const errors = [];
  if (typeof d.slug !== "string" || !d.slug) errors.push("slug must be a non-empty string");
  if (d.direction !== "approach" && d.direction !== "avoidance") errors.push("direction must be 'approach' or 'avoidance'");
  if (typeof d.description !== "string" || !d.description) errors.push("description must be a non-empty string");
  if (!Array.isArray(d.source_principles) || d.source_principles.length === 0) errors.push("source_principles must be a non-empty array");
  if (typeof d.created_at !== "string") errors.push("created_at must be an ISO 8601 string");
  if (typeof d.updated_at !== "string") errors.push("updated_at must be an ISO 8601 string");
  return errors;
}

function validateAssumption(a) {
  const errors = [];
  if (typeof a.slug !== "string" || !a.slug) errors.push("slug must be a non-empty string");
  if (typeof a.check !== "string" || !a.check) errors.push("check must be a non-empty string");
  if (typeof a.confidence !== "number" || a.confidence < 0 || a.confidence > 1) errors.push("confidence must be a number between 0 and 1");
  if (typeof a.ttl_expires !== "string") errors.push("ttl_expires must be an ISO 8601 string");
  if (!["observation", "inference", "statistical"].includes(a.source)) errors.push("source must be 'observation', 'inference', or 'statistical'");
  if (typeof a.created_at !== "string") errors.push("created_at must be an ISO 8601 string");
  return errors;
}

function validateMu(m) {
  const errors = [];
  if (typeof m.check_id !== "string" || !m.check_id) errors.push("check_id must be a non-empty string");
  if (typeof m.confirmation_count !== "number" || !Number.isInteger(m.confirmation_count)) errors.push("confirmation_count must be an integer");
  if (typeof m.violation_count !== "number" || !Number.isInteger(m.violation_count)) errors.push("violation_count must be an integer");
  if (m.last_checked !== null && typeof m.last_checked !== "string") errors.push("last_checked must be an ISO 8601 string or null");
  if (typeof m.cumulative_surprise !== "number") errors.push("cumulative_surprise must be a number");
  return errors;
}

function validateEpisode(e) {
  const errors = [];
  if (typeof e.timestamp !== "string") errors.push("timestamp must be an ISO 8601 string");
  if (typeof e.action_taken !== "string") errors.push("action_taken must be a string");
  if (typeof e.outcome !== "string") errors.push("outcome must be a string");
  if (!Array.isArray(e.active_assumptions)) errors.push("active_assumptions must be an array");
  if (!Array.isArray(e.active_desires)) errors.push("active_desires must be an array");
  if (typeof e.surprise_score !== "number") errors.push("surprise_score must be a number");
  if (typeof e.affinity_vector !== "object" || e.affinity_vector === null || Array.isArray(e.affinity_vector)) errors.push("affinity_vector must be a plain object");
  if (typeof e.narrative !== "string") errors.push("narrative must be a string");
  if (e.embedding !== null && !Array.isArray(e.embedding)) errors.push("embedding must be a number array or null");
  return errors;
}

// ── Tests ──────────────────────────────────────────────────

describe("Cognitive architecture schemas", () => {
  describe("Desire", () => {
    it("validates a well-formed desire", () => {
      const desire = {
        slug: "serve",
        direction: "approach",
        description: "Serve seekers of inner wellbeing",
        source_principles: ["care", "responsibility"],
        created_at: "2026-03-31T00:00:00.000Z",
        updated_at: "2026-03-31T00:00:00.000Z",
      };
      expect(validateDesire(desire)).toEqual([]);
    });

    it("rejects missing slug", () => {
      const desire = {
        slug: "",
        direction: "approach",
        description: "test",
        source_principles: ["care"],
        created_at: "2026-03-31T00:00:00.000Z",
        updated_at: "2026-03-31T00:00:00.000Z",
      };
      expect(validateDesire(desire)).toContainEqual(expect.stringContaining("slug"));
    });

    it("rejects invalid direction", () => {
      const desire = {
        slug: "test",
        direction: "neutral",
        description: "test",
        source_principles: ["care"],
        created_at: "2026-03-31T00:00:00.000Z",
        updated_at: "2026-03-31T00:00:00.000Z",
      };
      expect(validateDesire(desire)).toContainEqual(expect.stringContaining("direction"));
    });

    it("rejects empty source_principles", () => {
      const desire = {
        slug: "test",
        direction: "approach",
        description: "test",
        source_principles: [],
        created_at: "2026-03-31T00:00:00.000Z",
        updated_at: "2026-03-31T00:00:00.000Z",
      };
      expect(validateDesire(desire)).toContainEqual(expect.stringContaining("source_principles"));
    });
  });

  describe("Assumption", () => {
    it("validates a well-formed assumption", () => {
      const assumption = {
        slug: "slack-channel-working",
        check: "The Slack channel is operational",
        confidence: 0.8,
        ttl_expires: "2026-04-10T00:00:00.000Z",
        source: "observation",
        created_at: "2026-03-31T00:00:00.000Z",
      };
      expect(validateAssumption(assumption)).toEqual([]);
    });

    it("rejects confidence out of range", () => {
      const assumption = {
        slug: "test",
        check: "test",
        confidence: 1.5,
        ttl_expires: "2026-04-10T00:00:00.000Z",
        source: "observation",
        created_at: "2026-03-31T00:00:00.000Z",
      };
      expect(validateAssumption(assumption)).toContainEqual(expect.stringContaining("confidence"));
    });

    it("rejects invalid source", () => {
      const assumption = {
        slug: "test",
        check: "test",
        confidence: 0.5,
        ttl_expires: "2026-04-10T00:00:00.000Z",
        source: "guess",
        created_at: "2026-03-31T00:00:00.000Z",
      };
      expect(validateAssumption(assumption)).toContainEqual(expect.stringContaining("source"));
    });
  });

  describe("Statistical memory (μ)", () => {
    it("validates a well-formed mu entry", () => {
      const mu = {
        check_id: "slack-delivery",
        confirmation_count: 12,
        violation_count: 1,
        last_checked: "2026-03-31T12:00:00.000Z",
        cumulative_surprise: 0.15,
      };
      expect(validateMu(mu)).toEqual([]);
    });

    it("accepts null last_checked (never checked)", () => {
      const mu = {
        check_id: "new-check",
        confirmation_count: 0,
        violation_count: 0,
        last_checked: null,
        cumulative_surprise: 0,
      };
      expect(validateMu(mu)).toEqual([]);
    });

    it("rejects non-integer counts", () => {
      const mu = {
        check_id: "test",
        confirmation_count: 1.5,
        violation_count: 0,
        last_checked: null,
        cumulative_surprise: 0,
      };
      expect(validateMu(mu)).toContainEqual(expect.stringContaining("confirmation_count"));
    });
  });

  describe("Episodic memory (ε)", () => {
    it("validates a well-formed episode", () => {
      const episode = {
        timestamp: "2026-03-31T12:00:00.000Z",
        action_taken: "Compiled research doc",
        outcome: "Doc saved, 3200 words",
        active_assumptions: ["assumption:google-docs-accessible"],
        active_desires: ["desire:serve"],
        surprise_score: 0.2,
        affinity_vector: { serve: 0.7, conserve: -0.1 },
        narrative: "Successfully compiled the research doc",
        embedding: null,
      };
      expect(validateEpisode(episode)).toEqual([]);
    });

    it("accepts embedding as number array", () => {
      const episode = {
        timestamp: "2026-03-31T12:00:00.000Z",
        action_taken: "test",
        outcome: "test",
        active_assumptions: [],
        active_desires: [],
        surprise_score: 0,
        affinity_vector: {},
        narrative: "test",
        embedding: [0.1, 0.2, 0.3],
      };
      expect(validateEpisode(episode)).toEqual([]);
    });

    it("rejects affinity_vector as array", () => {
      const episode = {
        timestamp: "2026-03-31T12:00:00.000Z",
        action_taken: "test",
        outcome: "test",
        active_assumptions: [],
        active_desires: [],
        surprise_score: 0,
        affinity_vector: [0.1, 0.2],
        narrative: "test",
        embedding: null,
      };
      expect(validateEpisode(episode)).toContainEqual(expect.stringContaining("affinity_vector"));
    });
  });
});
