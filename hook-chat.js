// Swayambhu Chat Handler — Platform-agnostic chat session pipeline
// Channel adapters handle platform specifics (statically imported).
// The chat system prompt (prompt:chat) is in KV = agent-evolvable.
//
// Every kernel method is called via K (the kernel interface).
// This module is kernel-level code — immutable, imported directly.
//
// Chat state is stored per-channel: chat:{channel}:{chatId}
// One object per conversation, growing chronologically (mirrors Slack).
// Karma (audit trail) is embedded in the chat object, not in karma:{sessionId}.

export async function handleChat(K, channel, inbound, adapter) {
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
    await adapter.sendReply(chatId, "Budget refilled. Conversation history preserved.");
    return { ok: true, reason: "reset" };
  }
  if (command === "clear") {
    await K.kvDeleteSafe(convKey);
    await adapter.sendReply(chatId, "Conversation cleared.");
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
    await adapter.sendReply(chatId, "Budget reached. Send /reset to refill or /clear to start fresh.");
    return { ok: true, reason: "budget_exhausted" };
  }

  // Build system prompt (dharma injected by kernel in callLLM)
  const chatPrompt = await K.kvGet("prompt:chat");
  const contactContext = contact
    ? `\n\nYou are chatting with:\n${JSON.stringify(contact)}`
    : "";

  // If this conversation was initiated by the agent during a session, note it
  const sourceSession = conv.source_session;
  const sessionContext = sourceSession
    ? `\n\nThis conversation was initiated during session ${sourceSession}. If the user asks about what you were doing, use kv_query to read karma:${sourceSession} for context.`
    : "";

  const systemPrompt = [
    chatPrompt || "You are in a live chat. Respond conversationally.",
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
    tools = await K.buildToolDefinitions();
  } else if (contact) {
    // Contact exists but not approved — restricted tools
    const allowlist = chatConfig.unknown_contact_tools || [];
    tools = allowlist.length
      ? (await K.buildToolDefinitions()).filter(t => allowlist.includes(t.function?.name))
      : [];
    await K.karmaRecord({
      event: 'inbound_unapproved', sender_id: userId, channel,
    });
  } else {
    const allowlist = chatConfig.unknown_contact_tools || [];
    tools = allowlist.length
      ? (await K.buildToolDefinitions()).filter(t => allowlist.includes(t.function?.name))
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
  await adapter.sendReply(chatId, reply);

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

  // Advance next session for approved contacts — conversation is a signal to run sooner
  if (contact?.approved) {
    try {
      const advanceMins = chatConfig.session_advance_minutes ?? 1;
      const schedule = await K.kvGet("session_schedule");
      if (schedule?.next_session_after) {
        const sessionAt = new Date(schedule.next_session_after).getTime();
        const advanceTo = Date.now() + advanceMins * 60 * 1000;
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
