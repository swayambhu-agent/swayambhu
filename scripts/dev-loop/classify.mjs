// Classify stage — cognitive architecture audit and issue taxonomy.
// Pure audit functions check desires, patterns, experiences, and karma
// for structural problems. Issues are fingerprinted for dedup across cycles.

import { createHash } from "crypto";
import { listProbes, saveProbe, saveRun } from "./state.mjs";

// ── Pure functions ──────────────────────────────────────────

export function fingerprint(locus, summary) {
  const normalized = summary.toLowerCase().replace(/\s+/g, " ").trim();
  const hash = createHash("sha256")
    .update(`${locus}:${normalized}`)
    .digest("hex");
  return hash.slice(0, 16);
}

export function createIssue({
  summary,
  locus,
  severity = "medium",
  selfRepairability = 0.5,
  blastRadius = "local",
  evidenceQuality = "weak",
  confidence = 0.5,
}) {
  return {
    id: fingerprint(locus, summary),
    summary,
    locus,
    severity,
    self_repairability: selfRepairability,
    blast_radius: blastRadius,
    evidence_quality: evidenceQuality,
    reproducibility: "unknown",
    confidence,
    evidence: [],
    status: "observed",
    probe_budget: { sessions_allowed: 3, sessions_used: 0 },
    root_cause_chain: [],
    created_at: new Date().toISOString(),
  };
}

export function mergeEvidence(issue, newEvidence) {
  return {
    ...issue,
    evidence: [
      ...issue.evidence,
      { ...newEvidence, timestamp: new Date().toISOString() },
    ],
  };
}

// ── Audit functions ─────────────────────────────────────────

const AVOIDANCE_WORDS = /\b(avoid|stop|prevent|don't|never|reduce|eliminate)\b/i;

export function auditDesires(desires) {
  const issues = [];
  for (const d of desires) {
    const key = d.key || d.id || "unknown";
    const desc = d.description || "";

    if (AVOIDANCE_WORDS.test(desc)) {
      issues.push(
        createIssue({
          summary: `Desire ${key} uses avoidance framing: "${desc.slice(0, 60)}"`,
          locus: "userspace",
          severity: "medium",
          evidenceQuality: "strong",
          confidence: 0.9,
        }),
      );
    }

    if (
      !d.source_principles ||
      (Array.isArray(d.source_principles) && d.source_principles.length === 0)
    ) {
      issues.push(
        createIssue({
          summary: `Desire ${key} missing source_principles`,
          locus: "userspace",
          severity: "low",
          confidence: 0.8,
        }),
      );
    }

    if (desc.length < 15) {
      issues.push(
        createIssue({
          summary: `Desire ${key} has vague description (${desc.length} chars)`,
          locus: "userspace",
          severity: "low",
          confidence: 0.7,
        }),
      );
    }
  }
  return issues;
}

export function auditPatterns(patterns) {
  const issues = [];
  for (const p of patterns) {
    const key = p.key || p.id || "unknown";
    const strength = p.strength;

    if (strength === 0 || strength === 1.0) {
      issues.push(
        createIssue({
          summary: `Pattern ${key} strength stuck at ${strength}`,
          locus: "userspace",
          severity: "medium",
          evidenceQuality: "strong",
          confidence: 0.95,
        }),
      );
    } else if (strength > 0 && strength < 0.05) {
      issues.push(
        createIssue({
          summary: `Pattern ${key} strength ${strength} near zero — should be deleted`,
          locus: "userspace",
          severity: "low",
          confidence: 0.8,
        }),
      );
    }
  }
  return issues;
}

export function auditExperiences(experiences) {
  const issues = [];

  // Low-salience check — only meaningful with enough data
  if (experiences.length > 3) {
    const lowSalience = experiences.filter(
      (e) => (e.salience ?? 1) < 0.1,
    ).length;
    const ratio = lowSalience / experiences.length;
    if (ratio > 0.3) {
      issues.push(
        createIssue({
          summary: `${Math.round(ratio * 100)}% of experiences have salience < 0.1 (${lowSalience}/${experiences.length})`,
          locus: "userspace",
          severity: "medium",
          confidence: 0.7,
        }),
      );
    }
  }

  for (const e of experiences) {
    const key = e.key || e.id || "unknown";

    if (!e.embedding && !e.embeddings) {
      issues.push(
        createIssue({
          summary: `Experience ${key} missing embedding`,
          locus: "userspace",
          severity: "low",
          confidence: 0.6,
        }),
      );
    }

    const narrative = e.narrative || e.description || "";
    if (narrative.length < 30) {
      issues.push(
        createIssue({
          summary: `Experience ${key} has vague narrative (${narrative.length} chars)`,
          locus: "userspace",
          severity: "low",
          confidence: 0.6,
        }),
      );
    }
  }
  return issues;
}

export function auditKarma(karma) {
  const issues = [];

  for (const [key, events] of Object.entries(karma)) {
    if (!Array.isArray(events)) continue;

    const parseErrors = events.filter(
      (e) => e.event === "reflect_parse_error",
    );
    if (parseErrors.length > 0) {
      issues.push(
        createIssue({
          summary: `Session ${key} has ${parseErrors.length} reflect_parse_error(s)`,
          locus: "kernel",
          severity: "high",
          evidenceQuality: "strong",
          confidence: 0.95,
        }),
      );
    }

    const budgetExceeded = events.filter(
      (e) => e.event === "budget_exceeded",
    );
    if (budgetExceeded.length > 0) {
      issues.push(
        createIssue({
          summary: `Session ${key} exceeded budget`,
          locus: "kernel",
          severity: "high",
          evidenceQuality: "strong",
          confidence: 1.0,
        }),
      );
    }

    const failedTools = events.filter(
      (e) => e.event === "tool_complete" && e.ok === false,
    );
    if (failedTools.length > 2) {
      issues.push(
        createIssue({
          summary: `Session ${key} has ${failedTools.length} failed tool calls`,
          locus: "userspace",
          severity: "medium",
          evidenceQuality: "moderate",
          confidence: 0.8,
        }),
      );
    }
  }
  return issues;
}

// ── Dedup ───────────────────────────────────────────────────

export function dedup(newIssues, existingProbes) {
  const probeMap = new Map(existingProbes.map((p) => [p.id, p]));
  const fresh = [];
  const updated = [];

  for (const issue of newIssues) {
    const existing = probeMap.get(issue.id);
    if (existing) {
      const merged = mergeEvidence(existing, {
        source: "classify",
        summary: issue.summary,
      });
      updated.push(merged);
    } else {
      fresh.push(issue);
    }
  }

  return { newIssues: fresh, updatedProbes: updated };
}

// ── Main ────────────────────────────────────────────────────

export async function runClassify({ baseDir, observation, timestamp }) {
  const analysis = observation?.analysis || {};

  // Run all audits against available data
  const allIssues = [
    ...auditDesires(analysis.desires || []),
    ...auditPatterns(analysis.patterns || []),
    ...auditExperiences(analysis.experiences || []),
    ...auditKarma(analysis.karma || {}),
  ];

  // Dedup against existing probes
  const existingProbes = await listProbes(baseDir);
  const { newIssues, updatedProbes } = dedup(allIssues, existingProbes);

  // Persist new probes
  for (const issue of newIssues) {
    await saveProbe(baseDir, issue);
  }

  // Persist updated probes
  for (const probe of updatedProbes) {
    await saveProbe(baseDir, probe);
  }

  const classification = {
    timestamp,
    total_issues_found: allIssues.length,
    new_issues: newIssues.length,
    updated_probes: updatedProbes.length,
    issues: allIssues.map(({ id, summary, locus, severity }) => ({
      id,
      summary,
      locus,
      severity,
    })),
  };

  await saveRun(baseDir, timestamp, "classification.json", classification);

  return { classification, newIssues, updatedProbes };
}
