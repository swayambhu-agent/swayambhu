# Tapas — Prompt Distillation via Evolutionary Search

**Status:** Design doc (not yet implemented)

Use Opus as an oracle to define "good" outputs, then evolve prompts and
configs that get cheaper models closer to that quality bar.

## Why "Tapas"

Tapas = heat, refinement, disciplined practice. We're refining prompts
through iterative pressure until cheaper models produce Opus-quality output.

## Architecture

```
scripts/tapas/
├── harness.mjs          — Core: snapshot state, run models, collect outputs
├── fitness.mjs          — Scoring: structured comparison of outputs
├── evolve.mjs           — Genetic algorithm: selection, mutation, crossover
├── run.mjs              — CLI entry point
└── results/             — Generated: population snapshots, leaderboards
```

## How It Works

### Phase 1 — Collect Oracle Outputs

Take N representative karma snapshots (diverse states — fresh boot,
mid-session, post-crash, budget-constrained, etc.). Run Opus on each
using the current prompts. These become the ground truth.

```bash
node scripts/tapas/run.mjs collect-oracle --snapshots 8
```

This doesn't need a running worker. It directly:

1. Loads KV state from `.wrangler/shared-state` via Miniflare API (same
   pattern as the seed script)
2. Builds the prompt exactly as `act.js` / `reflect.js` would (reusing
   `buildPrompt` from kernel)
3. Calls Opus via the LLM provider directly
4. Saves input+output pairs to `scripts/tapas/results/oracle/`

### Phase 2 — Define the Genome

A "genome" is a candidate configuration — the things we're optimizing:

```javascript
{
  // Prompt mutations (applied as patches to the base template)
  promptPatches: [
    { section: "orient", find: "You are an autonomous agent",
      replace: "You are a precise planning system" },
    { section: "orient", append: "\n\nIMPORTANT: Always output valid JSON." },
  ],

  // Config overrides (dot-paths into config:defaults)
  configOverrides: {
    "orient.effort": "medium",
    "orient.max_output_tokens": 6000,
    "execution.max_steps.orient": 8,
  },

  // Context shaping — what goes into the user message
  contextShape: {
    includeBalances: true,
    includeLastReflect: true,
    effortOverride: null,
    contextPruning: "aggressive",
  }
}
```

### Phase 3 — Fitness Function

For each task type, compare cheap model output vs Opus output.

#### Orient Fitness

- **toolMatch** — Did it pick the same tools in the same order? Jaccard
  similarity, weighted by tool importance.
- **kvMatch** — Did it write to the same KV keys with similar values? Key
  overlap + value similarity.
- **planCoherence** — Is the session_summary semantically aligned? Extract
  key nouns/verbs, compute overlap. (Or embed both and cosine-sim if budget
  allows.)
- **formatValid** — Did it produce parseable JSON?

#### Reflect Fitness

- **sleepMatch** — Similar wake timing scheduled?
- **effortMatch** — Same effort level for next wake?
- **loadKeysMatch** — Overlap in `next_orient_context.load_keys`
- **verdictMatch** — Same accept/reject/defer on proposals
- **kvOpsMatch** — Similar KV operations proposed

#### Combined Score

Each metric is 0–1, combined as a weighted sum. Total fitness factors in
cost savings:

```javascript
function fitness(cheapOutput, opusOutput, cheapCost, opusCost) {
  const quality = weightedAvg({
    toolMatch:   [jaccard(cheap.tools, opus.tools),         0.30],
    kvMatch:     [kvSimilarity(cheap.kv_ops, opus.kv_ops),  0.25],
    structMatch: [structuralSim(cheap, opus),               0.25],
    formatValid: [isValidJSON(cheap) ? 1 : 0,               0.20],
  });
  const costRatio = cheapCost / opusCost;
  return quality / Math.max(costRatio, 0.01);
}
```

A 90% quality match at 5% of the cost scores very high.

### Phase 4 — Evolution Loop

```
Generation 0:  [current_prompts, variant_1, ..., variant_N]  (N=20)
                         |
              Evaluate each against all snapshots (3 runs each for stability)
                         |
              Rank by fitness, keep top 5
                         |
              Mutate: each survivor spawns 3 children with random mutations
              Crossover: random pairs swap prompt sections or config values
                         |
Generation 1:  [5 survivors + 15 offspring]
                         |
              Repeat for G generations (G=10-20)
```

#### Mutation Operators

- **swapSentence** — reorder instruction sentences in prompt
- **addEmphasis** — wrap a section in "IMPORTANT: ..." or "CRITICAL: ..."
- **simplify** — remove a sentence or paragraph
- **rephrase** — reword a section (use a cheap LLM to rephrase)
- **tweakConfig** — nudge a numeric config value +/-20%
- **addFewShot** — inject an example output into the prompt
- **changeFormat** — alter how context is presented (JSON vs prose vs bullets)

### Phase 5 — Output

After evolution, produce:

- **Best genome** — prompt patches + config overrides, ready to apply
- **Fitness trajectory** — did it converge? How many generations needed?
- **Per-snapshot breakdown** — which scenarios are still weak?
- **Cost/quality curve** — tradeoff at different quality thresholds

## Cost Estimate

| Step | Cost |
|------|------|
| Per evaluation | ~$0.002 (cheap model) x 8 snapshots x 3 runs = ~$0.05 |
| Per generation | 20 candidates x $0.05 = ~$1.00 |
| Full run (15 generations) | ~$15 + ~$5 oracle collection = **~$20** |

## Implementation Notes

### No running worker needed

The harness imports prompt-building logic directly, loads KV via Miniflare,
and calls the LLM provider. No HTTP overhead, no port conflicts, fully
deterministic state.

### Build order

1. **harness.mjs** — Snapshot capture + prompt reconstruction + LLM call.
   Foundation piece. Once you can replay an orient or reflect call with
   arbitrary prompts/config against a frozen KV state, everything else
   builds on it.
2. **fitness.mjs** — Start with orient only (simpler output format). Get
   comparison metrics working.
3. **evolve.mjs** — Simple (mu+lambda) evolution strategy. No external
   libraries needed.
4. **run.mjs** — CLI that ties it together.

### Stochasticity

LLM outputs are non-deterministic. Each candidate needs multiple runs per
snapshot to get stable fitness scores. 3-5 runs is the sweet spot —
enough for signal, not so many that cost explodes.

### What you might discover

The results are interpretable — you end up with concrete prompt changes
you can read and understand *why* they helped the cheaper model. Things
like "DeepSeek does better orient plans when you give it explicit
enumerated constraints rather than prose guidelines."

For some tasks (deep reflect, yama deliberation), no amount of prompt
engineering may close the gap. That's useful too — it tells you which
roles genuinely need the expensive model and which can be offloaded.
