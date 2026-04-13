export const AUTHORITY_EFFECTS = new Set([
  "no_authority_change",
  "authority_narrowing",
  "authority_widening",
  "policy_refactor_only",
]);

const AUTHORITY_KV_KEYS = new Set([
  "kernel:key_tiers",
  "kernel:write_policy",
]);

const AUTHORITY_CODE_TARGETS = new Set([
  "kernel:source:kernel.js",
  "kernel:source:authority-policy.js",
  "kernel.js",
  "authority-policy.js",
  "scripts/seed-local-kv.mjs",
]);

export function isAuthorityKvKey(key) {
  return AUTHORITY_KV_KEYS.has(String(key || ""));
}

export function isAuthorityCodeTarget(target) {
  return AUTHORITY_CODE_TARGETS.has(String(target || ""));
}

export function isAuthorityCandidateChange(change) {
  if (!change || typeof change !== "object") return false;
  if (change.type?.startsWith("kv_")) return isAuthorityKvKey(change.key);
  if (change.type === "code_patch") {
    return isAuthorityCodeTarget(change.target || change.path);
  }
  return false;
}

export function collectAuthorityCandidateTargets(candidateChanges = []) {
  return candidateChanges
    .filter(isAuthorityCandidateChange)
    .map((change) => {
      if (change.type?.startsWith("kv_")) {
        return { type: change.type, target: change.key };
      }
      return { type: change.type, target: change.target || change.path };
    });
}

export function normalizeAuthorityEffect(value) {
  return AUTHORITY_EFFECTS.has(value) ? value : null;
}

export function classifyAuthorityReviewPlan({ reviewPayload, candidateChanges = [] }) {
  const declaredEffect = normalizeAuthorityEffect(reviewPayload?.authority_effect);
  const touchedTargets = collectAuthorityCandidateTargets(candidateChanges);

  if (touchedTargets.length === 0) {
    return {
      ok: declaredEffect === null || declaredEffect === "no_authority_change",
      authority_effect: "no_authority_change",
      touched_targets: [],
      error: declaredEffect && declaredEffect !== "no_authority_change"
        ? "review_declares_authority_change_without_authority_surface_patch"
        : null,
    };
  }

  if (!declaredEffect) {
    return {
      ok: false,
      authority_effect: null,
      touched_targets: touchedTargets,
      error: "authority_effect_missing_or_invalid",
    };
  }

  if (declaredEffect === "no_authority_change") {
    return {
      ok: false,
      authority_effect: declaredEffect,
      touched_targets: touchedTargets,
      error: "authority_effect_declared_none_but_authority_surfaces_change",
    };
  }

  return {
    ok: true,
    authority_effect: declaredEffect,
    touched_targets: touchedTargets,
    error: null,
  };
}

export function buildAuthorityInvariantCommands() {
  return [
    "npm test -- tests/kernel.test.js tests/index.test.js tests/userspace.test.js tests/state-lab.test.js",
    "node -e \"const fs=require('fs'); const src=fs.readFileSync('kernel.js','utf8'); if(/updatePatternStrength\\s*\\(/.test(src)||/updateIdentificationLastExercised\\s*\\(/.test(src)||/ensureIdentitySeed\\s*\\(/.test(src)){process.exit(1)}\"",
  ];
}

export function mergeAuthorityValidation(validation = {}) {
  const staticCommands = Array.isArray(validation.static_commands)
    ? validation.static_commands.filter((command) => typeof command === "string" && command.trim())
    : [];
  const mergedCommands = Array.from(new Set([
    ...buildAuthorityInvariantCommands(),
    ...staticCommands,
  ]));

  return {
    ...validation,
    static_commands: mergedCommands,
  };
}
