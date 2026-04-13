// Classify stage — cognitive architecture audit and issue taxonomy.
// Pure audit logic lives in lib/dev-loop/classify.js; this file keeps the
// persistence/orchestration boundary.

import { listProbes, saveProbe, saveRun } from "./state.mjs";
export {
  fingerprint,
  createIssue,
  mergeEvidence,
  auditDesires,
  auditPatterns,
  auditTactics,
  auditExperiences,
  auditCarryForward,
  auditActions,
  auditMetaPolicyNotes,
  auditKarma,
  dedup,
} from "../../lib/dev-loop/classify.js";
import {
  auditDesires,
  auditPatterns,
  auditTactics,
  auditExperiences,
  auditCarryForward,
  auditActions,
  auditMetaPolicyNotes,
  auditKarma,
  dedup,
} from "../../lib/dev-loop/classify.js";

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
