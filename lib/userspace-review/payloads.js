import { parseJobOutput } from "../parse-job-output.js";

export function normalizePatchLikeChange(change) {
  if (!change || typeof change !== "object") return [];
  const base = { ...change };
  delete base.patches;
  if (typeof base.search === "string" && typeof base.old_string !== "string") {
    base.old_string = base.search;
  }
  if (typeof base.replace === "string" && typeof base.new_string !== "string") {
    base.new_string = base.replace;
  }
  delete base.search;
  delete base.replace;

  const patchList = Array.isArray(change.patches) ? change.patches : null;
  if (!patchList || patchList.length === 0) {
    return [base];
  }

  return patchList.map((patch) => {
    const normalized = { ...base };
    if (typeof patch?.search === "string") {
      normalized.old_string = patch.search;
    } else if (typeof patch?.old_string === "string") {
      normalized.old_string = patch.old_string;
    }
    if (typeof patch?.replace === "string") {
      normalized.new_string = patch.replace;
    } else if (typeof patch?.new_string === "string") {
      normalized.new_string = patch.new_string;
    }
    return normalized;
  });
}

export function normalizeCandidateChanges(candidateChanges) {
  if (!Array.isArray(candidateChanges)) return null;
  const normalized = [];
  for (const rawChange of candidateChanges) {
    if (!rawChange || typeof rawChange !== "object" || typeof rawChange.type !== "string") return null;

    if (rawChange.type === "kv_patch" || rawChange.type === "code_patch") {
      const expanded = normalizePatchLikeChange(rawChange);
      for (const change of expanded) {
        if (change.type === "kv_patch" && typeof change.key !== "string") return null;
        if (change.type === "code_patch" && typeof change.target !== "string" && typeof change.file !== "string") {
          return null;
        }
        normalized.push(change);
      }
      continue;
    }

    normalized.push(rawChange);
  }
  return normalized;
}

export function normalizeAuthorPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.hypothesis !== "string") return null;
  const candidateChanges = normalizeCandidateChanges(payload.candidate_changes);
  if (!candidateChanges) return null;
  if (!payload.validation || typeof payload.validation !== "object") return null;
  if (!payload.limits || typeof payload.limits !== "object") return null;
  return {
    ...payload,
    candidate_changes: candidateChanges,
  };
}

export function normalizeChallengePayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.review_role !== "userspace_review_adversarial") return null;
  if (typeof payload.review_result_path !== "string") return null;
  if (!["pass", "revise", "reject"].includes(payload.verdict)) return null;
  if (typeof payload.summary !== "string") return null;
  if (!Array.isArray(payload.agreements)) return null;
  if (!Array.isArray(payload.major_concerns)) return null;
  if (!Array.isArray(payload.required_changes)) return null;
  if (!Array.isArray(payload.reasons_not_to_change)) return null;
  if (typeof payload.confidence !== "number") return null;
  return payload;
}

function buildClaudeMeta(envelope) {
  if (!envelope || typeof envelope !== "object") return null;
  return {
    session_id: envelope.session_id || null,
    total_cost_usd: envelope.total_cost_usd || null,
    usage: envelope.usage || null,
    stop_reason: envelope.stop_reason || null,
    duration_ms: envelope.duration_ms || null,
  };
}

export function extractNormalizedChallengePayload(raw) {
  const parsed = parseJobOutput(raw || "");
  const direct = normalizeChallengePayload(parsed.payload);
  if (direct) {
    return { payload: direct, meta: parsed.meta };
  }

  let envelope = null;
  try {
    envelope = JSON.parse(raw || "");
  } catch {
    envelope = null;
  }
  const resultText = typeof envelope?.result === "string" ? envelope.result : "";
  const fenceRegex = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/gi;
  let match;
  while ((match = fenceRegex.exec(resultText)) !== null) {
    try {
      const candidate = JSON.parse(match[1].trim());
      const normalized = normalizeChallengePayload(candidate);
      if (normalized) {
        return { payload: normalized, meta: parsed.meta || buildClaudeMeta(envelope) };
      }
    } catch {}
  }

  return { payload: null, meta: parsed.meta || buildClaudeMeta(envelope) };
}

export function looksLikeUserspaceReviewPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  return payload.review_role === "userspace_review"
    && typeof payload.question === "string"
    && typeof payload.hypothesis === "string"
    && typeof payload.root_constraint === "string"
    && Array.isArray(payload.evidence)
    && Array.isArray(payload.proposed_changes)
    && typeof payload.validation === "object"
    && typeof payload.limits === "object"
    && Array.isArray(payload.reasons_not_to_change)
    && typeof payload.confidence === "number";
}

export function buildChallengePrompt(basePrompt, reviewResultPath, contextManifestPath) {
  return [
    basePrompt.trim(),
    "",
    `Review result path: ${reviewResultPath}`,
    `Original context manifest path: ${contextManifestPath}`,
    "Read both files first. Use the original evidence bundle to test whether the review is actually justified.",
    "Respond with JSON only.",
  ].join("\n");
}

export function buildReviewRevisePrompt(basePrompt, reviewResultPath, challengeResultPath, contextManifestPath) {
  return [
    basePrompt.trim(),
    "",
    `Prior review result path: ${reviewResultPath}`,
    `Adversarial review result path: ${challengeResultPath}`,
    `Original context manifest path: ${contextManifestPath}`,
    "Read all three before revising. Use the original evidence bundle to resolve the adversarial concerns.",
    "Return only the inner `userspace_review` payload object that matches the standard userspace review schema.",
    "Respond with JSON only.",
  ].join("\n");
}

export function buildAuthorPrompt(basePrompt, reviewResultPath) {
  return [
    basePrompt.trim(),
    "",
    `Review result path: ${reviewResultPath}`,
    "Read that JSON file first, then inspect only the target files needed to materialize the smallest candidate change set.",
    "Respond with JSON only.",
  ].join("\n");
}
