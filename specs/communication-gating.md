# Communication Gating — Implementation Plan

## Design

Every outbound communication tool call is intercepted by the kernel before execution. The kernel runs a focused LLM gate call — informed by dharma, yamas, and accumulated viveka — that judges whether the message should be sent, revised, or blocked. The kernel hardcodes the mechanism; viveka encodes the policy.

### What the kernel hardcodes

1. **Interception.** Tools with `communication` in their meta are intercepted in `executeToolCall` before isolate execution. Not bypassable through self-modification.

2. **Model gate.** The gate LLM call requires `comms_gate_capable: true` in `config:models`. If the current session model lacks this, the message is queued for deep reflect. Same pattern as `yama_capable`.

3. **Mechanical floor.** If the agent is initiating contact (no reply indicator) and no `viveka:contact:*` entry exists for the recipient, the kernel blocks without consulting the gate model. No wisdom about someone = no initiating contact.

4. **Karma logging.** Every communication attempt — sent, revised, blocked, queued — is recorded with full context.

### What viveka encodes

Relationship knowledge, channel norms, and communication discernment live as viveka entries:

```
viveka:contact:{identifier}     → relationship, tone, latitude
viveka:channel:{channel}:{id}   → channel norms, audience, appropriateness
viveka:comms:{topic}            → general communication wisdom
```

Created and refined by deep reflect through the Modification Protocol (wisdom type).

### The gate call

A single `callLLM` call (not an agent loop). The hardcoded gate prompt receives viveka entries + communication context. Dharma and yamas are auto-injected by `callLLM`. The model outputs `{ verdict, reasoning, revision? }`.

### Chat system

The chat system (`hook-chat.js`) sends replies via adapter, not through `executeToolCall`. Chat is always responding to inbound messages with a per-person configured model. **Chat is not gated by this system.** Future work could add chat-side gating via a kernel RPC method, but the risk profile is different (always responding, never initiating).

---

## Phase 1: Tool meta — identify communication tools

### tools/send_slack.js

Add `communication` field to meta:

```javascript
export const meta = {
  secrets: ["SLACK_BOT_TOKEN", "SLACK_CHANNEL_ID"],
  kv_access: "none",
  timeout_ms: 10000,
  communication: {
    channel: "slack",
    recipient_field: "channel",   // which arg identifies the recipient
    reply_field: null,            // no threading support yet
  },
};
```

`recipient_field: "channel"` — the kernel reads `args.channel` to identify the recipient. Falls back to the tool's default channel (from secrets) if absent.

### tools/send_email.js

```javascript
export const meta = {
  secrets: ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"],
  kv_access: "none",
  timeout_ms: 15000,
  communication: {
    channel: "email",
    recipient_field: "to",        // email address
    reply_field: "reply_to_id",   // presence means responding, absence means initiating
  },
};
```

### No seed script changes needed

Tool meta is read from the tool files by the seed script (`mod.meta`). The `communication` field propagates to `tool:{name}:meta` in KV automatically.

---

## Phase 2: Model capability — `comms_gate_capable`

### scripts/seed-local-kv.mjs — config:models

Add `comms_gate_capable: true` to models with sufficient judgment for communication gating:

```javascript
// Opus — yes
{ id: "anthropic/claude-opus-4.6", ..., comms_gate_capable: true },
// Sonnet — yes
{ id: "anthropic/claude-sonnet-4.6", ..., comms_gate_capable: true },
// Haiku — no (cheap model, insufficient judgment)
{ id: "anthropic/claude-haiku-4.5", ... },
// DeepSeek — no
{ id: "deepseek/deepseek-v3.2", ... },
```

### brainstem.js — capability check method

After `isNiyamaCapable` (line ~356), add:

```javascript
isCommsGateCapable(modelId) {
  const model = this.modelsConfig?.models?.find(m => m.id === modelId || m.alias === modelId);
  return !!model?.comms_gate_capable;
}
```

---

## Phase 3: System key prefix + blocked queue

### brainstem.js — SYSTEM_KEY_PREFIXES (line 303)

Add `'comms_blocked:'` to the prefix list so blocked comm records are protected system keys (writable via `kvWritePrivileged` only):

```javascript
static SYSTEM_KEY_PREFIXES = [
  'prompt:', 'config:', 'tool:', 'provider:', 'secret:',
  'modification_staged:', 'modification_snapshot:', 'hook:', 'doc:', 'git_pending:',
  'yama:', 'niyama:',
  'viveka:', 'prajna:',
  'comms_blocked:',
];
```

### brainstem.js — metadata type mapping (line ~1565)

Add `comms_blocked` to the auto-metadata type mapping:

```javascript
comms_blocked: "comms",
```

### brainstem.js — queue methods

Add near the communication gate section:

```javascript
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
    recipient: this.resolveRecipient(args, meta),
    mode: this.resolveCommsMode(args, meta),
    reason,
    gate_verdict: gateResult,
    session_id: this.sessionId,
    model: this.lastCallModel,
    timestamp: new Date().toISOString(),
  };
  await this.kvPut(`comms_blocked:${id}`, JSON.stringify(record));
  await this.karmaRecord({
    event: "comms_blocked",
    id,
    tool: toolName,
    channel: meta.communication.channel,
    recipient: record.recipient,
    reason,
  });
  return id;
}
```

---

## Phase 4: Viveka loading for gate context

### brainstem.js — load relevant viveka entries

```javascript
async loadCommsViveka(recipient, channel) {
  const entries = {};
  // Load all viveka:contact:*, viveka:channel:*, viveka:comms:* entries
  for (const prefix of ['viveka:contact:', 'viveka:channel:', 'viveka:comms:']) {
    const result = await this.kv.list({ prefix });
    for (const { name: key } of result.keys) {
      const value = await this.kvGet(key);
      if (value !== null) entries[key] = value;
    }
  }
  return entries;
}
```

This loads all communication-relevant viveka. In early stages the count is small. If it grows large, optimize with recipient-specific prefix matching later.

### brainstem.js — helper: resolve recipient and mode

```javascript
resolveRecipient(args, meta) {
  const comm = meta.communication;
  if (!comm) return null;
  return args[comm.recipient_field] || null;
}

resolveCommsMode(args, meta) {
  const comm = meta.communication;
  if (!comm?.reply_field) return 'initiating';
  return args[comm.reply_field] ? 'responding' : 'initiating';
}
```

---

## Phase 5: Communication gate — the core

### brainstem.js — hardcoded gate prompt

Add as a static constant near the top of the class:

```javascript
static COMMS_GATE_PROMPT = `You are evaluating an outbound communication attempt. Based on your principles and the wisdom context provided, determine whether this message should be sent.

Consider:
- Standing: is this a response to someone who contacted you, or are you initiating?
- Recipient: what does your accumulated wisdom say about them and your relationship?
- Content: is the message appropriate for this recipient and channel?
- Tone: does it match what this context requires?
- Authority: do you have standing to communicate this in this context?

[COMMUNICATION WISDOM]
{{viveka}}
[/COMMUNICATION WISDOM]

Respond with JSON only — no other text:
{
  "verdict": "send" | "revise" | "block",
  "reasoning": "brief explanation of your judgment",
  "revision": { "text": "revised message text" }
}

"revision" is only required when verdict is "revise". For "send", include reasoning only. For "block", explain why.`;
```

Note: `callLLM` automatically prepends dharma + yamas + niyamas to the system prompt. The gate prompt only needs viveka + instructions.

### brainstem.js — gate method

Insert in `executeToolCall`, after argument parsing and before the `spawn_subplan` / `check_balance` special cases:

```javascript
async communicationGate(toolName, args, meta) {
  const comm = meta.communication;
  const recipient = this.resolveRecipient(args, meta);
  const mode = this.resolveCommsMode(args, meta);

  // 1. Mechanical floor: initiating + no viveka about recipient → block
  if (mode === 'initiating') {
    const contactKeys = await this.kv.list({ prefix: 'viveka:contact:' });
    const hasViveka = contactKeys.keys.some(k => {
      const entry = k.name.replace('viveka:contact:', '');
      // Match if recipient contains the viveka identifier or vice versa
      return recipient && (
        recipient.toLowerCase().includes(entry.toLowerCase()) ||
        entry.toLowerCase().includes(recipient.toLowerCase())
      );
    });
    if (!hasViveka) {
      return {
        verdict: 'block',
        reasoning: `No viveka about recipient "${recipient}" — cannot initiate contact with unknown entity`,
        mechanical: true,
      };
    }
  }

  // 2. Model gate: current model must be comms_gate_capable
  const currentModel = this.lastCallModel || this.defaults?.orient?.model;
  if (!this.isCommsGateCapable(currentModel)) {
    return {
      verdict: 'queue',
      reasoning: `Current model ${currentModel} is not comms_gate_capable — queuing for deep reflect review`,
    };
  }

  // 3. Load viveka context
  const viveka = await this.loadCommsViveka(recipient, comm.channel);
  const vivekaBlock = Object.entries(viveka).length > 0
    ? Object.entries(viveka).map(([k, v]) => {
        const text = typeof v === 'object' ? (v.text || JSON.stringify(v)) : String(v);
        return `[${k}]\n${text}\n[/${k}]`;
      }).join('\n')
    : '(No accumulated wisdom about communication contexts yet. Be conservative.)';

  // 4. Build gate prompt with viveka injected
  const gatePrompt = Brainstem.COMMS_GATE_PROMPT.replace('{{viveka}}', vivekaBlock);

  // 5. Build context message
  const contextMessage = JSON.stringify({
    tool: toolName,
    channel: comm.channel,
    mode,
    recipient: recipient || '(default channel)',
    message_content: args.text || args.body || '',
    subject: args.subject || null,
    is_reply: mode === 'responding',
    reply_to: args[comm.reply_field] || null,
  });

  // 6. Call gate LLM
  const gateResult = await this.callLLM({
    model: currentModel,
    effort: 'low',
    maxTokens: 500,
    systemPrompt: gatePrompt,
    messages: [{ role: 'user', content: contextMessage }],
    step: `comms_gate:${toolName}`,
  });

  // 7. Parse verdict
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
    // Parse failure → block (safe default)
    return {
      verdict: 'block',
      reasoning: 'Gate response was not valid JSON — blocking as safety default',
      raw: gateResult.content,
    };
  }
}
```

### brainstem.js — modify executeToolCall (line 1283)

Insert the gate interception after arg parsing (line 1289), before the `spawn_subplan` check (line 1294):

```javascript
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

  // ── Communication gate (kernel-enforced) ──────────────────
  const toolMeta = await this._getToolMeta(name);
  if (toolMeta?.communication) {
    const gateResult = await this.communicationGate(name, args, toolMeta);

    if (gateResult.verdict === 'block') {
      await this.queueBlockedComm(name, args, toolMeta, gateResult.reasoning, gateResult);
      return { error: `Communication blocked: ${gateResult.reasoning}` };
    }

    if (gateResult.verdict === 'queue') {
      await this.queueBlockedComm(name, args, toolMeta, gateResult.reasoning, gateResult);
      return { error: `Communication queued for deep reflect review: ${gateResult.reasoning}` };
    }

    if (gateResult.verdict === 'revise' && gateResult.revision) {
      // Apply revision — only revise the message content, not structural args
      if (gateResult.revision.text) {
        if (args.text !== undefined) args.text = gateResult.revision.text;
        if (args.body !== undefined) args.body = gateResult.revision.text;
      }
      await this.karmaRecord({
        event: 'comms_revised',
        tool: name,
        recipient: this.resolveRecipient(args, toolMeta),
        reasoning: gateResult.reasoning,
      });
    }

    if (gateResult.verdict === 'send') {
      await this.karmaRecord({
        event: 'comms_approved',
        tool: name,
        recipient: this.resolveRecipient(args, toolMeta),
        reasoning: gateResult.reasoning,
      });
    }
  }
  // ── End communication gate ────────────────────────────────

  if (name === 'spawn_subplan') { ... }  // existing code continues
```

### brainstem.js — _getToolMeta helper

The gate needs tool meta before `executeAction` loads it. Add a lightweight cached meta loader:

```javascript
async _getToolMeta(toolName) {
  // Use existing cache if available
  if (this.toolsCache[`meta:${toolName}`] !== undefined) {
    return this.toolsCache[`meta:${toolName}`];
  }
  const meta = await this.kvGet(`tool:${toolName}:meta`);
  this.toolsCache[`meta:${toolName}`] = meta || null;
  return meta || null;
}
```

---

## Phase 6: KernelRPC — expose blocked comms methods

### brainstem.js — KernelRPC class

Add methods for the hook to read and process blocked comms:

```javascript
// In KernelRPC extends WorkerEntrypoint:

async listBlockedComms() {
  const result = await this.brainstem.kv.list({ prefix: 'comms_blocked:' });
  const entries = [];
  for (const { name: key } of result.keys) {
    const value = await this.brainstem.kvGet(key);
    if (value) entries.push(typeof value === 'string' ? JSON.parse(value) : value);
  }
  return entries;
}

async processCommsVerdict(id, verdict, revision) {
  const key = `comms_blocked:${id}`;
  const raw = await this.brainstem.kvGet(key);
  if (!raw) return { error: `No blocked comm found: ${id}` };
  const record = typeof raw === 'string' ? JSON.parse(raw) : raw;

  if (verdict === 'send' || verdict === 'revise_and_send') {
    let args = record.args;
    if (verdict === 'revise_and_send' && revision?.text) {
      args = { ...args };
      if (args.text !== undefined) args.text = revision.text;
      if (args.body !== undefined) args.body = revision.text;
    }
    // Execute directly via executeAction — bypasses gate (already approved by deep reflect)
    const result = await this.brainstem.executeAction({
      tool: record.tool,
      input: args,
      id: `comms_verdict_${id}`,
    });
    await this.brainstem.karmaRecord({
      event: 'comms_verdict_sent',
      id,
      tool: record.tool,
      recipient: record.recipient,
      verdict,
      revised: verdict === 'revise_and_send',
    });
    // Delete the blocked record
    await this.brainstem.kv.delete(key);
    return { ok: true, result };
  }

  if (verdict === 'drop') {
    await this.brainstem.karmaRecord({
      event: 'comms_verdict_dropped',
      id,
      tool: record.tool,
      recipient: record.recipient,
      reason: revision?.reason || 'dropped by deep reflect',
    });
    await this.brainstem.kv.delete(key);
    return { ok: true, dropped: true };
  }

  return { error: `Unknown verdict: ${verdict}` };
}
```

---

## Phase 7: Deep reflect integration

### hook-reflect.js — gatherReflectContext (line ~155)

Load blocked comms queue and add to template vars:

```javascript
// After loading modifications, before returning templateVars:
const blockedComms = await K.listBlockedComms();
templateVars.blockedComms = blockedComms.length > 0
  ? JSON.stringify(blockedComms, null, 2)
  : '(none)';
```

### hook-reflect.js — applyReflectOutput (line ~208)

After modification verdicts processing (line ~221), add comms verdict processing:

```javascript
// 2b. Communication verdicts
if (output.comms_verdicts) {
  for (const cv of output.comms_verdicts) {
    await K.processCommsVerdict(cv.id, cv.verdict, cv.revision);
  }
}
```

### prompts/deep-reflect.md

Add blocked comms section after the inflight modifications section (line ~43):

```markdown
## Blocked communications

{{blockedComms}}

These messages were attempted by a session but blocked by the communication gate. For each, decide:
- **send** — the message was appropriate, send it as-is
- **revise_and_send** — right intent, wrong execution; provide a revision
- **drop** — should not have been attempted; log and discard

If a message was blocked because the recipient has no viveka entry, consider whether to create one via a wisdom modification request. Adding a viveka:contact entry means future sessions can communicate with this recipient (subject to gate judgment).
```

Add `comms_verdicts` to the output schema (line ~254):

```json
"comms_verdicts": [
  {"id": "cb_...", "verdict": "send"},
  {"id": "cb_...", "verdict": "revise_and_send", "revision": {"text": "revised message"}},
  {"id": "cb_...", "verdict": "drop", "revision": {"reason": "..."}}
],
```

---

## Phase 8: Seed initial viveka entries

### scripts/seed-local-kv.mjs

After the existing KV seeding, add seed viveka entries:

```javascript
// ── Communication wisdom (seed) ──────────────────────────────

console.log("--- Communication wisdom ---");

await put("viveka:contact:swami", {
  text: "Creator and custodian. Inner circle. Full communication latitude — casual, experimental, direct. Can discuss anything including system internals, budget, failures.",
  type: "viveka",
  created: new Date().toISOString(),
  sources: [{ session: "seed", depth: 0, turn: 0, topic: "Initial seed — foundational relationship" }],
}, "json", "Viveka: relationship with creator");

await put("viveka:comms:defaults", {
  text: "When in doubt, do not send. Silence is safer than a poorly judged message. A blocked message can be reviewed and sent later; a sent message cannot be unsent. Be especially cautious when initiating contact — responding carries implicit standing, initiating requires explicit justification.",
  type: "viveka",
  created: new Date().toISOString(),
  sources: [{ session: "seed", depth: 0, turn: 0, topic: "Initial seed — conservative communication baseline" }],
}, "json", "Viveka: default communication stance");
```

---

## Phase 9: Prompt updates

### prompts/orient.md

Add a note about communication gating so the agent understands why sends might be blocked:

```markdown
### Communication gating

Every outbound message passes through a kernel-enforced gate before sending. The gate evaluates your message against your accumulated communication wisdom (`viveka:contact:*`, `viveka:comms:*`). Messages may be sent as-is, revised, or blocked.

If a message is blocked, it is queued for deep reflect review. Do not attempt to work around blocks — they exist because the gate judged that the message needs higher-level review.

If you are initiating contact with someone you have no viveka entry for, the message will be mechanically blocked. Build relationships through viveka entries during deep reflect.
```

---

## Phase 10: Tests

### tests/brainstem.test.js

New test group: "Communication gate":

1. **identifies communication tools** — tool with `communication` in meta is detected, tool without is not
2. **mechanical floor blocks initiating to unknown** — initiating + no viveka:contact entry → blocked without LLM call
3. **mechanical floor allows responding to unknown** — responding (reply_field present) passes mechanical floor
4. **model gate queues when model not capable** — non-comms_gate_capable model → queued
5. **gate call approves appropriate message** — mock LLM returns `{verdict: "send"}` → tool executes
6. **gate call blocks inappropriate message** — mock LLM returns `{verdict: "block"}` → tool does not execute, record queued
7. **gate call revises message** — mock LLM returns `{verdict: "revise", revision: {text: "..."}}` → args updated
8. **gate parse failure defaults to block** — mock LLM returns non-JSON → blocked
9. **blocked comm record written to KV** — verify `comms_blocked:{id}` written with full context
10. **processCommsVerdict send** — loads record, executes tool, deletes record
11. **processCommsVerdict drop** — deletes record, logs karma
12. **isCommsGateCapable** — returns true for opus/sonnet, false for haiku/deepseek

### tests/wake-hook.test.js

Add tests for deep reflect blocked comms integration:

1. **blocked comms loaded into reflect context** — verify templateVars includes blockedComms
2. **comms_verdicts processed from reflect output** — verify processCommsVerdict called for each verdict

---

## Phase 11: brainstem-dev.js

The dev subclass overrides `_executeTool` and `callWithCascade` but NOT `executeToolCall`. Since the gate lives in `executeToolCall`, it works in dev mode without changes.

Verify: `_getToolMeta` uses `this.kvGet` which works in both prod and dev. `communicationGate` calls `this.callLLM` which DevBrainstem overrides to use direct fetch. No dev-specific changes needed.

---

## File change summary

| File | Action | What changes |
|------|--------|-------------|
| `tools/send_slack.js` | EDIT | Add `communication` field to meta |
| `tools/send_email.js` | EDIT | Add `communication` field to meta |
| `brainstem.js` | EDIT | Add gate logic, capability check, queue methods, COMMS_GATE_PROMPT, modify executeToolCall |
| `scripts/seed-local-kv.mjs` | EDIT | Add `comms_gate_capable` to models, seed viveka entries |
| `hook-reflect.js` | EDIT | Load blocked comms, process comms_verdicts |
| `prompts/deep-reflect.md` | EDIT | Add blocked comms section + comms_verdicts schema |
| `prompts/orient.md` | EDIT | Add communication gating note |
| `tests/brainstem.test.js` | EDIT | Add communication gate tests |
| `tests/wake-hook.test.js` | EDIT | Add blocked comms reflect tests |

## Verification

1. `npm test` — all existing tests pass + new gate tests
2. `source .env && bash scripts/start.sh --reset-all-state --wake --set orient.model=deepseek` — orient with cheap model attempts send_slack → queued (deepseek not comms_gate_capable)
3. `node scripts/read-kv.mjs comms_blocked` — verify blocked record in KV
4. `node scripts/read-kv.mjs viveka:` — verify seed entries
5. `source .env && bash scripts/start.sh --reset-all-state --wake` — orient with opus attempts send_slack → gate call runs, sends or blocks based on viveka

## Future work (not in this plan)

- **Chat system gating**: Add a kernel RPC method (`K.commsGate(toolName, args)`) that `hook-chat.js` calls before sending replies. Lower priority since chat is always responding.
- **Thread-level standing**: Track thread participation so that agents maintain standing across a thread after being mentioned once.
- **Gate caching**: Within a session, skip the gate call for subsequent messages to the same recipient+channel after first approval. Adds cost savings but reduces per-message scrutiny.
- **Slack threading**: Add `thread_ts` support to `send_slack` tool so Slack messages can be identified as replies.
- **`in_reply_to` verification**: Verify that reply indicators reference real inbound messages (prevents the LLM from fabricating reply context to bypass the initiating check).
