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
const EXPERIENCE_INTERNAL_REASONING = /\bReason:\b|\b(carry-forward|carry forward|desire:|pattern:|tactic:)\b/i;
const TACTIC_REFLECTION_WORDS = /\b(reflect|reflection|deep-reflect|review|plan reason)\b/i;
const TACTIC_META_POLICY_WORDS = /\b(idle[- ]streak|no_action_streak|circuit-breaker pressure|fresh experience|internal_only|external anchors?|wake path)\b/i;
const TACTIC_META_POLICY_VERBS = /\b(skip|count(?:ing)?|coalesce|inspect|route)\b/i;
const CARRY_FORWARD_META_POLICY = /\b(idle[- ]streak|circuit-breaker|fresh experience|internal_only|pattern:|tactic:|monitoring\/coalescing|route it through|coalesce|apply pattern)\b/i;
const OUTBOUND_INTERNAL_RUNTIME = /\b(carry-forward|carry forward|desire:|pattern:|tactic:|no_action|idle[- ]streak|circuit-breaker|hold contract|dev_loop|debug\/probe|probe wake)\b/i;

function textSnippet(text, max = 72) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, max);
}

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

export function auditTactics(tactics) {
  const issues = [];
  for (const t of tactics) {
    const key = t.key || t.id || "unknown";
    const desc = t.description || "";

    if (TACTIC_REFLECTION_WORDS.test(desc)) {
      issues.push(
        createIssue({
          summary: `Tactic ${key} appears to govern reflection/review instead of act-time behavior`,
          locus: "userspace",
          severity: "medium",
          evidenceQuality: "strong",
          confidence: 0.9,
        }),
      );
    }

    if (TACTIC_META_POLICY_WORDS.test(desc) && TACTIC_META_POLICY_VERBS.test(desc)) {
      issues.push(
        createIssue({
          summary: `Tactic ${key} appears to smuggle runtime or memory policy into the tactic layer`,
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
    const observation = e.observation || e.text_rendering?.narrative || e.narrative || e.summary || e.description || "";
    if (observation.length < 30) {
      issues.push(
        createIssue({
          summary: `Experience ${key} has vague observation (${observation.length} chars)`,
          locus: "userspace",
          severity: "low",
          confidence: 0.6,
        }),
      );
    }

    if (EXPERIENCE_INTERNAL_REASONING.test(observation)) {
      issues.push(
        createIssue({
          summary: `Experience ${key} observation appears to contain narrative or internal reasoning: "${textSnippet(observation)}"`,
          locus: "userspace",
          severity: "medium",
          evidenceQuality: "strong",
          confidence: 0.9,
        }),
      );
    }
  }
  return issues;
}

export function auditCarryForward(lastReflect) {
  const issues = [];
  for (const item of lastReflect?.carry_forward || []) {
    const text = `${item.item || ""} ${item.why || ""}`.trim();
    if (!text) continue;
    if (CARRY_FORWARD_META_POLICY.test(text)) {
      issues.push(
        createIssue({
          summary: `Carry-forward item ${item.id || "unknown"} appears to smuggle runtime/meta-policy instead of a concrete next step: "${textSnippet(item.item || text)}"`,
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

export function auditActions(actions) {
  const issues = [];
  for (const action of actions) {
    const key = action.key || action.id || action.action_id || "unknown";
    const isRequestMessage = action.plan?.action === "request_message"
      || (Array.isArray(action.tool_calls) && action.tool_calls.some((call) => call.tool === "request_message"));
    if (!isRequestMessage) continue;

    const message = action.plan?.detail?.message
      || action.plan?.detail?.content
      || "";

    if (message && OUTBOUND_INTERNAL_RUNTIME.test(message)) {
      issues.push(
        createIssue({
          summary: `Outbound message in ${key} appears to leak internal runtime/cognitive vocabulary: "${textSnippet(message)}"`,
          locus: "userspace",
          severity: "high",
          evidenceQuality: "strong",
          confidence: 0.95,
        }),
      );
    }
  }
  return issues;
}

export function auditMetaPolicyNotes(reflections) {
  const issues = [];
  let totalNotes = 0;
  const noteRefs = [];

  for (const [key, reflection] of Object.entries(reflections || {})) {
    const notes = Array.isArray(reflection?.meta_policy_notes) ? reflection.meta_policy_notes : [];
    totalNotes += notes.length;
    notes.forEach((note, index) => {
      noteRefs.push(`${key}::${note?.slug || index}`);
      const hasWrongTargetReview = note?.target_review != null && note.target_review !== "userspace_review";
      const hasWrongNonLive = note?.non_live != null && note.non_live !== true;
      if (hasWrongTargetReview || hasWrongNonLive) {
        issues.push(
          createIssue({
            summary: `Meta-policy note ${key}[${index}] is not clearly marked non-live userspace_review output`,
            locus: "userspace",
            severity: "medium",
            evidenceQuality: "strong",
            confidence: 0.9,
          }),
        );
      }
      if (!note?.summary || !note?.rationale || !note?.proposed_experiment) {
        issues.push(
          createIssue({
            summary: `Meta-policy note ${key}[${index}] is missing required explanatory fields`,
            locus: "userspace",
            severity: "low",
            evidenceQuality: "strong",
            confidence: 0.85,
          }),
        );
      }
    });
  }

  return { issues, totalNotes, noteRefs };
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

// Probes not reproduced for this many consecutive cycles are marked resolved.
const STALE_THRESHOLD = 3;

export function dedup(newIssues, existingProbes) {
  const probeMap = new Map(existingProbes.map((p) => [p.id, p]));
  const newIssueIds = new Set(newIssues.map((i) => i.id));
  const fresh = [];
  const updated = [];

  for (const issue of newIssues) {
    const existing = probeMap.get(issue.id);
    if (existing) {
      const merged = mergeEvidence(existing, {
        source: "classify",
        summary: issue.summary,
      });
      // Reset miss counter — issue was reproduced this cycle
      merged.consecutive_misses = 0;
      updated.push(merged);
    } else {
      fresh.push(issue);
    }
  }

  // Expire stale probes: existing probes not reproduced this cycle
  for (const probe of existingProbes) {
    if (newIssueIds.has(probe.id)) continue; // already handled above
    if (probe.status === "resolved") continue; // already resolved
    const misses = (probe.consecutive_misses || 0) + 1;
    if (misses >= STALE_THRESHOLD) {
      updated.push({ ...probe, consecutive_misses: misses, status: "resolved" });
    } else {
      updated.push({ ...probe, consecutive_misses: misses });
    }
  }

  return { newIssues: fresh, updatedProbes: updated };
}

// ── Main ────────────────────────────────────────────────────

export async function runClassify({ baseDir, observation, timestamp }) {
  const analysis = observation?.analysis || {};

  // Convert KV objects to arrays — analyze-sessions outputs { "desire:slug": {...} }
  const toArray = (obj) => Array.isArray(obj) ? obj
    : Object.entries(obj || {}).map(([key, val]) => ({ key, ...val }));

  const metaPolicyAudit = auditMetaPolicyNotes(analysis.reflections || {});
  const allIssues = [
    ...auditDesires(toArray(analysis.desires)),
    ...auditPatterns(toArray(analysis.patterns)),
    ...auditTactics(toArray(analysis.tactics)),
    ...auditExperiences(toArray(analysis.experiences)),
    ...auditCarryForward(analysis.last_reflect || {}),
    ...auditActions(toArray(analysis.actions)),
    ...metaPolicyAudit.issues,
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
    meta_policy_notes_total: metaPolicyAudit.totalNotes,
    meta_policy_note_refs: metaPolicyAudit.noteRefs,
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
