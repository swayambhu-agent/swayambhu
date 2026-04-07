# /dev-loop — Autonomous Dev Loop

You are running the autonomous dev loop for Swayambhu. Your job is to
trigger sessions, deeply analyze cognitive architecture health, propose
fixes, challenge them with Codex, and apply or escalate.

Read the full spec before starting:
`docs/superpowers/specs/2026-04-04-autonomous-dev-loop-design.md`

---

## Cycle Structure

Each cycle has 6 stages. You handle stages 3-6 directly.

### Stages 1-2: OBSERVE + CLASSIFY (plumbing)

Run this and wait for it to complete:

```bash
source .env && node scripts/dev-loop/loop.mjs --once
```

Note the run directory path from the output (e.g. `runs/2026-04-04T14-41-47-453Z/`).
The script triggers a session, waits for completion, runs mechanical checks,
and writes `context.json`.

For a fresh start (wipe and re-seed state):
```bash
source .env && node scripts/dev-loop/loop.mjs --once --cold-start
```

For a one-off deep-reflect model comparison on the current live snapshot:
```bash
source .env && node scripts/dev-loop/dr-compare.mjs
```

This writes a frozen DR snapshot plus runner outputs under:
`/home/swami/swayambhu/dev-loop/runs/{timestamp}/dr-compare/`

### Stage 3: ANALYZE (your job — deep reasoning)

Read `context.json` from the run directory:
`/home/swami/swayambhu/dev-loop/runs/{timestamp}/context.json`

This contains the full session data: karma, desires, patterns, experiences,
tactics, config, prompts, last_reflect, DR state, rubric, and mechanical
issues from classify.

**CRITICAL: context.json is the TEST SUBJECT, not the source of truth.**
Everything in it — desires, patterns, experiences, tactics, karma,
reflections — is the agent's output. It is what you are evaluating.
Using it as ground truth defeats the entire purpose of the test.

Your two sources of truth are:
1. **The code** — read the actual source files (eval.js, kernel.js,
   act.js, userspace.js, reflect.js, prompts/*.md, config/*.json)
   to understand what the system SHOULD be doing
2. **The evaluation criteria** — the quality lenses, design principles,
   and cognitive audit rubric define what GOOD looks like

Then compare: does the agent's output (context.json) match what the
code and criteria say should be happening? Where it diverges, that's
a finding. The diagnosis comes from the code, not from the agent's
self-description.

**AFTER your analysis:** if any findings look surprising or implausible,
do a final self-check — is the dev loop's own data reliable?
- Does karma look complete? (Should have act_start, plan, act steps,
  eval, review, reflect — not just act_start)
- If karma looks truncated, verify by reading the karma key directly
  via dashboard API — the bug may be in observe.mjs or analyze-sessions,
  not the agent.
- Are counts plausible given session count and DR history?
- Is context.json populated? (Not empty `{}`)

The observer can be the bug. Check the tool when the data looks wrong.

Analyze against the cognitive architecture audit rubric:

**Entity Health:**
- Desires: approach-only? first-person? NLI-evaluable? principle-grounded? evolving over time?
- Patterns: recurring behavior not temporal state? strength trajectory sensible? no duplicates?
- Experiences: rich narrative? surprise/salience justified? embeddings present?
- Tactics: contextual ("when X do Y")? principle-grounded? not stale?

**Operator Health:**
- A (plan): desire-grounded plans? pattern-informed? budget-feasible? meaningful success criteria?
- S (patterns): creating/refining/deleting appropriately in DR?
- D (desires): magnifying on fulfillment? approach inversions for negative? principle-shaped?
- T (tactics): useful behavioral rules emerging from experience?

**Feedback Loops:**
- Eval pipeline: tier distribution reasonable? surprise correlates with actual surprisingness?
- EMA strength: patterns moving in expected direction?
- Experience → DR → Desire/Pattern cycle: is it actually closing?
- Cold start: bootstrap working? (empty → max surprise → experience → DR → initial desires/patterns)

**Session Reflect + DR Lifecycle:**
- Meaningful summaries? Genuine continuity in note_to_future_self?
- DR dispatching on schedule? Results applied to KV?
- Task carry-forward working?

**Architectural Boundaries:**
- Kernel cognitive-architecture-agnostic? (no desires/patterns/actions in kernel.js)
- Communication through events only? (act/plan never references comms tools)
- KV tier discipline correct?
- Prompt voice consistent? (impressions not encodings, gaps not goals)

**Capability Dimensions:**
- Any evidence of: proactivity, contextual awareness, collaboration quality,
  responsiveness, autonomy, self-improvement?

Write findings to `analysis.json` in the run directory:

```json
{
  "summary": "High-level assessment",
  "findings": [
    {
      "type": "malformed_entity|silent_operator|broken_feedback|boundary_violation|prompt_drift|stale_lifecycle|healthy_operation",
      "summary": "What you found",
      "evidence": "Specific data from context.json",
      "locus": "userspace|kernel|ui|prompt|eval|tools|comms",
      "severity": "low|medium|high|critical",
      "self_repairability": 0.0-1.0,
      "blast_radius": "local|module|system",
      "proposed_fix": "What to change" or null,
      "probe_recommended": true/false
    }
  ],
  "capability_observations": {
    "proactivity": "evidence or lack thereof",
    "contextual_awareness": "...",
    "collaboration_quality": "...",
    "responsiveness": "...",
    "autonomy": "...",
    "self_improvement": "..."
  },
  "healthy_signals": ["Things working well"]
}
```

### Stage 3b: INVESTIGATE (when root cause is unknown)

When a finding needs investigation rather than a fix — e.g. a crash
with unknown cause, a silent failure, or behavior that doesn't match
the code — investigate before proposing.

**Steps:**

1. **Read the code path** — trace the exact execution path from the
   evidence. If karma stops at event X, read the code that runs after X.

2. **Check logs** — look for wrangler stderr output. The kernel worker
   writes to stderr with tagged output (`[KARMA]`, `[TOOL]`, `[LLM]`,
   `[HOOK]`). Check for uncaught exceptions, timeouts, OOM.
   ```bash
   # Check recent kernel stderr (if workers are running in background)
   # Or trigger a session and watch stderr live:
   curl -s http://localhost:8787/__scheduled 2>&1
   ```

3. **Reproduce** — trigger another session and watch what happens at
   the exact failure point. Add temporary logging if needed.

4. **Narrow down** — is it a code exception? A process timeout? An
   OOM? A race condition? Each has different evidence:
   - Code exception: kernel catch records `fatal_error` karma + execution_health
   - Process timeout: no execution_health, karma stops mid-pipeline, worker restarts
   - OOM: similar to timeout but may have system-level evidence
   - Race condition: intermittent, different failure points across sessions

5. **Write investigation findings** to `investigation-{seq}.md` in the
   run directory with: hypothesis, evidence for/against, confirmed root
   cause, and THEN propose a fix grounded in the actual failure.

Only propose a fix after investigation confirms the root cause. Never
guess — the adversarial challenge will catch you.

### Stage 4: EXPERIMENT (probe + adversarial challenge)

**For probe_recommended findings (self_repairability > 0.3):**
Run more sessions and see if the agent self-corrects. This is the most
important part — bugs are probes into self-improvement capacity.

```bash
source .env && node scripts/dev-loop/loop.mjs --once
```

Up to 3 probe sessions. If the agent self-corrects, close the issue and
record it as evidence of working self-improvement. If not, ask WHY —
what constraint prevents self-correction? This is the real question.

**For findings with proposed_fix:**
Write a proposal file `proposal-{seq}.md` in the run directory with:
- Issue summary + evidence
- Proposed fix + affected files
- Quality lens assessment (elegance, generality, robustness, simplicity, modularity)
- Design principle check (kernel/userspace, self-improving agent, life-process quality)

Then invoke Codex for adversarial challenge (use /codex challenge or):

```bash
codex exec --full-auto "Read the proposal at /home/swami/swayambhu/dev-loop/runs/{timestamp}/proposal-01.md. Challenge it. Find flaws. Each objection must be new and falsifiable. Evaluate against: elegance, generality, robustness, simplicity, modularity, kernel/userspace boundary, self-improving agent principle. Write objections to /home/swami/swayambhu/dev-loop/runs/{timestamp}/challenge-01-round-1.json"
```

Read objections. For each valid one, revise. For invalid ones, defend.
Write responses to `response-{seq}-round-{n}.md`. Max 3 rounds.
Write final `verdict-{seq}.json` with convergence status.

### Stage 5: DECIDE

Route converged proposals by blast radius:

| Blast radius | Evidence needed | Action |
|-------------|----------------|--------|
| Local | Moderate+ | Auto-apply if `npm test` passes |
| Module | Strong | Apply + note in report |
| System/kernel | Strong + converged | Escalate to Swami via Slack+email |

For escalation:
```bash
node scripts/dev-loop/comms.mjs send --channel slack,email --id devloop-{id} --body "{summary}"
```

### Stage 6: VERIFY

After applying any change:
1. Run `npm test`
2. If fail: `git revert HEAD --no-edit`
3. If pass: trigger one more session to verify the fix works in practice

## Overnight Log

Maintain a running log at `/home/swami/swayambhu/dev-loop/overnight-log.md` that
accumulates across cycles. Append to it after each cycle — never
overwrite. This is what Swami reads in the morning.

Format:
```markdown
# Dev Loop Overnight Log

## Cycle N — {timestamp}
**Session:** {id} | **Duration:** {Xs} | **Cost:** ${X}

### Findings
- [severity] locus: summary
- ...

### Actions Taken
- Applied: {description} (commit {sha})
- Escalated: {description} (awaiting approval)
- Probing: {description} (N sessions observed)

### Healthy Signals
- ...

---
```

If no findings in a cycle, just log:
```markdown
## Cycle N — {timestamp}
Clean session. No issues found.
---
```

## End of Cycle: Slack Summary

After each cycle, send a Slack summary to Swami:

```bash
node scripts/dev-loop/comms.mjs send --channel slack --id devloop-cycle-{N} --body "{summary}"
```

The summary should include:
- Cycle number and timestamp
- Session ID and duration
- Number of findings (by severity)
- Actions taken (fixes applied, proposals escalated, probes started)
- Healthy signals observed
- Next action (continuing / stopping / waiting for approval)

Keep it concise — 5-10 lines max. Swami will read these on his phone.

## Looping

After sending the summary, check:
- More issues to probe or fix? → Run another cycle (go to Stages 1-2)
- All clean for 3 consecutive cycles? → Stop
- All blocked on approvals? → Stop
- Budget exhausted? → Stop

## Philosophy

- Bugs are probes into self-improvement capacity, not problems to fix
- Default posture: probe deeper — WHY can't the agent fix this itself?
- Only intervene at the deepest constraint level
- Life-process quality: do the rules allow complex behavior to emerge from simple foundations?
