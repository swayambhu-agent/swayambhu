# Probationary Semantic Rollback and Deployment Review

Date: 2026-04-12

Status: Draft

Related:

- `docs/superpowers/specs/2026-04-10-dr1-dr2-self-modification-handoff-design.md`
- `docs/superpowers/specs/2026-04-12-authority-policy-refactor-and-proto-dr3.md`

## Purpose

Give the system a governed way to detect that a recently deployed DR-2 or
DR-3 change made behavior worse in a semantic sense, not just in a crash
sense, and to roll it back without oscillating between nearby fixes.

The motivating case is concrete:

- a DR-2 change was staged, deployed, and restarted correctly
- later `30`-cycle dev-loop evidence showed new meta-policy notes indicating
  that the change was a regression
- the change was manually revoked

This spec defines how that same decision should become autonomous.

Important framing:

- `devloop_30` is not the long-term production concept
- the enduring concept is a bounded **post-deploy observation window**
- `devloop_30` is only the first observation backend because it is the only
  broad semantic regression signal we already trust on branches

## Code Validation Snapshot

This spec was validated against the live repo before drafting.

Current code facts this spec is explicitly responding to:

- `userspace.js` already has a real DR-2 deploy path:
  - `dr2Cycle()` reads stageable lab results
  - `applyDr2ValidatedChanges()` applies protected KV changes, stages code,
    and signals deploy
- `governor/worker.js` already supports deploy and rollback through:
  - `deploy:pending`
  - `deploy:rollback_requested`
  - pre-deploy snapshots at `deploy:snapshot:{version_id}`
- `kernel.js` already triggers automatic rollback on crash-only evidence:
  - `3` consecutive crashes or kills write `deploy:rollback_requested`
- `governor/deployer.js` already records:
  - `deploy:current`
  - `deploy:history`
  - `deploy:version:{version_id}`
- current deployment history is too thin for semantic rollback:
  - it records `version_id`, `deployed_at`, `changed_keys`, `code_hashes`,
    and deploy mode
  - it does not record source review provenance, predecessor version, or any
    probation status
- current DR-2 cooldown and failure backoff help with dispatch noise, but they
  do not prevent semantic oscillation between nearby fixes
- current runtime has no concept of:
  - probationary deployment
  - deployment-level review
  - quarantine of rolled-back fix families
  - semantic rollback request scoped to a specific current version
- current scheduled governor path has a provenance bug:
  - `scheduled()` deletes `deploy:pending` before `performDeploy()` re-reads it
  - this currently causes `execution_id` to fall back to `null` on the
    scheduled deploy path
  - any semantic-rollback provenance work must fix this first

This spec is therefore not describing a capability that already exists. It is
an explicit extension of the current DR-2/governor architecture.

## Problem

The current rollback story is asymmetric:

- **Crash rollback exists**
  - if deployed code breaks the runtime hard enough, kernel tripwire asks
    governor to roll back
- **Semantic rollback does not exist**
  - if behavior becomes worse but the runtime still executes, the system can
    only produce more review notes and try another forward patch

That creates two concrete risks.

### 1. Bad semantic fixes remain live too long

A change can:

- preserve process liveness
- pass targeted tests
- still make the agent less useful over a wider behavioral window

That was the actual failure mode in the motivating case.

### 2. Naive autonomy would thrash

If the system simply treats post-deploy regressions as fresh DR-2 defects, the
likely loop is:

1. deploy fix `A`
2. new notes appear because `A` harmed another behavior
3. DR-2 proposes `B`
4. `B` restores the old failure or partially recreates `A`
5. repeat

This is not robust self-correction. It is oscillation.

## Non-goals

This spec does **not** try to:

- replace crash rollback
- make every ordinary session participate in rollback adjudication
- require semantic rollback for every deploy in production immediately
- turn `deployment_review` into a general userspace diagnosis role
- decide the next forward fix after a rollback

Its job is narrower:

- detect whether a probationary deploy should be kept or reverted
- do that from structured post-deploy evidence
- prevent immediate reapplication of the same failed fix family

## Main Decision

Add a distinct post-deploy adjudication path:

- `deployment_review`

This is **not** DR-2 and **not** DR-3.

Why:

- `DR-2` asks: what userspace change best addresses this defect within the
  current authority model?
- `DR-3` asks: should the authority model itself change?
- `deployment_review` asks: did the last deployed change improve behavior
  enough to keep, or should governor roll it back?

That is a different question from both diagnosis and constitutional review.

## V1 Scope

V1 is intentionally narrow:

- only deployments originating from governed DR-2 or DR-3 code changes enter
  semantic probation
- V1 uses branch/lab observation windows backed by `devloop_30`, because that
  is the current trusted semantic-regression backend
- crash rollback remains active everywhere
- production should later use the same `deployment_review` role with a
  different observation backend, not with `devloop` as such

This is the smallest scope that solves the real problem we already hit.

## Target Architecture

The design has four new pieces:

1. deploy provenance
2. probation state
3. deployment review
4. rollback quarantine

It also has one prerequisite bug fix:

5. preserve deploy provenance across the scheduled governor path

## 1. Deploy Provenance

Every governed code deploy that comes from DR-2 or DR-3 must carry enough
provenance to be judged later.

Current `deploy:version:{version_id}` manifests are too thin.

### New manifest fields

Extend `deploy:version:{version_id}` to include:

```json
{
  "version_id": "v_...",
  "deployed_at": "ISO8601",
  "predecessor_version_id": "v_prev",
  "execution_id": "x_...",
  "changed_keys": ["hook:session:code"],
  "code_hashes": {},
  "deploy_mode": "cloudflare|local",
  "source": {
    "kind": "dr2|dr3|manual|operator",
    "review_note_key": "review_note:... or null",
    "authority_effect": "no_authority_change|authority_narrowing|authority_widening|policy_refactor_only|null",
    "change_family": "stable semantic family key or null"
  }
}
```

### Why `predecessor_version_id` is required

Semantic rollback must be targeted.

Without predecessor provenance, the governor only knows:

- the current version
- a generic history list

That is not enough to say:

- roll back exactly the probationary deploy we are evaluating
- and do not accidentally revert a newer version

### `change_family`

This is **not** a code hash.

It is a stable family identifier used for quarantine.

V1 definition:

- derived from:
  - source review kind (`dr2` or `dr3`)
  - sorted changed code targets
- intentionally ignores:
  - exact code bytes
  - review-note slug
  - review-note key ordinal details

Reason:

- exact patch hashes are too brittle
- quarantine needs to block near-identical retries of the same attempted fix

Concrete v1 rule:

- `change_family = hash(source_kind + sorted(changed_keys))`

This is deliberately simple and stable across repeated notes about the same
surface.

Known v1 limitation:

- this family is surface-based, not intent-based
- two unrelated fixes touching the same code surface may therefore share a
  family and over-trigger quarantine

V1 mitigation:

- quarantine expires after a bounded number of sessions
- this limits false-positive blast radius while keeping the first anti-thrash
  mechanism simple

## 2. Probation State

Every governed code deploy enters a probation window before it is considered
accepted.

### New lifecycle key

Add:

- `deployment_review:state:1`
- `deployment_review:result:{generation}`
- `deployment_review:quarantine:{change_family}`

This is runtime-owned lifecycle state, not agent-writable userspace state.

Authority-policy dependency:

- `deployment_review:*` must be added to the lifecycle tier in
  `authority-policy.js` / `kernel:write_policy`

Suggested shape:

```json
{
  "status": "idle|observing|reviewing|completed",
  "active_version_id": "v_...",
  "predecessor_version_id": "v_prev",
  "source_kind": "dr2|dr3",
  "source_review_note_key": "review_note:...",
  "change_family": "string",
  "started_at": "ISO8601",
  "observation_mode": "devloop_30|live_window",
  "observation_artifact_ref": "path or null",
  "extensions_used": 0,
  "max_extensions": 1,
  "final_verdict": "keep|rollback|null",
  "finalized_at": "ISO8601 or null"
}
```

### Main rule

Only one probationary governed code deploy may be active per branch/runtime at
a time.

Why:

- it keeps attribution legible
- it prevents stacked ambiguous deploys
- it is the simplest anti-thrash rule

If another DR-2 or DR-3 code deploy becomes stageable while probation is
active, runtime should not deploy it automatically. It should remain queued or
be rejected as "probation already active".

Enforcement point:

- the gate belongs in the live apply path, not just dispatch
- `applyDr2ValidatedChanges()` and the corresponding DR-3 apply path must
  check for active non-idle probation **before** calling `K.stageCode()` or
  `K.signalDeploy()`
- protected non-code writes may still apply; only governed code deploy should
  be blocked

V1 priority rule:

- DR-3 does **not** preempt active probation automatically
- if a DR-3 authority change becomes ready during DR-2 probation, it must wait
  or be deployed manually by the operator

This is acceptable in proto-DR-3 because authority review remains rare and
human-triggered.

## 3. Observation Phase

Probation is not judged from one later note.

It is judged from a bounded post-deploy observation window.

### Observation modes

`deployment_review` is generic over observation backend.

V1 mode:

- `devloop_30`
  - branch/lab-only
  - uses a bounded `30`-cycle regression run

Later production mode:

- `live_window`
  - runs over a bounded post-deploy real-session window
  - should draw from comparative live evidence such as:
    - target-behavior deltas
    - recurrence of adjacent `review_note:*`
    - continuity / blockage / no-action regressions

The adjudicator stays the same.

Only the evidence generator changes.

### V1 observation source

Use the evaluation method that already exposed the real problem:

- `30`-cycle dev-loop on the branch/runtime carrying the probationary deploy

This is the right v1 because:

- the evidence is broad enough to catch semantic drift
- it matches current practice
- it avoids pretending live-session telemetry is already rich enough for the
  same judgment

### Observation runner

V1 is autonomous, not manual.

Add a dedicated bounded lab job type, for example:

- `deployment_review_probe`

Its job is:

1. read the active probation record
2. run the configured `30`-cycle dev-loop against the probationary version
3. build a compact observation bundle
4. write:
   - batch summary artifact
   - compact review manifest
   - machine-readable list of review notes created during the probation window

This is deliberately separate from `deployment_review` itself.

Reason:

- observation generation and adjudication are different phases
- the dev-loop run is compute-heavy
- keeping the probe separate preserves a cleaner review prompt

V1 orchestration rule:

- the probe runs as a bounded adjacent compute job, not inline inside the live
  tick loop
- in `devloop_30` mode, it runs against the already-deployed probationary
  branch/runtime, not a second speculative worktree
- probe infrastructure failures are **not** semantic evidence against the
  deploy itself
- if the probe job fails to complete, probation may extend once; after that,
  the unresolved deploy defaults to `rollback`

### Observation bundle

At the end of the observation window, build a compact bundle containing:

- deployed version manifest
- predecessor version manifest
- pre-deploy baseline summary used to justify the deploy
- post-deploy observation summary
- meta-policy / review notes created during the probation window
- direct changed targets from the deploy manifest
- source review artifact that caused the original deploy

Important:

- this is not a raw dump of all sessions
- it is a bounded comparative bundle

### Baseline

V1 requires an explicit pre-deploy baseline summary.

That baseline may come from:

- the last accepted branch baseline batch
- or the immediately preceding regression batch on the predecessor version

If no baseline summary exists, the probationary deploy must not be eligible for
autonomous semantic keep. It may still deploy for experimentation, but final
resolution should default to rollback after the observation window unless a new
baseline is created.

This is intentionally conservative.

## 4. Deployment Review

After observation, run a distinct review role:

- `deployment_review`

### Inputs

It reads only:

- deployment provenance
- predecessor provenance
- baseline summary
- probation summary
- probation-period review notes
- source review note/result

It does **not** author patches.

### Output contract

```json
{
  "verdict": "keep|rollback|extend",
  "confidence": 0.0,
  "summary": "string",
  "target_current_version": "v_...",
  "expected_predecessor_version": "v_prev",
  "causal_adjacency": "low|medium|high",
  "evidence_for_improvement": ["string"],
  "evidence_for_regression": ["string"],
  "quarantine_recommended": true,
  "quarantine_reason": "string or null"
}
```

### Decision rule

`deployment_review` must answer these questions in order:

1. Did the target problem improve relative to the predecessor baseline?
2. Did new regressions appear during probation?
3. Are those regressions plausibly adjacent to the deployed change, rather
   than unrelated background noise?
4. Is the overall probation result better, worse, or unclear relative to the
   predecessor baseline?

Terminal decisions:

- `keep`
  - the change improved the intended behavior
  - and did not create stronger adjacent regressions
- `rollback`
  - the change created or amplified adjacent regressions
  - or failed to improve the target problem enough to justify the cost

Intermediate decision:

- `extend`
  - evidence is genuinely mixed or too sparse
  - runtime may run one additional bounded observation batch

V1 terminal rule:

- after `max_extensions`, anything other than a clean `keep` becomes
  `rollback`

Reason:

- experimental probation is not the place to accumulate ambiguous live state
- ambiguous semantic fixes should not silently become the new baseline

### Adversarial review requirement

`deployment_review` must use the same two-model adversarial structure as DR-2
and proto-DR-3:

1. primary reviewer
2. adversarial challenger
3. revise if needed
4. repeat up to configured max rounds

V1 convergence rule:

- if the final adversarial verdict does not converge to a clear `keep` or
  `rollback`, treat the result as `extend`

This keeps the role robust without inventing a fake certainty.

### Current-version guard

Before accepting any `keep` or `rollback` result, runtime must verify:

- `deploy:current.version_id === active_version_id`

If not:

- the probationary deploy was already superseded or rolled back externally
- finalize probation as `rollback` with reason `external_version_change`

This cleanly handles:

- crash-triggered rollback
- manual operator rollback
- any other out-of-band restoration

## 5. Rollback Request Path

Do **not** invent a second rollback key.

Reuse:

- `deploy:rollback_requested`

But strengthen its payload.

### New rollback request payload

```json
{
  "reason": "3_consecutive_crashes|semantic_regression",
  "requested_at": "ISO8601",
  "requested_by": "kernel_tripwire|deployment_review",
  "target_current_version": "v_...",
  "expected_predecessor_version": "v_prev or null",
  "source_review_note_key": "review_note:... or null",
  "change_family": "string or null"
}
```

### Governor requirement

Before performing rollback, governor must verify:

- `deploy:current.version_id === target_current_version`

If not:

- ignore the request as stale
- record an audit event

Why:

- semantic rollback may arrive after a newer deploy already happened
- blindly rolling back "whatever is current" would be incorrect

### Crash rollback compatibility

Crash rollback can still use the same key with:

- `reason = 3_consecutive_crashes`
- `target_current_version = current version if known, else null`

If crash rollback does not provide a target version, governor may retain
current behavior.

Explicit governor rule:

- if `target_current_version` is present, perform targeted rollback only when
  it matches `deploy:current.version_id`
- if `target_current_version` is `null`, perform untargeted rollback using
  current governor behavior

### Scheduled-path prerequisite fix

Before any provenance-aware semantic rollback work lands, governor must fix the
current scheduled deploy bug:

- `scheduled()` must not delete `deploy:pending` before `performDeploy()` reads
  it

Acceptable fixes:

- pass the already-read `pending` object into `performDeploy()`
- or move deletion to after `performDeploy()` has consumed the payload

Without this, the execution/provenance chain is not trustworthy.

## 6. Quarantine

Rollback alone is not enough.

Without quarantine, the system can re-propose the same failed fix family on
the next cycle.

### New lifecycle key family

Add:

- `deployment_review:quarantine:{change_family}`

Suggested payload:

```json
{
  "change_family": "string",
  "created_at": "ISO8601",
  "expires_after_sessions": 60,
  "source_review_note_key": "review_note:...",
  "rolled_back_version_id": "v_...",
  "reason": "string"
}
```

### Enforcement

Before runtime applies any stageable DR-2 or DR-3 code result, it must compute
or read the proposed `change_family`.

If that family is quarantined:

- do not auto-stage or auto-deploy it
- record a karma event
- optionally emit a new review note that materially new evidence is required

### Why quarantine is family-based

The actual threat is not exact byte-for-byte redeploy.

It is:

- repeated attempts to solve the same observed defect by reopening the same
  failed causal move

Family-level quarantine is the cleanest protection against that.

## Rollback Manifest Semantics

Current governor rollback restores prior code and then records a **new**
deployment version.

That is correct, but the manifest needs to distinguish:

- chronological predecessor
- semantic restoration target

V1 rule for rollback-created versions:

- `predecessor_version_id` = the just-current version that was rolled back
- add `rollback_of_version_id` = same just-current version
- add `restored_predecessor_version_id` = the version whose snapshot was
  restored

This preserves both:

- timeline correctness
- semantic clarity about what was restored

## Why This Avoids Thrashing

The design avoids oscillation through five concrete rules:

1. one probationary deploy at a time
2. bounded observation window before judgment
3. distinct deployment-level review instead of immediate forward patching
4. rollback only on comparative, causally adjacent evidence
5. quarantine of rolled-back fix families

This is the minimum coherent set.

If any one of these is removed, thrashing becomes much more likely.

## Why Ordinary DR-2 Should Not Do This

Letting ordinary DR-2 handle post-deploy regressions directly would blur two
questions:

- what is the best next fix?
- should the last fix remain live at all?

Those are not the same.

The first invites patching forward.

The second requires comparative adjudication against a predecessor.

That is why `deployment_review` deserves to be its own role.

## Why This Is Not DR-3

Authority-boundary changes still belong to proto-DR-3.

But whether a recent deploy should remain live is not a constitutional
question.

It is a deployment-stability question.

So:

- DR-3 may originate a change that later enters probation
- but `deployment_review` decides whether that deployed change should stay

This keeps the axes orthogonal:

- diagnosis
- constitutional change
- deployment adjudication

## Migration Plan

### Stage 0: prerequisite governor bug fix

1. fix scheduled governor deletion of `deploy:pending` before `performDeploy()`
   reads it
2. add regression tests proving scheduled deploy preserves execution/provenance
   payload

### Stage 1: provenance and targeted rollback contract

1. extend `deploy:pending` payload so DR-2/DR-3 can pass provenance through
   governor
2. extend `deploy:version:{version_id}` with predecessor and source metadata
3. strengthen `deploy:rollback_requested` payload with target-version checks
4. update governor rollback path to reject stale semantic rollback requests
5. extend rollback-created manifests with restoration semantics

### Stage 2: probation state and observation orchestration

1. add `deployment_review:state:1`
2. add `deployment_review:*` to the lifecycle tier in authority policy
3. open probation automatically after governed code deploys
4. prevent a second probationary auto-deploy while one is active
5. block code staging/deploy in `applyDr2ValidatedChanges()` and the DR-3
   apply path while probation is active
6. wire a dedicated observation runner for `devloop_30` branch evaluation

### Stage 3: deployment review role

1. add `deployment_review` prompt/schema/runner
2. reuse adversarial review infrastructure
3. add a `deployment_review` config block in `config/defaults.json`
4. emit terminal `keep` or `rollback`

### Stage 4: quarantine and apply-path enforcement

1. add `deployment_review:quarantine:*`
2. compute or transport `change_family` through DR-2/DR-3 results
3. block auto-redeployment of quarantined families

### Stage 5: later live-runtime extension

After branch/lab probation works cleanly:

- extend the same `deployment_review` role to `live_window` observation mode
  in the live runtime

This is a later phase, not part of the first implementation.

## Acceptance Criteria

The first implementation should pass these behavioral tests.

1. A probationary DR-2 deploy that causes new adjacent regressions over a
   `30`-cycle branch run is automatically rolled back to its predecessor.
2. A crash-only bad deploy still rolls back through the existing kernel
   tripwire.
3. A new semantic rollback request cannot roll back a newer unrelated current
   version by accident.
4. After semantic rollback, the same change family is not auto-redeployed
   during quarantine.
5. If probation evidence is mixed, the system does not silently keep the
   ambiguous fix as the new baseline.
6. Ordinary DR-2 does not continue patching the same probationary surface
   forward while deployment review is still unresolved.
7. Scheduled governor deploy preserves provenance payload rather than dropping
   `execution_id` and source metadata.

## Staleness Note For Older Specs

This design makes one older self-modification spec concretely stale against the
live code and the new architecture:

- `docs/superpowers/specs/2026-04-05-dr-self-modification-design.md`

Concrete drift:

- it describes direct DR code staging as the active architecture
- it describes config/prompt rollback as manual-only operator action
- live code now routes code changes through governed DR-2 lab execution
- this spec adds a distinct governed semantic rollback path after deploy

Keep that document as historical context only.
