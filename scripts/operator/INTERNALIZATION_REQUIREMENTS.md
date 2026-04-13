# Internalization Requirements From Operator Delta

This note turns the remaining operator/runtime delta into native product
requirements.

The goal is not to recreate the old operator loop inside the agent. The goal is
to identify the deeper capability gaps revealed by that loop, articulate the
optimal native requirement, and leave ourselves with clean issue candidates for
later implementation.

## Guiding principle

When an external operator tool is still useful, the right question is not:

- "which script do we port?"

The right question is:

- "what product requirement does this script reveal?"
- "should that requirement live natively in the runtime?"
- "if yes, where should it land in DR1, DR2, DR3, or the runtime control plane?"

## What should stay external

These are still best treated as operator/infrastructure concerns for now:

- service restart and local port orchestration
- Slack or email approval transport
- Cloudflare/remote service lifecycle
- branchable lab workspace management as an operator surface

These may stay in operator tooling even after the requirements below are
internalized.

## Requirement 1: Native Defect Ledger

### Bigger feature gap

The runtime lacks a first-class memory structure for tracked defects across
sessions.

Patterns, desires, tactics, and identifications are cognition entities. They
are not the same as:

- a defect under investigation
- a recurring failure mode
- a temporarily mitigated issue
- a suspected architecture regression

The external loop's probe model exists because the runtime currently has no
stable place to remember "this problem has been seen five times, is worsening,
and is still unresolved."

### Optimal native requirement

Add a first-class native defect ledger, distinct from cognition entities, with
durable entries for tracked runtime defects.

Suggested native shape:

- `probe:*` or `defect:*` keys
- stable fingerprint
- summary
- evidence refs
- severity
- blast radius
- self-repairability
- status
- last_seen_at
- first_seen_at
- confidence
- next_review_due

### Where it belongs

- DR1: create and update defect entries from recent evidence
- DR2: consume mature defects as structured inputs for proposal/challenge work
- DR3: consume defects whose proposed remedy crosses authority boundaries

### Why this is bigger than the operator script

This is not "port classify.js".
It is "give the runtime a durable memory for tracked faults."

Without this, self-improvement remains episodic and session-local.

### Acceptance criteria

- repeated observation of the same failure updates one stable defect record
- defects can accumulate evidence across sessions
- DR2 can target a specific defect record rather than a vague recent note
- the dashboard can distinguish cognition state from tracked defect state

### Candidate GitHub issue

`Add native defect ledger for tracked architecture failures`

## Requirement 2: Native Mechanical Audit Stage

### Bigger feature gap

The runtime relies too much on generative reflection to notice bad behavior.

The operator loop's deterministic heuristics matter because they catch certain
classes of defect consistently:

- malformed desires
- misclassified tactics
- contaminated experiences
- policy leakage into carry-forward
- outward messages that leak internal runtime language

The deeper requirement is not "keep a classify script." It is "the runtime
needs a repeatable non-generative audit layer."

### Optimal native requirement

Add a native mechanical audit phase that runs before DR1 synthesis and emits
grounded audit findings.

Suggested native outputs:

- `audit_finding:*` transient artifacts
- or direct feed into `probe:*`
- explicit evidence slices tied to:
  - experiences
  - actions
  - outbound messages
  - current cognition state

### Where it belongs

- directly before DR1
- or as a deterministic pre-pass inside DR1 input preparation

### Why this is bigger than the operator script

This is not "bring classify into runtime."
It is "make self-reflection partly falsifiable and repeatable."

### Acceptance criteria

- the same defective trace produces materially the same audit findings across runs
- audit findings are visible to DR1 as grounded evidence
- audit rules are narrow, testable, and independently versioned
- generative DR can disagree with an audit, but cannot fail to see it

### Candidate GitHub issue

`Add deterministic audit pass before deep reflect`

## Requirement 3: Native Longitudinal Review Window

### Bigger feature gap

The runtime is still too session-centric.

It has historical memory, but not a first-class way to reason over a bounded
window such as:

- last 20 act sessions
- last 5 DR cycles
- last 3 occurrences of the same defect

The external observation loop is better here because it intentionally aggregates
many sessions and compares deltas over time.

### Optimal native requirement

Add a native longitudinal review window that can build bounded multi-session
rollups for DR1 and DR2.

Suggested native capabilities:

- configurable review windows
- summaries by session type
- recurrence tracking
- trend summaries
- "improving / regressing / noisy" judgments

### Where it belongs

- runtime state preparation for DR1
- optionally a DR2 input mode for mature recurring defects

### Why this is bigger than the operator script

This is not "keep observe/analyze-sessions."
It is "make the runtime capable of learning from trajectories rather than
isolated incidents."

### Acceptance criteria

- DR1 can reference an explicit bounded rollup, not just the latest traces
- the runtime can tell whether a defect recurred across multiple sessions
- the runtime can distinguish one-off anomalies from persistent regressions

### Candidate GitHub issue

`Add longitudinal session rollups for deep reflect`

## Requirement 4: Native Ground-Truth Review Context

### Bigger feature gap

The runtime does not systematically compare its own behavior against
ground-truth artifacts such as:

- code
- config
- prompts
- schemas
- explicit quality rubrics

`kernel:source_map` is a hint, not a full review context.

The operator loop is stronger because it treats runtime outputs as hypotheses
that must be checked against the codebase and evaluation lenses.

### Optimal native requirement

Add a native review-context builder that materializes relevant code/config/rules
as review evidence for DR1 and DR2.

Suggested native capabilities:

- collect source-mapped files implicated by recent failures
- package relevant prompt/config/schema fragments
- include explicit review rubrics or invariant checks
- surface contradictions between runtime belief and code truth

### Where it belongs

- DR1: root-cause tracing and diagnosis
- DR2: proposal/challenge context
- DR3: authority review when code changes touch sensitive surfaces

### Why this is bigger than the operator script

This is not "copy cc-analyze into runtime."
It is "make self-improvement grounded in the actual implementation surface."

### Acceptance criteria

- DR1 can receive concrete code/config context for observed failures
- DR2 proposals can cite explicit implicated files and invariants
- review notes distinguish state-trace evidence from code-truth evidence

### Candidate GitHub issue

`Build native code and rubric review context for DR`

## Requirement 5: Native Finding-to-Review Routing

### Bigger feature gap

The runtime has DR2 and DR3, but the upstream routing from "observed problem"
to "review candidate" is still under-structured.

The external loop made this explicit:

- finding
- probe update
- proposal candidate
- challenge
- route
- maybe approval

The deeper requirement is not more DR2 machinery by itself. It is a clearer
native pipeline from diagnosis to review action.

### Optimal native requirement

Add a native routing layer that promotes mature findings into the appropriate
next step:

- ignore / watch
- keep as defect only
- create review note for DR2
- escalate to DR3
- request operator approval

### Where it belongs

- between DR1 outputs and DR2 inputs
- partially in runtime policy, partially in DR2 preparation

### Why this is bigger than the operator script

This is not "keep loop.mjs".
It is "make the runtime explicit about what happens after a diagnosis."

### Acceptance criteria

- DR1 outputs can be routed deterministically by policy
- low-confidence findings do not spam DR2
- recurring high-confidence defects automatically become structured DR2 inputs
- authority-sensitive findings escalate cleanly to DR3

### Candidate GitHub issue

`Add native routing from audit findings to DR2 and DR3`

## Requirement 6: Native Burst Session Control

### Bigger feature gap

There is no first-class runtime control for intensive back-to-back testing.

The operator loop solved this by manually resetting schedule gates and forcing
new sessions. That is a workaround, not the requirement.

### Optimal native requirement

Add a bounded burst-mode runtime control that schedules sessions immediately
back-to-back for a fixed count.

Suggested native shape:

- `schedule.burst_remaining`
- `schedule.burst_reason`
- `schedule.burst_origin`
- `schedule.burst_mode = immediate`

### Where it belongs

- runtime control plane / scheduling policy

### Why this is bigger than the operator script

This is not "keep an overnight forcing script."
It is "give the runtime a native accelerated test mode."

### Acceptance criteria

- operator can request a burst of `N` sessions
- each completed session immediately schedules the next until the burst is exhausted
- normal cadence resumes automatically afterward
- the burst state is visible and auditable

### Candidate GitHub issue

`Add bounded burst mode for consecutive local sessions`

## Requirement 7: Unified Reset and Teardown Control

### Bigger feature gap

Reset logic is fragmented across:

- local KV reset
- local file cleanup
- remote workspace cleanup
- remote reasoning/job cleanup
- service restarts

The operator tooling solved this procedurally, but the deeper gap is that the
system lacks one coherent experiment-reset capability.

### Optimal native requirement

Add a unified reset/teardown control for controlled experiments, spanning local
and optional remote surfaces.

Suggested reset scopes:

- local runtime state
- local observation artifacts
- local workspace scratch
- remote compute workspace
- remote reasoning index
- remote jobs scratch

### Where it belongs

- runtime/admin control plane
- with remote cleanup delegated to the compute surface where appropriate

### Why this is bigger than the operator script

This is not "keep remote-compute.mjs forever."
It is "make clean experimental reset a first-class supported capability."

### Acceptance criteria

- one command or admin action can reset a named scope cleanly
- reset scopes are explicit and composable
- remote reset uses authenticated runtime-side controls, not ad hoc shell assumptions
- the runtime records what was reset and when

### Candidate GitHub issue

`Add unified local and remote teardown controls for experiments`

## Priority order

If these become GitHub issues, the best order is:

1. Native mechanical audit stage
2. Native defect ledger
3. Native longitudinal review window
4. Native finding-to-review routing
5. Native ground-truth review context
6. Native burst session control
7. Unified reset and teardown control

Rationale:

- audit + defect ledger + longitudinal rollup are the real self-improvement gap
- routing is what makes those outputs operationally useful
- ground-truth review context raises diagnosis quality
- burst mode and teardown improve experimentation, but they do not by
  themselves improve cognition quality

## What this means for the old operator suite

If the requirements above are implemented well, most of the old operator loop
can eventually be archived without regret.

What should remain external longer:

- branchable lab workspace management
- service lifecycle helpers
- notification and approval transport
- Cloudflare and remote infrastructure control

Those are still operator concerns, not core cognition requirements.
