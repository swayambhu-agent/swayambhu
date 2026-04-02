# Userspace Reference

Userspace is everything outside the kernel — the cognitive policy that
decides what the agent does. The kernel provides infrastructure primitives
(KV, LLM, tools, events). Userspace uses them to implement the cognitive
architecture: act cycles, deep-reflect, samskara management, desire
evolution.

## Entry Point

`userspace.js` is the cognitive policy entry point. The kernel calls
`HOOKS.session.run(K, { crashData, balances, events, schedule })` —
this invokes `userspace.js:run()`.

The `run()` function coordinates two independent concerns:

```
run()
  ├─ try: actCycle()       — plan → act → eval → review → memory
  ├─ try: drCycle()        — DR state machine: poll / dispatch / apply
  └─ try: updateSchedule() — always runs, even if above failed
```

Each is wrapped in its own try/catch. A crashed act cycle doesn't
block DR dispatch. A failed DR dispatch doesn't prevent the schedule
update. This isolation prevents cascade failures.

## Act Cycle

The fast loop. Runs every session.

```
actCycle()
  1. Load config (defaults, models, inference)
  2. Load desires (desire:*) and samskaras (samskara:*)
  3. Cache embeddings for Tier 1 relevance filtering
  4. Process deep-reflect job completions from events
  5. Loop while budget remains:
     a. Plan — A_{s,c}(d) = a — samskaras + circumstances on desires
     b. Act — execute plan via tool calls
     c. Eval — compute σ (surprise) and α (affinity), update samskara strengths
     d. Record experience if salient (salience > threshold)
  6. Return { defaults, modelsConfig, desires, cyclesRun }
```

### Plan Phase

The LLM receives desires, samskaras, and circumstances. It produces
a plan: `{ action, success, relies_on, defer_if }` or `{ no_action, reason }`.

If `no_action`: the experience is still evaluated and recorded (this
is how bootstrap works — empty samskaras → σ=1 → high-salience experience).

### Eval (Mechanical)

The three-tier evaluation pipeline computes surprise (σ) and affinity (α):
- Tier 1: embedding similarity filter (cheap, local)
- Tier 2: NLI classification (cheap, local)
- Tier 3: LLM for ambiguous cases (expensive, fallback only)

Samskara strengths are updated via EMA:
```
strength = strength × (1 - α_ema) + (1 - σ_per_samskara) × α_ema
```

Empty samskaras → σ=1 (maximum surprise). This bootstraps the agent.

### Experience Recording

If `salience = σ + |α| > threshold`: record an experience.

Experience schema: `{ timestamp, action_taken, outcome, surprise_score, salience, narrative, embedding }`

No affinity vector stored. No active desire/samskara lists. The
narrative carries the qualitative meaning.

## DR Lifecycle (drCycle)

DR manages its own lifecycle through `dr:state:1` — a state machine
independent of act sessions. The cron provides the clock tick; DR
decides for itself whether to run.

```
drCycle()
  read dr:state:1
  ├─ dispatched → poll akash for completion
  ├─ completed  → apply results to KV, set idle + schedule next
  ├─ failed     → backoff, then retry
  └─ idle       → check if due, dispatch if so
```

**States:** idle → dispatched → completed → (apply) → idle.
Failed state has exponential backoff (2^N sessions, capped at 20).

**Cold start:** generation 0 → dispatch immediately.
After that, the schedule governs (default: 20 sessions or 7 days).

**Polling:** drCycle SSHes to akash, checks for `exit_code` file,
reads `output.json`. Short timeout (5s) prevents hangs.
No callbacks — jobs just run and exit.

**Result application:** Writes samskara:* and desire:* via kvWriteGated.
Also writes reflect:1:{sessionId} and last_reflect for continuity.

### S Operator (Samskara Management)

Creates, refines, erodes, and deletes samskaras from experience patterns.
The mechanical EMA handles routine confirmation/violation. S handles
pattern recognition — seeing what the numbers can't see.

### D Operator (Desire Magnification)

Magnifies experience through principles. "I did X" → "do more X."
Bidirectional: approach (toward alignment) and avoidance (away from
misalignment). Principles shape the direction, not the force.

## Files

| File | Role |
|------|------|
| `userspace.js` | Entry point — coordinates act cycle + DR dispatch |
| `act.js` | Act library — prompt rendering, tool defs, formatting |
| `eval.js` | Three-tier eval pipeline (embeddings → NLI → LLM fallback) |
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
`K.stageCode()` → governor deploys.
