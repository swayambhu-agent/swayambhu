# KV Operation Boundary Design

## Summary

Fix `#32` by introducing one canonical boundary for all model-produced
`kv_operations` before they reach `K.kvWriteGated(...)`.

The boundary should do three things:

1. validate only the canonical KV operation shape
2. reject malformed operations before any write attempt
3. emit first-class telemetry for rejected operations, including diagnostic
   hints when a malformed op was trivially recognizable

The core rules are:

- only canonical KV operations may cross into the kernel write gate
- no caller may hand raw model-produced `kv_operations` directly to
  `kvWriteGated(...)`

This should replace the current behavior where session reflect and
deep-reflect pass raw model output directly into `kvWriteGated(...)`.

This boundary should be understood as one slice of a broader runtime-schema
architecture:

- shared runtime schemas for high-value KV entities
- shared schemas for structured LLM outputs
- shared schemas for event, communication, tool, provider, and channel
  payloads
- one validation layer reused across those boundaries

This document covers only the `kv_operations` boundary, but it should be
implemented in a way that fits that broader shared-schema direction rather
than creating an isolated validation island.

## Problem

The production failure behind `#32` happened because session reflect emitted
a syntactically valid JSON object that was not a valid KV operation for the
kernel contract:

```json
{ "operation": "set", "key": "reflection:2026-04-14-session20", "value": {...} }
```

The kernel expects:

```json
{ "op": "put", "key": "reflection:2026-04-14-session20", "value": {...} }
```

Because raw `kv_operations` are currently passed through with no canonical
normalization or shape validation, the write reached `_kvWriteDirect(...)`
with `op.op === undefined`, producing:

- `Unknown op: undefined`

This was not an authorization error. It was a malformed-operation error that
the runtime discovered too late.

## Root cause

### 1. The write contract is implicit instead of enforced

The kernel has a strict KV operation contract:

- canonical op field: `op`
- canonical op names: `put`, `delete`, `patch`, `rename`, `field_merge`

But session reflect and deep-reflect do not enforce that contract at their
boundary.

### 2. Session reflect prompt underspecifies the object shape

The session reflect prompt states that supported ops are `put`, `delete`,
and `patch`, but it does not show concrete KV operation examples using the
canonical `op` field.

That makes generic CRUD-shaped outputs such as:

- `operation: "set"`

more likely.

### 3. JSON parsing is treated as sufficient validation

`runAgentLoop(...)` currently validates only:

- "did the model return parseable JSON?"

It does not validate:

- "does `kv_operations` match the runtime KV-operation contract?"

### 4. Error handling is too late and too coarse

The malformed operation is only discovered when `kvWriteGated(...)` tries to
execute it. By that point:

- the reflect pass is already over
- the error is surfaced as a blocked write, not as a schema-contract failure

## Design principles

1. One canonical contract for all model-produced KV operations.
2. One shared execution helper, not just one shared parser.
3. Strict at the boundary, strict at the kernel.
4. Do not silently repair malformed model output at runtime.
5. Do not hide drift silently; schema rejection must be observable.
6. Do not duplicate contract logic in reflect, deep-reflect, review, and
   lab code.
7. Keep authorization and write-policy logic in the kernel; do not move it
   into the boundary module.
8. Reject malformed operations before any write attempt.
9. Fail the batch closed on schema rejection.
10. Prefer shared runtime schemas over bespoke hand-written validators
    wherever the rule is schema-shaped.

## Proposed abstraction

Introduce one shared module:

- `lib/kv-operation-boundary.js`

Its job is to be the only sanctioned bridge from:

- raw model-produced `kv_operations`

to:

- canonical kernel-consumable KV operations
- telemetry
- controlled write execution

Use one high-level helper:

- `applyModelKvOperations(K, rawOps, options)`

Optional lower-level helpers may exist for testing:

- `prepareModelKvOperations(rawOps, options)`
- `classifyKvOperationSchemaError(rawOp, options)`

But production callers should use `applyModelKvOperations(...)`, not open-code
their own loop over prepared operations.

This boundary module should depend on the shared runtime validation layer.
It should not define a private parallel validation framework if the runtime
already has common schema compilation and validation helpers.

`applyModelKvOperations(...)` should be the only path used by:

- session reflect
- deep-reflect
- userspace review / DR2 validated changes
- authority review / DR3 validated changes
- any future model-produced `kv_operations` payload

## Canonical KV operation contract

Canonical operation shape:

```json
{
  "op": "put|delete|patch|field_merge",
  "key": "string",
  "value": "any",
  "old_string": "string",
  "new_string": "string",
  "fields": {},
  "metadata": {},
  "deliberation": "string"
}
```

Not every field is valid for every op.

This is the canonical shape for model-produced KV operations.

It does not need to expose every kernel-internal op.

In particular:

- `rename` remains kernel capability, but is not part of the LLM-facing
  boundary contract in v1

### Required fields by op

- `put`
  - requires: `op`, `key`, `value`

- `delete`
  - requires: `op`, `key`

- `patch`
  - requires: `op`, `key`, `old_string`, `new_string`

- `field_merge`
  - requires: `op`, `key`, `fields`

The boundary module validates this shape before any write attempt.

The preferred implementation is:

- validate the canonical shape with shared runtime schemas
- run only minimal custom checks for rules that are not naturally
  schema-shaped

### Optional fields

- `metadata`
  - optional
  - if present, must be a plain JSON object
  - passed through unchanged

- `deliberation`
  - optional
  - if present, must be a string
  - passed through unchanged

## Rejection semantics

This boundary should not normalize malformed operations into canonical ones.

Examples such as:

- `operation` instead of `op`
- `set` instead of `put`

should still be rejected as schema-invalid.

The boundary may attach a diagnostic hint saying a malformed op looked
trivially recognizable, but that hint is for telemetry only. It must not
change execution behavior.

Why strict reject is preferred:

- it keeps the runtime contract crisp
- it avoids teaching models that near-miss shapes are acceptable
- it produces cleaner traces for later model training
- it prevents normalization logic from becoming a creeping synonym table

## Validation stages

`applyModelKvOperations(K, rawOps, options)` should run in this order:

### 1. Container validation

Validate that `rawOps` is:

- absent / null -> treated as empty
- an array -> continue
- anything else -> reject the whole container as a schema error

The boundary should also impose a small sanity cap on batch size, e.g.:

- `MAX_MODEL_KV_OPS_PER_BATCH = 50`

If the batch exceeds that cap, the entire batch is rejected.
It must not be truncated.

Within an array, every element must be a plain JSON object.

If any element is:

- `null`
- an array
- a scalar
- a non-plain object

the whole batch is schema-rejected and no write attempt occurs.

### 2. Per-op extraction

For each raw op:

- copy the original for telemetry
- construct one candidate using only recognized own-properties

Do not spread raw objects blindly. This avoids accidental acceptance of:

- inherited properties
- `__proto__`
- `constructor`

Only recognized fields should be copied into the canonical candidate.

### 3. Base shape validation

Validate:

- canonical `op` exists exactly as `op`
- `key` exists and is a non-empty string
- op-specific required fields are present
- fields irrelevant to the op are ignored, not interpreted

Basic key-structure validation should also reject obvious malformed keys:

- control characters
- embedded newlines
- empty prefix segment
- empty suffix segment for colon-scoped keys

This is not a replacement for kernel tier policy. It is only a first-pass
structural sanity check.

### 4. Surface-specific op allowlist

The boundary should derive op allowlists from `source`, not from arbitrary
per-caller configuration.

Define the mapping in one place inside the boundary module, e.g.:

- `SOURCE_ALLOWED_OPS`

If `source` is not registered in that mapping, the boundary must fail closed:

- reject the batch as schema-invalid
- emit a boundary error noting the unknown source
- perform no write attempts

Example:

- session reflect:
  - `put`, `delete`, `patch`

- deep-reflect:
  - `put`, `delete`, `patch`

- review surfaces:
  - the approved review-time subset, including `field_merge` where policy
    allows it

This prevents a model from emitting a syntactically valid but out-of-scope
operation for a surface that never asked for it.

### 5. Semantic validators

After structural extraction, validation should be primarily schema-driven.

The intended layering is:

1. shared runtime schemas validate container shape and per-op shape
2. shared schemas validate value shapes where appropriate
3. a small validator pipeline handles the remaining dynamic rules

The boundary may support a small validator pipeline:

- `validators: [fn1, fn2, ...]`

This is where key-specific semantics belong, such as:

- `experience:*` schema requirements

In the broader runtime-schema architecture, many of these checks should move
out of ad hoc code and into shared schemas referenced by this boundary.

That lets the runtime remove duplicated ad hoc checks from:

- `reflect.js`
- `deep-reflect`
- any future surface that consumes the same operation family

Validator contract in v1:

- async or sync is allowed
- input:
  - `{ op, source }`
- output:
  - `{ ok: true, op? }`
  - or `{ ok: false, error }`

Validators must be side-effect free.

Validators compose in declared order, and each validator sees the cumulative
refined op returned by the previous validator.

They may:

- reject
- or return a refined canonical op

They may not:

- write to KV
- call tools
- depend on hidden global state

Validator refinement must not change:

- `op`
- `key`

Validators may refine only payload fields such as:

- `value`
- `fields`
- `metadata`
- `deliberation`

Stateful authorization and existing-value checks remain in the kernel.

`field_merge` should be treated as a mechanical refinement op, not a
deep-reflect cognition op.

So in v1:

- `field_merge` is not exposed to deep-reflect
- `field_merge` remains available only in:
  - `act`, where write policy already allows narrow mechanical updates
  - review-driven surfaces, where tightly scoped corrections are appropriate

If deep-reflect needs to change a protected object, it should do so through
the existing canonical object-writing path (`put`, `patch`, or `delete`) that
already fits its generative/structural role.

So the intended split is:

- schemas:
  - object shape
  - per-op required fields
  - plain-object constraints
  - value-shape checks that can be expressed declaratively

- custom validators:
  - source-specific allowlist checks
  - dynamic rules awkward to encode declaratively
  - rules that depend on local boundary options, not on kernel state

### 6. Output partitioning

Return:

- `accepted`
- `rejected`

Example shape:

```json
{
  "accepted": [{ "op": "put", "key": "workspace:x", "value": {} }],
  "rejected": [
    {
      "raw": { "operation": "merge", "key": "x" },
      "error": "Unsupported op alias: merge",
      "stage": "schema",
      "diagnostic_hint": "Expected canonical field 'op' and a supported canonical op name"
    }
  ]
}
```

If any op is schema-rejected at stages 1-5:

- the entire batch is rejected
- no KV write attempts occur for that batch
- the reflect or review output itself still persists

This avoids half-applying a logically related model-produced batch when the
contract itself is malformed.

## Integration points

### Session reflect

Replace raw iteration over `output.kv_operations` with:

- `applyModelKvOperations(K, output.kv_operations, { source: "reflect", validators: [...] })`

### Deep-reflect

Use exactly the same boundary module and pattern as session reflect.

### Review-driven writes

Any path that consumes model-produced `kv_operations` should use the same
boundary module before calling `kvWriteGated(...)`.

As the broader runtime-schema layer grows, this boundary should consume the
same shared compiled schemas and validation helpers used elsewhere in the
runtime, rather than preserving a bespoke KV-only validation stack.

This keeps the contract uniform across:

- reflect
- deep-reflect
- userspace review
- authority review

## Telemetry

Add first-class karma events:

- `kv_operation_schema_rejected`
  - source
  - raw_op_excerpt
  - stage
  - error
  - diagnostic_hint?

- `kv_operation_batch_rejected`
  - source
  - rejected_count
  - first_error

Retain existing:

- `kv_writes_blocked`

But after this change, `kv_writes_blocked` should mean:

- a canonical operation was blocked by authorization or write policy

It should no longer be the primary signal for malformed KV op shape.

### Diagnostic hints

Rejected ops may include non-authoritative hints such as:

- `expected field 'op' but found 'operation'`
- `unsupported op 'set'; canonical op is probably 'put'`

These hints are for:

- debugging
- prompt refinement
- later training data analysis

They must not alter runtime execution.

## Prompt contract changes

### Session reflect

Strengthen `prompt:reflect` so `kv_operations` includes explicit examples
using the canonical `op` field.

The examples should match the actual runtime contract exactly:

```json
{ "op": "put", "key": "workspace:cyclic-cosmology", "value": { "status": "in_progress" } }
{ "op": "delete", "key": "workspace:stale-note" }
{ "op": "patch", "key": "workspace:journal", "old_string": "old", "new_string": "new" }
```

### Deep-reflect

Keep the explicit examples already present, but ensure they are described as
the canonical form shared by all KV-operation-producing surfaces.

## Failure semantics

Malformed KV operations should not fail the entire reflect pass.

Instead:

- the reflect output itself is still persisted
- malformed KV-operation batches are rejected as a unit
- the rejection is recorded as a schema error, not a write-policy error

This preserves useful reflective output while preventing malformed writes.

### Authorization failures after schema validation

Once a batch passes schema preparation, individual writes may still be
blocked by kernel authorization or policy.

That remains kernel behavior and is surfaced via:

- `kv_writes_blocked`

This design does not attempt to add cross-key transactions or rollback.
Its scope is:

- canonical shape enforcement
- boundary telemetry
- preventing malformed KV operations from reaching the kernel

## Why this is the smallest robust solution

This design avoids three bad alternatives:

### 1. Ad hoc alias handling in `reflect.js`

Bad because:

- it fixes session reflect only
- deep-reflect and review paths stay vulnerable
- logic duplicates immediately

### 2. Relaxing the kernel to accept arbitrary op synonyms

Bad because:

- it pushes model sloppiness into the kernel
- weakens the core write contract
- makes authorization behavior harder to reason about

### 3. Runtime normalization of malformed ops

Bad because:

- it turns schema drift into implicit runtime behavior
- it pollutes traces by making invalid outputs look successful
- it creates pressure for an ever-growing synonym table

### 4. Prompt-only fix

Bad because:

- the runtime boundary remains unenforced
- one provider/model drift reintroduces the same class of bug

The right place to solve this is the boundary between:

- model-produced `kv_operations`
- kernel-consumable canonical KV operations

But the right long-term implementation style is still the same as the rest of
the runtime:

- shared schemas first
- narrow custom boundary logic second

## Rollout requirements

1. Land the boundary module.
2. Switch all known model-produced KV-op paths to `applyModelKvOperations(...)`.
3. Add an architecture test that fails if those paths open-code
   `kvWriteGated(...)` over raw `kv_operations`.
   This should be stronger than grep. The preferred v1 mechanism is a small
   AST-based assertion over the known model-produced KV-op call sites.
   If AST coverage is not practical, use one explicit wrapper marker and
   assert that each sanctioned path routes through that marker.
4. Add regression tests for:
   - rejection of `operation` instead of `op`
   - rejection of `set` instead of `put`
   - unsupported alias rejection
   - non-object batch elements
   - control-character keys
   - rejection of `field_merge` from deep-reflect source
5. Only after runtime enforcement is live, tighten prompt examples.

## Acceptance criteria

1. A reflect payload using:
   - `{ "operation": "set", ... }`
   is rejected as schema-invalid, produces no write attempt, and records
   `kv_operation_schema_rejected` with a diagnostic hint.

2. A reflect payload using an unsupported alias such as:
   - `{ "operation": "merge", ... }`
   produces:
   - no write attempt
   - a `kv_operation_schema_rejected` event
   - no `Unknown op: undefined`

3. `kvWriteGated(...)` receives only canonical operations from reflect and
   deep-reflect paths.

4. The duplicated `experience:*` ad hoc schema checks are replaced by the
   shared validator pipeline.

5. If any op in a model-produced batch is schema-invalid, no KV writes are
   attempted for that batch.

6. `prompt:reflect` contains explicit canonical KV-operation examples.

7. The same boundary module is used by all model-produced `kv_operations`
   paths, not just session reflect.

8. An architecture test exists to detect regression to direct raw
   `kvWriteGated(...)` calls in those paths.

9. A deep-reflect payload containing `field_merge` is rejected at the
   boundary before any write attempt.

## Non-goals

- redesigning kernel write-policy or authority rules
- introducing provider-native JSON schema enforcement across every LLM call
- runtime repair of malformed CRUD objects
- changing the semantic meaning of KV writes
