# Publications KB Incus Tool Architecture Design

## Summary

Move `publications_kb` from a Cloudflare-native Worker tool to an
Incus-executed tool under the new tool architecture:

- one canonical tool contract
- `locality: incus`
- Cloudflare dispatch plus receipt semantics
- direct local use by Incus-based long-running agents

This is a design and migration plan only. It does not implement the move.

## Problem

The current Worker-side `publications_kb` path is not robust:

- `https://publications.isha.in/api/...` returns `403 Forbidden`
- direct-origin HTTPS only works when certificate verification is disabled
- local helper scripts can work around this
- Cloudflare Worker runtime should not depend on insecure TLS behavior

So the current implementation is architecturally wrong even if it is
occasionally patchable.

## Goals

- Keep `publications_kb` as one canonical agent tool.
- Make the real executor run on Incus, where the helper already works.
- Allow both Cloudflare sessions and Incus-based research agents to use the
  same tool.
- Use receipt-based completion semantics so Cloudflare does not double-run or
  mis-record side effects.
- Preserve a stable tool schema for callers.

## Non-goals

- Do not redesign the publications backend itself.
- Do not solve all tool migration in this change.
- Do not implement a generic Incus tool substrate for every tool at once.
- Do not remove the current tool until the replacement is validated.

## Proposed architecture

### 1. Canonical tool contract

Keep a single `publications_kb` contract in the agent tool registry.

Recommended metadata:

- `availability: both`
- `locality: incus`
- `side_effect_level: read_only`
- `timeout_ms`: declared at the contract level

Supported actions remain:

- `search`
- `details`
- `fetch`

The input and output schemas should remain stable.

### 2. Incus executor

Create an Incus-side executor as the primary implementation.

It should wrap the existing known-good helper behavior:

- direct origin IP
- `Host: publications.isha.in`
- current login contract
- transport handling that works in the Incus environment

This executor may start as:

- a small internal HTTP service
- or a local Unix-socket service

The service should be private to the agent runtime and Incus agents.

### 3. Cloudflare adapter

The Cloudflare-side tool should become a dispatcher, not the real executor.

Responsibilities:

- validate input
- generate `tool_call_id`
- dispatch to Incus executor
- read receipt
- return the canonical tool result

It should not directly speak to the publications backend anymore.

### 4. Receipt model

Because `publications_kb` is read-only, the receipt model is mainly about
correctness and observability, not side-effect deduplication.

Still, use the same generic pattern:

- Cloudflare creates `tool_call_id`
- Incus executor writes `tool_receipt:{tool_call_id}`
- Cloudflare records success/failure from the receipt

Receipt fields:

- `tool_call_id`
- `tool_name`
- `status`
- `action`
- `started_at`
- `completed_at`
- `result`
- `error`
- `executor_runtime = incus`

### 5. Incus-agent access

Incus-based long-running agents should use the same executor locally.

They should not route through Cloudflare just to use the tool.

Expected pattern:

- same canonical tool name
- same schema
- local Incus adapter
- same receipt or result shape written back to shared state when needed

## Migration phases

### Phase 1: contract and locality metadata

- add explicit locality metadata for `publications_kb`
- document that the Worker implementation is transitional

### Phase 2: Incus executor

- stand up a private Incus service or local bridge
- move working transport logic there
- confirm `search`, `details`, `fetch` all succeed from Incus

### Phase 3: Cloudflare dispatcher

- replace direct backend calls in the Worker with dispatch + receipt lookup
- preserve existing tool schema

### Phase 4: Incus agent adapters

- make Codex/Gemini/Claude Code path use the same executor locally
- avoid duplicate helper logic

### Phase 5: remove Worker-native backend transport

- delete direct publications backend code from the Worker tool
- keep only the contract and dispatch adapter

## Data model additions

Suggested KV keys or equivalent shared store entries:

- `tool_receipt:{tool_call_id}`
- optional `tool_dispatch:{tool_call_id}` if dispatch and receipt need to be
  separated explicitly

Suggested receipt TTL:

- long enough for session follow-up and debugging
- short enough not to pollute long-term memory

## Reliability requirements

- Cloudflare must not treat a transport timeout as "tool definitely failed".
- Incus executor completion must be visible through a receipt even if the
  original dispatch response is lost.
- Duplicate dispatches using the same `tool_call_id` must be safe.
- Result parsing must preserve the current tool schema.

## Security requirements

- publications credentials stay on Incus for the real executor path
- Cloudflare should not need direct insecure access to the backend
- dispatcher to Incus must be authenticated
- executor must not expose a public unauthenticated surface

## Acceptance criteria

- `publications_kb.search`, `details`, and `fetch` succeed from:
  - Cloudflare session runtime
  - Incus-based research agents
- Cloudflare no longer talks directly to the publications backend
- direct insecure TLS workarounds are removed from the production Worker path
- tool results are visible through receipt-backed bookkeeping
- failures are diagnosable from shared receipts/logs

## Open questions

- shared store for receipts: KV vs queue vs Incus-local state mirrored to KV
- transport between Cloudflare and Incus: HTTP vs queue-driven dispatch
- whether read-only tools like `publications_kb` should block synchronously on
  receipt or always use async completion
- whether the generic receipt substrate should be built first and then reused
  for other Incus-local tools

## Recommended next step

Do this migration only after the generic Incus tool receipt path is designed
well enough that `publications_kb` becomes the first user, not a one-off
special case.
