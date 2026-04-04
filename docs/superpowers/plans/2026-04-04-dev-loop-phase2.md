# Dev Loop Phase 2: CC Skill + Deep Analysis

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the dev loop from a script that does mechanical checks into a Claude Code skill that does deep cognitive analysis and adversarial review with Codex.

**Architecture:** `loop.mjs` handles plumbing (OBSERVE + CLASSIFY + context assembly). A CC command (`/dev-loop`) orchestrates the intelligent stages (ANALYZE + EXPERIMENT + DECIDE + VERIFY) by reading `context.json`, reasoning about it, invoking Codex for challenge, and applying fixes.

**Tech Stack:** Node.js (ESM), Claude Code commands (markdown), Codex CLI, dashboard API for KV reads

**Spec:** `docs/superpowers/specs/2026-04-04-autonomous-dev-loop-design.md`

**Depends on:** Phase 1 (complete) — state.mjs, comms.mjs, observe.mjs, classify.mjs, decide.mjs, verify.mjs, loop.mjs, rubric.json

---

## File Structure

```
scripts/dev-loop/
  context.mjs           — assembles context.json from dashboard API data
  loop.mjs              — UPDATED: writes context.json after CLASSIFY

.claude/commands/
  dev-loop.md           — CC skill: orchestrates ANALYZE → EXPERIMENT → DECIDE → VERIFY
```

---

### Task 1: Context Assembly Module

**Files:**
- Create: `scripts/dev-loop/context.mjs`
- Create: `tests/dev-loop/context.test.js`

Assembles the full context package for CC analysis by reading all
relevant data from the dashboard API and local files.

- [ ] **Step 1: Write failing tests**

```js
// tests/dev-loop/context.test.js
import { describe, it, expect } from 'vitest';
import { buildContextFromAnalysis } from '../../scripts/dev-loop/context.mjs';

describe('context', () => {
  it('assembles context with meta fields', () => {
    const ctx = buildContextFromAnalysis({
      analysis: {
        session_counter: 5,
        desires: { 'desire:test': { slug: 'test' } },
        patterns: {},
        experiences: {},
        karma: {},
        defaults: { act: { model: 'mimo' } },
        last_reflect: {},
        dr_state: null,
      },
      sessionId: 'x_123',
      cycle: 3,
      strategy: 'accumulate',
      mechanicalIssues: [{ id: 'abc', summary: 'test issue' }],
    });

    expect(ctx.meta.cycle).toBe(3);
    expect(ctx.meta.strategy).toBe('accumulate');
    expect(ctx.meta.scope).toBe('current_snapshot');
    expect(ctx.meta.generated_at).toBeTruthy();
    expect(ctx.session_id).toBe('x_123');
    expect(ctx.desires).toEqual({ 'desire:test': { slug: 'test' } });
    expect(ctx.mechanical_issues).toHaveLength(1);
  });

  it('includes rubric from file', () => {
    const ctx = buildContextFromAnalysis({
      analysis: { desires: {}, patterns: {}, experiences: {}, karma: {}, defaults: {} },
      sessionId: 'x_1',
      cycle: 1,
      strategy: 'cold_start',
      mechanicalIssues: [],
    });

    expect(ctx.rubric).toBeTruthy();
    expect(ctx.rubric.quality_lenses).toBeTruthy();
    expect(ctx.rubric.design_principles).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dev-loop/context.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement context module**

```js
// scripts/dev-loop/context.mjs
// Assembles context.json for CC deep analysis.
// Transforms analyze-sessions.mjs output + mechanical issues + rubric
// into the context package defined in the spec.

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadRubric() {
  return JSON.parse(readFileSync(join(__dirname, 'rubric.json'), 'utf-8'));
}

export function buildContextFromAnalysis({
  analysis,
  sessionId,
  cycle,
  strategy,
  mechanicalIssues,
}) {
  return {
    meta: {
      generated_at: new Date().toISOString(),
      cycle,
      strategy,
      scope: 'current_snapshot',
    },
    session_id: sessionId,
    karma: analysis.karma || {},
    desires: analysis.desires || {},
    patterns: analysis.patterns || {},
    experiences: analysis.experiences || {},
    tactics: analysis.tactics || {},
    config: {
      defaults: analysis.defaults || {},
      models: analysis.models || {},
    },
    prompts: analysis.prompts || {},
    last_reflect: analysis.last_reflect || null,
    dr_state: analysis.dr_state || null,
    session_health: analysis.session_health || null,
    rubric: loadRubric(),
    mechanical_issues: mechanicalIssues || [],
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dev-loop/context.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/dev-loop/context.mjs tests/dev-loop/context.test.js
git commit -m "feat(dev-loop): add context assembly module for CC analysis"
```

---

### Task 2: Update loop.mjs to Write context.json

**Files:**
- Modify: `scripts/dev-loop/loop.mjs`

After CLASSIFY, assemble and write `context.json` so CC can read it.
Also load prompts from dashboard API to include in context.

- [ ] **Step 1: Add context assembly to loop.mjs**

After the CLASSIFY block in `runCycle`, add:

```js
import { buildContextFromAnalysis } from './context.mjs';

// ... after classify block:

// ── BUILD CONTEXT ──
// Assemble full context package for CC deep analysis
if (observation && classification) {
  const context = buildContextFromAnalysis({
    analysis: observation.analysis,
    sessionId: observation.latest_session_id,
    cycle: state.cycle,
    strategy: observation.strategy,
    mechanicalIssues: classification.issues || [],
  });
  await saveRun(STATE_DIR, timestamp, 'context.json', context);
  console.log(`[LOOP] Context written to runs/${timestamp}/context.json`);
}
```

- [ ] **Step 2: Verify loop still works**

Run: `npx vitest run tests/dev-loop/`
Expected: ALL PASS

Run: `source .env && node scripts/dev-loop/loop.mjs --once`
Expected: see `[LOOP] Context written to runs/...` in output

- [ ] **Step 3: Verify context.json was written**

```bash
ls .swayambhu/dev-loop/runs/*/context.json
cat .swayambhu/dev-loop/runs/*/context.json | python3 -m json.tool | head -20
```

- [ ] **Step 4: Commit**

```bash
git add scripts/dev-loop/loop.mjs
git commit -m "feat(dev-loop): write context.json after classify for CC analysis"
```

---

### Task 3: Claude Code Command (`/dev-loop`)

**Files:**
- Create: `.claude/commands/dev-loop.md`

The CC command is the orchestrator. It runs the plumbing script,
reads the context, does deep analysis, invokes Codex for challenge,
and handles decide/verify. This is a markdown prompt, not code.

- [ ] **Step 1: Create the command file**

```markdown
# /dev-loop — Autonomous Dev Loop

You are running the autonomous dev loop for Swayambhu. Your job is to
trigger sessions, deeply analyze cognitive architecture health, propose
fixes, challenge them with Codex, and apply or escalate.

## How This Works

1. Run `node scripts/dev-loop/loop.mjs --once` to trigger a session and
   run mechanical checks (OBSERVE + CLASSIFY)
2. Read the generated `context.json` from the run directory
3. Perform deep cognitive analysis (ANALYZE)
4. For findings with proposed fixes, invoke Codex for adversarial
   challenge (EXPERIMENT)
5. Route fixes: auto-apply, note, or escalate (DECIDE)
6. Verify applied changes pass tests (VERIFY)
7. Loop until clean or blocked on approvals

## Step 1: OBSERVE + CLASSIFY (plumbing)

Run this command and wait for it to complete:

```bash
source .env && node scripts/dev-loop/loop.mjs --once
```

This triggers a session, waits for completion, runs mechanical checks,
and writes `context.json`. Note the run directory path from the output.

## Step 2: ANALYZE (your job — deep reasoning)

Read the `context.json` file from the run directory. Also read the
cognitive architecture audit rubric from the spec:
`docs/superpowers/specs/2026-04-04-autonomous-dev-loop-design.md`
(section: "Cognitive Architecture Audit")

Analyze the session data against every check in the rubric:

### Entity Health
- **Desires**: approach-only? first-person? NLI-evaluable? principle-grounded? evolving?
- **Patterns**: recurring behavior (not temporal)? strength trajectory sensible? duplicates?
- **Experiences**: rich narrative? surprise/salience justified? embeddings present?
- **Tactics**: contextual rules? principle-grounded? not stale?

### Operator Health
- **A (plan)**: desire-grounded? pattern-informed? budget-feasible?
- **S (patterns)**: creating/refining/deleting appropriately?
- **D (desires)**: magnifying on fulfillment? approach inversions for negative experiences?
- **T (tactics)**: useful? retired when stale?

### Feedback Loops
- Eval pipeline tier distribution reasonable?
- EMA strength updates moving correctly?
- Experience → DR → Desire/Pattern cycle closing?
- Cold start bootstrap working?

### Session Reflect + DR Lifecycle
- Meaningful summaries? Continuity in note_to_future_self?
- DR dispatching on schedule? Results applied?

### Architectural Boundaries
- Kernel cognitive-architecture-agnostic?
- Communication through events only?
- KV tier discipline correct?
- Prompt voice consistent?

### Capability Dimensions
- Proactivity, contextual awareness, collaboration quality,
  responsiveness, autonomy, self-improvement — any evidence?

Write your findings to analysis.json in the run directory using this
format:

```json
{
  "summary": "High-level assessment of this session",
  "findings": [
    {
      "type": "malformed_entity|silent_operator|broken_feedback|boundary_violation|prompt_drift|stale_lifecycle|healthy_operation",
      "summary": "What you found",
      "evidence": "Specific data from context.json supporting this",
      "locus": "userspace|kernel|ui|prompt|eval|tools|comms",
      "severity": "low|medium|high|critical",
      "self_repairability": 0.0-1.0,
      "blast_radius": "local|module|system",
      "proposed_fix": "What to change (or null if probe recommended)",
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
  "healthy_signals": ["List of things working well"]
}
```

## Step 3: EXPERIMENT (probe + adversarial challenge)

For each finding:

**If probe_recommended and self_repairability > 0.3:**
Run more sessions (`node scripts/dev-loop/loop.mjs --once`) and check
if the agent self-corrects. Up to 3 probe sessions. If it self-corrects,
close the issue. If not, diagnose WHY — what constraint prevents self-
correction? This is the most important question.

**If proposed_fix exists:**
Write a proposal file: `proposal-{seq}.md` in the run directory with:
- Issue summary and evidence
- Proposed fix with affected files
- Quality lens assessment (elegance, generality, robustness, simplicity, modularity)
- Design principle check (kernel/userspace boundary, self-improving agent, etc.)

Then invoke Codex for adversarial challenge:

```bash
codex exec --full-auto -m gpt-5.4 "Read the proposal at {path}/proposal-01.md. Challenge it. Find flaws. Each objection must be new and falsifiable. Evaluate against: elegance, generality, robustness, simplicity, modularity, kernel/userspace boundary, self-improving agent principle, life-process quality. Write objections to {path}/challenge-01-round-1.json"
```

Read Codex's objections. For each:
- If valid: revise the proposal, write `response-01-round-1.md`
- If invalid: defend with evidence, write `response-01-round-1.md`

Up to 3 rounds. Write final `verdict-{seq}.json` with convergence status.

## Step 4: DECIDE

For each converged proposal, route based on blast radius:

| Blast radius | Required evidence | Action |
|-------------|-------------------|--------|
| Local | Moderate+ | Auto-apply if `npm test` passes |
| Module | Strong | Apply + note in report |
| System / kernel | Strong + converged | Escalate to Swami via Slack + email |

For escalation, use:
```bash
node scripts/dev-loop/comms.mjs send --channel slack,email --id devloop-{id} --body "{proposal summary}"
```

## Step 5: VERIFY

After applying any change:
1. Run `npm test`
2. If tests fail: `git revert HEAD --no-edit`
3. If tests pass: trigger one more session to verify the fix works

## Looping

After completing a cycle, check:
- Are there more issues to probe or fix? → Run another cycle
- All clean? → Stop
- All blocked on approvals? → Stop
- Budget exhausted ($5/day cash for session models)? → Stop

To run another cycle, go back to Step 1.

## Philosophy Reminders

- Bugs are probes into self-improvement capacity, not problems to fix
- Default posture: probe deeper — WHY can't the agent fix this itself?
- Only intervene at the deepest constraint level
- Quality lenses: elegance, generality, robustness, simplicity, modularity
- Life-process quality: do the rules allow complex behavior to emerge
  from simple foundations?
```

- [ ] **Step 2: Verify the command is discoverable**

```bash
ls .claude/commands/dev-loop.md
```

- [ ] **Step 3: Commit**

```bash
git add .claude/commands/dev-loop.md
git commit -m "feat(dev-loop): add /dev-loop CC command — orchestrates deep analysis + Codex challenge"
```

---

### Task 4: Update analyze-sessions.mjs for Prompts + Tactics

**Files:**
- Modify: `scripts/analyze-sessions.mjs`

The context.json needs prompts and tactics, but analyze-sessions.mjs
doesn't currently collect them. Add these to the output.

- [ ] **Step 1: Add prompt and tactic collection**

In `analyze-sessions.mjs`, add to the parallel data gathering:

```js
// Add to the Promise.all block:
getAll('tactic:'),
// And for prompts, get specific keys:
get('prompt:act'),
get('prompt:reflect'),
get('prompt:plan'),
get('prompt:deep_reflect'),
```

Add them to the output object:

```js
tactics,
prompts: {
  act: promptAct,
  reflect: promptReflect,
  plan: promptPlan,
  deep_reflect: promptDeepReflect,
},
```

This applies to both the Miniflare and dashboard source paths.

- [ ] **Step 2: Verify analyze-sessions still works**

```bash
node scripts/analyze-sessions.mjs --last 1 --source dashboard | python3 -c "import sys,json; d=json.load(sys.stdin); print('tactics:', len(d.get('tactics',{}))); print('prompts:', list(d.get('prompts',{}).keys()))"
```

Expected: `tactics: N` and `prompts: ['act', 'reflect', 'plan', 'deep_reflect']`

- [ ] **Step 3: Commit**

```bash
git add scripts/analyze-sessions.mjs
git commit -m "feat(dev-loop): add tactics and prompts to analyze-sessions output"
```

---

### Task 5: End-to-End Test

- [ ] **Step 1: Run a full dev-loop cycle**

With services running:

```bash
/dev-loop
```

This should:
1. Trigger a session via loop.mjs
2. Write context.json
3. CC reads and analyzes it
4. CC writes analysis.json with findings
5. If findings exist: write proposals, invoke Codex challenge
6. Apply or escalate

- [ ] **Step 2: Verify artifacts were created**

```bash
ls .swayambhu/dev-loop/runs/*/
# Should see: observation.json, context.json, classification.json,
#             analysis.json, report.md
# If proposals: proposal-*.md, challenge-*-round-*.json, verdict-*.json
```

- [ ] **Step 3: Review the analysis quality**

Read `analysis.json` — is the analysis substantive? Does it go deeper
than the mechanical checks? Does it reason about feedback loops,
operator health, capability dimensions?

- [ ] **Step 4: Commit any fixes from the test**

```bash
git add -A scripts/dev-loop/ .claude/commands/
git commit -m "fix(dev-loop): adjustments from end-to-end test"
```

---

## Summary

| Task | What | Type |
|------|------|------|
| 1 | context.mjs — assembles context.json | Script + tests |
| 2 | loop.mjs update — writes context.json after classify | Script update |
| 3 | /dev-loop CC command — orchestrates deep analysis + Codex | CC command |
| 4 | analyze-sessions.mjs — add tactics + prompts | Script update |
| 5 | End-to-end test | Manual verification |

Tasks 1-2 are script work (subagent-friendly). Task 3 is a markdown
file (simple write). Task 4 is a small script modification. Task 5 is
manual testing with the full /dev-loop command.
