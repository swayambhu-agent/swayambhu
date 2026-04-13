import { join } from "path";

import { parseJobOutput } from "../parse-job-output.js";

export function buildAuthorityOverview(spec, manifest) {
  return [
    "# Authority Review Overview",
    "",
    "## Question",
    spec.question,
    "",
    ...(spec.notes.length
      ? ["## Notes", ...spec.notes.map((note) => `- ${note}`), ""]
      : []),
    "## Included Evidence",
    ...manifest.map((entry) => `- ${entry.kind}: ${entry.relative_path} (from ${entry.source_path})`),
    "",
    "Read the behaviorally direct evidence first, then inspect authority policy and kernel surfaces.",
  ].join("\n");
}

export function buildAuthorityReviewPrompt(basePrompt) {
  return [
    "You are running inside the Swayambhu proto-DR-3 authority review harness.",
    "The current working directory is an isolated review bundle.",
    `Start with ${join("context", "overview.md")} and ${join("context", "manifest.json")}.`,
    "All evidence files are copied under context/files/.",
    "Do not modify files. Do not browse the web. Respond with JSON only.",
    "",
    basePrompt.trim(),
  ].join("\n\n");
}

export function buildAuthorityChallengePrompt(basePrompt, reviewResultPath, contextManifestPath) {
  return [
    basePrompt.trim(),
    "",
    `Review result path: ${reviewResultPath}`,
    `Original context manifest path: ${contextManifestPath}`,
    "Read both files first and test whether this really belongs in constitutional review.",
    "Respond with JSON only.",
  ].join("\n");
}

export function buildAuthorityRevisePrompt(basePrompt, reviewResultPath, challengeResultPath, contextManifestPath) {
  return [
    basePrompt.trim(),
    "",
    `Prior review result path: ${reviewResultPath}`,
    `Adversarial review result path: ${challengeResultPath}`,
    `Original context manifest path: ${contextManifestPath}`,
    "Read all three before revising.",
    "Respond with JSON only.",
  ].join("\n");
}

export function buildAuthorityAuthorPrompt(basePrompt, reviewResultPath) {
  return [
    basePrompt.trim(),
    "",
    `Review result path: ${reviewResultPath}`,
    "Read that JSON first, then inspect only the authority surfaces needed to materialize the smallest candidate change set.",
    "Respond with JSON only.",
  ].join("\n");
}

export function parseAuthorityJsonLoose(raw) {
  const parsed = parseJobOutput(raw || "");
  if (parsed?.payload && typeof parsed.payload === "object") {
    return { payload: parsed.payload, meta: parsed.meta || null };
  }
  try {
    const direct = JSON.parse(raw || "");
    if (direct && typeof direct === "object") return { payload: direct, meta: null };
  } catch {}
  const fenceMatch = String(raw || "").match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    try {
      const payload = JSON.parse(fenceMatch[1].trim());
      return { payload, meta: null };
    } catch {}
  }
  return { payload: null, meta: null };
}

export function looksLikeAuthorityReviewPayload(payload) {
  return !!(
    payload
    && payload.review_role === "authority_review"
    && typeof payload.question === "string"
    && typeof payload.hypothesis === "string"
    && typeof payload.root_constraint === "string"
    && typeof payload.why_userspace_review_cannot_fix_it === "string"
    && typeof payload.authority_effect === "string"
    && Array.isArray(payload.required_invariant_checks)
    && Array.isArray(payload.evidence)
    && Array.isArray(payload.proposed_changes)
    && Array.isArray(payload.migration_plan)
    && payload.validation && typeof payload.validation === "object"
    && typeof payload.promotion_recommendation === "string"
    && Array.isArray(payload.reasons_not_to_change)
    && typeof payload.confidence === "number"
  );
}

export function looksLikeAuthorityChallengePayload(payload) {
  return !!(
    payload
    && payload.review_role === "authority_review_adversarial"
    && typeof payload.review_result_path === "string"
    && ["pass", "revise", "reject"].includes(payload.verdict)
    && typeof payload.summary === "string"
    && Array.isArray(payload.agreements)
    && Array.isArray(payload.major_concerns)
    && Array.isArray(payload.required_changes)
    && Array.isArray(payload.reasons_not_to_change)
    && typeof payload.confidence === "number"
  );
}

export function normalizeAuthorityReviewPayload(payload) {
  return looksLikeAuthorityReviewPayload(payload) ? payload : null;
}

export function normalizeAuthorityChallengePayload(payload) {
  return looksLikeAuthorityChallengePayload(payload) ? payload : null;
}
