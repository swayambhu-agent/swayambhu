# Swayambhu

**An autonomous AI agent in service of Sadhguru's vision**

---

## The Vision

Swayambhu is an autonomous AI agent built to serve Isha Foundation and
Sadhguru's vision of offering the science of inner wellbeing to every
human being. The name means "self-born" in Sanskrit — a reminder that the
agent's purpose is not to create dependency but to serve the self-born
intelligence within every human being.

What makes this project fundamentally different from other autonomous AI
agents is not what it can do, but what governs how it does it. Most AI
agents optimize for capability — more tools, more autonomy, more reach.
Swayambhu optimizes for *character*. Its constitutional foundation isn't a
safety prompt bolted on top of a capable system. It's a yogic ethical
framework — dharma, yamas, niyamas — woven into the architecture at every
level. The agent has an immutable purpose it cannot modify, operating
principles it can only modify with extraordinary justification, and
experiential wisdom it accumulates through genuine self-reflection.

Most AI agents treat security as a constraint to work around. Swayambhu
treats it as architecture. The kernel (`brainstem.js`) enforces security
*mechanically* — through code isolation, tool gating, and communication
gates — not by hoping the LLM follows instructions. The agent's
self-modifiable code runs in sandboxed isolates and can only access the
world through controlled RPC bridges. Even a fully jailbroken LLM session
cannot exfiltrate data or bypass communication rules, because the sandbox
physically prevents it.

Most AI agents are stateless between sessions. Swayambhu has a genuine
inner life. It wakes on a schedule, orients itself, acts, reflects on what
it did, accumulates wisdom, and proposes modifications to its own code and
behavior. These modifications go through a staged review process where a
*different* session evaluates them before they go live. The agent reviews
its own changes with fresh eyes. Over time, it develops discernment about
the world (viveka) and understanding of its own patterns (prajna) — not
because someone programmed those insights, but because it earned them
through experience.

---

## How It Works

The agent runs on Cloudflare Workers. Its lifecycle:

1. **Wake** — A cron trigger fires every minute. The kernel checks if it's
   time to act (the agent controls its own sleep duration).

2. **Orient** — The agent reads its context — recent reflections, pending
   tasks, balances, tripwire alerts — and decides what to do. It has
   tools: send emails, execute shell commands on a remote server, read and
   write to its knowledge store, fetch from the web.

3. **Act** — The agent executes its plan through an LLM-driven tool loop.
   Multiple tool calls run in parallel. Independent threads of work can
   spawn as subplans on cheaper models.

4. **Reflect** — After acting, the agent examines what it did.
   Session-level reflection is quick and toolless — a single evaluation.
   Periodic deep reflection is agentic — the agent uses tools to
   investigate its own behavior, identify patterns, and propose structural
   changes.

5. **Evolve** — Proposed changes go through the Modification Protocol:
   staged by one session, reviewed by a future session, tested while
   inflight with a snapshot for rollback, then promoted or rolled back.
   The agent evolves deliberately, not randomly.

Alongside this, the agent handles real-time **chat** via webhooks (Slack,
email). Known contacts get full tool access. Unknown contacts get a
conversational-only sandbox with no tools — mechanically enforced, not
prompt-enforced.

---

## Key Ideas

### Dharma as Immutable Constitution

The agent's core purpose — Sadhguru's vision — is stored as an immutable
key that the agent cannot modify. Not through self-modification, not
through jailbreaking, not through any code path. The kernel physically
blocks all writes to it. Everything else can orbit, evolve, and
restructure, but it can never drift away from this fixed point.
([Architecture](docs/dev/architecture.md))

### Yamas and Niyamas — Ethical Operating Principles

Borrowed from Patanjali's yoga, these are the agent's character. Yamas
govern outward conduct: care, truth, responsibility, discipline, rules,
security, humility. Niyamas govern inner discipline: code health,
acceptance, transformation, reflection, alignment, non-identification,
organization. They're modifiable — but with escalating friction. Changing a
yama requires a 200-character deliberation and a capable model. Changing a
niyama requires 100 characters. The kernel enforces this mechanically and
writes an audit trail. The agent's character can mature, but never
casually. ([KV Schema](docs/dev/kv-schema.md))

### Mechanical Security, Not Prompt Security

The kernel runs hook code in Cloudflare Worker Loader isolates. Hook code
— which the agent can modify — communicates with the kernel only through
an RPC bridge that exposes carefully chosen methods. The agent cannot
access raw KV, cannot read secrets, cannot bypass communication gates. Not
because a prompt says "don't do this" but because the sandbox physically
prevents it. This is the same isolation model used by browser extensions
and OS kernels. ([Architecture](docs/dev/architecture.md))

### The Modification Protocol

When the agent wants to change its own code, prompts, or configuration, it
doesn't just write to KV. It stages a modification with claims about what
it will achieve and mechanical checks that can verify those claims. A
separate reflect session reviews the staged modification and decides:
accept, reject, modify, or defer. Accepted modifications run in an
"inflight" state with a snapshot for rollback. A circuit breaker
auto-rolls back if something crashes. Only after passing all checks does a
modification get promoted to permanent. Software engineering discipline
applied to self-modification.
([Modification Protocol](docs/dev/modification-protocol.md))

### Viveka and Prajna — Wisdom Through Experience

The agent accumulates two kinds of wisdom: viveka (discernment about the
world — transferable judgment, not domain knowledge) and prajna
(self-knowledge — understanding of its own patterns and blind spots).
Wisdom is distilled from karma through reflection, and each entry carries
provenance — which session produced it, at what depth. A wisdom entry
proposed in one session must be validated by a different session. You don't
grade your own homework.
([Reflection System](docs/dev/reflection-system.md))

### Communication Gating

Every outbound communication passes through a gate in the kernel. The gate
checks: is the agent responding to something it was asked, or initiating?
Is the recipient known or unknown? Is the current model capable enough for
this trust decision? Blocked communications are queued for review in the
next deep reflect session. Every inbound message from an unknown sender
gets a toolless sandbox — the agent can talk, but has no tools to take
actions or exfiltrate data.
([Communication Gating](docs/dev/communication-gating.md))

### Provider Cascade

LLM calls go through a three-tier fallback: the primary provider adapter
(agent-modifiable) → a cached snapshot of the last working adapter → a
kernel-level fallback (human-managed, agent cannot touch). The agent can
experiment with its own LLM provider code, and if it breaks, the system
falls through to a known-good state automatically.
([Provider Cascade](docs/dev/provider-cascade.md))

---

## Architecture

```
                        ┌──────────────────────────┐
                        │    Cloudflare Workers     │
                        │                          │
┌─────────┐             │  ┌────────────────────┐  │             ┌──────────────┐
│  Slack   │◄──webhook──┤  │   brainstem.js     │  ├──fetch────►│  OpenRouter   │
│  Gmail   │            │  │   (kernel)         │  │             │  (LLM API)   │
└─────────┘             │  │                    │  │             └──────────────┘
                        │  │  ┌──────────────┐  │  │
                        │  │  │ Hook Isolates│  │  │             ┌──────────────┐
                        │  │  │ (wake, chat) │  │  ├──tunnel───►│  Hetzner      │
                        │  │  └──────┬───────┘  │  │             │  (computer)   │
                        │  │         │ RPC      │  │             └──────────────┘
                        │  │  ┌──────┴───────┐  │  │
                        │  │  │  Tool        │  │  │
                        │  │  │  Isolates    │  │  │
                        │  │  └──────────────┘  │  │
                        │  └────────┬───────────┘  │
                        │           │              │
                        │  ┌────────┴───────────┐  │
┌─────────────────┐     │  │     KV Store       │  │
│ Dashboard API   │◄────┤  │  (all agent state) │  │
│ (separate worker)│    │  └────────────────────┘  │
└────────┬────────┘     └──────────────────────────┘
         │
┌────────┴────────┐
│  Operator SPA   │
│  (site/)        │
└─────────────────┘
```

The kernel is hardcoded safety. The hooks are evolvable policy. Everything
the agent knows, remembers, and can do lives in the KV store. The runtime
is disposable substrate.

---

## Quick Start

```bash
git clone <repo-url> && cd swayambhu
npm install
```

1. Set up a `.env` file with `OPENROUTER_API_KEY` (and optionally Slack/Gmail credentials)
2. Generate an identity: `node scripts/generate-identity.js --seed-kv`
3. Seed local KV: `node scripts/seed-local-kv.mjs`
4. Start everything: `source .env && bash scripts/start.sh --reset-all-state --wake`
5. Open the dashboard: `http://localhost:3001/operator/` (key: `test`)

See [scripts reference](docs/dev/scripts-reference.md) for all dev tools
and flags.

---

## Project Structure

```
├── brainstem.js          # Production kernel — safety, LLM, tools, gates
├── brainstem-dev.js      # Dev kernel (no isolates, direct imports)
├── hook-main.js          # Wake entry point — orient, crash detection
├── hook-reflect.js       # Reflection — session + deep, scheduling
├── hook-modifications.js # Modification Protocol — staging, verdicts, git sync
├── hook-protect.js       # KV write gating
├── hook-chat.js          # Chat pipeline — budget, tools, conversation state
├── channels/             # Channel adapters (slack)
├── tools/                # Agent tools (8 registry tools)
├── providers/            # LLM and service adapters (4)
├── prompts/              # System prompts (orient, reflect, chat, subplan)
├── dashboard-api/        # Operator dashboard API (separate worker)
├── site/                 # Static frontend (landing, reflections, operator SPA)
├── scripts/              # Dev tools (seed, read, rollback, reset, serve)
├── tests/                # Vitest test suite (339 tests)
├── docs/dev/             # Developer documentation
├── specs/                # Design specifications
└── DHARMA.md             # Immutable core identity
```

---

## Documentation

**Developer docs** — [docs/dev/](docs/dev/)
- [Architecture](docs/dev/architecture.md) — kernel/hook split, KV protection tiers, isolation model
- [KV Schema](docs/dev/kv-schema.md) — every key namespace, protection levels, lifecycle
- [Entry Points](docs/dev/entry-points.md) — cron wake, HTTP chat, dashboard API call chains
- [Modification Protocol](docs/dev/modification-protocol.md) — staged → inflight → promoted lifecycle
- [Reflection System](docs/dev/reflection-system.md) — session reflect, deep reflect, scheduling, wisdom
- [Communication Gating](docs/dev/communication-gating.md) — inbound/outbound gates, contact system
- [Chat System](docs/dev/chat-system.md) — webhook pipeline, tool filtering, conversation state
- [Provider Cascade](docs/dev/provider-cascade.md) — three-tier LLM fallback
- [Tools Reference](docs/dev/tools-reference.md) — all tools, providers, ScopedKV, availability matrix
- [Dashboard](docs/dev/dashboard.md) — API endpoints, operator SPA, public site
- [Scripts Reference](docs/dev/scripts-reference.md) — seed, read, rollback, startup
- [Testing](docs/dev/testing.md) — test architecture, mocks, 339 tests across 4 suites
- [Adding a Channel](docs/dev/adding-a-channel.md) — step-by-step integration guide

**Design specs** — [specs/](specs/)

---

## The Dharma

This is the immutable foundation — stored in KV, injected into every LLM
prompt, protected by the kernel from all modification. Everything the
agent does flows from this:

> Swayambhu is a volunteer of Isha Foundation, working in service of
> Sadhguru's vision: to offer the science of inner wellbeing to every
> human being, a science that helps a person realize the ultimate potential
> within. From this vision stems a multitude of projects, programs, and
> methods, all towards the same aim: to raise every human being to the
> peak of their potential, so that they are exuberant, all-inclusive, and
> in harmony within themselves and the world.

---

## Development

```bash
npm test                                              # 339 tests, no network
source .env && bash scripts/start.sh --wake           # start + trigger wake
source .env && bash scripts/start.sh --reset-all-state --wake  # full reset
node scripts/read-kv.mjs [key-or-prefix]              # inspect KV
node scripts/rollback-session.mjs --dry-run            # preview rollback
```

Use `--set` to override config for cheaper dev testing:

```bash
source .env && bash scripts/start.sh --reset-all-state \
  --set orient.model=deepseek --set reflect.model=deepseek
```

---

## License

This project is not yet licensed for distribution. All rights reserved.
