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

export function routeProposal({ blast_radius, evidence_quality, challenge_converged }) {
  const rank = evidenceRank(evidence_quality);

  // Weak evidence — always defer regardless of blast radius
  if (rank < EVIDENCE_RANK.moderate) {
    return { action: "defer", reason: `evidence too weak (${evidence_quality}) to act on` };
  }

  // System blast radius — always escalate, even with strong evidence
  if (blast_radius === "system") {
    return { action: "escalate", reason: `system-level change requires human approval` };
  }

  // Module blast radius
  if (blast_radius === "module") {
    if (rank >= EVIDENCE_RANK.strong) {
      return { action: "apply_and_note", reason: `module-level change with strong evidence — applying with note` };
    }
    // moderate evidence at module level — defer
    return { action: "defer", reason: `module-level change needs strong evidence (have ${evidence_quality})` };
  }

  // Local blast radius with moderate+ evidence — auto-apply
  return { action: "auto_apply", reason: `local change with ${evidence_quality} evidence — safe to auto-apply` };
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
