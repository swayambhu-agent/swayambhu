# Claude Code Project Notes

## Environment Setup

Before running Swayambhu, source the local env file:

```bash
source .env
```

This loads `OPENROUTER_API_KEY` needed for LLM access.

## Local Dev Startup

### Shared state

All local workers and the seed script must use the same `--persist-to` path
so they share one KV store. The canonical path is `.wrangler/shared-state`
(relative to repo root). The seed script already has this baked in.

### Starting dev environment

One script handles everything — `start.sh`. By default it starts all
services and preserves existing KV state. Use `--trigger` to trigger a
session after startup. Use `--reset-all-state` to wipe state and re-seed
from scratch. Use `--set` to override any `config:defaults` value after seeding.

```bash
# Start services only (dashboard, kernel — no trigger)
source .env && bash scripts/start.sh

# Start + trigger a session
source .env && bash scripts/start.sh --trigger

# Full reset + trigger
source .env && bash scripts/start.sh --reset-all-state --trigger

# Full reset with config overrides (dot-path into config:defaults)
source .env && bash scripts/start.sh --reset-all-state --set act.model=deepseek --set reflect.model=deepseek
```

The script automatically:
- Kills stale workers (`pkill -f workerd`)
- Waits for ports to actually free (avoids port conflict footgun)
- Starts kernel, dashboard API, and dashboard SPA
- Waits for services to be ready
- Triggers `/__scheduled` if `--trigger` is passed

### IMPORTANT: `pkill -f workerd` kills ALL workers

This kills both kernel (8787) and dashboard API (8790). The start
script handles restarting both automatically.

### Ports

| Service        | Port | Notes                                    |
|----------------|------|------------------------------------------|
| Kernel         | 8787 | `--test-scheduled` enables `/__scheduled` |
| Dashboard API  | 8790 | SPA hardcodes this for localhost          |
| Dashboard SPA  | 3001 | `dev-serve.mjs` — no-cache static server  |
| Governor       | 8791 | Only with `--governor` flag               |

### Dashboard auth

The patron key for local dev is `test` (set in `dashboard-api/wrangler.toml`).
Enter it in the dashboard login prompt.

## Testing

### Unit tests

```bash
npm test          # vitest — all unit tests, no network, no Workers runtime
```

Tests cover:
- `tests/kernel.test.js` — kernel logic, safety gates, tool dispatch, key tiers, code staging
- `tests/userspace.test.js` — session flow, schedule gating, crash detection
- `tests/tools.test.js` — tool/provider execute(), module structure
- `tests/chat.test.js` — chat system
- `tests/governor.test.js` — index.js generation, builder utilities

Shared mocks in `tests/helpers/`: `mock-kv.js` (KV store), `mock-kernel.js`
(kernel interface mock).

### Integration testing (dev mode)

After seeding + starting wrangler dev, trigger a session:

```bash
curl http://localhost:8787/__scheduled
```

Watch stderr for tagged output: `[KARMA]`, `[TOOL]`, `[LLM]`, `[HOOK]`.

### Switching models

The seed script seeds canonical production models (Claude). To use cheaper
models for basic dev testing, use `--set` with `--reset-all-state`:

```bash
# Full reset with DeepSeek for all roles (~30x cheaper)
source .env && bash scripts/start.sh --reset-all-state --set act.model=deepseek --set reflect.model=deepseek

# Override just act model
source .env && bash scripts/start.sh --reset-all-state --set act.model=deepseek
```

Model aliases (e.g. `deepseek` for `deepseek/deepseek-v3.2`) are resolved
at runtime via `config:models` alias_map. You can also use full model IDs.

**Use cheap models for:** tool wiring, act flow, KV ops, prompt rendering,
budget enforcement, basic sessions.

**Use real models for:** reflection hierarchy, deep reflect,
anything needing structured JSON adherence.

## Code Layout

### Two-worker architecture

The system consists of two Cloudflare Workers sharing one KV namespace:

**Runtime Worker** (`index.js` → `kernel.js` + statically compiled modules):

| File | Role | Mutable? |
|------|------|----------|
| `kernel.js` | Safety gates, tick-based execution engine, infrastructure primitives | No (governor enforces) |
| `userspace.js` | Cognitive policy — act cycle, DR dispatch, schedule | Yes (via code staging) |
| `act.js` | Act library — prompt rendering, tool defs, context formatting | Yes (via code staging) |
| `eval.js` | Three-tier eval pipeline (embeddings → NLI → LLM fallback) | Yes (via code staging) |
| `memory.js` | Memory utilities — samskara operators, experience selection, vector math | Yes (via code staging) |
| `reflect.js` | Reflection policy — scheduling, deep reflect dispatch | Yes (via code staging) |
| `prompts/deep_reflect.md` | M/D operator prompt — loaded as `prompt:deep_reflect` | Yes (via code staging) |
| `tools/*.js` | Tool implementations | Yes (via code staging) |
| `providers/*.js` | LLM/balance provider adapters | Yes (via code staging) |
| `channels/*.js` | Channel adapters (Slack) | Yes (via code staging) |
| `index.js` | Entry point — imports all modules, wires to kernel | Auto-generated by governor |

**Deep-reflect** dispatches as an async CC analysis job on akash (via `start_job`
tool). DR lifecycle is managed by an independent state machine on `dr:state:1`
(idle → dispatched → completed → applied → idle). `drCycle` runs on every tick
independently of the session schedule, polling akash for completion — no callbacks.
Results are applied to `samskara:*` and `desire:*` keys. The M/D operator prompt
is stored as `prompt:deep_reflect`.

### Kernel vs policy boundary

The kernel (`kernel.js`) is **cognitive-architecture-agnostic**. It does
not know about desires, assumptions, actions, plans, reviews, act vs
reflect, or deep reflect. It provides infrastructure primitives that any
cognitive architecture can build on.

**What the kernel provides (the K interface):**

| Category | Methods |
|----------|---------|
| KV access | `kvGet`, `kvWriteSafe`, `kvDeleteSafe`, `kvWriteGated`, `kvList`, `loadKeys` |
| LLM calling | `callLLM` (dharma + principle injection, budget enforcement, provider cascade) |
| Tool dispatch | `executeToolCall`, `executeAction`, `buildToolDefinitions`, `callHook` |
| Event bus | `emitEvent` (write events), `drainEvents` (read + process + dead-letter) |
| Code staging | `stageCode(targetKey, code)`, `signalDeploy()` |
| Safety | Crash detection/recovery, sealed key filtering, communication gating |
| Bookkeeping | `karmaRecord`, `getSessionId`, `getSessionCost` |
| Config | `getDefaults`, `getModelsConfig`, `getDharma`, `getPrinciples` |

**Tick dispatch:** The kernel's `runTick()` calls userspace on every cron tick:
1. Load config (dharma, principles, key tiers, models)
2. Infrastructure inputs — crash detection, balances, drained events
3. **Hand to userspace** — `HOOKS.tick.run(K, { crashData, balances, events })`
4. Record execution outcome (clean/crash)
5. Release execution lock

Userspace decides everything: whether to run an act session (schedule-gated),
whether to poll DR (every tick), what context to load, how to structure the
work. The kernel doesn't know or care.

**KV write tiers** (loaded from `kernel:key_tiers` at boot, falls back
to `DEFAULT_KEY_TIERS`):

| Tier | Example keys | Rule |
|------|-------------|------|
| Immutable | `dharma`, `principle:*`, `patron:public_key` | Never writable — not by agent, not by userspace |
| Kernel-only | `karma:*`, `sealed:*`, `event:*`, `kernel:*` | Only kernel internals can write |
| Protected | `config:*`, `prompt:*`, `tool:*`, `contact:*`, `desire:*`, `samskara:*` | Writable via `kvWriteGated` with privileged context flag |
| Code keys | `tool:*:code`, `hook:*:code` | Must go through `K.stageCode()` → governor deploys |
| Agent keys | `experience:*`, everything else | `kvWriteSafe` — direct write |

**Principles:** `principle:*` keys are loaded at boot via `loadPrinciples()`
and injected into every LLM call as a `[PRINCIPLES]` block after dharma.
They are fully immutable — the agent cannot write them.

**Does NOT belong in the kernel:**
- What to do during a session (session policy)
- What to reflect on or how (reflection policy)
- Context building, summarization, digest generation
- Session type decisions (act vs reflect, depth levels)
- Scheduling decisions (when to run, intervals)
- Session bookkeeping (counter, session_start karma)
- Tripwire/effort evaluation
- Any logic that shapes the agent's behavior rather than enforcing safety

**Rule of thumb:** if it's about *what* the agent does → userspace.
If it's about *what the agent cannot do* → kernel.

**Governor Worker** (`governor/`):

| File | Role |
|------|------|
| `governor/worker.js` | Entry point — cron watchdog, deploy/rollback/status endpoints |
| `governor/builder.js` | Reads code from KV, generates index.js |
| `governor/deployer.js` | CF Workers API multipart upload, version tracking |

The governor is optional for local dev — `index.js` is hand-written and
imports directly from disk. Use `--governor` flag with start.sh to run it.

**Inference Server** (`inference/`):

| File | Role |
|------|------|
| `inference/main.py` | FastAPI: /embed (bge-small-en-v1.5), /nli (DeBERTa-v3-base), /health |
| `inference/Dockerfile` | Multi-stage ONNX Runtime build |
| `inference/deploy.yaml` | Akash SDL for production deployment |

The inference server runs on Akash (production) or docker-compose (local dev).
The eval pipeline calls it for Tier 1 (embeddings) and Tier 2 (NLI). Falls back
to LLM-only evaluation when unavailable.

### Code staging and deployment

Code changes use two kernel primitives:
1. `K.stageCode(targetKey, code)` — writes to `code_staging:{key}` in KV
2. `K.signalDeploy()` — writes `deploy:pending` to KV
3. Governor picks up pending deploys, applies staged code, builds, deploys via CF API
4. Governor tracks version history for rollback

The kernel validates that only code keys (`tool:*:code`, `hook:*:code`,
`provider:*:code`, `channel:*:code`) can be staged. Userspace decides
*when* to stage and deploy — the kernel just provides the primitives.

Non-code changes (config, prompts, insights) go through `kvWriteGated`
with a privileged context flag. No deployment needed.

### Debug logging

Errors in background processing (e.g. chat handler failures) are logged to
`log:{category}:{timestamp}` keys with a 7-day TTL. Karma records reference
these via `log_ref` to keep the audit trail lightweight while preserving
full error details (stack traces, inbound payloads) for debugging.

```
# Karma entry (what the agent sees)
{ event: "chat_error", channel: "slack", log_ref: "log:chat:1711352400000" }

# Log key (full details, auto-expires after 7 days)
log:chat:1711352400000 → { error, stack, inbound, timestamp }
```

Errors also output to stderr (`[CHAT]` tag) for real-time dev visibility.
Query logs: `node scripts/read-kv.mjs log:`.

### Tools and providers

Tool code lives in `tools/*.js`, provider adapters in `providers/*.js`.
Single source of truth — statically imported by `index.js`, also seeded
into KV as source-of-truth for the governor. **No `export default`** in
these files (they use named exports: `execute`, `call`, `check`, `meta`).

### Key scripts

| Script | Purpose |
|--------|---------|
| `source .env && bash scripts/start.sh` | Restart workers, preserve state |
| `source .env && bash scripts/start.sh --reset-all-state` | Full reset: wipe state, seed with production models |
| `source .env && bash scripts/start.sh --reset-all-state --set path=value` | Full reset with config overrides |
| `node scripts/seed-local-kv.mjs` | Seed local KV (~2s) — uses Miniflare API directly |
| `node scripts/read-kv.mjs [key-or-prefix]` | Inspect local KV (list keys, read values) |
| `node scripts/write-kv.mjs <key> <file>` | Write a single KV key from file (.json → json, else text) |
| `node scripts/delete-kv.mjs <key>` | Delete a single KV key |
| `node scripts/clear-schedule.mjs` | Clear schedule timer (force immediate session) |
| `node scripts/gmail-auth.mjs` | Generate Gmail OAuth refresh token |
| `node scripts/rollback-session.mjs` | Undo last session's KV changes (`--dry-run` to preview, `--yes` to skip confirm) |

### Cognitive architecture KV keys

The cognitive architecture (spec: `swayambhu-cognitive-architecture.md`) uses
three entity types stored in KV:

| Prefix | Entity | Tier | Written by | Read by |
|--------|--------|------|------------|---------|
| `desire:*` | Desires (d) — approach/avoidance vectors | Protected | Deep-reflect (D operator) | Act (plan phase) |
| `samskara:*` | Samskaras (s) — impressions with EMA strength | Protected | Strength: review (mechanical). Create/refine/delete: deep-reflect (S operator) | Act (plan phase) |
| `experience:*` | Experiences (ε) — salient experiences | Agent | Review phase (conditional) | Deep-reflect |

Cold start: all stores empty (`d_0 = ∅`, `s_0 = ∅`, `ε_0 = ∅`).
The first session wakes with empty samskaras (σ=1, max surprise), records
a high-salience experience, and deep-reflect bootstraps desires via `D_p(ε, ∅)`
and samskaras via `S(ε, ∅)`. The agent earns everything from the start.

Schemas: see `tests/schema.test.js` for canonical field definitions and
validation logic.

## Working Style — MANDATORY

**Do NOT make code changes without explicit approval.** When the user asks
a question or raises an issue, respond with your analysis, thoughts, and
proposed approach first. Wait for the user to say "yes", "do it", "go ahead",
or otherwise clearly approve before writing or editing any files. This
applies to ALL changes — even small ones, even "obvious" fixes, even
documentation updates. Do NOT implement anything until you receive explicit
go-ahead. The only exception is when the user gives an explicit instruction
to implement something (e.g. "Implement the following plan:" or "add X to Y").

**Think independently on design decisions.** Don't just agree with the user —
carefully reflect and think through proposals from first principles. Push
back if you genuinely think a different approach is better, and explain why.
Agreeing without thinking leads to worse outcomes than honest disagreement.

**Delete stale artifacts.** When code or architecture changes make a file,
doc, prompt, config, or test obsolete, delete it. Don't leave dead files
around "for reference" — git history exists for that. Stale artifacts
mislead future sessions and accumulate confusion.

**Commit and push after every significant piece of work.** Don't let
changes accumulate — commit as soon as a coherent unit of work is complete
(a bug fix, a feature, a refactor). This protects against lost work and
keeps the git history useful.

**When working on prompt fine-tuning, role-play the prompt internally.**
Imagine yourself as the model receiving the prompt. Before recommending
a change, simulate how the wording would land — what it would emphasize,
what it would suppress, what behavior it would actually produce. This
is how you evaluate prompting ideas: not by abstract reasoning about them,
but by feeling their effect on yourself.

## Problem-Solving Approach

When an immediate need reveals a deeper architectural gap, address the
foundation first rather than applying a quick fix. Use specific situations
as a lens to examine the underlying design — the immediate need serves the
broader goal of getting the foundations right.

**Self-improving agent principle.** Swayambhu is designed to improve and
fix itself. When you find a bug or limitation, don't just fix the
immediate issue — ask: what is preventing the agent from seeing this
problem and fixing it itself? The goal is to close the loop so the agent
can detect, diagnose, and resolve similar problems autonomously in the
future. Fix the meta-problem, not just the problem.

## Development Philosophy

This is v0.1 — no backwards compatibility needed. Feel free to change data
formats, KV schemas, karma structures, API shapes, etc. without migration
or fallback logic. Old local data can always be wiped with a re-seed.

### Why `--persist-to`?

Wrangler's `--local` flag and `wrangler dev` use different storage backends
by default (`blobs/` vs `miniflare-*.sqlite`). Using `--persist-to` on both
the seed script and all `wrangler dev` instances forces them to the same
SQLite store, so seeded keys are visible to running workers.
