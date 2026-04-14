# KV Operation Boundary Implementation Plan

## Goal

Implement the [KV operation boundary design](./2026-04-14-kv-operation-boundary-design.md)
for `#32` in a way that:

- fixes the immediate reflect/deep-reflect malformed-op failure mode
- moves the runtime toward a shared schema architecture rather than a
  KV-only validation island
- avoids papering over contract drift with runtime normalization

The target outcome is:

- model-produced `kv_operations` are either canonical and schema-valid
- or they are rejected before any write attempt

with useful telemetry and no silent repair.

## Implementation stance

Prefer a small number of strong abstractions:

1. one shared runtime schema helper layer
2. one KV-operation boundary module
3. one source-owned allowlist map
4. one architecture test guarding the sanctioned write paths

Avoid:

- caller-local normalization code
- bespoke validation logic spread across reflect, userspace, and review code
- prompt-only fixes without runtime enforcement
- broad validator frameworks for what should be schema checks

## Core implementation decisions

### 1. Add a shared runtime schema helper first

Do not build a private validation mini-framework directly inside
`lib/kv-operation-boundary.js`.

Create a small shared helper, e.g.:

- `lib/runtime-validation.js`

This helper should own:

- schema loading / compilation
- cached validators
- a uniform error shape

It should be usable later by other runtime boundaries, not just KV ops.

### 2. Use JSON Schema + Ajv for the boundary schemas

There is no shared runtime schema library in the repo yet. The current schema
usage is narrow and review-focused.

For this rollout:

- add `ajv` as a runtime dependency
- keep Ajv hidden behind `lib/runtime-validation.js`

Do not couple callers directly to Ajv APIs.

If Ajv proves too heavy for the Worker bundle, keep the same helper API and
swap the implementation behind it:

- precompiled validators
- or a lighter JSON Schema-compatible validator

Do not bypass the shared helper just to avoid the dependency.

### 3. Keep the boundary strict-reject

Do not implement runtime normalization.

The boundary should:

- parse/extract only recognized own-properties
- validate strict canonical shape
- reject the whole batch if any op is malformed
- emit diagnostic hints without changing execution

This is important both for correctness now and for clean future training
traces.

### 4. Treat `field_merge` as mechanical only

In v1:

- `field_merge` is not allowed from `deep-reflect`
- `field_merge` stays available for:
  - `act`
  - review-driven paths where policy already allows it

Deep-reflect uses:

- `put`
- `delete`
- `patch`

only.

### 5. Make source allowlists explicit and fail closed

Define one mapping inside the boundary module, e.g.:

- `SOURCE_ALLOWED_OPS`

Unknown sources must fail closed:

- reject the batch
- emit boundary telemetry
- perform no write attempts

Do not fall back to a permissive default.

### 6. Batch-schema failure is atomic at the boundary

If any op in a model-produced batch fails boundary validation:

- reject the full batch
- persist the reflect/review output itself
- emit schema rejection telemetry
- do not attempt any KV writes from that batch

This avoids half-applying a malformed contract surface.

### 7. Keep kernel authorization unchanged

The boundary is not allowed to absorb:

- write-policy rules
- deliberation requirements
- protected-key authorization
- existing-value semantics

Those remain in:

- `kvWriteGated(...)`

The boundary owns shape and source-surface contract validity, not policy.

## New shared modules and schema files

### New modules

- `lib/runtime-validation.js`
- `lib/kv-operation-boundary.js`

### New schemas

These should live under the existing `schemas/` tree so they become part of
the broader runtime-schema footprint.

Recommended initial set:

- `schemas/kv-operation.schema.json`
- `schemas/kv-operation-batch.schema.json`
- `schemas/experience-record.schema.json`

If needed for clarity, a small subfolder is fine:

- `schemas/runtime/kv-operation.schema.json`
- `schemas/runtime/kv-operation-batch.schema.json`
- `schemas/runtime/experience-record.schema.json`

The exact path matters less than keeping them in the shared schema tree and
making them consumable through one helper.

## Real integration points

The plan must cover all current model-produced KV-op write paths:

1. session reflect write loop inside
   [executeReflect()](/home/swami/swayambhu/repo/reflect.js:71)

2. deep-reflect write loop inside
   [applyReflectOutput()](/home/swami/swayambhu/repo/reflect.js:461)

3. DR2 validated changes inside
   [applyDr2ValidatedChanges()](/home/swami/swayambhu/repo/userspace.js:2565)

4. DR apply / deep-reflect result application inside
   [applyDrResults()](/home/swami/swayambhu/repo/userspace.js:2805)

If any of these remain raw `kvWriteGated(...)` loops over model-produced
`kv_operations`, the rollout is incomplete.

## Phase plan

### Phase 1: Shared runtime validation foundation

#### Files

- `package.json`
- `package-lock.json`
- `lib/runtime-validation.js` (new)
- `schemas/kv-operation.schema.json` (new)
- `schemas/kv-operation-batch.schema.json` (new)
- `schemas/experience-record.schema.json` (new)
- `tests/schema.test.js`
- `tests/runtime-validation.test.js` (new)

#### Work

1. Add `ajv` as a dependency.

2. Create `lib/runtime-validation.js` with:

- cached schema compilation
- `validateWithSchema(schemaName, value)`
- consistent return shape:
  - `{ ok: true, value }`
  - `{ ok: false, error, details }`

3. Move the initial KV-op contract into real shared schemas:

- op item shape
- op batch shape
- experience record shape

4. Convert `tests/schema.test.js` away from test-only handwritten shape
checks for the migrated objects and toward the shared schema helpers where
practical.

#### Important simplification

Do not attempt to generalize the whole runtime schema system in Phase 1.

The goal is:

- one real shared schema helper
- one real runtime consumer set

not a full `#27` implementation.

### Phase 2: KV-operation boundary module and early guardrails

#### Files

- `lib/kv-operation-boundary.js` (new)
- `lib/runtime-validation.js`
- `schemas/kv-operation.schema.json`
- `schemas/kv-operation-batch.schema.json`
- `schemas/experience-record.schema.json`
- `tests/kv-operation-boundary.test.js` (new)
- `tests/architecture-boundaries.test.js`

#### Work

1. Create `applyModelKvOperations(K, rawOps, options)` as the only
production entry point.

2. Add the first regression tests before wiring callers:

- reject `operation` instead of `op`
- reject `set` instead of `put`
- reject unknown sources
- reject non-object batch members
- reject batch-size overflow
- reject `field_merge` from `deep-reflect`

3. Implement the strict boundary flow:

- empty/null batch -> no-op success
- non-array batch -> reject batch
- batch size over cap -> reject batch
- any non-plain-object element -> reject batch
- extract recognized own-properties only
- validate each candidate against shared schemas
- fail closed on any schema rejection

4. Add one explicit source map:

- `SOURCE_ALLOWED_OPS`

with v1 policy:

- `reflect` -> `put`, `delete`, `patch`
- `deep-reflect` -> `put`, `delete`, `patch`
- `userspace-review` -> allowed validated-change subset
- `authority-review` or equivalent review path -> allowed validated-change
  subset

5. Implement diagnostic hint classification without normalization.

Examples:

- `operation` instead of `op`
- `set` instead of `put`

Hints are telemetry only.

6. Keep custom validators minimal.

The only v1 custom validator that should exist here is the one that cannot
be handled cleanly via shared schema and source allowlists.

The `experience:*` duplicate ad hoc checks should migrate to:

- schema-backed validation of the `value` shape for `put` operations on
  `experience:*`

7. Decide `toPrivilegedOp(...)` ownership now.

`userspace.js` currently wraps some review/deep-reflect ops through
`toPrivilegedOp(...)`.

The boundary module should absorb this responsibility for model-produced
privileged writes so callers do not keep separate pre-write mutation logic.

That means:

- callers pass raw model-produced ops
- `applyModelKvOperations(...)` handles any required privileged-shape
  adaptation consistently before `kvWriteGated(...)`

Do not leave `toPrivilegedOp(...)` half-inside callers and half-inside the
boundary.

8. Return one structured result that callers can log consistently, e.g.:

- `accepted`
- `rejected`
- `batchRejected`
- `writeBlocked`

The exact field names can vary, but the distinction between:

- schema rejection
- authorization/policy rejection

must remain explicit.

9. Land the architecture guardrail in the same phase.

Do not wait until cleanup.

Add an early test that guards the known model-produced KV-op paths against
reintroducing raw `kvWriteGated(...)` loops.

### Phase 3: Migrate all model-produced KV-op callers

#### Files

- `reflect.js`
- `userspace.js`
- `tests/reflect.test.js`
- `tests/userspace.test.js`

#### Work

1. Replace the raw loop in session reflect with `applyModelKvOperations(...)`.

2. Replace the raw loop in deep-reflect with `applyModelKvOperations(...)`.

3. Replace DR2 validated-change application with the boundary module.

Because DR2 output is also model-produced structured data, it should not be
an exception.

4. Replace DR apply / deep-reflect result KV writes with the same boundary.

5. Resolve caller-side key-prefix filtering explicitly.

`applyDrResults()` currently filters candidate ops by allowed key prefixes
before writing them.

Keep this ownership split:

- caller keeps semantic selection of which model-produced ops are even in
  scope for that path
- boundary validates shape, source allowlist, and schema
- kernel enforces authorization/policy

Do not move caller-specific semantic filtering into the generic boundary
module.

6. Remove the duplicated inline `experience_schema_rejected` checks from:

- session reflect
- deep-reflect
- userspace deep-reflect apply path

Those checks should now flow through the shared boundary and shared schema.

#### Important nuance

The boundary should be used only for model-produced `kv_operations`.

Do not route direct runtime-authored writes that are already canonical and
not model-produced through this helper unless there is a specific reason.

### Phase 4: Telemetry and prompt tightening

#### Files

- `prompts/reflect.md`
- `prompts/deep_reflect.md`
- `tests/kv-operation-boundary.test.js`
- `tests/reflect.test.js`
- `tests/userspace.test.js`

#### Work

1. Add first-class telemetry for:

- `kv_operation_schema_rejected`
- `kv_operation_batch_rejected`
- any diagnostic hint classification used for debugging

2. Tighten `prompt:reflect` to include explicit canonical KV-op examples.

3. Confirm `prompt:deep_reflect` examples remain canonical and do not mention
`field_merge` as a deep-reflect op.

4. Add any remaining regression tests not needed to bootstrap Phase 2,
including:

- reject `operation` instead of `op`
- reject `set` instead of `put`
- reject unknown sources
- reject non-object batch members
- reject batch-size overflow
- reject `field_merge` from `deep-reflect`
- preserve reflect output when KV-op batch is rejected
- pass canonical valid batches through to `kvWriteGated(...)`

### Phase 5: Cleanup and convergence with the broader schema layer

#### Files

- `reflect.js`
- `userspace.js`
- `tests/schema.test.js`
- any schema/validation docs touched by the rollout

#### Work

1. Remove any now-dead caller-local comments or assumptions that imply:

- "JSON parse success is enough"
- "malformed ops will be tolerated"

2. Remove any leftover bespoke schema checks that are now covered by the
shared schema helper.

3. Make sure test coverage uses the shared runtime schema layer rather than
drifting back to test-only handwritten validators for the same contract.

4. Document the boundary as one concrete consumer of the broader shared
runtime-schema direction, not as a one-off subsystem.

## Validation strategy

The rollout should be considered complete only if all of the following pass:

- targeted unit tests for `lib/runtime-validation.js`
- targeted unit tests for `lib/kv-operation-boundary.js`
- updated `tests/reflect.test.js`
- updated `tests/userspace.test.js`
- updated `tests/architecture-boundaries.test.js`
- `node --check` on changed runtime files

If the shared schema helper introduces bundle or runtime issues in the Worker
environment, fix that in the helper layer rather than bypassing the boundary
design.

The rollout should not be deployed in a mixed state where some
model-produced KV-op paths are boundary-protected and others still write raw
ops. Land the caller migrations and architecture guard in the same release
slice.

If the boundary rollout causes unexpected production breakage, the rollback
plan is:

1. revert the release slice as a whole
2. do not re-enable raw caller-local normalization or bespoke write loops
3. fix the shared helper / boundary module off the hot path

Rollback should preserve the architectural direction rather than reintroduce
multiple competing write paths.

## What this plan deliberately does not do

- implement the whole broader boundary-schema program from `#27`
- add TypeScript
- redesign kernel write policy
- make malformed KV-op batches partially succeed
- introduce runtime normalization as a compatibility layer

## Success criteria

1. No model-produced KV-op path can reach `kvWriteGated(...)` without
   passing through `applyModelKvOperations(...)`.
2. `operation: "set"`-style near misses are rejected, not normalized.
3. Schema-invalid batches produce no write attempts.
4. Canonical valid batches still write successfully.
5. `deep-reflect` cannot emit `field_merge` in v1.
6. The runtime now has one real shared schema helper that later boundary
   work can reuse.
