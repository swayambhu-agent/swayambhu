import { vi } from "vitest";
import { makeKVStore } from "./mock-kv.js";

export function makeMockK(kvInit = {}, opts = {}) {
  const kv = makeKVStore(kvInit);

  const mock = {
    // KV reads
    kvGet: vi.fn(async (key) => {
      const val = kv._store.get(key) ?? null;
      if (val === null) return null;
      try { return typeof val === "string" ? JSON.parse(val) : val; }
      catch { return val; }
    }),
    kvGetWithMeta: vi.fn(async (key) => {
      const val = kv._store.get(key) ?? null;
      return { value: val, metadata: kv._meta.get(key) || null };
    }),
    kvList: vi.fn(async (listOpts = {}) => {
      let keys = [...kv._store.keys()];
      if (listOpts.prefix) keys = keys.filter(k => k.startsWith(listOpts.prefix));
      if (listOpts.limit) keys = keys.slice(0, listOpts.limit);
      return {
        keys: keys.map(name => ({ name, metadata: kv._meta.get(name) || null })),
        list_complete: true,
      };
    }),

    // KV writes
    kvPutSafe: vi.fn(async (key, value, metadata) => {
      kv._store.set(key, typeof value === "string" ? value : JSON.stringify(value));
      if (metadata) kv._meta.set(key, metadata);
    }),
    kvDeleteSafe: vi.fn(async (key) => {
      kv._store.delete(key);
    }),
    kvWritePrivileged: vi.fn(async (ops) => {
      for (const op of ops) {
        if (op.op === "delete") {
          kv._store.delete(op.key);
        } else if (op.op === "patch") {
          const current = kv._store.get(op.key) ?? null;
          if (typeof current !== "string") {
            throw new Error(`patch op: key "${op.key}" is not a string value`);
          }
          if (!current.includes(op.old_string)) {
            throw new Error(`patch op: old_string not found in "${op.key}"`);
          }
          if (current.indexOf(op.old_string) !== current.lastIndexOf(op.old_string)) {
            throw new Error(`patch op: old_string matches multiple locations in "${op.key}"`);
          }
          kv._store.set(op.key, current.replace(op.old_string, op.new_string));
        } else {
          kv._store.set(op.key, typeof op.value === "string" ? op.value : JSON.stringify(op.value));
        }
      }
    }),

    // Blocked communications
    listBlockedComms: vi.fn(async () => []),
    processCommsVerdict: vi.fn(async () => ({ ok: true })),

    // Agent loop
    runAgentLoop: vi.fn(async () => ({})),
    executeToolCall: vi.fn(async () => ({})),
    buildToolDefinitions: vi.fn(async () => []),
    executeAction: vi.fn(async () => ({})),
    executeAdapter: vi.fn(async () => ({})),
    checkBalance: vi.fn(async () => ({ providers: {}, wallets: {} })),
    callHook: vi.fn(async () => null),

    // Karma
    karmaRecord: vi.fn(async () => {}),

    // Utility
    resolveModel: vi.fn(async (m) => m),
    estimateCost: vi.fn(async () => 0),
    buildPrompt: vi.fn(async (t, v) => t || JSON.stringify(v)),
    parseAgentOutput: vi.fn(async (c) => (c ? JSON.parse(c) : {})),
    loadKeys: vi.fn(async (keys) => {
      const result = {};
      for (const key of keys) {
        const val = kv._store.get(key);
        result[key] = val ? (typeof val === "string" ? JSON.parse(val) : val) : null;
      }
      return result;
    }),
    getSessionCount: vi.fn(async () => opts.sessionCount || 0),
    mergeDefaults: vi.fn(async (d, o) => ({ ...d, ...o })),
    isSystemKey: vi.fn(async (key) => {
      const prefixes = [
        'prompt:', 'config:', 'tool:', 'provider:', 'secret:',
        'proposal:', 'hook:', 'doc:',
        'yama:', 'niyama:', 'viveka:', 'prajna:', 'comms_blocked:',
        'contact:', 'contact_index:', 'sealed:',
      ];
      const exact = ['providers', 'wallets', 'patron:contact', 'patron:identity_snapshot'];
      if (exact.includes(key)) return true;
      return prefixes.some(p => key.startsWith(p));
    }),
    getSystemKeyPatterns: vi.fn(async () => ({
      prefixes: [
        'prompt:', 'config:', 'tool:', 'provider:', 'secret:',
        'proposal:', 'hook:', 'doc:',
        'yama:', 'niyama:', 'viveka:', 'prajna:', 'comms_blocked:',
        'contact:', 'contact_index:', 'sealed:',
      ],
      exact: ['providers', 'wallets', 'patron:contact', 'patron:identity_snapshot'],
    })),

    // State
    getSessionId: vi.fn(async () => opts.sessionId || "test_session"),
    getSessionCost: vi.fn(async () => opts.sessionCost || 0),
    getKarma: vi.fn(async () => opts.karma || []),
    getDefaults: vi.fn(async () => opts.defaults || {}),
    getModelsConfig: vi.fn(async () => opts.modelsConfig || null),
    getDharma: vi.fn(async () => opts.dharma || null),
    getToolRegistry: vi.fn(async () => opts.toolRegistry || null),
    getYamas: vi.fn(async () => opts.yamas || null),
    getNiyamas: vi.fn(async () => opts.niyamas || null),
    getPatronId: vi.fn(async () => opts.patronId || null),
    getPatronContact: vi.fn(async () => opts.patronContact || null),
    isPatronIdentityDisputed: vi.fn(async () => opts.patronIdentityDisputed || false),
    resolveContact: vi.fn(async (platform, userId) => null),
    elapsed: vi.fn(async () => 0),

    // Proposal system
    createProposal: vi.fn(async () => "p_test_123"),
    loadProposals: vi.fn(async () => ({})),
    updateProposalStatus: vi.fn(async () => {}),
    processProposalVerdicts: vi.fn(async () => {}),

    // Config utilities
    getMaxSteps: vi.fn(async (state, role, depth) => {
      const { defaults } = state;
      if (role === 'orient') return defaults?.execution?.max_steps?.orient || 12;
      const perLevel = defaults?.reflect_levels?.[depth];
      if (perLevel?.max_steps) return perLevel.max_steps;
      return depth === 1
        ? (defaults?.execution?.max_steps?.reflect || 5)
        : (defaults?.execution?.max_steps?.deep_reflect || 10);
    }),
    getReflectModel: vi.fn(async (state, depth) => {
      const { defaults } = state;
      const perLevel = defaults?.reflect_levels?.[depth];
      if (perLevel?.model) return perLevel.model;
      return defaults?.deep_reflect?.model || defaults?.orient?.model;
    }),

    // Internal — expose KV store for assertions
    _kv: kv,
  };

  // applyKVOperation needs `this` bound to the mock object (calls kvPutSafe, karmaRecord, etc.)
  const _SYSTEM_PREFIXES = [
    'prompt:', 'config:', 'tool:', 'provider:', 'secret:',
    'proposal:', 'hook:', 'doc:',
    'yama:', 'niyama:', 'viveka:', 'prajna:', 'skill:', 'comms_blocked:',
    'contact:', 'contact_index:', 'sealed:',
  ];
  const _SYSTEM_EXACT = ['providers', 'wallets', 'patron:contact', 'patron:identity_snapshot'];
  function _isSystemKey(key) {
    if (_SYSTEM_EXACT.includes(key)) return true;
    return _SYSTEM_PREFIXES.some(p => key.startsWith(p));
  }

  mock.applyKVOperation = vi.fn(async (op) => {
    const key = op.key;
    const valueSummary = op.value != null
      ? (typeof op.value === 'string'
          ? (op.value.length > 500 ? op.value.slice(0, 500) + '\u2026' : op.value)
          : JSON.stringify(op.value).slice(0, 500))
      : undefined;

    if (key.startsWith("contact:")) {
      try { await mock.kvWritePrivileged([op]); }
      catch (err) {
        await mock.karmaRecord({ event: "modification_blocked", key, op: op.op, reason: err.message, attempted_value: valueSummary });
      }
      return;
    }

    if (_isSystemKey(key)) {
      await mock.karmaRecord({ event: "modification_blocked", key, op: op.op, reason: "system_key", attempted_value: valueSummary });
      return;
    }

    const { value: existing, metadata } = await mock.kvGetWithMeta(key);
    if (existing !== null && !metadata?.unprotected) {
      await mock.karmaRecord({ event: "modification_blocked", key, op: op.op, reason: "protected_key", attempted_value: valueSummary });
      return;
    }

    switch (op.op) {
      case "put":
        await mock.kvPutSafe(op.key, op.value, { unprotected: true, ...op.metadata });
        break;
      case "delete":
        await mock.kvDeleteSafe(op.key);
        break;
      case "patch": {
        const current = await mock.kvGet(op.key);
        if (typeof current !== "string") break;
        if (!current.includes(op.old_string)) break;
        if (current.indexOf(op.old_string) !== current.lastIndexOf(op.old_string)) break;
        const patched = current.replace(op.old_string, op.new_string);
        await mock.kvPutSafe(op.key, patched, { unprotected: true, ...op.metadata });
        break;
      }
    }
  });

  return mock;
}
