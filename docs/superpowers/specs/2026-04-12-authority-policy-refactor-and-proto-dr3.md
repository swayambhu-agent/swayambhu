# Authority Policy Refactor and Proto-DR-3

Date: 2026-04-12

Status: Draft

Related:

- `docs/superpowers/specs/2026-04-07-userspace-review-roles.md`
- `docs/superpowers/specs/2026-04-10-dr1-dr2-self-modification-handoff-design.md`
- `docs/superpowers/specs/2026-04-09-identification-implementation-spec.md`

## Purpose

Make the kernel a generic enforcement engine rather than a holder of
userspace-specific cognitive concepts.

The immediate trigger is narrow:

- `kernel.js` currently names cognitive families like `pattern:*` and
  `identification:*`
- `kernel.js` also contains entity-specific helpers like
  `updatePatternStrength()` and `updateIdentificationLastExercised()`
- `kernel.js` currently seeds `identification:working-body`, which is a
  first-order cognitive object

Those choices are pragmatic, but they couple the kernel to the current
userspace ontology.

If userspace later stops using `pattern`, `identification`, `desire`, or any
other current concept, the kernel should not need a redesign just to remain
correct.

This spec defines:

- a policy layer that moves authority rules out of kernel source and into
  kernel-owned data
- a single generic privileged write mechanism
- removal of ontology-specific helpers and seeds from kernel code
- a proto-`DR-3` path for governed changes to the authority model itself

## Code Validation Snapshot

This spec was validated against the live repo before drafting.

Current code facts that this spec is explicitly responding to:

- `kernel.js` still hardcodes ontology-specific families in
  `DEFAULT_KEY_TIERS`
- `scripts/seed-local-kv.mjs` already seeds `kernel:key_tiers`
- `kernel.js` still contains:
  - `ensureIdentitySeed()`
  - `updatePatternStrength()`
  - `updateIdentificationLastExercised()`
- `kernel.js` also still contains hardcoded write-friction checks in
  `_gateSystem()` for:
  - `principle:*`
  - `prompt:*`
  - `config:model_capabilities`
- `kernel.js` still contains domain-specific `_gateContact()` logic
- `kernel.js` still supports `rename` for direct agent-key writes
- `kernel.js` still performs key-family-specific post-write side effects for:
  - `hook:*` alerting
  - selected `config:*` cache reloads
- live code treats `principle:*` as protected-with-deliberation even though
  `CLAUDE.md` still describes principles as immutable; this spec follows the
  live runtime, not the stale note
- `buildKernelInterface()` currently exposes `updatePatternStrength()`, but
  does not expose `updateIdentificationLastExercised()`
- `userspace.js` still attempts `K.updateIdentificationLastExercised?.(...)`
  opportunistically, so identification exercise tracking is currently a silent
  no-op rather than a working helper path
- `kvWriteGated()` currently supports `put`, `delete`, and `patch`, but not
  `field_merge`
- current runtime `kvWriteGated()` call sites use only:
  - `reflect`
  - `deep-reflect`
  - `userspace-review`
- `act` and `authority-review` would be new validated contexts
- `eval` is not currently a real `kvWriteGated()` caller
- `DR-2` already exists as a governed lab path with adversarial review
  configured in `config/defaults.json`

This document therefore describes a target refactor from the current code
base, not an abstract architecture disconnected from implementation.

## Problem

The current runtime boundary is cleaner than early Swayambhu, but it still has
three leaks.

### 1. Kernel knows current cognitive families

`DEFAULT_KEY_TIERS` in `kernel.js` currently hardcodes families like:

- `pattern:*`
- `desire:*`
- `tactic:*`
- `identification:*`
- `review_note:*`

Some of these are review infrastructure rather than cognition, but several are
plainly ontology-specific.

That means:

- changing userspace ontology requires changing kernel source
- the kernel carries assumptions about current cognitive design
- "protectedness" of a concept is partly encoded in source instead of policy

### 2. Kernel exposes ontology-specific mutation helpers

`kernel.js` currently contains:

- `updatePatternStrength()`
- `updateIdentificationLastExercised()`

These are narrow helpers, but they still embed:

- entity names
- field names
- schema expectations

That is domain knowledge in the kernel.

### 3. Kernel seeds a cognitive object

`ensureIdentitySeed()` currently creates `identification:working-body`.

That is not just an authority rule. It is a statement about userspace meaning.

This is the clearest boundary leak:

- the kernel is creating first-order cognition
- therefore the kernel is no longer purely generic infrastructure

## Design Goals

1. Kernel code should know enforcement mechanics, not cognitive ontology.
2. Authority boundaries should remain explicit and enforceable.
3. Userspace should be free to evolve its ontology without requiring kernel
   edits.
4. Policy should be able to evolve through governed self-modification.
5. Changes to authority policy should be stricter than ordinary userspace
   changes.
6. The migration should preserve current safety properties during transition.

## Non-goals

This refactor does **not** try to:

- eliminate every kernel-owned invariant
- make the kernel writable by ordinary runtime cognition
- merge kernel, policy, and userspace into one layer
- make `DR-3` a full always-on live review loop immediately
- redesign the current cognitive ontology as part of this spec

## Main Decision

Split the current runtime boundary into three conceptual surfaces:

1. `kernel`
   - generic enforcement machinery
   - lifecycle ownership
   - audit and deployment plumbing
2. `authority policy`
   - kernel-owned data describing key tiers and allowed write operations
   - no direct act-time write access
3. `userspace`
   - prompts, planning, reflection, cognition, and userspace code

And add a fourth review role:

4. proto-`DR-3`
   - governed review for changes to the authority model itself

The key principle is:

- the kernel is a policy engine, not a domain model

## Target Architecture

## Surface 1: Kernel

The kernel should own only:

- key-pattern matching
- tier enforcement
- lifecycle ownership
- generic write-operation validation
- deploy / rollback plumbing
- auditing and karma
- fail-closed behavior when policy is missing or invalid

The kernel should **not** own:

- ontology-specific key families in source
- ontology-specific write helpers
- ontology-specific seed objects
- field semantics like "strength should be clamped" for a particular concept

### Allowed kernel knowledge

After this refactor, kernel source may still know:

- tier names: `immutable`, `kernel_only`, `lifecycle`, `protected`
- operation names: `put`, `delete`, `patch`, `field_merge`
- runtime contexts: `act`, `reflect`, `deep-reflect`, `userspace-review`,
  `authority-review`
- kernel-owned infrastructure roots like:
  - `kernel:*`
  - `karma:*`
  - `sealed:*`
  - `event:*`
  - `dr:*`
  - `dr2:*`
  - `dr3:*`
  - `dharma`
  - patron trust anchors

This is infrastructure knowledge, not cognitive ontology.

### `lifecycle` versus `kernel_only`

Both tiers are non-agent-writable.

They differ by purpose:

- `kernel_only`
  - safety and trust anchors the runtime should treat as internal
  - not part of ordinary review progression
- `lifecycle`
  - runtime-owned coordination state for schedulers, review machines, and
    promotion bookkeeping
  - may be created, advanced, reset, or deleted by dedicated runtime lifecycle
    helpers

So `lifecycle` is not a weaker protection tier. It is a narrower semantic
category for resettable runtime state.

### Existing lifecycle helpers

Current kernel already exposes dedicated lifecycle helpers:

- `writeLifecycleState()`
- `deleteLifecycleState()`

V1 decision:

- keep these as kernel-internal runtime helpers outside `kvWriteGated()`
- do not route lifecycle writes through the authority-policy engine

Rationale:

- authority policy governs agent-originated writes
- lifecycle state is runtime-owned bookkeeping, not agent cognition

Follow-on requirement:

- lifecycle helpers should still produce explicit audit / karma events so they
  do not become an invisible write path

## Surface 2: Authority Policy

Authority policy should live in kernel-owned data, not kernel source.

Initial documents:

- `kernel:key_tiers`
- `kernel:write_policy`

These keys remain kernel-owned:

- ordinary act-time cognition may not write them
- ordinary `DR-1` may not write them
- ordinary `DR-2` may not write them directly
- proto-`DR-3` may propose changes to them through governed promotion

Proto-`DR-3` write-path clarification:

- authority-policy changes are **not** written live through `kvWriteGated()`
- in the proto phase they should be materialized as governed deploy artifacts
  such as seeded policy-doc changes and then applied by governor during deploy
- this preserves the rule that `kernel:*` remains `kernel_only` at runtime

### `kernel:key_tiers`

`kernel:key_tiers` defines which key families belong to which trust tier.

Illustrative shape:

```json
{
  "immutable": ["dharma", "patron:public_key"],
  "kernel_only": [
    "karma:*",
    "sealed:*",
    "event:*",
    "event_dead:*",
    "kernel:*",
    "patron:direct"
  ],
  "lifecycle": ["dr:*", "dr2:*", "dr3:*"],
  "protected": [
    "config:*",
    "prompt:*",
    "tool:*",
    "provider:*",
    "channel:*",
    "hook:*",
    "secret:*",
    "code_staging:*",
    "desire:*",
    "pattern:*",
    "principle:*",
    "tactic:*",
    "identification:*",
    "review_note:*"
  ]
}
```

This example still names current userspace families, but now the knowledge
lives in data rather than source.

It is illustrative, not an exhaustive copy of the current seed. Current live
seed data still includes additional protected families and singletons such as
`skill:*`, `task:*`, `contact_platform:*`, `providers`, `wallets`,
`patron:contact`, and `patron:identity_snapshot`.

That is the critical shift:

- rearchitecting userspace changes policy data
- not kernel source

### `kernel:write_policy`

`kernel:write_policy` defines which contexts may perform which operations on
which key families, plus the friction attached to those operations.

Illustrative shape:

```json
{
  "version": 1,
  "rules": [
    {
      "match": "pattern:*",
      "ops": {
        "put": {
          "contexts": ["deep-reflect", "userspace-review"],
          "budget_class": "privileged",
          "requires_deliberation": false
        },
        "patch": {
          "contexts": ["deep-reflect", "userspace-review"],
          "budget_class": "privileged",
          "requires_deliberation": false
        },
        "delete": {
          "contexts": ["deep-reflect", "userspace-review"],
          "budget_class": "privileged",
          "requires_deliberation": false
        },
        "field_merge": {
          "contexts": ["act", "deep-reflect", "userspace-review"],
          "allowed_fields": ["strength"],
          "budget_class": "mechanical",
          "requires_deliberation": false
        }
      }
    },
    {
      "match": "identification:*",
      "ops": {
        "put": {
          "contexts": ["deep-reflect", "userspace-review"],
          "budget_class": "privileged",
          "requires_deliberation": false
        },
        "patch": {
          "contexts": ["deep-reflect", "userspace-review"],
          "budget_class": "privileged",
          "requires_deliberation": false
        },
        "delete": {
          "contexts": ["deep-reflect", "userspace-review"],
          "budget_class": "privileged",
          "requires_deliberation": false
        },
        "field_merge": {
          "contexts": ["act", "deep-reflect", "userspace-review"],
          "allowed_fields": ["last_exercised_at", "last_reviewed_at", "strength"],
          "budget_class": "mechanical",
          "requires_deliberation": false
        }
      }
    },
    {
      "match": "prompt:*",
      "ops": {
        "put": {
          "contexts": ["deep-reflect", "userspace-review"],
          "budget_class": "privileged",
          "requires_deliberation": true,
          "min_deliberation_chars": 200
        },
        "patch": {
          "contexts": ["deep-reflect", "userspace-review"],
          "budget_class": "privileged",
          "requires_deliberation": true,
          "min_deliberation_chars": 200
        }
      }
    }
  ]
}
```

This document is intentionally generic:

- the kernel does not know what a pattern is
- the kernel only knows that for keys matching `pattern:*`, `field_merge` of
  `strength` is allowed in certain contexts

## Surface 3: Userspace

Userspace owns:

- cognitive object schemas
- prompt meanings
- planning and reflection semantics
- seed object meanings
- value semantics of fields
- when a change is cognitively justified

This means:

- `identification:working-body` moves out of kernel and into userspace seed or
  bootstrap logic
- callers clamp or shape values before writing them
- userspace may replace `pattern:*` or `identification:*` entirely without
  forcing a kernel redesign

Explicit migration responsibility:

- once `updatePatternStrength()` is removed, callers must clamp strength into
  the valid `[0, 1]` range before issuing `field_merge`
- the kernel enforces field allowlists, not ontology-specific value ranges

## Single Privileged Write Engine

Keep one privileged write entry point:

- `kvWriteGated(op, context)`

Do **not** create a second special-purpose kernel API for mechanical field
updates.

Instead, extend `kvWriteGated` with one new operation:

- `field_merge`

### Supported operations

For protected keys governed by authority policy:

- `put`
- `delete`
- `patch`
- `field_merge`

For unprotected direct agent-key writes:

- `put`
- `delete`
- `patch`
- `rename`

`rename` already exists in `_kvWriteDirect()` for ordinary agent keys.
V1 does **not** extend authority-policy enforcement to `rename` on protected
keys. Keeping that boundary explicit is simpler than inventing a second
protected rename semantics in the same refactor.

Current gap:

- destination protection is still enforced by `kvWriteSafe()`
- but a blocked destination write currently throws rather than returning a
  clean `{ ok: false }`

V1 requirement:

- normalize `_kvWriteDirect().rename` to return a clean failure result instead
  of leaking a thrown exception when the destination tier blocks the write

### Runtime contexts

`kvWriteGated(op, context)` should continue taking an explicit caller-supplied
context string.

V1 context set:

- `act`
- `reflect`
- `deep-reflect`
- `userspace-review`
- `authority-review`

The kernel should validate that:

- the supplied context is one of the recognized values
- the active policy rule allows that context for the requested operation

The kernel should **not** infer the context from hidden runtime phase.

That keeps the enforcement engine simple:

- callers state intent
- policy decides whether that intent is allowed

Compatibility note:

- current live callers only use `reflect`, `deep-reflect`, and
  `userspace-review`
- adding context validation is therefore a behavior change
- before enabling validation, all live call sites must be audited and updated
  to use only recognized context strings

`reflect`-context authority boundary for v1:

- keep `reflect` limited to agent-tier writes only
- do not grant `reflect` protected-key authority through `kernel:write_policy`

That preserves current behavior. Expanding `reflect` into protected families
would be an authority-widening change and should be treated as such, not as a
compatibility cleanup.

### `budget_class` semantics

`budget_class` is an enforcement property, not documentation.

V1 meaning:

- `privileged`
  - checks `MAX_PRIVILEGED_WRITES`
  - increments `privilegedWriteCount` after a successful write
- `mechanical`
  - does **not** increment `privilegedWriteCount`
  - still records karma/audit
  - is allowed only for explicitly whitelisted operations such as
    `field_merge`

This preserves the key property of the current helper methods:

- fast mechanical updates like pattern-strength or identification-exercised
  writes must not consume the same limited budget as structural prompt/config
  changes

Contact-write decision for v1:

- while `_gateContact()` remains separate, it should use the same
  `privileged` cap semantics
- contact writes count toward the privileged cap
- the current increment-without-precheck asymmetry should be treated as a bug,
  not preserved as intended behavior

### Migration of existing `_gateSystem` friction

Current source already hardcodes three friction rules in `_gateSystem()`:

- `principle:*` requires deliberation
- `prompt:*` requires deliberation
- `config:model_capabilities` requires deliberation

This spec does **not** add a second source of truth for those rules.

Migration rule:

1. mirror these checks into `kernel:write_policy`
2. validate policy-driven enforcement produces the same outcomes
3. remove the hardcoded source checks from `_gateSystem()`

The policy layer becomes authoritative only after step 3.

### `field_merge` semantics

`field_merge` performs a shallow merge of named fields onto an existing object.

Illustrative operation:

```json
{
  "op": "field_merge",
  "key": "pattern:foo",
  "fields": {
    "strength": 0.72
  }
}
```

Kernel responsibilities for `field_merge`:

- confirm the key matches a protected family
- load the relevant rule from `kernel:write_policy`
- confirm the calling context is allowed
- confirm every requested field is in `allowed_fields`
- apply the shallow merge
- record the write in karma
- charge the configured budget class

Kernel should **not**:

- infer semantic ranges for ontology-specific fields
- clamp values because a particular family happens to use `strength`
- interpret the field contents beyond generic shape checks

If the target key does not exist, `field_merge` should fail with
`key_not_found`.

That keeps creation and mutation separate:

- `put` creates
- `field_merge` mutates

### Why `field_merge` instead of more helpers

It replaces:

- `updatePatternStrength()`
- `updateIdentificationLastExercised()`
- future helper proliferation for every new cognitive family

The abstraction becomes:

- generic operation
- data-defined authority
- userspace-defined meaning

## Post-write Infrastructure Hooks

Not every key-family-specific behavior is cognitive leakage.

Two current kernel behaviors are infrastructural and should stay kernel-side in
v1 even after authority policy is introduced:

- alerting on `hook:*` privileged writes
- hot-reloading selected cached `config:*` values after successful writes

These are not ontology semantics. They are runtime-maintenance behavior tied to
code and config surfaces.

Design rule:

- authority policy decides whether the write is allowed
- kernel post-write hooks decide whether any infrastructure maintenance must
  happen after the write succeeds

This keeps the policy refactor focused on authority, not on removing every
useful post-write side effect from kernel.

## Explicitly Deferred Domain Leakage

This refactor is primarily about removing userspace ontology from kernel.

Two remaining source-level leaks are acknowledged but not fully solved here.

### `_gateContact()`

`_gateContact()` encodes approval rules and patron-trust semantics for
`contact:*` and `contact_platform:*`.

That is real domain knowledge, but it is a different domain than cognitive
ontology:

- approval rules
- patron-only actions
- binding integrity

V1 decision:

- keep `_gateContact()` in kernel
- do not fold contact policy into the same refactor as cognitive family
  removal
- align `_gateContact()` to the same privileged-cap precheck used by other
  privileged writes

Rationale:

- contact approval is part of the patron trust boundary
- mixing it into the first authority-policy refactor would enlarge scope too
  much and obscure the cognitive-boundary cleanup

Follow-on direction:

- a later constitutional refactor may move this into a dedicated
  `kernel:contact_policy` or broader trust-policy layer

### Pattern key format validation

Current `kvWriteGated()` rejects malformed `pattern:*` keys that use `/`
instead of `:`.

That is ontology-specific validation in kernel source.

V1 decision:

- treat this as a known remaining leak
- remove it once the callers and policy-driven migration no longer depend on
  pattern-specific emergency guarding

It should not survive as permanent kernel knowledge.

## Fail-Closed Behavior

The kernel must not silently become permissive when policy documents are
missing.

### Bootstrap fallback

Kernel source may keep a minimal bootstrap fallback policy, but it should be:

- infrastructural
- conservative
- explicitly secondary to loaded policy

Recommended behavior:

1. load `kernel:key_tiers`
2. load `kernel:write_policy`
3. if either is missing or invalid:
   - keep lifecycle and kernel-only protections active
   - deny protected `field_merge`
   - deny any privileged write whose authorization depends on missing policy
   - emit a kernel-level audit event

This is safer than synthesizing permissive defaults in code.

## Removals From Kernel

These should be removed from `kernel.js`:

- `ensureIdentitySeed()`
- `updatePatternStrength()`
- `updateIdentificationLastExercised()`

These should also stop being primary source-of-truth in kernel source:

- ontology-specific entries in `DEFAULT_KEY_TIERS`

Recommended replacement:

- rename `DEFAULT_KEY_TIERS` to something like `BOOTSTRAP_KEY_TIERS`
- reduce it to infrastructural fallback only
- move full policy into seeded `kernel:key_tiers`

## Seed Ownership

Seed ownership should follow meaning, not convenience.

### Move out of kernel

- `identification:working-body`

This seed should be created by:

- repo/bootstrap seeding, explicitly including `identification:working-body`
- or explicit userspace bootstrap logic

It should not be created by kernel boot code.

### Why

The question "what is the working body?" belongs to cognition, not
enforcement.

Changing it later should require:

- userspace review
- or authority review if it affects legitimacy boundaries

But it should not require a kernel change just because the seed wording or
ontology changes.

## DR Role Boundary After Refactor

## DR-1: Operational Review

Unchanged in spirit.

`DR-1` continues to:

- detect divergences
- update first-order cognitive state inside the current architecture
- emit `review_note:*` when the issue is structural

`DR-1` does **not** change authority policy.

## DR-2: Userspace Review

`DR-2` continues to own:

- userspace prompt changes
- userspace config changes
- userspace code changes
- low-risk state migrations under the current authority model

`DR-2` may diagnose authority problems, but if the fix requires changing:

- `kernel:key_tiers`
- `kernel:write_policy`
- kernel enforcement semantics

then `DR-2` must escalate to proto-`DR-3`.

### Escalation criterion

Escalate when the smallest correct fix would change:

- who may write what
- under which context
- with which required deliberation
- with which budget class
- or which key family belongs to which trust tier

That is not ordinary userspace repair. That is constitutional repair.

## Proto-DR-3: Authority Review

Proto-`DR-3` is the first concrete runtime instantiation of role-3 review.

Its scope is intentionally narrow:

- authority policy
- kernel enforcement invariants
- boundary-changing migration plans

It is **not** yet a freeform architecture-research engine for all possible
ontology changes.

### Core question

Does the current authority model itself need to change?

### Inputs

- repeated `DR-2` findings that hit the same boundary
- explicit review notes targeting authority review
- current `kernel:key_tiers`
- current `kernel:write_policy`
- kernel source bundle
- userspace source bundle where the pressure shows up
- validation history of prior authority changes

### Outputs

- authority findings
- proposed policy changes
- required invariant checks
- classification of authority effect:
  - `no_authority_change`
  - `authority_narrowing`
  - `authority_widening`
  - `policy_refactor_only`
- migration plan
- promotion recommendation

### Trigger surface

Add a distinct review target:

- `target_review: "authority_review"`

This keeps the bridge explicit:

- `review_note:userspace_review:*` feeds `DR-2`
- `review_note:authority_review:*` feeds proto-`DR-3`

`DR-2` may also emit an authority-review request directly when its final
diagnosis says the fix belongs in the boundary model, not userspace.

### Dispatch model

Proto-`DR-3` should begin as a stricter mode of the existing lab path, not as
an always-on new scheduler.

V1 dispatch:

- human-triggered
- or explicit `DR-2` escalation from a completed userspace review

V1 does **not** require a permanent always-on `dr3:state:*` machine.

If the constitutional path proves useful and stable, it can later gain:

- `dr3:state:1`
- `dr3:result:{generation}`

But that should be a second step, not part of the first proto rollout.

### Cadence

Proto-`DR-3` should **not** run on normal live cadence.

V1 trigger policy:

- explicit human request
- or a `DR-2` escalation with high confidence
- or repeated recurrence of the same authority-bound finding

This keeps constitutional review rare and deliberate.

## Proto-DR-3 Validation Standard

Authority changes are stricter than ordinary userspace changes.

V1 should require:

1. multi-model review
2. adversarial challenge
3. explicit authority-diff classification
4. invariant test suite
5. governor-backed deployment
6. post-deploy behavioral regression

### Convergence rule

Proto-`DR-3` should not stop at "one model proposed something plausible".

Minimum convergence path:

1. primary review model proposes the change
2. adversarial model challenges it
3. primary model revises
4. adversarial model either:
   - passes it
   - or names a remaining blocking flaw

This is stricter than ordinary `DR-2`, but it should reuse the same general
lab machinery with a stricter config/profile, not invent a second independent
lab runtime.

### Additional proto-`DR-3` checks

Before staging an authority-policy change, the system must also compute:

- whether the diff widens authority
- whether it narrows authority
- whether it only refactors representation without changing authority

Recommended rule for proto phase:

- `no_authority_change` or `policy_refactor_only`
  - may proceed after convergence and invariant pass
- `authority_narrowing`
  - may proceed after convergence and invariant pass
- `authority_widening`
  - requires explicit elevated approval in proto phase

That elevated approval may initially be:

- patron approval
- or a later stronger autonomous policy once the system has earned it

Proto-`DR-3` should begin conservatively.

## Invariants

Proto-`DR-3` must validate invariants that ordinary `DR-2` does not need.

Required invariants:

1. Lifecycle keys remain runtime-owned.
2. `kernel:*` remains non-agent-writable outside the constitutional path.
3. Missing or invalid policy fails closed.
4. A userspace-only patch cannot silently widen authority.
5. `field_merge` never bypasses key-tier checks.
6. Allowed fields for `field_merge` come from policy, not kernel source.
7. Kernel source does not regain ontology-specific helper methods.
8. Seed creation for cognitive objects remains outside kernel.

The invariant suite should become an explicit test target, not a prose hope.

## Migration Plan

## Stage 1: Add `kernel:write_policy`

Keep the existing seeded `kernel:key_tiers`.

Add and seed:

- `kernel:write_policy`

Do not yet remove:

- existing helper methods
- hardcoded `_gateSystem()` deliberation checks

Goal:

- establish `kernel:write_policy` as a real runtime object without changing
  behavior yet

## Stage 2: Add `field_merge` to `kvWriteGated`

Extend the existing write engine.

Goal:

- make the generic replacement primitive available before helper removal
- audit all live `kvWriteGated()` callers and add explicit context validation
  for `act` and `authority-review` without breaking current
  `reflect` / `deep-reflect` / `userspace-review` callers
- map existing `_gateSystem()` deliberation rules into policy with parity tests
- add `field_merge` key-not-found failure semantics
- normalize direct `rename` failure handling to return clean blocked-write
  results rather than thrown exceptions
- fix `_gateContact()` privileged-cap precheck so contact writes follow the
  same cap semantics as other privileged writes
- add baseline unit tests for current `updatePatternStrength()` behavior before
  migrating callers away from it

## Stage 3: Move helper call sites to `field_merge`

Replace:

- `K.updatePatternStrength(...)`
- `K.updateIdentificationLastExercised(...)`

with:

- `K.kvWriteGated({ op: "field_merge", ... }, context)`

Goal:

- prove helper methods are no longer needed
- prove `mechanical` budget behavior preserves the current no-budget property
  of helper-based field updates
- replace the currently broken identification exercise no-op with a real
  `field_merge` write path
- make caller-side clamping of pattern strength explicit and tested before
  deleting the kernel helper

## Stage 4: Remove ontology-specific kernel helpers

Delete:

- `updatePatternStrength()`
- `updateIdentificationLastExercised()`

Goal:

- remove ontology-specific mutation logic from kernel
- remove hardcoded `_gateSystem()` deliberation checks now that policy rules
  are authoritative

## Stage 5: Move seed ownership out of kernel

Delete:

- `ensureIdentitySeed()`

Seed `identification:working-body` from:

- `scripts/seed-local-kv.mjs`
- or explicit userspace bootstrap

Goal:

- remove ontology-specific cognitive creation from kernel

## Stage 6: Reduce kernel fallback tiers to infrastructural only

Shrink bootstrap defaults and rely on `kernel:key_tiers` as the full source of
truth.

Goal:

- kernel source no longer carries userspace families as primary policy

## Stage 6.5: Clean up acknowledged remaining leaks

Address, in this order:

- pattern-specific key-format validation
- contact/trust policy extraction, if still justified after the core refactor

Goal:

- finish the transition from "kernel knows some current userspace details" to
  "kernel enforces policy and trust invariants generically"

## Stage 7: Introduce proto-`DR-3` authority-review path

Add:

- `authority_review` target
- `dr3:*` to the lifecycle tier
- stricter lab validation for policy changes

Goal:

- governed evolution of the authority model itself without yet introducing a
  fully automated DR-3 scheduler

## Testing And Validation

The refactor should be judged at four layers.

### 1. Unit-level enforcement tests

Test:

- key-tier matching from policy docs
- `field_merge` authorization by context and field
- fail-closed behavior when policy is missing
- rejection of lifecycle writes through ordinary cognition

### 2. Migration compatibility tests

Test:

- current `pattern` strength updates still work through `field_merge`
- current identification exercise tracking still works through `field_merge`
- seeded identity still exists after kernel seed removal

### 3. Review-path tests

Test:

- `DR-2` escalates authority changes instead of trying to patch them as
  userspace changes
- proto-`DR-3` computes authority-diff classification correctly
- widening changes are blocked without elevated approval

### 4. Behavioral regression

After any proto-`DR-3` governor deployment:

- run a full 30-cycle dev-loop regression
- compare against the current accepted baseline
- inspect new review notes
- reject and roll back if exploratory behavior or other key capabilities
  collapse

## Why This Is The Elegant Answer

It preserves the clean split:

- kernel owns enforcement
- policy owns authority description
- userspace owns meaning

And it avoids both bad extremes:

- hardcoding ontology in kernel source
- letting userspace unilaterally rewrite its own constraints

The system remains self-modifiable, but in layers:

- userspace can evolve through `DR-2`
- the authority model can evolve through proto-`DR-3`
- the kernel remains the thin engine that enforces whichever authority model
  has been validly installed

## Bottom Line

The target state is:

- one generic kernel write engine
- authority rules in kernel-owned policy data
- no ontology-specific helper methods in kernel
- no ontology-specific seed creation in kernel
- a proto-`DR-3` path for constitutional self-modification

That is the smallest architecture that:

- removes cognitive leakage from kernel
- preserves enforceable boundaries
- and still allows the system to evolve its own constitution under stronger
  review
