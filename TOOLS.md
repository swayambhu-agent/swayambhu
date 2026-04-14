# Tools

This document defines how agent tools are modeled, where they execute, and
how Cloudflare and Incus share one tool surface without splitting into two
different systems.

## Core idea

There is one canonical tool definition per capability.

A tool is not a "Cloudflare tool" or an "Incus tool". It is a named agent
capability with:

- a stable contract
- a declared execution locality
- a routing policy
- a result schema

What differs by environment is the adapter and execution target.

## Architectural split

### Cloudflare owns

Cloudflare is the agent runtime. It owns:

- session execution
- event and request handling
- KV reads and writes
- model calls
- scheduling
- tool routing
- tool-call recording and result interpretation

Cloudflare should keep only core cognition primitives and the minimum
lightweight tools that truly need to run in-worker.

### Incus owns

Incus is the capability substrate. It owns:

- long-running analysis
- filesystem-aware tools
- brittle integrations
- research helpers
- tools that need custom runtimes, Python, local mirrors, or special network
  behavior

Incus-hosted executors may still be fully agent-owned product code. The fact
that they execute outside Cloudflare does not make them "external" in the
architectural sense.

### External dependencies

External services are not stageable product code.

What the agent owns and stages is:

- the tool contract
- the adapter code
- the routing logic
- the executor code it runs on Cloudflare or Incus

What it does not own is the third-party service itself.

## Canonical tool contract

Each tool should be defined once with at least these fields:

- `name`
- `description`
- `input_schema`
- `output_schema`
- `secrets`
- `timeout_ms`
- `side_effect_level`
- `availability`
- `locality`

Recommended meanings:

- `availability: session | task | both`
- `locality: edge | incus | either`

`availability` answers:

- who is allowed to call this tool?

`locality` answers:

- where should this tool execute?

Examples:

- `kv_query`
  - `availability: both`
  - `locality: edge`

- `publications_kb`
  - `availability: both`
  - `locality: incus`

- `send_slack`
  - likely `availability: both`
  - locality may still be `incus` if we want side effects routed through the
    same receipt model

## Routing model

Cloudflare is the router, not the place where every tool must execute.

The router should decide:

- run inline in Cloudflare
- dispatch to an Incus executor
- reject because the tool is unavailable in the current runtime

Incus-based long-running agents should not go through Cloudflare just to use a
tool that already lives in Incus. They should call the same canonical tool via
the Incus-side adapter directly.

So the architecture is:

- one tool contract
- one chosen execution target
- multiple thin adapters

## Dispatch and receipt, not blind proxying

Cloudflare to Incus tool calls should not be modeled as "HTTP proxy and trust
the response".

That creates correctness bugs:

- Incus executes a side-effecting tool
- the HTTP response times out before Cloudflare records the result
- the session retries
- the tool runs twice

This is especially dangerous for:

- outbound communication
- job creation
- writes to external systems

The correct model is dispatch plus receipt.

### Required pattern

For Incus-local tools called from Cloudflare:

1. Cloudflare generates a `tool_call_id`.
2. Cloudflare dispatches the request to Incus with that ID.
3. Incus executes the tool.
4. Incus writes a receipt keyed by `tool_call_id` into a shared store.
5. Cloudflare reads the receipt and records success or failure from that
   receipt, not from the transport round trip alone.

Receipts must include:

- `tool_call_id`
- `tool_name`
- `status`
- `started_at`
- `completed_at`
- `result`
- `error`
- `side_effect_committed`

For side-effecting tools, the receipt is the source of truth.

## Timeout model

Timeouts belong to the tool contract, not to the network hop.

The router should evaluate whether a tool can complete within the current
Cloudflare session budget.

If not:

- dispatch asynchronously
- wait for a receipt later
- resume in a later session if needed

This lets Cloudflare own cognition and bookkeeping without pretending every
tool must finish inside one Worker tick.

## Code staging

Code staging applies to all agent-owned code:

- tool contracts
- routing logic
- Cloudflare adapters
- Incus executors

The important distinction is not Cloudflare vs Incus.

The distinction is:

- agent-owned product code
- external dependency

That said, once tool executors live on both Cloudflare and Incus, staging must
treat them as separate deploy targets.

A staged change may touch:

- Cloudflare only
- Incus only
- both

Multi-target changes need coordinated deploy and rollback behavior.

## Default placement policy

Use these defaults unless there is a clear reason not to.

### Keep on Cloudflare

- KV primitives
- model/provider calls
- session and scheduler internals
- event/request/comms routing primitives
- tiny pure transforms that are part of the cognition loop itself

### Put on Incus

- research and knowledge-base tools
- filesystem-dependent tools
- code execution helpers
- tools with odd transport requirements
- long-running tools
- anything likely to be reused by Codex, Gemini, Claude Code, or other
  Incus-based runtimes

### Put in both runtimes conceptually

A tool may be callable from both:

- Cloudflare sessions
- Incus long-running agents

without having two separate implementations.

The correct pattern is:

- one contract
- one primary implementation
- environment-specific adapters

## Publications KB as the reference example

`publications_kb` is the clearest example of why this architecture matters.

It is useful in both places:

- session-time reasoning
- long-horizon research tasks

But it is a poor fit for Cloudflare-native execution because:

- the public hostname returns `403`
- the direct IP path currently works only with insecure TLS behavior
- the local helper succeeds because it can disable certificate verification
- the Worker runtime should not depend on that behavior

So the correct design is:

- canonical tool contract lives with the agent
- primary executor lives on Incus
- Cloudflare dispatches and reads receipts
- Incus-based agents call the same executor locally

## Short version

- Define tools once.
- Declare locality explicitly.
- Keep Cloudflare focused on cognition, routing, and bookkeeping.
- Put most concrete tools on Incus.
- Use dispatch plus receipts for Cloudflare to Incus tool calls.
- Stage all agent-owned tool code, regardless of runtime target.
