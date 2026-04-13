# Operator Tool Inventory

This document describes the remaining external operator tooling after the
runtime/operator split.

It answers three questions for each tool:

1. What does it do?
2. What requirement does it satisfy?
3. What is a concrete example use case?

The goal is to decide what should stay as operator tooling, what should move,
and what can be archived.

## `scripts/operator/state-lab.mjs`

What it does:
- Manages the branchable local-state lab used for A/B runtime experiments.
- Can save immutable snapshots, create writable branches, activate a branch,
  start services for a branch, run lab validation, materialize DR workspaces,
  and promote a branch.

Requirement satisfied:
- Operator-controlled branch/snapshot management for local state and runtime
  workspaces.
- Safe experimentation against a frozen state snapshot instead of the live
  local runtime.

Example use case:
- You want to test whether a userspace change improves DR behavior without
  mutating the live local state.
- You run:
  - `node scripts/operator/state-lab.mjs save baseline`
  - `node scripts/operator/state-lab.mjs branch snapshot:baseline dr2-test`
  - `node scripts/operator/state-lab.mjs start dr2-test`
- Then you inspect that branch in isolation and only promote it if it behaves
  better.

## `scripts/operator/state-lab-gateway.mjs`

What it does:
- Proxies either browser traffic or kernel traffic to whichever state-lab
  branch is currently active in `active-ui.json`.
- Provides a stable front-door port while the underlying active branch can
  change.

Requirement satisfied:
- Stable operator access to the active state-lab branch without memorizing
  per-branch ports.

Example use case:
- You are switching between multiple state-lab branches during review, but you
  want `http://localhost:9071/patron/` to always show the currently active one.

## `scripts/operator/dev-loop/services.mjs`

What it does:
- Starts, restarts, and waits for the local stack used by the dev-loop.
- Supports either the default local stack or the currently active state-lab
  branch.
- Launches `scripts/start.sh` or `scripts/operator/state-lab.mjs start ...`
  depending on mode.

Requirement satisfied:
- Operator control over the local service lifecycle during repeated audit and
  validation runs.

Example use case:
- Before a long audit run, you want to force a clean restart of the local
  kernel/dashboard pair so that the next `observe` cycle starts from a known
  service state.

## `scripts/operator/dev-loop/state.mjs`

What it does:
- Stores the dev-loop’s own file-backed bookkeeping outside the repo.
- Persists loop state, probes, queue buckets, and run artifacts under
  `/home/swami/swayambhu/dev-loop` or the configured base dir.

Requirement satisfied:
- External orchestration state that should not live inside the runtime KV or
  pollute the git worktree.

Example use case:
- A multi-cycle operator run needs to remember which probes have already been
  seen, which approval requests are pending, and where the per-cycle run
  artifacts were written.

## `scripts/operator/dev-loop/observe.mjs`

What it does:
- Triggers a local agent session, waits for it to start and complete, then runs
  `scripts/analyze-sessions.mjs` to produce an observation bundle.
- Persists `observation.json` into the dev-loop run directory.

Requirement satisfied:
- External observation of the local runtime as a black-box system under test.

Example use case:
- You want to see what one more local wake cycle actually did before deciding
  whether the architecture changed for the better.
- `observe.mjs` triggers the session and captures the resulting snapshot for
  later classification.

## `scripts/operator/dev-loop/classify.mjs`

What it does:
- Takes an observation bundle and classifies architecture issues from it.
- Deduplicates against existing probes and persists both new and updated probe
  records.

Requirement satisfied:
- Operator-side issue taxonomy and accumulation across multiple observed runs.

Example use case:
- After several overnight sessions, you want to know whether the same bad
  pattern is recurring or whether the system is discovering genuinely new
  issues.

## `scripts/operator/dev-loop/remote-compute.mjs`

What it does:
- Talks to the remote compute surface over HTTP using Cloudflare Access plus
  `COMPUTER_API_KEY`.
- Can execute cleanup commands remotely and currently focuses on wiping
  workspace/reasoning/job directories and seeding a clean reasoning index.

Requirement satisfied:
- Operator cleanup and reset of a remote compute surface before a controlled
  experiment.

Example use case:
- Before starting a new dev-loop batch against Akash, you want to clear
  `/home/swayambhu/workspace`, `/home/swayambhu/reasoning`, and
  `/home/swayambhu/jobs` so the next run is not contaminated by leftovers.

## `scripts/operator/dev-loop/comms.mjs`

What it does:
- Sends operator-facing notifications and approval requests over Slack and
  Gmail SMTP.
- Parses reply messages such as `approve <id>` and `reject <id> ...`.

Requirement satisfied:
- Human-in-the-loop approvals and out-of-band notifications for the external
  dev-loop.

Example use case:
- A dev-loop cycle finds a proposed fix that should not auto-apply.
- It formats an approval request, sends it to Slack, and later polls Slack for
  an `approve` or `reject` reply.

## `scripts/operator/dev-loop/dr-compare.mjs`

What it does:
- Captures a single live deep-reflect snapshot from KV, writes it to disk, then
  runs Claude and Codex against the same snapshot in parallel.
- Scores the outputs heuristically and writes `report.json` and `report.md`.

Requirement satisfied:
- Model-comparison benchmarking for deep-reflect quality on the same frozen
  input.

Example use case:
- You want to know whether Claude or Codex produces better DR output on the
  current snapshot before changing the default DR runner.

Keep/archive note:
- This is the clearest archive candidate if DR model selection is already
  settled. It is benchmarking infrastructure, not a core operator control path.

## `scripts/operator/dev-loop/loop.mjs`

What it does:
- Runs the full external dev-loop orchestration:
  - observe
  - classify
  - external Claude architecture analysis
  - decision routing
  - optional approvals
  - optional verification
  - heartbeat/notification handling
- Tracks cycle state, PID files, budgets, and overnight reporting.

Requirement satisfied:
- External autonomous improvement loop that evaluates the agent from outside
  rather than relying only on internal DR behavior.

Example use case:
- You want the system to spend the night repeatedly waking the local agent,
  auditing the results, collecting findings, and optionally preparing decisions
  for the next morning’s review.

## `scripts/operator/dev-loop/verify.mjs`

What it does:
- Runs `npm test` after changes and, on failure, reverts the most recent
  commits in reverse order.
- Persists `verification.json` into the run directory.

Requirement satisfied:
- External safety net around applied fixes in the operator loop.

Example use case:
- A dev-loop decision auto-applies one or more fixes. Before trusting the
  result, you want a coarse “tests pass / revert on regression” pass.

Keep/archive note:
- This is borderline. It still satisfies a real requirement, but it is a blunt
  older workflow compared with the newer DR2/DR3 validation path.

## Summary

Likely keep for now:
- `state-lab.mjs`
- `state-lab-gateway.mjs`
- `dev-loop/services.mjs`
- `dev-loop/state.mjs`
- `dev-loop/observe.mjs`
- `dev-loop/classify.mjs`
- `dev-loop/remote-compute.mjs`
- `dev-loop/comms.mjs`
- `dev-loop/loop.mjs`

Borderline:
- `dev-loop/verify.mjs`

Likely archive candidate:
- `dev-loop/dr-compare.mjs`
