// Swayambhu Kernel
// Hardcoded safety primitives, execution engine, and session infrastructure.
// Policy (session flow, reflection) lives in act.js and reflect.js — mutable
// code injected at construction via HOOKS. Tools, providers, and channels are
// also injected. The kernel enforces safety: KV write tiers, dharma injection,
// communication gates, budget enforcement, and proposal mechanics.
//
// Entry point is index.js, which imports all modules and wires them here.

class Brainstem {
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
    this.modelsConfig = null;
    this.modelCapabilities = null;
    this.defaults = null;
    this.dharma = null;
    this.toolsCache = {};      // Loaded tool code+meta, cached per session
    this.lastWorkingSnapshotted = false; // Only snapshot provider once per session
    this.privilegedWriteCount = 0; // Counter for kvWritePrivileged calls
    this._alertConfigCache = undefined; // undefined = not loaded, null = doesn't exist
    this.yamas = null;         // Cached yama principles (loaded at boot)
    this.niyamas = null;       // Cached niyama principles (loaded at boot)
    this.patronId = null;      // Contact slug of patron (loaded at boot)
    this.patronContact = null; // Full patron contact record (loaded at boot)
    this.patronSnapshot = null;  // Last verified identity fields (loaded at boot)
    this.patronIdentityDisputed = false; // True if monitored fields changed unverified
    this.lastCallModel = null; // Last model used in callLLM (for capability gates)
    this._commsGateApproved = false; // Transient flag: set by executeToolCall/processCommsVerdict around executeAction
  }

  static SYSTEM_KEY_PREFIXES = [
    'prompt:', 'config:', 'tool:', 'provider:', 'secret:',
    'modification_staged:', 'modification_snapshot:', 'hook:', 'doc:', 'git_pending:',
    'yama:', 'niyama:',
    'viveka:', 'prajna:',
    'skill:',
    'comms_blocked:',
    'contact:',
    'contact_index:',
    'sealed:',
  ];
  static KERNEL_ONLY_PREFIXES = ['kernel:', 'sealed:'];
  static SYSTEM_KEY_EXACT = ['providers', 'wallets', 'patron:contact', 'patron:identity_snapshot'];
  static IMMUTABLE_KEYS = ['patron:public_key'];
  static DANGER_SIGNALS = ["fatal_error", "orient_parse_error", "all_providers_failed"];
  static MAX_PRIVILEGED_WRITES = 50;
  static PRINCIPLE_PREFIXES = ['yama:', 'niyama:'];

  static isSystemKey(key) {
    if (Brainstem.SYSTEM_KEY_EXACT.includes(key)) return true;
    return Brainstem.SYSTEM_KEY_PREFIXES.some(p => key.startsWith(p));
  }

  static isKernelOnly(key) {
    return Brainstem.KERNEL_ONLY_PREFIXES.some(p => key.startsWith(p));
  }

  static isPrincipleKey(key) {
    return Brainstem.PRINCIPLE_PREFIXES.some(p => key.startsWith(p));
  }

  static isPrincipleAuditKey(key) {
    return Brainstem.isPrincipleKey(key) && key.endsWith(':audit');
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
    for (const prefix of Brainstem.PRINCIPLE_PREFIXES) {
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

    // Identity monitor — compare monitored fields against last verified snapshot
    const snapshot = await this.kvGet("patron:identity_snapshot");
    if (!snapshot) {
      // First boot — create snapshot from seed
      const initial = {
        name: this.patronContact.name,
        platforms: this.patronContact.platforms,
        verified_at: new Date().toISOString(),
      };
      await this.kvPut("patron:identity_snapshot", initial);
      this.patronSnapshot = initial;
      this.patronIdentityDisputed = false;
    } else {
      this.patronSnapshot = snapshot;
      const nameChanged = this.patronContact.name !== snapshot.name;
      const platformsChanged = JSON.stringify(this.patronContact.platforms) !== JSON.stringify(snapshot.platforms);
      this.patronIdentityDisputed = nameChanged || platformsChanged;
      if (this.patronIdentityDisputed) {
        await this.karmaRecord({
          event: "patron_identity_disputed",
          old: { name: snapshot.name, platforms: snapshot.platforms },
          new: { name: this.patronContact.name, platforms: this.patronContact.platforms },
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
    // Check index cache first
    const cached = await this.kvGet(`contact_index:${platform}:${platformUserId}`);
    if (cached) {
      const contact = await this.kvGet(`contact:${cached}`);
      if (!contact) return null;
      return this._applyPatronSnapshot(cached, contact);
    }

    // Scan contacts on miss (small set for v0.1)
    const contactKeys = await this.kvListAll({ prefix: "contact:" });
    for (const { name: key } of contactKeys) {
      const contact = await this.kvGet(key);
      if (contact?.platforms?.[platform] === platformUserId) {
        const id = key.replace("contact:", "");
        await this.kvPut(`contact_index:${platform}:${platformUserId}`, id);
        return this._applyPatronSnapshot(id, contact);
      }
    }
    return null;
  }

  _applyPatronSnapshot(id, contact) {
    // When patron identity is disputed, override monitored fields with last-known-good values
    if (this.patronIdentityDisputed && id === this.patronId && this.patronSnapshot) {
      return { id, ...contact, name: this.patronSnapshot.name, platforms: this.patronSnapshot.platforms };
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

  isCommsGateCapable(modelId) {
    const resolved = this.resolveModel(modelId);
    return !!this.modelCapabilities?.[resolved]?.comms_gate_capable;
  }

  // ── Communication gate (kernel-enforced) ────────────────────

  static COMMS_GATE_PROMPT = `You are evaluating an outbound communication attempt. Based on your principles and the wisdom context provided, determine whether this message should be sent.

Consider:
- Standing: is this a response to someone who contacted you, or are you initiating contact?
- Recipient type: is this going to a specific person ("person") or a destination like a channel ("destination")? For destinations, focus on whether the content suits that venue.
- Recipient: what does your accumulated wisdom say about them and your relationship?
- Content: is the message appropriate for this recipient and context?
- Tone: does it match what this context requires?
- Authority: do you have standing to communicate this in this context?

[COMMUNICATION WISDOM]
{{viveka}}
[/COMMUNICATION WISDOM]

Respond with JSON only:
{
  "verdict": "send" | "revise" | "block",
  "reasoning": "brief explanation",
  "revision": { "text": "revised message" }
}

"revision" required only when verdict is "revise".`;

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

  async loadCommsViveka() {
    const entries = {};
    // General communication wisdom (not contact-specific)
    for (const prefix of ['viveka:channel:', 'viveka:comms:']) {
      const wisdomKeys = await this.kvListAll({ prefix });
      for (const { name: key } of wisdomKeys) {
        const value = await this.kvGet(key);
        if (value !== null) entries[key] = value;
      }
    }
    return entries;
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
    await this.kvPut(`comms_blocked:${id}`, record);
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

    // 1. Mechanical floor — blocks person-targeted comms to unknown/unapproved contacts
    //    Destination-targeted tools (Slack) proceed to LLM gate regardless
    const channel = meta.communication?.channel;
    const recipientType = meta.communication?.recipient_type || 'destination';
    const recipientContact = recipient ? await this.resolveContact(channel, recipient) : null;
    if (recipientType === 'person' && recipient) {
      if (!recipientContact) {
        // No contact at all — block initiating, allow responding to reach LLM gate
        if (mode === 'initiating') {
          return {
            verdict: 'block',
            reasoning: `No contact record for recipient "${recipient}" — cannot initiate contact with unknown person`,
            mechanical: true,
          };
        }
      } else if (!recipientContact.approved) {
        // Contact exists but unapproved — block ALL engagement
        return {
          verdict: 'block',
          reasoning: `Contact "${recipient}" is not approved — all communication blocked until operator approves`,
          mechanical: true,
        };
      }
    }

    // 2. Model gate: current model must be comms_gate_capable
    const currentModel = this.lastCallModel || this.defaults?.orient?.model;
    if (!this.isCommsGateCapable(currentModel)) {
      return {
        verdict: 'queue',
        reasoning: `Model ${currentModel} not comms_gate_capable — queuing for deep reflect`,
      };
    }

    // 3. Load viveka context + recipient contact
    const viveka = await this.loadCommsViveka();
    if (recipientContact) {
      viveka[`contact:${recipientContact.id}`] = recipientContact.communication || recipientContact;
    }
    const vivekaBlock = Object.entries(viveka).length > 0
      ? Object.entries(viveka).map(([k, v]) => {
          const text = typeof v === 'object' ? (v.text || JSON.stringify(v)) : String(v);
          return `[${k}]\n${text}\n[/${k}]`;
        }).join('\n')
      : '(No accumulated communication wisdom yet. Be conservative.)';

    // 4. Gate LLM call
    const gatePrompt = Brainstem.COMMS_GATE_PROMPT.replace('{{viveka}}', vivekaBlock);
    const contentField = meta.communication?.content_field || 'text';
    const contextMessage = JSON.stringify({
      tool: toolName,
      channel: meta.communication.channel,
      recipient_type: recipientType,
      mode,
      recipient: recipient || '(default channel)',
      message_content: args[contentField] || '',
      subject: args.subject || null,
      is_reply: mode === 'responding',
      reply_to: meta.communication.reply_field ? args[meta.communication.reply_field] : null,
    });

    const gateResult = await this.callLLM({
      model: currentModel,
      effort: 'low',
      maxTokens: 500,
      systemPrompt: gatePrompt,
      messages: [{ role: 'user', content: contextMessage }],
      step: `comms_gate:${toolName}`,
    });

    // 5. Parse verdict
    try {
      const parsed = JSON.parse(gateResult.content);
      return {
        verdict: parsed.verdict || 'block',
        reasoning: parsed.reasoning || '',
        revision: parsed.revision || null,
        gate_model: currentModel,
        gate_cost: gateResult.cost,
      };
    } catch {
      return {
        verdict: 'block',
        reasoning: 'Gate response not valid JSON — blocking as safety default',
        raw: gateResult.content,
      };
    }
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
      await this.karmaRecord({
        event: 'comms_verdict_sent', id, tool: record.tool,
        recipient: record.recipient, verdict,
        revised: verdict === 'revise_and_send',
      });
      await this.kvWritePrivileged([{ op: "delete", key }]);
      return { ok: true, result };
    }

    if (verdict === 'drop') {
      await this.karmaRecord({
        event: 'comms_verdict_dropped', id, tool: record.tool,
        recipient: record.recipient,
        reason: revision?.reason || 'dropped by deep reflect',
      });
      await this.kvWritePrivileged([{ op: "delete", key }]);
      return { ok: true, dropped: true };
    }

    return { error: `Unknown verdict: ${verdict}` };
  }

  // ── Karma log ────────────────────────────────────────────────

  async karmaRecord(entry) {
    const record = {
      t: Date.now(),
      elapsed_ms: this.elapsed(),
      ...entry,
    };
    this.karma.push(record);
    await this.kvPut(`karma:${this.sessionId}`, this.karma);

    if (Brainstem.DANGER_SIGNALS.includes(entry.event)) {
      await this.kvPut("last_danger", {
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

  async kvPutSafe(key, value, metadata) {
    if (key === "dharma") throw new Error("Cannot overwrite dharma — immutable key");
    if (Brainstem.isKernelOnly(key)) throw new Error(`Blocked: kernel-only key "${key}"`);
    if (Brainstem.isSystemKey(key)) throw new Error(`Blocked: system key "${key}" — use kvWritePrivileged`);
    return this.kvPut(key, value, metadata);
  }

  async kvDeleteSafe(key) {
    if (key === "dharma") throw new Error("Cannot delete dharma — immutable key");
    if (Brainstem.isKernelOnly(key)) throw new Error(`Blocked: kernel-only key "${key}"`);
    if (Brainstem.isSystemKey(key)) throw new Error(`Blocked: system key "${key}" — use kvWritePrivileged`);
    return this.kv.delete(key);
  }

  async kvWritePrivileged(ops) {
    if (!Array.isArray(ops) || ops.length === 0) return;

    // ── Pre-validation: reject entire batch before any writes ──
    for (const op of ops) {
      if (op.key === "dharma" || Brainstem.IMMUTABLE_KEYS.includes(op.key)) {
        throw new Error(`Cannot write "${op.key}" — immutable key`);
      }
      if (Brainstem.isKernelOnly(op.key)) throw new Error(`Blocked: kernel-only key "${op.key}"`);

      // Contact index is kernel-managed (auto-built by resolveContact)
      if (op.key.startsWith("contact_index:")) {
        throw new Error(`Contact index keys are kernel-managed`);
      }

      // Contacts: agent can create (unapproved, no platforms), edit, delete unapproved
      if (op.key.startsWith("contact:")) {
        // Patch ops on contacts could bypass approved/platforms checks — block if touching approved
        if (op.op === "patch" && op.new_string?.includes('"approved"')) {
          throw new Error(`Cannot patch "approved" field on contacts — use the dashboard`);
        }
        const existing = await this.kvGet(op.key);
        if (op.op === "delete") {
          if (existing && existing.approved) {
            throw new Error(`Deletion of approved contacts is operator-only`);
          }
          // Unapproved or non-existent — allow delete, fall through
        } else if (existing === null) {
          // Creation: must be unapproved with empty platforms
          if (op.value?.approved === true) {
            throw new Error(`Setting approved: true is operator-only`);
          }
          if (op.value?.platforms && Object.keys(op.value.platforms).length > 0) {
            throw new Error(`Agent-created contacts must have empty platforms — platform IDs are operator-only`);
          }
          op.value = { ...op.value, approved: false, platforms: op.value?.platforms || {} };
          // Fall through to normal processing
        } else {
          // Update: block setting approved: true, auto-flip if platforms changed
          if (op.value?.approved === true) {
            throw new Error(`Setting approved: true is operator-only`);
          }
          if (op.value?.platforms && JSON.stringify(op.value.platforms) !== JSON.stringify(existing.platforms)) {
            op.value = { ...op.value, approved: false };
          } else if (!('approved' in (op.value || {}))) {
            // Preserve existing approved status when agent doesn't explicitly set it
            op.value = { ...op.value, approved: existing.approved };
          }
          // Fall through to normal processing
        }
      }

      // Model capabilities require deliberation + yama_capable model
      if (op.key === "config:model_capabilities") {
        if (!op.deliberation || op.deliberation.length < 200) {
          throw new Error(`Model capability changes require deliberation (min 200 chars, got ${op.deliberation?.length || 0})`);
        }
        if (!this.isYamaCapable(this.lastCallModel)) {
          throw new Error(`Model capability changes require a yama_capable model (last model: ${this.lastCallModel})`);
        }
      }

      // Yama/Niyama gates — validate before any writes execute
      if (Brainstem.isPrincipleKey(op.key) && !Brainstem.isPrincipleAuditKey(op.key)) {
        const isYama = op.key.startsWith('yama:');
        const type = isYama ? 'yama' : 'niyama';
        const minChars = isYama ? 200 : 100;
        const typeLabel = isYama ? 'Yama' : 'Niyama';

        if (!op.deliberation || op.deliberation.length < minChars) {
          throw new Error(`${typeLabel} modifications require deliberation (min ${minChars} chars, got ${op.deliberation?.length || 0})`);
        }
        const capCheck = isYama ? this.isYamaCapable(this.lastCallModel) : this.isNiyamaCapable(this.lastCallModel);
        if (!capCheck) {
          throw new Error(`${typeLabel} writes require a ${type}_capable model (last model: ${this.lastCallModel})`);
        }
      }
    }

    if (this.privilegedWriteCount + ops.length > Brainstem.MAX_PRIVILEGED_WRITES) {
      throw new Error(`Privileged write limit (${Brainstem.MAX_PRIVILEGED_WRITES}/session) exceeded`);
    }

    const configKeys = ["config:defaults", "config:models", "config:tool_registry", "config:model_capabilities"];
    const principleWarnings = [];
    let touchedPrinciple = false;

    for (const op of ops) {
      // ── Yama/Niyama diff warning (gates already passed in pre-validation) ──
      if (Brainstem.isPrincipleKey(op.key) && !Brainstem.isPrincipleAuditKey(op.key)) {
        const isYama = op.key.startsWith('yama:');
        const type = isYama ? 'yama' : 'niyama';

        const currentValue = await this.kvGet(op.key);
        const proposedValue = op.op === 'delete' ? null : (op.op === 'patch' ? `[patch: "${op.old_string}" → "${op.new_string}"]` : op.value);
        const name = op.key.replace(`${type}:`, '');

        const warningMsg = isYama
          ? `WARNING: You are modifying yama "${name}".\n\nCAUTION: You are attempting to modify a yama — a core principle of how you act in the world. This requires extraordinary justification. How does this change better serve your dharma?\n\nCurrent value: ${currentValue ?? '(new)'}\nProposed value: ${proposedValue ?? '(delete)'}`
          : `WARNING: You are modifying niyama "${name}".\n\nCAUTION: You are attempting to modify a niyama — a core principle that governs how you reflect and improve. This requires compelling justification. How does this change better serve your dharma?\n\nCurrent value: ${currentValue ?? '(new)'}\nProposed value: ${proposedValue ?? '(delete)'}`;

        principleWarnings.push({
          key: op.key,
          name,
          type,
          current_value: currentValue,
          proposed_value: proposedValue,
          deliberation: op.deliberation,
          model: this.lastCallModel,
          message: warningMsg,
        });

        touchedPrinciple = true;
      }

      // Snapshot current value before writing
      const { value: oldValue, metadata: oldMeta } = await this.kvGetWithMeta(op.key);
      await this.karmaRecord({
        event: "privileged_write",
        key: op.key,
        old_value: oldValue,
        new_value: op.value,
        op: op.op,
      });

      // Execute the operation
      if (op.op === "delete") {
        await this.kv.delete(op.key);
      } else if (op.op === "patch") {
        const current = await this.kvGet(op.key);
        if (typeof current !== "string") {
          throw new Error(`patch op: key "${op.key}" is not a string value`);
        }
        if (!current.includes(op.old_string)) {
          throw new Error(`patch op: old_string not found in "${op.key}"`);
        }
        if (current.indexOf(op.old_string) !== current.lastIndexOf(op.old_string)) {
          throw new Error(`patch op: old_string matches multiple locations in "${op.key}"`);
        }
        const patched = current.replace(op.old_string, op.new_string);
        await this.kvPut(op.key, patched, op.metadata);
      } else {
        await this.kvPut(op.key, op.value, op.metadata);
      }

      this.privilegedWriteCount++;

      // Audit trail for yama/niyama writes
      if (Brainstem.isPrincipleKey(op.key) && !Brainstem.isPrincipleAuditKey(op.key)) {
        const auditKey = `${op.key}:audit`;
        const existing = await this.kvGet(auditKey) || [];
        existing.push({
          date: new Date().toISOString(),
          model: this.lastCallModel,
          deliberation: op.deliberation,
          old_value: oldValue,
          new_value: op.op === 'delete' ? null : (op.value ?? null),
        });
        await this.kvPut(auditKey, existing);
      }

      // Alert on hook: key writes
      if (op.key.startsWith("hook:")) {
        await this.sendKernelAlert("hook_write",
          `Privileged write to ${op.key} in session ${this.sessionId}`);
      }
    }

    // Auto-reload cached config after privileged writes to config keys
    const touchedConfig = ops.some(op => configKeys.includes(op.key));
    if (touchedConfig) {
      if (ops.some(op => op.key === "config:defaults"))
        this.defaults = await this.kvGet("config:defaults");
      if (ops.some(op => op.key === "config:models"))
        this.modelsConfig = await this.kvGet("config:models");
      if (ops.some(op => op.key === "config:tool_registry"))
        this.toolRegistry = await this.kvGet("config:tool_registry");
      if (ops.some(op => op.key === "config:model_capabilities"))
        this.modelCapabilities = await this.kvGet("config:model_capabilities");
    }

    // Reload principle cache after writes
    if (touchedPrinciple) {
      await this.loadYamasNiyamas();
    }

    // Return warnings for principle writes
    if (principleWarnings.length > 0) {
      return { warnings: principleWarnings };
    }
  }

  // ── Kernel interface (replaces KernelRPC) ───────────────────
  // Returns a K object with the same API hooks expect from KernelRPC.
  // Includes sealed: key filtering for security.

  buildKernelInterface() {
    const brain = this;
    return {
      // LLM
      callLLM: async (opts) => brain.callLLM(opts),

      // KV reads (sealed keys blocked — hook code must not read quarantined data)
      kvGet: async (key) => {
        if (key.startsWith("sealed:")) return null;
        return brain.kvGet(key);
      },
      kvGetWithMeta: async (key) => {
        if (key.startsWith("sealed:")) return { value: null, metadata: null };
        return brain.kvGetWithMeta(key);
      },
      kvList: async (opts) => brain.kv.list(opts),

      // KV writes
      kvPutSafe: async (key, value, metadata) => brain.kvPutSafe(key, value, metadata),
      kvDeleteSafe: async (key) => brain.kvDeleteSafe(key),
      kvWritePrivileged: async (ops) => brain.kvWritePrivileged(ops),

      // Agent loop
      runAgentLoop: async (opts) => brain.runAgentLoop(opts),
      executeToolCall: async (tc) => brain.executeToolCall(tc),
      buildToolDefinitions: async (extra) => brain.buildToolDefinitions(extra),
      spawnSubplan: async (args, depth) => brain.spawnSubplan(args, depth),
      callHook: async (name, ctx) => brain.callHook(name, ctx),
      executeAction: async (step) => brain.executeAction(step),
      executeAdapter: async (adapterKey, input) => brain.executeAdapter(adapterKey, input),

      // Blocked communications
      listBlockedComms: async () => brain.listBlockedComms(),
      processCommsVerdict: async (id, verdict, revision) => brain.processCommsVerdict(id, verdict, revision),

      // Balance
      checkBalance: async (args) => brain.checkBalance(args),

      // Karma
      karmaRecord: async (entry) => brain.karmaRecord(entry),

      // Utility
      resolveModel: async (m) => brain.resolveModel(m),
      estimateCost: async (model, usage) => brain.estimateCost(model, usage),
      buildPrompt: async (template, vars) => brain.buildPrompt(template, vars),
      parseAgentOutput: async (content) => brain.parseAgentOutput(content),
      loadKeys: async (keys) => {
        const filtered = keys.filter(k => !k.startsWith("sealed:"));
        return brain.loadKeys(filtered);
      },
      getSessionCount: async () => brain.getSessionCount(),
      mergeDefaults: async (defaults, overrides) => brain.mergeDefaults(defaults, overrides),
      isSystemKey: async (key) => Brainstem.isSystemKey(key),
      getSystemKeyPatterns: async () => ({
        prefixes: Brainstem.SYSTEM_KEY_PREFIXES,
        exact: Brainstem.SYSTEM_KEY_EXACT,
      }),

      // KV operation gating (moved from hook-protect.js — immutable safety)
      applyKVOperation: async (op) => brain.applyKVOperation(op),

      // Config utilities (used by both act.js and reflect.js)
      getMaxSteps: async (state, role, depth) => Brainstem.getMaxSteps(state, role, depth),
      getReflectModel: async (state, depth) => Brainstem.getReflectModel(state, depth),

      // Proposal system (code change proposals)
      createProposal: async (request, sessionId, depth) => brain.createProposal(request, sessionId, depth),
      loadProposals: async (statusFilter) => brain.loadProposals(statusFilter),
      updateProposalStatus: async (id, newStatus, metadata) => brain.updateProposalStatus(id, newStatus, metadata),
      processProposalVerdicts: async (verdicts, depth) => brain.processProposalVerdicts(verdicts, depth),

      // State (read-only)
      getSessionId: async () => brain.sessionId,
      getSessionCost: async () => brain.sessionCost,
      getKarma: async () => brain.karma,
      getDefaults: async () => brain.defaults,
      getModelsConfig: async () => brain.modelsConfig,
      getModelCapabilities: async () => brain.modelCapabilities,
      getDharma: async () => brain.dharma,
      getToolRegistry: async () => brain.toolRegistry,
      getYamas: async () => brain.yamas,
      getNiyamas: async () => brain.niyamas,
      getPatronId: async () => brain.patronId,
      getPatronContact: async () => brain.patronContact,
      isPatronIdentityDisputed: async () => brain.patronIdentityDisputed,
      rotatePatronKey: async (newPublicKey, signature) => brain.rotatePatronKey(newPublicKey, signature),
      resolveContact: async (platform, platformUserId) => brain.resolveContact(platform, platformUserId),
      elapsed: async () => brain.elapsed(),
    };
  }

  // ── KV operation gating (from hook-protect.js — kernel safety) ──

  async applyKVOperation(op) {
    const key = op.key;

    // Truncate value for karma logging
    const valueSummary = op.value != null
      ? (typeof op.value === 'string'
          ? (op.value.length > 500 ? op.value.slice(0, 500) + '\u2026' : op.value)
          : JSON.stringify(op.value).slice(0, 500))
      : undefined;

    // Contact keys route through kvWritePrivileged (kernel-enforced approval rules)
    if (key.startsWith("contact:")) {
      try {
        await this.kvWritePrivileged([op]);
      } catch (err) {
        await this.karmaRecord({
          event: "modification_blocked", key, op: op.op,
          reason: err.message, attempted_value: valueSummary,
        });
      }
      return;
    }

    if (Brainstem.isSystemKey(key)) {
      await this.karmaRecord({
        event: "modification_blocked", key, op: op.op,
        reason: "system_key", attempted_value: valueSummary,
      });
      return;
    }

    // Agent keys: new keys can be created freely; existing keys need unprotected flag
    const { value: existing, metadata } = await this.kvGetWithMeta(key);
    if (existing !== null && !metadata?.unprotected) {
      await this.karmaRecord({
        event: "modification_blocked", key, op: op.op,
        reason: "protected_key", attempted_value: valueSummary,
      });
      return;
    }

    await this._applyKVOperationDirect(op);
  }

  async _applyKVOperationDirect(op) {
    switch (op.op) {
      case "put":
        await this.kvPutSafe(op.key, op.value, { unprotected: true, ...op.metadata });
        break;
      case "delete":
        await this.kvDeleteSafe(op.key);
        break;
      case "patch": {
        const current = await this.kvGet(op.key);
        if (typeof current !== "string") break;
        if (!current.includes(op.old_string)) break;
        if (current.indexOf(op.old_string) !== current.lastIndexOf(op.old_string)) break;
        const patched = current.replace(op.old_string, op.new_string);
        await this.kvPutSafe(op.key, patched, { unprotected: true, ...op.metadata });
        break;
      }
      case "rename": {
        const { value, metadata } = await this.kvGetWithMeta(op.key);
        if (value !== null) {
          await this.kvPutSafe(op.value, value, metadata);
          await this.kvDeleteSafe(op.key);
        }
        break;
      }
    }
  }

  // ── Proposal system (code change proposals — governor deploys accepted ones) ──

  static CODE_KEY_PATTERNS = ['tool:', 'hook:', 'provider:', 'channel:'];

  static isCodeKey(key) {
    return Brainstem.CODE_KEY_PATTERNS.some(p => key.startsWith(p)) && key.endsWith(':code');
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
    const nonCodeOps = request.ops.filter(op => !Brainstem.isCodeKey(op.key));
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

    await this.kvPut(`proposal:${id}`, proposal);
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
    await this.kvPut(`proposal:${id}`, record);
    await this.karmaRecord({ event: `proposal_${newStatus}`, proposal_id: id });
  }

  async processProposalVerdicts(verdicts, depth) {
    for (const v of verdicts || []) {
      const id = v.modification_id || v.proposal_id;
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
            await this.kvPut(`proposal:${id}`, record);
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
      await this.kvPut("deploy:pending", {
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
          const passed = Brainstem.evaluatePredicate(value, check.predicate, check.expected);
          return { passed, detail: `${check.key}${check.path ? '.' + check.path : ''} ${check.predicate} ${JSON.stringify(check.expected)} → actual: ${JSON.stringify(value)}` };
        }
        case "tool_call": {
          const result = await this.executeAction({
            tool: check.tool, input: check.input || {}, id: `check_${check.tool}`,
          });
          if (check.assert) {
            const passed = Brainstem.evaluatePredicate(result, check.assert.predicate, check.assert.expected);
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
    // 1. Detect platform kill from previous session
    await this.detectPlatformKill();

    // 2. Meta-safety check (3 consecutive crashes → signal governor + fallback)
    const hookSafe = await this.checkHookSafety();

    // 3. Execute hook or fallback
    if (hookSafe) {
      await this.executeHook();
    } else {
      await this.wake();
    }
  }

  async detectPlatformKill() {
    const activeSession = await this.kvGet("kernel:active_session");
    if (!activeSession) return;

    // Previous session was platform-killed — inject into last_sessions
    const history = await this.kvGet("kernel:last_sessions") || [];
    history.unshift({ id: activeSession, outcome: "killed", ts: new Date().toISOString() });
    while (history.length > 5) history.pop();
    await this.kvPut("kernel:last_sessions", history);

    // Clean up the stale marker
    await this.kv.delete("kernel:active_session");
  }

  async checkHookSafety() {
    const history = await this.kvGet("kernel:last_sessions") || [];
    if (history.length < 3) return true;

    const last3 = history.slice(0, 3);
    const allBad = last3.every(s => s.outcome === "crash" || s.outcome === "killed");
    if (!allBad) return true;

    // Tripwire fires — signal governor to rollback
    await this.kvPut("deploy:rollback_requested", {
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
    // Write active session marker (catches platform kills)
    await this.kvPut("kernel:active_session", this.sessionId);

    let outcome = "clean";
    try {
      await this.runWake();
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

  // Wake orchestration — timing, crash detection, dispatch to act or reflect
  async runWake() {
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
      // 0. Check if it's actually time to wake up
      const wakeConfig = await this.kvGet("wake_config");
      if (wakeConfig?.next_wake_after) {
        if (Date.now() < new Date(wakeConfig.next_wake_after).getTime()) {
          return { skipped: true, reason: "not_time_yet" };
        }
      }

      // 1. Crash detection
      const crashData = await this._detectCrash();

      // 2. Load ground truth
      const balances = await this.checkBalance({});

      // 3. Reload core state from KV
      defaults = await this.kvGet("config:defaults");
      this.defaults = defaults;
      state.defaults = defaults;
      const lastReflect = await this.kvGet("last_reflect");

      // 4. Merge with defaults
      const config = this.mergeDefaults(defaults, wakeConfig);

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
      const effort = Brainstem.evaluateTripwires(config, { balances });

      // 7. Load context keys
      const loadKeys = lastReflect?.next_orient_context?.load_keys
        || defaults?.memory?.default_load_keys
        || [];
      const additionalContext = await this.loadKeys(
        loadKeys.filter(k => !k.startsWith("sealed:"))
      );

      // 8. Build context
      const context = {
        balances, lastReflect, additionalContext,
        effort, reflectDepth,
        crashData,
      };

      // 9. Record session start
      await this.karmaRecord({
        event: "session_start",
        session_id: this.sessionId,
        effort,
        crash_detected: !!crashData,
        balances,
      });

      // 10. Run session or reflect
      if (reflectDepth > 0) {
        const { runReflect } = this.HOOKS.reflect || {};
        if (!runReflect) throw new Error("No runReflect in HOOKS.reflect");
        await runReflect(K, state, reflectDepth, context);
      } else {
        const { runSession } = this.HOOKS.act || {};
        if (!runSession) throw new Error("No runSession in HOOKS.act");
        await runSession(K, state, context, config);
      }

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
    const stale = await this.kvGet("kernel:active_session");
    if (!stale) return null;
    if (stale === this.sessionId) return null;

    const deadKarma = await this.kvGet(`karma:${stale}`);
    return {
      dead_session_id: stale,
      karma: deadKarma,
      last_entry: Array.isArray(deadKarma) ? deadKarma[deadKarma.length - 1] : null,
    };
  }

  // ── Tripwire evaluation ───────────────────────────────────

  static evaluateTripwires(config, liveData) {
    const alerts = config.alerts || [];
    let effort = config.default_effort || config.wake?.default_effort || "low";
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
    if (role === 'orient') return defaults?.execution?.max_steps?.orient || 12;
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
    return defaults?.deep_reflect?.model || defaults?.orient?.model;
  }

  async updateSessionOutcome(outcome) {
    const history = await this.kvGet("kernel:last_sessions") || [];
    history.unshift({ id: this.sessionId, outcome, ts: new Date().toISOString() });
    while (history.length > 5) history.pop();
    await this.kvPut("kernel:last_sessions", history);
  }

  async runMinimalFallback() {
    await this.sendKernelAlert("hook_reset",
      "Hook execution failed. Running minimal recovery mode.");

    const hardcodedPrompt = `You are Swayambhu in recovery mode. Your wake hook has been reset due to repeated failures. Check your balances and report your status. Do not attempt complex operations.`;

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

    // Write session counter via internal kvPut
    const count = await this.getSessionCount();
    await this.kvPut("session_counter", count + 1);
  }

  // ── Wake cycle ──────────────────────────────────────────────

  // ── Minimal fallback (no hook:wake:code in KV) ─────────────
  // Used when no hook is loaded, or after the hook safety tripwire fires.
  // Runs a hardcoded recovery session — does NOT load prompt:orient
  // (could be corrupted). Does NOT process kv_operations from output.

  async wake() {
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
    const rawPubKey = Brainstem.parseSSHEd25519(pubKeyStr);
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
    Brainstem.parseSSHEd25519(newPublicKey);

    // Write directly to KV binding — bypasses kvPut immutability guard
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
      ctx.kv = this._buildScopedKV(toolName, meta.kv_access);
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
    return { ...input, secrets };
  }

  // ── Scoped KV wrapper (replaces Worker Loader ScopedKV RPC) ───

  _buildScopedKV(toolName, kvAccess) {
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
        const resolved = `${scope}${key}`;  // writes always scoped
        const fmt = typeof value === "string" ? "text" : "json";
        await kv.put(resolved, typeof value === "string" ? value : JSON.stringify(value), {
          metadata: { type: "tooldata", format: fmt, updated_at: new Date().toISOString() },
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
    const costLimit = budgetCap ?? budget?.max_cost;
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
      request: msgs,
      response: result.content || null,
      tool_calls: result.toolCalls || [],
      tools_available: tools?.map(t => ({ name: t.function?.name, description: t.function?.description })) || [],
    });

    this.sessionCost += cost;
    this.sessionLLMCalls++;
    this.lastCallModel = model;

    return { content: result.content, usage: result.usage, cost, toolCalls: result.toolCalls };
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

    const msg = data.choices?.[0]?.message;
    const usage = data.usage || {};
    return {
      ok: true,
      content: msg?.content || "",
      usage,
      toolCalls: msg?.tool_calls || null,
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
            model: { type: 'string', description: 'Model alias (default: haiku)' },
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

        if (gateResult.verdict === 'block' || gateResult.verdict === 'queue') {
          await this.queueBlockedComm(name, args, commMeta, gateResult.reasoning, gateResult);
          return { error: `Communication ${gateResult.verdict === 'queue' ? 'queued for review' : 'blocked'}: ${gateResult.reasoning}` };
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
                await this.kvPut(quarantineKey, {
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
    const model = this.resolveModel(args.model || await this.getFallbackModel() || 'haiku');
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

    try {
      for (let i = 0; i < maxSteps; i++) {
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
    const found = this._findBraces(content, "{", "}") || this._findBraces(content, "[", "]");
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

  async kvPut(key, value, metadata = {}) {
    // Protect immutable keys
    if (key === "dharma" || Brainstem.IMMUTABLE_KEYS.includes(key)) {
      throw new Error(`Cannot write "${key}" — immutable key`);
    }

    // System keys cannot be marked unprotected
    if (Brainstem.isSystemKey(key)) delete metadata.unprotected;

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
      modification_staged:    { type: "modification", format: "json" },
      modification_snapshot: { type: "modification", format: "json" },
      viveka:     { type: "wisdom", format: "json" },
      prajna:     { type: "wisdom", format: "json" },
      git_pending:    { type: "git_sync", format: "json" },
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
    const context = {};
    for (const key of keys) {
      context[key] = await this.kvGet(key);
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
    return `You are executing a subgoal. You have tools available via function calling.

Goal: {{goal}}

Use your tools to accomplish this goal. When done, produce a JSON object
with a "result" field summarizing what you accomplished.

Budget: max {{maxSteps}} turns, max ${{maxCost}}.`;
  }

  elapsed() {
    return Date.now() - this.startTime;
  }
}

export { Brainstem };
