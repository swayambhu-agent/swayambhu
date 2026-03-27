# Async Jobs Architecture

## Problem

Sessions are currently synchronous and atomic: the cron fires, the kernel
runs act or reflect, everything happens within that execution, session ends.
This creates two constraints:

1. **Long-running work blocks the session.** A 40-minute CC analysis can't
   run inside a session — Worker timeouts, budget ceilings, and the patron
   needing the system for more urgent things all prevent it.

2. **Sessions can't benefit from work started earlier.** If a previous
   session wanted to dispatch an analysis, there's no way for a later
   session to pick up the results.

As models get cheaper and more capable, long-running compute becomes
increasingly useful across all session types:

- **DR** dispatches a CC analysis (40-60 min) for deep code/pattern review
- **Act** dispatches a background research task while handling patron requests
- **Reflect** dispatches parallel analyses (CC + Codex) and a later DR
  collects whichever finished
- Any session dispatches a long build, test run, or data pipeline

The system needs a way to **dispatch work that outlives the session** and
**collect results when they're ready**.

## Design: KV-tracked async jobs

### Principles

1. **Jobs are independent of sessions.** A job has its own lifecycle:
   created → running → completed/failed/expired. Sessions dispatch and
   collect, but the job doesn't care which session does either.

2. **KV is the coordination layer.** Job records live in KV. The compute
   happens on remote hosts. KV tracks what was dispatched, what's running,
   and what's done.

3. **Completion triggers a session.** When a job finishes, it calls back
   to the kernel (via webhook), which writes an inbox item and advances
   the session timer. The next session processes the result — same pattern
   as chat messages from contacts.

4. **Sessions orchestrate, jobs don't spawn jobs.** If a job's output
   implies further work is needed (e.g., "now run phase 2 on host Y"),
   the result says so and the next session dispatches it. All dispatch
   decisions go through sessions, keeping the execution flow linear,
   debuggable, and logged in karma.

5. **Structured results in KV, large artifacts on disk.** Small structured
   output (JSON, status) travels back to KV. Large files (reports, patches,
   data, binaries) stay on the compute target's filesystem. The job record
   carries pointers to both.

6. **Sessions remain short.** Dispatching a job is fast (pack context,
   transfer, start process). Collecting is fast (read job record from KV,
   access artifacts via tools). The session itself stays within normal
   budget/time limits.

### Job lifecycle

```
┌─────────────────────────────────────────────────────────┐
│                    Session N                             │
│                                                         │
│  1. Session starts (act, reflect, or DR)                │
│  2. Kernel drains inbox (chat msgs, job results, etc.)  │
│  3. Session runs normally                               │
│  4. Session decides to dispatch a job (via start_job)   │
│     → context packed, transferred, process started      │
│     → job:{id} written to KV with status: "running"     │
│  5. Session produces its normal output and ends          │
│                                                         │
└────────────────────────┬────────────────────────────────┘
                         │
            [Time passes — job runs on compute target]
                         │
         [Job completes → callback to kernel webhook:
          POST /job-complete/{id}
          → kernel writes inbox item + advances session]
                         │
┌────────────────────────▼────────────────────────────────┐
│                    Session N+k                           │
│                                                         │
│  1. Session starts                                      │
│  2. Kernel drains inbox — sees job_complete item         │
│  3. Agent reads structured result from job_result:{id}  │
│  4. Agent accesses artifacts on target via tools if      │
│     needed (e.g., computer tool for akash files)        │
│  5. Session acts on results (or defers to appropriate   │
│     session type)                                       │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### KV schema

#### Job record: `job:{id}`

```json
{
  "id": "cc-dr1-1711352400",
  "type": "cc_analysis",
  "status": "running",
  "created_at": "2026-03-25T10:00:00Z",
  "dispatched_by": {
    "session_id": "sess_42",
    "session_type": "deep_reflect",
    "depth": 1
  },
  "target": "akash",
  "workdir": "/home/swayambhu/jobs/cc-dr1-1711352400",
  "pid": 12345,
  "config": {
    "prompt_summary": "Deep reflect depth-1: 20 sessions of karma...",
    "context_keys": ["karma:*", "reflect:0:*", "config:defaults"],
    "ttl_minutes": 120
  },

  // Filled on completion:
  "completed_at": "2026-03-25T10:45:00Z",
  "exit_code": 0,
  "result_key": "job_result:cc-dr1-1711352400",
  "artifacts": [
    { "path": "/home/swayambhu/jobs/cc-dr1-1711352400/output.json", "type": "json", "size_bytes": 8420, "description": "DR analysis output" },
    { "path": "/home/swayambhu/jobs/cc-dr1-1711352400/stderr.log", "type": "log", "size_bytes": 2300, "description": "Process stderr" }
  ]
}
```

**`target`** is a logical name resolved via `config:compute_targets` at
runtime — not a hostname. If the host moves or access method changes,
update one config key rather than every job record.

**`artifacts`** lists files that remain on the compute target. The agent
accesses them via the appropriate tool for that target (e.g., `computer`
tool for akash). Artifacts survive until explicitly cleaned up by a
session or a TTL-based janitor.

#### Job result: `job_result:{id}`

Stored separately from the job record because results can be large
(but must still fit in a KV value — ~25MB max, practically <1MB).
For output larger than this, use artifacts.

```json
{
  "job_id": "cc-dr1-1711352400",
  "type": "cc_analysis",
  "result": {
    "session_summary": "...",
    "kv_operations": [],
    "proposal_requests": [],
    "next_steps": "Recommend running benchmark on GPU target"
  }
}
```

The `next_steps` field is how a job communicates that follow-up work is
needed. The collecting session reads it and decides whether to dispatch
another job — the job itself never dispatches.

#### Job status values

| Status | Meaning |
|--------|---------|
| `running` | Process started, not yet completed |
| `completed` | Callback received, result + artifacts recorded |
| `failed` | Process exited non-zero, callback reported error, or output unparseable |
| `expired` | TTL exceeded without callback — process presumed dead |
| `cancelled` | Explicitly cancelled by a session |

### Compute targets config

```json
// config:compute_targets
{
  "akash": {
    "type": "ssh_server",
    "access_tool": "computer",
    "base_dir": "/home/swayambhu/jobs",
    "callback_url": "https://kernel.swayambhu.dev/job-complete",
    "persistent_storage": true,
    "max_concurrent_jobs": 2
  }
}
```

Each target defines:
- **`type`**: How the target is accessed (`ssh_server`, `api`, `local`)
- **`access_tool`**: Which tool the agent uses to interact with the
  target's filesystem (`computer`, `web_fetch`, etc.)
- **`base_dir`**: Where job working directories are created
- **`callback_url`**: URL the job script calls on completion
- **`persistent_storage`**: Whether files survive reboots (affects
  TTL/expiry strategy)
- **`max_concurrent_jobs`**: Concurrency limit for this target

The `start_job` tool resolves the target name against this config to
determine how to dispatch. The agent accesses artifacts using the
target's `access_tool`.

### Tools

#### `start_job`

Dispatches a new async job. Packs context from KV, transfers to compute
target, starts background process, writes job record to KV.

```json
{
  "name": "start_job",
  "description": "Start a long-running background job on a compute target. Packs context from KV, transfers it, and starts the process. Returns immediately with a job ID. The job calls back on completion, triggering a session.",
  "parameters": {
    "type": "cc_analysis | codex_analysis | custom",
    "target": "(optional) compute target name, default: akash",
    "prompt": "The analysis/task prompt",
    "context_keys": ["karma:*", "reflect:0:*"],
    "include_code": true,
    "command": "(for custom type) shell command to run"
  }
}
```

Returns: `{ ok: true, job_id: "cc-dr1-1711352400" }`

The tool is fast — it does context packing and transfer (seconds), not the
analysis itself. Session budget barely notices it.

#### `collect_jobs`

Explicit mid-session polling. The primary notification path is the
completion callback → inbox; this tool is for when the agent wants to
check on a specific job without waiting for the next session.

```json
{
  "name": "collect_jobs",
  "description": "Check status of background jobs. Call with no args to check all, or with job_id for a specific job. Primarily useful for mid-session checks — job completion callbacks handle normal notification.",
  "parameters": {
    "job_id": "(optional) specific job to check",
    "wait_seconds": "(optional) short poll — wait up to N seconds for completion"
  }
}
```

Returns:
```json
{
  "completed": [
    { "job_id": "cc-dr1-1711352400", "type": "cc_analysis", "result_key": "job_result:cc-dr1-1711352400" }
  ],
  "still_running": [
    { "job_id": "codex-review-1711352500", "type": "codex_analysis", "started": "5 min ago" }
  ],
  "failed": [],
  "expired": []
}
```

### Completion callback

When a job finishes, the job script calls back to the kernel worker:

```bash
curl -s -X POST https://kernel.swayambhu.dev/job-complete/{id} \
  -H "Authorization: Bearer $JOB_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"exit_code": 0, "artifacts": [{"path": "output.json", ...}]}'
```

The kernel's fetch handler:

1. Validates the callback (auth token, job ID exists, status is `running`)
2. Updates `job:{id}` with completion data (status, exit_code, artifacts)
3. Reads the structured result from the compute target if small enough,
   writes to `job_result:{id}`
4. Writes inbox item: `{ type: "job_complete", ref: "job:{id}", ... }`
5. Advances `session_schedule` (same mechanism as chat messages)
6. Returns 200

The job script template includes the callback:

```bash
mkdir -p {workdir} && \
echo '<base64>' | base64 -d | tar xz -C {workdir} && \
nohup sh -c '
  cd {workdir} && \
  {command} > output.json 2>stderr.log; \
  EXIT=$?; echo $EXIT > exit_code; \
  curl -s -X POST {callback_url}/{id} \
    -H "Authorization: Bearer {job_secret}" \
    -H "Content-Type: application/json" \
    -d "{\"exit_code\": $EXIT}"
' > /dev/null 2>&1 & echo $!
```

**Fallback if callback fails:** The `collect_jobs` tool and TTL-based
expiry provide backup detection. If the callback never arrives (network
issue, curl not installed), the next session's explicit poll or the TTL
expiry catches it. The callback is the fast path, not the only path.

### Kernel integration: inbox-based notification

**Status: the unified inbox is now implemented.** All external events
(chat messages, patron directives, and — once built — job completions)
write to `inbox:*` KV keys. The kernel drains the inbox at session start
via `drainInbox()` in `runSession()`, and the items appear in the session
context as `context.inbox`.

Job completions arrive as inbox items via the callback handler:

```js
await K.writeInboxItem({
  type: "job_complete",
  source: { job_id: "cc-dr1-1711352400", target: "akash" },
  summary: 'CC analysis completed (depth-1 DR, 20 sessions)',
  ref: "job:cc-dr1-1711352400",
  result_key: "job_result:cc-dr1-1711352400",
  timestamp: new Date().toISOString(),
});
```

#### What happens with collected results

Depends on the job type:

| Job type | Result handling |
|----------|----------------|
| `cc_analysis` (dispatched by DR) | Next DR reads structured result, applies via `applyReflectOutput()`. May access artifacts for deeper context. |
| `cc_analysis` (dispatched by act) | Result available in next session. Act reads structured output, references artifacts if relevant. |
| `codex_analysis` | Same pattern — structured result in KV, artifacts on target. |
| `custom` (build/test) | Structured result has pass/fail + summary. Build artifacts stay on target. |
| `custom` (data pipeline) | Structured result has row counts, schema info. Data files stay on target. |

**Key design decision: results are stored, not auto-applied.** A completed
CC analysis doesn't automatically trigger `applyReflectOutput()` — a session
(typically DR or reflect) reads the result and decides what to do with it.
This preserves the agent's agency over its own state changes.

### Context injection via inbox

When a session starts, the kernel drains the inbox. The agent sees all
events — chat messages, patron directives, job completions — in a single
`inbox` array in its context:

```json
{
  "inbox": [
    {
      "type": "chat_message",
      "contact_name": "Swami",
      "summary": "explore on your own, report back",
      "ref": "chat:slack:U084ASKBXB7"
    },
    {
      "type": "job_complete",
      "source": { "job_id": "cc-dr1-1711352400", "target": "akash" },
      "summary": "CC analysis completed (depth-1 DR, 20 sessions)",
      "ref": "job:cc-dr1-1711352400",
      "result_key": "job_result:cc-dr1-1711352400"
    }
  ]
}
```

The agent reads structured results via `kv_query` on `result_key`, and
accesses large artifacts on the compute target via the target's access
tool (e.g., `computer` for akash).

### Comms gate interaction

If a job completes mid-session and the callback writes an inbox item, the
comms gate staleness check will hold any outbound messages (since
unprocessed inbox items exist). This prevents the agent from sending
replies based on stale context — the same mechanism that protects against
mid-session chat messages also covers mid-session job completions.

## Compute targets

### akash (current)

The existing compute box. Persistent storage, SSH access via `computer`
tool, runs as `swayambhu` user.

- **Start**: computer tool call (unpack tarball + nohup process)
- **Callback**: `curl` to kernel webhook on completion
- **Artifacts**: persistent in `/home/swayambhu/jobs/{id}/`
- **Access**: computer tool (`cat`, `ls`, etc.)
- **Cleanup**: computer tool (`rm -rf {workdir}`) when agent decides

### Future targets

| Target | Type | Access tool | Notes |
|--------|------|-------------|-------|
| akash | `ssh_server` | `computer` | Current compute box, persistent storage |
| Codex API | `api` | `web_fetch` | OpenAI's async API — has its own job/polling model |
| Cloud Run / Lambda | `api` | `web_fetch` | Burst compute, ephemeral — artifacts must be transferred back |
| GPU box | `ssh_server` | `computer` | For ML workloads, same pattern as akash |
| Local (wrangler) | `local` | N/A | Dev/test — mock job that completes immediately |

Each target is defined in `config:compute_targets`. The job infrastructure
in KV is the same regardless of target — only the dispatch method and
artifact access differ.

**Ephemeral targets** (Cloud Run, Lambda) don't have persistent storage.
For these, the job script must transfer artifacts back before the
container shuts down — either to a persistent target or directly into
the callback payload (if small enough). The `start_job` tool handles
this based on the target's `persistent_storage` flag.

## File transfer: base64 tarball

Context lives in KV (Cloudflare Worker) and needs to reach the compute
target's filesystem. For SSH-type targets, the bridge is the computer tool.

**Approach: build tar.gz in the Worker, base64 encode, unpack in one call.**

### Why this works in Workers

Workers run on V8 isolates with Web Platform APIs (not Node.js):

| API | Purpose |
|-----|---------|
| `Uint8Array` / `ArrayBuffer` / `DataView` | Binary construction |
| `TextEncoder` / `TextDecoder` | UTF-8 ↔ binary |
| `CompressionStream('gzip')` | Streaming gzip |
| `ReadableStream` / `WritableStream` | Pipe through compression |
| `btoa()` | Base64 encode |
| `Blob` | Concatenate typed arrays |

### Tar construction (~50 lines)

```js
function buildTar(files) {
  // files = [{ name: "karma/session_42.json", content: "..." }, ...]
  const encoder = new TextEncoder();
  const chunks = [];

  for (const file of files) {
    const data = encoder.encode(file.content);
    const header = new Uint8Array(512);

    encodeString(header, 0, file.name, 100);
    encodeString(header, 100, '0000644', 8);
    encodeString(header, 124, data.length.toString(8), 12);
    encodeString(header, 156, '0', 1);
    encodeString(header, 257, 'ustar', 6);

    let sum = 0;
    for (let i = 0; i < 512; i++) sum += (i >= 148 && i < 156) ? 32 : header[i];
    encodeString(header, 148, sum.toString(8), 7);

    chunks.push(header, data);
    const pad = 512 - (data.length % 512);
    if (pad < 512) chunks.push(new Uint8Array(pad));
  }

  chunks.push(new Uint8Array(1024)); // end-of-archive
  return concat(chunks);
}
```

### Compression + encoding

```js
async function packAndEncode(files) {
  const tar = buildTar(files);
  const compressed = await new Response(
    new Blob([tar]).stream().pipeThrough(new CompressionStream('gzip'))
  ).arrayBuffer();
  const bytes = new Uint8Array(compressed);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
```

### Transfer + start: one computer tool call

```bash
mkdir -p {workdir} && \
echo '<base64>' | base64 -d | tar xz -C {workdir} && \
nohup sh -c '
  cd {workdir} && \
  {command} > output.json 2>stderr.log; \
  EXIT=$?; echo $EXIT > exit_code; \
  curl -s -X POST {callback_url}/{id} \
    -H "Authorization: Bearer {job_secret}" \
    -H "Content-Type: application/json" \
    -d "{\"exit_code\": $EXIT}"
' > /dev/null 2>&1 & echo $!
```

### Size budget

| Content | Typical size |
|---------|-------------|
| Karma (20 sessions) | 50-150 KB |
| Reflections | 20-40 KB |
| Prompts + config | 15-25 KB |
| Wisdom + code | 55-130 KB |
| Chat history | 10-50 KB |
| **Total uncompressed** | **~150-400 KB** |
| **Gzipped → base64** | **~55-160 KB** |

Well within HTTP request limits and CC's 1M context window.

## Edge cases

### Callback never arrives

Network failure, curl not available, or process killed before callback.
Two fallback paths:

1. **TTL expiry**: if `created_at + ttl_minutes` has passed and the job
   is still "running", mark it `expired` during the next `collect_jobs`
   call. The session can re-dispatch if needed.
2. **Explicit poll**: agent calls `collect_jobs` to check on a specific
   job, which reads the filesystem (exit_code file) directly.

The callback is the fast path. TTL + polling are the safety net.

### Target becomes unreachable

If akash goes down after a job completes and writes its callback, the
structured result is in KV (safe) but artifacts on disk are unreachable.
The agent discovers this when it tries to access artifacts via the
computer tool and gets an error.

**Handling**: The structured result in KV should contain enough
information for the session to make decisions without the full artifacts.
Artifacts are supplementary detail — the critical output should always
fit in the KV result.

### Multiple jobs of the same type

Policy question: if a DR dispatches a CC analysis and the next DR also
wants one (before the first completes), should it:

- **Skip** — "there's already one running, wait for it"
- **Dispatch another** — two CC analyses running concurrently is fine
- **Cancel and re-dispatch** — the newer prompt has fresher context

**Recommendation**: skip by default. The `start_job` tool checks for
running jobs of the same type and reports back. The LLM can override
if it has a good reason (e.g. the running job's context is stale).

### Job results arrive during act (not DR)

An act session collects a completed CC analysis that was dispatched by DR.
Act shouldn't apply DR-schema results (kv_operations, proposals, etc.) —
that's DR's job. Act should:

1. Note the completed job in its context
2. Leave the result in KV for the next DR to process
3. Optionally reference findings in its own work if relevant

The prompt guidance should make this clear: *"Completed analysis jobs are
available for reference. Only DR sessions should apply structural changes
(kv_operations, proposals) from analysis results."*

### Multi-step workflows

A job's result says "next, run X on target Y with these parameters."
The collecting session dispatches the next step. This plays out across
sessions:

```
Session 1: dispatches gather job on akash
  → [gather completes, callback, session advances]
Session 2: sees gather result, dispatches analyze job on akash
  → [analyze completes, callback, session advances]
Session 3: sees analyze result, applies findings
```

Each step is a separate job, dispatched by a session. The session has
full context (inbox + previous results) to decide what to dispatch next.
No job-to-job communication needed.

**Optimization for tight pipelines:** If latency between steps matters,
a single job can internally run multiple steps on the same host. From
Swayambhu's perspective it's one job; inside, it's a pipeline. This
gives zero-latency between steps without changing the architecture.

### Artifact cleanup

Artifacts accumulate on compute targets. Cleanup options:

1. **Agent-driven**: session explicitly calls computer tool to
   `rm -rf {workdir}` after processing results
2. **TTL-based janitor**: a cron on the target deletes workdirs older
   than N days (e.g., `find /home/swayambhu/jobs -maxdepth 1 -mtime +7 -exec rm -rf {} +`)
3. **Job record marks cleanup**: when the session processes the result,
   it sets `cleanup: true` on the job record. A background process on
   the target checks for this flag.

Recommendation: agent-driven + TTL janitor as safety net. The agent
decides when it's done with artifacts, but stale workdirs get cleaned
up automatically after 7 days regardless.

### Session wants to wait for a job (rare)

Occasionally a session might want to block on a near-complete job rather
than deferring to the next session. Use `collect_jobs` with `wait_seconds`:

```json
{ "name": "collect_jobs", "parameters": { "job_id": "xxx", "wait_seconds": 30 } }
```

The tool polls once with a short timeout. If the job completes in that
window, great. If not, it returns `still_running` and the session moves on.
This should be rare and never used for long waits.

## Implementation phases

### Phase 1: Job infrastructure

- KV schema: `job:{id}` and `job_result:{id}` records
- `config:compute_targets` schema and seed data for akash
- `tools/start-job.js` — generic job dispatch with tarball transfer
- `tools/collect-jobs.js` — poll, collect, cleanup
- Tarball builder utility (tar + gzip + base64 in Workers)
- Job expiry logic (TTL-based status transitions)

### Phase 2: Completion callback + inbox integration

- Kernel fetch handler: `POST /job-complete/{id}` endpoint
- Callback validates auth, updates job record, writes inbox item,
  advances session schedule
- Prompt guidance for act and reflect on how to handle job results
- **Note:** the inbox infrastructure is already implemented. This phase
  is just wiring job events into it.

### Phase 3: CC analysis job type

- `cc_analysis` start command template on akash
- Context packing: KV glob resolution, file tree building
- CLAUDE.md for CC working directory
- DR prompt updates: when and how to dispatch CC analyses

### Phase 4: Result application

- Formalize how DR applies collected CC analysis results
  (via `applyReflectOutput()` or a new `applyJobResult()`)
- Handle partial results (CC produced output but it's incomplete)
- Karma trail: record job dispatch + collection as karma events

### Phase 5: Additional job types + targets

- Codex analysis job type
- Custom command jobs
- Other compute targets (GPU box, Cloud Run, etc.)
- Ephemeral target support (artifact transfer before shutdown)

## Open questions

1. **Result TTL**: How long should `job_result:{id}` persist in KV after
   collection? Useful for future reflections but also clutter.
   Maybe 7-day TTL like debug logs?

2. **Concurrency limits**: Per-target `max_concurrent_jobs` — should the
   `start_job` tool enforce this, or just warn and let the LLM decide?

3. **Job priority**: If multiple jobs complete between sessions, does the
   order of processing matter? Should some job types take precedence?

4. **CC model selection**: Should the CC invocation specify `--model opus`
   or rely on the default? The Max plan includes Opus, but CC's default
   might be Sonnet.

5. **Callback authentication**: What auth scheme for the job-complete
   webhook? A per-job secret generated at dispatch time? Or a shared
   secret in `config:compute_targets`?
