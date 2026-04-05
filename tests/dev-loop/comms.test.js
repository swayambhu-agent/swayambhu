import { describe, it, expect } from "vitest";
import {
  formatApprovalMessage,
  parseReply,
} from "../../scripts/dev-loop/comms.mjs";

// ── formatApprovalMessage ───────────────────────────────────

describe("formatApprovalMessage", () => {
  it("formats with [DEVLOOP] prefix and ID", () => {
    const msg = formatApprovalMessage({
      id: "devloop-abc",
      summary: "Refactor kernel safety gates",
    });
    expect(msg).toContain("[DEVLOOP]");
    expect(msg).toContain("devloop-abc");
    expect(msg).toContain("Refactor kernel safety gates");
  });

  it("includes approve and reject instructions", () => {
    const msg = formatApprovalMessage({
      id: "devloop-xyz",
      summary: "test",
    });
    expect(msg).toContain("approve devloop-xyz");
    expect(msg).toContain("reject devloop-xyz");
  });

  it("includes optional fields when provided", () => {
    const msg = formatApprovalMessage({
      id: "devloop-001",
      summary: "Add new tool",
      blastRadius: "tools/*.js",
      evidence: "All tests pass",
      challengeResult: "No issues found",
      why: "Tool output not capped, causing context explosion",
      whatChanges: "Add 8k char cap in runAgentTurn",
    });
    expect(msg).toContain("Blast radius: tools/*");
    expect(msg).toContain("*Why:* Tool output not capped");
    expect(msg).toContain("*Changes:* Add 8k char cap");
  });

  it("omits optional fields when not provided", () => {
    const msg = formatApprovalMessage({
      id: "devloop-002",
      summary: "Minor fix",
    });
    expect(msg).not.toContain("Blast radius:");
    expect(msg).not.toContain("Evidence:");
    expect(msg).not.toContain("Challenge result:");
  });
});

// ── parseReply ──────────────────────────────────────────────

describe("parseReply", () => {
  it("parses APPROVE", () => {
    const result = parseReply("APPROVE devloop-123");
    expect(result).toEqual({
      id: "devloop-123",
      action: "APPROVE",
      reason: null,
    });
  });

  it("parses REJECT with reason", () => {
    const result = parseReply("REJECT devloop-456 too risky right now");
    expect(result).toEqual({
      id: "devloop-456",
      action: "REJECT",
      reason: "too risky right now",
    });
  });

  it("returns null for non-approval messages", () => {
    expect(parseReply("hello world")).toBeNull();
    expect(parseReply("")).toBeNull();
    expect(parseReply(null)).toBeNull();
    // APPROVE/REJECT with any ID is valid (short IDs like k7m3p)
    expect(parseReply("APPROVE k7m3p")).toEqual({
      id: "k7m3p", action: "APPROVE", reason: null,
    });
  });

  it("handles case-insensitive matching", () => {
    const lower = parseReply("approve devloop-789");
    expect(lower).toEqual({
      id: "devloop-789",
      action: "APPROVE",
      reason: null,
    });

    const mixed = parseReply("Reject devloop-abc not yet");
    expect(mixed).toEqual({
      id: "devloop-abc",
      action: "REJECT",
      reason: "not yet",
    });
  });

  it("finds reply in multiline text", () => {
    const email = "Thanks for the update.\n\nAPPROVE devloop-999\n\nBest regards";
    const result = parseReply(email);
    expect(result).toEqual({
      id: "devloop-999",
      action: "APPROVE",
      reason: null,
    });
  });
});
