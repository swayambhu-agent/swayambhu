# Configuration Reference

This document covers every setting you can change to control how Swayambhu
behaves. Settings live in three places: environment variables (secrets),
KV keys (the agent's memory), and config files (Wrangler TOML). Each
section tells you where the setting lives and how to change it.

---

## Where Settings Live

### Environment Variables and Secrets

API keys and credentials. Set via `wrangler secret put` for production or
in `.env` for local development. These are opaque to the agent — it uses
them but cannot read or list them.

### KV Keys

Everything else: models, budgets, prompts, tools, contacts, behavior
config. Changed via:
- **Seed script** (`scripts/seed-local-kv.mjs`) — for initial setup
- **Dashboard API** — for contacts and quarantine management
- **Agent self-modification** — through the Modification Protocol during
  reflection

### Config Files

`wrangler.toml` and `wrangler.dev.toml` control the Cloudflare Worker
deployment: worker name, KV namespace binding, cron schedule, and
compatibility flags. These are not accessible to the agent at runtime.

---

## Model Configuration

### Model Registry — `config:models`

The model registry defines which LLM models are available, what they cost,
and their aliases:

```json
{
  "models": [
    {
      "id": "anthropic/claude-opus-4.6",
      "alias": "opus",
      "input_cost_per_mtok": 5.00,
      "output_cost_per_mtok": 25.00,
      "max_output_tokens": 128000,
      "best_for": "Strategy, deep reflection, full situational awareness"
    },
    {
      "id": "anthropic/claude-sonnet-4.6",
      "alias": "sonnet",
      "input_cost_per_mtok": 3.00,
      "output_cost_per_mtok": 15.00,
      "max_output_tokens": 64000,
      "best_for": "Writing, moderate reasoning, reflection, chat"
    },
    {
      "id": "anthropic/claude-haiku-4.5",
      "alias": "haiku",
      "input_cost_per_mtok": 1.00,
      "output_cost_per_mtok": 5.00,
      "max_output_tokens": 64000,
      "best_for": "Simple tasks, classification, cheap execution"
    },
    {
      "id": "deepseek/deepseek-v3.2",
      "alias": "deepseek",
      "input_cost_per_mtok": 0.10,
      "output_cost_per_mtok": 0.10,
      "max_output_tokens": 64000,
      "best_for": "Cheap dev testing"
    }
  ],
  "fallback_model": "anthropic/claude-haiku-4.5",
  "alias_map": {
    "opus": "anthropic/claude-opus-4.6",
    "sonnet": "anthropic/claude-sonnet-4.6",
    "haiku": "anthropic/claude-haiku-4.5",
    "deepseek": "deepseek/deepseek-v3.2"
  }
}
```

**Adding a new model:** Add an entry to the `models` array with its full
OpenRouter model ID, a short alias, and cost-per-million-token pricing.
Add the alias to `alias_map` so it can be referenced by short name
elsewhere in config.

**Aliases** let you write `"sonnet"` instead of
`"anthropic/claude-sonnet-4.6"` in config values. The kernel resolves
aliases at runtime.

**Fallback model** is used when the primary model fails. Keep this set to
a cheap, reliable model.

### Model Capabilities — `config:model_capabilities`

Capability flags control which models are allowed to perform sensitive
operations:

```json
{
  "anthropic/claude-opus-4.6": {
    "yama_capable": true,
    "niyama_capable": true,
    "comms_gate_capable": true
  },
  "anthropic/claude-sonnet-4.6": {
    "yama_capable": true,
    "niyama_capable": true,
    "comms_gate_capable": true
  }
}
```

| Flag | What It Controls |
|------|-----------------|
| `yama_capable` | Can modify yamas (outer ethics). Requires 200-char deliberation. |
| `niyama_capable` | Can modify niyamas (inner ethics). Requires 100-char deliberation. |
| `comms_gate_capable` | Can evaluate outbound messages through the communication gate. Models without this flag have messages queued for review instead. |

**This key is intentionally separate from `config:models`** to prevent
the agent from granting itself capabilities by editing the model registry.
Haiku and DeepSeek have no capability flags — they cannot modify principles
or pass the communication gate.

### Master Defaults — `config:defaults`

The central configuration for all agent behavior. Every role references
this key:

```json
{
  "orient": {
    "model": "anthropic/claude-haiku-4.5",
    "effort": "low",
    "max_output_tokens": 4000
  },
  "reflect": {
    "model": "anthropic/claude-sonnet-4.6",
    "effort": "medium",
    "max_output_tokens": 1000
  },
  "deep_reflect": {
    "default_interval_sessions": 5,
    "default_interval_days": 7,
    "model": "anthropic/claude-opus-4.6",
    "effort": "high",
    "max_output_tokens": 4000,
    "budget_multiplier": 3.0
  },
  "chat": {
    "model": "sonnet",
    "effort": "low",
    "max_cost_per_conversation": 0.50,
    "max_tool_rounds": 5,
    "max_output_tokens": 1000,
    "max_history_messages": 40,
    "unknown_contact_tools": []
  },
  "session_budget": {
    "max_cost": 0.15,
    "max_duration_seconds": 600,
    "reflect_reserve_pct": 0.33
  },
  "execution": {
    "max_subplan_depth": 3,
    "max_reflect_depth": 1,
    "reflect_interval_multiplier": 5,
    "max_steps": {
      "orient": 12,
      "reflect": 5,
      "deep_reflect": 10
    },
    "fallback_model": "anthropic/claude-haiku-4.5"
  },
  "wake": {
    "sleep_seconds": 21600,
    "default_effort": "low"
  },
  "memory": {
    "default_load_keys": ["config:models", "config:resources"],
    "max_context_budget_tokens": 8000
  },
  "failure_handling": {
    "retries": 1,
    "on_fail": "skip_and_cascade"
  }
}
```

Key sections explained below.

---

## Agent Behavior

### Wake Cycle

**Cron trigger** — Defined in `wrangler.toml`:

```toml
[triggers]
crons = ["* * * * *"]
```

The cron fires every minute. The agent checks its own sleep timer and
immediately returns if it's not time to wake. The no-op invocations cost
essentially nothing (one KV read).

**Sleep duration** — Controlled by `config:defaults.wake.sleep_seconds`
(default: 21600 = 6 hours). The agent can adjust its own sleep at the end
of each session via its reflect output. The value in `config:defaults` is
just the starting default.

**Wake config** — The live wake state is stored in the `wake_config` KV
key:

```json
{
  "next_wake_after": "2026-03-17T18:00:00Z",
  "sleep_seconds": 21600,
  "effort": "low"
}
```

To force an immediate wake, reset the timer:

```bash
node scripts/reset-wake-timer.mjs
curl http://localhost:8787/__scheduled
```

**Effort level** — Controls how deeply the agent thinks on each wake.
Values: `"low"`, `"medium"`, `"high"`. Lower effort uses fewer tokens
and completes faster. The agent can escalate its own effort in response to
tripwire conditions (e.g. low balance).

### Orient vs. Reflect

On each wake, the agent runs one of two modes:

**Orient** (normal) — The agent wakes, loads context, uses tools, acts on
the world, then does a session reflect (depth 0). This is the standard
cycle.

**Deep reflect** (periodic) — Replaces the orient session entirely. The
agent examines its own patterns, structures, and alignment instead of
acting on the world. Deep reflect runs when either condition is met:
- A configured number of sessions have passed since the last deep reflect
  (`default_interval_sessions`, default: 5)
- A configured number of days have passed (`default_interval_days`,
  default: 7)

### Reflect Scheduling

The schedule for each reflection depth is stored in
`reflect:schedule:{depth}`:

```json
{
  "after_sessions": 20,
  "after_days": 7,
  "last_reflect": "2026-03-15T10:00:00Z",
  "last_reflect_session": 42
}
```

The agent sets `after_sessions` and `after_days` in its deep reflect
output. If no schedule exists, the system falls back to
`config:defaults.deep_reflect.default_interval_sessions` and
`default_interval_days`.

**To force a deep reflect,** set `after_sessions` to 0 in the schedule
key, or delete the schedule key entirely.

### Session Budgets

Every session has hard limits, configured in
`config:defaults.session_budget`:

| Setting | Default | What It Controls |
|---------|---------|-----------------|
| `max_cost` | $0.15 | Maximum total LLM spend per session |
| `max_duration_seconds` | 600 | Wall-clock time limit (keep well below CF's 15-min hard limit) |
| `reflect_reserve_pct` | 0.33 | Fraction of budget reserved for the post-session reflect |

The kernel enforces these before every LLM call. When a budget is
exceeded, the session exits gracefully (not a crash).

During crash recovery, the kernel ignores `config:defaults` and uses a
hardcoded fallback budget ($0.50, 120 seconds, 3 steps).

### Step Limits

Each phase has a maximum number of tool-calling rounds, configured in
`config:defaults.execution.max_steps`:

| Phase | Default | What It Means |
|-------|---------|---------------|
| `orient` | 12 | Up to 12 rounds of LLM → tool call → result |
| `reflect` | 5 | Session reflect (usually 1 round, no tools) |
| `deep_reflect` | 10 | Up to 10 rounds during deep reflection |

---

## Contact Management

Contacts are the security boundary between Swayambhu and the outside
world. They determine who the agent can communicate with, what content
it can see from inbound messages, and how it behaves in chat.

### Why Contacts Matter

- **Outbound gate** — The agent cannot initiate messages to people who
  aren't in the contact registry. This is a mechanical block, not a
  prompt instruction.
- **Inbound redaction** — Messages from unknown senders have their
  content redacted before the agent sees it. The original content is
  quarantined for operator review.
- **Chat tools** — Known contacts get full tool access in chat. Unknown
  contacts get only the tools in the `unknown_contact_tools` allowlist
  (empty by default = no tools).

### Contact Record Structure

Contacts are stored at `contact:{slug}` in KV. The slug is a permanent
identifier — pick something stable like a name or handle.

```json
{
  "name": "Swami Kevala",
  "relationship": "patron",
  "about": "Bramhachari at Isha.",
  "timezone": "Asia/Kolkata",
  "location": "Isha Yoga Center, Coimbatore",
  "platforms": {
    "slack": "U084ASKBXB7"
  },
  "chat": {
    "model": "sonnet",
    "effort": "high",
    "max_cost_per_conversation": 1.00,
    "max_output_tokens": 2000
  },
  "communication": "Feel free to discuss absolutely anything."
}
```

**Required fields:**
- `name` — Display name
- `platforms` — Map of platform to user ID (e.g. `{ "slack": "U...", "email": "user@example.com" }`)

**Optional fields:**
- `relationship` — Describes the relationship (freeform, used for context)
- `about` — Background information the agent sees during conversations
- `timezone`, `location` — Used for context awareness
- `chat` — Per-contact overrides for chat behavior (see below)
- `communication` — Natural language guidance for how to communicate with
  this person

### Adding Contacts

**Via the dashboard API:**

```bash
curl -X POST http://localhost:8790/contacts \
  -H "X-Operator-Key: test" \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "jane_doe",
    "name": "Jane Doe",
    "platforms": { "email": "jane@example.com", "slack": "U12345" },
    "relationship": "volunteer",
    "notes": "Coordinates social media for Isha USA"
  }'
```

**Via the seed script:** Add an entry to `scripts/seed-local-kv.mjs` in
the Contacts section and re-seed.

Contact records are operator-managed. The agent cannot create or modify
contacts during normal orient sessions. During deep reflect, the agent
can *propose* contact changes through the modification protocol, but they
go through the same staged review as any other modification.

### Contact Index

When a message arrives, the kernel needs to look up the contact by
platform and user ID. The contact index at `contact_index:{platform}:{userId}`
maps each platform identity to its contact slug:

```
contact_index:slack:U084ASKBXB7 → "swami_kevala"
```

These are created automatically when you add a contact via the dashboard
API. If you add contacts via the seed script, add the index entries too.

### Per-Contact Chat Config

The `chat` field on a contact record overrides global chat defaults for
that person:

| Setting | Global Default | What It Controls |
|---------|---------------|-----------------|
| `model` | `sonnet` | Which LLM model to use in chat |
| `effort` | `low` | Thinking depth |
| `max_cost_per_conversation` | $0.50 | Budget cap for a single conversation |
| `max_output_tokens` | 1000 | Maximum response length |
| `max_tool_rounds` | 5 | Maximum tool-calling rounds per turn |
| `max_history_messages` | 40 | Conversation history window |

For important contacts (like the patron), you might set higher effort,
a larger budget, and longer responses. For casual contacts, the defaults
are usually fine.

### Chat Commands

Users in Slack can send these commands:

| Command | What It Does |
|---------|-------------|
| `/reset` | Refills the conversation budget (preserves history) |
| `/clear` | Clears conversation history and budget |

---

## Channel Settings

### Enabling Channels

Channels are stored as code + config pairs in KV:
- `channel:slack:code` — The Slack adapter (webhook verification, message parsing, reply sending)
- `channel:slack:config` — Which secrets the adapter needs

The Slack channel is seeded by default. To disable it, delete these keys.
To add a new channel, write a new adapter following the same pattern and
add its config.

### Webhook URL

Each channel has a webhook endpoint on the main worker:

```
https://your-worker.workers.dev/channel/{channel_name}
```

For Slack: `https://your-worker.workers.dev/channel/slack`

The kernel loads the channel adapter from KV, verifies the webhook
signature, parses the inbound message, and routes it to the chat handler.

### Unknown Contact Behavior

When someone who isn't in the contact registry messages the bot:

1. **Content is not redacted** in chat (redaction only applies to inbound
   tool results like `check_email`, not direct chat messages).
2. **Tools are restricted.** Only tools listed in
   `config:defaults.chat.unknown_contact_tools` are available. By default
   this is an empty array — unknown contacts get no tool access.
3. The event is recorded in karma as `inbound_unknown`.

To give unknown contacts access to specific tools:

```json
{
  "chat": {
    "unknown_contact_tools": ["kv_query", "web_fetch"]
  }
}
```

---

## Communication Settings

### The Outbound Communication Gate

Every outbound message passes through a three-layer gate before it's
sent. This is kernel-enforced — the agent cannot bypass it.

**Layer 1 — Mechanical floor.** If the tool is initiating contact (not
replying to someone who messaged first) and the recipient has no
`upaya:contact:*` entry, the message is blocked immediately. No LLM call
is made. Unknown recipients require upaya entries before the agent can
reach out.

**Layer 2 — Model gate.** The current model must have
`comms_gate_capable: true` in `config:model_capabilities`. If not (e.g.
using Haiku or DeepSeek), the message is queued for review during deep
reflect rather than evaluated by the gate.

**Layer 3 — LLM judgment.** A gate LLM call evaluates the message against
accumulated communication wisdom (`upaya:contact:*`, `upaya:channel:*`,
`upaya:comms:*`). The gate can:
- **Send** — message goes through as-is
- **Revise** — message is rewritten and then sent
- **Block** — message is stored for review

### Default Communication Stance — `upaya:comms:defaults`

The seed value establishes a conservative baseline:

> When in doubt, do not send. Silence is safer than a poorly judged
> message. A blocked message can be reviewed later; a sent message cannot
> be unsent. Be especially cautious when initiating — responding carries
> implicit standing, initiating requires justification.

The agent can evolve this stance through the wisdom modification protocol
during deep reflection.

### Blocked Communications

Messages blocked by the gate are stored as `comms_blocked:{id}` keys.
They accumulate until the next deep reflect session, which reviews each
one and issues a verdict:

- **send** — the original message was appropriate, send it now
- **revise_and_send** — right intent, needs better execution; provide
  revised text
- **drop** — should not have been sent; discard with a reason

You can see blocked communications in the deep reflect output or by
browsing `comms_blocked:*` keys in the dashboard's KV Explorer.

---

## Spending Limits

### OpenRouter

Set a spending cap on your API key in the
[OpenRouter dashboard](https://openrouter.ai/settings/credits). This is
your hard ceiling — even if the agent's per-session budget is
misconfigured, OpenRouter will reject calls once the cap is reached.

Recommended starting budget: $10-20 for testing, $50-100 for ongoing
operation with production models.

### Per-Session Budget

Configured in `config:defaults.session_budget.max_cost` (default: $0.15
per session). This is the soft ceiling enforced by the kernel before each
LLM call. A typical orient session with Haiku costs $0.01-0.03. A deep
reflect with Opus costs $0.10-0.40.

The `budget_multiplier` in `config:defaults.deep_reflect` (default: 3.0)
multiplies the session budget during deep reflect, since those sessions
use expensive models and need more room.

### Cloudflare

The Workers paid plan is $5/month and includes 10 million requests. The
cron fires ~43,000 times per month (once per minute). Most are no-ops.
Active sessions make ~10-50 subrequests each (LLM calls, KV reads/writes).
The $5 plan is more than sufficient.

KV includes 1 GB of storage and 10 million reads/day on the paid plan.
Swayambhu typically uses a few MB of storage and a few thousand reads per
day.

### Wallet Monitoring

If you've configured a crypto wallet (`WALLET_ADDRESS`,
`WALLET_PRIVATE_KEY`), the agent monitors its USDC balance on the Base
chain. This is informational — the agent reports the balance but doesn't
spend from the wallet autonomously.

---

## Overriding Config at Dev Startup

The start script supports config overrides without editing the seed
script:

```bash
# Override any config:defaults value using dot-path notation
source .env && bash scripts/start.sh --reset-all-state \
  --set orient.model=deepseek \
  --set reflect.model=deepseek \
  --set session_budget.max_cost=0.01 \
  --set wake.sleep_seconds=60

# Multiple --set flags can be combined
```

Overrides are applied after seeding, so they take precedence over seed
values. The `--set` flag requires `--reset-all-state` (overriding config
that's already in KV has no effect — the seed has to run first).

Values are auto-typed: `true`/`false` become booleans, numbers become
numbers, everything else is a string.

---

## Quick Reference: All Configurable KV Keys

| Key | What It Controls | Changed By |
|-----|-----------------|------------|
| `config:defaults` | Models, budgets, effort, steps, sleep, chat | Seed, agent (via modification protocol) |
| `config:models` | Model registry, aliases, pricing | Seed, agent (via modification protocol) |
| `config:model_capabilities` | Per-model capability flags | Seed, operator (manual KV edit) |
| `config:resources` | Platform limits, external endpoints | Seed |
| `config:tool_registry` | Tool names and descriptions for LLM | Seed, agent (via modification protocol) |
| `wake_config` | Next wake time, sleep duration, effort | Agent (after each session) |
| `reflect:schedule:{depth}` | When next deep reflect is due | Agent (after deep reflect) |
| `contact:{slug}` | Contact records | Operator (dashboard API or seed) |
| `upaya:comms:defaults` | Default communication stance | Agent (via wisdom modification) |
| `upaya:comms:*` | Communication wisdom entries | Agent (via wisdom modification) |
| `upaya:contact:*` | Per-contact communication wisdom | Agent (via wisdom modification) |
| `prompt:orient` | Orient session system prompt | Agent (via modification protocol) |
| `prompt:reflect` | Session reflect prompt | Agent (via modification protocol) |
| `prompt:reflect:1` | Deep reflect prompt | Agent (via modification protocol) |
| `prompt:chat` | Chat system prompt | Agent (via modification protocol) |
| `yama:*` | Outer ethics | Agent (with deliberation + capable model) |
| `niyama:*` | Inner ethics | Agent (with deliberation + capable model) |
