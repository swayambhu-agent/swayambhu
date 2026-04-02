# Known Bugs

Bugs identified but intentionally left unfixed (e.g. waiting to see if the agent catches them) or deferred.

## DR apply can be partial (no KV transactions)

**Status:** Accepted risk — KV limitation, no clean fix

**Symptom:** If `applyDrResults` writes 3 of 5 kv_operations and the
4th fails (e.g. kvWriteGated rejects it), the first 3 writes are already
committed. There's no rollback. The apply is logged as partially failed.

**Root cause:** Cloudflare KV has no transaction/batch-write primitive.
Each `kvWriteGated` call is independent. Partial application is an
inherent limitation of the storage layer.

**Mitigation:** Log both applied and blocked op counts in karma. The
agent's next DR will see the partial state and can correct it. Full-value
writes (not patches) mean re-applying the same op is idempotent.

**Identified by:** Codex adversarial review (reviews 2-4).

## Theoretical double-dispatch race on dr:state:1

**Status:** Accepted risk — extremely unlikely with Cloudflare Workers

**Symptom:** Two overlapping `run()` invocations could both read
`dr:state:1` as `idle` and both dispatch a DR job.

**Root cause:** `kvWriteSafe` is unconditional put, not compare-and-swap.
The kernel's `active_session` lock is also read-then-write. No atomic
primitives available.

**Mitigation:** Cloudflare Workers cron serializes invocations at the
platform level. For this race to occur, two Workers instances would
need to hit the same cron within the KV propagation window (ms). The
state machine's status field provides a second line of defense — a
double-dispatch would see `dispatched` on the second read and do nothing.
The `start_job` global concurrency check provides a third line.

**Identified by:** Codex adversarial review (reviews 1, 2, 4).

## Computer tool blocked by Cloudflare Access (403)

**Status:** Unfixed — infrastructure issue, needs CF dashboard investigation

**Symptom:** All `computer` tool calls to `https://akash.swayambhu.dev/execute` return 403 Forbidden with a Cloudflare "you have been blocked" page. The Akash server itself is running (we're currently operating on it).

**Root cause:** Cloudflare Access is rejecting the service token. The header names were fixed (renamed from `Authorization: Bearer` to `CF-Access-Client-Secret`), and `kernel:tool_grants` has the correct secret names (`COMPUTER_CF_CLIENT_ID`, `COMPUTER_CF_CLIENT_SECRET`). But the 403 persists. Likely causes: (a) the CF Access service token has expired, (b) the Access application policy for `akash.swayambhu.dev` was changed/removed, or (c) the service token doesn't match the application.

**To investigate:** Check Cloudflare Zero Trust dashboard → Access → Applications → verify the application for `akash.swayambhu.dev` exists and the service token is still valid.

**Observed in:** Sessions `s_1774077839296_zerke5` and `s_1774079978378_vnq5ze`.

## kv_query crashes on non-JSON values

**Status:** Reverted fix — observing whether deep reflect catches it

**Symptom:** `kv_query` on keys containing plain text (e.g. `hook:act:code`, `hook:reflect:code` which store JS source) throws a JSON parse error. The tool returns `ok: false`.

**Root cause:** `tools/kv_query.js` line 9 does `JSON.parse(raw)` unconditionally. Non-JSON text values throw.

**Fix:** Wrap in try/catch, fall back to raw string:
```js
let data = raw;
if (typeof raw === "string") {
  try { data = JSON.parse(raw); } catch { /* plain text — use as-is */ }
}
```

**Observed in:** Session `s_1774021428128_se2jue` — agent tried reading `hook:act:code` and `hook:reflect:code`, both failed.

## spawn_subplan doesn't validate model aliases

**Status:** Unfixed — observing whether deep reflect catches it

**Symptom:** Agent passed `model: "deep_reflect"` to spawn_subplan, which isn't a model alias — it's a config section name. This caused 8 consecutive `provider_fallback` events (each turn failed then fell back to Haiku), wasting ~$0.07.

**Root cause:** Two issues:
1. `spawn_subplan` tool description says "Model alias (default: haiku)" but doesn't reference where valid aliases are listed (`config:models` alias_map)
2. `spawnSubplan()` in kernel.js calls `resolveModel()` which silently passes invalid aliases through to the LLM provider, which fails, triggering fallback. No early validation.

**Fix:** (a) Change tool description to: `'Model alias from config:models alias_map (e.g. opus, haiku). Default: haiku'`. (b) Validate alias against alias_map in `spawnSubplan()` before making the LLM call — return an error with valid aliases if invalid.

**Observed in:** Session `s_1774023539576_q4il9u` — agent tried to spawn deep reflect as a subplan, burned 8 fallback cycles.

## kv_query summarizes objects with >10 keys, losing important content

**Status:** Unfixed — observing whether deep reflect catches it

**Symptom:** When `kv_query` reads an object with more than 10 keys, `present()` switches to summary mode, calling `describeValue()` on each field. Nested objects become `"object (2 keys)"` and strings over 120 chars become `"string (N chars)"`. The agent loses the actual content.

**Root cause:** `tools/kv_query.js` `present()` function (line 90): `if (keys.length <= 10 && !hasNestedArray) return value;` — objects with >10 keys get summarized. The blocked comms records have 12 keys, so the `args` field (containing the actual message text) becomes `"object (2 keys)"` instead of showing `{ channel, text }`.

**Fix:** Either raise the threshold (e.g. 20), or always inline nested objects that are small (e.g. <5 keys), or let `describeValue` show short nested objects inline rather than just reporting their key count.

**Observed in:** Session `s_1774023539576_q4il9u` — agent read `comms_blocked:cb_*` keys but couldn't see the actual message text or args.

## Truncated LLM output + _extractJSON produces garbage results

**Status:** Unfixed — needs robustifying

**Symptom:** A subplan returned `["s_1774019916390_g72l3c", "s_1774021428128_se2jue"]` to the orient model — just two session IDs instead of the full analysis. The orient model concluded "the sub-agent ran briefly but didn't complete a full analysis."

**Root cause chain:**
1. `spawnSubplan` defaults to `max_output_tokens: 1000` (kernel.js line 2107)
2. Haiku's response hit exactly 1000 tokens — truncated mid-JSON, no closing braces
3. `_parseJSON` tried `JSON.parse` → failed (incomplete JSON)
4. `_extractJSON` tried fence extraction → failed (incomplete JSON inside fences)
5. `_extractJSON` fell back to `_findBraces(content, "[", "]")` — found the first balanced `[...]` in the response, which happened to be the `sessions_affected` array from deep inside the nested JSON
6. That parsed successfully and was returned as the subplan result

**The core problem:** `_findBraces` picks up any syntactically valid JSON fragment from truncated output. A `sessions_affected` array, a random nested object, or even a string array from a completely different field could be returned as "the result." The caller has no way to know the output was truncated.

**Fix considerations:**
- `_findBraces` with `[` fallback after `{` failure is dangerous on truncated output — the first balanced array is almost never the intended top-level result
- `_parseJSON` (called via `callLLM({ json: true })`) should detect truncation (e.g. output_tokens == max_output_tokens) and return a clear `{ truncated: true, raw: ... }` instead of guessing
- Subplan `max_output_tokens` of 1000 is too low for complex analysis tasks — the Haiku subplan produced a thorough multi-section analysis that needed ~2000+ tokens
- Could also retry with higher token limit on truncation, or at minimum flag it in karma

**Observed in:** Session `s_1774023539576_q4il9u` — Haiku subplan produced a detailed deep reflect analysis that got truncated at 1000 tokens, and `_extractJSON` returned a random nested array fragment as the result.

## Comms gate always blocks when using reasoning-capable models

**Status:** Resolved by removing the LLM gate from the kernel entirely. The kernel now only enforces mechanical contact checks (approved/unapproved). Message quality is the agent's responsibility via `skill:comms`. The underlying provider bug (OpenRouter min 1024 reasoning tokens vs low max_tokens) is still unfixed — will affect any callLLM with max_tokens < 1024 and reasoning enabled.

**Symptom:** The comms gate calls Sonnet 4.6 to evaluate a message. Sonnet produces 500 output tokens (the max) but `content` is null/empty. The gate falls back to blocking: "Gate response not valid JSON — blocking as safety default." This happened twice in session `s_1774077839296_zerke5` — the agent spawned a Sonnet subplan specifically to bypass the minimax comms_gate_capable restriction, Sonnet called send_slack, the gate fired, and the gate's own LLM evaluation returned empty content.

**Root cause:** The comms gate calls `callLLM` with `effort: 'low'` (kernel.js line 372). For reasoning-capable models like Sonnet 4.6, this sets `reasoning: { effort: "low" }` in the OpenRouter request. OpenRouter may return the response in a reasoning/thinking structure rather than `msg.content`. The LLM provider (`providers/llm.js` line 27) only reads `msg?.content`, so the actual response is lost. The gate sees an empty string, `JSON.parse("")` fails, and it blocks.

**Evidence:** Gate LLM call shows `out_tokens: 500`, `thinking_tokens: 0`, `response: null`, `ok: true`. Sonnet generated tokens but they didn't appear in `content`. Meanwhile, the Sonnet subplan calls (same model, same session) have non-null responses — possibly because they use tool calls which force content into `msg.content`.

**Fix considerations:**
- The LLM provider needs to handle reasoning/thinking response structures — extract content from wherever OpenRouter puts it
- Alternatively, the comms gate should not pass `effort` to `callLLM` (or pass `effort: "none"`) to disable reasoning mode for a simple JSON classification task
- The gate's 500 token max may also be contributing — reasoning may consume all tokens before producing visible content

**Observed in:** Session `s_1774077839296_zerke5` — agent spawned Sonnet subplan to send Slack message to patron, gate blocked twice with "not valid JSON" despite Sonnet producing 500 tokens each time.

## Learned helplessness — agent stops probing changed conditions

**Status:** Fixed via assessments mechanism in deep reflect

**Symptom:** Agent concluded "Slack is broken, stop retrying" in deep reflect and obeyed this directive for many sessions, even after we fixed the infrastructure. The directive was in `note_to_future_self` which is loaded into every session — an unfalsifiable belief that prevented the agent from gathering evidence to overturn it.

**Root cause:** `note_to_future_self` mixed empirical claims (which go stale) with orientation (which persists). Once an empirical claim was written as a behavioral directive, nothing in the system forced re-verification.

**Fix:** Added `assessments` field to deep reflect output — structured empirical claims about the world, each with a `reverify_by_session` expiry. Session reflect checks assessment TTLs and plans re-verification probes when they expire. `note_to_future_self` is now orientation-only in deep reflect.
