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

function validateSamskara(s) {
  const errors = [];
  if (typeof s.pattern !== "string" || !s.pattern) errors.push("pattern must be a non-empty string");
  if (typeof s.strength !== "number" || s.strength < 0 || s.strength > 1) errors.push("strength must be a number between 0 and 1");
  return errors;
}

function validateExperience(e) {
  const errors = [];
  if (typeof e.timestamp !== "string") errors.push("timestamp must be an ISO 8601 string");
  if (typeof e.action_taken !== "string") errors.push("action_taken must be a string");
  if (typeof e.outcome !== "string") errors.push("outcome must be a string");
  if (typeof e.surprise_score !== "number") errors.push("surprise_score must be a number");
  if (typeof e.salience !== "number") errors.push("salience must be a number");
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

  describe("Samskara", () => {
    it("validates a well-formed samskara", () => {
      const samskara = {
        pattern: "Slack fails silently — success responses don't guarantee delivery",
        strength: 0.85,
      };
      expect(validateSamskara(samskara)).toEqual([]);
    });

    it("rejects missing pattern", () => {
      const samskara = { strength: 0.5 };
      const errors = validateSamskara(samskara);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toMatch(/pattern/);
    });

    it("rejects strength out of range", () => {
      expect(validateSamskara({ pattern: "test", strength: 1.5 }).length).toBeGreaterThan(0);
      expect(validateSamskara({ pattern: "test", strength: -0.1 }).length).toBeGreaterThan(0);
    });

    it("accepts strength at boundaries", () => {
      expect(validateSamskara({ pattern: "test", strength: 0 })).toEqual([]);
      expect(validateSamskara({ pattern: "test", strength: 1 })).toEqual([]);
    });
  });

  describe("Experience", () => {
    it("validates a well-formed experience", () => {
      const experience = {
        timestamp: "2026-03-20T10:00:00.000Z",
        action_taken: "Sent a greeting to the patron",
        outcome: "Message delivered successfully",
        surprise_score: 0.1,
        salience: 0.3,
        narrative: "Routine greeting. No issues.",
        embedding: null,
      };
      expect(validateExperience(experience)).toEqual([]);
    });

    it("accepts embedding as array of numbers", () => {
      const experience = {
        timestamp: "2026-03-20T10:00:00.000Z",
        action_taken: "test",
        outcome: "test",
        surprise_score: 0.5,
        salience: 0.7,
        narrative: "test",
        embedding: [0.1, 0.2, 0.3],
      };
      expect(validateExperience(experience)).toEqual([]);
    });

    it("rejects missing salience", () => {
      const experience = {
        timestamp: "2026-03-20T10:00:00.000Z",
        action_taken: "test",
        outcome: "test",
        surprise_score: 0.5,
        narrative: "test",
        embedding: null,
      };
      const errors = validateExperience(experience);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toMatch(/salience/);
    });
  });
});
