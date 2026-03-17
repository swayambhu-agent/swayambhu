# Prompt Audit — Swayambhu Agent Prompts

Generated 2026-03-17. Compares each prompt against actual codebase behavior.

---

## Orient (`prompts/orient.md`)

### Token estimate: ~350

### Missing capabilities

- **MEDIUM — No explanation of effort levels.** The context includes an `effort` field but the prompt never explains what effort levels mean (low/medium/high/max) or how the agent should calibrate its behavior. — `hook-main.js:evaluateTripwires()` lines 253–274

- **LOW — kv_manifest tool not described.** Listed as available but the prompt only says "read/write memory" without mentioning the ability to list keys by prefix. — `tools/kv_manifest.js`

- **LOW — prajna:* wisdom entries not mentioned.** The prompt mentions `viveka:*` but not `prajna:*` (self-knowledge). Both are available for query. — KV schema 1.18


### Structural issues

- **Output schema is minimal.** Only shows `session_summary`, `kv_operations`, `next_wake_config`. There's no guidance on what makes a good `session_summary`, what effort levels mean for `next_wake_config`, or what `sleep_seconds` values are reasonable.

- **Tool descriptions only in passing.** The prompt says "check balances, search the web, send messages, read/write memory" but never names specific tools. The agent relies entirely on tool definitions from the registry, which have one-line descriptions. For complex tools like `akash_exec` (shell access to a server) or the gated communication tools, this may not be enough context.

### Suggested additions

After "## Available tools" section, add:

```
Your tools include: kv_query (read any KV key with dot-path navigation),
kv_manifest (list keys by prefix), kv_write (write to your own tooldata:*
namespace), check_balance (provider and wallet balances), web_fetch,
send_slack (communication-gated), send_email (communication-gated),
check_email (inbound-gated — unknown sender content is redacted),
akash_exec (shell on Akash server), spawn_subplan, verify_patron.

Reference docs about your own architecture are at doc:architecture and
doc:modification_guide — query them when you need to understand your own
systems.
```

Before "## What to do", add:

```
## Your context

The user message contains JSON with:
- last_reflect: your previous session's reflection, including note_to_future_self
- additional_context: KV keys you asked to load in your last reflection
- balances: current provider and wallet balances
- effort: your effort level this session (low/medium/high/max)
- crash_data: details if the previous session crashed, null otherwise
- current_time: ISO timestamp
```

Replace the communication gating section:

```
### Communication gating

Outbound messages pass through a kernel-enforced gate. The mechanical floor
blocks initiating contact with unknown persons (no contact: record). The LLM
gate evaluates messages against viveka:comms:* and viveka:channel:* wisdom.
Messages may be sent, revised, or blocked and queued for deep reflect review.
```

Remove lines 31–33 (yama/niyama modification instructions — not applicable to orient).

**Net token impact:** +120 tokens added, ~30 removed. Total ~440 tokens.

---

## Reflect (`prompts/reflect.md`)

### Token estimate: ~1,200

### Missing capabilities

- **HIGH — comms_verdicts not in output schema.** Session reflect doesn't process `comms_verdicts` (that's deep reflect only, via `applyReflectOutput`), but the reflect code DOES process `modification_verdicts` via `processReflectVerdicts()`. The prompt correctly documents modification_verdicts. No gap here for reflect's actual capabilities.

- **MEDIUM — patch op documented inconsistently.** Line 126 shows `patch` op in the yama example, but the main `kv_operations` description (line 69) only lists `put` and `delete`. And `kv_operations` are processed by `applyKVOperation()` which calls `kvPutSafe` — so `patch` ops in kv_operations would fail on system keys anyway.

### Stale or incorrect

- **Lines 12–17: Template variables {{karma}}, {{sessionCost}}, {{results}}, {{stagedModifications}} are NOT populated by buildPrompt.** `executeReflect()` (hook-reflect.js lines 22–26) passes only `{ systemKeyPatterns }` to `buildPrompt()`. The values for karma, sessionCost, and stagedModifications are passed in the `initialContext` user message. So the rendered system prompt contains the literal strings `{{karma}}`, `{{sessionCost}}`, `{{results}}`, and `{{stagedModifications}}`. The LLM sees these as unreplaced placeholders in the system prompt, with the actual data arriving in the user message as JSON.

- **Line 17: {{results}} is never populated anywhere.** It is not in the template vars passed to `buildPrompt()`, and it is not in the `initialContext` JSON (`{ karma, sessionCost, stagedModifications }`). This placeholder is completely orphaned — the LLM sees `**Step results:**\n{{results}}` literally. If "step results" means something, the data should be provided; if not, the section should be removed.

- **Line 39: `viveka:*` and `prajna:*` described correctly for wisdom awareness, but the `viveka:contact:*` pattern is obsolete across the codebase.** The reflect prompt doesn't reference `viveka:contact:*` directly, so no direct error here — but the orient prompt does, and the prompts should be consistent.

- **Lines 74–75: modification_requests ops list includes "rename".** The prompt shows `{"op": "rename", "key": "old:name", "value": "new:name"}` but `kvWritePrivileged()` (brainstem.js line 740) only handles `delete`, `patch`, and default (put). There is no `rename` op implementation. A rename op would fall through to a put of `"new:name"` as the value at key `"old:name"`, which is not the intended behavior.

### Unnecessary

- **Lines 39–42: Explaining wisdom storage for reflect when it can't write wisdom.** The prompt says "You don't write wisdom here — that happens in deep reflect" which is good framing. But the 4 lines about viveka and prajna prefixes could be condensed since reflect can't act on them.

### Structural issues

- **Template var / user message split is confusing.** The prompt is written as if karma, cost, staged modifications, and results will be substituted into the system prompt (using `{{}}` syntax). In reality, only `{{systemKeyPatterns}}` is substituted; the rest arrive in the user message. This means the "This session" section in the system prompt is structurally misleading — the headings are there but the data isn't inline. The LLM has to piece together data from the user message with structure from the system prompt.

- **Output schema shows `next_orient_context.load_keys` as required but processing code doesn't enforce it.** `writeSessionResults()` and `executeReflect()` don't check for this field. It's consumed by `hook-main.js:wake()` line 94 when reading `last_reflect.next_orient_context.load_keys`. If reflect omits it, the next session falls back to `defaults.memory.default_load_keys`.

### Suggested additions

Fix the template variable issue. Either:
**(Option A — recommended)** Move karma, sessionCost, stagedModifications into the template vars passed to `buildPrompt()` in `executeReflect()`. This means changing hook-reflect.js, not the prompt. OR
**(Option B)** Rewrite the prompt to not use `{{}}` for these fields and instead reference them as "provided in the user message":

Replace lines 9–22:
```
## This session

The user message contains a JSON object with:
- **karma**: the full karma log for this session
- **sessionCost**: total dollar cost of this session
- **stagedModifications**: any modifications awaiting deep reflect review

## System key patterns

{{systemKeyPatterns}}
```

Remove line 17 (`{{results}}`) entirely — it's never populated.

Remove the `rename` op from the modification_requests example (line 75).

---

## Deep Reflect (`prompts/deep-reflect.md`)

### Token estimate: ~3,500

### Missing capabilities

- **~~HIGH~~ FIXED — Contact management for blocked comms.** `kvWritePrivileged` now allows updates to existing contacts (put/patch) while blocking creation and deletion. The deep-reflect prompt has been updated to tell the agent that new contacts are operator-only, but existing contact records can be updated (notes, timezone, preferences).

- **MEDIUM — No mention of `doc:modification_guide` for understanding modification protocol.** The prompt says "Reference documentation about yourself is stored at `doc:*` keys" (line 11) which is good, but doesn't specifically call out the modification guide which is directly relevant to deep reflect's primary function.

- **LOW — comms_verdicts output field `revision` structure.** The prompt shows `revision: {"text": "revised message"}` for `revise_and_send` and `revision: {"reason": "not appropriate"}` for `drop`. But `processCommsVerdict()` (brainstem.js line 638) only checks `revision?.text` for content_field replacement. The `reason` field for `drop` is not used by the code — it's logged in karma but not structurally required. Not a bug, but the prompt implies `reason` matters for drops when it's optional.

### Stale or incorrect

- **Lines 81–84: Context balance template variables.** `{{context.orBalance}}`, `{{context.walletBalance}}`, `{{context.effort}}`, `{{context.crashData}}` — these ARE correctly populated by `gatherReflectContext()` (hook-reflect.js line 196), which builds a `context` object in templateVars. Verified correct.

- **Lines 59–61: Patron awareness template variables.** `{{patron_contact}}`, `{{patron_identity_disputed}}` — correctly populated by `gatherReflectContext()`. Verified correct.

### Unnecessary

- **Lines 129–148: "When to write wisdom" section.** At ~200 tokens, this is detailed guidance that could be condensed. The test at line 149 ("would a wise person carry this understanding regardless of domain?") is valuable, but the bullet lists of when/when-not could be shortened.

- **Lines 155–170: Wisdom key naming examples.** ~100 tokens of examples. Useful for initial sessions but will be redundant after the agent has established naming patterns. Consider moving to `doc:wisdom_guide` in KV so the agent can load it on demand.

- **Lines 172–201: Wisdom schema documentation.** ~200 tokens documenting the JSON schema. This is reference material that could live in `doc:wisdom_guide` rather than consuming prompt tokens every deep reflect session.

- **Lines 214–218: "Examine your alignment" repeats yama/niyama context.** The agent already has full yamas and niyamas injected by the kernel via `callLLM()`. Telling it to "read `yama:*:audit`" is useful, but the framing duplicates what's already in context.

### Structural issues

- **Most important instructions are in the middle, not at beginning/end.** The output schema and modification protocol (the actionable parts) are at the end, which is good for LLM attention. But the "What to do" section (line 88) is buried after a large context section. Consider moving the investigation guidance before the context sections.

- **Wisdom documentation dominates the prompt.** The wisdom section (lines 94–213) is ~1,200 tokens — roughly a third of the entire prompt. For a session that may not need to write any wisdom, this is a significant tax on context. The deep-reflect prompt should focus on judgment and investigation; wisdom mechanics could be in a reference doc.

### Suggested additions

Consider extracting wisdom documentation (lines 94–201) into `doc:wisdom_guide` seeded into KV. Replace with:

```
### Your wisdom

You maintain prajna (self-knowledge) and viveka (world-discernment) in KV.
Query doc:wisdom_guide via kv_query for the full schema and naming
conventions. Query your existing prajna:* and viveka:* entries before
reflecting.

Wisdom modifications use type: "wisdom" with a validation field. They go
through the same Modification Protocol as code changes.
```

**Net token impact:** ~800 tokens saved if wisdom docs are extracted to KV.

---

## Subplan (`prompts/subplan.md`)

### Token estimate: ~80

### Missing capabilities

- **HIGH — No tool descriptions or guidance.** The subplan agent receives the same tools as its parent (including `spawn_subplan` for further nesting) but the prompt gives zero context about available tools, KV structure, or capabilities. The agent must rely entirely on tool definitions for guidance.

- **LOW — No mention of depth limits.** `max_subplan_depth` (default 3) limits nesting, but the subplan agent isn't told about this. If it tries to spawn a sub-subplan at max depth, it'll get an error.

### Structural issues

- **Extremely minimal for an autonomous agent.** The subplan agent can do almost everything the orient agent can (KV read/write, web fetch, email, Slack, shell access) but has ~5% of the guidance. Whether this is a problem depends on the complexity of subplan goals. For simple tasks ("check the OpenRouter balance") it's fine. For complex ones ("investigate why emails aren't being delivered") it may lack crucial context.

- **Output schema is informal.** Says to produce "a JSON object with a 'result' field" but `runAgentLoop` → `parseAgentOutput` will parse any valid JSON. If the subplan produces `{ "result": "...", "kv_operations": [...] }`, the kv_operations won't be processed (subplan output goes back to the parent agent as a tool result, not through the orient pipeline).

### Suggested additions

Add after the goal line:
```
You have tools: kv_query (read KV), kv_manifest (list keys), kv_write
(your own storage), check_balance, web_fetch, send_slack, send_email,
check_email, akash_exec, verify_patron, spawn_subplan (nested agents).

Communication tools (send_slack, send_email) are kernel-gated. Email
content from unknown senders is redacted.
```

**Net token impact:** +60 tokens.

---

## Chat (`prompt:chat` — inline in seed script)

### Token estimate: ~50

### Full prompt text:

```
You are in a live chat session. Respond conversationally and concisely.
Use tools when the user asks about balances, KV state, or anything that
requires looking up data. Keep replies short — this is real-time chat,
not a report.
```

### Missing capabilities

- **MEDIUM — No identity framing.** The chat prompt doesn't say "You are Swayambhu" — it relies on dharma injection from `callLLM()` for identity. The dharma IS injected, but the chat prompt could benefit from a brief identity frame since it's the most user-facing context.

- **LOW — Communication tool awareness.** Known contacts get full tool access in chat. The prompt doesn't mention that tool use is possible beyond "balances" and "KV state", missing shell access (akash_exec), email, web fetch, etc.

- **LOW — Budget awareness.** Chat has per-conversation cost limits (`chatConfig.max_cost_per_conversation`, default $0.50) and turn limits, but the agent isn't told this. It can't adjust its behavior to conserve budget within a conversation.

- **LOW — Unknown contact behavior not explained.** Unknown contacts get no tools (or only allowlisted ones). The chat agent doesn't know why it suddenly has no tools for some conversations. Adding a note would help it explain the situation gracefully.

### Structural issues

- **Extremely minimal.** This is the most human-facing prompt and it's 4 lines. The dharma + yamas + niyamas injection from `callLLM()` adds significant context, but the chat-specific guidance is thin. The contact JSON is appended by `handleChat()` (hook-chat.js line 47–48) but the prompt doesn't tell the agent what to do with contact information.

### Suggested additions

Replace with:
```
You are Swayambhu, in a live chat. Respond conversationally and concisely.

Use tools when the user asks about balances, KV state, or anything that
requires data. Keep replies short — this is real-time chat, not a report.

If contact information is provided below, use it to personalize the
conversation. If you have no tools available, you are chatting with an
unknown contact — be helpful but do not reveal system internals.
```

**Net token impact:** +30 tokens.

---

## Cross-prompt issues

### 4. `rename` op in reflect schema, not implemented
- **Reflect** (line 75) shows `{"op": "rename", ...}` in modification_requests. **Brainstem** `kvWritePrivileged()` has no rename handler — the op would fall through to a put, storing the new key name as a value at the old key.
- **Resolution:** Remove `rename` from the reflect prompt example. If rename is desired, implement it as delete + put in the ops array.

### 5. Reflect template variables are broken
- **Reflect** uses `{{karma}}`, `{{sessionCost}}`, `{{results}}`, `{{stagedModifications}}` as if they're template vars, but `executeReflect()` only passes `{ systemKeyPatterns }` to `buildPrompt()`. These appear as literal `{{...}}` in the rendered system prompt. Data arrives via user message instead.
- **Resolution:** Either pass these as template vars to buildPrompt, or rewrite the prompt to reference data in the user message. The `{{results}}` var is never populated anywhere and should be removed entirely.

### 6. Orient doesn't explain context that reflect controls
- **Reflect** carefully chooses `next_orient_context.load_keys` and writes `note_to_future_self` into `last_reflect`. **Orient** never tells the agent to look at `last_reflect.note_to_future_self` or `additional_context` — the thread of continuity exists in the data but isn't surfaced by the prompt.
- **Resolution:** Orient should explain its context fields, especially `last_reflect.note_to_future_self` as the continuity mechanism.

### 7. Tool description consistency
- **Orient** mentions tools by category ("check balances, search the web, send messages, read/write memory"). **Deep-reflect** says "use kv_query, web_fetch, etc." **Subplan** says nothing. **Chat** says "balances, KV state, or anything that requires looking up data."
- **Resolution:** Establish a standard brief tool summary used across prompts, adapted to each context's available tool set.

### 8. Wisdom terminology consistency
- **Orient** mentions only `viveka:*`. **Reflect** mentions both `viveka:*` and `prajna:*`. **Deep-reflect** has full wisdom documentation for both. The orient agent should know about prajna too since it can query it.
- **Resolution:** Orient's viveka section should mention prajna briefly: "Your `viveka:*` keys contain discernment about the world; `prajna:*` keys contain self-knowledge."

