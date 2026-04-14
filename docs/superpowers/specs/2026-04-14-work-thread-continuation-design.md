# Work Thread and Continuation Design

## Summary

Replace the current `session_request` plus free-floating `carry_forward`
model with a cleaner hierarchy:

- `work_thread`: the canonical durable unit of actionable work
- `continuation`: internal continuity attached to a `work_thread`

The immediate goal is to fix:

- `#30` fulfilled work resurfacing as pending
- `#34` exploratory or timebound work being closed like one-shot deliverables

This is a design and migration plan only. It does not implement the model.

## Problem

The current architecture has two overlapping continuity systems:

- `session_request:*` tracks requester-visible work state
- `last_reflect.carry_forward` tracks internal continuity

Those systems are only loosely connected. As a result:

- repeated or reformulated asks become multiple sibling `session_request:*`
  records
- fulfilling one request does not close its duplicates
- stale carry-forward can remain active even when the underlying job or
  request is already complete
- exploratory requests are interpreted as one-shot requests because the
  request schema has no contract type or completion condition

The result is not just prompt drift. It is a structural identity problem:
there is no single canonical object for a durable work thread.

## Root cause

### 1. Request identity is too weak

`trigger_session` always creates a new `session_request:{id}` record. It
cannot continue, merge, or supersede an existing work thread.

### 2. Request updates are too local

`update_request` updates one exact request ID. If three open records really
refer to the same thread, fulfilling one leaves the others alive.

### 3. Carry-forward acts like a second work system

`carry_forward` can preserve live operational work even when the external
request thread changed. This creates split-brain continuity:

- request says one thing
- carry-forward says another

### 4. Request contract semantics are under-specified

The request schema has no explicit distinction between:

- one-shot deliverable
- timebound exploration

So a meaningful interim deliverable can be misread as final fulfillment.

## Design principles

1. One canonical durable object per actionable thread.
2. External and internal work use the same durable thread model.
3. Continuity must attach to a thread, not float beside it.
4. Non-actionable orientation should not become durable work state.
5. Favor upsert and linkage over post hoc dedupe heuristics.
6. Keep compatibility with existing `session_request:*` keys for the first
   rollout; treat naming cleanup as a second step.
7. On ambiguity, do not guess. Prefer explicit linkage or clarification over
   heuristic merges.

## Proposed model

### 1. Work thread

A work thread is the canonical durable unit of actionable work.

Conceptual name:

- `work_thread`

Initial KV compatibility name:

- `session_request:{id}`

The implementation may keep the existing key prefix initially, but the
runtime, prompts, docs, and dashboard should treat the object as a work
thread rather than a per-message request.

### 2. Continuation

A continuation is an internal continuity record attached to a work thread.

It exists to answer:

- what is the next bounded step on this thread?
- what is currently blocked?
- what should the next session remember?

It is not an independent durable work contract.

### 3. Note to future self

`note_to_future_self` remains the place for:

- cautions
- orientation
- reminders
- things worth noticing next time

It should not hold actionable multi-session work.

### 4. Review and meta-policy notes

Review notes, meta-policy notes, and reasoning artifacts remain separate.
They are structural diagnostics, not work-thread continuity.

## Data model

### Work thread schema

Recommended conceptual schema:

```json
{
  "id": "wt_1774785541",
  "requester": {
    "type": "contact|self",
    "id": "swami_kevala"
  },
  "conversation_ref": "chat:slack:U084ASKBXB7",
  "summary": "Deep overnight exploration of cyclic cosmology theory",
  "status": "active|blocked|stale|fulfilled|rejected|superseded|expired",
  "contract_type": "one_shot|timebound",
  "completion_condition": "deliver_requested_output|best_effort_by_timebound",
  "timebound_duration_hours": 8,
  "timebound_until_at": null,
  "result": null,
  "note": null,
  "error": null,
  "superseded_by": null,
  "created_at": "ISO8601",
  "updated_at": "ISO8601",
  "last_user_signal_at": "ISO8601"
}
```

`conversation_ref` is optional.

It should be present when the thread is anchored to a live contact
conversation. It may be absent for:

- self-originated work
- standing-task spawned work
- migrated legacy threads
- internal follow-up threads that are not tied to one live chat surface

Not all fields must be introduced at once. The minimum meaningful upgrade is:

- stable work-thread identity
- `requester.type`
- `requester.id`
- `status`
- `contract_type`
- `completion_condition`
- `last_user_signal_at`

There is no separate `open` / `closed` boolean. Openness is derived from
`status`:

- open: `active`, `blocked`, `stale`
- closed: `fulfilled`, `rejected`, `superseded`, `expired`

`completion_condition` describes what success looks like. It does not encode
failure or lapse states. `expired` is a terminal closure outcome used when a
timebound thread reaches its bound without satisfying its completion
condition.

### Continuation schema

Recommended schema:

```json
{
  "id": "wt_1774785541:cf1",
  "request_id": "wt_1774785541",
  "item": "Compare RM(3,7) decomposition against the 112→128 claim",
  "why": "The overnight exploration is still active and this is the most grounded next step.",
  "priority": "high|medium|low",
  "status": "active|done|dropped|expired",
  "blocked_on": "Patron clarification on Ajna source tradition",
  "wake_condition": "When a reply arrives clarifying Ajna scope",
  "created_at": "ISO8601",
  "updated_at": "ISO8601",
  "expires_at": "ISO8601"
}
```

Invariant:

- every continuation must reference a valid work thread by `request_id`

## Lifecycle rules

### Work-thread creation

Inbound or internal actionable work should go through one conceptual
operation:

- `upsert_work_thread(...)`

This is the key abstraction that replaces create-only request minting.

Behavior:

- if the caller provides an explicit `request_id`, target that thread
- otherwise, if inbound triage has already resolved the message to one
  specific existing thread, target that thread
- otherwise, if inbound triage has already classified the message as an
  explicit new parallel task, create a new thread
- otherwise, if the message is continuation-shaped and exactly one open
  thread exists for the same conversation and requester, target that thread
- otherwise, if no open thread exists, create a new thread
- otherwise, if multiple open threads exist and no explicit thread is given,
  do not merge heuristically; require clarification or an explicit fork /
  supersede decision

This should be implemented in one helper used by both:

- chat-triggered work creation
- self-originated durable work creation

`request_id` is an internal/runtime handle. It is appropriate for:

- self-originated callers
- dashboard/operator actions
- internal follow-up actions that are explicitly continuing a known thread

Contacts are not expected to know or provide raw thread IDs. Human-originated
chat should normally resolve through conversation scope, ambiguity holding
state, or explicit clarification, not by asking the contact for an ID.

This does not mean "ask for clarification whenever more than one open thread
exists." Multiple open threads in one conversation are normal. Clarification
is only required when the new message does not already identify:

- one specific existing thread to continue
- or a clearly new parallel task to open

So a message like "any updates on the cosmology work?" should continue the
cosmology thread even if other open threads exist, while a message like
"what's the status?" may require clarification if several open threads are
plausible targets.

Conversely, if there is exactly one open thread but the new message is
obviously a different piece of work, it should open a new thread rather than
attach to the existing one. For example, if the only open thread is
cosmology research and the user says "email Sravanth the report", that should
be treated as a new parallel thread unless triage has stronger evidence that
it is merely an update inside the existing thread.

#### Matching contract

The helper must use an explicit deterministic matching order:

1. `request_id` provided by caller:
   - if open, update it
   - if `status = expired` and caller provides explicit reopen intent plus a
     new time bound, reopen it
   - otherwise, if closed, fail with an explicit error rather than silently
     reopening
2. No `request_id`, but triage has already resolved one specific open thread:
   - update that thread
3. No `request_id`, but triage has already classified the message as an
   explicit new parallel task:
   - create a new thread
4. No `request_id`, the message is continuation-shaped, and exactly one open
   thread exists for the same
   scope:
   - if `conversation_ref` is present: `conversation_ref + requester.id`
   - if `conversation_ref` is absent: `requester.id`
   - update that thread
5. No open thread for that scope, or the message is clearly a different new
   task:
   - create a new thread
6. More than one open thread for that scope:
   - return `ambiguous_open_threads`
   - caller must clarify, supersede, or explicitly fork

This is intentionally not semantic similarity matching. The goal is to avoid
both false merges and false duplicate creation by making ambiguity explicit.

#### Concurrency requirement

`upsert_work_thread(...)` must execute under a scoped mutex for:

- `conversation_ref + requester.id` when `conversation_ref` exists
- otherwise `requester.id`

Otherwise two near-simultaneous callers can both observe "no open thread"
and create duplicates anyway.

Required model:

- acquire scoped lock
- run deterministic match
- create or update thread
- release lock

This scoped lock is mandatory for the first implementation. A post-write
reconciler may detect race-created duplicates, but it must not silently merge
them heuristically. If a race is ever detected despite the lock strategy, the
runtime should surface it as ambiguity and route it through the same explicit
resolution path as `ambiguous_open_threads`.

#### Ambiguity fallback policy

When `ambiguous_open_threads` is returned:

- inbound chat triage must not create a new thread by default
- if the message is brief, status-like, or clearly continuation-shaped, ask
  for clarification or reply without mutating thread state
- if the message explicitly indicates a new parallel task, create a new
  thread with explicit fork intent
- internal callers must supply an explicit `request_id` or explicit
  fork/supersede intent; they may not rely on guesswork

#### Ambiguity holding state

If inbound triage encounters `ambiguous_open_threads`, the message must not
be left as unstructured conversation residue.

Required holding state:

- store a `pending_thread_resolution` record on the conversation containing:
  - raw inbound message content
  - candidate thread IDs
  - created_at / expires_at
  - resolution mode: `clarify_required`

Required runtime behavior:

- the next inbound reply in that conversation must load this holding state
  before normal upsert logic
- if the user clarifies, resolve the hold into:
  - continue existing thread
  - supersede
  - explicit fork
- if the user never clarifies, the holding state expires without mutating
  any work thread

### Work-thread updates

State transitions:

- `active -> blocked`
- `active -> stale`
- `active -> fulfilled`
- `active -> rejected`
- `active -> superseded`
- `active -> expired`
- `blocked -> active`
- `blocked -> stale`
- `blocked -> expired`
- `stale -> active`
- `stale -> expired`
- `expired -> active` with explicit reopen intent and a new time bound
- `active -> active` with contract refinement
- `blocked -> blocked` with contract refinement

`fulfilled` and `rejected` are terminal.
`superseded` is terminal but links to the successor thread.
`expired` is closed by default, but may be explicitly reopened into the same
thread when a later user signal or operator action extends the allowed time
window.

`blocked` is not a completion state. It means the thread is still open but
cannot currently proceed without some missing input, dependency, or
prerequisite.

### Contract-type transitions

`contract_type` is mutable while a thread is open.

Allowed transitions while `status` is `active` or `blocked`:

- `one_shot -> timebound`
- refinement of `completion_condition`
- refinement of `timebound_duration_hours`
- refinement of `timebound_until_at`

This is necessary because requester intent can evolve after creation.
A later user signal such as "keep going overnight" must be able to widen the
contract rather than being forced into the original one-shot semantics.

In this v1 model, exploratory/open-ended asks are represented as
`timebound` plus explicit extension, not as an unbounded
contract type.

Recommended interpretation:

- `deliver_requested_output`
  - close as `fulfilled` once the requested deliverable or user-visible
    outcome has been produced
- `best_effort_by_timebound`
  - close as `fulfilled` when the allotted window has been substantially used
    and the best meaningful result available within that window has been
    delivered
  - close as `expired` when the allotted window ends before that best-effort
    result is actually delivered

### Explicit reopening of expired threads

An expired timebound thread may be reopened when continuity should remain in
the same thread rather than being split across successors.

Required conditions:

- the thread currently has `status = expired`
- caller intent is explicit that work should resume or continue
- a new time bound is supplied via exactly one of:
  - `timebound_duration_hours`
  - `timebound_until_at`

Allowed reopening triggers:

- a later user message such as "keep going for another 4 hours"
- an operator/dashboard action that explicitly extends the thread
- an internal follow-up action that carries explicit reopen intent from a
  user-approved extension

Not allowed:

- silent reopening just because a vaguely related message arrived
- reopening `fulfilled`, `rejected`, or `superseded` threads

When reopened:

- `status` becomes `active`
- `last_user_signal_at` is updated
- the previous expiry remains visible in thread history / audit, but the
  canonical thread ID is preserved

### Thread staleness

Open work threads need a staleness policy so they do not accumulate forever.

Required signals:

- `last_user_signal_at`
- `updated_at`
- optional `completion_condition`
- optional `timebound_duration_hours`
- optional `timebound_until_at`

When `contract_type = "timebound"`, exactly one of these should be set:

- `timebound_duration_hours`
- `timebound_until_at`

Required runtime behavior:

- non-timebound threads may become `stale` when they are still open but no
  longer current planner obligations
- when a timebound thread reaches its configured duration or end time, close
  it according to its completion condition:
  - `deliver_requested_output`
    - `fulfilled` if the requested deliverable or outcome has been produced
    - otherwise `expired`
  - `best_effort_by_timebound`
    - `fulfilled` if a substantive best-effort result has been delivered by
      the bound
    - otherwise `expired`
- a blocked timebound thread that reaches its bound normally becomes
  `expired`; `blocked` does not keep the contract open past its allowed
  window
- `stale` threads are not treated as active planner obligations by default
- a new user signal can reactivate a `stale` thread back to `active`

This keeps timebound exploration from silently remaining active after the
allowed window was already spent while preserving `stale` as an open-state
concept rather than a terminal closure.

It also preserves the ability to continue the same exploration thread later
without creating artificial duplicates, as long as reopening is explicit and
paired with a new bound.

### Continuation updates

Continuations are created and refreshed only for open threads:

- `active`
- `blocked`

When a thread becomes:

- `fulfilled`
- `rejected`
- `superseded`
- `expired`

all active continuations for that thread must be resolved, dropped, or
rewritten immediately.

There should never be an active continuation whose parent thread is closed.

Because the current KV model is not transactional, this invariant must be
enforced as eventually consistent by runtime reconciliation, not assumed to be
atomic.

Required mechanism:

- every tick that loads work-thread context must run a
  `reconcile_work_threads_and_continuations()` sweep first
- the sweep must detect:
  - active continuations whose parent thread is closed or missing
  - continuations whose `request_id` points to a superseded thread
- those continuations must be:
  - resolved, dropped, or rewritten before planner context is assembled

So the operational invariant is:

- by the time act planning begins, no orphan active continuations remain

## Prompt changes

### Communication prompt

Current triage thinks in terms of:

- queue new work

It should instead think in terms of:

- continue existing work thread
- create new work thread
- ask for clarification before opening a thread
- reply without work creation

This does not require exposing internal IDs to the human. It requires the
tool contract to support upsert semantics.

### Act prompt

The act prompt should stop framing request status as if every request were a
one-shot deliverable.

It should state:

- update the work thread status according to its contract type
- do not mark a timebound exploration thread fulfilled merely because one
  useful deliverable was produced
- use `blocked` when real progress cannot continue without new input
- for `best_effort_by_timebound`, use `fulfilled` when the thread has worked
  through the allotted window and delivered the best meaningful result it
  could produce within that window
- use `expired` when a timebound thread's allowed window has elapsed without
  satisfying its completion condition and without explicit extension
- if the user later explicitly extends that same timebound effort, reopen the
  expired thread rather than inventing a duplicate successor by default
- use `fulfilled` only when the thread's completion condition is met

### Auto-reconcile prompt

The current request reconcile prompt is too permissive:

- it explicitly allows `fulfilled` once the requester-facing ask appears
  satisfied even if optional follow-up ideas remain

That is correct for one-shot work and wrong for exploration charters.

The reconcile logic should receive:

- `contract_type`
- `completion_condition`
- current thread status
- active continuation summaries

and should treat interim deliverables differently from completion.

In particular:

- `blocked` is never itself a completion condition
- a timebound thread should close as `fulfilled` if its completion condition
  is satisfied by the bound
- a timebound thread should close as `expired` only when the bound is reached
  without satisfying its completion condition
- a later explicit extension may reopen that same expired thread with a new
  bound

### Reflect and deep-reflect prompts

Reflect and deep-reflect should stop treating carry-forward as a parallel
work surface.

They should instead:

- create or update continuations only against an open `request_id`
- keep `note_to_future_self` for non-actionable orientation

This is not only a prompt rule. It is a runtime invariant.

Required enforcement:

- the runtime continuation-write path must reject creation of any actionable
  continuation without a valid open parent work thread
- if reflect or deep-reflect emits actionable continuity without a resolvable
  open `request_id`, the runtime must not persist it as a continuation
- in that case, the runtime should either:
  - convert it to `note_to_future_self` if it is merely orienting/reminding
  - or drop it and surface a structured error / review note if it was
    intended as actionable continuity

So prompts should help the model avoid generating invalid continuation output,
but code must enforce that no orphan actionable continuation can be stored.

## Migration plan

### Phase 1: semantic upgrade without key rename

Keep KV prefix:

- `session_request:*`

But change the conceptual contract everywhere:

- docs
- dashboard labels
- prompts
- tool descriptions

Treat `session_request` as a work thread.

Recurring scheduled commitments such as "send me a news report every day at
7am" are out of scope for this spec. They should be modeled separately as a
`standing_task` that instantiates one-shot work threads per occurrence.

### Phase 2: introduce upsert helper with scoped locking

Add a shared request/work-thread helper that:

- finds the best open thread for the same conversation/contact
- decides create vs continue vs supersede
- updates `last_user_signal_at`

This helper should be the only creation path.

The helper must be robust to legacy callers:

- if caller intent is underspecified, default to the deterministic
  matching contract above rather than always creating a new thread

### Phase 3: continuation linkage plus reconcile sweep

Require every active continuation to carry a `request_id`.

During this phase:

- migrate existing carry-forward items best-effort
- add the runtime reconcile sweep that removes or rewrites orphaned
  continuations before context assembly
- add a hard runtime guard on continuation writes so new orphan actionable
  continuations cannot be created even if prompts or model output drift
- if an item cannot be linked to a live thread, either:
  - convert it to `note_to_future_self`
  - or drop it

This phase is a prerequisite for prompt rules that assume request-linked
continuations and orphan cleanup.

### Phase 4: prompt/runtime cleanup in the same release as Phase 3

Update:

- communication triage wording
- act completion wording
- auto-reconcile wording
- reflect and deep-reflect continuation rules

This phase should not ship before Phase 3. Prompt rules that assume linked
continuations and contract-aware completion should arrive only once the
runtime can enforce them.

Recommended rollout:

- Phase 2: upsert helper with scoped locking
- Phase 3: continuation linkage plus reconcile sweep
- Phase 4: prompt and runtime wording changes

These three phases should ship together or in immediate sequence without an
intermediate release boundary.

### Phase 5: optional physical rename

Only after compatibility is proven:

- `session_request:*` -> `work_thread:*`
- `carry_forward` -> `continuations`

This is an implementation cleanup, not required for correctness.

## Why this solves #30 cleanly

`#30` is fundamentally about split identity and split continuity.

This design fixes both at the root:

- no more create-only work contracts
- no more multiple open records for the same real thread by default
- no more floating carry-forward state that can contradict request state

The solution is structural, not heuristic.

## Why this also enables #34

Once the durable object is a real work thread, it can carry:

- `contract_type`
- `completion_condition`
- `timebound_duration_hours`
- `timebound_until_at`

That makes exploratory and timebound work first-class rather than implicit
text inside a summary.

So this design is the correct substrate for:

- `#30` request-state correctness
- `#34` timebound/exploratory contract semantics

## Non-goals

- Do not turn every reflection artifact into a work thread.
- Do not remove `note_to_future_self`.
- Do not force a storage-key rename in the first implementation.
- Do not solve every dashboard or comms UX problem in this same change.

## Acceptance criteria

- repeated or reformulated asks in one live thread do not create conflicting
  sibling open work threads by default
- ambiguous multiple-open-thread cases do not silently merge; they surface
  explicit ambiguity instead
- fulfilling a work thread closes the canonical thread rather than leaving
  live duplicates behind
- active continuations always reference an open work thread by the time act
  planning begins
- runtime code rejects orphan actionable continuation writes rather than
  relying on prompt compliance alone
- closed work threads do not retain active continuations beyond the next
  reconcile sweep
- timebound exploration work can remain active without being mistaken for
  one-shot fulfillment
- timebound threads close as `fulfilled` when they satisfy their completion
  condition by the bound, and as `expired` only when the bound lapses without
  doing so
- an expired timebound thread can be explicitly reopened with a new bound
  instead of forcing a brand-new duplicate thread
- non-actionable reminders stay in `note_to_future_self`, not in work-thread
  continuity
