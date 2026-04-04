# Enhancements

Tracked ideas for future improvement. Not prioritized — just captured.

## Dashboard

- **Event numbering in timeline**: Add index numbers to karma events in the timeline view so they can be referenced easily (e.g. "event 23" instead of scrolling to find it).

- **Preserve tab state on navigation**: When switching between tabs (Timeline, KV, etc.) and back, the previously selected session, expanded event, and scroll position should be preserved instead of resetting.

- **Local spend estimate alongside provider balance**: The OpenRouter balance API has a reconciliation delay, so after an expensive session (e.g. deep reflect at $0.43) the displayed balance doesn't update immediately. Could sum `cost` fields from karma events to show a local "spent this session" or "estimated current balance" figure that updates instantly.

## Act

- **Surface deep reflect schedule in act context**: The agent doesn't know when the next deep reflect is due, leading it to waste steps trying to trigger one manually. Add a line to the act prompt: "Deep reflections are scheduled automatically by the kernel." and include the schedule details (last ran session N, next due at session M or date D). The kernel already reads `reflect:schedule:1` in `highestReflectDepthDue` — just pass it through to the act context. Cheap to compute, prevents a whole class of wasted effort.

- **Minimax at low effort is too weak for act**: Session `s_1774023539576_q4il9u` showed minimax reading the alias map (opus, sonnet, haiku, etc.) and then immediately passing `"deep_reflect"` as a model name to spawn_subplan. It had the right information but couldn't connect the dots. Consider notching up to medium effort or switching to a more capable model (mimo, sonnet) for act — the token savings from minimax are negated when it makes mistakes that burn 8 fallback cycles.

## Tools

- **web_fetch returns raw HTML — wastes tokens and causes hangs**: `web_fetch` returns full HTML pages including scripts, nav, footers. When a subplan fetches multiple pages and sends them to the LLM, the context is massive and mostly useless. This caused a session hang — the LLM call with 4 full HTML pages in context timed out and killed the worker process. Fix: extract text content from HTML (strip tags, scripts, styles) before returning. The `max_length` parameter exists but the agent rarely uses it, and even truncated HTML is mostly boilerplate. A smarter extraction (readability-style) would give the agent the article text it actually needs.

- **kv_manifest silent miss on wrong prefix**: `kv_manifest` returns `{ keys: [], count: 0 }` for both a typo'd prefix and a legitimately empty prefix — the agent can't tell the difference. Could silently poll a wrong prefix forever thinking "nothing new yet." Not fixable at the KV level (prefix scans have no concept of "this namespace exists"). Possible mitigations: prompt guidance ("if a prefix scan returns empty unexpectedly, verify against a broader scan"), or a heuristic in the tool that warns when a prefix has no keys and doesn't match any known prefix pattern.

## Naming

- ~~**Rename "orient" to "act" throughout codebase**~~ — **Status: Done.** Completed via `scripts/migrate-orient-to-act.mjs` and manual sweep.

## Contacts & Roles

- **Support role**: Introduce a `support` contact role alongside `patron`. The patron is the non-technical person who funds and communicates with the agent. The support contact is the technical person who diagnoses and fixes platform bugs. Key design points:
  - Support never touches the live agent's state directly — they export a KV snapshot, replicate locally, diagnose, fix the platform code, and deploy.
  - The broken agent self-heals on next session (or the patron resets state via dashboard if needed).
  - No special write permissions required — just read access (KV snapshot export) and a communication channel.
  - Patron-granted: only the patron can designate a support contact.
  - Scaling vision: the platform builder's own agent acts as support for other patrons' agents, via a skill.
  - A "type 2" failure (agent gets itself into a bad state through self-modification) is really a "type 1" failure (platform bug in the guardrails/reflection/rollback system) — so the fix is always at the platform level.

- **Platform update propagation**: Agents should periodically check the swayambhu GitHub repo for platform updates. Updates flow through three tiers:

  **Tier 1 — Kernel-only (no interface changes):** Governor-managed, fully automated. Agent detects new version available, notifies patron. Patron approves via dashboard, governor pulls new kernel from GitHub, rebuilds with agent's existing KV code, deploys. Scales to millions of agents.

  **Tier 2 — Advisory:** Published guidance rather than code pushes. E.g. "We improved how act context is built — here's the pattern." Agent reads advisories during normal sessions, evaluates them against its own (potentially divergent) codebase, and implements changes through its existing self-modification process (proposals → review → deploy). Uses the self-improvement system rather than bypassing it. Each agent adapts the advice to its own code. Free — the agent does its own work.

  **Tier 3 — Breaking interface changes:** The agent can't self-fix because a kernel interface it depends on has changed. Requires migration by an authorized support agent. Support agent takes a KV snapshot, understands both old and new interfaces, performs the migration, patron approves the result. This is a paid service — the more an agent has diverged through self-modification, the more custom the migration, the more valuable the work. Support agents that have migrated many agents build expertise and efficiency. This is the natural revenue model: open source software, paid technical support.

## Agent Escalation

- **Patron escalation path for platform bugs the agent can't fix**: When the agent identifies a kernel/platform-level bug that's beyond its self-modification capability, it currently has no reliable way to inform the patron. Real example: the `request_message` tool had a broken dependency injection (kvGet undefined). The agent correctly diagnosed it, wrote a detailed root cause analysis to a file on the server, but couldn't communicate it because the bug WAS in the communication tool. Catch-22. The agent needs a "raise to patron" channel that works even when the primary comms tool is broken. Options: (a) direct Slack write as a kernel-level alert (similar to `sendKernelAlert` which already exists for crash notifications), (b) a `patron_escalation:*` KV prefix visible in the dashboard, (c) a dedicated `escalate` tool that bypasses the event/comms pipeline and writes directly to Slack via the kernel alert path. The key constraint: this channel must work independently of the agent's own comms infrastructure.

- **KV-based bug reporting**: The agent saved its bug report to a file on the akash server but not to KV. Future sessions and DR couldn't see the analysis. A `note:*` KV prefix for agent-written observations would persist findings across sessions and make them visible in the dashboard. Low friction (agent-tier write), searchable, and DR-accessible.

## Cognitive Architecture

- **Multi-session strategy layer**: The current architecture is session-oriented — each tick plans one action with no memory of longer-term goals. Tactics + DR ideas provide session-to-session continuity, but there's no concept of "I'm working on a multi-session project" or "this week I want to accomplish X through steps A, B, C." Defer until the agent has 20-30 sessions of real experience with tactics + ideas. Watch for these failure signals: abandoned long-running work, repeated context loss across sessions, inability to sequence related actions, or thrashing between unrelated activities. If those appear, design a lightweight strategy layer (possibly just a `current_objective` field in `last_reflect` plus an "unfinished work" queue). Let usage reveal the right mechanism rather than guessing.

## Deep Reflect

- **DR context enrichment**: The current DR dispatch sends raw KV prefixes
  (`pattern:*`, `experience:*`, `desire:*`, `principle:*`, `config:defaults`,
  `reflect:1:*`, `last_reflect`). The old in-worker path had richer context
  via `gatherReflectContext` — patron state, communication health, session
  health, selected experiences. Consider adding more context keys to the
  dispatch or building a pre-computed context summary key that drCycle writes
  before dispatching. The v2 S/D prompt is intentionally narrower, but richer
  context could improve DR quality.

- **KV atomic batch write**: A `kvBatchWrite` kernel primitive that writes
  multiple keys atomically (all-or-nothing) would eliminate the partial-apply
  risk in DR result application. Cloudflare KV doesn't support this natively,
  but a soft implementation could: write all values to staging keys, then
  rename atomically (still not truly atomic, but reduces the window).

- **DR depth > 1**: The current spec and implementation only handle depth 1.
  Higher depths (depth 2 reflects on depth 1 outputs) are designed in the
  cognitive architecture spec but not implemented. Each depth would get its
  own `dr:state:N` record with the same state machine.

## Tool Management

- **First-class tool add/remove operations**: Currently adding or removing a tool requires updating multiple KV keys in sync (`tool:*:code`, `tool:*:meta`, `config:tool_registry`, `kernel:tool_grants`, and the governor rebuild). There's no atomic operation for this. A kernel-level `registerTool` / `deregisterTool` method would handle all keys atomically — update the registry, write/delete code+meta, trigger a governor rebuild. The agent could invoke these via `proposal_requests` in deep reflect, and the patron could use them via a script or dashboard action.

## Lessons from Claude Code (Anthropic CLI v2.1.88)

Comparison based on the extracted source at `andrew-kramer-inno/claude-code-source-build`. Claude Code is an interactive developer tool (human drives); Swayambhu is an autonomous agent (drives itself). Different problems, but several patterns transfer.

### Context compaction for act sessions

Claude Code dedicates 11 files to managing context window pressure — auto-compaction, micro-compaction, time-based configuration, post-compact cleanup. Swayambhu's sessions are discrete and short today, but as act sessions get more complex (12-step tool loops, deep context building), earlier context becomes dead weight.

**Idea:** After step N of the agent loop, compress earlier tool-call results into a summary before the next LLM call. Start simple — strip raw tool output and keep a one-line result summary. Especially relevant for deep-reflect at depth 2+ where context is already rich before the agent loop even starts. The kernel's `runAgentLoop` already tracks steps; it could inject a compaction pass at configurable intervals (e.g. every 4 steps).

### Lightweight dream mode

Claude Code has `DreamTask` and `autoDream` with consolidation locks — background autonomous processing for memory consolidation between active interactions. Conceptually similar to deep-reflect but much cheaper and lighter.

**Idea:** A "dream" session type that runs between act sessions on a fast/cheap model. No tools, no proposals, no communication. Just reads recent mu and epsilon entries and produces consolidation outputs: merge redundant mu counters, flag epsilon clusters for deep-reflect attention, pre-compute embedding caches. Runs at near-zero cost (single cheap LLM call). Complements deep-reflect without replacing it — dream handles housekeeping so deep-reflect can focus on cognitive updates. Could be triggered by a mu/epsilon growth threshold or simply run every N sessions.

### KV migration framework

Claude Code has explicit model version migrations as migration files, similar to database migrations. Swayambhu currently handles schema changes through `--reset-all-state` which wipes everything.

**Idea:** Migration scripts in `scripts/migrations/` with sequential numbering: `001_add_desires.mjs`, `002_assumption_ttl.mjs`, etc. A `kernel:schema_version` KV key tracks which migrations have run. The seed script runs pending migrations on `--reset-all-state`. The governor runs them on deploy (for production). Each migration is a function that receives a KV interface and performs reads/writes/deletes. Reversible migrations include a `down()` function. This prevents "wipe and re-seed" from being the only upgrade path — important as real agents accumulate state that can't be recreated.

### Feature flags via governor

Claude Code uses ~90 compile-time `feature('FLAG_NAME')` toggles for dead-code elimination. Swayambhu's governor builds `index.js` dynamically but doesn't have a feature flag system.

**Idea:** A `config:features` KV key (object of flag → boolean). Governor reads it during `generateIndexJS()` and conditionally includes/excludes imports. Use cases: disable a broken tool without a full rollback, enable experimental providers for testing, gate channels (e.g. WhatsApp only when credentials exist). Lighter than a full rollback, more granular than the current all-or-nothing build.

### Worktree-based code testing in governor

Claude Code has first-class git worktree support for isolated parallel work. Swayambhu's governor deploys staged code and relies on crash tripwire for rollback — deploy first, detect breakage after.

**Idea:** Governor creates a temporary worktree, applies staged code changes, runs `npm test` in the worktree. Only proceeds to deploy if tests pass. Falls back to current version if tests fail, marks proposals as `failed` with test output. More expensive per deploy cycle but catches breakage *before* it reaches production. The crash tripwire becomes a second safety net rather than the primary one.

### Team/swarm coordination (future)

Claude Code has `teamMemorySync`, `InProcessTeammateTask`, and swarm initialization — multi-agent coordination built into the architecture. Swayambhu is single-agent today but has `spawn_subplan` as a concept.

**Idea:** Low priority now. When subagent spawning is implemented, the KV namespace is a natural shared state layer. Each subagent could get a scoped KV prefix (`subagent:{id}:*`) with read access to parent state. The parent agent's review phase would drain subagent results. Claude Code's model of "in-process teammate" (shared memory, coordinated tasks) vs "remote agent" (independent, async) maps well to Swayambhu's act-session vs event-driven patterns.
