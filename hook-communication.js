// Swayambhu Communication Handler — inbound chat and outbound delivery pipeline.
// Channel adapters handle platform specifics (statically imported).
// The communication system prompt (prompt:communication) is in KV = agent-evolvable.
//
// Every kernel method is called via K (the kernel interface).
// This module is kernel-level code — immutable, imported directly.
//
// Chat state is stored per-channel: chat:{channel}:{chatId}
// One object per conversation, growing chronologically (mirrors Slack).
// Karma (audit trail) is embedded in the chat object, not in karma:{sessionId}.

export async function handleChat(K, channel, inbound) {
  const { chatId, text, command, userId, resolvedChatKey, sentTs } = inbound;
  const convKey = `chat:${channel}:${resolvedChatKey || chatId}`;

  // Load or init conversation state
  let conv = await K.kvGet(convKey) || {
    messages: [],
    karma: [],
    total_cost: 0,
    created_at: new Date().toISOString(),
    turn_count: 0,
  };
  // Ensure karma array exists (migration from older format)
  if (!conv.karma) conv.karma = [];

  // Handle commands
  if (command === "reset") {
    conv.total_cost = 0;
    delete conv._budget_warned;
    await K.kvWriteSafe(convKey, conv);
    await K.executeAdapter(channel, { text: "Budget refilled. Conversation history preserved.", channel: chatId });
    return { ok: true, reason: "reset" };
  }
  if (command === "clear") {
    await K.kvDeleteSafe(convKey);
    await K.executeAdapter(channel, { text: "Conversation cleared.", channel: chatId });
    return { ok: true, reason: "clear" };
  }

  // Load config: global defaults + contact overrides
  const defaults = await K.getDefaults();
  const contact = await K.resolveContact(channel, userId);
  const chatDefaults = defaults?.chat || {};
  const contactConfig = contact?.chat || {};
  const chatConfig = { ...chatDefaults, ...contactConfig };
  const maxCost = chatConfig.max_cost_per_conversation || 0.50;
  if (conv.total_cost >= maxCost) {
    await K.executeAdapter(channel, { text: "Budget reached. Send /reset to refill or /clear to start fresh.", channel: chatId });
    return { ok: true, reason: "budget_exhausted" };
  }

  // Build system prompt (dharma injected by kernel in callLLM)
  const chatPrompt = await K.kvGet("prompt:communication");
  const contactContext = contact
    ? `\n\nYou are chatting with:\n${JSON.stringify(contact)}`
    : "";

  // If this conversation was initiated by the agent during a session, note it
  const sourceSession = conv.source_session;
  const sessionContext = sourceSession
    ? `\n\nThis conversation was initiated during session ${sourceSession}. If the user asks about what you were doing, use kv_query to read karma:${sourceSession} for context.`
    : "";

  const systemPrompt = [
    chatPrompt || "You are in a live communication session. Respond conversationally.",
    contactContext,
    sessionContext,
  ].join("\n\n").trim();

  // Deduplicate layer 1: same Slack timestamp = same message re-delivered
  if (sentTs && conv.messages.some(m => m.sentTs === sentTs)) {
    return { ok: true, reason: "duplicate_ts" };
  }

  // Deduplicate layer 2: same text with no intervening reply = double-send
  // Find where this message belongs chronologically using Slack's sent timestamp
  const lastUserMsg = [...conv.messages].reverse().find(m => m.role === "user");
  const lastNonUserMsg = [...conv.messages].reverse().find(m => m.role !== "user");
  const lastUserIsNewer = lastUserMsg && (!lastNonUserMsg || lastUserMsg.ts > (lastNonUserMsg.ts || ""));
  if (lastUserIsNewer && lastUserMsg.content === text) {
    return { ok: true, reason: "duplicate_content" };
  }

  // Append user message (use Slack's sent timestamp for correct ordering)
  const ts = sentTs ? new Date(parseFloat(sentTs) * 1000).toISOString() : new Date().toISOString();
  conv.messages.push({ role: "user", content: text, userId, ts, sentTs });

  // Resolve model + tools (unapproved/unknown contacts get no tools — mechanical jailbreak prevention)
  const chatModel = chatConfig.model || defaults?.act?.model || "sonnet";
  const model = await K.resolveModel(chatModel);
  let tools;
  if (contact?.approved) {
    tools = await K.buildToolDefinitions([], { context: "communication" });
  } else if (contact) {
    // Contact exists but not approved — restricted tools
    const allowlist = chatConfig.unknown_contact_tools || [];
    tools = allowlist.length
      ? (await K.buildToolDefinitions([], { context: "communication" })).filter(t => allowlist.includes(t.function?.name))
      : [];
    await K.karmaRecord({
      event: 'inbound_unapproved', sender_id: userId, channel,
    });
  } else {
    const allowlist = chatConfig.unknown_contact_tools || [];
    tools = allowlist.length
      ? (await K.buildToolDefinitions([], { context: "communication" })).filter(t => allowlist.includes(t.function?.name))
      : [];
    await K.karmaRecord({
      event: 'inbound_unknown', sender_id: userId, channel,
    });
  }

  // Tool-calling loop
  const maxRounds = chatConfig.max_tool_rounds || 5;
  let reply = null;

  for (let i = 0; i < maxRounds; i++) {
    const response = await K.callLLM({
      model,
      effort: chatConfig.effort || "low",
      maxTokens: chatConfig.max_output_tokens || 1000,
      systemPrompt,
      messages: conv.messages,
      tools,
      step: `chat_${channel}_t${conv.turn_count}_r${i}`,
    });
    conv.total_cost += response.cost || 0;

    // Budget warning — inject once when cost crosses threshold
    const warningPct = chatConfig.budget_warning_pct || 0.80;
    if (!conv._budget_warned && conv.total_cost >= maxCost * warningPct) {
      conv.messages.push({
        role: "system",
        content: "This conversation's budget is running low. Wrap up soon.",
      });
      conv._budget_warned = true;
    }

    if (response.toolCalls?.length) {
      conv.messages.push({
        role: "assistant",
        content: response.content || null,
        tool_calls: response.toolCalls,
      });
      const results = await Promise.all(
        response.toolCalls.map(tc =>
          K.executeToolCall(tc).catch(err => ({ error: err.message }))
        )
      );
      for (let j = 0; j < response.toolCalls.length; j++) {
        conv.messages.push({
          role: "tool",
          tool_call_id: response.toolCalls[j].id,
          content: JSON.stringify(results[j]),
        });
      }
      continue;
    }

    reply = response.content;
    conv.messages.push({ role: "assistant", content: reply, ts: new Date().toISOString() });
    break;
  }

  if (!reply) {
    // Tool rounds exhausted — force a text reply with tools disabled
    const finalResponse = await K.callLLM({
      model,
      effort: chatConfig.effort || "low",
      maxTokens: chatConfig.max_output_tokens || 1000,
      systemPrompt,
      messages: conv.messages,
      tools: [],
      step: `chat_${channel}_t${conv.turn_count}_final`,
    });
    conv.total_cost += finalResponse.cost || 0;
    reply = finalResponse.content || "(no response)";
    conv.messages.push({ role: "assistant", content: reply, ts: new Date().toISOString() });
  }

  // Send via channel adapter
  await K.executeAdapter(channel, { text: reply, channel: chatId });

  // Collect chat karma from kernel (in-memory only, not written to karma:{sessionId})
  const chatKarma = await K.getChatKarma();
  conv.karma.push(...chatKarma);

  // Trim + save state
  conv.turn_count++;
  conv.last_activity = new Date().toISOString();
  const maxMsgs = chatConfig.max_history_messages || 40;
  if (conv.messages.length > maxMsgs) {
    conv.messages = trimByTurns(conv.messages, maxMsgs);
  }
  await K.kvWriteSafe(convKey, conv);

  // Emit event for next session
  try {
    await K.emitEvent("chat_message", {
      source: { channel, user_id: userId },
      contact_name: contact?.name || userId,
      contact_approved: !!contact?.approved,
      summary: text.slice(0, 300),
      timestamp: new Date().toISOString(),
      ref: convKey,
    });
  } catch {}

  // Advance next session for approved contacts — conversation is a signal to run sooner
  if (contact?.approved) {
    try {
      const advanceSecs = chatConfig.session_advance_seconds
        ?? (chatConfig.session_advance_minutes ? chatConfig.session_advance_minutes * 60 : 30);
      const schedule = await K.kvGet("session_schedule");
      if (schedule?.next_session_after) {
        const sessionAt = new Date(schedule.next_session_after).getTime();
        const advanceTo = Date.now() + advanceSecs * 1000;
        if (sessionAt > advanceTo) {
          await K.kvWriteSafe("session_schedule", {
            ...schedule,
            next_session_after: new Date(advanceTo).toISOString(),
          });
        }
      }
    } catch {}
  }

  return { ok: true, turn: conv.turn_count };
}

export async function handleDelivery(K, events) {
  const byContact = {};
  for (const event of events) {
    const contactId = event.contact || "unknown";
    if (!byContact[contactId]) byContact[contactId] = [];
    byContact[contactId].push(event);
  }

  const results = [];

  for (const [contactId, contactEvents] of Object.entries(byContact)) {
    try {
      const contact = await K.resolveContact(null, contactId);
      if (!contact) {
        await K.karmaRecord({
          event: "delivery_skipped",
          contact: contactId,
          reason: "contact_not_found",
          event_count: contactEvents.length,
        });
        continue;
      }

      const platform = contact.platform || "slack";
      const convKey = `chat:${platform}:${contactId}`;
      const conv = await K.kvGet(convKey) || { messages: [] };

      const prompt = await K.kvGet("prompt:communication");
      if (!prompt) {
        await K.karmaRecord({ event: "delivery_error", reason: "no_prompt:communication" });
        continue;
      }

      const deliveryContext = {
        mode: "delivery",
        contact: { id: contactId, name: contact.name, platform },
        pending_deliverables: contactEvents.map(e => ({
          type: e.type,
          content: e.content,
          attachments: e.attachments,
          timestamp: e.timestamp,
        })),
        conversation_history: conv.messages.slice(-20),
      };

      const model = await K.resolveModel(
        (await K.getDefaults())?.communication?.model || (await K.getDefaults())?.act?.model
      );
      const response = await K.callLLM({
        model,
        system: prompt,
        messages: [{ role: "user", content: JSON.stringify(deliveryContext) }],
        max_tokens: 1000,
      });

      const message = response?.content;
      if (!message) continue;

      const adapterKey = platform === "slack" ? "slack" : platform;
      await K.executeAdapter(adapterKey, {
        text: message,
        channel: contactId,
      });

      conv.messages.push(
        { role: "user", content: `[DELIVERY] ${contactEvents.map(e => e.content).join("; ")}` },
        { role: "assistant", content: message }
      );
      await K.kvWriteSafe(convKey, conv);

      await K.karmaRecord({
        event: "delivery_sent",
        contact: contactId,
        event_count: contactEvents.length,
        model,
      });

      results.push({ contact: contactId, sent: true });
    } catch (err) {
      await K.karmaRecord({
        event: "delivery_error",
        contact: contactId,
        error: err.message,
      });
      results.push({ contact: contactId, sent: false, error: err.message });
    }
  }

  return results;
}

// Trim messages by turn boundaries, keeping the most recent turns.
// A turn is: a user/system message, a standalone assistant message,
// or an assistant message with tool_calls + all its tool results.
function trimByTurns(messages, maxMsgs) {
  // Find turn boundaries (indices where a new turn starts)
  const boundaries = [0];
  for (let i = 1; i < messages.length; i++) {
    const msg = messages[i];
    // tool results belong to the preceding assistant turn
    if (msg.role === 'tool') continue;
    boundaries.push(i);
  }

  // Walk backwards through turns until we hit the limit
  let startIdx = messages.length;
  for (let b = boundaries.length - 1; b >= 0; b--) {
    const turnStart = boundaries[b];
    const turnSize = startIdx - turnStart;
    if (messages.length - turnStart > maxMsgs && turnStart < startIdx) break;
    startIdx = turnStart;
  }

  return messages.slice(startIdx);
}
