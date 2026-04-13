import { describe, it, expect } from "vitest";
import {
  shouldAutoApply,
  routeProposal,
  generateApprovalId,
} from "../../lib/operator/dev-loop/decide.js";

// ── routeProposal ─────────────────────────────────────────

describe("routeProposal", () => {
  it("returns cold_start when the classifier marks the state as cold-start-only", () => {
    const result = routeProposal({
      blast_radius: "local",
      evidence_quality: "strong",
      challenge_converged: true,
      cold_start: true,
    });
    expect(result).toEqual({
      action: "cold_start",
      reason: "state requires cold start recovery",
    });
  });

  it("escalates when the classifier says human judgment is required", () => {
    const result = routeProposal({
      blast_radius: "local",
      evidence_quality: "moderate",
      challenge_converged: false,
      requires_human_judgment: true,
    });
    expect(result).toEqual({
      action: "escalate",
      reason: "change requires human judgment",
    });
  });

  it("auto-applies local + moderate evidence", () => {
    const result = routeProposal({
      blast_radius: "local",
      evidence_quality: "moderate",
      challenge_converged: false,
    });
    expect(result).toEqual({
      action: "auto_apply",
      reason: "local change with moderate evidence - safe to auto-apply",
    });
  });

  it("auto-applies module + strong evidence when challenge converged", () => {
    const result = routeProposal({
      blast_radius: "module",
      evidence_quality: "strong",
      challenge_converged: true,
    });
    expect(result).toEqual({
      action: "auto_apply",
      reason: "module-level change with strong evidence and converged challenge - safe to auto-apply",
    });
  });

  it("defers module + strong evidence when challenge did not converge", () => {
    const result = routeProposal({
      blast_radius: "module",
      evidence_quality: "strong",
      challenge_converged: false,
    });
    expect(result).toEqual({
      action: "defer",
      reason: "module-level change needs converged challenge before auto-apply",
    });
  });

  it("defers module + moderate evidence", () => {
    const result = routeProposal({
      blast_radius: "module",
      evidence_quality: "moderate",
      challenge_converged: true,
    });
    expect(result).toEqual({
      action: "defer",
      reason: "module-level change needs strong evidence (have moderate)",
    });
  });

  it("escalates system + strong evidence when challenge converged", () => {
    const result = routeProposal({
      blast_radius: "system",
      evidence_quality: "strong",
      challenge_converged: true,
    });
    expect(result).toEqual({
      action: "escalate",
      reason: "system-level change with strong evidence and converged challenge requires human approval",
    });
  });

  it("defers system + strong evidence when challenge did not converge", () => {
    const result = routeProposal({
      blast_radius: "system",
      evidence_quality: "strong",
      challenge_converged: false,
    });
    expect(result).toEqual({
      action: "defer",
      reason: "system-level change needs converged challenge before escalation",
    });
  });

  it("rejects weak evidence for any blast radius", () => {
    for (const radius of ["local", "module", "system"]) {
      const result = routeProposal({
        blast_radius: radius,
        evidence_quality: "weak",
        challenge_converged: true,
      });
      expect(result).toEqual({
        action: "defer",
        reason: "evidence too weak (weak) to act on",
      });
    }
  });
});

// ── shouldAutoApply ───────────────────────────────────────

describe("shouldAutoApply", () => {
  it("returns true for local + moderate+", () => {
    expect(shouldAutoApply("local", "moderate")).toBe(true);
    expect(shouldAutoApply("local", "strong")).toBe(true);
  });

  it("returns false for local + weak", () => {
    expect(shouldAutoApply("local", "weak")).toBe(false);
  });

  it("returns false for system", () => {
    expect(shouldAutoApply("system", "weak")).toBe(false);
    expect(shouldAutoApply("system", "moderate")).toBe(false);
    expect(shouldAutoApply("system", "strong")).toBe(false);
  });

  it("returns true for module + strong only", () => {
    expect(shouldAutoApply("module", "strong")).toBe(true);
    expect(shouldAutoApply("module", "moderate")).toBe(false);
    expect(shouldAutoApply("module", "weak")).toBe(false);
  });
});

// ── generateApprovalId ────────────────────────────────────

describe("generateApprovalId", () => {
  it("generates 5-char alphanumeric ID", () => {
    const id = generateApprovalId("2026-04-04T12:30:00.000Z", 3);
    expect(id).toHaveLength(5);
    expect(id).toMatch(/^[a-z2-9]{5}$/);
  });

  it("generates unique IDs", () => {
    const ids = new Set();
    for (let i = 0; i < 100; i++) ids.add(generateApprovalId("ts", i));
    expect(ids.size).toBe(100);
  });
});
