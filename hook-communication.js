// Swayambhu Communication — unified turn processor.
// All communication flows through runTurn: one brain, one state, one prompt.
// Ingress normalizers (ingestInbound, ingestInternal) create CommTurns.
// Normal path: the scheduled tick is the main writer.
// Exception: when a long-running session is already holding the execution lock,
// fetch may use a narrow inbound fast-path so chat stays responsive.

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

const REPLY_TOOL = {
  type: "function",
  function: {
    name: "reply",
    description: "Reply conversationally to the contact without accepting or queueing new work.",
    parameters: {
      type: "object",
      properties: { message: { type: "string", description: "Message to send" } },
      required: ["message"],
    },
  },
};

const CLARIFY_TOOL = {
  type: "function",
  function: {
    name: "clarify",
    description: "Ask a clarifying question needed before work can be queued or answered well.",
    parameters: {
      type: "object",
      properties: { question: { type: "string", description: "Clarifying question to ask" } },
      required: ["question"],
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

async function loadConversationRequests(K, conversationId, contact) {
  const list = await K.kvList({ prefix: "session_request:" });
  const requests = [];

  for (const entry of list.keys) {
    const request = await K.kvGet(entry.name);
    if (!request) continue;
    if (request.ref !== conversationId && request.contact !== contact?.id) continue;

    requests.push({
      id: request.id,
      summary: request.summary,
      status: request.status,
      updated_at: request.updated_at,
      note: request.note || null,
      result: request.result || null,
      error: request.error || null,
      next_session: request.next_session || null,
    });
  }

  requests.sort((a, b) =>
    new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime(),
  );

  return requests.slice(0, 5);
}

function buildRequestStatusBlock(requests) {
  if (!requests?.length) return "";
  return "\n\n[REQUEST STATUS]\n"
    + requests.map((request) => {
      const detail = request.result || request.note || request.error || "";
      const nextSession = request.next_session ? ` Next session: ${request.next_session}.` : "";
      return `- ${request.id} — ${request.status}: ${request.summary}${detail ? ` (${detail})` : ""}.${nextSession}`;
    }).join("\n");
}

function buildQueuedWorkAcknowledgement() {
  return "Got it. I'm taking this on and will follow up when I have something concrete.";
}

function isTrivialAcknowledgement(text) {
  const normalized = String(text || "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, " ")
    .trim();
  if (!normalized) return false;
  if (normalized.length > 40) return false;

  return /^(ok|okay|ok great|great|got it|sounds good|all good|perfect|nice|cool|thanks|thank you|thankyou|awesome|sure|yep|yes|fine)$/.test(normalized);
}

function parseToolArgs(rawArgs) {
  try {
    return JSON.parse(rawArgs || "{}");
  } catch {
    return {};
  }
}

function makeEmptyConversation() {
  return {
    messages: [],
    karma: [],
    inbound_cost: 0,
    internal_cost: 0,
    created_at: new Date().toISOString(),
    turn_count: 0,
  };
}

function appendInboundTurns(conv, inboundTurns) {
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
}

async function persistConversationState(K, conversationId, conv, replyTarget, maxMessages) {
  conv.reply_target = replyTarget;
  conv.turn_count++;
  conv.last_activity = new Date().toISOString();
  if (conv.messages.length > maxMessages) {
    conv.messages = trimByTurns(conv.messages, maxMessages);
  }
  await K.kvWriteSafe(conversationId, conv);
}

export async function trySuppressTrivialAcknowledgement(K, conversationId, turns) {
  const inboundTurns = turns.filter((turn) => turn.source === "inbound");
  if (inboundTurns.length !== 1 || turns.some((turn) => turn.source !== "inbound")) {
    return { used: false };
  }

  const defaults = await K.getDefaults();
  const chatDefaults = defaults?.chat || {};
  const conv = await K.kvGet(conversationId) || makeEmptyConversation();
  const contact = turns[0]?.reply_target?.platform
    ? await K.resolveContact(turns[0].reply_target.platform, turns[0].reply_target.channel)
    : null;
  const relatedRequests = await loadConversationRequests(K, conversationId, contact);
  const hasPendingRequest = relatedRequests.some((request) => request.status === "pending");

  if (!hasPendingRequest || !isTrivialAcknowledgement(inboundTurns[0]?.content)) {
    return { used: false };
  }

  appendInboundTurns(conv, inboundTurns);
  await persistConversationState(
    K,
    conversationId,
    conv,
    turns[0].reply_target,
    chatDefaults.max_history_messages || 40,
  );

  await K.karmaRecord({
    event: "comms_discarded",
    conversation: conversationId,
    mode: "inbound",
    reason: "acknowledgement_with_pending_request",
    request_queued: false,
    request_context_count: relatedRequests.length,
  });

  return { used: true };
}

// ── runTurn: the unified conversation processor ───────

export async function runTurn(K, conversationId, turns) {
  // 1. Load conversation state
  let conv = await K.kvGet(conversationId) || makeEmptyConversation();
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
  const relatedRequests = hasInbound
    ? await loadConversationRequests(K, conversationId, contact)
    : [];
  const requestStatusBlock = hasInbound ? buildRequestStatusBlock(relatedRequests) : "";
  const modeInstruction = hasInbound
    ? "\n\n[TURN MODE]\nYou are handling a live inbound human message. This is triage, not execution. Do not inspect KV or perform work inside chat. If the contact is asking for substantive work, use trigger_session. If more detail is needed before queuing work, use clarify. If the message is purely conversational or status-related, use reply."
    : "\n\n[TURN MODE]\nYou are handling internal agent updates for an existing conversation. You may inspect lightweight request state and decide whether to send, hold, or discard.";

  // Render internal turns as agent context block
  const internalTurns = sorted.filter(t => t.source === "internal");
  const agentUpdates = internalTurns.length > 0
    ? "\n\n[AGENT UPDATES]\n" + internalTurns.map(t =>
        `- [${t.intent || "update"}] ${t.content}`
      ).join("\n") + "\n\nDecide whether to send, hold, or discard each update. Use the send tool to message the contact, hold to defer, or discard to drop."
    : "";

  const systemPrompt = (chatPrompt + contactContext + requestStatusBlock + modeInstruction + agentUpdates).trim();

  // Append inbound turns to message history
  const inboundTurns = sorted.filter(t => t.source === "inbound");
  appendInboundTurns(conv, inboundTurns);

  const hasPendingRequest = relatedRequests.some((request) => request.status === "pending");

  // 5. Build tools
  const tools = hasInbound
    ? [REPLY_TOOL, CLARIFY_TOOL, DISCARD_TOOL, TRIGGER_SESSION_TOOL]
    : [SEND_TOOL, HOLD_TOOL, DISCARD_TOOL, KV_QUERY_TOOL, KV_MANIFEST_TOOL];

  // 6. Call LLM (with tool loop for kv_query/kv_manifest)
  const model = await K.resolveModel(chatDefaults.model || defaults?.act?.model || "sonnet");
  const maxRounds = hasInbound ? 2 : 3;
  let outcome = null;
  let requestQueued = false;

  if (hasInbound
    && inboundTurns.length === 1
    && hasPendingRequest
    && isTrivialAcknowledgement(inboundTurns[0]?.content)) {
    outcome = { action: "discarded", reason: "acknowledgement_with_pending_request" };
  }

  for (let i = 0; i < maxRounds && !outcome; i++) {
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
    const args = parseToolArgs(tc.function?.arguments);

    if (name === "reply") {
      outcome = { action: "sent", message: args.message, reason: "reply" };
      break;
    }
    if (name === "clarify") {
      outcome = { action: "sent", message: args.question, reason: "clarify" };
      break;
    }
    if (name === "send") {
      outcome = { action: "sent", message: args.message, reason: "send" };
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

    const chatContext = {
      channel: turns[0].reply_target?.platform,
      userId: turns[0].metadata?.userId,
      contact,
      convKey: conversationId,
      chatConfig: chatDefaults,
    };
    const results = [];
    const executedToolCalls = [];
    for (const tc2 of response.toolCalls) {
      executedToolCalls.push(tc2);
      const extraArgs = tc2.function?.name === "trigger_session"
        ? { _chatContext: chatContext }
        : undefined;
      const result = await K.executeToolCall(tc2, extraArgs).catch(err => ({ error: err.message }));
      results.push(result);

      if (tc2.function?.name === "trigger_session" && !result?.error) {
        const tc2Args = parseToolArgs(tc2.function?.arguments);
        requestQueued = true;
        await K.karmaRecord({
          event: "comms_request_queued",
          conversation: conversationId,
          summary: tc2Args.summary || null,
        });
        outcome = {
          action: "sent",
          message: buildQueuedWorkAcknowledgement(tc2Args.summary),
          reason: "request_queued",
        };
        break;
      }
      if (tc2.function?.name === "trigger_session" && result?.error) {
        await K.karmaRecord({
          event: "comms_trigger_session_failed",
          conversation: conversationId,
          error: result.error,
        });
        outcome = {
          action: "sent",
          message: "I couldn't queue that just now. Please try again shortly.",
          reason: "request_queue_failed",
        };
        break;
      }
    }

    for (let j = 0; j < executedToolCalls.length; j++) {
      conv.messages.push({
        role: "tool",
        tool_call_id: executedToolCalls[j].id,
        content: JSON.stringify(results[j]),
      });
    }

    if (outcome) break;
  }

  if (!outcome) {
    outcome = { action: "held", reason: "tool rounds exhausted without outcome" };
  }

  // 7. Execute outcome
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
      mode: hasInbound ? "inbound" : "internal",
      reason: outcome.reason,
      request_queued: requestQueued,
      request_context_count: relatedRequests.length,
    });
  }

  // 8. Persist state
  await persistConversationState(
    K,
    conversationId,
    conv,
    turns[0].reply_target,
    chatDefaults.max_history_messages || 40,
  );

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
  let eventContent = event.content || event.reflection || event.actions_summary || JSON.stringify(event);
  let contactSlug = event.contact;

  if (event.ref?.startsWith("session_request:")) {
    const request = await K.kvGet(event.ref);
    if (request) {
      contactSlug = contactSlug || request.contact;
      const result = request.result ? ` Result: ${request.result}` : "";
      const note = request.note ? ` Note: ${request.note}` : "";
      const error = request.error ? ` Error: ${request.error}` : "";
      eventContent = `Request "${request.summary}" is now ${request.status}.${result}${note}${error}`;
    }
  }

  if (!contactSlug) return null;
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
      const bindingSlug = binding?.slug || binding?.contact;
      if (bindingSlug === contactSlug) {
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
    content: eventContent,
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
