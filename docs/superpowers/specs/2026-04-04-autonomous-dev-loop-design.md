# Autonomous Dev Loop

## Purpose

An autonomous system that continuously tests and improves Swayambhu by
triggering sessions, analyzing results, probing the agent's self-correction
capacity, and fixing root constraints. Runs indefinitely until there is
nothing left to do, all remaining work is blocked on human approval, or
the daily budget is exhausted.

## Core Philosophy

**Bugs are probes, not problems.** When the dev loop finds an issue, the
first question is not "how do we fix this?" but "can the agent fix this
itself?" If it can't, the real question becomes: *why not?* What
information is missing, what capability is absent, what feedback loop is
broken? Fix the deepest constraint, not the surface symptom.

**Default posture: probe deeper.** But when a fix is obvious, safe, and
low blast radius — just do it. Reserve deep probing for issues where the
agent *should* be able to handle it but can't.

**The agent should be becoming:** a proactive collaborator that notices
what's happening, contributes without being asked, handles ad-hoc
requests, works on projects autonomously, and uses spare time to improve
its own capabilities. These are observation targets tracked over time,
not automated metrics (yet).

## Pipeline: 5 Decision Stages

```
OBSERVE → CLASSIFY → EXPERIMENT → DECIDE → VERIFY
```

### Stage 1: OBSERVE

Trigger a session and collect evidence.

**Session strategy** — the orchestrator decides how to trigger based on
current state and what's being tested:

| Strategy | When | Command |
|----------|------|---------|
| Accumulate | Default. Testing self-correction, learning, pattern evolution. Needs state continuity across sessions. | `curl localhost:8787/__scheduled` |
| Cold start | Testing bootstrap (empty patterns/desires → first experience → DR). After schema-breaking code changes. After state corruption. | `bash scripts/start.sh --reset-all-state --trigger` |
| Partial reset | Clearing specific state (e.g. wipe experiences but keep config, clear schedule to force immediate session). | `node scripts/delete-kv.mjs <key>` then trigger |
| Config override | Testing with different models/effort/budget. | `bash scripts/start.sh --reset-all-state --set act.model=deepseek --trigger` |

The orchestrator tracks which strategy was used in `observation.json` so
analysis can account for it. Cold start sessions are expected to have
empty patterns and maximum surprise — that's correct behavior, not a bug.

**Data collection:**
- Start services if not running (`scripts/start.sh`)
- Trigger session using chosen strategy, wait for completion
- Run `scripts/analyze-sessions.mjs --last 1` for karma data
- Screenshot dashboard UI via headless browser (all tabs)
- Collect: karma records, session summary, reflections, desires,
  patterns, experiences, cost, LLM call count, tool results

**Session completion detection:**
Poll `session_counter` via `scripts/read-kv.mjs` — when it increments
from the pre-trigger value, the tick completed. Timeout after 5 minutes
(sessions typically complete in 30-120s). Note: a tick that skips act
(schedule-gated) still increments the counter — check karma for the
new session ID to confirm an act session actually ran.

Output: `runs/{timestamp}/observation.json` + UI screenshots.

### Stage 2: CLASSIFY

Score each issue found and deduplicate against known issues. This is
where the cognitive architecture audit runs — evaluating entity health,
operator output, feedback loops, and architectural boundaries.

**Issue taxonomy (single model, no two-track split):**

```json
{
  "id": "fingerprint-hash",
  "summary": "...",
  "locus": "userspace | kernel | ui | prompt | eval | tools | comms",
  "severity": "low | medium | high | critical",
  "self_repairability": 0.0-1.0,
  "blast_radius": "local | module | system",
  "evidence_quality": "strong | moderate | weak",
  "reproducibility": "deterministic | intermittent | unknown",
  "confidence": 0.0-1.0,
  "evidence": [],
  "status": "observed | experimenting | diagnosed | fixing | verified | closed | quarantined",
  "probe_budget": { "sessions_allowed": 3, "sessions_used": 0 },
  "root_cause_chain": []
}
```

**Evidence quality scoring:**
- **Strong**: directly observed in karma/KV data, reproducible,
  root cause identified. Example: parse error in karma log with
  stack trace.
- **Moderate**: observed but not fully explained, or observed once
  without reproduction attempt. Example: desire worded as avoidance
  in a single session.
- **Weak**: inferred from indirect signals, not directly observed.
  Example: "patterns seem stale" without comparing across sessions.

Fingerprinting: SHA-256 of `locus + ':' + normalized_summary` (lowered,
trimmed, stopwords removed). On classify, check all existing
`probes/*.json` — if fingerprint matches, update the existing issue
(append evidence, bump sessions_used) rather than creating a new one.

Output: new/updated issues in `probes/{issue-id}.json`.

### Stage 3: EXPERIMENT

What happens depends on classification:

**Agent-domain issues (self_repairability > 0.3):**
Run bounded trials — trigger more sessions and observe whether the agent
self-corrects.

- Deterministic bug: 1 repro confirms the issue
- Intermittent: up to N sessions (default 3), quarantine if unresolved
- Self-improvement probe: compare baseline session behavior vs
  post-session behavior on the same issue class

If the agent self-corrects: close the issue, record as evidence of
working self-improvement. If not: diagnose *why* — what constraint
prevents self-correction? Add to `root_cause_chain`.

**UI / patron-facing / accumulated bugs:**
Propose a direct fix. Score against quality lenses.

**All proposals go through adversarial challenge (Claude vs Codex):**

Challenge protocol:
- Claude writes proposal as a structured prompt describing: the issue,
  proposed fix, affected files, quality lens assessment
- Codex receives via:
  `codex exec --full-auto -m gpt-5.4 "Challenge this proposal: {proposal}"`
- Max 2 rounds per proposal
- Each round must introduce a new falsifiable objection
- Terminate when objections are resolved, downgraded, or escalated
- Both sides argue from the quality lenses and design principles

Output: `runs/{timestamp}/experiment.json` with challenge transcript.

### Stage 4: DECIDE

Route based on evidence threshold relative to blast radius:

| Blast radius | Required evidence | Action |
|-------------|-------------------|--------|
| Local | Moderate+ | Auto-apply if `npm test` passes |
| Module | Strong | Apply + note in report |
| System / kernel | Strong + converged challenge | Escalate to Swami via Slack + email |

**Evidence threshold rule:** no proposal is applied unless its supporting
evidence crosses the threshold appropriate to its blast radius.

For escalated items: send proposal + reasoning + quality lens scores +
challenge transcript to Swami. Continue working on other issues while
waiting. Pick up replies asynchronously in next cycle.

**Approval protocol:**

Each pending approval gets a unique ID (e.g. `devloop-{timestamp}-{seq}`).
The message to Swami includes this ID prominently:

```
[DEVLOOP] Approval request: devloop-1712234567-01

Issue: {summary}
Proposal: {description}
Blast radius: system
Evidence: {evidence summary}
Challenge result: {converged/escalated}

Reply with: APPROVE devloop-1712234567-01
            REJECT devloop-1712234567-01 {reason}
```

Comms prefixed with `[DEVLOOP]` for approval requests. Can also use
Swami's Slack/email for testing comms issues (prefix `[TESTING]`).

**Reply parsing:**
- Check Slack messages and email for replies containing the approval ID
- `APPROVE {id}` → move `queue/pending/{id}.json` to `queue/approved/`
- `REJECT {id} {reason}` → move to `queue/rejected/` with reason
- Free-form replies with the ID → treat as conversation, re-prompt
  with clarification
- No match → ignore (not a dev loop reply)
- Dedup: once an ID is approved/rejected, further replies are ignored

Output: applied changes committed to git, pending items in
`queue/pending/`.

### Stage 5: VERIFY

After every applied change:

- Run `npm test`
- Trigger a targeted repro session (or full session if needed)
- Confirm the issue is resolved
- If regression detected: rollback the commit, reopen the issue,
  escalate if needed

Output: verification result in `runs/{timestamp}/verification.json`.

## Evaluation Criteria

### Quality Lenses

Applied by both Claude (proposer) and Codex (challenger) when evaluating
proposals and agent behavior:

- **Elegance** — is the solution clean and natural, or forced/hacky?
- **Generality** — does it solve the class of problem, not just this instance?
- **Robustness** — does it handle edge cases and degrade gracefully?
- **Simplicity** — is it the simplest thing that could work?
- **Modularity** — are concerns properly separated?

### Design Principles

- **Kernel/userspace boundary** — is cognitive policy leaking into
  infrastructure, or vice versa?
- **Self-improving agent** — could the agent have caught and fixed this
  itself? What's preventing it?
- **Communication boundary** — act/plan never references comms tools
- **KV tier discipline** — write permissions correct per tier
- **Prompt framing voice** — uses the system's own voice (impressions,
  gaps, magnification)

### Life-Process Quality

Does the architecture allow complex behavior to emerge organically from
simple foundations? Is behavior generative rather than prescriptive? A
fix that adds a special case fails this lens. A fix that removes a
constraint so the agent naturally reaches the right behavior passes it.

### Capability Dimensions (observation targets)

Track qualitative evidence over time of the agent becoming:

| Dimension | What to observe |
|-----------|----------------|
| Proactivity | Initiates useful actions without being asked |
| Contextual awareness | Understands what Swami is working on and why |
| Collaboration quality | Suggestions are genuinely useful, not generic |
| Responsiveness | Handles ad-hoc Slack requests well mid-session |
| Autonomy | Takes a project and runs with it independently |
| Self-improvement | Uses downtime to improve its own capabilities |

## Cognitive Architecture Audit

The most important function of the OBSERVE and CLASSIFY stages. Every
cycle, the dev loop evaluates whether the cognitive architecture is
working as designed — not just whether sessions run without errors, but
whether the cognitive entities are well-formed, the operators are
producing meaningful output, and the feedback loops are closing.

Data collection happens in OBSERVE. Scoring and issue creation happens
in CLASSIFY.

### Entity Health Checks

**Desires** — Are they actually desires?
- Direction is approach-only (never avoidance: "avoid X", "stop Y")
- First-person target state ("I have X", "my work advances Y")
- NLI-evaluable against outcomes (not vague: "be better")
- Actionable through own effort (not external: "patron notices me")
- Grounded in at least one principle (source_principles populated)
- Not redundant with an existing principle
- Evolving over time — fulfilled desires should spawn broader ones,
  not just sit there unchanged

**Patterns** — Are they actually impressions?
- Describe recurring behavior, not temporal state ("Slack is down
  right now" is a circumstance, not a pattern)
- Strength 0-1 reflects confirmation rate (not stuck at 0 or 1)
- Strength trajectory makes sense (confirmed patterns rise, violated
  ones decay via EMA)
- Text is causal, not correlational ("APIs timeout under load" not
  "API was slow today")
- Low-strength patterns actually get deleted (threshold 0.05 working)
- No duplicate patterns saying the same thing differently

**Experiences** — Are they salient and well-formed?
- Rich narrative explaining what happened and why it mattered
  (not "things went okay")
- Surprise and salience scores present and justified
- Outcome matches actual tool results (eval pipeline not hallucinating)
- Embedding present (inference service working)
- Not recording low-signal noise (salience threshold effective)
- Not missing high-signal events (threshold not too aggressive)

**Tactics** — Are they situation-specific rules?
- Contextual ("when X, do Y"), not universal (that's a principle)
- Grounded in patterns from actual experiences
- source_principles populated
- Not stale — retired when superseded

### Operator Health Checks

**A operator (act)** — Is planning working?
- Plans are grounded in active desires (not random actions)
- Plans reference relevant patterns (pattern-informed decisions)
- Plans are completable within session budget
- `no_action` returned when genuinely nothing to do (not as escape)
- Success criteria are specific and observable

**S operator (deep-reflect)** — Are patterns evolving?
- Creates new patterns when experiences reveal recurring observations
- Refines pattern text when understanding improves
- Deletes patterns that are mostly violated
- Consolidates near-duplicate patterns
- Doesn't create temporal state as patterns

**D operator (deep-reflect)** — Are desires magnifying?
- Creates new desires when old ones are fulfilled (expansion)
- Doesn't terminate fulfilled desires (magnification, not completion)
- New desires are broader/deeper than predecessors
- Negative experiences produce approach inversions, not avoidance
- Principles shape direction (care → "for others' benefit")

**T operator (deep-reflect)** — Are tactics useful?
- Created from repeated patterns in experiences
- Retired when superseded or stale
- Actually influence plan phase behavior

### Session Reflect Health

- Produces meaningful session_summary (not generic/vague)
- note_to_future_self carries genuine continuity (not boilerplate)
- next_act_context.load_keys are relevant (not loading everything)
- Task carry-forward works (tasks from last_reflect persist and
  get updated across sessions)
- kv_operations are appropriate (not writing to protected keys,
  not making destructive changes)
- Schedule adjustments are sensible (not scheduling too aggressively
  or too passively)

### Deep Reflect Lifecycle Health

- **Dispatch**: DR triggers on schedule (after N sessions or M days)
- **Execution**: Job runs on Akash, produces structured output
- **Application**: Results applied to pattern:* and desire:* keys
- **State machine**: `dr:state:1` transitions correctly
  (idle → dispatched → completed → applied → idle)
- **Stale job recovery**: if a job is stuck in dispatched state
  for too long, it gets cleaned up
- **Cost**: DR jobs use Anthropic subscription (zero OpenRouter cost)

### Feedback Loop Health

**Eval pipeline** — Is the measurement system working?
- Tier 1 (embeddings) filters to a reasonable subset of patterns
- Tier 2 (NLI) resolves most remaining pairs
- Tier 3 (LLM) handles edge cases only (if called too often,
  patterns may be poorly worded or NLI model inadequate)
- Degraded fallback is rare
- Surprise scores correlate with actual surprisingness
- Affinity vectors non-empty when desires exist

**EMA strength updates** — Is learning happening?
- Pattern strengths move in expected direction after
  confirmation/violation
- α_ema parameter (0.3) producing reasonable adaptation speed
- Not oscillating wildly (pattern text too vague?)
- Not frozen (patterns never tested? embedding relevance issue?)

**Experience → DR → Desire/Pattern loop** — Is the cycle closing?
- Experiences actually get read by deep-reflect
- DR output actually changes patterns and desires
- Changed patterns actually influence next session's planning
- Changed desires actually precipitate different actions

**Cold start** — Does bootstrapping work?
- Empty patterns → σ=1 (maximum surprise)
- High salience → experience recorded
- DR triggered → initial patterns and desires created
- Second session plans from newly created desires

### Event and Communication Health

- Events drain correctly each tick (not accumulating)
- Dead-lettered events are investigated (not silently dropped)
- Communication events route to correct channels
- Delivery confirmations received (not fire-and-forget)
- Chat system handles inbound messages correctly

### Architectural Boundary Checks

- **Kernel as infrastructure** — kernel.js is cognitive-architecture-
  agnostic. It provides primitives (KV, LLM, tools, events) without
  knowing about desires, patterns, or the act/reflect cycle. If
  cognitive concepts appear in kernel.js, that's a boundary violation.
- **Communication boundary** — act/plan never references send_slack,
  send_whatsapp, send_email. Communication flows through events.
- **KV tier discipline** — agent writes stay in agent tier,
  protected writes use kvWriteGated with privilege context,
  immutable keys never written
- **Prompt voice** — prompts use the system's own framing:
  "impressions" not "encodings", "gaps" not "goals",
  "magnification through principles" not "evolution"

### What to Do With Findings

Each finding from the cognitive audit is classified:

| Finding type | Example | Action |
|-------------|---------|--------|
| Malformed entity | Avoidance desire, temporal pattern | Probe: can DR fix this? If not, why? |
| Silent operator | S creates 0 patterns despite rich experiences | Root constraint: prompt issue? Context too small? |
| Broken feedback | Strength never updates | Root constraint: eval pipeline, embedding, or config |
| Boundary violation | Cognitive logic in kernel | Direct fix (architectural, may need approval) |
| Prompt drift | "Goals" instead of "gaps" in output | Prompt fix (medium significance) |
| Stale lifecycle | DR stuck in dispatched state | Investigate: Akash job status, state machine bug |
| Healthy operation | Desires expanding, patterns confirming | Record as positive evidence |

## State Model

```
.swayambhu/dev-loop/              (gitignored — operational state)
  state.json                      orchestrator: current cycle, cash budget
                                  spent today, phase, heartbeat,
                                  stage failure counters

  probes/
    {issue-id}.json               issue being tracked: taxonomy fields,
                                  evidence, probe history, root cause
                                  chain, status

  queue/
    pending/{id}.json             awaiting Swami's approval (includes
                                  approval ID for reply correlation)
    approved/{id}.json            approved, ready to apply
    rejected/{id}.json            rejected with reason

  runs/
    {timestamp}/
      observation.json            stage 1 output
      classification.json         stage 2 output
      experiment.json             stage 3 output (incl challenge transcript)
      applied.json                stage 4 output
      verification.json           stage 5 output
      report.md                   human-readable cycle summary

  metrics/
    cumulative.json               cycles run, issues found,
                                  self-corrections observed, root
                                  constraints identified, fixes applied,
                                  capability dimension observations
```

**Why not KV:** the dev loop is CI/CD infrastructure, not agent state.
The agent's KV is its mind. Mixing them blurs the boundary we protect.

**Why not git for operational state:** git is for code history. Endless
report/queue commits pollute history. Applied code changes go through
git; operational artifacts stay on disk.

## Orchestrator

A single coordinator script (`scripts/dev-loop.sh` or
`scripts/dev-loop.mjs`) that:

1. Loads state (budget spent, pending probes, approval queue)
2. Checks for approval responses (Slack/email replies from Swami)
3. If approved items exist: apply them → verify
4. Runs one cycle: observe → classify → experiment → decide → verify
5. Writes report, updates metrics
6. Checks stop conditions
7. Loops (or stops)

**Stop conditions:**
- Clean observation + no probes pending + no fixes pending
- All remaining work blocked on human approval
- Daily budget ($5) exhausted
- Ctrl-C / SIGTERM

**Self-monitoring (watchdog):**
- Heartbeat written to `state.json` every cycle
- Stuck-run detection: if heartbeat age > 2x expected cycle time, alert
- Stale approval cleanup: if pending item age > 48h, re-notify or close
- Per-stage failure tracking: each stage has a consecutive failure
  counter in `state.json`. If a stage fails 3 times in a row, it is
  disabled and an alert is sent to Swami. The loop continues with
  remaining stages. Disabled stages can be re-enabled by resetting
  the counter in `state.json`.

## Budget

**Cash budget** — tracks actual money spent via OpenRouter API calls.
Subscription-backed work (Claude Code, Codex, Akash DR) is uncapped
since it uses existing subscriptions at no marginal cost.

Cost sources:
- Session models (mimo/minimax): cheap, ~$0.01-0.05 per session
- Deep reflect on Akash: zero cash cost (Anthropic subscription)
- Claude Code analysis: zero cash cost (subscription)
- Codex challenge: zero cash cost (ChatGPT Pro subscription)
- Slack/email notifications: zero cash cost

Daily cash cap: $5 (tracked in `state.json`, resets at midnight UTC).
Primarily constrains number of probe sessions per day.

## Interfaces

Concrete commands and mechanisms for each external dependency.

### Session triggering

```bash
# Accumulate (existing state)
curl -s http://localhost:8787/__scheduled

# Cold start
bash scripts/start.sh --reset-all-state --trigger

# Config override
bash scripts/start.sh --reset-all-state --set act.model=deepseek --trigger

# Partial reset (clear specific keys, then trigger)
node scripts/delete-kv.mjs session_schedule
curl -s http://localhost:8787/__scheduled
```

### Session completion detection

Poll `session_counter` — canonical completion signal:
```bash
# Before trigger: capture current session count
BEFORE=$(node scripts/read-kv.mjs session_counter)

# After trigger: poll until counter increments or timeout (5 min)
TIMEOUT=300; ELAPSED=0
while [ "$(node scripts/read-kv.mjs session_counter)" = "$BEFORE" ]; do
  sleep 5; ELAPSED=$((ELAPSED + 5))
  [ $ELAPSED -ge $TIMEOUT ] && echo "TIMEOUT" && break
done

# Confirm an act session ran (not just a schedule-skipped tick)
node scripts/read-kv.mjs cache:session_ids  # check for new session ID
```

### Dashboard screenshots

Via the `/browse` skill (Claude Code) or a puppeteer script. Dashboard
SPA runs on port 3001 locally (tunneled to 8080 for remote access):
```bash
# Using browse skill (from Claude Code)
# Navigate to localhost:3001, screenshot each tab

# Or via puppeteer/playwright script for automation
node scripts/screenshot-dashboard.mjs --port 3001 --output runs/{timestamp}/
```

### Adversarial challenge

```bash
codex exec --full-auto -m gpt-5.4 \
  "Challenge this proposal. Find flaws. You have max 2 rounds.
   Each objection must be new and falsifiable.
   Evaluate against: elegance, generality, robustness, simplicity, modularity.
   
   PROPOSAL:
   {proposal_json}"
```

### Approval messaging and reply checking

The dev loop uses its own lightweight adapter for Slack/email — not
the agent's comms tools (those are agent-internal, routed through
events). The adapter is a small Node.js module
(`scripts/dev-loop/comms.mjs`) that:

- **Sends** via Slack Web API (`chat.postMessage`) and Gmail API
  (using the existing OAuth refresh token from `scripts/gmail-auth.mjs`)
- **Checks replies** via Slack `conversations.history` and Gmail
  `messages.list` with query filters
- **Parses** `APPROVE {id}` / `REJECT {id} {reason}` from reply text
- **Deduplicates** by tracking processed message IDs in `state.json`

```bash
# Send approval request
node scripts/dev-loop/comms.mjs send \
  --channel slack,email \
  --id devloop-1712234567-01 \
  --body "proposal summary..."

# Check for replies
node scripts/dev-loop/comms.mjs check \
  --since "2026-04-04T12:00:00Z"
# Returns JSON: [{ id: "devloop-...", action: "approve|reject", reason: "..." }]
```

## Implementation Notes

### What this is NOT

This is not a second cognitive architecture. Deep reflect operates
*within* the agent on its own experiences. The dev loop operates
*outside*, evaluating the system holistically — including things the
agent cannot see (UI rendering, test suite results, architectural drift,
cross-module consistency).

### Relationship to existing tools

| Existing tool | How dev loop uses it |
|--------------|---------------------|
| `scripts/start.sh` | Stage 1: trigger sessions |
| `scripts/analyze-sessions.mjs` | Stage 1: gather karma data |
| `scripts/rollback-session.mjs` | Stage 5: rollback on regression |
| `/browse` skill | Stage 1: UI screenshots |
| `/codex challenge` | Stage 3: adversarial review |
| `npm test` | Stage 4+5: gate for auto-apply |
| Slack/email channels | Stage 4: approval requests + comms testing |

### Execution environment

Runs on Swami's dev machine. Claude Code orchestrates analysis/proposals.
Codex CLI handles adversarial challenge. Sessions run via local wrangler
dev. Dashboard screenshots via headless browser.
