export const KNOWN_WRITE_CONTEXTS = new Set([
  "act",
  "reflect",
  "deep-reflect",
  "userspace-review",
  "authority-review",
]);

const REVIEW_CONTEXTS = ["deep-reflect", "userspace-review"];

function privilegedOps({
  contexts = REVIEW_CONTEXTS,
  requiresDeliberation = false,
  minDeliberationChars,
} = {}) {
  const rule = {
    contexts,
    budget_class: "privileged",
    requires_deliberation: requiresDeliberation,
  };
  if (requiresDeliberation && Number.isFinite(minDeliberationChars)) {
    rule.min_deliberation_chars = minDeliberationChars;
  }
  return {
    put: { ...rule },
    patch: { ...rule },
    delete: { ...rule },
  };
}

export const BOOTSTRAP_KEY_TIERS = {
  immutable: ["dharma", "patron:public_key"],
  kernel_only: ["karma:*", "sealed:*", "event:*", "event_dead:*", "kernel:*", "patron:direct"],
  lifecycle: ["dr:*", "dr2:*", "dr3:*"],
  protected: [
    "config:*", "prompt:*", "tool:*", "provider:*", "channel:*",
    "hook:*", "contact:*", "contact_platform:*", "code_staging:*",
    "secret:*", "pattern:*", "skill:*", "task:*",
    "providers", "wallets", "patron:contact", "patron:identity_snapshot",
    "desire:*", "principle:*", "tactic:*", "identification:*", "review_note:*",
  ],
};

export const BOOTSTRAP_WRITE_POLICY = {
  version: 1,
  rules: [
    {
      match: "config:model_capabilities",
      ops: privilegedOps({ requiresDeliberation: true, minDeliberationChars: 200 }),
    },
    {
      match: "config:*",
      ops: privilegedOps(),
    },
    {
      match: "principle:*",
      ops: privilegedOps({ requiresDeliberation: true, minDeliberationChars: 200 }),
    },
    {
      match: "prompt:*",
      ops: privilegedOps({ requiresDeliberation: true, minDeliberationChars: 200 }),
    },
    {
      match: "desire:*",
      ops: privilegedOps(),
    },
    {
      match: "tactic:*",
      ops: privilegedOps(),
    },
    {
      match: "review_note:*",
      ops: privilegedOps({ contexts: ["deep-reflect"] }),
    },
    {
      match: "pattern:*",
      ops: {
        ...privilegedOps(),
        field_merge: {
          contexts: ["act", ...REVIEW_CONTEXTS],
          budget_class: "mechanical",
          requires_deliberation: false,
          allowed_fields: ["strength"],
        },
      },
    },
    {
      match: "identification:*",
      ops: {
        ...privilegedOps(),
        field_merge: {
          contexts: ["act", ...REVIEW_CONTEXTS],
          budget_class: "mechanical",
          requires_deliberation: false,
          allowed_fields: ["last_exercised_at", "last_reviewed_at", "strength"],
        },
      },
    },
  ],
};

export function mergeKeyTiers(loadedTiers) {
  if (!loadedTiers || typeof loadedTiers !== "object") return BOOTSTRAP_KEY_TIERS;
  const merged = {};
  for (const [tierName, defaultPatterns] of Object.entries(BOOTSTRAP_KEY_TIERS)) {
    const loadedPatterns = Array.isArray(loadedTiers[tierName]) ? loadedTiers[tierName] : [];
    merged[tierName] = Array.from(new Set([...defaultPatterns, ...loadedPatterns]));
  }
  for (const [tierName, patterns] of Object.entries(loadedTiers)) {
    if (tierName in merged) continue;
    merged[tierName] = Array.isArray(patterns) ? [...patterns] : patterns;
  }
  return merged;
}

export function mergeWritePolicy(loadedPolicy) {
  if (!loadedPolicy || typeof loadedPolicy !== "object" || !Array.isArray(loadedPolicy.rules)) {
    return BOOTSTRAP_WRITE_POLICY;
  }
  return {
    version: typeof loadedPolicy.version === "number" ? loadedPolicy.version : BOOTSTRAP_WRITE_POLICY.version,
    rules: loadedPolicy.rules.length > 0 ? loadedPolicy.rules : BOOTSTRAP_WRITE_POLICY.rules,
  };
}
