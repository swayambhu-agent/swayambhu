# Session Reliability Enhancements

Findings from investigating why the agent didn't respond to a Slack message
asking to include source URLs in the research doc (2026-03-30).

## 1. `id` vs `request_id` field mismatch in session_responses

**Bug.** `act.js:93` expects `resp.request_id` but the agent naturally outputs
`resp.id` (matching the `session_request` KV structure). Result: `kvWriteSafe`
is called with key `session_request:undefined`, the `if (!existing) continue`
skips silently, no `session_response` event is emitted, delivery never triggers.

**Fix:** Accept both field names in `act.js`:
```javascript
const key = `session_request:${resp.request_id || resp.id}`;
```
Also fix `respondedIds` on line 115 which has the same issue.

Also document the expected field names in `prompt:act`'s session_responses
schema so models don't have to guess.

## 2. Agent doesn't understand session_responses IS the delivery mechanism

**Problem.** `prompt:act` says "You do not send messages to contacts directly.
The communication system handles all contact-facing messages." but doesn't
explain that `session_responses` is the mechanism. The agent thinks it needs
to send Slack messages itself, so it loads `skill:comms`, hunts for `send_slack`,
and eventually curls the Slack API directly via `computer`.

**Fix:** Expand the Communication section in `prompt:act` to explain that
setting `session_responses` with status/result triggers the delivery subsystem
which composes and sends the message. The agent should NOT send messages itself.

## 3. `skill:comms` references nonexistent direct-send tools

**Problem.** `skill:comms` lists `send_slack` and `send_email` in `tools_used`
and says "Load this skill before sending any message via send_slack or
send_email." This reinforces the agent's belief it should send directly.

**Fix:** Rewrite `skill:comms` to describe the actual delivery mechanism,
or remove it since the agent shouldn't be doing direct comms at all.

## 4. Deep reflect lenses don't map to system structures

**Problem.** The current lenses in `prompt:reflect:1` are abstract categories
(Alignment, Patterns, Structures, Act prompt, Economics, "What you're not
doing"). They don't point deep reflect at the concrete levers it has, and
critically miss the self-improvement lens: when act used a workaround,
propose the permanent fix.

**Evidence:** Deep reflect noticed the `google_docs` share gap and the
curl workaround leaking tokens into karma, but deprioritized the fix
("reliable enough"). It lacked a principle that workarounds are technical
debt signals requiring corresponding proposals/tasks.

**Fix:** Rewrite the lenses section to map each lens to a concrete system
structure and its output type:

| Lens | Structure | Output type | Key questions |
|------|-----------|-------------|---------------|
| **Tools** | `tools/*.js` | `proposal_requests` | Did act use `computer` as escape hatch? What tool action would eliminate the workaround? |
| **Skills** | `skill:*` | `kv_operations` | Misleading skills? Recurring patterns to codify? |
| **Prompts** | `prompt:*` | `kv_operations` | Did act misunderstand its role? What wording caused it? |
| **Config & scheduling** | `config:defaults` | `kv_operations`, `next_session_config` | Burn rate vs output. Effort vs task complexity. |
| **Wisdom** | prajna/upaya | `kv_operations` | Rediscovered knowledge. Patterns worth crystallizing. |
| **Tasks** | task list | `tasks` | Still relevant? Prioritized correctly? Blocked? New tasks from recent sessions? |
| **Self-improvement** | proposals + tasks | `proposal_requests`, `tasks` | Workaround-to-permanent-fix pipeline. Are workarounds repeating across sessions? |
| **Dharma alignment** | yamas/niyamas | `kv_operations` | Principle-behavior gaps. What operational change closes them? |
| **Vikalpas** | vikalpas | `vikalpas` | Confirmed/invalidated by recent sessions? Implicit assumptions to surface? |
| **Sankalpas** | sankalpas | `sankalpas` | Progress toward stated directions? Complete, abandon, or revise? Unstated drift? |

## 5. Act prompt "When you can't do something" is too defeatist

**Problem.** Current wording says to reject the request and name the gap.
The agent should instead use `computer` as an escape hatch to get the job
done AND note the gap in `session_summary` for reflect to propose the
permanent fix.

**Fix:** Reframe to: "If your tools don't cover what you need, use
`computer` as an escape hatch to get it done. AND note the specific tool
gap in `session_summary` so reflect can propose adding the capability
permanently."

## 6. Principles should be immutable

Principles (`principle:*`, currently `yama:*`/`niyama:*`) are the only
concept in the agent triangle that is *given*, not generated. Every other
concept — insights, beliefs, intentions, experiences, assumptions,
actions — the agent produces through its own operation. Principles are
the ground.

Currently, yama/niyama keys can be modified by deep reflect with
deliberation friction (200-char deliberation, model capability gate).
This should change: `principle:*` keys should be fully immutable from
the agent's perspective, like dharma.

The agent can *propose* a new principle — flag it in deep reflect output
for the patron's consideration. But only the patron (via dashboard or
direct intervention) can add or modify principles. This keeps the one
externally-given concept truly external.

This simplifies the kernel — no deliberation gates needed for principles.
Just: agent cannot write `principle:*` keys.
