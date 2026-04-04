import { describe, it, expect } from "vitest";
import {
  fingerprint,
  createIssue,
  mergeEvidence,
  auditDesires,
  auditPatterns,
  auditExperiences,
  auditKarma,
  dedup,
} from "../../scripts/dev-loop/classify.mjs";

// ── fingerprint ────────────────────────────────────────────

describe("fingerprint", () => {
  it("produces consistent hash for same input", () => {
    const a = fingerprint("userspace", "desire uses avoidance framing");
    const b = fingerprint("userspace", "desire uses avoidance framing");
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("normalizes case and whitespace", () => {
    const a = fingerprint("userspace", "Desire Uses  Avoidance   Framing");
    const b = fingerprint("userspace", "desire uses avoidance framing");
    expect(a).toBe(b);
  });

  it("different locus produces different hash", () => {
    const a = fingerprint("userspace", "some issue");
    const b = fingerprint("kernel", "some issue");
    expect(a).not.toBe(b);
  });
});

// ── createIssue ────────────────────────────────────────────

describe("createIssue", () => {
  it("creates issue with all taxonomy fields and defaults", () => {
    const issue = createIssue({
      summary: "test issue summary here",
      locus: "userspace",
    });

    expect(issue.id).toMatch(/^[0-9a-f]{16}$/);
    expect(issue.summary).toBe("test issue summary here");
    expect(issue.locus).toBe("userspace");
    expect(issue.severity).toBe("medium");
    expect(issue.self_repairability).toBe(0.5);
    expect(issue.blast_radius).toBe("local");
    expect(issue.evidence_quality).toBe("weak");
    expect(issue.reproducibility).toBe("unknown");
    expect(issue.confidence).toBe(0.5);
    expect(issue.evidence).toEqual([]);
    expect(issue.status).toBe("observed");
    expect(issue.probe_budget).toEqual({
      sessions_allowed: 3,
      sessions_used: 0,
    });
    expect(issue.root_cause_chain).toEqual([]);
    expect(issue.created_at).toBeTruthy();
  });

  it("respects explicit severity and confidence", () => {
    const issue = createIssue({
      summary: "critical problem",
      locus: "kernel",
      severity: "high",
      confidence: 0.95,
      blastRadius: "global",
    });
    expect(issue.severity).toBe("high");
    expect(issue.confidence).toBe(0.95);
    expect(issue.blast_radius).toBe("global");
    expect(issue.locus).toBe("kernel");
  });
});

// ── mergeEvidence ──────────────────────────────────────────

describe("mergeEvidence", () => {
  it("appends evidence to existing issue", () => {
    const issue = createIssue({
      summary: "test issue",
      locus: "userspace",
    });
    const updated = mergeEvidence(issue, {
      source: "classify",
      detail: "seen again",
    });

    expect(updated.evidence).toHaveLength(1);
    expect(updated.evidence[0].source).toBe("classify");
    expect(updated.evidence[0].detail).toBe("seen again");
    expect(updated.evidence[0].timestamp).toBeTruthy();
    // Original unchanged
    expect(issue.evidence).toHaveLength(0);
  });

  it("accumulates multiple evidence entries", () => {
    const issue = createIssue({ summary: "test", locus: "userspace" });
    const once = mergeEvidence(issue, { source: "a" });
    const twice = mergeEvidence(once, { source: "b" });
    expect(twice.evidence).toHaveLength(2);
    expect(twice.evidence[0].source).toBe("a");
    expect(twice.evidence[1].source).toBe("b");
  });
});

// ── auditDesires ───────────────────────────────────────────

describe("auditDesires", () => {
  it("flags avoidance desires", () => {
    const desires = [
      {
        key: "desire:1",
        description: "Avoid making mistakes in communication",
        source_principles: ["p1"],
      },
      {
        key: "desire:2",
        description: "Never repeat the same error twice in sessions",
        source_principles: ["p2"],
      },
      {
        key: "desire:3",
        description: "Prevent data loss during operations and deployments",
        source_principles: ["p1"],
      },
    ];
    const issues = auditDesires(desires);
    const avoidanceIssues = issues.filter((i) =>
      i.summary.includes("avoidance framing"),
    );
    expect(avoidanceIssues).toHaveLength(3);
  });

  it("passes well-formed desires", () => {
    const desires = [
      {
        key: "desire:1",
        description: "Build deeper understanding of patron needs through active listening",
        source_principles: ["p1", "p2"],
      },
    ];
    const issues = auditDesires(desires);
    expect(issues).toHaveLength(0);
  });

  it("flags desires missing source_principles", () => {
    const desires = [
      {
        key: "desire:1",
        description: "A well-formed approach desire with good length",
        source_principles: [],
      },
      {
        key: "desire:2",
        description: "Another desire without any principles at all",
      },
    ];
    const issues = auditDesires(desires);
    const missingPrinciples = issues.filter((i) =>
      i.summary.includes("missing source_principles"),
    );
    expect(missingPrinciples).toHaveLength(2);
  });

  it("flags vague descriptions", () => {
    const desires = [
      {
        key: "desire:1",
        description: "Be good",
        source_principles: ["p1"],
      },
    ];
    const issues = auditDesires(desires);
    const vague = issues.filter((i) => i.summary.includes("vague"));
    expect(vague).toHaveLength(1);
  });
});

// ── auditPatterns ──────────────────────────────────────────

describe("auditPatterns", () => {
  it("flags patterns with strength stuck at 0 or 1", () => {
    const patterns = [
      { key: "pattern:a", strength: 0 },
      { key: "pattern:b", strength: 1.0 },
    ];
    const issues = auditPatterns(patterns);
    expect(issues).toHaveLength(2);
    expect(issues[0].summary).toContain("stuck at 0");
    expect(issues[1].summary).toContain("stuck at 1");
  });

  it("flags near-zero patterns that should be deleted", () => {
    const patterns = [{ key: "pattern:c", strength: 0.02 }];
    const issues = auditPatterns(patterns);
    expect(issues).toHaveLength(1);
    expect(issues[0].summary).toContain("should be deleted");
  });

  it("passes healthy patterns", () => {
    const patterns = [
      { key: "pattern:a", strength: 0.5 },
      { key: "pattern:b", strength: 0.8 },
      { key: "pattern:c", strength: 0.15 },
    ];
    const issues = auditPatterns(patterns);
    expect(issues).toHaveLength(0);
  });
});

// ── auditExperiences ───────────────────────────────────────

describe("auditExperiences", () => {
  it("flags too many low-salience experiences", () => {
    const experiences = [
      { key: "e:1", salience: 0.01, narrative: "a".repeat(30), embedding: [1] },
      { key: "e:2", salience: 0.02, narrative: "b".repeat(30), embedding: [1] },
      { key: "e:3", salience: 0.8, narrative: "c".repeat(30), embedding: [1] },
      { key: "e:4", salience: 0.05, narrative: "d".repeat(30), embedding: [1] },
    ];
    const issues = auditExperiences(experiences);
    const lowSalience = issues.filter((i) => i.summary.includes("salience"));
    // 3/4 = 75% below 0.1
    expect(lowSalience).toHaveLength(1);
  });

  it("skips low-salience check when too few experiences", () => {
    const experiences = [
      { key: "e:1", salience: 0.01, narrative: "a".repeat(30), embedding: [1] },
      { key: "e:2", salience: 0.02, narrative: "b".repeat(30), embedding: [1] },
    ];
    const issues = auditExperiences(experiences);
    const lowSalience = issues.filter((i) =>
      i.summary.includes("salience < 0.1"),
    );
    expect(lowSalience).toHaveLength(0);
  });

  it("flags missing embeddings", () => {
    const experiences = [
      { key: "e:1", narrative: "a decent narrative for testing purposes" },
    ];
    const issues = auditExperiences(experiences);
    const missing = issues.filter((i) => i.summary.includes("missing embedding"));
    expect(missing).toHaveLength(1);
  });

  it("flags vague narratives", () => {
    const experiences = [
      { key: "e:1", narrative: "short", embedding: [1] },
    ];
    const issues = auditExperiences(experiences);
    const vague = issues.filter((i) => i.summary.includes("vague narrative"));
    expect(vague).toHaveLength(1);
  });
});

// ── auditKarma ─────────────────────────────────────────────

describe("auditKarma", () => {
  it("flags reflect_parse_error events", () => {
    const karma = {
      "karma:session:1": [
        { event: "reflect_parse_error", detail: "bad json" },
      ],
    };
    const issues = auditKarma(karma);
    expect(issues).toHaveLength(1);
    expect(issues[0].summary).toContain("reflect_parse_error");
    expect(issues[0].severity).toBe("high");
  });

  it("flags budget_exceeded events", () => {
    const karma = {
      "karma:session:2": [{ event: "budget_exceeded" }],
    };
    const issues = auditKarma(karma);
    expect(issues).toHaveLength(1);
    expect(issues[0].summary).toContain("exceeded budget");
  });

  it("flags sessions with more than 2 failed tool calls", () => {
    const karma = {
      "karma:session:3": [
        { event: "tool_complete", ok: false },
        { event: "tool_complete", ok: false },
        { event: "tool_complete", ok: false },
        { event: "tool_complete", ok: true },
      ],
    };
    const issues = auditKarma(karma);
    expect(issues).toHaveLength(1);
    expect(issues[0].summary).toContain("3 failed tool calls");
  });

  it("passes clean sessions", () => {
    const karma = {
      "karma:session:4": [
        { event: "tool_complete", ok: true },
        { event: "act_complete" },
      ],
    };
    const issues = auditKarma(karma);
    expect(issues).toHaveLength(0);
  });
});

// ── dedup ──────────────────────────────────────────────────

describe("dedup", () => {
  it("separates new issues from existing probes", () => {
    const issueA = createIssue({ summary: "problem alpha", locus: "userspace" });
    const issueB = createIssue({ summary: "problem beta", locus: "kernel" });
    const existingProbe = createIssue({
      summary: "problem alpha",
      locus: "userspace",
    });

    const result = dedup([issueA, issueB], [existingProbe]);
    expect(result.newIssues).toHaveLength(1);
    expect(result.newIssues[0].summary).toBe("problem beta");
    expect(result.updatedProbes).toHaveLength(1);
    expect(result.updatedProbes[0].evidence).toHaveLength(1);
  });

  it("returns all as new when no existing probes", () => {
    const issues = [
      createIssue({ summary: "issue one", locus: "userspace" }),
      createIssue({ summary: "issue two", locus: "kernel" }),
    ];
    const result = dedup(issues, []);
    expect(result.newIssues).toHaveLength(2);
    expect(result.updatedProbes).toHaveLength(0);
  });
});
