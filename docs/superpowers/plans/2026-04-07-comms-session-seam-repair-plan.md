# Comms/Session Seam Repair Plan

## Purpose

Repair the boundary between communication and work execution without
collapsing the two concerns back together.

The architectural decision stands:

- communication owns conversation state, routing, and delivery
- sessions own work execution
- a durable KV contract bridges the two

The current failures are implementation drift, not evidence that the
separation itself was wrong.

## Current Failure Modes

### 1. Comms bypasses the kernel tool path

`runTurn()` exposes `trigger_session`, but then executes it by direct
module import instead of the normal kernel tool executor:

- [hook-communication.js](/home/swami/swayambhu/repo/hook-communication.js)
- [tools/trigger_session.js](/home/swami/swayambhu/repo/tools/trigger_session.js)

This causes the Slack failure seen overnight: `trigger_session` expects
kernel-injected `kv` and `emitEvent`, but comms passes `K` manually and
the tool crashes on `kv.put(...)`.

### 2. The durable request contract is only half implemented

`trigger_session` creates `session_request:{id}` and emits a
`session_request` event, but the execution side does not yet complete
the contract:

- sessions do not load pending requests into act context
- act output does not update request state
- no `session_response` events are emitted in the live runtime

The result is a write-only request record.

### 3. Sessions implicitly depend on ephemeral inbound evidence

Communication stores inbound messages in `chat:*` conversation state and
emits events, but sessions later behave as if the original inbound
message should still exist as separate durable request evidence.

This is the wrong dependency direction. After handoff, execution should
trust the durable request object, not the transient inbound event.

### 4. Stale requests are not resurfaced mechanically

There is no runtime path that:

- detects old `pending` requests
- reintroduces them into act context
- records that they were ignored

So request accountability depends too much on the model remembering to
close its own loops.

### 5. `trigger_session` is structurally special-cased

It is not part of the normal runtime tool map in [index.js](/home/swami/swayambhu/repo/index.js), so comms cannot execute it through the same
kernel path as other tools.

## Architectural Decision

Keep the current seam for now:

- durable request object in KV
- event as signal
- communication reads and writes conversation state
- execution reads and updates request state

Do **not** rename `session_request` / `session_response` yet.

Treat them as the current form of a more general durable work-contract
seam. Rename only after non-session executors actually need to update
the same contract.

## Target End State

### Communication layer

Owns:

- inbound message ingestion
- conversation history in `chat:*`
- contact-aware message generation and delivery
- request creation from conversation
- rendering request status back into natural language

Does **not** own:

- work execution
- task progress semantics beyond what the durable request says

### Request layer

Owns:

- durable source of truth for requested work
- request lifecycle state
- provenance linking request to conversation/contact
- progress/result payloads

### Execution layer

Owns:

- reading active requests from durable state
- performing work
- writing request updates/resolution
- emitting request update signals

It must not depend on the original inbound chat event once handoff is
complete.

## Repair Strategy

### Stage 1. Fix the comms handoff bug

Goal: make `trigger_session` run through the same execution contract as
other tools.

Changes:

- add `trigger_session` to the runtime `TOOLS` map in
  [index.js](/home/swami/swayambhu/repo/index.js)
- ensure its grants/meta are available through the normal kernel tool
  loader
- remove the direct import path in
  [hook-communication.js](/home/swami/swayambhu/repo/hook-communication.js)
- execute `trigger_session` via `K.executeToolCall(...)`
- preserve `_chatContext` by teaching the comms path to inject it into
  the tool-call context cleanly rather than bypassing the kernel

Implementation note:

The cleanest version is to add a comms-aware tool execution helper at
the kernel boundary or on `K`, rather than teaching comms to manually
assemble fake tool contexts.

This stage also fixes `trigger_session` to use the safe write path
intended by the architecture instead of raw `kv.put(...)`.

### Stage 2. Make request state first-class in session context

Goal: make the durable request object the thing sessions act on.

Changes:

- load active `session_request:*` records into userspace before act runs
- pass them into act context using the existing `pending_requests`
  support in [act.js](/home/swami/swayambhu/repo/act.js)
- define selection rules:
  - requests directly referenced by current events
  - stale pending requests above age threshold
  - bounded limit to avoid prompt bloat
- include enough structured fields for execution:
  - `id`
  - `summary`
  - `status`
  - `updated_at`
  - `ref`
  - prior `note` / `result` / `error`

Do **not** require sessions to inspect `chat:*` or inbound events to
recover request intent.

### Stage 3. Implement the missing response/update side

Goal: complete the contract so execution can resolve or update requests.

Changes:

- define a live output contract for act sessions:
  - `session_responses` or equivalent request-update array
- after act completes, userspace updates `session_request:{id}` records
- emit `session_response` events for communication
- support at least:
  - `pending`
  - `fulfilled`
  - `rejected`
- support optional:
  - `note`
  - `result`
  - `error`
  - `next_session`

Important constraint:

Do not push full fulfillment semantics into the kernel. Userspace should
decide the meaning of the update. The runtime should only:

- apply the envelope
- persist it durably
- emit the signal

### Stage 4. Add mechanical accountability for open requests

Goal: requests do not disappear just because the model forgot them.

Changes:

- add stale pending request discovery on each tick
- re-surface stale requests into act context with age metadata
- record `unaddressed_requests` when a session had request context but
  emitted no corresponding update
- surface stale request summaries into reflect / DR inputs

Kernel/runtime responsibility:

- discover stale requests
- expose them
- record missed updates

Userspace responsibility:

- decide what to do with them
- decide urgency and requester-facing messaging

Do not put policy like "escalate aggressively after N hours" into the
kernel.

### Stage 5. Fix follow-up message semantics

Goal: subsequent contact messages on the same thread do not vanish into
conversation state while a request is still pending.

Changes:

- when an inbound message arrives on a conversation with active pending
  request(s), comms should decide between:
  - conversational reply only
  - attach note/update to existing request
  - create a new request
- define a simple v1 rule:
  - if the inbound is clearly a clarification or reply to pending work,
    append a request note/update to the same request
  - otherwise create a new request only if the comms model calls
    `trigger_session`

This preserves the comms/session split while preventing follow-up replies
from becoming invisible to pending work.

### Stage 6. Tighten request lifecycle shape

Goal: make the durable request object useful beyond the initial pending
state.

V1 required fields:

- `id`
- `contact`
- `contact_name`
- `summary`
- `status`
- `created_at`
- `updated_at`
- `ref`
- `result`
- `error`
- `next_session`

V1.1 optional lifecycle additions after the repair lands:

- `notes`
- `history`
- `assigned_executor`
- `last_session_id`
- `waiting_on_requester`

Do not expand the schema prematurely before the basic loop works.

## Implementation Tasks

### Task Group A. Runtime wiring

Files:

- [index.js](/home/swami/swayambhu/repo/index.js)
- [hook-communication.js](/home/swami/swayambhu/repo/hook-communication.js)
- [tools/trigger_session.js](/home/swami/swayambhu/repo/tools/trigger_session.js)
- [kernel.js](/home/swami/swayambhu/repo/kernel.js)

Tasks:

- register `trigger_session` in runtime tools
- remove direct module import execution
- add comms-safe execution path with `_chatContext`
- move `trigger_session` writes onto the gated/safe path

### Task Group B. Session context and updates

Files:

- [userspace.js](/home/swami/swayambhu/repo/userspace.js)
- [act.js](/home/swami/swayambhu/repo/act.js)
- [prompts/act.md](/home/swami/swayambhu/repo/prompts/act.md) if present in KV seed source, otherwise corresponding prompt seed path

Tasks:

- load pending request records
- include them in act context
- define and process request updates from act output
- emit `session_response`
- record `unaddressed_requests`

### Task Group C. Communication rendering

Files:

- [hook-communication.js](/home/swami/swayambhu/repo/hook-communication.js)
- [prompts/communication.md](/home/swami/swayambhu/repo/prompts/communication.md)

Tasks:

- make comms read request updates from durable state
- handle pending/fulfilled/rejected naturally
- handle follow-up messages against pending requests
- remove any remaining assumption that inbound event persistence is the
  source of truth for work state

### Task Group D. Accountability and resurfacing

Files:

- [userspace.js](/home/swami/swayambhu/repo/userspace.js)
- [reflect.js](/home/swami/swayambhu/repo/reflect.js)

Tasks:

- stale request scan
- resurfacing into act context
- reflect visibility for stale/unaddressed requests

## Testing Plan

### New tests required

#### Communication/runtime

- inbound actionable DM -> `trigger_session` succeeds through normal tool
  path
- no `kv undefined` / `emitEvent undefined` failures
- `session_request:{id}` is created and `session_request` event emitted

#### Session context

- pending requests are loaded into act context
- requests referenced by current events appear first
- stale requests are resurfaced

#### Request updates

- act output with request update mutates `session_request:{id}`
- `session_response` event is emitted
- missing update for in-context request records `unaddressed_requests`

#### Communication rendering

- `session_response` causes comms to read the durable request state and
  render a natural message
- requester asks for status and comms answers from request state
- follow-up on pending request attaches to the right request in v1

### Regression tests

- internal-only comms turns still do not expose `trigger_session`
- `request_message` path still works unchanged
- event claiming/release lifecycle remains correct

## Rollout Order

1. land Stage 1 only
2. run focused comms tests
3. land Stage 2 and Stage 3 together
4. run request-lifecycle tests
5. land Stage 4 accountability
6. run short manual Slack regression
7. land Stage 5 follow-up semantics

Do not combine all stages into one patch. The current seam is broken in
multiple ways, and staged rollout makes it much easier to isolate
regressions.

## Success Criteria

- actionable contact messages reliably create durable request records
- comms never directly imports request tools to execute them
- sessions see pending requests from durable state
- request state is updated after work
- communication of results comes from durable request state
- stale requests cannot silently disappear
- follow-up replies on pending work are visible to the system

## Deferred Question

Should `session_request/session_response` later be renamed to
`work_request/work_update`?

Answer for now: defer.

Only revisit this after:

- request updates are fully live
- at least one non-session executor actually needs to update the same
  contract

Until then, naming churn would add migration cost without solving the
current failure.
