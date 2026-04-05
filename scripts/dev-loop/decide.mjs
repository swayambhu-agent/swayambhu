// Decide stage — evidence-based routing for proposals.
// Pure logic: routes proposals to auto-apply, escalate, or defer
// based on blast radius and evidence quality. No I/O.

// ── Evidence rank ──────────────────────────────────────────

const EVIDENCE_RANK = { weak: 0, moderate: 1, strong: 2 };

function evidenceRank(quality) {
  return EVIDENCE_RANK[quality] ?? -1;
}

// ── Pure functions ─────────────────────────────────────────

export function shouldAutoApply(blastRadius, evidenceQuality) {
  if (blastRadius === "system") return false;
  if (blastRadius === "module") return evidenceQuality === "strong";
  // local: moderate or strong
  return evidenceRank(evidenceQuality) >= EVIDENCE_RANK.moderate;
}

export function routeProposal({
  blast_radius,
  evidence_quality,
  challenge_converged = false,
  requires_human_judgment = false,
  cold_start = false,
}) {
  const rank = evidenceRank(evidence_quality);

  if (cold_start) {
    return { action: "cold_start", reason: "state requires cold start recovery" };
  }

  if (requires_human_judgment) {
    return { action: "escalate", reason: "change requires human judgment" };
  }

  if (rank < EVIDENCE_RANK.moderate) {
    return { action: "defer", reason: `evidence too weak (${evidence_quality}) to act on` };
  }

  if (blast_radius === "system") {
    if (rank >= EVIDENCE_RANK.strong && challenge_converged) {
      return {
        action: "escalate",
        reason: "system-level change with strong evidence and converged challenge requires human approval",
      };
    }
    return {
      action: "defer",
      reason: "system-level change needs converged challenge before escalation",
    };
  }

  if (blast_radius === "module") {
    if (rank >= EVIDENCE_RANK.strong && challenge_converged) {
      return {
        action: "auto_apply",
        reason: "module-level change with strong evidence and converged challenge - safe to auto-apply",
      };
    }
    if (rank >= EVIDENCE_RANK.strong) {
      return {
        action: "defer",
        reason: "module-level change needs converged challenge before auto-apply",
      };
    }
    return {
      action: "defer",
      reason: `module-level change needs strong evidence (have ${evidence_quality})`,
    };
  }

  return { action: "auto_apply", reason: `local change with ${evidence_quality} evidence - safe to auto-apply` };
}

export function generateApprovalId(_timestamp, _seq, existingIds = []) {
  // Short 5-char alphanumeric ID — easy to type in Slack replies
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789'; // no ambiguous chars (0/o/1/l/i)
  const existing = new Set(existingIds);
  for (let attempt = 0; attempt < 100; attempt++) {
    let id = '';
    for (let i = 0; i < 5; i++) id += chars[Math.floor(Math.random() * chars.length)];
    if (!existing.has(id)) return id;
  }
  // Fallback: timestamp-based
  return `dl${Date.now().toString(36).slice(-5)}`;
}
