# Work Thread and Continuation Implementation Plan

## Goal

Implement the [work-thread and continuation design](./2026-04-14-work-thread-continuation-design.md)
without turning the runtime into a pile of request-specific exceptions.

The plan should fix:

- `#30` fulfilled work resurfacing as pending
- `#34` timebound and exploratory work being closed too early

And it should establish one durable continuity model that future features can
reuse.

## Implementation stance

Prefer a small number of strong abstractions:

1. one canonical runtime module for durable work-thread lifecycle
2. one canonical runtime module for continuation lifecycle
3. one compatibility adapter layer for legacy names and statuses
4. conversation-scoped ambiguity state, not a new global state surface

Avoid:

- adding special-case dedupe logic in each caller
- teaching prompts to compensate for missing runtime invariants
- scattering `pending|active` branching through unrelated files
- heuristic merge rules that silently collapse multiple open threads

## Core implementation decisions

### 1. Keep KV prefixes and public tool names in v1

Do not rename storage keys or public tools in the first rollout.

Keep:

- `session_request:*`
- `update_request`
- `trigger_session`
- `last_reflect.carry_forward`

But treat them as compatibility names over the new model:

- `session_request:*` = work thread
- `carry_forward` = continuation list

This keeps the migration bounded while letting the runtime semantics change
cleanly underneath.

### 2. Add one canonical thread module

Create:

- `lib/work-threads.js`

This module should own:

- thread normalization from legacy stored shape
- thread serialization back to KV
- status sets and open/closed derivation
- transition validation
- explicit reopen rules
- deterministic `upsertWorkThread(...)`
- scoped lease acquisition for upsert
- lifecycle reconciliation for expiration and staleness
- conversation/requester scope derivation
- loading conversation-related and planner-related threads
- contract-aware thread update helpers

All callers should go through this module rather than directly manipulating
`session_request:*` records.

### 3. Add one canonical continuation module

Create:

- `lib/continuations.js`

This module should own:

- continuation validation
- continuation write guards
- continuation update application
- orphan detection
- reconciliation against parent work-thread state
- migration of legacy carry-forward items into request-linked continuations

`reflect.js` and `userspace.js` should stop hand-editing continuation arrays
directly.

### 4. Store ambiguity state on the conversation object

Do not create a new top-level KV prefix for ambiguity holding state.

Instead, store:

- `pending_thread_resolution`

inside the existing conversation record in `hook-communication.js`.

That state belongs to one conversation and should travel with that
conversation's turn history.

### 5. Use one status adapter, not dual canonical statuses

Canonical thread statuses in code should be:

- `active`
- `blocked`
- `stale`
- `fulfilled`
- `rejected`
- `superseded`
- `expired`

Legacy `pending` should only exist as a read compatibility alias that
normalizes to `active`.

Do not add both `pending` and `active` as first-class statuses everywhere.

### 6. Use one scoped lease strategy, not ad hoc caller-local locking

Cloudflare KV does not give us a true compare-and-swap mutex. So the first
implementation should use one explicit best-effort lease pattern everywhere
`upsertWorkThread(...)` is called.

Required shape:

- lease key derived from the thread scope
- short TTL
- owner token
- lease validation on read-after-write
- idempotency key on create/upsert requests
- post-write reconcile that turns rare duplicate races into explicit
  ambiguity rather than silent merge

Implementation target:

- add a small scoped-lease helper in `lib/work-threads.js`, patterned after
  the existing event-lease semantics in `kernel.js`

This is an explicit engineering deviation from the design spec's ideal
"scoped mutex" language. In this rollout, the guarantee is:

- best-effort mutual exclusion
- deterministic idempotency
- eventual duplicate detection and ambiguity surfacing

not true atomic exclusion.

Do not let each caller invent its own locking behavior.

## Phase plan

### Phase 1: Canonical thread model with compatibility adapter

#### Files

- `lib/work-threads.js` (new)
- `lib/session-requests.js`
- `tools/trigger_session.js`
- `tools/update_request.js`
- `hook-communication.js`
- `userspace.js`
- `dashboard-api/worker.js`
- `site/patron/src/components/RequestsTab.jsx`
- `tests/tools.test.js`
- `tests/chat.test.js`
- `tests/userspace.test.js`
- `tests/dashboard-api.test.js`
- `tests/work-threads.test.js` (new)

#### Work

1. Create `lib/work-threads.js` with these canonical entry points:

- `normalizeWorkThread(record, key?)`
- `serializeWorkThread(thread)`
- `isOpenWorkThreadStatus(status)`
- `deriveWorkThreadScope({ conversationRef, requesterId })`
- `acquireWorkThreadScopeLease(...)`
- `validateWorkThreadTransition(existing, patch)`
- `applyWorkThreadUpdate(...)`
- `upsertWorkThread(...)`
- `reconcileWorkThreadLifecycle(...)`
- `loadConversationWorkThreads(...)`
- `loadPlannerWorkThreads(...)`

Phase 1 is not a standalone release. It lands together with Phase 2 so that
chat-originated callers never see the new upsert semantics without the
matching triage-intent plumbing.

2. Convert `lib/session-requests.js` into a compatibility wrapper.

Keep the file, but make it delegate to `lib/work-threads.js` so existing
imports do not spread migration logic.

3. Change `trigger_session` from create-only to upsert-based.

Add optional inputs for explicit lifecycle control:

- `request_id?`
- `intent?` with values:
  - `auto`
  - `continue`
  - `new_parallel`
  - `reopen`
- `contract_type?`
- `completion_condition?`
- `timebound_duration_hours?`
- `timebound_until_at?`

`summary` remains required for now.

4. Change `update_request` to use validated work-thread transitions.

It should stop assuming only:

- `pending`
- `fulfilled`
- `rejected`

and instead use the canonical status set.

5. Switch all request consumers to normalized thread reads.

Replace direct `session_request:*` logic in:

- `hook-communication.js`
- `userspace.js`
- dashboard API

with loaders from `lib/work-threads.js`.

6. Implement the scoped lease in the same phase.

`upsertWorkThread(...)` must not ship without:

- scope-derived lease keys
- owner token / idempotency token
- bounded TTL
- duplicate-race fallback that surfaces ambiguity instead of silently keeping
  two canonical threads

7. Add one lifecycle sweep entry point in the same phase.

`reconcileWorkThreadLifecycle(...)` should be the only place that:

- expires timebound threads once their bound is reached
- marks non-timebound open threads as `stale`
- leaves already closed threads untouched

#### Important simplification

Do not rename call sites to `work_thread` yet.

The implementation win here is centralizing semantics, not cosmetically
renaming every symbol in one pass.

#### Exit criteria

- one module owns thread normalization and transitions
- one module owns scoped work-thread lease acquisition
- no caller creates or updates raw `session_request:*` records directly
- `pending` is treated only as a legacy read alias of `active`
- dashboard and chat surfaces can read both legacy and new thread records

### Phase 2: Conversation triage and ambiguity handling

#### Files

- `hook-communication.js`
- `tools/trigger_session.js`
- `prompts/communication.md`
- `tests/chat.test.js`
- `tests/index.test.js`

#### Work

1. Extend inbound triage to express thread intent explicitly.

Do not add a large new tool surface.

Keep the current inbound decision shape and extend it with:

- `thread_intent`:
  - `continue`
  - `new_parallel`
  - `clarify`
  - `auto`
- `request_id?`
- optional contract fields for timebound work

The runtime, not the model, should own final ambiguity handling.

2. Add `pending_thread_resolution` to conversation state.

Store:

- original inbound message
- candidate thread IDs
- created/expiry timestamps
- resolution mode

inside the conversation record.

Default TTL:

- `24h`

This is long enough to survive a normal pause in conversation and short
enough that stale ambiguity does not linger for days.

3. Resolve ambiguity before normal upsert.

If a conversation has pending thread resolution:

- next inbound message must try to resolve it first
- only after resolution should normal queueing resume

4. Garbage-collect expired ambiguity holds.

Expiry cleanup should happen in:

- inbound chat handling before triage
- any conversation write path that already loads the conversation object

An expired `pending_thread_resolution` must be removed without mutating any
work thread.

5. Only ask clarifying questions on true ambiguity.

If the message clearly identifies:

- one existing thread
- or a clearly new task

do not ask for clarification merely because several open threads exist.

#### Important simplification

Keep ambiguity handling entirely inside conversation runtime state.

Do not introduce a separate global “thread router” service or a new KV event
type for ambiguity.

#### Exit criteria

- chat triage can continue an existing thread, open a new parallel one, or
  ask for clarification explicitly
- multiple open threads in one conversation no longer imply mandatory
  clarification
- ambiguity state survives across turns without inventing a new global state
  surface
- expired ambiguity holds are removed deterministically

### Phase 3: Continuation enforcement and legacy carry-forward migration

#### Files

- `lib/continuations.js` (new)
- `reflect.js`
- `userspace.js`
- `prompts/reflect.md`
- `prompts/deep_reflect.md`
- `tests/reflect.test.js`
- `tests/userspace.test.js`
- `tests/continuations.test.js` (new)

#### Work

1. Create `lib/continuations.js` with these canonical entry points:

- `normalizeContinuation(item)`
- `validateContinuation(item, openThreadIndex)`
- `applyContinuationUpdates(...)`
- `reconcileContinuationsAgainstThreads(...)`
- `migrateLegacyCarryForward(...)`

2. Move continuation mutation logic out of `reflect.js`.

`reflect.js` should stop directly editing continuation arrays and instead call
the continuation module.

3. Enforce the parent-thread invariant in code.

New actionable continuations must not be persisted unless:

- they include `request_id`
- the referenced parent thread exists
- the parent thread is open

4. Migrate legacy active carry-forward items without heuristic thread linking.

For any active continuation in `last_reflect.carry_forward` that lacks
`request_id`:

- materialize a self-originated work thread
- attach the continuation to that new thread

Do not try to infer which external request it “really” belonged to.

This is intentionally mechanical. In the old model, `carry_forward` was the
actionable continuity surface. So every active legacy carry-forward item is
treated as actionable continuity during migration. Non-active carry-forward
items are not migrated into live work threads.

5. Add a reconcile sweep before planner context assembly.

In `userspace.js`, run:

- `reconcileContinuationsAgainstThreads(...)`

before building act context.

That sweep should:

- drop or rewrite orphan continuations
- close active continuations whose parent thread is now closed
- reopen nothing automatically

#### Important simplification

Treat orphan actionable continuity as a migration problem, not as a permanent
runtime mode.

The runtime should always converge to:

- every active continuation has one open parent thread

#### Exit criteria

- continuation writes are code-guarded, not prompt-trusted
- active continuations always reference open parent threads
- legacy carry-forward is migrated without semantic guesswork

### Phase 4: Contract-aware completion and expiration rules

#### Files

- `lib/work-threads.js`
- `tools/update_request.js`
- `userspace.js`
- `prompts/act.md`
- `tests/userspace.test.js`
- `tests/tools.test.js`

#### Work

1. Implement contract-aware status transitions.

Required cases:

- `one_shot + deliver_requested_output`
- `timebound + deliver_requested_output`
- `timebound + best_effort_by_timebound`
- explicit reopen of `expired`

Timebound expiration trigger site:

- `reconcileWorkThreadLifecycle(...)` runs before planner context assembly in
  `userspace.js`
- the same lifecycle sweep runs before conversation-related thread status is
  loaded in `hook-communication.js` and dashboard/API loaders that depend on
  current thread state

2. Make auto-reconcile use contract data.

Replace the current request reconcile framing:

- “fulfilled if requester-facing ask appears satisfied”

with logic that receives:

- `contract_type`
- `completion_condition`
- active continuation summaries
- current thread status

3. Support explicit reopen of `expired`.

Only allow reopen when:

- caller intent is explicit
- new time bound is provided

Do not silently revive expired threads from vague follow-up language.

4. Enforce premature-fulfillment guards in code, not only in auto-reconcile
   prompts.

`validateWorkThreadTransition(...)` should reject:

- `timebound + best_effort_by_timebound -> fulfilled`

before the configured bound has elapsed, unless the caller is an explicit
operator override or carries `allow_early_completion: true` as an already
resolved structured input.

The validation layer should not inspect raw human language. Any human-driven
early-complete instruction must be converted into that structured flag before
it reaches transition validation.

Single conversion site:

- `hook-communication.js` triage is the only runtime path that may translate
  an explicit human message into `allow_early_completion: true`
- operator/dashboard actions may set the flag directly
- auto-reconcile must never invent the flag on its own

5. Define the non-timebound staleness rule in the same lifecycle sweep.

Default rule:

- if a non-timebound thread is still open
- and has no active continuation
- and has no user signal or thread update for `max(24h, 2 * schedule interval)`

then `reconcileWorkThreadLifecycle(...)` may mark it `stale`

#### Important simplification

Do not add a separate `open/closed` field and do not multiply statuses for
every closure reason.

Keep:

- status = lifecycle state
- completion_condition = success semantics

#### Exit criteria

- best-effort timebound work can close as `fulfilled`
- timebound lapse without satisfying the contract closes as `expired`
- expired threads reopen only with explicit extension
- premature fulfillment of timebound best-effort work is rejected by runtime
  validation, not merely discouraged by prompt wording
- timebound expiry and non-timebound staleness are both produced by one
  explicit lifecycle sweep

### Phase 5: Prompt cleanup after runtime invariants are live

#### Files

- `prompts/communication.md`
- `prompts/act.md`
- `prompts/reflect.md`
- `prompts/deep_reflect.md`
- `tests/reflect.test.js`
- `tests/chat.test.js`

#### Work

1. Update communication prompt language from:

- queue a request

to:

- continue a thread
- open a new parallel thread
- clarify ambiguity

2. Update act prompt language to:

- use contract-aware completion
- stop treating every open thread as one-shot work

3. Update reflect and deep-reflect prompts to:

- require `request_id` on actionable continuity
- stop using `note_to_future_self` as a substitute for a continuation
- keep non-actionable reminders in `note_to_future_self`

#### Important simplification

Do not ship prompt assumptions before runtime can enforce them.

Phase 5 must follow Phase 3 and Phase 4, not precede them.

#### Exit criteria

- prompts describe the model the runtime actually enforces
- no prompt is compensating for a missing code invariant

## Recommended implementation order

The smallest safe sequence is:

1. Phase 1 + Phase 2 + Phase 3 in one migration slice
2. Phase 4 + Phase 5 immediately after, with no unrelated release boundary in
   between

Phase 1 must not ship without Phase 2, because deterministic upsert without
ambiguity holding leaves the system with nowhere safe to send
`ambiguous_open_threads`.

Phase 1 must also not sit for long without Phase 3, because thread lifecycle
changes and continuation free-floating behavior should not diverge across
releases.

Phases 4 and 5 should follow immediately because contract-aware completion and
prompt semantics must agree.

## Testing plan

### New unit tests

- `tests/work-threads.test.js`
  - normalization from legacy request records
  - open/closed derivation
  - transition validation
  - deterministic upsert
  - explicit reopen

- `tests/continuations.test.js`
  - request-linked continuation writes
  - orphan rejection
  - legacy carry-forward migration
  - reconcile sweep behavior

### Existing tests to update

- `tests/tools.test.js`
  - `trigger_session` becomes upsert-based
  - `update_request` understands new statuses and contract fields

- `tests/chat.test.js`
  - continuation-shaped inbound messages continue the right thread
  - obviously new tasks open new threads even with one existing open thread
  - ambiguous messages create `pending_thread_resolution`

- `tests/userspace.test.js`
  - planner loads open work threads via canonical loader
  - auto-reconcile becomes contract-aware
  - expired thread reopen path
  - reconcile sweep removes orphan continuations

- `tests/reflect.test.js`
  - new actionable continuity must include `request_id`
  - orphan actionable continuity is rejected or downgraded
  - legacy carry-forward migration path

- `tests/dashboard-api.test.js`
  - request summary handles canonical statuses

## Risks and how to avoid them

### Risk 1: status migration leaks everywhere

Avoidance:

- normalize legacy `pending` to `active` in one adapter only
- keep downstream code consuming canonical statuses only

### Risk 2: ambiguity handling grows a second workflow engine

Avoidance:

- keep ambiguity state on the conversation object
- allow only one pending ambiguity record per conversation
- garbage-collect expired holds on the same conversation path that loads them

### Risk 3: continuation migration drops real work

Avoidance:

- migrate legacy orphan carry-forward into self-originated work threads
- do not discard active items just because parent linkage is missing

### Risk 4: prompt/runtime mismatch during rollout

Avoidance:

- land runtime guards before prompt changes
- do not require `request_id` in prompts until code can enforce it

### Risk 5: compatibility glue becomes permanent

Avoidance:

- keep `lib/session-requests.js` as a compatibility wrapper only during the
  semantic migration
- remove it once all imports have moved to `lib/work-threads.js`, or at the
  latest in the same cleanup pass that does the physical key/name rename

## Explicit non-goals for the first implementation

- no storage-key rename from `session_request:*` to `work_thread:*`
- no rename of public tools from `trigger_session` / `update_request`
- no `standing_task` implementation yet
- no attempt to infer exact parent threads for legacy orphan continuations
- no semantic similarity merge engine

## Deliverable at the end of this plan

At the end of this implementation, the system should have:

- one canonical durable work-thread model
- one canonical continuation model
- contract-aware completion for one-shot and timebound work
- explicit reopen for expired timebound work
- conversation-scoped ambiguity handling
- no orphan actionable continuity stored by runtime code

That gives the runtime a coherent substrate for both external work contracts
and self-originated multi-session continuity without adding a large number of
special-case behaviors.
