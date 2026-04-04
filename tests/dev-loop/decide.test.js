import { describe, it, expect } from "vitest";
import {
  shouldAutoApply,
  routeProposal,
  generateApprovalId,
} from "../../scripts/dev-loop/decide.mjs";

// ── routeProposal ─────────────────────────────────────────

describe("routeProposal", () => {
  it("auto-applies local + moderate evidence", () => {
    const result = routeProposal({
      blast_radius: "local",
      evidence_quality: "moderate",
    });
    expect(result.action).toBe("auto_apply");
    expect(result.reason).toBeTruthy();
  });

  it("auto-applies local + strong evidence", () => {
    const result = routeProposal({
      blast_radius: "local",
      evidence_quality: "strong",
    });
    expect(result.action).toBe("auto_apply");
  });

  it("requires approval for system blast radius", () => {
    for (const quality of ["weak", "moderate", "strong"]) {
      const result = routeProposal({
        blast_radius: "system",
        evidence_quality: quality,
      });
      // System: weak → defer, moderate/strong → escalate
      if (quality === "weak") {
        expect(result.action).toBe("defer");
      } else {
        expect(result.action).toBe("escalate");
      }
    }
  });

  it("notes module-level changes with strong evidence", () => {
    const result = routeProposal({
      blast_radius: "module",
      evidence_quality: "strong",
    });
    expect(result.action).toBe("apply_and_note");
    expect(result.reason).toBeTruthy();
  });

  it("defers module-level changes with moderate evidence", () => {
    const result = routeProposal({
      blast_radius: "module",
      evidence_quality: "moderate",
    });
    expect(result.action).toBe("defer");
  });

  it("rejects weak evidence for any blast radius", () => {
    for (const radius of ["local", "module", "system"]) {
      const result = routeProposal({
        blast_radius: radius,
        evidence_quality: "weak",
      });
      expect(result.action).toBe("defer");
      expect(result.reason).toContain("weak");
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
  it("generates deterministic ID", () => {
    const id = generateApprovalId("2026-04-04T12:30:00.000Z", 3);
    expect(id).toBe("devloop-2026-04-04T123000000Z-03");
    // Same inputs produce same output
    expect(generateApprovalId("2026-04-04T12:30:00.000Z", 3)).toBe(id);
  });

  it("pads single-digit seq to 2 digits", () => {
    const id = generateApprovalId("2026-04-04T00:00:00.000Z", 1);
    expect(id).toMatch(/-01$/);
  });

  it("preserves double-digit seq", () => {
    const id = generateApprovalId("2026-04-04T00:00:00.000Z", 12);
    expect(id).toMatch(/-12$/);
  });
});
