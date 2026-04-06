import { describe, it, expect } from "vitest";

// ── Schema validators ──────────────────────────────────────
// Lightweight validation for cognitive architecture entities.
// These are the canonical shapes — if a field is missing or
// wrong-typed, the test catches it before it hits KV.

function validateDesire(d) {
  const errors = [];
  if (typeof d.slug !== "string" || !d.slug) errors.push("slug must be a non-empty string");
  if (d.direction !== "approach") errors.push("direction must be 'approach'");
  if (typeof d.description !== "string" || !d.description) errors.push("description must be a non-empty string");
  if (!Array.isArray(d.source_principles) || d.source_principles.length === 0) errors.push("source_principles must be a non-empty array");
  if (typeof d.created_at !== "string") errors.push("created_at must be an ISO 8601 string");
  if (typeof d.updated_at !== "string") errors.push("updated_at must be an ISO 8601 string");
  return errors;
}

function validatePattern(s) {
  const errors = [];
  if (typeof s.pattern !== "string" || !s.pattern) errors.push("pattern must be a non-empty string");
  if (typeof s.strength !== "number" || s.strength < 0 || s.strength > 1) errors.push("strength must be a number between 0 and 1");
  return errors;
}

function validateExperience(e) {
  const errors = [];
  if (typeof e.timestamp !== "string") errors.push("timestamp must be an ISO 8601 string");
  if (e.action_ref !== null && typeof e.action_ref !== "string") errors.push("action_ref must be a string or null");
  if (e.session_id !== null && typeof e.session_id !== "string") errors.push("session_id must be a string or null");
  if (typeof e.cycle !== "number") errors.push("cycle must be a number");
  if (typeof e.observation !== "string") errors.push("observation must be a string");
  if (!e.desire_alignment || typeof e.desire_alignment !== "object") errors.push("desire_alignment must be an object");
  if (!e.pattern_delta || typeof e.pattern_delta !== "object") errors.push("pattern_delta must be an object");
  if (typeof e.pattern_delta?.sigma !== "number") errors.push("pattern_delta.sigma must be a number");
  if (!Array.isArray(e.pattern_delta?.scores)) errors.push("pattern_delta.scores must be an array");
  if (typeof e.salience !== "number") errors.push("salience must be a number");
  if (e.text_rendering !== undefined && typeof e.text_rendering !== "object") errors.push("text_rendering must be an object if present");
  if (e.text_rendering?.narrative !== undefined && typeof e.text_rendering.narrative !== "string") errors.push("text_rendering.narrative must be a string if present");
  if (e.embedding !== undefined && e.embedding !== null && !Array.isArray(e.embedding)) errors.push("embedding must be a number array or null if present");
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

  describe("Pattern", () => {
    it("validates a well-formed pattern", () => {
      const pattern = {
        pattern: "Slack fails silently — success responses don't guarantee delivery",
        strength: 0.85,
      };
      expect(validatePattern(pattern)).toEqual([]);
    });

    it("rejects missing pattern", () => {
      const pattern = { strength: 0.5 };
      const errors = validatePattern(pattern);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toMatch(/pattern/);
    });

    it("rejects strength out of range", () => {
      expect(validatePattern({ pattern: "test", strength: 1.5 }).length).toBeGreaterThan(0);
      expect(validatePattern({ pattern: "test", strength: -0.1 }).length).toBeGreaterThan(0);
    });

    it("accepts strength at boundaries", () => {
      expect(validatePattern({ pattern: "test", strength: 0 })).toEqual([]);
      expect(validatePattern({ pattern: "test", strength: 1 })).toEqual([]);
    });
  });

  describe("Experience", () => {
    it("validates a well-formed experience", () => {
      const experience = {
        timestamp: "2026-03-20T10:00:00.000Z",
        action_ref: "action:a_1",
        session_id: "session_1",
        cycle: 0,
        observation: "A greeting message was sent and delivery succeeded.",
        desire_alignment: {
          top_positive: [{ desire_key: "desire:serve", score: 0.8 }],
          top_negative: [],
          affinity_magnitude: 0.8,
        },
        pattern_delta: {
          sigma: 0.1,
          scores: [],
        },
        salience: 0.3,
        text_rendering: { narrative: "Routine greeting. No issues." },
        embedding: null,
      };
      expect(validateExperience(experience)).toEqual([]);
    });

    it("accepts embedding as array of numbers", () => {
      const experience = {
        timestamp: "2026-03-20T10:00:00.000Z",
        action_ref: "action:a_2",
        session_id: "session_2",
        cycle: 1,
        observation: "A test action completed successfully.",
        desire_alignment: {
          top_positive: [],
          top_negative: [{ desire_key: "desire:resource-stewardship", score: 0.7 }],
          affinity_magnitude: 0.7,
        },
        pattern_delta: {
          sigma: 0.5,
          scores: [{ pattern_key: "pattern:test", direction: "contradiction", surprise: 0.5 }],
        },
        salience: 0.7,
        text_rendering: { narrative: "test" },
        embedding: [0.1, 0.2, 0.3],
      };
      expect(validateExperience(experience)).toEqual([]);
    });

    it("rejects missing salience", () => {
      const experience = {
        timestamp: "2026-03-20T10:00:00.000Z",
        action_ref: "action:a_3",
        session_id: "session_3",
        cycle: 0,
        observation: "test",
        desire_alignment: {
          top_positive: [],
          top_negative: [],
          affinity_magnitude: 0,
        },
        pattern_delta: {
          sigma: 0.5,
          scores: [],
        },
        text_rendering: { narrative: "test" },
        embedding: null,
      };
      const errors = validateExperience(experience);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toMatch(/salience/);
    });
  });
});
