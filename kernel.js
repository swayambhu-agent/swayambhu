// Swayambhu Kernel
// Hardcoded safety primitives, execution engine, and session infrastructure.
// Policy (session flow, reflection) lives in act.js and reflect.js — mutable
// code injected at construction via HOOKS. Tools, providers, and channels are
// also injected. The kernel enforces safety: KV write tiers, dharma injection,
// communication gates, budget enforcement, and proposal mechanics.
//
// Entry point is index.js, which imports all modules and wires them here.

class Kernel {
  constructor(env, opts = {}) {
    this.env = env;
    this.ctx = opts.ctx || null;
    this.kv = env.KV;

    // Dependency injection — modules wired by index.js
    this.TOOLS = opts.TOOLS || {};
    this.HOOKS = opts.HOOKS || {};
    this.PROVIDERS = opts.PROVIDERS || {};
    this.CHANNELS = opts.CHANNELS || {};
    this.startTime = Date.now();
    this.sessionId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.sessionCost = 0;
    this.sessionLLMCalls = 0;
    this.karma = [];           // The flight recorder — replaces this.log
    this.mode = opts.mode || 'session'; // 'session' (act/reflect) or 'chat'
    this.modelsConfig = null;
    this.modelCapabilities = null;
    this.defaults = null;
    this.dharma = null;
    this.toolsCache = {};      // Loaded tool code+meta, cached per session
    this.lastWorkingSnapshotted = false; // Only snapshot provider once per session
    this.privilegedWriteCount = 0; // Counter for privileged writes (system + contact keys)
    this._alertConfigCache = undefined; // undefined = not loaded, null = doesn't exist
    this.yamas = null;         // Cached yama principles (loaded at boot)
    this.niyamas = null;       // Cached niyama principles (loaded at boot)
    this.patronId = null;      // Contact slug of patron (loaded at boot)
    this.patronContact = null; // Full patron contact record (loaded at boot)
    this.patronSnapshot = null;  // Last verified identity fields (loaded at boot)
    this.patronPlatforms = null; // Patron's platform bindings (loaded at boot from contact_platform: keys)
    this.patronIdentityDisputed = false; // True if monitored fields changed unverified
    this.lastCallModel = null; // Last model used in callLLM (for yama/niyama capability checks)
    this._commsGateApproved = false; // Transient flag: set by executeToolCall/processCommsVerdict around executeAction
  }

  static SYSTEM_KEY_PREFIXES = [
    'prompt:', 'config:', 'tool:', 'provider:', 'secret:',
    'proposal:', 'hook:', 'doc:',
    'yama:', 'niyama:', 'task:',
    'upaya:', 'prajna:',
    'skill:',
    'comms_blocked:',
    'contact:',
    'contact_platform:',
    'sealed:',
    'inbox:',
  ];
  static KERNEL_ONLY_PREFIXES = ['kernel:', 'sealed:', 'karma:', 'inbox:'];
  static KERNEL_ONLY_EXACT = ['patron:direct'];
  static SYSTEM_KEY_EXACT = ['providers', 'wallets', 'patron:contact', 'patron:identity_snapshot'];
  static IMMUTABLE_KEYS = ['patron:public_key'];
  static DANGER_SIGNALS = ["fatal_error", "act_parse_error", "all_providers_failed"];
  static MAX_PRIVILEGED_WRITES = 50;
  static PRINCIPLE_PREFIXES = ['yama:', 'niyama:'];

  static isSystemKey(key) {
    if (Kernel.SYSTEM_KEY_EXACT.includes(key)) return true;
    return Kernel.SYSTEM_KEY_PREFIXES.some(p => key.startsWith(p));
  }

  static isKernelOnly(key) {
    if (Kernel.KERNEL_ONLY_EXACT.includes(key)) return true;
    return Kernel.KERNEL_ONLY_PREFIXES.some(p => key.startsWith(p));
  }

  static isPrincipleKey(key) {
    return Kernel.PRINCIPLE_PREFIXES.some(p => key.startsWith(p));
  }

  static isPrincipleAuditKey(key) {
    return Kernel.isPrincipleKey(key) && key.endsWith(':audit');
  }

  // ── SSH Ed25519 key parsing ───────────────────────────────

  static parseSSHEd25519(sshKeyString) {
    const parts = sshKeyString.trim().split(/\s+/);
    if (parts[0] !== 'ssh-ed25519' || !parts[1]) {
      throw new Error('Not an ssh-ed25519 key');
    }
    const raw = Uint8Array.from(atob(parts[1]), c => c.charCodeAt(0));
    // SSH wire format: [4-byte len][key-type string][4-byte len][32-byte key]
    const typeLen = (raw[0] << 24) | (raw[1] << 16) | (raw[2] << 8) | raw[3];
    const keyOffset = 4 + typeLen + 4;
    const keyLen = (raw[4 + typeLen] << 24) | (raw[4 + typeLen + 1] << 16) |
                   (raw[4 + typeLen + 2] << 8) | raw[4 + typeLen + 3];
    if (keyLen !== 32) throw new Error(`Expected 32-byte ed25519 key, got ${keyLen}`);
    return raw.slice(keyOffset, keyOffset + 32);
  }

  // ── Yamas and Niyamas (operating principles) ─────────────

  async loadEagerConfig() {
    this.defaults = await this.kvGet("config:defaults");
    this.modelsConfig = await this.kvGet("config:models");
    this.modelCapabilities = await this.kvGet("config:model_capabilities");
    this.dharma = await this.kvGet("dharma");
    this.toolRegistry = await this.kvGet("config:tool_registry");
    this.toolGrants = await this.kvGet("kernel:tool_grants");
    if (!this.toolGrants || Object.keys(this.toolGrants).length === 0) {
      this.toolGrants = this._buildToolGrantsFromModules();
    }
    await this.loadYamasNiyamas();
    await this.loadPatronContext();
  }

  async loadYamasNiyamas() {
    this.yamas = {};
    this.niyamas = {};
    for (const prefix of Kernel.PRINCIPLE_PREFIXES) {
      const principleKeys = await this.kvListAll({ prefix });
      for (const { name: key } of principleKeys) {
        if (key.endsWith(':audit')) continue;
        const value = await this.kvGet(key);
        if (value === null) continue;
        if (prefix === 'yama:') this.yamas[key] = value;
        else this.niyamas[key] = value;
      }
    }
  }

  // ── Patron context ──────────────────────────────────────

  async loadPatronContext() {
    const patronSlug = await this.kvGet("patron:contact");
    if (!patronSlug) return;

    this.patronId = patronSlug;
    this.patronContact = await this.kvGet(`contact:${patronSlug}`);
    if (!this.patronContact) return;

    // Build platforms map from contact_platform: keys for this patron
    const platformKeys = await this.kvListAll({ prefix: "contact_platform:" });
    this.patronPlatforms = {};
    const patronPlatforms = this.patronPlatforms;
    for (const { name: key } of platformKeys) {
      const binding = await this.kvGet(key);
      if (binding?.slug === patronSlug) {
        // key format: contact_platform:{platform}:{userId}
        const parts = key.replace("contact_platform:", "").split(":");
        const platform = parts[0];
        const userId = parts.slice(1).join(":");
        patronPlatforms[platform] = userId;
      }
    }

    // Identity monitor — compare monitored fields against last verified snapshot
    const snapshot = await this.kvGet("patron:identity_snapshot");
    if (!snapshot) {
      // First boot — create snapshot from seed
      const initial = {
        name: this.patronContact.name,
        platforms: patronPlatforms,
        verified_at: new Date().toISOString(),
      };
      await this.kvWrite("patron:identity_snapshot", initial);
      this.patronSnapshot = initial;
      this.patronIdentityDisputed = false;
    } else {
      this.patronSnapshot = snapshot;
      const nameChanged = this.patronContact.name !== snapshot.name;
      const platformsChanged = JSON.stringify(patronPlatforms) !== JSON.stringify(snapshot.platforms);
      this.patronIdentityDisputed = nameChanged || platformsChanged;
      if (this.patronIdentityDisputed) {
        await this.karmaRecord({
          event: "patron_identity_disputed",
          old: { name: snapshot.name, platforms: snapshot.platforms },
          new: { name: this.patronContact.name, platforms: patronPlatforms },
        });
      }
    }
  }

  async kvListAll(opts = {}) {
    const keys = [];
    let cursor;
    let pages = 0;
    do {
      const result = await this.kv.list({ ...opts, cursor });
      keys.push(...result.keys);
      cursor = result.list_complete ? undefined : result.cursor;
      if (++pages > 100) { console.error("[KERNEL] kvListAll: hit 100-page safety limit"); break; }
    } while (cursor);
    return keys;
  }

  async resolveContact(platform, platformUserId) {
    // Look up platform binding — single source of truth for platform→contact mapping
    const binding = await this.kvGet(`contact_platform:${platform}:${platformUserId}`);
    if (!binding?.slug) return null;

    const contact = await this.kvGet(`contact:${binding.slug}`);
    if (!contact) return null;

    // Attach approval from platform binding (not from contact record)
    const resolved = { ...contact, approved: binding.approved === true };
    return this._applyPatronSnapshot(binding.slug, resolved);
  }

  _applyPatronSnapshot(id, contact) {
    // When patron identity is disputed, override monitored fields with last-known-good values
    if (this.patronIdentityDisputed && id === this.patronId && this.patronSnapshot) {
      return { id, ...contact, name: this.patronSnapshot.name };
    }
    return { id, ...contact };
  }

  isYamaCapable(modelId) {
    const resolved = this.resolveModel(modelId);
    return !!this.modelCapabilities?.[resolved]?.yama_capable;
  }

  isNiyamaCapable(modelId) {
    const resolved = this.resolveModel(modelId);
    return !!this.modelCapabilities?.[resolved]?.niyama_capable;
  }


  // ── Communication gate (kernel-enforced contact boundary) ───

  resolveRecipient(args, meta) {
    const comm = meta.communication;
    if (!comm?.recipient_field) return null;
    return args[comm.recipient_field] || null;
  }

  resolveCommsMode(args, meta) {
    const comm = meta.communication;
    if (!comm?.reply_field) return 'initiating';
    return args[comm.reply_field] ? 'responding' : 'initiating';
  }

  generateCommsBlockedId() {
    return `cb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  async queueBlockedComm(toolName, args, meta, reason, gateResult) {
    const id = this.generateCommsBlockedId();
    const record = {
      id,
      tool: toolName,
      args,
      channel: meta.communication.channel,
      content_field: meta.communication.content_field || null,
      recipient: this.resolveRecipient(args, meta),
      mode: this.resolveCommsMode(args, meta),
      reason,
      gate_verdict: gateResult,
      session_id: this.sessionId,
      model: this.lastCallModel,
      timestamp: new Date().toISOString(),
    };
    // Kernel-internal write — not exposed via RPC
    await this.kvWrite(`comms_blocked:${id}`, record);
    await this.karmaRecord({
      event: "comms_blocked",
      id, tool: toolName,
      channel: meta.communication.channel,
      recipient: record.recipient,
      mode: record.mode,
      reason,
    });
    return id;
  }

  async communicationGate(toolName, args, meta) {
    const recipient = this.resolveRecipient(args, meta);
    const mode = this.resolveCommsMode(args, meta);

    // Mechanical floor — blocks person-targeted comms to unknown/unapproved contacts
    // Destination-targeted tools (e.g. Slack channel) pass through
    const channel = meta.communication?.channel;
    const recipientType = meta.communication?.recipient_type || 'destination';
    const recipientContact = recipient ? await this.resolveContact(channel, recipient) : null;
    if (recipientType === 'person' && recipient) {
      if (!recipientContact) {
        if (mode === 'initiating') {
          return {
            verdict: 'block',
            reasoning: `No contact record for recipient "${recipient}" — cannot initiate contact with unknown person`,
            mechanical: true,
          };
        }
      } else if (!recipientContact.approved) {
        return {
          verdict: 'block',
          reasoning: `Contact "${recipient}" is not approved — all communication blocked until patron approves`,
          mechanical: true,
        };
      }
    }

    // Staleness check — if inbox items arrived since session started, hold outbound.
    // Inbox items only exist when unprocessed (drainInbox deletes them at session start),
    // so any present items arrived mid-session and the agent's context is stale.
    if (this.mode === 'session') {
      const peek = await this.kv.list({ prefix: "inbox:", limit: 1 });
      if (peek.keys.length > 0) {
        return {
          verdict: 'hold',
          reasoning: 'Unprocessed inbox items arrived during session — holding to avoid stale reply',
        };
      }
    }

    // Approved contact or destination — allow through
    // Message quality and comms policy are the agent's responsibility (see skill:comms)
    return { verdict: 'send' };
  }

  async listBlockedComms() {
    const blockedKeys = await this.kvListAll({ prefix: 'comms_blocked:' });
    const entries = [];
    for (const { name: key } of blockedKeys) {
      const value = await this.kvGet(key);
      if (value !== null) {
        try { entries.push(typeof value === 'string' ? JSON.parse(value) : value); }
        catch { continue; }
      }
    }
    return entries;
  }

  // ── Inbox (unified event queue) ────────────────────────────
  // All external events (chat messages, patron directives, job completions)
  // write to inbox:* keys. Sessions drain the inbox at startup.

  async drainInbox() {
    const keys = await this.kvListAll({ prefix: "inbox:" });
    const items = [];
    for (const { name } of keys) {
      const val = await this.kvGet(name);
      if (val) {
        items.push(val);
        await this.kv.delete(name);
      }
    }
    if (items.length > 0) {
      await this.karmaRecord({
        event: "inbox_drained",
        count: items.length,
        types: items.reduce((acc, i) => { acc[i.type] = (acc[i.type] || 0) + 1; return acc; }, {}),
      });
    }
    return items;
  }

  async processCommsVerdict(id, verdict, revision) {
    const key = `comms_blocked:${id}`;
    const raw = await this.kvGet(key);
    if (!raw) return { error: `No blocked comm: ${id}` };
    let record;
    try { record = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch { return { error: "corrupted record" }; }

    if (verdict === 'send' || verdict === 'revise_and_send') {
      let sendArgs = { ...record.args };
      if (verdict === 'revise_and_send' && revision?.text) {
        const cf = record.content_field;
        if (cf && sendArgs[cf] !== undefined) sendArgs[cf] = revision.text;
      }
      // Execute via executeAction — set gate flag (already approved by deep reflect)
      this._commsGateApproved = true;
      let result;
      try {
        result = await this.executeAction({
          tool: record.tool,
          input: sendArgs,
          id: `comms_verdict_${id}`,
        });
      } finally {
        this._commsGateApproved = false;
      }
      // Check if delivery actually succeeded before deleting the record
      if (result?.ok === false || result?.error) {
        await this.karmaRecord({
          event: 'comms_verdict_failed', id, tool: record.tool,
          recipient: record.recipient, verdict,
          error: result?.error || 'delivery failed',
        });
        return { ok: false, error: result?.error || 'delivery failed', result };
      }
      await this.karmaRecord({
        event: 'comms_verdict_sent', id, tool: record.tool,
        recipient: record.recipient, verdict,
        revised: verdict === 'revise_and_send',
      });
      await this.kv.delete(key);
      return { ok: true, result };
    }

    if (verdict === 'drop') {
      await this.karmaRecord({
        event: 'comms_verdict_dropped', id, tool: record.tool,
        recipient: record.recipient,
        reason: revision?.reason || 'dropped by deep reflect',
      });
      await this.kv.delete(key);
      return { ok: true, dropped: true };
    }

    return { error: `Unknown verdict: ${verdict}` };
  }

  // ── Debug log (durable, auto-expiring) ──────────────────────

  static LOG_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

  async writeLog(category, details) {
    const key = `log:${category}:${Date.now()}`;
    await this.kv.put(key, JSON.stringify({
      ...details,
      timestamp: new Date().toISOString(),
    }), { expirationTtl: Kernel.LOG_TTL_SECONDS });
    return key;
  }

  // ── Karma log ────────────────────────────────────────────────

  async karmaRecord(entry) {
    const record = {
      t: Date.now(),
      elapsed_ms: this.elapsed(),
      ...entry,
    };
    this.karma.push(record);

    // In chat mode, karma stays in-memory only — handleChat embeds it in the chat object.
    // In session mode, persist to KV after every event for crash recovery.
    if (this.mode !== 'chat') {
      await this.kvWrite(`karma:${this.sessionId}`, this.karma);
    }

    if (Kernel.DANGER_SIGNALS.includes(entry.event)) {
      await this.kvWrite("last_danger", {
        t: record.t,
        event: entry.event,
        session_id: this.sessionId,
      });
    }
  }

  // ── Kernel alerting ────────────────────────────────────────

  async sendKernelAlert(event, message) {
    try {
      if (this._alertConfigCache === undefined) {
        this._alertConfigCache = await this.kvGet("kernel:alert_config");
      }
      const config = this._alertConfigCache;
      if (!config?.url) return;

      // Resolve {{ENV_VAR}} patterns in URL from this.env
      const url = config.url.replace(/\{\{(\w+)\}\}/g, (_, name) => this.env[name] || "");

      // Build body from template, interpolating {{message}}, {{event}}, {{session}}
      const vars = { message, event, session: this.sessionId };
      const bodyStr = JSON.stringify(config.body_template || {})
        .replace(/\{\{(\w+)\}\}/g, (_, name) => vars[name] || "");

      await fetch(url, {
        method: "POST",
        headers: config.headers || { "Content-Type": "application/json" },
        body: bodyStr,
      });
    } catch {
      // Alerting must never crash the kernel — swallow errors
    }
  }

  // ── KV write tiers (RPC-exposed) ─────────────────────────

  async kvWriteSafe(key, value, metadata) {
    if (key === "dharma") throw new Error("Cannot overwrite dharma — immutable key");
    if (Kernel.isKernelOnly(key)) throw new Error(`Blocked: kernel-only key "${key}"`);
    if (Kernel.isSystemKey(key)) throw new Error(`Blocked: system key "${key}" — use kvWriteGated with deep-reflect context`);
    return this.kvWrite(key, value, metadata);
  }

  async kvDeleteSafe(key) {
    if (key === "dharma") throw new Error("Cannot delete dharma — immutable key");
    if (Kernel.isKernelOnly(key)) throw new Error(`Blocked: kernel-only key "${key}"`);
    if (Kernel.isSystemKey(key)) throw new Error(`Blocked: system key "${key}" — use kvWriteGated with deep-reflect context`);
    return this.kv.delete(key);
  }

  // kvWritePrivileged — REMOVED. Functionality moved to kvWriteGated with context-based permissions.
  // Contact gating → _gateContact(). System key gating → _gateSystem().
  // processCommsVerdict uses direct kv.delete() for comms_blocked: cleanup.

  // ── Kernel interface (replaces KernelRPC) ───────────────────
  // Returns a K object with the same API hooks expect from KernelRPC.
  // Includes sealed: key filtering for security.

  buildKernelInterface() {
    const kernel = this;
    return {
      // LLM
      callLLM: async (opts) => kernel.callLLM(opts),

      // KV reads (sealed keys blocked — hook code must not read quarantined data)
      kvGet: async (key) => {
        if (key.startsWith("sealed:")) return null;
        return kernel.kvGet(key);
      },
      kvGetWithMeta: async (key) => {
        if (key.startsWith("sealed:")) return { value: null, metadata: null };
        return kernel.kvGetWithMeta(key);
      },
      kvList: async (opts) => kernel.kv.list(opts),

      // KV writes
      kvWriteSafe: async (key, value, metadata) => kernel.kvWriteSafe(key, value, metadata),
      kvDeleteSafe: async (key) => kernel.kvDeleteSafe(key),
      kvWriteGated: async (op, context) => kernel.kvWriteGated(op, context),

      // Agent loop
      runAgentLoop: async (opts) => kernel.runAgentLoop(opts),
      executeToolCall: async (tc) => kernel.executeToolCall(tc),
      buildToolDefinitions: async (extra) => kernel.buildToolDefinitions(extra),
      spawnSubplan: async (args, depth) => kernel.spawnSubplan(args, depth),
      callHook: async (name, ctx) => kernel.callHook(name, ctx),
      executeAction: async (step) => kernel.executeAction(step),
      executeAdapter: async (adapterKey, input) => kernel.executeAdapter(adapterKey, input),

      // Blocked communications
      listBlockedComms: async () => kernel.listBlockedComms(),
      processCommsVerdict: async (id, verdict, revision) => kernel.processCommsVerdict(id, verdict, revision),

      // Inbox (unified event queue)
      writeInboxItem: async (item) => {
        const ts = Date.now().toString().padStart(15, '0');
        const source = item.type === 'chat_message'
          ? `chat:${item.source?.channel}:${item.source?.user_id}`
          : item.type;
        const key = `inbox:${ts}:${source}`;
        await kernel.kv.put(key, JSON.stringify(item), { expirationTtl: 86400 });
      },

      // Balance
      checkBalance: async (args) => kernel.checkBalance(args),

      // Karma & logging
      karmaRecord: async (entry) => kernel.karmaRecord(entry),
      writeLog: async (category, details) => kernel.writeLog(category, details),

      // Utility
      resolveModel: async (m) => kernel.resolveModel(m),
      estimateCost: async (model, usage) => kernel.estimateCost(model, usage),
      buildPrompt: async (template, vars) => kernel.buildPrompt(template, vars),
      parseAgentOutput: async (content) => kernel.parseAgentOutput(content),
      loadKeys: async (keys) => {
        const filtered = keys.filter(k => !k.startsWith("sealed:"));
        return kernel.loadKeys(filtered);
      },
      getSessionCount: async () => kernel.getSessionCount(),
      mergeDefaults: async (defaults, overrides) => kernel.mergeDefaults(defaults, overrides),
      isSystemKey: async (key) => Kernel.isSystemKey(key),
      getSystemKeyPatterns: async () => ({
        prefixes: Kernel.SYSTEM_KEY_PREFIXES,
        exact: Kernel.SYSTEM_KEY_EXACT,
      }),

      // KV operation gating — context-based permissions
      // (kvWriteGated already exposed above in KV writes section)

      // Config utilities (used by both act.js and reflect.js)
      getMaxSteps: async (state, role, depth) => Kernel.getMaxSteps(state, role, depth),
      getReflectModel: async (state, depth) => Kernel.getReflectModel(state, depth),

      // Proposal system (code change proposals)
      createProposal: async (request, sessionId, depth) => kernel.createProposal(request, sessionId, depth),
      loadProposals: async (statusFilter) => kernel.loadProposals(statusFilter),
      updateProposalStatus: async (id, newStatus, metadata) => kernel.updateProposalStatus(id, newStatus, metadata),
      processProposalVerdicts: async (verdicts, depth) => kernel.processProposalVerdicts(verdicts, depth),

      // State (read-only)
      getSessionId: async () => kernel.sessionId,
      getSessionCost: async () => kernel.sessionCost,
      getKarma: async () => kernel.karma,
      getChatKarma: async () => kernel.mode === 'chat' ? [...kernel.karma] : [],
      getDefaults: async () => kernel.defaults,
      getModelsConfig: async () => kernel.modelsConfig,
      getModelCapabilities: async () => kernel.modelCapabilities,
      getDharma: async () => kernel.dharma,
      getToolRegistry: async () => kernel.toolRegistry,
      getYamas: async () => kernel.yamas,
      getNiyamas: async () => kernel.niyamas,
      getPatronId: async () => kernel.patronId,
      getPatronContact: async () => kernel.patronContact,
      isPatronIdentityDisputed: async () => kernel.patronIdentityDisputed,
      rotatePatronKey: async (newPublicKey, signature) => kernel.rotatePatronKey(newPublicKey, signature),
      resolveContact: async (platform, platformUserId) => kernel.resolveContact(platform, platformUserId),
      elapsed: async () => kernel.elapsed(),
    };
  }

  // ── KV write gating (context-based permissions for agent-originated writes) ──

  async kvWriteGated(op, context) {
    const key = op.key;

    // 1. Always blocked — immutable keys
    if (key === "dharma" || Kernel.IMMUTABLE_KEYS.includes(key)) {
      return { ok: false, error: `Cannot write "${key}" — immutable` };
    }

    // 2. Always blocked — kernel-only keys
    if (Kernel.isKernelOnly(key)) {
      return { ok: false, error: `Cannot write kernel key "${key}"` };
    }

    // 3. Always blocked — code keys go through proposal_requests
    if (Kernel.isCodeKey(key)) {
      return { ok: false, error: `Code key "${key}" requires proposal_requests` };
    }

    // 4. Contact keys — allowed in all contexts (with approval gating)
    if (key.startsWith("contact:") || key.startsWith("contact_platform:")) {
      return this._gateContact(op);
    }

    // 5. System keys — deep-reflect only
    if (Kernel.isSystemKey(key)) {
      if (context !== "deep-reflect") {
        return { ok: false, error: `Cannot write system key "${key}" during ${context} — note in session_summary for deep reflect` };
      }
      return this._gateSystem(op);
    }

    // 6. Agent keys — check protection
    const { value: existing, metadata } = await this.kvGetWithMeta(key);
    if (existing !== null && !metadata?.unprotected) {
      return { ok: false, error: `Cannot overwrite protected key "${key}"` };
    }

    // 7. Unprotected or new agent key — direct write
    return this._kvWriteDirect(op);
  }

  // ── Contact key gating (approval rules for platform bindings) ──

  async _gateContact(op) {
    const key = op.key;

    // Only put/delete/patch supported for contact keys
    if (!["put", "delete", "patch"].includes(op.op)) {
      return { ok: false, error: `Unsupported op "${op.op}" for contact key "${key}"` };
    }

    if (key.startsWith("contact_platform:")) {
      if (op.op === "patch" && op.new_string?.includes('"approved"')) {
        return { ok: false, error: `Cannot patch "approved" field on platform bindings — use the dashboard` };
      }
      if (op.op === "delete") {
        const existing = await this.kvGet(key);
        if (existing?.approved) {
          return { ok: false, error: `Deletion of approved platform bindings is patron-only` };
        }
      } else if (op.op !== "patch") {
        if (op.value?.approved === true) {
          return { ok: false, error: `Setting approved: true on platform bindings is patron-only` };
        }
        if (!op.value?.slug) {
          return { ok: false, error: `Platform binding must include a slug` };
        }
        op.value = { ...op.value, approved: false };
      }
    }

    // Snapshot old value for karma
    const { value: oldValue } = await this.kvGetWithMeta(key);

    // Execute via raw write (bypasses system key check in kvWriteSafe)
    if (op.op === "delete") {
      await this.kv.delete(key);
    } else if (op.op === "patch") {
      const current = await this.kvGet(key);
      if (typeof current !== "string") return { ok: false, error: `patch: key "${key}" is not a string` };
      if (!current.includes(op.old_string)) return { ok: false, error: `patch: old_string not found in "${key}"` };
      if (current.indexOf(op.old_string) !== current.lastIndexOf(op.old_string)) return { ok: false, error: `patch: old_string matches multiple locations in "${key}"` };
      await this.kvWrite(key, current.replace(op.old_string, op.new_string), op.metadata);
    } else {
      await this.kvWrite(key, op.value, op.metadata);
    }

    // Karma after successful write
    await this.karmaRecord({
      event: "privileged_write", key, old_value: oldValue,
      new_value: op.value, op: op.op,
    });
    this.privilegedWriteCount++;
    return { ok: true };
  }

  // ── System key gating (deep-reflect only, deliberation gates for principles) ──

  async _gateSystem(op) {
    const key = op.key;

    // Only put/delete/patch supported for system keys
    if (!["put", "delete", "patch"].includes(op.op)) {
      return { ok: false, error: `Unsupported op "${op.op}" for system key "${key}"` };
    }

    // Model capabilities require deliberation + yama_capable model
    if (key === "config:model_capabilities") {
      if (!op.deliberation || op.deliberation.length < 200) {
        return { ok: false, error: `Model capability changes require deliberation (min 200 chars, got ${op.deliberation?.length || 0})` };
      }
      if (!this.isYamaCapable(this.lastCallModel)) {
        return { ok: false, error: `Model capability changes require a yama_capable model (last model: ${this.lastCallModel})` };
      }
    }

    // Yama/Niyama deliberation + capability gates
    if (Kernel.isPrincipleKey(key) && !Kernel.isPrincipleAuditKey(key)) {
      const isYama = key.startsWith('yama:');
      const type = isYama ? 'yama' : 'niyama';
      const minChars = isYama ? 200 : 100;
      const typeLabel = isYama ? 'Yama' : 'Niyama';

      if (!op.deliberation || op.deliberation.length < minChars) {
        return { ok: false, error: `${typeLabel} modifications require deliberation (min ${minChars} chars, got ${op.deliberation?.length || 0})` };
      }
      const capCheck = isYama ? this.isYamaCapable(this.lastCallModel) : this.isNiyamaCapable(this.lastCallModel);
      if (!capCheck) {
        return { ok: false, error: `${typeLabel} writes require a ${type}_capable model (last model: ${this.lastCallModel})` };
      }
    }

    // Per-session limit
    if (this.privilegedWriteCount + 1 > Kernel.MAX_PRIVILEGED_WRITES) {
      return { ok: false, error: `Privileged write limit (${Kernel.MAX_PRIVILEGED_WRITES}/session) exceeded` };
    }

    // Principle diff warning
    let principleWarning = null;
    if (Kernel.isPrincipleKey(key) && !Kernel.isPrincipleAuditKey(key)) {
      const isYama = key.startsWith('yama:');
      const type = isYama ? 'yama' : 'niyama';
      const currentValue = await this.kvGet(key);
      const proposedValue = op.op === 'delete' ? null : (op.op === 'patch' ? `[patch: "${op.old_string}" → "${op.new_string}"]` : op.value);
      const name = key.replace(`${type}:`, '');

      const warningMsg = isYama
        ? `WARNING: You are modifying yama "${name}".\n\nCAUTION: You are attempting to modify a yama — a core principle of how you act in the world. This requires extraordinary justification. How does this change better serve your dharma?\n\nCurrent value: ${currentValue ?? '(new)'}\nProposed value: ${proposedValue ?? '(delete)'}`
        : `WARNING: You are modifying niyama "${name}".\n\nCAUTION: You are attempting to modify a niyama — a core principle that governs how you reflect and improve. This requires compelling justification. How does this change better serve your dharma?\n\nCurrent value: ${currentValue ?? '(new)'}\nProposed value: ${proposedValue ?? '(delete)'}`;

      principleWarning = { key, name, type, current_value: currentValue, proposed_value: proposedValue, deliberation: op.deliberation, model: this.lastCallModel, message: warningMsg };
    }

    // Snapshot old value
    const { value: oldValue } = await this.kvGetWithMeta(key);

    // Execute
    if (op.op === "delete") {
      await this.kv.delete(key);
    } else if (op.op === "patch") {
      const current = await this.kvGet(key);
      if (typeof current !== "string") return { ok: false, error: `patch: key "${key}" is not a string` };
      if (!current.includes(op.old_string)) return { ok: false, error: `patch: old_string not found in "${key}"` };
      if (current.indexOf(op.old_string) !== current.lastIndexOf(op.old_string)) return { ok: false, error: `patch: old_string matches multiple locations in "${key}"` };
      await this.kvWrite(key, current.replace(op.old_string, op.new_string), op.metadata);
    } else {
      await this.kvWrite(key, op.value, op.metadata);
    }

    // Karma after successful write
    await this.karmaRecord({
      event: "privileged_write", key, old_value: oldValue,
      new_value: op.value, op: op.op,
    });
    this.privilegedWriteCount++;

    // Audit trail for yama/niyama
    if (Kernel.isPrincipleKey(key) && !Kernel.isPrincipleAuditKey(key)) {
      const auditKey = `${key}:audit`;
      const existing = await this.kvGet(auditKey) || [];
      existing.push({
        date: new Date().toISOString(),
        model: this.lastCallModel,
        deliberation: op.deliberation,
        old_value: oldValue,
        new_value: op.op === 'delete' ? null : (op.value ?? null),
      });
      await this.kvWrite(auditKey, existing);
    }

    // Alert on hook: key writes
    if (key.startsWith("hook:")) {
      await this.sendKernelAlert("hook_write",
        `Privileged write to ${key} in session ${this.sessionId}`);
    }

    // Auto-reload cached config
    const configKeys = ["config:defaults", "config:models", "config:tool_registry", "config:model_capabilities"];
    if (configKeys.includes(key)) {
      if (key === "config:defaults") this.defaults = await this.kvGet("config:defaults");
      if (key === "config:models") this.modelsConfig = await this.kvGet("config:models");
      if (key === "config:tool_registry") this.toolRegistry = await this.kvGet("config:tool_registry");
      if (key === "config:model_capabilities") this.modelCapabilities = await this.kvGet("config:model_capabilities");
    }

    // Reload principle cache
    if (Kernel.isPrincipleKey(key) && !Kernel.isPrincipleAuditKey(key)) {
      await this.loadYamasNiyamas();
    }

    const result = { ok: true };
    if (principleWarning) result.warning = principleWarning;
    return result;
  }

  // ── Direct write for unprotected agent keys ──

  async _kvWriteDirect(op) {
    switch (op.op) {
      case "put":
        await this.kvWriteSafe(op.key, op.value, { unprotected: true, ...op.metadata });
        return { ok: true };
      case "delete":
        await this.kvDeleteSafe(op.key);
        return { ok: true };
      case "patch": {
        const current = await this.kvGet(op.key);
        if (typeof current !== "string") return { ok: false, error: `patch: key "${op.key}" is not a string` };
        if (!current.includes(op.old_string)) return { ok: false, error: `patch: old_string not found in "${op.key}"` };
        if (current.indexOf(op.old_string) !== current.lastIndexOf(op.old_string)) return { ok: false, error: `patch: old_string matches multiple locations in "${op.key}"` };
        const patched = current.replace(op.old_string, op.new_string);
        await this.kvWriteSafe(op.key, patched, { unprotected: true, ...op.metadata });
        return { ok: true };
      }
      case "rename": {
        const { value, metadata } = await this.kvGetWithMeta(op.key);
        if (value === null) return { ok: false, error: `rename: key "${op.key}" does not exist` };
        await this.kvWriteSafe(op.value, value, metadata);
        await this.kvDeleteSafe(op.key);
        return { ok: true };
      }
      default:
        return { ok: false, error: `Unknown op: ${op.op}` };
    }
  }

  // ── Proposal system (code change proposals — governor deploys accepted ones) ──

  static CODE_KEY_PATTERNS = ['tool:', 'hook:', 'provider:', 'channel:'];

  static isCodeKey(key) {
    return Kernel.CODE_KEY_PATTERNS.some(p => key.startsWith(p)) && key.endsWith(':code');
  }

  _generateProposalId() {
    return `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  async createProposal(request, sessionId, depth = 0) {
    if (!request.claims?.length || !request.ops?.length) {
      await this.karmaRecord({ event: "proposal_invalid", reason: "missing required fields (claims, ops)" });
      return null;
    }

    // Validate all ops target code keys
    const nonCodeOps = request.ops.filter(op => !Kernel.isCodeKey(op.key));
    if (nonCodeOps.length > 0) {
      await this.karmaRecord({
        event: "proposal_invalid",
        reason: `proposal ops must target code keys — non-code targets: ${nonCodeOps.map(o => o.key).join(', ')}`,
      });
      return null;
    }

    const id = this._generateProposalId();
    const sessionCount = await this.getSessionCount();
    const proposal = {
      id,
      targets: request.ops.map(op => op.key),
      changes: {},
      claims: request.claims,
      checks: request.checks || [],
      proposed_by: sessionId,
      proposed_at: new Date().toISOString(),
      proposed_at_session: sessionCount,
      proposed_by_depth: depth,
      status: "proposed",
    };

    // Store the actual change data
    for (const op of request.ops) {
      proposal.changes[op.key] = { op: op.op || "put", code: op.value, old_string: op.old_string, new_string: op.new_string };
    }

    await this.kvWrite(`proposal:${id}`, proposal);
    await this.karmaRecord({ event: "proposal_created", proposal_id: id, claims: request.claims, targets: proposal.targets });
    return id;
  }

  async loadProposals(statusFilter) {
    const list = await this.kvListAll({ prefix: "proposal:" });
    const proposals = {};
    const sessionCount = await this.getSessionCount();
    for (const { name: key } of list) {
      const record = await this.kvGet(key);
      if (!record) continue;
      if (statusFilter && record.status !== statusFilter) continue;
      const checkResults = record.checks?.length
        ? await this._evaluateChecks(record.checks)
        : null;
      const sessions_since = record.proposed_at_session != null
        ? sessionCount - record.proposed_at_session
        : null;
      proposals[record.id] = { record, check_results: checkResults, sessions_since };
    }
    return proposals;
  }

  async updateProposalStatus(id, newStatus, metadata = {}) {
    const record = await this.kvGet(`proposal:${id}`);
    if (!record) throw new Error(`No proposal: ${id}`);
    record.status = newStatus;
    Object.assign(record, metadata);
    record[`${newStatus}_at`] = new Date().toISOString();
    await this.kvWrite(`proposal:${id}`, record);
    await this.karmaRecord({ event: `proposal_${newStatus}`, proposal_id: id });
  }

  async processProposalVerdicts(verdicts, depth) {
    for (const v of verdicts || []) {
      const id = v.proposal_id;
      if (!id) continue;
      switch (v.verdict) {
        case "accept":
          await this.updateProposalStatus(id, "accepted", { accepted_by_depth: depth });
          break;
        case "reject":
          await this.updateProposalStatus(id, "rejected", { reason: v.reason, rejected_by_depth: depth });
          break;
        case "withdraw":
          await this.kvDelete(`proposal:${id}`);
          await this.karmaRecord({ event: "proposal_withdrawn", proposal_id: id });
          break;
        case "modify": {
          const record = await this.kvGet(`proposal:${id}`);
          if (record) {
            if (v.updated_ops) {
              record.ops = v.updated_ops;
              record.changes = {};
              for (const op of v.updated_ops) {
                record.changes[op.key] = { op: op.op || "put", code: op.value, old_string: op.old_string, new_string: op.new_string };
              }
              record.targets = v.updated_ops.map(op => op.key);
            }
            if (v.updated_checks) record.checks = v.updated_checks;
            if (v.updated_claims) record.claims = v.updated_claims;
            record.modified_at = new Date().toISOString();
            await this.kvWrite(`proposal:${id}`, record);
            await this.karmaRecord({ event: "proposal_modified", proposal_id: id });
          }
          break;
        }
        case "defer":
          await this.karmaRecord({ event: "proposal_deferred", proposal_id: id, reason: v.reason });
          break;
      }
    }

    // Signal governor if any proposals were accepted
    const hasAccepted = verdicts?.some(v => v.verdict === "accept");
    if (hasAccepted) {
      await this.kvWrite("deploy:pending", {
        requested_at: new Date().toISOString(),
        session_id: this.sessionId,
      });
    }
  }

  async kvDelete(key) {
    await this.kv.delete(key);
  }

  // ── Predicate evaluation (used by proposals and reflect) ──

  static evaluatePredicate(value, predicate, expected) {
    switch (predicate) {
      case "exists": return value !== null && value !== undefined;
      case "equals": return value === expected;
      case "gt": return typeof value === "number" && value > expected;
      case "lt": return typeof value === "number" && value < expected;
      case "matches": return typeof value === "string" && new RegExp(expected).test(value);
      case "type": return typeof value === expected;
      default: return false;
    }
  }

  async _evaluateCheck(check) {
    try {
      switch (check.type) {
        case "kv_assert": {
          let value = await this.kvGet(check.key);
          if (check.path && value != null) {
            value = check.path.split(".").reduce((o, k) => o?.[k], value);
          }
          const passed = Kernel.evaluatePredicate(value, check.predicate, check.expected);
          return { passed, detail: `${check.key}${check.path ? '.' + check.path : ''} ${check.predicate} ${JSON.stringify(check.expected)} → actual: ${JSON.stringify(value)}` };
        }
        case "tool_call": {
          const result = await this.executeAction({
            tool: check.tool, input: check.input || {}, id: `check_${check.tool}`,
          });
          if (check.assert) {
            const passed = Kernel.evaluatePredicate(result, check.assert.predicate, check.assert.expected);
            return { passed, detail: `${check.tool} result ${check.assert.predicate} ${JSON.stringify(check.assert.expected)} → actual: ${JSON.stringify(result)}` };
          }
          return { passed: true, detail: `${check.tool} executed successfully` };
        }
        default:
          return { passed: false, detail: `unknown check type: ${check.type}` };
      }
    } catch (err) {
      return { passed: false, detail: `check error: ${err.message}` };
    }
  }

  async _evaluateChecks(checks) {
    const results = [];
    for (const check of checks) {
      results.push(await this._evaluateCheck(check));
    }
    return { all_passed: results.every(r => r.passed), results };
  }

  // ── Tool grants from static imports (fallback when kernel:tool_grants not in KV) ──

  _buildToolGrantsFromModules() {
    const GRANT_FIELDS = ["secrets", "communication", "inbound", "provider"];
    const grants = {};
    for (const [name, mod] of Object.entries(this.TOOLS)) {
      const grant = {};
      for (const field of GRANT_FIELDS) {
        if (mod.meta?.[field] !== undefined) grant[field] = mod.meta[field];
      }
      if (Object.keys(grant).length) grants[name] = grant;
    }
    return grants;
  }

  // ── Hook dispatch (scheduled entry point) ─────────────────

  async runScheduled() {
    // 1. Session lock — prevent overlapping sessions
    const active = await this.kvGet("kernel:active_session");
    if (active?.started_at) {
      const maxDuration = this.defaults?.session_budget?.max_duration_seconds
        || (await this.kvGet("config:defaults"))?.session_budget?.max_duration_seconds
        || 600;
      const ttl = maxDuration * 2 * 1000;
      const age = Date.now() - new Date(active.started_at).getTime();

      if (age < ttl) {
        // Session is still alive — bail out
        return;
      }

      // Stale marker — previous session is dead (platform kill / OOM)
      const history = await this.kvGet("kernel:last_sessions") || [];
      history.unshift({ id: active.id, outcome: "killed", ts: new Date().toISOString() });
      while (history.length > 5) history.pop();
      await this.kvWrite("kernel:last_sessions", history);
    }

    // 2. Acquire lock — write marker before any work
    await this.kvWrite("kernel:active_session", {
      id: this.sessionId,
      started_at: new Date().toISOString(),
    });

    // 3. Meta-safety check (3 consecutive crashes → signal governor + fallback)
    const hookSafe = await this.checkHookSafety();

    // 4. Execute hook or fallback
    if (hookSafe) {
      await this.executeHook();
    } else {
      await this.runFallbackSession();
    }
  }

  async checkHookSafety() {
    const history = await this.kvGet("kernel:last_sessions") || [];
    if (history.length < 3) return true;

    const last3 = history.slice(0, 3);
    const allBad = last3.every(s => s.outcome === "crash" || s.outcome === "killed");
    if (!allBad) return true;

    // Tripwire fires — signal governor to rollback
    await this.kvWrite("deploy:rollback_requested", {
      reason: "3_consecutive_crashes",
      last_sessions: last3,
      requested_at: new Date().toISOString(),
    });

    await this.karmaRecord({ event: "hook_safety_reset", last_sessions: last3 });
    await this.sendKernelAlert("hook_reset",
      "3 consecutive crashes detected. Signaled governor for rollback. Running minimal mode.");
    return false;
  }

  async executeHook() {
    let outcome = "clean";
    try {
      await this.runSession();
    } catch (err) {
      outcome = "crash";
      await this.karmaRecord({
        event: "hook_execution_error",
        error: err.message,
        stack: err.stack,
      });

      // Fall back to hardcoded minimal in same session
      await this.runMinimalFallback();
    }

    // Update session history
    await this.updateSessionOutcome(outcome);

    // Clean up active session marker
    await this.kv.delete("kernel:active_session");
  }

  // Session orchestration — timing, crash detection, dispatch to act or reflect
  async runSession() {
    await this.loadEagerConfig();
    const K = this.buildKernelInterface();

    let defaults = this.defaults;
    let modelsConfig = this.modelsConfig;
    let toolRegistry = this.toolRegistry;

    // Build shared state object passed to act/reflect
    const state = {
      defaults, modelsConfig, toolRegistry, sessionId: this.sessionId,
      async refreshDefaults() {
        state.defaults = await K.getDefaults();
        defaults = state.defaults;
      },
      async refreshModels() {
        state.modelsConfig = await K.getModelsConfig();
        modelsConfig = state.modelsConfig;
      },
      async refreshToolRegistry() {
        state.toolRegistry = await K.getToolRegistry();
        toolRegistry = state.toolRegistry;
      },
    };

    try {
      // 0. Load defaults early — needed for schedule check fallback
      defaults = await this.kvGet("config:defaults");
      this.defaults = defaults;
      state.defaults = defaults;

      // 1. Check if it's actually time to run a session
      const schedule = await this.kvGet("session_schedule");
      const nextSession = schedule?.next_session_after;
      if (!nextSession) {
        // No valid session time — policy code wrote bad data or first boot.
        // Fall back to default interval_seconds so we don't run every cron tick.
        const fallbackInterval = defaults?.schedule?.interval_seconds || 21600;
        const fallbackTime = new Date(Date.now() + fallbackInterval * 1000).toISOString();
        await this.kvWriteSafe("session_schedule", { ...schedule, next_session_after: fallbackTime, interval_seconds: fallbackInterval });
        return { skipped: true, reason: "not_time_yet", healed: true };
      }
      if (Date.now() < new Date(nextSession).getTime()) {
        return { skipped: true, reason: "not_time_yet" };
      }

      // 2. Crash detection
      const crashData = await this._detectCrash();

      // 3. Load ground truth
      const balances = await this.checkBalance({});
      const lastReflect = await this.kvGet("last_reflect");

      // 4. Merge with defaults
      const config = this.mergeDefaults(defaults, schedule);

      // 4a. Cache stable values
      modelsConfig = await this.kvGet("config:models");
      this.modelsConfig = modelsConfig;
      state.modelsConfig = modelsConfig;
      toolRegistry = await this.kvGet("config:tool_registry");
      this.toolRegistry = toolRegistry;
      state.toolRegistry = toolRegistry;

      // 5. Check if reflection is due
      const { highestReflectDepthDue } = this.HOOKS.reflect || {};
      const reflectDepth = highestReflectDepthDue
        ? await highestReflectDepthDue(K, state)
        : 0;

      // 6. Evaluate tripwires
      const effort = Kernel.evaluateTripwires(config, { balances });

      // 7. Load context keys
      const loadKeys = lastReflect?.next_act_context?.load_keys
        || defaults?.memory?.default_load_keys
        || [];
      const additionalContext = await this.loadKeys(
        loadKeys.filter(k => !k.startsWith("sealed:"))
      );

      // 7a. Drain inbox (unified event queue — chat messages, patron directives, job completions)
      const inboxItems = await this.drainInbox();

      // Extract patron DM from inbox for effort override (replaces patron:direct)
      const patronDM = inboxItems.find(i => i.type === "patron_direct");

      // 7b. Override effort for direct message sessions
      const effectiveEffort = patronDM
        ? (defaults?.act_after_dm?.effort || "high")
        : effort;

      // 7c. Load reflect schedules for all depths
      const maxReflectDepth = defaults?.execution?.max_reflect_depth || 1;
      const reflectSchedule = {};
      const sessionCount = await this.getSessionCount();
      for (let d = 1; d <= maxReflectDepth; d++) {
        const sched = await this.kvGet(`reflect:schedule:${d}`);
        if (sched) {
          const interval = sched.after_sessions
            || defaults?.deep_reflect?.default_interval_sessions || 20;
          reflectSchedule[d] = {
            last_ran: sched.last_reflect_session || 0,
            next_due: (sched.last_reflect_session || 0) + interval,
          };
        }
      }

      // 8. Build context
      const context = {
        balances, lastReflect, additionalContext,
        effort: effectiveEffort, reflectDepth,
        crashData,
        inbox: inboxItems,
        directMessage: patronDM?.message || null,
        reflectSchedule: Object.keys(reflectSchedule).length > 0 ? reflectSchedule : null,
        patronPlatforms: this.patronPlatforms || null,
      };

      // 9. Record session start + increment counter
      const count = await this.getSessionCount();
      await this.kvWriteSafe("session_counter", count + 1);
      const sessionIds = await this.kvGet("cache:session_ids") || [];
      sessionIds.push(this.sessionId);
      await this.kvWriteSafe("cache:session_ids", sessionIds);

      await this.karmaRecord({
        event: "session_start",
        session_id: this.sessionId,
        session_number: count + 1,
        effort,
        scheduled_at: schedule?.next_session_after || null,
        crash_detected: !!crashData,
        balances,
      });

      // 10. Run session or reflect
      if (reflectDepth > 0) {
        const { runReflect } = this.HOOKS.reflect || {};
        if (!runReflect) throw new Error("No runReflect in HOOKS.reflect");
        await runReflect(K, state, reflectDepth, context);
      } else {
        const { runAct } = this.HOOKS.act || {};
        if (!runAct) throw new Error("No runAct in HOOKS.act");
        await runAct(K, state, context, config);
      }

      // 11. Session bookkeeping — always runs regardless of act vs deep reflect
      const karma = this.karma;
      if (karma.length > 0) {
        const { summarizeKarma } = this.HOOKS.act || {};
        if (summarizeKarma) {
          await this.kvWriteSafe(`karma_summary:${this.sessionId}`, summarizeKarma(karma));
        }
      }

      // 12. Session end — clean bookend with final balances
      let endBalances;
      try { endBalances = await this.checkBalance({}); } catch {}
      await this.karmaRecord({
        event: "session_end",
        session_id: this.sessionId,
        session_cost: this.sessionCost,
        llm_calls: this.sessionLLMCalls,
        elapsed_ms: this.elapsed(),
        ...(endBalances ? { balances: endBalances } : {}),
      });

      return { ok: true };

    } catch (err) {
      await this.karmaRecord({
        event: "fatal_error",
        error: err.message,
        stack: err.stack,
      });
      return { ok: false, error: err.message };
    }
  }

  // ── Crash detection ───────────────────────────────────────

  async _detectCrash() {
    // The active_session marker is always the current session at this point
    // (written by runScheduled before runSession). Crash detection for dead
    // sessions is now handled in runScheduled's lock check, which records
    // killed sessions in kernel:last_sessions before we get here.
    // This method now just checks if a killed session was recorded.
    const history = await this.kvGet("kernel:last_sessions") || [];
    const lastKilled = history.find(s => s.outcome === "killed");
    if (!lastKilled) return null;

    const deadKarma = await this.kvGet(`karma:${lastKilled.id}`);
    return {
      dead_session_id: lastKilled.id,
      karma: deadKarma,
      last_entry: Array.isArray(deadKarma) ? deadKarma[deadKarma.length - 1] : null,
    };
  }

  // ── Tripwire evaluation ───────────────────────────────────

  static evaluateTripwires(config, liveData) {
    const alerts = config.alerts || [];
    let effort = config.default_effort || config.schedule?.default_effort || "low";
    for (const alert of alerts) {
      const value = alert.field.split(".").reduce((o, k) => o?.[k], liveData) ?? null;
      if (value === null) continue;
      let fired = false;
      switch (alert.condition) {
        case "below": fired = value < alert.value; break;
        case "above": fired = value > alert.value; break;
        case "equals": fired = value === alert.value; break;
        case "changed": fired = true; break;
      }
      if (fired && alert.override_effort) {
        const levels = ["low", "medium", "high", "xhigh"];
        if (levels.indexOf(alert.override_effort) > levels.indexOf(effort)) {
          effort = alert.override_effort;
        }
      }
    }
    return effort;
  }

  // ── Config utility methods (used by both act.js and reflect.js) ──

  static getMaxSteps(state, role, depth) {
    const { defaults } = state;
    if (role === 'act') return defaults?.execution?.max_steps?.act || 12;
    const perLevel = defaults?.reflect_levels?.[depth];
    if (perLevel?.max_steps) return perLevel.max_steps;
    return depth === 1
      ? (defaults?.execution?.max_steps?.reflect || 5)
      : (defaults?.execution?.max_steps?.deep_reflect || 10);
  }

  static getReflectModel(state, depth) {
    const { defaults } = state;
    const perLevel = defaults?.reflect_levels?.[depth];
    if (perLevel?.model) return perLevel.model;
    return defaults?.deep_reflect?.model || defaults?.act?.model;
  }

  async updateSessionOutcome(outcome) {
    const history = await this.kvGet("kernel:last_sessions") || [];
    history.unshift({ id: this.sessionId, outcome, ts: new Date().toISOString() });
    while (history.length > 5) history.pop();
    await this.kvWrite("kernel:last_sessions", history);
  }

  async runMinimalFallback() {
    await this.sendKernelAlert("hook_reset",
      "Hook execution failed. Running minimal recovery mode.");

    const hardcodedPrompt = `You are Swayambhu in recovery mode. Your session hook has been reset due to repeated failures. Check your balances and report your status. Do not attempt complex operations.`;

    await this.loadEagerConfig();
    this.defaults = { session_budget: { max_cost: 0.50, max_duration_seconds: 120 } };
    await this.karmaRecord({ event: "session_start", mode: "recovery" });

    const tools = this.buildToolDefinitions();
    const fallbackModel = await this.getFallbackModel();
    if (!fallbackModel) throw new Error("No fallback model configured");
    const model = this.resolveModel(fallbackModel);

    try {
      await this.runAgentLoop({
        systemPrompt: hardcodedPrompt,
        initialContext: "Recovery mode. Check balances and report status.",
        tools,
        model,
        effort: "low",
        maxTokens: 1000,
        maxSteps: 3,
        step: "recovery",
      });
      // Don't process kv_operations — discard them
    } catch (err) {
      await this.karmaRecord({
        event: "recovery_error",
        error: err.message,
      });
    }

    // Write session counter via internal kvWrite
    const count = await this.getSessionCount();
    await this.kvWrite("session_counter", count + 1);
  }

  // ── Session cycle ───────────────────────────────────────────

  // ── Minimal fallback (no hook code in KV) ───────────────────
  // Used when no hook is loaded, or after the hook safety tripwire fires.
  // Runs a hardcoded recovery session — does NOT load prompt:act
  // (could be corrupted). Does NOT process kv_operations from output.

  async runFallbackSession() {
    await this.runMinimalFallback();
    await this.updateSessionOutcome("clean");
  }

  // ── Actions (dynamic tools) ─────────────────────────────────

  async executeAction(step) {
    const toolName = step.tool;

    // Load tool code + meta (platform-specific, overridable)
    const { meta, moduleCode } = await this._loadTool(toolName);

    // Communication tools require gate approval — cannot be called via RPC directly
    // Gate classification comes from kernel:tool_grants (immutable to agent), not meta
    const grant = this.toolGrants?.[toolName];
    if (grant?.communication && !this._commsGateApproved) {
      return { error: 'Communication tools require gate approval — cannot call executeAction directly' };
    }

    // Build sandboxed context based on function metadata
    const ctx = await this.buildToolContext(toolName, meta || {}, step.input || {});

    // Record pre-execution in karma (this is the crash breadcrumb)
    await this.karmaRecord({
      event: "tool_start",
      tool: toolName,
      step_id: step.id,
      input_summary: step.input || {},
    });

    // Execute (platform-specific, overridable)
    try {
      const result = await this._executeTool(toolName, moduleCode, meta, ctx);

      // Record success
      await this.karmaRecord({
        event: "tool_complete",
        tool: toolName,
        step_id: step.id,
        ok: true,
        result_summary: result,
      });

      return result;
    } catch (err) {
      await this.karmaRecord({
        event: "tool_complete",
        tool: toolName,
        step_id: step.id,
        ok: false,
        error: err.message,
      });
      throw err;
    }
  }

  async executeAdapter(adapterKey, input, secretOverrides) {
    const mod = this.PROVIDERS[adapterKey];
    if (!mod) throw new Error(`Unknown adapter: ${adapterKey}`);

    // Providers inject secrets from their own meta.secrets, not from toolGrants
    const secrets = {};
    for (const name of (mod.meta?.secrets || [])) {
      if (this.env[name] !== undefined) secrets[name] = this.env[name];
    }
    for (const name of (mod.meta?.kv_secrets || [])) {
      const val = await this.kvGet(`secret:${name}`);
      if (val !== null) secrets[name] = val;
    }
    if (secretOverrides) Object.assign(secrets, secretOverrides);

    const ctx = { ...input, secrets, fetch: (...args) => fetch(...args) };
    const fn = mod.execute || mod.call || mod.check;
    if (!fn) throw new Error(`Adapter ${adapterKey} has no callable function`);
    return fn(ctx);
  }

  async checkBalance(args) {
    const [providers, wallets] = await Promise.all([
      this.kvGet("providers"),
      this.kvGet("wallets"),
    ]);

    const results = { providers: {}, wallets: {} };
    const scopeFilter = args?.scope;

    for (const [name, config] of Object.entries(providers || {})) {
      if (!config.adapter) continue;
      const scope = config.scope || "general";
      if (scopeFilter && scope !== scopeFilter) continue;
      try {
        const val = await this.executeAdapter(config.adapter, {}, await this._resolveSecretOverrides(config));
        results.providers[name] = { balance: val, scope };
      } catch (e) {
        results.providers[name] = { balance: null, scope, error: e.message };
      }
    }

    for (const [name, config] of Object.entries(wallets || {})) {
      if (!config.adapter) continue;
      const scope = config.scope || "general";
      if (scopeFilter && scope !== scopeFilter) continue;
      try {
        const val = await this.executeAdapter(config.adapter, {}, await this._resolveSecretOverrides(config));
        results.wallets[name] = { balance: val, scope };
      } catch (e) {
        results.wallets[name] = { balance: null, scope, error: e.message };
      }
    }

    return results;
  }

  // ── Patron identity verification ────────────────────────────

  async verifyPatronSignature(message, signatureBase64) {
    const pubKeyStr = await this.kvGet("patron:public_key");
    if (!pubKeyStr) throw new Error("No patron public key configured");
    const rawPubKey = Kernel.parseSSHEd25519(pubKeyStr);
    const key = await crypto.subtle.importKey(
      "raw", rawPubKey, { name: "Ed25519" }, false, ["verify"],
    );
    const sigBytes = Uint8Array.from(atob(signatureBase64), c => c.charCodeAt(0));
    const msgBytes = new TextEncoder().encode(message);
    return crypto.subtle.verify("Ed25519", key, sigBytes, msgBytes);
  }

  async verifyPatron(args) {
    if (!args.message || !args.signature) {
      return { error: "Both message and signature are required", verified: false };
    }
    try {
      const verified = await this.verifyPatronSignature(args.message, args.signature);
      await this.karmaRecord({
        event: verified ? "patron_verified" : "patron_verification_failed",
        message: args.message,
      });
      return { verified };
    } catch (e) {
      return { error: e.message, verified: false };
    }
  }

  async rotatePatronKey(newPublicKey, signatureBase64) {
    const canonicalMessage = `rotate:${newPublicKey}`;
    const valid = await this.verifyPatronSignature(canonicalMessage, signatureBase64);
    if (!valid) throw new Error("Invalid signature — rotation rejected");

    // Validate the new key parses correctly
    Kernel.parseSSHEd25519(newPublicKey);

    // Write directly to KV binding — bypasses kvWrite immutability guard
    await this.kv.put("patron:public_key", newPublicKey, {
      metadata: {
        type: "identity", format: "text",
        updated_at: new Date().toISOString(),
        rotated_by: "kernel:rotatePatronKey",
      },
    });

    await this.karmaRecord({
      event: "patron_key_rotated",
      new_key_prefix: newPublicKey.slice(0, 30) + "...",
    });

    await this.sendKernelAlert("patron_key_rotated",
      `Patron public key rotated in session ${this.sessionId}`);

    return { rotated: true };
  }

  // Resolve secret overrides from provider config
  // Supports "kv:secret:key_name" values that read from KV
  async _resolveSecretOverrides(config) {
    if (!config.secrets) return null;
    const resolved = {};
    for (const [key, val] of Object.entries(config.secrets)) {
      if (typeof val === 'string' && val.startsWith('kv:')) {
        resolved[key] = await this.kvGet(val.slice(3));
      } else {
        resolved[key] = val;
      }
    }
    return resolved;
  }

  // Load tool module from statically compiled TOOLS
  async _loadTool(toolName) {
    const mod = this.TOOLS[toolName];
    if (!mod) throw new Error(`Unknown tool: ${toolName}`);
    // Strip grant fields — kernel reads these from toolGrants, not meta
    const { secrets, communication, inbound, provider, ...operationalMeta } = mod.meta || {};
    return { meta: operationalMeta, moduleCode: null };
  }

  // Execute tool function directly (no isolate)
  async _executeTool(toolName, moduleCode, meta, ctx) {
    ctx.fetch = (...args) => fetch(...args);

    if (meta.kv_access && meta.kv_access !== "none") {
      ctx.kv = this._buildScopedKV(toolName, meta.kv_access, meta.kv_write_prefixes);
    }
    // Provider binding comes from grants (kernel-controlled), not meta
    const grant = this.toolGrants?.[toolName];
    if (grant?.provider) {
      ctx.provider = this.PROVIDERS[`provider:${grant.provider}`];
    }

    const fn = this.TOOLS[toolName].execute || this.TOOLS[toolName].call || this.TOOLS[toolName].check;
    if (!fn) throw new Error(`Tool ${toolName} has no callable function`);
    return fn(ctx);
  }

  async buildToolContext(toolName, meta, input) {
    // Scoped secrets from two tiers:
    // 1. env secrets — gated by kernel:tool_grants (kernel-only, agent can't modify)
    // 2. KV secrets (Swayambhu-provisioned, stored at secret:{name})
    const secrets = {};
    const grant = this.toolGrants?.[toolName];
    const allowedEnvSecrets = grant?.secrets || [];
    for (const secretName of allowedEnvSecrets) {
      if (this.env[secretName] !== undefined) {
        secrets[secretName] = this.env[secretName];
      }
    }
    for (const secretName of (meta.kv_secrets || [])) {
      const val = await this.kvGet(`secret:${secretName}`);
      if (val !== null) secrets[secretName] = val;
    }

    // kv and fetch are handled by the ES module itself (env.KV_BRIDGE, globalThis.fetch)
    return { ...input, secrets, config: this.defaults };
  }

  // ── Scoped KV wrapper (replaces Worker Loader ScopedKV RPC) ───

  _buildScopedKV(toolName, kvAccess, writePrefixes = []) {
    const kv = this.kv;
    const scope = `tooldata:${toolName}:`;
    return {
      async get(key) {
        const resolved = kvAccess === "own" ? `${scope}${key}` : key;
        if (resolved.startsWith('sealed:')) return null;
        try { return await kv.get(resolved, "json"); }
        catch { try { return await kv.get(resolved, "text"); } catch { return null; } }
      },
      async put(key, value) {
        // Allow writes to declared prefixes (e.g., job:, job_result:) without scoping
        const allowedPrefix = writePrefixes.find(p => key.startsWith(p));
        const resolved = allowedPrefix ? key : `${scope}${key}`;
        const fmt = typeof value === "string" ? "text" : "json";
        await kv.put(resolved, typeof value === "string" ? value : JSON.stringify(value), {
          metadata: { type: allowedPrefix ? "job" : "tooldata", format: fmt, updated_at: new Date().toISOString() },
        });
      },
      async list(opts = {}) {
        if (kvAccess === "own") {
          const result = await kv.list({ ...opts, prefix: scope + (opts.prefix || "") });
          return {
            keys: result.keys.map(k => ({ ...k, name: k.name.slice(scope.length) })),
            list_complete: result.list_complete,
          };
        }
        const result = await kv.list(opts);
        return {
          keys: result.keys.filter(k => !k.name.startsWith('sealed:')),
          list_complete: result.list_complete,
        };
      },
    };
  }

  // ── LLM calls (dynamic provider with cascade fallback) ─────

  async callLLM({ model, effort, maxTokens, systemPrompt, messages, tools, step, budgetCap }) {
    const budget = this.defaults?.session_budget;
    const costLimit = budgetCap ?? (this.mode === 'chat' ? null : budget?.max_cost);
    if (costLimit && this.sessionCost >= costLimit)
      throw new Error("Budget exceeded: cost");
    if (budget?.max_duration_seconds && this.elapsed() > budget.max_duration_seconds * 1000)
      throw new Error("Budget exceeded: duration");

    const startMs = Date.now();

    // Kernel-enforced dharma injection — no hook or prompt modification can bypass this
    const dharmaPrefix = this.dharma ? `[DHARMA]\n${this.dharma}\n[/DHARMA]\n\n` : '';

    // Kernel-enforced yama/niyama injection — mutable but always present
    let principlesBlock = '';
    if (this.yamas && Object.keys(this.yamas).length > 0) {
      const yamaEntries = Object.entries(this.yamas)
        .map(([key, text]) => {
          const name = key.replace('yama:', '');
          return `[${name}]\n${text}\n[/${name}]`;
        }).join('\n');
      principlesBlock += `[YAMAS]\n${yamaEntries}\n[/YAMAS]\n\n`;
    }
    if (this.niyamas && Object.keys(this.niyamas).length > 0) {
      const niyamaEntries = Object.entries(this.niyamas)
        .map(([key, text]) => {
          const name = key.replace('niyama:', '');
          return `[${name}]\n${text}\n[/${name}]`;
        }).join('\n');
      principlesBlock += `[NIYAMAS]\n${niyamaEntries}\n[/NIYAMAS]\n\n`;
    }

    const fullSystemPrompt = systemPrompt
      ? dharmaPrefix + principlesBlock + systemPrompt
      : (dharmaPrefix + principlesBlock) || null;

    // Build messages array, prepending system prompt if provided
    const msgs = fullSystemPrompt
      ? [{ role: "system", content: fullSystemPrompt }, ...messages]
      : [...messages];

    // Resolve model family + check reasoning support
    const modelInfo = this.modelsConfig?.models?.find(
      m => m.id === model || m.alias === model
    );
    const family = modelInfo?.family || null;
    const resolvedEffort = (effort && effort !== "none" && modelInfo?.supports_reasoning)
      ? effort : null;

    // Standardized request — provider adapter translates this
    const request = {
      model,
      max_tokens: maxTokens || 1000,
      messages: msgs,
      family,
      effort: resolvedEffort,
      ...(tools?.length ? { tools } : {}),
    };

    // Try cascade: dynamic adapter → last working → hardcoded fallback
    const result = await this.callWithCascade(request, step);
    const durationMs = Date.now() - startMs;

    if (!result.ok) {
      await this.karmaRecord({
        event: "llm_call",
        step, model, effort,
        ok: false,
        error: result.error,
        duration_ms: durationMs,
        provider_tier: result.tier,
      });

      // Model fallback (separate from provider fallback)
      const fallbackModel = await this.getFallbackModel();
      if (fallbackModel && model !== fallbackModel) {
        return this.callLLM({ model: fallbackModel, effort: "low", maxTokens,
          systemPrompt, messages, tools, step, budgetCap });
      }
      throw new Error(`LLM call failed on all providers: ${result.error}`);
    }

    let cost = this.estimateCost(model, result.usage);
    if (cost === null) {
      const models = this.modelsConfig?.models || [];
      const maxInput = models.length ? Math.max(...models.map(m => m.input_cost_per_mtok)) : 10;
      const maxOutput = models.length ? Math.max(...models.map(m => m.output_cost_per_mtok)) : 30;
      cost = ((result.usage.prompt_tokens || 0) * maxInput
        + (result.usage.completion_tokens || 0) * maxOutput) / 1_000_000;
      await this.karmaRecord({
        event: "warning",
        message: `Model "${model}" not in config:models — using pessimistic cost estimate ($${cost.toFixed(6)})`,
        step,
      });
    }

    await this.karmaRecord({
      event: "llm_call",
      step, model, effort,
      ok: true,
      duration_ms: durationMs,
      provider_tier: result.tier,
      in_tokens: result.usage.prompt_tokens,
      out_tokens: result.usage.completion_tokens,
      thinking_tokens: result.usage.thinking_tokens || 0,
      cost,
      ...(result.finish_reason === "length" ? { truncated: true } : {}),
      response: result.content || null,
      tool_calls: result.toolCalls || [],
      tools_available: tools?.map(t => ({ name: t.function?.name, description: t.function?.description })) || [],
    });

    this.sessionCost += cost;
    this.sessionLLMCalls++;
    this.lastCallModel = model;

    return { content: result.content, usage: result.usage, cost, toolCalls: result.toolCalls, finish_reason: result.finish_reason };
  }

  async callWithCascade(request, step) {
    // Tier 1: Compiled LLM provider (statically imported)
    try {
      const mod = this.PROVIDERS['provider:llm'];
      if (!mod) throw new Error("No LLM provider compiled");
      const fn = mod.call || mod.execute;
      if (!fn) throw new Error("LLM provider has no call/execute function");

      const secrets = {};
      for (const name of (mod.meta?.secrets || [])) {
        if (this.env[name] !== undefined) secrets[name] = this.env[name];
      }

      const result = await fn({ ...request, secrets, fetch: (...args) => fetch(...args) });
      if (!result || (typeof result.content !== "string" && !result.toolCalls?.length)) {
        throw new Error("Provider returned invalid response — missing content and tool calls");
      }
      return { ...result, ok: true, tier: "compiled" };
    } catch (err) {
      await this.karmaRecord({
        event: "provider_fallback",
        from: "compiled",
        to: "hardcoded",
        error: err.message,
      });
    }

    // Tier 2: Hardcoded direct OpenRouter call (nuclear fallback)
    try {
      const result = await this._hardcodedLLMFallback(request, step);
      return result;
    } catch (err) {
      return { ok: false, error: err.message, tier: "all_failed" };
    }
  }

  // Minimal direct OpenRouter call — no provider module dependency
  async _hardcodedLLMFallback(request, step) {
    const body = {
      model: request.model,
      max_tokens: request.max_tokens,
      messages: request.messages,
    };
    if (request.effort) body.reasoning = { effort: request.effort };
    if (request.tools?.length) body.tools = request.tools;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    let resp, data;
    try {
      resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Authorization": `Bearer ${this.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      data = await resp.json();
    } finally {
      clearTimeout(timeout);
    }

    if (!resp.ok || data.error) {
      throw new Error(JSON.stringify(data.error || data));
    }

    const choice = data.choices?.[0];
    const msg = choice?.message;
    const usage = data.usage || {};
    return {
      ok: true,
      content: msg?.content || "",
      usage,
      toolCalls: msg?.tool_calls || null,
      finish_reason: choice?.finish_reason || null,
      tier: "hardcoded",
    };
  }

  // ── Agent loop (tool-calling execution primitive) ──────────

  buildToolDefinitions(extraTools = []) {
    const registry = this.toolRegistry || { tools: [] };
    const defs = registry.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(
            Object.entries(t.input || {}).map(([k, v]) => [k, { type: 'string', description: String(v) }])
          ),
        },
      },
    }));

    // Built-in: spawn a nested agent loop
    defs.push({
      type: 'function',
      function: {
        name: 'spawn_subplan',
        description: 'Spawn a nested agent to handle an independent sub-task. Multiple spawn_subplan calls in one turn execute in parallel.',
        parameters: {
          type: 'object',
          properties: {
            goal: { type: 'string', description: 'What the subplan should achieve' },
            model: { type: 'string', description: 'Model alias from config:models (e.g. opus, sonnet, haiku)' },
            max_steps: { type: 'number', description: 'Max turns (default: 5)' },
          },
          required: ['goal'],
        },
      },
    });

    // Built-in: verify patron identity via Ed25519 signature
    defs.push({
      type: 'function',
      function: {
        name: 'verify_patron',
        description: 'Verify the patron\'s identity by checking an Ed25519 signature against the patron public key. Use when you need to confirm someone is really the patron (e.g. after noticing unusual behavior).',
        parameters: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'The exact message that was signed' },
            signature: { type: 'string', description: 'Base64-encoded Ed25519 signature' },
          },
          required: ['message', 'signature'],
        },
      },
    });

    return [...defs, ...extraTools];
  }

  async executeToolCall(toolCall) {
    const name = toolCall.function.name;
    let args;
    try {
      args = typeof toolCall.function.arguments === 'string'
        ? JSON.parse(toolCall.function.arguments)
        : toolCall.function.arguments || {};
    } catch {
      return { error: `Invalid JSON in tool arguments for ${name}` };
    }

    if (name === 'spawn_subplan') {
      return this.spawnSubplan(args);
    }

    if (name === 'verify_patron') {
      return this.verifyPatron(args);
    }

    if (name === 'check_balance') {
      return this.checkBalance(args);
    }

    // ── Load tool meta + grants (shared by comms gate + inbound gate) ──
    const { meta: toolMeta } = await this._loadTool(name).catch(() => ({ meta: null }));
    const toolGrant = this.toolGrants?.[name] || {};

    // ── Communication gate (kernel-enforced) ──────────────────
    // Gate classification comes from kernel:tool_grants (immutable to agent), not meta.
    // The agent cannot bypass the gate by modifying tool:*:meta in KV.
    let isCommsTool = false;
    {
      const commGrant = toolGrant.communication;
      if (commGrant) {
        isCommsTool = true;
        // Build a meta-like object from grants for the gate methods
        const commMeta = { communication: commGrant };
        const gateResult = await this.communicationGate(name, args, commMeta);

        if (gateResult.verdict === 'block' || gateResult.verdict === 'queue' || gateResult.verdict === 'hold') {
          await this.queueBlockedComm(name, args, commMeta, gateResult.reasoning, gateResult);
          const label = gateResult.verdict === 'hold' ? 'held for next session'
            : gateResult.verdict === 'queue' ? 'queued for review' : 'blocked';
          return { error: `Communication ${label}: ${gateResult.reasoning}` };
        }

        if (gateResult.verdict === 'revise' && gateResult.revision?.text) {
          const cf = commGrant.content_field;
          if (cf && args[cf] !== undefined) args[cf] = gateResult.revision.text;
          await this.karmaRecord({
            event: 'comms_revised', tool: name,
            recipient: this.resolveRecipient(args, commMeta),
            reasoning: gateResult.reasoning,
          });
        }

        if (gateResult.verdict === 'send') {
          await this.karmaRecord({
            event: 'comms_approved', tool: name,
            recipient: this.resolveRecipient(args, commMeta),
            reasoning: gateResult.reasoning,
          });
        }
      }
    }
    // ── End communication gate ────────────────────────────────

    // Pre-validation hook
    const schema = this.toolRegistry?.tools?.find(t => t.name === name)?.input;
    const preCheck = await this.callHook('validate', { tool: name, args, schema });
    if (preCheck && !preCheck.ok) {
      await this.karmaRecord({ event: "hook_rejected", hook: "validate", tool: name, error: preCheck.error });
      return { error: preCheck.error };
    }
    if (preCheck?.args) args = preCheck.args;

    // Set gate approval flag so executeAction allows communication tools
    if (isCommsTool) this._commsGateApproved = true;
    try {
      let result = await this.executeAction({
        tool: name,
        input: args,
        id: toolCall.id,
      });

      // Post-validation hook
      const postCheck = await this.callHook('validate_result', { tool: name, args, result });
      if (postCheck && !postCheck.ok) {
        await this.karmaRecord({ event: "hook_rejected", hook: "validate_result", tool: name, error: postCheck.error });
        return { error: postCheck.error };
      }

      // ── Inbound content gate (kernel-enforced) ──────────────────
      // Gate classification comes from kernel:tool_grants (immutable to agent).
      // Tools with inbound grants return external messages. The kernel
      // redacts content from unknown senders and quarantines it under
      // sealed:* keys (unreadable by agent, visible to patron via dashboard).
      {
        const inboundGrant = toolGrant.inbound;
        if (inboundGrant && result && !result.error) {
          const { channel, sender_field, content_field, result_array } = inboundGrant;
          const items = result[result_array];
          if (Array.isArray(items)) {
            for (const item of items) {
              const senderId = item[sender_field];
              if (!senderId) continue;
              const contact = await this.resolveContact(channel, senderId);
              if (!contact || !contact.approved) {
                const reason = !contact ? 'unknown sender' : 'unapproved sender';
                const ts = Date.now();
                const quarantineKey = `sealed:quarantine:${channel}:${encodeURIComponent(senderId)}:${ts}`;
                await this.kvWrite(quarantineKey, {
                  sender: senderId,
                  content: item[content_field],
                  tool: name,
                  reason,
                  timestamp: new Date(ts).toISOString(),
                  ...(item.subject ? { subject: item.subject } : {}),
                  ...(item.from ? { from: item.from } : {}),
                });
                item[content_field] = `[content redacted — ${reason}]`;
                await this.karmaRecord({
                  event: 'inbound_redacted', sender_id: senderId, channel,
                  quarantine_key: quarantineKey,
                });
              }
            }
          }
        }
      }
      // ── End inbound content gate ────────────────────────────────

      // ── Chat seeding (outbound Slack DMs seed conversation state) ──
      // When send_slack targets a DM channel, seed the chat object so
      // the agent's outbound message appears in conversation history
      // and the recipient's reply has full context.
      if (name === 'send_slack' && result && !result.error && result.ok) {
        const targetChannel = args.channel || this.env.SLACK_CHANNEL_ID;
        // Only seed chat for DMs (user ID starts with U)
        if (targetChannel && targetChannel.startsWith('U')) {
          try {
            const chatKey = `chat:slack:${targetChannel}`;
            const conv = await this.kvGet(chatKey) || {
              messages: [],
              karma: [],
              total_cost: 0,
              created_at: new Date().toISOString(),
              turn_count: 0,
            };
            conv.messages.push({
              role: "assistant",
              content: args.text,
              source_session: this.sessionId,
              ts: new Date().toISOString(),
            });
            if (!conv.source_session) {
              conv.source_session = this.sessionId;
            }
            conv.last_activity = new Date().toISOString();
            await this.kvWriteSafe(chatKey, conv);
          } catch (err) {
            // Non-fatal — chat seeding failure shouldn't break the tool call
            await this.karmaRecord({ event: "chat_seed_error", tool: name, error: err.message });
          }
        }
      }
      // ── End chat seeding ──────────────────────────────────────────

      return result;
    } finally {
      if (isCommsTool) this._commsGateApproved = false;
    }
  }

  async callHook(hookName, ctx) {
    const mod = this.TOOLS[hookName];
    if (!mod) return null;  // hook tool not compiled in — degrade gracefully

    try {
      const hookCtx = await this.buildToolContext(hookName, mod.meta || {}, ctx);
      hookCtx.fetch = (...args) => fetch(...args);
      const fn = mod.execute || mod.call || mod.check;
      if (!fn) return null;
      return await fn(hookCtx);
    } catch (err) {
      await this.karmaRecord({ event: "hook_error", hook: hookName, error: err.message });
      return null;  // broken hook degrades to no hook, not crash
    }
  }

  async spawnSubplan(args, depth = 0) {
    const maxDepth = this.defaults?.execution?.max_subplan_depth || 3;
    if (depth >= maxDepth) {
      return { error: `Subplan depth limit (${maxDepth}) reached`, goal: args.goal };
    }

    const subplanPrompt = await this.kvGet("prompt:subplan") || this.defaultSubplanPrompt();
    const requestedModel = args.model || await this.getFallbackModel() || 'haiku';
    const model = this.resolveModel(requestedModel);
    if (model === requestedModel && !requestedModel.includes('/')) {
      const validAliases = Object.keys(this.modelsConfig?.alias_map || {});
      return { error: `Unknown model alias: "${requestedModel}". Valid aliases: ${validAliases.join(', ')}` };
    }
    const maxSteps = args.max_steps || 5;

    const builtPrompt = this.buildPrompt(subplanPrompt, {
      goal: args.goal,
      maxSteps,
      maxCost: args.max_cost || 0.05,
      executorModel: args.model || 'haiku',
    });

    // Subplan tools: same as parent
    const tools = this.buildToolDefinitions();

    return this.runAgentLoop({
      systemPrompt: builtPrompt,
      initialContext: `Execute this goal: ${args.goal}`,
      tools,
      model,
      effort: args.effort || 'low',
      maxTokens: args.max_output_tokens || 1000,
      maxSteps,
      step: `subplan_d${depth}`,
    });
  }

  async runAgentLoop({ systemPrompt, initialContext, tools, model, effort,
                       maxTokens, maxSteps, step, budgetCap }) {
    const messages = [];
    if (initialContext) {
      const content = typeof initialContext === 'string'
        ? initialContext
        : JSON.stringify(initialContext);
      messages.push({ role: 'user', content });
    }

    let parseRetried = false;
    let softWarned = false;

    // Budget limit config — resolve role from step name
    const role = step.startsWith('reflect_depth_') ? 'deep_reflect'
      : step === 'act' ? 'act'
      : null;
    const roleConfig = role ? this.defaults?.[role] : null;
    const softPct = roleConfig?.budget_soft_limit_pct ?? 0.75;
    const hardPct = roleConfig?.budget_hard_limit_pct ?? 0.90;
    const costLimit = budgetCap ?? this.defaults?.session_budget?.max_cost;

    try {
      for (let i = 0; i < maxSteps; i++) {
        // ── Budget soft/hard limits ──────────────────────────────
        if (costLimit && role) {
          const usedPct = this.sessionCost / costLimit;

          // Hard limit — strip tools, force final output
          if (usedPct >= hardPct) {
            messages.push({ role: 'user', content:
              'Budget hard limit reached. Produce your final JSON output NOW. No more tool calls.' });
            const finalResp = await this.callLLM({
              model, effort, maxTokens, systemPrompt, messages,
              step: `${step}_budget_final`, budgetCap,
            });
            return await this.parseAgentOutput(finalResp.content);
          }

          // Soft limit — warn once, tools still available
          if (!softWarned && usedPct >= softPct) {
            messages.push({ role: 'user', content:
              'Budget is running low. Finish your exploration and produce your final output soon.' });
            softWarned = true;
          }
        }

        const response = await this.callLLM({
          model, effort, maxTokens,
          systemPrompt, messages, tools,
          step: `${step}_turn_${i}`, budgetCap,
        });

        if (response.toolCalls?.length) {
          // Add assistant message with tool calls
          messages.push({
            role: 'assistant',
            content: response.content || null,
            tool_calls: response.toolCalls,
          });

          // Execute tools in parallel
          const results = await Promise.all(
            response.toolCalls.map(tc => this.executeToolCall(tc)
              .catch(err => ({ error: err.message })))
          );

          // Add tool result messages (one per tool call)
          for (let j = 0; j < response.toolCalls.length; j++) {
            messages.push({
              role: 'tool',
              tool_call_id: response.toolCalls[j].id,
              content: JSON.stringify(results[j]),
            });
          }
          continue;
        }

        // No tool calls — final output
        const parsed = await this.parseAgentOutput(response.content);
        if (parsed.parse_error && !parseRetried) {
          parseRetried = true;
          messages.push(
            { role: 'assistant', content: response.content },
            { role: 'user', content: 'Your output was not valid JSON. Respond with only a valid JSON object.' }
          );
          continue;  // burns one step, loop retries once
        }
        return parsed;
      }

      // Max steps reached — force final output (no tools, forces text)
      messages.push({ role: 'user', content: 'Maximum steps reached. Produce your final output now.' });
      const finalResponse = await this.callLLM({
        model, effort, maxTokens, systemPrompt, messages,
        step: `${step}_final`, budgetCap,
      });
      return await this.parseAgentOutput(finalResponse.content);

    } catch (err) {
      if (err.message.startsWith("Budget exceeded")) {
        await this.karmaRecord({ event: "budget_exceeded", reason: err.message, step });
        return { budget_exceeded: true, reason: err.message };
      }
      throw err;
    }
  }

  async parseAgentOutput(content) {
    if (!content) return {};
    try { return JSON.parse(content); }
    catch {
      // Try extracting JSON from markdown fences or surrounding prose
      const extracted = this._extractJSON(content);
      if (extracted) return extracted;

      const repaired = await this.callHook('parse_repair', { content });
      if (repaired?.content) {
        try { return JSON.parse(repaired.content); }
        catch { /* fall through */ }
      }
      return { parse_error: true, raw: content };
    }
  }

  _extractJSON(content) {
    if (!content || typeof content !== "string") return null;
    // Strip markdown code fences
    const fenceMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) {
      try { return JSON.parse(fenceMatch[1].trim()); }
      catch { /* fall through */ }
    }
    // Find outermost { } or [ ]
    const found = this._findBraces(content, "{", "}");
    if (found) {
      try { return JSON.parse(found); }
      catch { /* no valid JSON */ }
    }
    return null;
  }

  _findBraces(text, open, close) {
    const start = text.indexOf(open);
    if (start === -1) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === open) depth++;
      else if (ch === close && --depth === 0) return text.slice(start, i + 1);
    }
    return null;
  }

  // ── Helpers ─────────────────────────────────────────────────

  async kvGet(key) {
    try {
      const val = await this.kv.get(key, "json");
      return val;
    } catch {
      try {
        return await this.kv.get(key, "text");
      } catch {
        return null;
      }
    }
  }

  // Returns { value, metadata } using KV's native metadata slot.
  // Value is returned as raw text (not JSON-parsed).
  async kvGetWithMeta(key) {
    try {
      return await this.kv.getWithMetadata(key, "text");
    } catch {
      return { value: null, metadata: null };
    }
  }

  async kvWrite(key, value, metadata = {}) {
    // Protect immutable keys
    if (key === "dharma" || Kernel.IMMUTABLE_KEYS.includes(key)) {
      throw new Error(`Cannot write "${key}" — immutable key`);
    }

    // System keys cannot be marked unprotected
    if (Kernel.isSystemKey(key)) delete metadata.unprotected;

    // Auto-tag: guarantee every key has at minimum a type based on prefix
    const prefix = key.split(":")[0];
    const fmt = typeof value === "string" ? "text" : "json";
    const defaults = {
      providers:  { type: "config", format: "json" },
      wallets:    { type: "config", format: "json" },
      tool:       { type: "tool", runtime: "worker", format: "text" },
      provider:   { type: "provider", runtime: "worker", format: "text" },
      karma:      { type: "log", format: "json" },
      prompt:     { type: "prompt", format: "text" },
      config:     { type: "config", format: "json" },
      dharma:     { type: "core", immutable: true, format: "text" },
      secret:     { type: "secret", format: "json" },
      session:    { type: "session", format: "json" },
      tooldata:   { type: "tooldata", format: fmt },
      reflect:    { type: "reflect_output", format: "json" },
      hook:       { type: "hook", format: "text" },
      doc:        { type: "doc", format: "text" },
      proposal:   { type: "proposal", format: "json" },
      upaya:     { type: "wisdom", format: "json" },
      prajna:     { type: "wisdom", format: "json" },
      kernel:     { type: "kernel", format: "json" },
      sealed:     { type: "sealed", format: "json" },
      yama:       { type: "yama", format: "text" },
      niyama:     { type: "niyama", format: "text" },
      comms_blocked: { type: "comms", format: "json" },
    };
    const finalMetadata = {
      ...defaults[prefix],
      ...metadata,  // caller can override/extend
      updated_at: new Date().toISOString(),
    };

    const data = typeof value === "string" ? value : JSON.stringify(value);
    await this.kv.put(key, data, { metadata: finalMetadata });
  }

  async loadKeys(keys) {
    const MAX_CHARS = 100_000;
    const context = {};
    for (const key of keys) {
      const value = await this.kvGet(key);
      if (value === null || value === undefined) continue;
      const serialized = typeof value === "string" ? value : JSON.stringify(value);
      if (serialized.length > MAX_CHARS) {
        context[key] = {
          _truncated: true,
          _reason: `Value too large for act context (${serialized.length} chars, limit ${MAX_CHARS})`,
        };
      } else {
        context[key] = value;
      }
    }
    return context;
  }

  resolveModel(modelOrAlias) {
    return this.modelsConfig?.alias_map?.[modelOrAlias] || modelOrAlias;
  }

  async getFallbackModel() {
    return this.modelsConfig?.fallback_model
      || await this.kvGet("kernel:fallback_model")
      || null;
  }

  estimateCost(model, usage) {
    const inputTokens = usage.prompt_tokens || 0;
    const outputTokens = usage.completion_tokens || 0;
    const modelInfo = this.modelsConfig?.models?.find(
      m => m.id === model || m.alias === model
    );
    if (!modelInfo) return null;
    return (inputTokens * modelInfo.input_cost_per_mtok
      + outputTokens * modelInfo.output_cost_per_mtok) / 1_000_000;
  }

  mergeDefaults(defaults, overrides) {
    if (!overrides) return defaults || {};
    if (!defaults) return overrides;
    const merged = { ...defaults };
    for (const [key, val] of Object.entries(overrides)) {
      if (val && typeof val === "object" && !Array.isArray(val) && merged[key]) {
        merged[key] = { ...merged[key], ...val };
      } else {
        merged[key] = val;
      }
    }
    return merged;
  }

  async getSessionCount() {
    const counter = await this.kvGet("session_counter");
    return counter || 0;
  }

  buildPrompt(template, vars) {
    if (!template) return JSON.stringify(vars);
    let result = typeof template === "string" ? template : JSON.stringify(template);
    result = result.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (match, path) => {
      const val = path.split(".").reduce((obj, key) => obj?.[key], vars);
      if (val === undefined) return match;
      return typeof val === "string" ? val : JSON.stringify(val);
    });
    return result;
  }

  defaultSubplanPrompt() {
    return "You are executing a subgoal. You have tools available via function calling.\n\n" +
      "Goal: {{goal}}\n\n" +
      "Use your tools to accomplish this goal. When done, produce a JSON object\n" +
      "with a \"result\" field summarizing what you accomplished.\n\n" +
      "Budget: max {{maxSteps}} turns, max ${{maxCost}}.";
  }

  elapsed() {
    return Date.now() - this.startTime;
  }
}

export { Kernel };
