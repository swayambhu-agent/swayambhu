# Userspace Reference

Userspace is everything outside the kernel — the cognitive policy that
decides what the agent does. The kernel provides infrastructure primitives
(KV, LLM, tools, events). Userspace uses them to implement the cognitive
architecture: act cycles, deep-reflect, samskara management, desire
evolution.

## Entry Point

`userspace.js` is the cognitive policy entry point. The kernel calls
`HOOKS.tick.run(K, { crashData, balances, events })` on every cron tick.

Userspace is a **multiplexer, not an orchestrator.** It coordinates
independent concerns that share a clock tick and a KV store. Nothing else.

```
run(K, { crashData, balances, events })
  +-- try: actCycle()       -- schedule-gated: plan -> act -> eval -> review -> memory
  +-- try: drCycle()        -- runs every tick: poll / dispatch / apply
```

Each is wrapped in its own try/catch. A crashed act cycle doesn't
block DR polling. A failed DR dispatch doesn't prevent the next act
session. This isolation prevents cascade failures.

## Session Ownership

Userspace owns the concept of "session." The kernel only knows about
"ticks" (executions). This means userspace is responsible for:

- **Schedule gate** — reading `session_schedule` from KV, deciding if
  it's time for an act session
- **Session counter** — incrementing `session_counter` in KV when an
  act session actually runs
- **Session bookkeeping** — emitting `session_start` / `session_complete`
  karma events, tracking session IDs
- **Schedule updates** — writing `session_schedule` with the next
  session time after each act cycle

The kernel calls userspace on every tick regardless. If the session
schedule says "not yet," actCycle returns immediately. drCycle still
runs — it has its own clock.

## Act Cycle

The fast loop. Runs when the session schedule says it's time.

```
actCycle()
  0. Schedule gate — read session_schedule, return if not due
  1. Session bookkeeping — increment counter, emit session_start
  2. Load config (defaults, models, inference)
  3. Load desires (desire:*) and samskaras (samskara:*)
  4. Cache embeddings for Tier 1 relevance filtering
  5. Loop while budget remains:
     a. Plan — A_{s,c}(d) = a — samskaras + circumstances on desires
     b. Act — execute plan via tool calls
     c. Eval — compute sigma (surprise) and alpha (affinity), update samskara strengths
     d. Record experience if salient (salience > threshold)
  6. Schedule next session
  7. Return { defaults, modelsConfig, desires, cyclesRun }
```

### Plan Phase

The LLM receives desires, samskaras, and circumstances. It produces
a plan: `{ action, success, relies_on, defer_if }` or `{ no_action, reason }`.

If `no_action`: the experience is still evaluated and recorded (this
is how bootstrap works — empty samskaras -> sigma=1 -> high-salience experience).

### Eval (Mechanical)

The three-tier evaluation pipeline computes surprise (sigma) and affinity (alpha):
- Tier 1: embedding similarity filter (cheap, local)
- Tier 2: NLI classification (cheap, local)
- Tier 3: LLM for ambiguous cases (expensive, fallback only)

Samskara strengths are updated via EMA:
```
strength = strength * (1 - alpha_ema) + (1 - sigma_per_samskara) * alpha_ema
```

Empty samskaras -> sigma=1 (maximum surprise). This bootstraps the agent.

### Experience Recording

If `salience = sigma + |alpha| > threshold`: record an experience.

Experience schema: `{ timestamp, action_taken, outcome, surprise_score, salience, narrative, embedding }`

No affinity vector stored. No active desire/samskara lists. The
narrative carries the qualitative meaning.

## DR Lifecycle (drCycle)

DR runs on **every tick**, independent of the act session schedule.
This is the key difference from the previous design where DR was
coupled to session timing.

DR manages its own lifecycle through `dr:state:1` — a state machine
that shares nothing with act sessions except the KV store.

```
drCycle()  [runs every tick]
  read dr:state:1
  +-- dispatched -> poll akash for completion
  +-- completed  -> apply results to KV, set idle + schedule next
  +-- failed     -> backoff, then retry
  +-- idle       -> check if due, dispatch if so
```

**States:** idle -> dispatched -> completed -> (apply) -> idle.
Failed state has exponential backoff (2^N ticks, capped).

**Cold start:** generation 0 -> dispatch immediately.
After that, the schedule governs (default: 20 sessions or 7 days).

**Polling:** drCycle SSHes to akash, checks for `exit_code` file,
reads `output.json`. Short timeout (5s) prevents hangs.
No callbacks — jobs just run and exit.

**Result application:** Writes samskara:* and desire:* via kvWriteGated.
Also writes reflect:1:{executionId} and last_reflect for continuity.

**Why this matters:** With the tick-based kernel, DR state transitions
happen within minutes of job completion, not hours. Dispatch on tick N,
job completes 10 minutes later, tick N+1 polls and applies results.
Previously this could take 12+ hours (two session intervals).

### S Operator (Samskara Management)

Creates, refines, erodes, and deletes samskaras from experience patterns.
The mechanical EMA handles routine confirmation/violation. S handles
pattern recognition — seeing what the numbers can't see.

### D Operator (Desire Magnification)

Magnifies experience through principles. "I did X" -> "do more X."
Bidirectional: approach (toward alignment) and avoidance (away from
misalignment). Principles shape the direction, not the force.

## Two Clocks, One Tick

The cron provides the tick. Two independent systems share it:

| System | Gate | Frequency | What it does |
|--------|------|-----------|-------------|
| Act cycle | `session_schedule` (userspace-owned) | Every N hours | Plan, act, eval, review |
| DR lifecycle | `dr:state:1` (self-managed) | Every tick | Poll, dispatch, apply |

Neither system knows the other exists. `run()` calls both. If act
returns early (not due), DR still runs. If DR returns early (idle, not
due), act still runs. They communicate only through KV: DR writes
desires and samskaras, act reads them.

## Files

| File | Role |
|------|------|
| `userspace.js` | Entry point — tick handler, coordinates act cycle + DR lifecycle |
| `act.js` | Act library — prompt rendering, tool defs, formatting |
| `eval.js` | Three-tier eval pipeline (embeddings -> NLI -> LLM fallback) |
| `memory.js` | Memory utilities — samskara strength EMA, experience selection, vector math |
| `reflect.js` | Reflection policy — scheduling, deep-reflect dispatch, context gathering |
| `prompts/act.md` | Act session prompt template |
| `prompts/deep-reflect.md` | In-worker deep-reflect prompt (depth 1) |
| `prompts/deep_reflect.md` | S/D operator prompt dispatched to akash |
| `prompts/reflect.md` | Session reflect prompt |
| `tools/*.js` | Tool implementations |
| `providers/*.js` | LLM/balance/compute provider adapters |
| `channels/*.js` | Channel adapters (Slack, etc.) |

All userspace files are mutable — the agent can propose changes via
`K.stageCode()` -> governor deploys.
