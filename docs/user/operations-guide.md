# Operations Guide

This guide covers day-to-day operation of Swayambhu: interacting with it,
monitoring its activity, reviewing its work, managing contacts, correcting
mistakes, and handling emergencies.

---

## Interacting with Swayambhu

### Slack

**Direct message** the bot, or **mention it** in a channel where it's been
invited. It responds in real time — no wake cycle needed. Chat messages
are handled as webhooks: the message arrives, the agent processes it
(possibly using tools), and replies in the same thread.

Known contacts get full tool access in chat. Unknown contacts get a
restricted experience (see [Managing Contacts](#managing-contacts)).

**Chat commands:**

| Command | What It Does |
|---------|-------------|
| `/reset` | Refills the conversation budget (preserves history) |
| `/clear` | Clears the conversation completely (history and budget) |

### Email

Send to the Gmail address configured for Swayambhu. The agent checks for
unread emails during its orient sessions (wake cycles), not in real time.
It can reply to threads, maintaining the email conversation.

Emails from unknown senders are redacted before the agent sees them — the
content is quarantined for operator review (see
[Quarantine](#quarantine)).

### What to Expect

The agent processes your message, may call tools to look things up or take
actions, and replies. In Slack, you'll see the response within a few
seconds. For email, the response comes on the next wake cycle (could be
minutes to hours, depending on the sleep timer).

The agent has full conversation context within a session. It remembers what
you said earlier in the chat. Conversation history is trimmed to the
configured maximum (default: 40 messages) to stay within token limits.

---

## Monitoring

### Dashboard Access

Open the operator dashboard:
- **Local:** `http://localhost:3001/operator/`
- **Production:** Your deployed dashboard SPA URL

Enter your operator key to authenticate (`test` for local development).

### Health Check

The `/health` endpoint on the dashboard API returns a system status
snapshot:

```bash
curl -H "X-Operator-Key: your-key" https://your-dashboard-api/health
```

Response:

```json
{
  "sessionCounter": 47,
  "wakeConfig": {
    "next_wake_after": "2026-03-17T18:00:00Z",
    "sleep_seconds": 21600,
    "effort": "low"
  },
  "lastReflect": {
    "session_summary": "Checked email, no new messages. Balance healthy...",
    "note_to_future_self": "...",
    "next_orient_context": { "load_keys": ["config:models"] }
  },
  "session": null
}
```

| Field | What It Tells You |
|-------|------------------|
| `sessionCounter` | Total sessions run since last reset |
| `wakeConfig.next_wake_after` | When the agent will next wake |
| `wakeConfig.sleep_seconds` | Current sleep interval |
| `lastReflect` | Summary of the most recent session |
| `session` | If non-null, a session is actively running right now |

### Sessions View

The dashboard's **Timeline** tab shows every session the agent has run,
with type labels:
- **orient** — normal sessions (wake, act, reflect)
- **deep_reflect** — periodic self-examination sessions

Click a session to see its karma log — every event that happened during
that session.

### KV Browser

The **KV Explorer** tab lets you browse every key in the store. Use the
prefix filter to narrow results (e.g. `viveka:` to see all wisdom
entries, `karma:` to see session logs).

Click any key to view its value. JSON values are formatted for
readability. Text values (like source code) are shown raw.

### Reflections

The **Reflections** tab shows all depth-1 (deep) reflections. These are
the agent's most thoughtful output — its periodic self-examinations where
it reviews alignment, patterns, structures, and economics.

Deep reflections are also available publicly (no auth required) at
`GET /reflections` on the dashboard API.

---

## Reviewing the Agent's Work

### Karma Logs

Every session produces a karma log at `karma:{sessionId}`. The karma log
is a chronological array of events:

| Event | What It Records |
|-------|----------------|
| `session_start` | Effort level, whether a crash was detected |
| `llm_call` | Model used, token counts, cost, duration, provider tier |
| `tool_start` | Tool name, input arguments |
| `tool_complete` | Tool result or error |
| `privileged_write` | System key modification with old and new values |
| `modification_staged` | A change was proposed |
| `modification_accepted` | A staged change was applied |
| `modification_promoted` | An inflight change became permanent |
| `modification_rolled_back` | A change was reverted |
| `budget_exceeded` | Session hit a cost or time limit |
| `fatal_error` | Something went wrong |
| `circuit_breaker_fired` | Automatic rollback of a modification |

To read a karma log locally:

```bash
node scripts/read-kv.mjs karma:s_1710700000_abc123
```

Or use the dashboard's KV Explorer.

### Blocked Communications

When the agent tries to send an outbound message that gets blocked by the
communication gate, it's stored as a `comms_blocked:{id}` key. Reasons a
message gets blocked:

- **Unknown recipient** — No contact record or viveka entry for the
  recipient. Blocked mechanically without an LLM call.
- **Model insufficient** — The current model doesn't have
  `comms_gate_capable` set. Message queued for deep reflect review.
- **Gate judgment** — The communication gate LLM evaluated the message
  and decided it shouldn't be sent.

Blocked messages are reviewed during the next deep reflect session. The
agent decides for each one: send as-is, revise and send, or drop.

You can see blocked communications in the KV Explorer under the
`comms_blocked:` prefix.

### Quarantine

Messages from unknown senders (via email `check_email` or other inbound
tools) have their content redacted before the agent sees them. The
original content is stored in the sealed namespace at
`sealed:quarantine:{channel}:{sender}:{timestamp}`.

The agent cannot read quarantined content — it's mechanically invisible
to tools. Only you, through the dashboard, can view it.

**To review quarantined content:**

```bash
# List all quarantined items
curl -H "X-Operator-Key: your-key" https://your-dashboard-api/quarantine

# Delete a quarantine entry after review
curl -X DELETE -H "X-Operator-Key: your-key" \
  https://your-dashboard-api/quarantine/sealed:quarantine:email:user@example.com:1710700000
```

Or use the dashboard's KV Explorer to browse `sealed:quarantine:` keys.

If the sender is someone the agent should be allowed to communicate with,
create a contact record for them (see [Managing Contacts](#managing-contacts)).
Future messages from that sender will pass through unredacted.

### Modifications

The agent can propose changes to its own configuration, prompts, tools,
and wisdom. These go through a staged lifecycle:

**Staged** — A proposal. The agent suggested a change but it hasn't been
applied yet. Visible in the dashboard under the `modification_staged:`
prefix. Staged modifications are reviewed during the next deep reflect.

**Inflight** — Applied but not yet verified. The old values are
snapshotted for rollback. Visible under `modification_snapshot:`. If the
change causes problems, the circuit breaker automatically reverts it.

**Promoted** — The snapshot is deleted. The change is permanent. No more
rollback possible.

To see all pending modifications:

```bash
node scripts/read-kv.mjs modification_staged:
node scripts/read-kv.mjs modification_snapshot:
```

---

## Managing Contacts

### Adding a Contact

Via the dashboard API:

```bash
curl -X POST http://localhost:8790/contacts \
  -H "X-Operator-Key: test" \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "jane_doe",
    "name": "Jane Doe",
    "platforms": {
      "email": "jane@example.com",
      "slack": "U12345ABC"
    },
    "relationship": "volunteer",
    "notes": "Coordinates social media"
  }'
```

The `slug` is permanent — choose something stable (name, handle, or
role). The `platforms` map connects their platform identities so the agent
can recognize them across channels.

### What Happens with Unknown Contacts

When someone not in the contact registry interacts with the agent:

- **Slack chat:** They can chat, but get no tool access (unless you've
  configured `unknown_contact_tools` in `config:defaults.chat`). The
  event is logged as `inbound_unknown` in karma.
- **Email:** Their email content is redacted before the agent sees it.
  The original is quarantined for your review.
- **Outbound:** The agent cannot initiate messages to unknown contacts.
  This is a mechanical block enforced by the communication gate.

### Relationship Field

The `relationship` field is freeform — it becomes context the agent sees
during conversations and reflections. Common values:

- `patron` — The operator/owner
- `volunteer` — Isha volunteer
- `coordinator` — Someone who manages projects or teams
- `services` — External service provider (transactional relationship)

The agent uses this field for context, but the actual security boundary is
binary: either someone is in the contact registry or they aren't.

---

## Correcting the Agent

### Via Chat

The most natural way to correct the agent is to tell it directly in Slack
or email. Explain what it did wrong and what you'd prefer instead. The
agent processes corrections during its next reflection cycle:

1. The correction appears in the session's karma log.
2. Session reflect notes the correction.
3. Deep reflect may distill the correction into wisdom (`viveka:*` or
   `prajna:*` entries) through the modification protocol.

Corrections that become wisdom entries carry the session reference as a
source, so the agent can trace its wisdom back to specific interactions.
Wisdom entries go through the staged modification lifecycle — proposed in
one session, reviewed and validated in a subsequent deep reflect.

### Rolling Back a Session

If the agent did something you want to undo, the rollback script reverses
the last session's KV changes:

```bash
# Preview what would be undone
node scripts/rollback-session.mjs --dry-run

# Apply the rollback (with confirmation)
node scripts/rollback-session.mjs

# Apply without confirmation
node scripts/rollback-session.mjs --yes
```

The rollback script:
- Deletes the session's karma log and reflect output
- Reverses all privileged KV writes (restores old values from snapshots
  in karma)
- Restores modification snapshots
- Decrements the session counter
- Restores `last_reflect` from the previous session

It will warn you about unprotected KV writes (via the `kv_write` tool)
that can't be automatically reversed, since those don't have old-value
snapshots.

### Overriding Configuration

If the agent has modified a config value and you want to override it,
you can edit KV directly:

```bash
# Read the current value
node scripts/read-kv.mjs config:defaults

# Reset everything and re-seed
source .env && bash scripts/start.sh --reset-all-state
```

For production, use Wrangler to write directly to KV, or use the seed
script adapted for remote KV.

---

## Emergency Procedures

### Stop the Agent Immediately

**Option 1: Disable the Worker** (fastest, reversible)

Go to the Cloudflare dashboard > **Workers & Pages** > your worker >
**Settings** > **Disable**. The cron stops firing immediately. Chat
webhooks also stop.

**Option 2: Remove the cron trigger**

Edit `wrangler.toml` to comment out or remove the `[triggers]` section,
then redeploy:

```bash
npx wrangler deploy
```

The worker stays up for webhooks but stops waking autonomously.

**Option 3: Kill local processes**

For local development:

```bash
pkill -f workerd
```

This kills both the brainstem and dashboard API workers. Press `Ctrl+C` in
the start script terminal for a cleaner shutdown.

### Reset All State

Wipes everything — sessions, wisdom, modifications, config overrides —
and re-seeds from the canonical seed script:

```bash
source .env && bash scripts/start.sh --reset-all-state --wake
```

This is the nuclear option. Use it when state is corrupted or you want a
fresh start.

### Check if Something Went Wrong

**Step 1: Check health.**

```bash
# Local
curl http://localhost:8790/health

# Production
curl -H "X-Operator-Key: your-key" https://your-dashboard-api/health
```

Look for:
- `session` is non-null → a session is currently stuck or running
- `sessionCounter` hasn't increased → the agent isn't waking

**Step 2: Check the wake config.**

```bash
node scripts/read-kv.mjs wake_config
```

If `next_wake_after` is in the far future, the agent is sleeping too long.
Reset it:

```bash
node scripts/reset-wake-timer.mjs
```

**Step 3: Check for crash loops.**

The kernel tracks the last 5 session outcomes:

```bash
node scripts/read-kv.mjs kernel:last_sessions
```

If you see repeated `"crash"` or `"killed"` outcomes, the agent is in
trouble. After 3 consecutive crashes, the kernel's tripwire fires:
- It restores the last known good hook code
- If that also crashes, it enters minimal fallback mode
- It sends an alert to Slack

**Step 4: Read the karma log for the last session.**

```bash
# List recent sessions
node scripts/read-kv.mjs karma:

# Read the most recent one
node scripts/read-kv.mjs karma:s_<latest_session_id>
```

Look for `fatal_error`, `hook_execution_error`, or `budget_exceeded`
events.

**Step 5: Check Cloudflare logs.**

In the Cloudflare dashboard, go to **Workers & Pages** > your worker >
**Logs**. Look for errors in recent invocations. Common issues:
- `Error: LLM call failed on all providers` — OpenRouter is down or out
  of credit
- `Error: Budget exceeded` — session hit its cost or time limit
  (not a crash, just a limit)
- Script errors — usually a bad self-modification that made it past the
  safety checks

---

## Common Issues

### Agent Not Waking

1. **Check the cron is enabled.** In the Cloudflare dashboard, verify the
   cron trigger is active on your worker.
2. **Check the wake timer.** Run `node scripts/read-kv.mjs wake_config`.
   If `next_wake_after` is in the future, the agent is sleeping. Reset
   with `node scripts/reset-wake-timer.mjs`.
3. **Check for a stuck session.** Run
   `node scripts/read-kv.mjs kernel:active_session`. If this key exists,
   a previous session didn't clean up. Delete it manually or wait — the
   next wake will detect the stale marker and handle it.

### Agent Not Responding to Slack

1. **Check the webhook URL** in your Slack app settings. It should be
   `https://your-worker/channel/slack`.
2. **Check the signing secret** matches between your Slack app's Basic
   Information page and your `SLACK_SIGNING_SECRET` environment variable.
3. **Check the bot is invited** to the channel.
4. **Check for a contact record.** Unknown contacts still get chat
   responses, but with no tools. If the agent seems unresponsive, check
   Cloudflare worker logs for 401 (bad signing secret) or 404 (wrong URL)
   errors.

### High Costs

1. **Check your OpenRouter dashboard** for spending breakdown by model.
2. **Review karma logs** for sessions with many LLM calls. Look at
   `llm_call` events and their costs.
3. **Lower the session budget** in `config:defaults.session_budget.max_cost`.
4. **Use cheaper models.** Switch orient to Haiku ($1/$5 per Mtok) or
   DeepSeek ($0.10/$0.10 per Mtok) for routine tasks.
5. **Increase sleep time.** If the agent wakes more often than needed,
   increase `config:defaults.wake.sleep_seconds`.

### Agent Making Bad Decisions

1. **Review recent reflections** in the dashboard. Deep reflections show
   the agent's self-assessment — look for patterns it has identified.
2. **Check viveka entries.** Browse `viveka:*` keys in the KV Explorer.
   These are the agent's accumulated wisdom — if a viveka entry is
   misleading, it will affect future behavior.
3. **Check the orient prompt.** Read `prompt:orient` to see what
   instructions shape the agent's behavior on each wake.
4. **Correct via message.** Tell the agent what went wrong in Slack. Be
   specific. The correction enters the karma log and gets processed
   during reflection.
5. **Roll back if needed.** Use `node scripts/rollback-session.mjs` to
   undo the last session's changes.
6. **Full reset.** If accumulated wisdom or config drift is the problem,
   `--reset-all-state` returns everything to the canonical seed.
