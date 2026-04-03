// Swayambhu Kernel — safety floor, not ceiling.
//
// The kernel is deliberately thin. It enforces ~10 safety invariants and
// nothing else. Everything beyond safety lives in KV and is agent-modifiable.
// Features locked in the kernel are capabilities the agent can never improve.
// If the agent could implement something itself via code staging, it doesn't
// belong here.
//
// Policy (session flow, reflection) lives in userspace.js, act.js, reflect.js
// — mutable code injected at construction via HOOKS. Tools, providers, and
// channels are also injected. Entry point is index.js.
//
// The agent's identity is its KV data, not the kernel. The kernel is
// disposable infrastructure that can be redeployed without losing anything.

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
    this._eventHandlers = opts.EVENT_HANDLERS || {};
    this.startTime = Date.now();
    this.executionId = `x_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
    this.keyTiers = null;      // Loaded from kernel:key_tiers at boot; falls back to DEFAULT_KEY_TIERS
    this.principles = null;    // Cached generic principles (loaded at boot, immutable by agent)
    this.patronId = null;      // Contact slug of patron (loaded at boot)
    this.patronContact = null; // Full patron contact record (loaded at boot)
    this.patronSnapshot = null;  // Last verified identity fields (loaded at boot)
    this.patronPlatforms = null; // Patron's platform bindings (loaded at boot from contact_platform: keys)
    this.patronIdentityDisputed = false; // True if monitored fields changed unverified
    this.touchedKeys = new Set();
    this.pulseCounter = 0;
  }

  // Write tiers enforce trust boundaries:
  // - immutable: identity anchors. Without a fixed point, everything drifts.
  // - kernel_only: safety state the agent must not touch (audit logs, quarantine,
  //   execution tracking). Modifying these would let the agent disable its own
  //   safety mechanisms.
  // - protected: agent-modifiable via kvWriteGated in deep-reflect context,
  //   with old values captured in karma for rollback.
  static DEFAULT_KEY_TIERS = {
    immutable: ["dharma", "principle:*", "patron:public_key"],
    kernel_only: ["karma:*", "sealed:*", "event:*", "event_dead:*", "kernel:*", "patron:direct"],
    protected: [
      "config:*", "prompt:*", "tool:*", "provider:*", "channel:*",
      "hook:*", "contact:*", "contact_platform:*", "code_staging:*",
      "secret:*", "samskara:*", "skill:*", "task:*",
      "providers", "wallets", "patron:contact", "patron:identity_snapshot",
      "desire:*",
    ],
  };
  static DANGER_SIGNALS = ["fatal_error", "act_parse_error", "all_providers_failed"];
  static MAX_PRIVILEGED_WRITES = 50;

  // ── Key tier helpers (instance methods — use loaded tiers from KV) ──

  _matchesTierPattern(key, patterns) {
    for (const pattern of patterns) {
      if (pattern.endsWith('*')) {
        if (key.startsWith(pattern.slice(0, -1))) return true;
      } else {
        if (key === pattern) return true;
      }
    }
    return false;
  }

  isImmutableKey(key) {
    return this._matchesTierPattern(key, (this.keyTiers || Kernel.DEFAULT_KEY_TIERS).immutable);
  }

  isKernelOnly(key) {
    return this._matchesTierPattern(key, (this.keyTiers || Kernel.DEFAULT_KEY_TIERS).kernel_only);
  }

  isSystemKey(key) {
    return this.isImmutableKey(key)
      || this.isKernelOnly(key)
      || this._matchesTierPattern(key, (this.keyTiers || Kernel.DEFAULT_KEY_TIERS).protected);
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

  // ── Principles (generic, immutable) ──────────────────────

  async loadEagerConfig() {
    this.keyTiers = await this.kvGet("kernel:key_tiers") || Kernel.DEFAULT_KEY_TIERS;
    this.defaults = await this.kvGet("config:defaults");
    this.modelsConfig = await this.kvGet("config:models");
    this.modelCapabilities = await this.kvGet("config:model_capabilities");
    this.dharma = await this.kvGet("dharma");
    this.toolRegistry = await this.kvGet("config:tool_registry");
    this.toolGrants = await this.kvGet("kernel:tool_grants");
    if (!this.toolGrants || Object.keys(this.toolGrants).length === 0) {
      this.toolGrants = this._buildToolGrantsFromModules();
    }
    await this.loadPrinciples();
    await this.loadPatronContext();
  }

  async loadPrinciples() {
    this.principles = {};
    const keys = await this.kvListAll({ prefix: 'principle:' });
    for (const { name: key } of keys) {
      if (key.endsWith(':audit')) continue;
      const value = await this.kvGet(key);
      if (value !== null) this.principles[key] = value;
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

  // ── Event Bus ───────────────────────────────────────────────
  // Structured event queue replacing the inbox. Events are routed to
  // named handlers configured in config:event_handlers. Failed events
  // are retried up to 3 times then dead-lettered.

  async drainEvents(handlers) {
    const rawConfig = await this.kvGet('config:event_handlers') || {};

    // Backward compat: if config has handlers/deferred keys, use them;
    // otherwise treat the whole object as handlers with no deferred.
    const handlerConfig = rawConfig.handlers || (rawConfig.deferred ? {} : rawConfig);
    const deferredConfig = rawConfig.deferred || {};

    const listResult = await this.kvListAll({ prefix: 'event:' });
    const events = [];

    for (const { name } of listResult) {
      const val = await this.kv.get(name, 'json');
      if (val) events.push({ key: name, ...val });
    }

    if (events.length === 0) return { processed: [], actContext: [], deferred: {} };

    const processed = [];
    const actContext = [];
    const deferred = {}; // { processorName: [event, ...] }

    for (const event of events) {
      actContext.push(event);

      // --- Immediate handlers ---
      const handlerNames = handlerConfig[event.type] || [];
      let allHandlersSucceeded = true;

      for (const handlerName of handlerNames) {
        const handlerFn = handlers[handlerName];
        if (!handlerFn) {
          await this.karmaRecord({
            event: "event_handler_unknown",
            handler: handlerName,
            event_type: event.type,
            event_key: event.key,
          });
          continue;
        }
        try {
          await handlerFn(this.buildKernelInterface(), event);
        } catch (err) {
          allHandlersSucceeded = false;
          await this.karmaRecord({
            event: "event_handler_error",
            handler: handlerName,
            event_type: event.type,
            error: err.message,
          });
        }
      }

      // --- Deferred processors ---
      const deferredProcessors = deferredConfig[event.type] || [];
      const hasDeferred = deferredProcessors.length > 0;

      if (hasDeferred) {
        // Track how many times this deferred event has been drained
        const drainKey = `event_drain_count:${event.key}`;
        const drainCount = ((await this.kvGet(drainKey)) || 0) + 1;

        if (drainCount >= 5) {
          // Dead-letter: processor never claimed terminal disposition
          const deadKey = event.key.replace('event:', 'event_dead:');
          await this.kv.put(deadKey, JSON.stringify({ ...event, drain_count: drainCount }), { expirationTtl: 604800 });
          await this.kv.delete(event.key);
          await this.kv.delete(drainKey);
          await this.karmaRecord({ event: "event_dead_lettered", type: event.type, key: event.key, reason: "deferred_ttl" });
        } else {
          await this.kv.put(drainKey, JSON.stringify(drainCount), { expirationTtl: 86400 });
          // Group event by processor name — processor owns deletion
          for (const processorName of deferredProcessors) {
            if (!deferred[processorName]) deferred[processorName] = [];
            deferred[processorName].push(event);
          }
        }
        processed.push(event);
      } else if (allHandlersSucceeded) {
        await this.kv.delete(event.key);
        processed.push(event);
      } else {
        const failKey = `event_fail_count:${event.key}`;
        const failCount = ((await this.kvGet(failKey)) || 0) + 1;
        if (failCount >= 3) {
          const deadKey = event.key.replace('event:', 'event_dead:');
          await this.kv.put(deadKey, JSON.stringify({ ...event, fail_count: failCount }), { expirationTtl: 604800 });
          await this.kv.delete(event.key);
          await this.kv.delete(failKey);
          await this.karmaRecord({ event: "event_dead_lettered", type: event.type, key: event.key });
        } else {
          await this.kv.put(failKey, JSON.stringify(failCount), { expirationTtl: 86400 });
        }
      }
    }

    if (events.length > 0) {
      const typeCounts = {};
      for (const e of events) typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
      await this.karmaRecord({ event: "events_drained", count: events.length, types: typeCounts });
    }

    return { processed, actContext, deferred };
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
      await this.kvWrite(`karma:${this.executionId}`, this.karma);
    }

    if (Kernel.DANGER_SIGNALS.includes(entry.event)) {
      await this.kvWrite("last_danger", {
        t: record.t,
        event: entry.event,
        execution_id: this.executionId,
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

      // Build body from template, interpolating {{message}}, {{event}}, {{execution}}
      const vars = { message, event, execution: this.executionId };
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
    if (this.isImmutableKey(key)) throw new Error(`Cannot overwrite "${key}" — immutable key`);
    if (this.isKernelOnly(key)) throw new Error(`Blocked: kernel-only key "${key}"`);
    if (this.isSystemKey(key)) throw new Error(`Blocked: system key "${key}" — use kvWriteGated with deep-reflect context`);
    return this.kvWrite(key, value, metadata);
  }

  async kvDeleteSafe(key) {
    if (this.isImmutableKey(key)) throw new Error(`Cannot delete "${key}" — immutable key`);
    if (this.isKernelOnly(key)) throw new Error(`Blocked: kernel-only key "${key}"`);
    if (this.isSystemKey(key)) throw new Error(`Blocked: system key "${key}" — use kvWriteGated with deep-reflect context`);
    if (this.touchedKeys) this.touchedKeys.add(key);
    return this.kv.delete(key);
  }

  // kvWritePrivileged — REMOVED. Functionality moved to kvWriteGated with context-based permissions.
  // Contact gating → _gateContact(). System key gating → _gateSystem().

  // ── Kernel interface (replaces KernelRPC) ───────────────────
  // Returns a K object with the same API hooks expect from KernelRPC.
  // Includes sealed: key filtering for security.

  buildKernelInterface() {
    const kernel = this;
    return {
      // LLM
      callLLM: async (opts) => kernel.callLLM(opts),

      // KV reads — sealed keys blocked. Quarantined content (from unknown senders)
      // may contain prompt injection. The agent never sees raw sealed content;
      // the patron reviews and approves senders via the dashboard.
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
      runAgentTurn: async (opts) => kernel.runAgentTurn(opts),
      runAgentLoop: async (opts) => kernel.runAgentLoop(opts),
      executeToolCall: async (tc) => kernel.executeToolCall(tc),
      buildToolDefinitions: async (extra) => kernel.buildToolDefinitions(extra),
      callHook: async (name, ctx) => kernel.callHook(name, ctx),
      executeAction: async (step) => kernel.executeAction(step),
      executeAdapter: async (adapterKey, input) => kernel.executeAdapter(adapterKey, input),

      // Event bus
      emitEvent: async (type, payload) => {
        const ts = Date.now().toString().padStart(15, '0');
        const nonce = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
        const key = `event:${ts}:${type}:${nonce}`;
        const event = {
          type,
          ...payload,
          timestamp: payload.timestamp || new Date().toISOString(),
        };
        await kernel.kv.put(key, JSON.stringify(event), { expirationTtl: 86400 });
        await kernel.karmaRecord({ event: "event_emitted", type, key });
        return { key };
      },

      // Event lease helpers
      claimEvent: async (key, executionId) => {
        const raw = await kernel.kv.get(key);
        if (!raw) return false;
        const event = JSON.parse(raw);
        const now = Date.now();
        if (event.claimed_by && event.lease_expires && event.lease_expires > now) {
          return false;
        }
        event.claimed_by = executionId;
        event.claimed_at = now;
        event.lease_expires = now + 60000;
        await kernel.kv.put(key, JSON.stringify(event), { expirationTtl: 86400 });
        return true;
      },
      releaseEvent: async (key) => {
        const raw = await kernel.kv.get(key);
        if (!raw) return;
        const event = JSON.parse(raw);
        delete event.claimed_by;
        delete event.claimed_at;
        delete event.lease_expires;
        await kernel.kv.put(key, JSON.stringify(event), { expirationTtl: 86400 });
      },
      deleteEvent: async (key) => {
        if (!key.startsWith('event:')) throw new Error(`deleteEvent: not an event key: "${key}"`);
        await kernel.kv.delete(key);
        await kernel.kv.delete(`event_drain_count:${key}`);
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
      loadKeys: async (keys) => {
        const filtered = keys.filter(k => !k.startsWith("sealed:"));
        return kernel.loadKeys(filtered);
      },
      // getSessionCount removed — userspace reads session_counter directly via kvGet
      mergeDefaults: async (defaults, overrides) => kernel.mergeDefaults(defaults, overrides),
      isSystemKey: async (key) => kernel.isSystemKey(key),
      getSystemKeyPatterns: async () => kernel.keyTiers || Kernel.DEFAULT_KEY_TIERS,

      // KV operation gating — context-based permissions
      // (kvWriteGated already exposed above in KV writes section)

      // Code staging
      stageCode: async (targetKey, code) => kernel.stageCode(targetKey, code),
      signalDeploy: async () => kernel.signalDeploy(),

      // State (read-only)
      getExecutionId: async () => kernel.executionId,
      getSessionCost: async () => kernel.sessionCost,
      getKarma: async () => kernel.karma,
      getChatKarma: async () => kernel.mode === 'chat' ? [...kernel.karma] : [],
      getDefaults: async () => kernel.defaults,
      getModelsConfig: async () => kernel.modelsConfig,
      getModelCapabilities: async () => kernel.modelCapabilities,
      getDharma: async () => kernel.dharma,
      getToolRegistry: async () => kernel.toolRegistry,
      getPrinciples: async () => kernel.principles,
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
    if (this.isImmutableKey(key)) {
      return { ok: false, error: `Cannot write "${key}" — immutable` };
    }

    // 2. Always blocked — kernel-only keys
    if (this.isKernelOnly(key)) {
      return { ok: false, error: `Cannot write kernel key "${key}"` };
    }

    // 3. Always blocked — code keys go through K.stageCode()
    if (Kernel.isCodeKey(key)) {
      return { ok: false, error: `Code key "${key}" requires K.stageCode()` };
    }

    // 4. Contact keys — allowed in all contexts (with approval gating)
    if (key.startsWith("contact:") || key.startsWith("contact_platform:")) {
      return this._gateContact(op);
    }

    // 5. System keys — deep-reflect only
    if (this.isSystemKey(key)) {
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

  // ── System key gating (deep-reflect only) ────────────────

  async _gateSystem(op) {
    const key = op.key;

    // Only put/delete/patch supported for system keys
    if (!["put", "delete", "patch"].includes(op.op)) {
      return { ok: false, error: `Unsupported op "${op.op}" for system key "${key}"` };
    }

    // Model capabilities are separated from config:models to prevent
    // self-escalation — a single write can't both add a model and grant it
    // communication or principle-writing powers. The deliberation requirement
    // forces careful reasoning about capability changes.
    if (key === "config:model_capabilities") {
      if (!op.deliberation || op.deliberation.length < 200) {
        return { ok: false, error: `Model capability changes require deliberation (min 200 chars, got ${op.deliberation?.length || 0})` };
      }
    }

    // Per-session limit
    if (this.privilegedWriteCount + 1 > Kernel.MAX_PRIVILEGED_WRITES) {
      return { ok: false, error: `Privileged write limit (${Kernel.MAX_PRIVILEGED_WRITES}/session) exceeded` };
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

    // Alert on hook: key writes
    if (key.startsWith("hook:")) {
      await this.sendKernelAlert("hook_write",
        `Privileged write to ${key} in execution ${this.executionId}`);
    }

    // Auto-reload cached config
    const configKeys = ["config:defaults", "config:models", "config:tool_registry", "config:model_capabilities"];
    if (configKeys.includes(key)) {
      if (key === "config:defaults") this.defaults = await this.kvGet("config:defaults");
      if (key === "config:models") this.modelsConfig = await this.kvGet("config:models");
      if (key === "config:tool_registry") this.toolRegistry = await this.kvGet("config:tool_registry");
      if (key === "config:model_capabilities") this.modelCapabilities = await this.kvGet("config:model_capabilities");
    }

    return { ok: true };
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

  // ── Code staging (two primitives — replaces proposal system) ──────

  static CODE_KEY_PATTERNS = ['tool:', 'hook:', 'provider:', 'channel:'];

  static isCodeKey(key) {
    return Kernel.CODE_KEY_PATTERNS.some(p => key.startsWith(p)) && key.endsWith(':code');
  }

  async stageCode(targetKey, code) {
    if (!Kernel.isCodeKey(targetKey)) {
      throw new Error(`"${targetKey}" is not a code key — stageCode only accepts code keys`);
    }
    const record = {
      code,
      staged_at: new Date().toISOString(),
      execution_id: this.executionId,
    };
    await this.kvWrite(`code_staging:${targetKey}`, record);
    await this.karmaRecord({ event: "code_staged", target: targetKey });
  }

  async signalDeploy() {
    await this.kvWrite("deploy:pending", {
      requested_at: new Date().toISOString(),
      execution_id: this.executionId,
    });
    await this.karmaRecord({ event: "deploy_signaled" });
  }

  async kvDelete(key) {
    await this.kv.delete(key);
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
    // 1. Execution lock — prevent overlapping executions
    const active = await this.kvGet("kernel:active_execution");
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

      // Stale marker — previous execution is dead (platform kill / OOM)
      const history = await this.kvGet("kernel:last_executions") || [];
      history.unshift({ id: active.id, outcome: "killed", ts: new Date().toISOString() });
      while (history.length > 5) history.pop();
      await this.kvWrite("kernel:last_executions", history);
    }

    // 2. Acquire lock — write marker before any work
    await this.kvWrite("kernel:active_execution", {
      id: this.executionId,
      started_at: new Date().toISOString(),
    });

    // 3. Meta-safety check (3 consecutive crashes → signal governor + fallback)
    const hookSafe = await this.checkHookSafety();

    // 4. Execute hook or fallback
    if (hookSafe) {
      await this.runTick();
    } else {
      await this.runFallbackSession();
    }
  }

  // Hook safety tripwire: 3 consecutive crashes trigger rollback.
  // 1 crash could be transient (network), 2 could be coincidence, 3 strongly
  // suggests broken hook code. We signal the governor to rollback rather than
  // restoring inline, so the deployed code is also fixed.
  async checkHookSafety() {
    const history = await this.kvGet("kernel:last_executions") || [];
    if (history.length < 3) return true;

    const last3 = history.slice(0, 3);
    const allBad = last3.every(s => s.outcome === "crash" || s.outcome === "killed");
    if (!allBad) return true;
    await this.kvWrite("deploy:rollback_requested", {
      reason: "3_consecutive_crashes",
      last_executions: last3,
      requested_at: new Date().toISOString(),
    });

    await this.karmaRecord({ event: "hook_safety_reset", last_executions: last3 });
    await this.sendKernelAlert("hook_reset",
      "3 consecutive crashes detected. Signaled governor for rollback. Running minimal mode.");
    return false;
  }

  async runTick() {
    await this.loadEagerConfig();
    const K = this.buildKernelInterface();
    let outcome = "clean";

    try {
      // Infrastructure inputs
      const crashData = await this._detectCrash();
      const balances = await this.checkBalance({});
      const { actContext: events, deferred } = await this.drainEvents(this._eventHandlers);

      // Hand to userspace — one call, userspace decides everything
      const { tick } = this.HOOKS;
      if (!tick?.run) throw new Error("No HOOKS.tick.run");
      await tick.run(K, { crashData, balances, events });

      // Process deferred events inside lock
      if (this.HOOKS.deferred) {
        for (const [processor, processorEvents] of Object.entries(deferred)) {
          const hook = this.HOOKS.deferred[processor];
          if (!hook?.run) continue;
          try {
            await hook.run(K, processorEvents);
          } catch (err) {
            await this.karmaRecord({ event: "deferred_processor_error", processor, error: err.message });
          }
        }
      }

    } catch (err) {
      outcome = "crash";
      await this.karmaRecord({
        event: "fatal_error",
        error: err.message,
        stack: err.stack,
      });
    }

    // Always record execution outcome and release lock
    await this._writeExecutionHealth(outcome);
    await this.updateExecutionOutcome(outcome);
    await this.kv.delete("kernel:active_execution");
  }

  // ── Crash detection ───────────────────────────────────────

  async _detectCrash() {
    // The active_execution marker is always the current execution at this point
    // (written by runScheduled before runTick). Crash detection for dead
    // executions is now handled in runScheduled's lock check, which records
    // killed executions in kernel:last_executions before we get here.
    // This method now just checks if a killed execution was recorded.
    const history = await this.kvGet("kernel:last_executions") || [];
    const lastKilled = history.find(s => s.outcome === "killed");
    if (!lastKilled) return null;

    const deadKarma = await this.kvGet(`karma:${lastKilled.id}`);
    return {
      dead_execution_id: lastKilled.id,
      karma: deadKarma,
      last_entry: Array.isArray(deadKarma) ? deadKarma[deadKarma.length - 1] : null,
    };
  }

  async _writeExecutionHealth(outcome) {
    const karma = this.karma || [];
    const health = {
      outcome,
      cost: this.sessionCost,
      llm_calls: this.sessionLLMCalls,
      elapsed_ms: this.elapsed(),
      reflect_ran: karma.some(e => e.event === 'llm_call' && e.step?.startsWith('reflect')),
      budget_exceeded: karma.filter(e => e.event === 'budget_exceeded').map(e => e.step),
      truncations: karma.filter(e => e.truncated).map(e => e.step),
      provider_fallbacks: karma.filter(e => e.event === 'provider_fallback').length,
      tool_failures: karma.filter(e => e.event === 'tool_complete' && e.ok === false).length,
      kv_writes_blocked: karma.filter(e => e.event === 'kv_writes_blocked').length,
      parse_errors: karma.filter(e => e.event === 'reflect_parse_error').length,
      updates_missed: karma.filter(e => e.event?.endsWith('_missed')).length,
      timestamp: new Date().toISOString(),
    };
    // Only include non-zero/non-empty problem indicators
    if (!health.budget_exceeded.length) delete health.budget_exceeded;
    if (!health.truncations.length) delete health.truncations;
    if (!health.provider_fallbacks) delete health.provider_fallbacks;
    if (!health.tool_failures) delete health.tool_failures;
    if (!health.kv_writes_blocked) delete health.kv_writes_blocked;
    if (!health.parse_errors) delete health.parse_errors;
    if (!health.updates_missed) delete health.updates_missed;
    try {
      await this.kv.put(
        `execution_health:${this.executionId}`,
        JSON.stringify(health),
        { expirationTtl: 30 * 24 * 60 * 60, metadata: { format: "json" } }
      );
    } catch {}
  }

  async updateExecutionOutcome(outcome) {
    const history = await this.kvGet("kernel:last_executions") || [];
    history.unshift({ id: this.executionId, outcome, ts: new Date().toISOString() });
    while (history.length > 5) history.pop();
    await this.kvWrite("kernel:last_executions", history);
  }

  async runMinimalFallback() {
    await this.sendKernelAlert("hook_reset",
      "Hook execution failed. Running minimal recovery mode.");

    const hardcodedPrompt = `You are Swayambhu in recovery mode. Your session hook has been reset due to repeated failures. Check your balances and report your status. Do not attempt complex operations.`;

    await this.loadEagerConfig();
    this.defaults = { session_budget: { max_cost: 0.50, max_duration_seconds: 120 } };
    await this.karmaRecord({ event: "act_start", mode: "recovery" });

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
    const count = (await this.kvGet("session_counter")) || 0;
    await this.kvWrite("session_counter", count + 1);
  }

  // ── Session cycle ───────────────────────────────────────────

  // ── Minimal fallback (no hook code in KV) ───────────────────
  // Used when no hook is loaded, or after the hook safety tripwire fires.
  // Runs a hardcoded recovery session — does NOT load prompt:act
  // (could be corrupted). Does NOT process kv_operations from output.

  async runFallbackSession() {
    await this.runMinimalFallback();
    await this.updateExecutionOutcome("clean");
  }

  // ── Actions (dynamic tools) ─────────────────────────────────

  async executeAction(step) {
    const toolName = step.tool;

    // Load tool code + meta (platform-specific, overridable)
    const { meta, moduleCode } = await this._loadTool(toolName);

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

    // Constitutional safety: self-contained contact check for person-targeted adapters
    // Kernel derives recipient from the actual args — does NOT trust caller metadata
    const commsMeta = mod.meta?.communication;
    if (commsMeta?.recipient_type === "person") {
      const recipientField = commsMeta.recipient_field;
      const recipientId = recipientField ? input[recipientField] : null;
      if (recipientId) {
        const contact = await this.resolveContact(commsMeta.channel, recipientId);
        if (!contact?.approved) {
          await this.karmaRecord({
            event: "adapter_contact_blocked",
            adapter: adapterKey,
            recipient: recipientId,
            reason: "unapproved_contact",
          });
          throw new Error(`Cannot send to unapproved contact: ${recipientId}`);
        }
      }
    }

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
      `Patron public key rotated in execution ${this.executionId}`);

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
    const kernel = this;
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
        if (kernel.touchedKeys) kernel.touchedKeys.add(resolved);
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

  // ── LLM calls (3-tier provider cascade) ─────────────────────
  // Tier 1: compiled provider (agent-modifiable via code staging)
  // Tier 2: last-working snapshot (auto-captured on first success per session)
  // Tier 3: kernel hardcoded fallback (human-managed, always works)
  // This ensures LLM access survives the agent's own mistakes. If the agent
  // breaks the provider adapter, tier 2 catches it. If tier 2 is also bad,
  // tier 3 is always there.

  async callLLM({ model, effort, maxTokens, systemPrompt, messages, tools, step, budgetCap, json }) {
    const budget = this.defaults?.session_budget;
    const costLimit = budgetCap ?? (this.mode === 'chat' ? null : budget?.max_cost);
    if (costLimit && this.sessionCost >= costLimit)
      throw new Error("Budget exceeded: cost");
    if (budget?.max_duration_seconds && this.elapsed() > budget.max_duration_seconds * 1000)
      throw new Error("Budget exceeded: duration");

    const startMs = Date.now();

    // Dharma and principles are injected here in the kernel, not in hook code.
    // This guarantees every LLM call carries core identity — a bad hook
    // modification cannot remove it.
    const dharmaPrefix = this.dharma ? `[DHARMA]\n${this.dharma}\n[/DHARMA]\n\n` : '';
    let principlesBlock = '';
    if (this.principles && Object.keys(this.principles).length > 0) {
      const entries = Object.entries(this.principles)
        .map(([key, text]) => {
          const name = key.replace('principle:', '');
          return `[${name}]\n${text}\n[/${name}]`;
        }).join('\n');
      principlesBlock = `[PRINCIPLES]\n${entries}\n[/PRINCIPLES]\n\n`;
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

    const response = { content: result.content, usage: result.usage, cost, toolCalls: result.toolCalls, finish_reason: result.finish_reason };

    if (json) {
      response.parsed = this._parseJSON(result.content);
    }

    return response;
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

    if (name === 'verify_patron') {
      return this.verifyPatron(args);
    }

    if (name === 'check_balance') {
      return this.checkBalance(args);
    }

    // ── Load tool grants (for inbound gate) ──
    const toolGrant = this.toolGrants?.[name] || {};

    // Pre-validation hook
    const schema = this.toolRegistry?.tools?.find(t => t.name === name)?.input;
    const preCheck = await this.callHook('validate', { tool: name, args, schema });
    if (preCheck && !preCheck.ok) {
      await this.karmaRecord({ event: "hook_rejected", hook: "validate", tool: name, error: preCheck.error });
      return { error: preCheck.error };
    }
    if (preCheck?.args) args = preCheck.args;

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

    return result;
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

  async runAgentTurn({ systemPrompt, messages, tools, model, effort,
                       maxTokens, step, budgetCap }) {
    const response = await this.callLLM({
      model, effort, maxTokens,
      systemPrompt, messages, tools,
      step, budgetCap,
    });
    const cost = response.cost || 0;

    if (response.toolCalls?.length) {
      // Append assistant message with tool calls
      messages.push({
        role: 'assistant',
        content: response.content || null,
        tool_calls: response.toolCalls,
      });

      // Execute tools in parallel, catch errors gracefully
      const toolResults = await Promise.all(
        response.toolCalls.map(tc => this.executeToolCall(tc)
          .catch(err => ({ error: err.message })))
      );

      // Append one tool result message per call
      for (let i = 0; i < response.toolCalls.length; i++) {
        messages.push({
          role: 'tool',
          tool_call_id: response.toolCalls[i].id,
          content: JSON.stringify(toolResults[i]),
        });
      }

      return { response, toolResults, cost, done: false };
    }

    // No tool calls — append assistant message, signal done
    messages.push({
      role: 'assistant',
      content: response.content || null,
    });

    return { response, toolResults: [], cost, done: true };
  }

  async runAgentLoop({ systemPrompt, initialContext, tools, model, effort,
                       maxTokens, maxSteps, step, budgetCap, maxSpend }) {
    const messages = [];
    if (initialContext) {
      const content = typeof initialContext === 'string'
        ? initialContext
        : JSON.stringify(initialContext);
      messages.push({ role: 'user', content });
    }

    let parseRetried = false;
    let softWarned = false;
    let loopSpend = 0;

    // Budget limit config
    const costLimit = budgetCap ?? this.defaults?.session_budget?.max_cost;
    const softPct = 0.75;
    const hardPct = 0.90;

    try {
      for (let i = 0; i < maxSteps; i++) {
        // ── Per-invocation spend limit (subplans) ──────────────────
        if (maxSpend && loopSpend >= maxSpend) {
          await this.karmaRecord({ event: "budget_exceeded", reason: "maxSpend exceeded", step });
          return { budget_exceeded: true, reason: "Subplan spend limit reached" };
        }

        // ── Budget soft/hard limits ──────────────────────────────
        if (costLimit) {
          const usedPct = this.sessionCost / costLimit;

          // Hard limit — strip tools, force final output
          if (usedPct >= hardPct) {
            messages.push({ role: 'user', content:
              'Budget hard limit reached. Produce your final JSON output NOW. No more tool calls.' });
            const finalResp = await this.callLLM({
              model, effort, maxTokens, systemPrompt, messages,
              step: `${step}_budget_final`, budgetCap, json: true,
            });
            return finalResp.parsed ?? {};
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
        loopSpend += response.cost || 0;

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

        // No tool calls — parse JSON from response
        const parsed = this._parseJSON(response.content);
        if (parsed === null && !parseRetried) {
          parseRetried = true;
          messages.push(
            { role: 'assistant', content: response.content },
            { role: 'user', content: 'Your output was not valid JSON. Respond with only a valid JSON object.' }
          );
          continue;  // burns one step, loop retries once
        }
        return parsed ?? { parse_error: true, raw: response.content };
      }

      // Max steps reached — force final output (no tools, forces text)
      messages.push({ role: 'user', content: 'Maximum steps reached. Produce your final output now.' });
      const finalResponse = await this.callLLM({
        model, effort, maxTokens, systemPrompt, messages,
        step: `${step}_final`, budgetCap, json: true,
      });
      return finalResponse.parsed ?? {};

    } catch (err) {
      if (err.message.startsWith("Budget exceeded")) {
        await this.karmaRecord({ event: "budget_exceeded", reason: err.message, step });
        return { budget_exceeded: true, reason: err.message };
      }
      throw err;
    }
  }

  // Try JSON.parse, then fence stripping, then brace matching. Returns parsed
  // object or null. Pure mechanical extraction — no LLM calls, no side effects.
  _parseJSON(content) {
    if (!content) return null;
    try { return JSON.parse(content); }
    catch { return this._extractJSON(content); }
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
    if (this.isImmutableKey(key)) {
      throw new Error(`Cannot write "${key}" — immutable key`);
    }

    if (this.touchedKeys) this.touchedKeys.add(key);

    // System keys cannot be marked unprotected
    if (this.isSystemKey(key)) delete metadata.unprotected;

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
      samskara:  { type: "samskara", format: "json" },
      kernel:     { type: "kernel", format: "json" },
      sealed:     { type: "sealed", format: "json" },
      principle:  { type: "principle", format: "text" },
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

  elapsed() {
    return Date.now() - this.startTime;
  }
}

export { Kernel };
