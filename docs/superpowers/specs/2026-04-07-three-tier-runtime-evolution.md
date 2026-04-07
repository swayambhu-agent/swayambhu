# Three-Tier Runtime Evolution

Date: 2026-04-07

Status: Draft

## Purpose

This document defines how Swayambhu should evolve from the current runtime
shape into a cleaner three-tier architecture:

1. live runtime tier
2. governance tier
3. bounded compute and lab tier

It is not a cognitive-framework spec.

It is a runtime-boundary spec.

Its job is to answer:

- what should remain on Cloudflare Workers
- what the governor should own
- what the remote computer should become
- how to migrate from the current broad `computer` tool without breaking the
  working system

This document should be read together with:

- `docs/ARCHITECTURE.md`
- `docs/agent/design-rationale.md`
- `docs/superpowers/specs/2026-04-07-userspace-review-roles.md`
- `docs/superpowers/specs/2026-04-07-dr2-lab-runtime-design.md`
- `docs/superpowers/plans/2026-04-07-wake-provenance-and-external-trigger-plan.md`

## Main Conclusion

Swayambhu should keep the live kernel and live userspace runtime on
Cloudflare Workers.

The system should not move the entire agent onto a general-purpose server at
this stage.

Instead, it should evolve toward a cleaner three-tier runtime:

1. **Live runtime tier**
   - Cloudflare Workers
   - safety kernel
   - live userspace
   - live KV-backed state
   - operational sessions and operational review

2. **Governance tier**
   - governor worker and deployment pipeline
   - code staging, build, deploy, rollback, version history, promotion
   - the only path by which userspace code becomes live

3. **Bounded compute and lab tier**
   - long-running analysis jobs
   - userspace-review experiments
   - branch-local testing and bounded continuation
   - artifact production for later promotion
   - no direct authority to mutate live userspace

The main architectural problem today is not that Cloudflare Workers are the
wrong live substrate.

The main problem is that the current `computer` path gives the agent an
overly broad remote shell capability that partially undermines an otherwise
clean safety boundary.

Therefore the key runtime evolution is:

- keep Workers as the live substrate
- keep governor as the promotion path
- narrow the remote computer into a bounded compute and lab tier

## Why Not Move The Whole Agent Onto A Computer

Running the whole agent on a computer would simplify many operational
problems:

- easier local execution
- easier debugging
- easier long-running jobs
- easier lab experiments
- fewer tarball and callback mechanics

But it would also collapse the strongest boundary in the current design:

- the agent cannot directly rewrite the safety floor that runs it

Today that boundary is made real by deployment separation:

- live kernel and userspace run in Cloudflare Workers
- the governor controls code promotion
- the remote computer is outside the live runtime

If the whole agent moves onto one computer, that boundary becomes much weaker
unless it is rebuilt with a new containment model.

That would turn a current strength into a new research problem.

The current stage of the system does not justify paying that cost.

## Current Reality

The current architecture is already close to the target shape, but it is not
cleanly separated.

### What is already good

- the live runtime is on Workers
- the kernel/userspace split is real
- governor-mediated promotion already exists
- deep-reflect already uses a separate compute path for long-running analysis
- local state-lab already provides branchable isolated experimentation

### What is still muddled

- the `computer` tool provides broad remote shell execution
- the compute tier is treated as both a convenience limb and a structured job
  runner
- job types are only weakly differentiated
- side-effect boundaries on remote compute are not explicit enough
- userspace-review and lab work are not yet first-class runtime roles

This creates a trust inversion:

- the live runtime has careful safety boundaries
- the remote compute surface is comparatively blunt

That is the wrong asymmetry.

### Current gaps against the target

The current system already violates parts of the cleaner target boundary:

- `start_job` writes `job:*` records into live KV today
- completed remote jobs call back into the live runtime
- `computer` is still a normal tool surface rather than an exceptional one
- the current lab design still assumes side-effect isolation machinery that
  does not yet exist in the kernel

This spec is therefore an evolution document, not a claim that the target
boundary already exists.

## Target Three-Tier Architecture

## Tier 1: Live Runtime

This tier remains on Cloudflare Workers.

### Responsibilities

- run the safety kernel
- run live userspace
- execute act sessions
- execute operational review
- handle live inbound and outbound interactions
- enforce write gates, budget gates, safety rails, and communication policy
- own the authoritative live KV namespace

### What belongs here

- `kernel.js`
- live userspace modules and prompts
- live tool invocation
- live scheduling
- live session and review state
- callback ingestion for async job completion

### What does not belong here

- open-ended sandbox experimentation
- broad shell access
- speculative code patch trials
- branch-local continuation experiments
- architecture research execution

Tier 1 should remain optimized for:

- correctness
- boundedness
- safety
- recoverability

not for unrestricted experimentation.

## Tier 2: Governance

This tier is the governor and its promotion path.

### Responsibilities

- receive staged userspace code changes
- build deployable runtime artifacts
- deploy or roll back live userspace code
- maintain version history and rollback anchors
- act as the sole authority for promoting userspace code into Tier 1

### Core rule

The live runtime must not gain a second code-promotion path.

Even if higher review roles become highly capable, live userspace code should
still become active only through the governor path.

That preserves:

- auditability
- reversibility
- a single blast-radius choke point

### Relation to review roles

- `operational_review` may write live cognitive state and bounded config/prompt
  changes within existing rules
- `userspace_review` may propose and validate userspace changes
- the governor remains the point that turns validated changes into live code

## Tier 3: Bounded Compute And Lab

This tier is the remote compute capability, but in a narrower form than the
current `computer` tool.

It should be treated as:

- a long-running analysis tier
- a bounded experiment tier
- an artifact-production tier

not as a general shell limb attached to the live agent.

### Responsibilities

- run structured long-duration analysis jobs
- run `userspace_review` lab experiments
- host branch-local validation, tests, and bounded continuations
- produce artifacts, reports, and stageable outputs
- support architecture research branches without touching live runtime

### Explicit non-authority

Tier 3 must not:

- directly mutate live KV
- directly deploy live code
- directly bypass governor
- perform live irreversible side effects by default
- become an unrestricted second runtime for the whole agent

Its outputs should be:

- reports
- artifacts
- job results
- candidate code patches
- governor-stageable outputs

not direct live mutations.

## Job Completion Protocol

The job-completion callback is the only intended Tier 3 to Tier 1 boundary
crossing in the normal architecture.

Tier 3 does need one narrow write-adjacent path into Tier 1:

- completed jobs must be able to notify the live runtime that they finished

That path must remain tightly constrained.

The callback path must be treated as a boundary interface, not as a general
mutation path.

Its rules should be:

- strict callback secret validation
- strict payload validation
- only kernel-owned job-state updates
- no arbitrary KV writes
- no arbitrary state transitions outside job tracking

In other words:

- Tier 3 may signal completion
- Tier 1 decides what that signal means and what state changes are allowed

The current implementation of this boundary lives in the runtime HTTP path,
not yet in a dedicated kernel-owned protocol surface.

That is acceptable as a temporary reality.

It is not the desired final boundary shape.

## The Core Evolution: From `computer` To Bounded Compute

The current `computer` tool is too broad.

Today it is effectively:

- "run an arbitrary shell command on the remote machine"

That is convenient, but it is the wrong abstraction for the target system.

The remote tier should instead expose a small number of bounded capability
classes.

This requires enforcement machinery, not only better prompt wording.

The runtime must gain the ability to expose or suppress remote capabilities by
session role and runtime profile.

## Structured remote capabilities

The remote tier should converge toward structured operations such as:

- `analysis_job`
  - long-running model or file analysis
- `lab_run`
  - isolated userspace experiment against a snapshot or branch
- `artifact_fetch`
  - collect outputs from completed runs
- `bounded_exec`
  - only where a typed higher-level capability does not yet exist

These do not need to be final tool names.

The important change is that remote compute should be addressed primarily
through typed job classes with declared limits, not through open-ended shell.

## Transitional status of `computer`

The current `computer` tool should be treated as a legacy compatibility
surface.

Short-term:

- keep it for operations that still depend on it
- tighten its use in prompts and policy
- stop treating it as the natural path for new capability design

Medium-term:

- remove it from normal userspace tool selection
- reserve it for patron-authorized maintenance or explicit recovery contexts
- replace most real use cases with structured remote job paths

Long-term:

- either delete it
- or keep it as a quarantined operator-only escape hatch outside normal
  autonomous use

This transition cannot rely on prompt bias alone.

It requires a mechanical tool-availability gate in the runtime so autonomous
sessions can stop seeing `computer` as a default tool surface.

## Tier Boundaries By Review Role

## Operational review

`operational_review` belongs in Tier 1.

It should continue to:

- inspect live traces and state
- update live cognitive structure inside the current architecture
- keep the current userspace functioning coherently

It should not need Tier 3 except for structured long-running analysis jobs
that already fit the existing async job path.

## Userspace review

`userspace_review` is the main consumer of Tier 3.

Its correct runtime shape is:

- observe live outcomes from Tier 1
- form a hypothesis about userspace
- run isolated experiments in Tier 3
- emit validated stageable changes
- hand those changes to Tier 2 for promotion

This is the runtime realization of:

- `docs/superpowers/specs/2026-04-07-userspace-review-roles.md`
- `docs/superpowers/specs/2026-04-07-dr2-lab-runtime-design.md`

## Architecture research

`architecture_research` may also use Tier 3, but on looser and rarer
cadences.

Its default outputs should remain:

- architecture proposals
- branch experiment definitions
- migration plans

not live mutations.

## Design Principles For The Evolution

1. **Do not collapse the kernel boundary for convenience.**
   Easier execution is not worth losing the most important safety property.

2. **Remote compute is capability, not authority.**
   Tier 3 may do more work, but it should not own promotion.

3. **Promotion stays singular.**
   Live userspace code promotion must keep flowing through Tier 2.

4. **Experimentation happens off the live path.**
   Tier 3 is where userspace-review and architecture research test ideas.

5. **Prefer structured jobs over arbitrary shell.**
   Each new remote capability should be designed as a typed bounded operation,
   not as "just run this command."

6. **Treat state and side-effect isolation as first-class.**
   The remote tier must be branch-aware, profile-aware, and side-effect-aware.

7. **Do not overfit the runtime split to the current ontology.**
   This runtime architecture should remain valid even if userspace stops using
   the current concepts or review phrasing.

8. **Use kernel enforcement for hard prohibitions.**
   If a capability must be unavailable in some context, the kernel should
   enforce that boundary rather than relying on prompt discipline alone.

## Required Runtime Prerequisites

The following are mechanical prerequisites for the cleaner three-tier model.

They are not optional polish.

### Tool-availability gate

The runtime needs a session-aware tool filter so different runtime roles can
see different tool surfaces.

Examples:

- normal autonomous sessions should eventually stop seeing `computer`
- lab continuations should see a restricted tool set
- operator or recovery contexts may still expose broader capabilities

Without this, the migration away from `computer` is mostly aspirational.

### Kernel-enforced lab tool denylist

Tier 3 bounded continuation must use kernel-enforced tool denial, not only a
lab env var convention.

The denylist should be controlled by the lab runtime and enforced where tools
are executed.

This is the correct place to block:

- outbound communication tools
- wallet and transaction tools
- any explicitly irreversible capability

### Callback hardening

The remote job completion callback must be explicitly narrowed to:

- authenticated completion notification
- validated payload
- kernel-owned job state updates only

No broader interpretation path should exist.

### Kernel-owned job bookkeeping

Remote job tools should not own live KV bookkeeping longer than necessary.

The clean target is:

- remote-dispatch tools return structured results
- the kernel owns the authoritative job-state write path

This keeps live-state mutation in the kernel boundary rather than inside the
remote compute adapter surface.

## Migration Stages

## Stage dependency matrix

The migration stages are not independent.

They should be read with these hard dependencies:

- Stage 1.5 depends on Stage 1
- Stage 2 depends on Stage 1 and Stage 1.5
- Stage 3 depends on Stage 2
- Stage 4 depends on Stage 3 and the runtime prerequisites listed above
- Stage 5 depends on Stages 3 and 4 proving real replacement paths
- Stage 6 depends on the local and adjacent Tier 3 runtime already being
  stable

In practical terms:

- do not operationalize Tier 3 lab continuation before tool-availability and
  tool-deny mechanics exist
- do not deprecate `computer` before structured replacements are real
- do not treat callback-based remote work as clean until the callback boundary
  has been hardened

## Stage 0: Declare the target boundary

Adopt this three-tier architecture as the intended runtime direction.

Immediate consequences:

- stop designing new features around unconstrained `computer`
- treat Tier 3 as a bounded compute and lab tier
- treat Tier 2 as the only live code-promotion path

This stage is documentation and policy alignment.

## Stage 1: Reclassify remote compute surfaces

Document and classify all current remote-compute use cases:

- live convenience shell usage
- async analysis jobs via `start_job`
- artifact collection
- dev-loop and state-lab experiments

Then separate them into:

- keep as structured job
- migrate into lab runtime
- deprecate
- reserve for operator-only use

This stage should explicitly mark `tools/computer.js` as legacy/high-risk.

## Stage 1.5: Inventory every `computer` use

Produce an explicit inventory of:

- prompt references
- userspace call paths
- manual operator workflows
- dev-loop workflows
- any other remote-shell dependence

For each use, decide whether it should become:

- structured analysis
- lab execution
- artifact collection
- operator-only escape hatch
- deprecated and removed

The migration away from `computer` should not proceed without this inventory.

## Stage 2: Tighten the live policy around `computer`

Before removing it, narrow its practical blast radius.

Examples:

- stop advertising it as a normal planning tool
- require explicit high-friction policy for autonomous use
- bias prompts toward structured tools first
- keep it out of userspace-review default change strategies

This stage reduces dependence before code removal.

It should be paired with the new tool-availability gate so prompt policy is
backed by runtime enforcement.

## Stage 3: Strengthen structured compute paths

Make structured remote operations the default path for new work.

In practice this means:

- keep `start_job` for bounded async analysis
- extend typed job classes where needed
- formalize Tier 3 lab execution through `state-lab.mjs lab-run`
- formalize artifact collection and promotion handoff

The remote compute tier should become legible as a set of bounded runtimes,
not a shell API.

This stage should also narrow the current boundary mismatches:

- harden the callback path
- move job bookkeeping toward kernel-owned writes
- reduce arbitrary file and shell assumptions in structured job types

These are not optional refinements.

They are the prerequisite cleanup that makes Tier 3 consistent with the stated
boundary model.

## Stage 4: Operationalize Tier 3 for userspace review

Implement the v1 lab described in:

- `docs/superpowers/specs/2026-04-07-dr2-lab-runtime-design.md`

This creates the first true Tier 3 runtime for self-improvement:

- isolated
- reproducible
- governor-compatible
- non-live by default

At this point the three tiers become materially real.

### Promotion authority during Stage 4

Until the system has a separately justified autonomous promotion authority,
promotion from Tier 3 results should remain mediated by:

- a human
- or an external dev-loop style controller

`userspace_review` may recommend promotion.

It should not assume the right to self-promote immediately simply because it
ran the experiment.

## Stage 5: Reserve `computer` for exceptional contexts

Once structured job paths cover the actual needs:

- remove `computer` from normal autonomous use
- keep only explicit operator or recovery access if still needed

This stage completes the main boundary cleanup.

## Stage 6: Optionally add remote hosted lab execution

Only after the local and adjacent lab is proven should the system consider a
remote-hosted lab runtime for Tier 3.

That is an optimization step, not the first correct design.

## What Stays Where

## Remains in Tier 1

- live kernel execution
- live userspace execution
- live scheduling
- live act sessions
- operational review
- live inbound and outbound channels
- live KV authority

## Remains in Tier 2

- code staging
- deploy and rollback
- versioned promotion
- build artifacts
- promotion approval mechanics

## Moves or consolidates into Tier 3

- long-running non-live analysis
- userspace-review experiments
- branch-local replay and continuation
- test-driven validation of userspace changes
- architecture research branches

## Non-Goals

This document does not propose:

- moving the live kernel off Workers
- giving Tier 3 direct live code authority
- making the remote machine the new single runtime for the whole agent
- removing the governor
- making architecture research a live mutation path

## Dispatch Model

The review roles should not invent an entirely separate runtime heartbeat.

The intended direction is:

- keep review dispatch inside the existing live runtime scheduling loop
- give `userspace_review` its own schedule and triggering policy
- let the live runtime decide when to dispatch Tier 3 work
- let Tier 3 perform the non-live experiment
- return validated artifacts for later promotion

This keeps one live orchestrator while still allowing multiple review roles.

The intended direction is to evolve the existing live review dispatch path,
not to bolt on a second unrelated polling loop.

## Success Criteria

This evolution is successful when:

1. the live runtime still has a real safety floor outside agent reach
2. governor remains the single live code-promotion path
3. normal autonomous behavior no longer depends on broad arbitrary shell
4. userspace-review can run meaningful experiments without touching live state
5. remote compute is described in terms of bounded job classes, not as a
   general-purpose limb
6. the runtime architecture remains meaningful even if userspace cognition is
   redesigned
7. lab isolation and callback handling are kernel-enforced rather than
   convention-enforced

## Immediate Implications

The next architectural steps should be interpreted in this order:

1. implement the Tier 3 lab runtime for `userspace_review`
2. treat `computer` as a legacy surface to be narrowed
3. keep Workers as the live runtime substrate
4. keep governor as the only promotion path

That gives the system a cleaner runtime story without giving up its strongest
existing boundary.
