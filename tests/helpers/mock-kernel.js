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
    kvWriteSafe: vi.fn(async (key, value, metadata) => {
      kv._store.set(key, typeof value === "string" ? value : JSON.stringify(value));
      if (metadata) kv._meta.set(key, metadata);
    }),
    kvDeleteSafe: vi.fn(async (key) => {
      kv._store.delete(key);
    }),
    // kvWritePrivileged removed — functionality moved to kvWriteGated with context

    // Event bus
    claimEvent: vi.fn(async (key, executionId) => {
      const raw = kv._store.get(key) ?? null;
      if (!raw) return false;
      const event = typeof raw === "string" ? JSON.parse(raw) : raw;
      const now = Date.now();
      if (event.claimed_by && event.lease_expires && event.lease_expires > now) {
        return false;
      }
      event.claimed_by = executionId;
      event.claimed_at = now;
      event.lease_expires = now + 60000;
      kv._store.set(key, JSON.stringify(event));
      return true;
    }),
    releaseEvent: vi.fn(async (key) => {
      const raw = kv._store.get(key) ?? null;
      if (!raw) return;
      const event = typeof raw === "string" ? JSON.parse(raw) : raw;
      delete event.claimed_by;
      delete event.claimed_at;
      delete event.lease_expires;
      kv._store.set(key, JSON.stringify(event));
    }),
    emitEvent: vi.fn(async (type, payload) => {
      const ts = Date.now().toString().padStart(15, '0');
      const nonce = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
      const key = `event:${ts}:${type}:${nonce}`;
      const event = { type, ...payload, timestamp: payload?.timestamp || new Date().toISOString() };
      kv._store.set(key, JSON.stringify(event));
      return { key };
    }),

    // Agent loop
    runAgentTurn: vi.fn(async () => ({ response: { content: null }, toolResults: [], cost: 0, done: true })),
    callLLM: vi.fn(async (opts) => {
      const content = '{}';
      const resp = { content, cost: 0, toolCalls: null };
      if (opts?.json) resp.parsed = JSON.parse(content);
      return resp;
    }),
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
    loadKeys: vi.fn(async (keys) => {
      const result = {};
      for (const key of keys) {
        const val = kv._store.get(key);
        result[key] = val ? (typeof val === "string" ? JSON.parse(val) : val) : null;
      }
      return result;
    }),
    mergeDefaults: vi.fn(async (d, o) => ({ ...d, ...o })),
    isSystemKey: vi.fn(async (key) => {
      const prefixes = [
        'prompt:', 'config:', 'tool:', 'provider:', 'secret:',
        'hook:', 'doc:', 'samskara:', 'skill:', 'task:',
        'principle:', 'contact:', 'contact_platform:', 'sealed:',
        'event:', 'event_dead:',
      ];
      const exact = ['providers', 'wallets', 'patron:contact', 'patron:identity_snapshot'];
      if (exact.includes(key)) return true;
      return prefixes.some(p => key.startsWith(p));
    }),
    getSystemKeyPatterns: vi.fn(async () => ({
      prefixes: [
        'prompt:', 'config:', 'tool:', 'provider:', 'secret:',
        'hook:', 'doc:', 'samskara:', 'skill:', 'task:',
        'principle:', 'contact:', 'contact_platform:', 'sealed:',
        'event:', 'event_dead:',
      ],
      exact: ['providers', 'wallets', 'patron:contact', 'patron:identity_snapshot'],
    })),

    // State
    getExecutionId: vi.fn(async () => opts.executionId || opts.sessionId || "test_execution"),
    getSessionCost: vi.fn(async () => opts.sessionCost || 0),
    getKarma: vi.fn(async () => opts.karma || []),
    getChatKarma: vi.fn(async () => []),
    getDefaults: vi.fn(async () => opts.defaults || {}),
    getModelsConfig: vi.fn(async () => opts.modelsConfig || null),
    getDharma: vi.fn(async () => opts.dharma || null),
    getToolRegistry: vi.fn(async () => opts.toolRegistry || null),
    getPrinciples: vi.fn(async () => opts.principles || null),
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

    // Internal — expose KV store for assertions
    _kv: kv,
  };

  // kvWriteGated mock — mirrors kernel context-based permission logic
  const _SYSTEM_PREFIXES = [
    'prompt:', 'config:', 'tool:', 'provider:', 'secret:',
    'hook:', 'doc:', 'samskara:', 'skill:', 'task:',
    'principle:', 'contact:', 'contact_platform:', 'sealed:',
    'event:', 'event_dead:',
  ];
  const _SYSTEM_EXACT = ['providers', 'wallets', 'patron:contact', 'patron:identity_snapshot'];
  const _KERNEL_ONLY = ['kernel:', 'sealed:', 'karma:', 'event:', 'event_dead:'];
  const _KERNEL_ONLY_EXACT = ['patron:direct'];
  const _CODE_PATTERNS = ['tool:', 'hook:', 'provider:', 'channel:'];
  function _isSystemKey(key) {
    if (_SYSTEM_EXACT.includes(key)) return true;
    return _SYSTEM_PREFIXES.some(p => key.startsWith(p));
  }
  function _isKernelOnly(key) {
    if (_KERNEL_ONLY_EXACT.includes(key)) return true;
    return _KERNEL_ONLY.some(p => key.startsWith(p));
  }
  function _isCodeKey(key) { return _CODE_PATTERNS.some(p => key.startsWith(p)) && key.endsWith(':code'); }

  mock.kvWriteGated = vi.fn(async (op, context) => {
    const key = op.key;

    if (key === "dharma" || key.startsWith("principle:") || key === "patron:public_key") {
      return { ok: false, error: `Cannot write "${key}" — immutable` };
    }
    if (_isKernelOnly(key)) {
      return { ok: false, error: `Cannot write kernel key "${key}"` };
    }
    if (_isCodeKey(key)) {
      return { ok: false, error: `Code key "${key}" requires proposal_requests` };
    }

    // Contact keys — allowed in all contexts
    if (key.startsWith("contact:") || key.startsWith("contact_platform:")) {
      if (op.op === "put") await mock.kvWriteSafe(op.key, op.value, op.metadata);
      else if (op.op === "delete") await mock.kvDeleteSafe(op.key);
      return { ok: true };
    }

    // System keys — deep-reflect only
    if (_isSystemKey(key)) {
      if (context !== "deep-reflect") {
        return { ok: false, error: `Cannot write system key "${key}" during ${context}` };
      }
      // Allow in deep-reflect (simplified mock — real kernel has deliberation gates)
      if (op.op === "put") await mock.kvWriteSafe(op.key, op.value, op.metadata);
      else if (op.op === "delete") await mock.kvDeleteSafe(op.key);
      return { ok: true };
    }

    // Agent keys — check protection
    const { value: existing, metadata } = await mock.kvGetWithMeta(key);
    if (existing !== null && !metadata?.unprotected) {
      return { ok: false, error: `Cannot overwrite protected key "${key}"` };
    }

    // Direct write
    switch (op.op) {
      case "put":
        await mock.kvWriteSafe(op.key, op.value, { unprotected: true, ...op.metadata });
        break;
      case "delete":
        await mock.kvDeleteSafe(op.key);
        break;
      case "patch": {
        const current = await mock.kvGet(op.key);
        if (typeof current !== "string") return { ok: false, error: `patch: key "${op.key}" is not a string` };
        if (!current.includes(op.old_string)) return { ok: false, error: `patch: old_string not found in "${op.key}"` };
        if (current.indexOf(op.old_string) !== current.lastIndexOf(op.old_string)) return { ok: false, error: `patch: old_string matches multiple locations in "${op.key}"` };
        const patched = current.replace(op.old_string, op.new_string);
        await mock.kvWriteSafe(op.key, patched, { unprotected: true, ...op.metadata });
        break;
      }
    }
    return { ok: true };
  });

  return mock;
}
