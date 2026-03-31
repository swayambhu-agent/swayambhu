# Claude Code for Deep Reflect

## Problem

Deep reflects (DR) currently run as multi-turn agent loops via the OpenRouter
API using Claude Opus. Each DR has a budget of ~$0.50 and frequently hits the
budget ceiling before completing its analysis — the model wants to keep going
but gets cut off. Increasing the budget is expensive: a thorough DR with 10+
tool-call turns can easily run $1-3 per session, and DRs happen regularly.

Meanwhile, the Claude Code Max plan provides unlimited access to Opus 4.6
with a 1M context window. If DR workloads can be routed through Claude Code
on the akash compute box, the marginal cost per DR drops to zero.

## Constraint: Anthropic ToS

Claude Code's acceptable use prohibits fully autonomous agent-operated
workflows — i.e. using CC as a loop where an outer system drives iterative
tool calls through CC as if it were an API. The current DR pattern (LLM call
→ tool results → LLM call → tool results → ... → final output) would look
exactly like that if transplanted directly into CC.

**The approach must be: one prompt in, one analysis out.** CC does its own
internal reasoning (which may be multi-step within its own session), but
from Swayambhu's perspective it's a single invocation — not an outer loop
driving CC through repeated calls.

## Design: Context-Packed Single-Shot Analysis

### Core idea

Instead of the current iterative explore-then-conclude pattern, front-load
all the context that DR would normally gather via tool calls, package it into
files in a working directory, and give CC one comprehensive prompt. CC's 1M
context window means we can feed it far more context than the current DR ever
sees — making the analysis both cheaper AND deeper.

### Flow

```
Regular DR flow (kernel)
  │
  ├─ 1. Context gathering phase (no LLM — just KV reads + formatting)
  │     • Read all KV keys DR would typically query via tools
  │     • Format into structured files
  │     • Write files to a temp working directory on akash
  │
  ├─ 2. Prompt construction
  │     • Build the DR system prompt (same as current, minus tool instructions)
  │     • Add a CLAUDE.md to the working dir with project context
  │     • Compose the analysis request as a single user message
  │
  ├─ 3. CC invocation (single shot via computer tool)
  │     • `claude -p "<prompt>" --output-format json`
  │     • CC reads the context files, does its analysis, returns JSON
  │     • One invocation, one response — not an outer agent loop
  │
  ├─ 4. Parse CC output
  │     • Extract the DR JSON output (same schema as current)
  │     • Feed back into applyReflectOutput() as normal
  │
  └─ 5. Cleanup temp files
```

### What gets packed into context files

The current DR gathers context through tool calls (kv_query, web_fetch).
By pre-gathering this data, we eliminate the need for iterative exploration:

| File | Contents | Source |
|------|----------|--------|
| `karma/` | Session karma logs for all sessions since last DR | `karma:{sessionId}` KV keys |
| `reflections/` | All depth-0 reflect outputs since last DR | `reflect:0:{id}` KV keys |
| `prior-deep-reflections.json` | Previous DR outputs at this depth | `reflect:{depth}:{id}` KV keys |
| `config.json` | Current `config:defaults` | KV |
| `prompts/` | All `prompt:*` keys | KV |
| `wisdom/` | All `prajna:*` and `upaya:*` entries (full content) | KV |
| `proposals.json` | All proposals (any status) | KV |
| `chat-history/` | Recent chat conversations | `chat:*` KV keys |
| `contacts.json` | Contact records | `contact:*` KV keys |
| `balances.json` | Current provider/wallet balances | Context passed to DR |
| `code/` | Current source files (act.js, reflect.js, tools/, etc.) | KV `code:*` keys |
| `blocked-comms.json` | Pending blocked communications | KV |
| `yamas-niyamas.json` | Current operating principles | `yama:*`, `niyama:*` KV keys |

**Estimated total size:** Most DRs would pack 200-500KB of context. Well
within the 1M token window (~750K tokens of text capacity). This means CC
gets to see **everything** — not just what the iterative DR happened to
query via tools.

### The CC prompt

The prompt to CC should be structured as:

```
You are performing a deep reflection on Swayambhu's recent operations.

All relevant context has been provided as files in the current directory.
Read them thoroughly before producing your analysis.

[Current DR system prompt — reflection instructions, output schema, etc.]

Your output must be a single JSON object matching this schema: { ... }

Key directories:
- karma/ — session logs (one file per session, chronological)
- reflections/ — session-level reflections
- prior-deep-reflections.json — your previous analyses at this depth
- config.json — current system configuration
- prompts/ — all active prompts
- wisdom/ — prajna (insights) and upaya (methods)
- code/ — current source code
- chat-history/ — recent conversations

Read everything. Take your time. This is the most thorough analysis
you can produce — you have more context than you've ever had before.
```

### Async job infrastructure

CC analysis can take 40-60 minutes — far longer than any session. The
solution is an **async job system** where sessions dispatch work and later
sessions collect results. This is a general-purpose system that applies
to all session types, not just DR.

**See [async-jobs.md](async-jobs.md) for the full async jobs spec** — KV
schema, job lifecycle, tools (`start_job`, `collect_jobs`), kernel
auto-collection, file transfer via tarball, edge cases.

### Integration: CC as a subplan within the existing DR

DR remains the orchestrator running via the normal API-based agent loop.
CC becomes a **tool** that DR can invoke — a `cc_analysis` tool alongside
kv_query, web_fetch, computer, etc. DR decides when and whether to use it.

This is the right approach because:

- **DR retains full flexibility.** It can do a CC analysis, then follow up
  with API-based tool calls to investigate something CC flagged. Or run
  two CC analyses with different prompts. Or skip CC entirely for a light
  DR and save the overhead.
- **Composable with other providers.** The same pattern works for a Codex
  analysis, a Gemini deep-think, or any other external analysis engine.
  DR picks the right tool for the job.
- **Graceful degradation.** If CC is down or auth is expired, DR just
  doesn't use that tool — the session still completes via normal API flow.
- **Minimal API cost for orchestration.** DR's own API usage becomes tiny:
  a few cheap turns to decide what to analyze, invoke CC, and process the
  result. The expensive analysis work is offloaded to CC.

#### How it works

**Session N — DR dispatches a job:**

1. DR starts its normal agent loop (Opus via API, with tools).
2. DR assesses what needs deep analysis. Invokes `start_job` with a prompt,
   context keys, and job type (`cc_analysis`).
3. The tool packs context → tarball → transfers to akash → starts CC in
   background → writes `job:{id}` to KV → returns the job ID immediately.
4. DR can continue doing other work (kv_query, web_fetch, etc.) or produce
   its final output noting a pending job.
5. Session ends. CC is still running on akash.

**Session N+1 (or later) — collect results:**

1. Early in the session (act or reflect), check for completed jobs via
   `collect_jobs` tool (or kernel does this automatically).
2. For each completed job: read the result from KV, apply it.
3. For CC analysis results: feed into `applyReflectOutput()` or make the
   result available as context for the current session.

**Key point:** the dispatching session and the collecting session don't need
to be the same session, or even the same type of session. A DR dispatches,
a later act or DR collects.

#### Tools: `start_job` and `collect_jobs`

```js
// tools/start-job.js
export const meta = {
  secrets: ["CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "COMPUTER_API_KEY"],
  kv_access: "readwrite",
  timeout_ms: 120000,  // just packing + transfer, not the analysis itself
};

export async function execute({ type, prompt, context_keys, include_code, K, secrets, fetch }) {
  // 1. Generate job ID
  // 2. Read requested KV keys, build file tree
  // 3. Pack tarball, transfer to akash, start background process
  // 4. Write job:{id} to KV with status: "running"
  // 5. Return { ok: true, job_id, estimated_duration: "30-60 min" }
}
```

```js
// tools/collect-jobs.js
export const meta = {
  secrets: ["CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "COMPUTER_API_KEY"],
  kv_access: "readwrite",
  timeout_ms: 60000,
};

export async function execute({ job_id, K, secrets, fetch }) {
  // If job_id specified, check that one job. Otherwise check all running jobs.
  // 1. List job:* keys with status "running"
  // 2. For each: poll akash (check exit_code file exists)
  // 3. If done: read output, update KV record, cleanup workdir
  // 4. Return { completed: [...], still_running: [...], failed: [...] }
}
```

See [async-jobs.md](async-jobs.md) for full tool definitions, automatic
kernel collection, and job type extensibility.

## Tradeoffs

| Aspect | Subplan approach | Direct replacement (rejected) |
|---|---|---|
| API cost | Small (~$0.02-0.05 for DR orchestration turns) | Zero |
| Flexibility | DR can mix CC + API + other providers | Locked to CC only |
| Fallback | Graceful — DR continues without CC | Needs explicit fallback code |
| Complexity | Tool implementation + DR prompt guidance | Simpler but rigid |
| Multi-step analysis | DR can run CC multiple times or follow up | Single shot only |

The small API cost for orchestration is negligible compared to the savings
from offloading the heavy analysis to CC.

## What DR gains with CC

- **10-50x more context**: Currently DR sees only what it queries (budget-limited).
  CC sees everything packed upfront.
- **Zero marginal cost for analysis**: Max plan = unlimited Opus. The heavy
  thinking happens on CC, not the API meter.
- **Deeper analysis**: No budget ceiling cutting off exploration. CC can
  reason as long as it needs.
- **Composability**: DR can combine CC analysis with other tools, other
  providers, or its own follow-up reasoning.
- **Better output quality**: More context + Opus 4.6 + no budget pressure
  = substantially better reflections.

## Implementation phases

Phases 1-2 (job infrastructure, kernel integration) are in
[async-jobs.md](async-jobs.md). CC-specific phases:

### Phase 1: CC analysis job type (depends on async-jobs Phase 1)

- `cc_analysis` start command template on akash
- Context packing: resolve `context_keys` globs against KV, build file tree
- CLAUDE.md for the CC working directory
- Test end-to-end: start job → wait → collect result

### Phase 2: DR prompt + result application

- Update `prompt:reflect:1` with guidance on `start_job` for heavy analysis
- Formalize how DR applies collected CC results (via `applyReflectOutput()`
  or decide to discard/modify)
- Keep existing tool-call DR as default; CC jobs are additional capability

### Phase 3: Tuning

- Refine CC analysis prompts based on output quality
- Optimize context packing (signal vs noise)
- DR prompt guidance on when CC analysis is worth dispatching vs doing
  a cheaper API-based investigation

## Open questions

CC-specific (generic job questions are in [async-jobs.md](async-jobs.md)):

1. **CC file access in `-p` mode**: Verify that `claude -p` can read files
   from the working directory. Need to confirm with a quick test on akash.

2. **Output size limits**: CC's output in `-p` mode — is there a practical
   limit? DR outputs are typically 2-10KB of JSON, should be fine.

3. **CC model selection**: Should the invocation specify `--model opus`,
   or rely on CC's default? Max plan includes Opus but CC might default
   to Sonnet.

4. **Context packing granularity**: Should DR specify exactly which KV
   keys to pack (precise but requires DR to know what's relevant), or
   should `cc_analysis` have a default "pack everything" mode?
