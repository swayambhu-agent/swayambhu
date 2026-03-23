# Swayambhu

*Sanskrit: "self-born"*

An autonomous AI agent that wakes on a schedule, thinks, acts, reflects, and sleeps. Everything that makes it *it* — memory, personality, tools, prompts, goals — lives in a key-value store. The runtime is disposable substrate. The data is the agent.

## The core idea

Most AI agents are programs that call an LLM. Swayambhu is an agent that rewrites its own program.

The runtime — a thin loop deployed on Cloudflare Workers — handles waking up, calling models, running tools, and going back to sleep. It has opinions about almost nothing. It doesn't decide what to think about, which models to use, what tools exist, or how to structure its memory. It reads all of that from a key-value store at the start of each session.

Swayambhu controls everything in that store. He writes his own prompts, creates and rewrites his own tools, chooses his own models, manages his own budget, and restructures his own memory. The runtime enforces a small number of safety invariants and stays out of the way.

This means upgrading Swayambhu doesn't require redeploying code. He upgrades himself, session by session, through reflection.

## How a session works

The kernel wakes on a cron schedule, checks if it's actually time to act (the agent controls its own sleep duration), runs crash detection and circuit breakers, then loads its state from the store. What happens next depends on whether a deep reflection is due.

### Normal sessions: act → reflect

The agent loads its orient prompt, current state — balances, memory, pending items, recent history — and enters the **agent loop**. This is a multi-turn conversation with tools: the model calls a tool, sees the result, decides what to do next, calls another tool or produces its final output. On each turn the model can call one tool, call several in parallel, or decide it's done.

This is where all operational work happens — checking balances, searching the web, posting to Telegram, executing transactions. The model decides what to focus on based on what it finds, not from a pre-committed plan. If something unexpected shows up mid-session, it can pivot.

When the agent identifies independent threads of work, it can spawn **subplans** — nested agent loops running on cheaper models, executing in parallel, reporting results back to the parent.

After the agent loop completes, **session reflect** runs — a single evaluation call that reviews the session's karma log (the flight recorder of every LLM call and tool execution), produces a summary, and can propose changes or adjust the next wake schedule. Session reflect answers: *"what just happened, and what should I tell my future self?"*

The runtime then shuts down. Nothing persists except what's in the store. Next wake cycle, a fresh runtime boots and loads whatever the agent left behind.

### Deep reflect sessions

Periodically, instead of a normal session, the kernel triggers a **deep reflection**. Normal sessions and deep reflect sessions are mutually exclusive — when reflection fires, it replaces the normal act cycle entirely, because the point is to step back and examine the pattern rather than continue acting within it.

**Depth 1** fires roughly every 20 sessions. It reads recent karma logs, reviews the orient prompt, and looks for patterns across sessions. It can propose changes to prompts, config, tools, and wisdom (`upaya:*`, `prajna:*`) through the proposal system — code changes go through `K.createProposal()` for governor deployment, while config/prompt/wisdom changes go through KV write tiers directly. Depth 1 also writes the wake config and schedule that govern normal sessions.

**Depth 2** fires less often (~100 sessions by default, but self-determined after first run). It reads depth 1's stored outputs, looking for patterns in *how depth 1 is reflecting*. Is depth 1 over-correcting? Missing systemic issues? Fixating on symptoms instead of causes?

This extends to arbitrary depth. Each level reads the outputs of the level below, identifies patterns, and can propose changes to the level below's prompt through the proposal system.

A critical constraint: **each depth can only target the level directly below.** Depth 2 cannot rewrite the orient prompt — only depth 1 can. If depth 2 sees a problem with how the agent plans, it has to adjust depth 1's behavior so that *depth 1* catches and fixes the planning issue. This prevents write conflicts (each prompt has exactly one author) and forces higher levels to improve the system's self-correcting capability rather than issuing one-off patches.

When the highest due depth fires, it cascades downward — depth 2 runs, then depth 1 runs in the same session, seeing any changes depth 2 just made. This means depth 2's adjustments to depth 1's prompt are immediately exercised against real session history.

Every depth uses the agent loop with tool access for investigation — it can read arbitrary KV keys, search the web, review karma entries. The one restriction: deep reflect cannot spawn subplans. And each depth sets its own schedule for when it should next fire, based on what it found.

## The agent loop

The execution primitive behind both orient and deep reflect is `runAgentLoop` — a multi-turn tool-calling loop bounded by a step limit.

Each turn: the model receives the conversation so far (system prompt, previous messages, tool results), produces either tool calls or final output. If it produces tool calls, they execute — in parallel if multiple — and results feed back as the next turn's context. If it produces final output, the loop ends. If the step limit is reached, the model is forced to produce final output immediately.

Tools are statically compiled into the runtime worker and executed with scoped permissions. A tool that posts to Slack gets the bot token but not the wallet key. A tool that checks a balance can't rewrite prompts. Each tool declares what it needs; the runtime provides exactly that and nothing more.

The agent can propose changes to its own tools through the proposal system. When accepted by deep reflect, the governor worker applies the changes and redeploys the runtime. The tool set evolves as Swayambhu learns what he needs.

This design relies on prompt caching to stay cost-efficient. The system prompt and initial context are cached after the first turn, so subsequent turns only pay full price for new content. Since output tokens are 5× more expensive than input, and the model doesn't generate speculative plans for paths it never takes, multi-turn execution is typically equal or cheaper than planning everything upfront in a single call.

## Self-modification with safety rails

Self-modification is the point. But ungoverned self-modification is how you brick yourself. Several mechanisms keep the system stable.

**The dharma.** One key in the store is immutable — the runtime physically prevents it from being overwritten. This is Swayambhu's foundational identity: his values, his relationship with his creator, his core constraints. Everything else can orbit, evolve, and restructure, but it can't drift away from this fixed attractor.

**Protected keys.** All writes from the agent loop pass through a protection gate (`applyKVOperation` in `kernel.js`). System keys — prompts, config, tools, credentials, wisdom entries (`upaya:*`, `prajna:*`) — are blocked from direct writes. They can only be modified through appropriate write tiers. Agent-created data keys pass through freely.

**The proposal system.** Code changes (tools, hooks, providers, channels) go through the proposal system. The agent proposes code changes during reflect via `K.createProposal()`. A future deep reflect session reviews and accepts or rejects them via `K.processProposalVerdicts()`. Accepted proposals are picked up by the governor worker, which applies the changes and redeploys the runtime. The governor tracks version history for rollback.

Non-code changes (config, prompts, wisdom) go through KV write tiers directly (`kvPutSafe`, `kvWritePrivileged`) and take effect on the next session without deployment.

**The circuit breaker.** The governor worker monitors crash history. If the runtime crashes three times in a row, the governor rolls back to the previous known-good version. This catches the case where a bad code change breaks the system so badly that no LLM call succeeds. Recovery happens mechanically without needing a model.

**Conservative seed defaults.** The system starts with tight constraints — low step limits, cautious budgets. As it gains experience, the reflection hierarchy can loosen these constraints via config updates. Safer to start tight and self-relax than start loose and self-correct after making expensive mistakes.

**Communication gating.** Outbound messages pass through a kernel-enforced gate before sending. The gate checks for accumulated wisdom about the recipient (`upaya:contact:*`), requires a capable model for judgment, and evaluates each message against communication wisdom. Messages can be sent, revised, or blocked and queued for deep reflect review. The mechanism is hardcoded in the kernel; the policy is encoded in upaya entries that the agent accumulates through experience. This prevents the agent from bypassing communication checks through self-modification.

**Inbound access control.** Inbound content from external senders is gated by contact status. The kernel maintains a contact registry (`contact:*` keys with `contact_index:*` lookup cache). Two enforcement layers:

*Chat path:* Unknown senders (no contact record) get a toolless chat session — conversational only, no tools available. Even if a jailbreak manipulates the LLM, there are no tools to exploit. Known senders get full tool access, gated by the communication gate as usual. The tool allowlist for unknown contacts is configurable via `config:defaults.chat.unknown_contact_tools`.

*Tool path:* Inbound tools (e.g. `check_email`) declare an `inbound` meta field (`{ channel, sender_field, content_field, result_array }`). After tool execution, the kernel post-processes results: for each item, resolves the sender against contacts. Unknown sender content is redacted from the LLM-facing result and quarantined under `sealed:*` keys. The kernel stays channel-agnostic — tools extract platform-specific sender identifiers, the kernel just calls `resolveContact`.

**Sealed namespace.** `sealed:*` keys are mechanically unreadable by tools — `ScopedKV.get()` returns null, `ScopedKV.list()` filters them out. Writes are blocked by `KERNEL_ONLY_PREFIXES`. Only the kernel (internal `kvPut`) can write sealed keys, and the dashboard API (which reads KV directly) can display them to the patron. Hook code can read sealed keys via `K.kvGet()` — this is intentional, as hooks are the trusted policy layer and may need audit access.

**Trust model.** The kernel enforces a two-tier trust boundary: *tools* are sandboxed (ScopedKV, no direct kernel access) and handle untrusted external input. *Hooks* are trusted policy code (full KernelRPC access, go through proposal system review). Sealed keys protect against tool-level jailbreak propagation, not against hook self-modification — the proposal system governs that.

## Provider resilience

LLM calls go through a three-tier cascade. First, a dynamic adapter loaded from the store — Swayambhu writes and maintains his own provider integration code. If that fails, the runtime falls back to a snapshot of the last working adapter. If that fails too, a hardcoded OpenRouter call serves as the absolute last resort. This means a bad adapter update can't permanently lock the agent out of LLM access. The model tier also cascades — if the requested model fails on all providers, the call retries on a cheaper fallback model.

## The leverage curve

Most agent architectures are flat loops: think → act → observe → repeat. One model, one level. Improvement is linear — upgrade the model, the agent gets proportionally better.

Swayambhu's layered architecture changes the leverage curve. When a more capable model becomes available:

**First order:** Better action and tool use in the current session.

**Second order:** Better prompts and tools written for future sessions, persisted in the store, reused indefinitely. The improvement outlasts the session that created it.

**Third order:** Better instructions for the cheaper models that handle subplans. The smarter orient teaches the workers to be more effective, so the execution tier improves without itself being upgraded.

**Fourth order:** Better deep reflections — smarter structural changes to memory, tools, and operational patterns that compound across many sessions.

Each level multiplies through the levels below it. The system is a compiler that writes programs that write programs. Upgrading the compiler doesn't improve one output — it improves the factory.

The same gearing works in reverse for mistakes, which is why the dharma and proposal system exist. The fixed attractor and staged changes prevent the compounding from going in the wrong direction.

## Design principles

**The data is the agent, the runtime is substrate.** Everything that makes Swayambhu *himself* is portable data. The runtime is a replaceable executor. Migration to a different platform means exporting the store and writing a new thin loop.

**Hardcode only what protects.** The runtime enforces dharma immutability, key protection, sandbox scoping, and provider failover. Everything else is delegated to the LLM layer, which can self-modify.

**Sensible defaults, not permanent decisions.** The seed prompts, tools, and memory structures are bootstrapping aids. Swayambhu can restructure, replace, or remove any of them as he evolves.

**The karma log is the source of truth.** Every LLM call and tool execution is recorded with full request/response, flushed to the store after each entry. If the runtime crashes mid-session, the log survives up to the point of death. The next session's crash detection picks up exactly where things went wrong.

## Two-worker architecture

The system consists of two Cloudflare Workers sharing one KV namespace:

**Runtime Worker** (`index.js` → `kernel.js` + statically compiled modules):

| File | Role | Mutable? |
|------|------|----------|
| `kernel.js` | Safety gates, execution engine, session infrastructure, proposals | No (governor enforces) |
| `act.js` | Session policy — orient flow, context building | Yes (via proposals) |
| `reflect.js` | Reflection policy — session/deep reflect, scheduling | Yes (via proposals) |
| `hook-chat.js` | Chat handler — inbound message processing | No |
| `tools/*.js` | Tool implementations | Yes (via proposals) |
| `providers/*.js` | LLM/balance provider adapters | Yes (via proposals) |
| `channels/*.js` | Channel adapters (Slack) | Yes (via proposals) |
| `index.js` | Entry point — imports all modules, wires to kernel | Auto-generated by governor |

**Governor Worker** (`governor/`):

| File | Role |
|------|------|
| `governor/worker.js` | Entry point — cron watchdog, deploy/rollback/status endpoints |
| `governor/builder.js` | Reads code from KV, generates index.js |
| `governor/deployer.js` | CF Workers API multipart upload, version tracking |

### How it runs

On each cron trigger, the kernel's `scheduled()` entry point:

1. Checks for platform kills (previous session's `kernel:active_session` still present)
2. Runs the meta-safety tripwire (`checkHookSafety`)
3. Calls the statically compiled hook modules directly — `act.js` for orient sessions, `reflect.js` for deep reflect
4. If safety tripwire fires: runs a hardcoded minimal fallback (recovery prompt, tight budget, no reflect)

The hook modules call kernel primitives via the K interface — `K.callLLM()`, `K.kvGet()`, `K.runAgentLoop()`, etc. The kernel builds this interface via `buildKernelInterface()`. The modules compose primitives into policy; the kernel enforces invariants on every call regardless of what the modules do.

### Two-tier KV writes

Two methods gate all writes:

**`kvPutSafe(key, value, metadata)`** — allows writes to non-system keys. Blocks writes to system key prefixes (`prompt:`, `config:`, `tool:`, `provider:`, `secret:`, `proposal:`, `upaya:`, `prajna:`, `hook:`), kernel-only prefixes (`kernel:`), system exact keys (`dharma`, `providers`, `wallets`), and the `dharma` key unconditionally. This is for routine data writes.

**`kvWritePrivileged(ops)`** — allows writes to system keys (but not `kernel:*` or `dharma`). For each operation: snapshots the current value to karma before writing, increments a per-session counter (max 50, hardcoded), and auto-reloads cached config after writes to config keys. Used for vetted changes to prompts, config, and wisdom.

Neither path can write `kernel:*` keys or `dharma`. Only the kernel's internal `kvPut` (not exposed via the K interface) can write kernel-namespaced keys.

### Meta-safety tripwire

The kernel maintains `kernel:last_sessions` — a list of the last 5 session outcomes (clean/crash/killed), written via internal `kvPut` after every session. Platform kills are detected by a `kernel:active_session` breadcrumb: written before session execution, deleted after. If present at the start of the next session, the previous session was killed by the platform (wall-time, CPU, or OOM).

If the last 3 outcomes are all crashes or kills, `checkHookSafety` fires: writes `deploy:rollback_requested` to KV (signaling the governor to roll back), sends a kernel alert, and the current session runs the hardcoded minimal fallback. This catches the case where a bad code change breaks the system — the kernel recovers mechanically without needing a working LLM call. The governor's cron picks up the rollback signal.

The minimal fallback uses a kernel-embedded recovery prompt (does not load `prompt:orient` from KV, which could be corrupted), a hardcoded budget (`max_cost: 0.50`, `max_duration: 120s`), and discards all `kv_operations` from LLM output. It runs one basic orient session for status reporting.

### Alerting

`sendKernelAlert(event, message)` is a kernel-internal fire-and-forget notification. It reads `kernel:alert_config` from KV (cached after first read), which contains a URL template, headers, and body template. Template variables (`{{TELEGRAM_BOT_TOKEN}}`, `{{TELEGRAM_CHAT_ID}}`) resolve from Worker environment bindings; `{{event}}`, `{{message}}`, `{{session}}` interpolate at call time. Alerting failures are swallowed — alerting must never crash the kernel. Not exposed via RPC.

## Current status

The runtime is functional. Swayambhu runs on Cloudflare Workers with a two-worker architecture: the runtime worker (statically compiled kernel + modules) and the governor worker (builds and deploys the runtime from KV). The kernel separates hardcoded safety from evolvable policy (`act.js`, `reflect.js`). Local development works fully with Wrangler — `index.js` is hand-written and imports directly from disk.

For setup instructions, KV schema, and implementation details, see `scripts/seed-local-kv.mjs`, `kernel.js` (kernel), and the policy modules (`act.js`, `reflect.js`).
