// Swayambhu Communication — unified turn processor.
// All communication flows through runTurn: one brain, one state, one prompt.
// Ingress normalizers (ingestInbound, ingestInternal) create CommTurns.
// The scheduled tick is the single writer — fetch only writes events.

// ── LLM tools for communication ───────────────────────

const SEND_TOOL = {
  type: "function",
  function: {
    name: "send",
    description: "Send a message to the contact. Use this for every outbound reply.",
    parameters: {
      type: "object",
      properties: { message: { type: "string", description: "Message to send" } },
      required: ["message"],
    },
  },
};

const HOLD_TOOL = {
  type: "function",
  function: {
    name: "hold",
    description: "Defer delivery. Use when timing is wrong or you need to bundle with other updates.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Why you are holding" },
        release_after: { type: "string", description: "ISO8601 timestamp to release (optional)" },
      },
      required: ["reason"],
    },
  },
};

const DISCARD_TOOL = {
  type: "function",
  function: {
    name: "discard",
    description: "Drop this update without sending. Use when the content is not worth communicating.",
    parameters: {
      type: "object",
      properties: { reason: { type: "string", description: "Why you are discarding" } },
      required: ["reason"],
    },
  },
};

const KV_QUERY_TOOL = {
  type: "function",
  function: {
    name: "kv_query",
    description: "Read a KV value. Use to look up tasks, session history, contact info.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "KV key to read" },
        path: { type: "string", description: "Dot-bracket path to drill in" },
      },
      required: ["key"],
    },
  },
};

const KV_MANIFEST_TOOL = {
  type: "function",
  function: {
    name: "kv_manifest",
    description: "List KV keys by prefix.",
    parameters: {
      type: "object",
      properties: {
        prefix: { type: "string", description: "Key prefix" },
        limit: { type: "number", description: "Max keys (default 20)" },
      },
    },
  },
};

const TRIGGER_SESSION_TOOL = {
  type: "function",
  function: {
    name: "trigger_session",
    description: "Signal that the conversation has an actionable request. Only call when you have enough detail to act on.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "What the session should work on" },
      },
      required: ["summary"],
    },
  },
};

const INTERNAL_MECHANICS_PATTERNS = [
  ["carry-forward", /\bcarry[- ]forward\b/i],
  ["desire-key", /\bdesire:[a-z0-9._-]+\b/i],
  ["pattern-key", /\bpattern:[a-z0-9._-]+\b/i],
  ["tactic-key", /\btactic:[a-z0-9._-]+\b/i],
  ["principle-key", /\bprinciple:[a-z0-9._-]+\b/i],
  ["identification-key", /\bidentification:[a-z0-9._-]+\b/i],
  ["no_action", /\bno_action\b/i],
  ["idle-streak", /\bidle[- ]streak\b/i],
  ["circuit-breaker", /\bcircuit[- ]breaker\b/i],
  ["dev-loop", /\bdev[_-]?loop\b/i],
  ["reflect-key", /\breflect:\d+:/i],
  ["last-reflect", /\blast_reflect\b/i],
  ["session-request-key", /\bsession_request:[a-z0-9._-]+\b/i],
  ["kv", /\bKV keys?\b|\bkey names?\b/i],
];

function detectInternalMechanicsLeak(text) {
  const message = String(text || "");
  if (!message.trim()) return [];
  return INTERNAL_MECHANICS_PATTERNS
    .filter(([, pattern]) => pattern.test(message))
    .map(([marker]) => marker);
}

async function applyOutboundMessageGuard(K, conversationId, outcome, { mode }) {
  if (outcome?.action !== "sent") return outcome;
  const markers = detectInternalMechanicsLeak(outcome.message);
  if (!markers.length) return outcome;
  await K.karmaRecord({
    event: "comms_internal_mechanics_blocked",
    conversation: conversationId,
    mode,
    reason: outcome.reason,
    markers,
  });
  return { action: "discarded", reason: "internal_mechanics_blocked" };
}

// ── runTurn: the unified conversation processor ───────

export async function runTurn(K, conversationId, turns) {
  // 1. Load conversation state
  let conv = await K.kvGet(conversationId) || {
    messages: [],
    karma: [],
    inbound_cost: 0,
    internal_cost: 0,
    created_at: new Date().toISOString(),
    turn_count: 0,
  };
  if (!conv.karma) conv.karma = [];
  if (conv.inbound_cost === undefined) conv.inbound_cost = conv.total_cost || 0;
  if (conv.internal_cost === undefined) conv.internal_cost = 0;

  // 2. Load config
  const defaults = await K.getDefaults();
  const chatDefaults = defaults?.chat || {};

  // Determine source type for this batch
  const hasInbound = turns.some(t => t.source === "inbound");
  const hasInternal = turns.some(t => t.source === "internal");
  const costKey = hasInbound ? "inbound_cost" : "internal_cost";

  // Budget check
  const maxCost = chatDefaults.max_cost_per_conversation || 0.50;
  if (conv[costKey] >= maxCost) {
    return { action: "error", error: "budget_exhausted", retryable: false };
  }

  // 3. Sort: internal first, then inbound
  const sorted = [...turns].sort((a, b) => {
    if (a.source === "internal" && b.source === "inbound") return -1;
    if (a.source === "inbound" && b.source === "internal") return 1;
    return 0;
  });

  // 4. Build system prompt with internal context
  const chatPrompt = await K.kvGet("prompt:communication") || "You are in a live communication session. Respond conversationally.";
  const contact = turns[0]?.reply_target?.platform
    ? await K.resolveContact(turns[0].reply_target.platform, turns[0].reply_target.channel)
    : null;
  const contactContext = contact ? `\n\nYou are chatting with:\n${JSON.stringify(contact)}` : "";

  // Render internal turns as agent context block
  const internalTurns = sorted.filter(t => t.source === "internal");
  const agentUpdates = internalTurns.length > 0
    ? "\n\n[AGENT UPDATES]\n" + internalTurns.map(t =>
        `- [${t.intent || "update"}] ${t.content}`
      ).join("\n") + "\n\nDecide whether to send, hold, or discard each update. Use the send tool to message the contact, hold to defer, or discard to drop."
    : "";

  const systemPrompt = (chatPrompt + contactContext + agentUpdates).trim();

  // Append inbound turns to message history
  const inboundTurns = sorted.filter(t => t.source === "inbound");
  for (const turn of inboundTurns) {
    conv.messages.push({
      role: "user",
      content: turn.content,
      userId: turn.metadata?.userId,
      ts: turn.metadata?.sentTs
        ? new Date(parseFloat(turn.metadata.sentTs) * 1000).toISOString()
        : new Date().toISOString(),
      sentTs: turn.metadata?.sentTs,
    });
  }

  // 5. Build tools
  const tools = [SEND_TOOL, HOLD_TOOL, DISCARD_TOOL, KV_QUERY_TOOL, KV_MANIFEST_TOOL];
  if (hasInbound) tools.push(TRIGGER_SESSION_TOOL);

  // 6. Call LLM (with tool loop for kv_query/kv_manifest)
  const model = await K.resolveModel(chatDefaults.model || defaults?.act?.model || "sonnet");
  const maxRounds = 3;
  let outcome = null;

  for (let i = 0; i < maxRounds; i++) {
    const response = await K.callLLM({
      model,
      effort: chatDefaults.effort || "low",
      maxTokens: chatDefaults.max_output_tokens || 1000,
      systemPrompt,
      messages: conv.messages,
      tools,
      step: `comms_${conv.turn_count}_r${i}`,
    });
    conv[costKey] += response.cost || 0;

    if (!response.toolCalls?.length) {
      // No tool call — default to hold (safer than send)
      outcome = { action: "held", reason: "no explicit send/hold/discard tool call" };
      break;
    }

    // Process tool calls
    const tc = response.toolCalls[0];
    const name = tc.function?.name;
    const args = JSON.parse(tc.function?.arguments || "{}");

    if (name === "send") {
      outcome = { action: "sent", message: args.message };
      break;
    }
    if (name === "hold") {
      outcome = { action: "held", reason: args.reason, release_after: args.release_after || null };
      break;
    }
    if (name === "discard") {
      outcome = { action: "discarded", reason: args.reason };
      break;
    }

    // kv_query, kv_manifest, trigger_session — execute and continue loop
    conv.messages.push({
      role: "assistant",
      content: response.content || null,
      tool_calls: response.toolCalls,
    });

    const results = await Promise.all(
      response.toolCalls.map(async (tc2) => {
        const n = tc2.function?.name;
        if (n === "trigger_session") {
          const mod = await import("./tools/trigger_session.js");
          const chatContext = {
            channel: turns[0].reply_target?.platform,
            userId: turns[0].metadata?.userId,
            contact,
            convKey: conversationId,
            chatConfig: chatDefaults,
          };
          return mod.execute({ ...JSON.parse(tc2.function?.arguments || "{}"), K, _chatContext: chatContext });
        }
        return K.executeToolCall(tc2).catch(err => ({ error: err.message }));
      })
    );

    for (let j = 0; j < response.toolCalls.length; j++) {
      conv.messages.push({
        role: "tool",
        tool_call_id: response.toolCalls[j].id,
        content: JSON.stringify(results[j]),
      });
    }
  }

  if (!outcome) {
    outcome = { action: "held", reason: "tool rounds exhausted without outcome" };
  }

  // 7. Execute outcome
  outcome = await applyOutboundMessageGuard(K, conversationId, outcome, {
    mode: hasInbound ? "inbound" : "internal",
  });

  if (outcome.action === "sent") {
    const replyTarget = turns[0].reply_target;
    await K.executeAdapter(replyTarget.platform, {
      text: outcome.message,
      channel: replyTarget.channel,
      thread_ts: replyTarget.thread_ts || undefined,
    });
    conv.messages.push({ role: "assistant", content: outcome.message, ts: new Date().toISOString() });
  }

  if (outcome.action === "sent" || outcome.action === "discarded") {
    await K.karmaRecord({
      event: outcome.action === "sent" ? "comms_sent" : "comms_discarded",
      conversation: conversationId,
      reason: outcome.reason,
    });
  }

  // 8. Persist state
  conv.reply_target = turns[0].reply_target; // always update last-known reply target
  conv.turn_count++;
  conv.last_activity = new Date().toISOString();
  const maxMsgs = chatDefaults.max_history_messages || 40;
  if (conv.messages.length > maxMsgs) {
    conv.messages = trimByTurns(conv.messages, maxMsgs);
  }
  await K.kvWriteSafe(conversationId, conv);

  return outcome;
}

// ── Ingress: inbound message ──────────────────────────

export function ingestInbound(channel, inbound) {
  const { chatId, text, userId, resolvedChatKey, sentTs } = inbound;
  const platformUserId = resolvedChatKey || chatId;
  return {
    conversation_id: `chat:${channel}:${platformUserId}`,
    reply_target: { platform: channel, channel: platformUserId, thread_ts: null },
    source: "inbound",
    content: text,
    intent: null,
    idempotency_key: null, // set by caller from event key
    metadata: { sentTs, userId, channel },
  };
}

// ── Ingress: internal event ───────────────────────────

export async function ingestInternal(K, event) {
  const contactSlug = event.contact;
  // Resolve conversation_id from contact slug
  let conversationId = await K.kvGet(`conversation_index:${contactSlug}`);
  if (!conversationId) {
    // Look up platform binding to find platformUserId
    const contact = await K.kvGet(`contact:${contactSlug}`);
    if (!contact) return null;
    // Find first platform binding
    const bindings = await K.kvList({ prefix: `contact_platform:` });
    for (const b of bindings.keys) {
      const binding = await K.kvGet(b.name);
      if (binding?.contact === contactSlug) {
        const parts = b.name.replace("contact_platform:", "").split(":");
        const platform = parts[0];
        const platformUserId = parts[1];
        conversationId = `chat:${platform}:${platformUserId}`;
        // Create index for future lookups
        await K.kvWriteSafe(`conversation_index:${contactSlug}`, conversationId);
        break;
      }
    }
  }
  if (!conversationId) return null;

  // Load existing conv to get reply_target
  const conv = await K.kvGet(conversationId);
  const parts = conversationId.replace("chat:", "").split(":");
  const platform = parts[0];
  const platformUserId = parts.slice(1).join(":");

  return {
    conversation_id: conversationId,
    reply_target: conv?.reply_target || { platform, channel: platformUserId, thread_ts: null },
    source: "internal",
    content: event.content || event.reflection || event.actions_summary || JSON.stringify(event),
    intent: event.intent || (event.type === "dr_complete" ? "share" : "report"),
    idempotency_key: event.key || null,
    metadata: { event_type: event.type, event_key: event.key },
  };
}

// ── Outbox helpers ────────────────────────────────────

export async function createOutboxItem(K, conversationId, content, reason, releaseAfter, sourceEventKeys) {
  const id = `ob_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const item = {
    id,
    conversation_id: conversationId,
    content,
    hold_reason: reason,
    release_after: releaseAfter || null,
    source_event_keys: sourceEventKeys || [],
    created_at: new Date().toISOString(),
    attempts: 0,
  };
  await K.kvWriteSafe(`outbox:${conversationId}:${id}`, item);
  return item;
}

export async function checkOutbox(K) {
  const now = new Date();
  const list = await K.kvList({ prefix: "outbox:" });
  const due = [];
  for (const entry of list.keys) {
    const item = await K.kvGet(entry.name);
    if (!item) continue;
    if (item.release_after && new Date(item.release_after) <= now) {
      due.push({ key: entry.name, ...item });
    }
  }
  return due;
}

// ── Commands (handled in fetch, not runTurn) ──────────

export async function handleCommand(K, channel, inbound) {
  const { chatId, command, resolvedChatKey } = inbound;
  const platformUserId = resolvedChatKey || chatId;
  const convKey = `chat:${channel}:${platformUserId}`;

  if (command === "reset") {
    const conv = await K.kvGet(convKey);
    if (conv) {
      conv.inbound_cost = 0;
      conv.internal_cost = 0;
      delete conv._budget_warned;
      await K.kvWriteSafe(convKey, conv);
    }
    await K.executeAdapter(channel, { text: "Budget refilled.", channel: chatId });
    return { ok: true, reason: "reset" };
  }

  if (command === "clear") {
    await K.kvDeleteSafe(convKey);
    await K.executeAdapter(channel, { text: "Conversation cleared.", channel: chatId });
    return { ok: true, reason: "clear" };
  }

  return null;
}

// ── Trim helper (unchanged) ──────────────────────────

function trimByTurns(messages, maxMsgs) {
  const boundaries = [0];
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].role !== "tool") boundaries.push(i);
  }
  let startIdx = messages.length;
  for (let b = boundaries.length - 1; b >= 0; b--) {
    const turnStart = boundaries[b];
    if (messages.length - turnStart > maxMsgs && turnStart < startIdx) break;
    startIdx = turnStart;
  }
  return messages.slice(startIdx);
}
