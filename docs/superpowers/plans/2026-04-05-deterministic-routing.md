# Deterministic Routing — Implementation Plan

## Goal

Make routing deterministic in `loop.mjs` instead of analyst-chosen in `cc-analyze.md`.

Target behavior:
- `cc-analyze.md` emits classification only.
- `decide.mjs` computes the action deterministically from classification.
- `loop.mjs` owns execution for `auto_apply`.
- `loop.mjs` continues to own escalation delivery and cold-start scheduling.

One non-obvious but necessary adjustment: move the `restartWorkersIfNeeded()` and `maybeCompileReasoningArtifacts()` calls to after `PROCESS DECISIONS`, because `action`, `verified`, and `files_changed` will no longer exist until the loop computes and executes them.

## Task 1: Update `decide.test.js` first

Make the routing tests fail against the current implementation before touching `decide.mjs`.

File to modify:
- `/home/swami/swayambhu/repo/tests/dev-loop/decide.test.js`

Replace the current `describe("routeProposal", ...)` block with this exact block:

```js
describe("routeProposal", () => {
  it("returns cold_start when the classifier marks the state as cold-start-only", () => {
    const result = routeProposal({
      blast_radius: "local",
      evidence_quality: "strong",
      challenge_converged: true,
      cold_start: true,
    });
    expect(result).toEqual({
      action: "cold_start",
      reason: "state requires cold start recovery",
    });
  });

  it("escalates when the classifier says human judgment is required", () => {
    const result = routeProposal({
      blast_radius: "local",
      evidence_quality: "moderate",
      challenge_converged: false,
      requires_human_judgment: true,
    });
    expect(result).toEqual({
      action: "escalate",
      reason: "change requires human judgment",
    });
  });

  it("auto-applies local + moderate evidence", () => {
    const result = routeProposal({
      blast_radius: "local",
      evidence_quality: "moderate",
      challenge_converged: false,
    });
    expect(result).toEqual({
      action: "auto_apply",
      reason: "local change with moderate evidence - safe to auto-apply",
    });
  });

  it("auto-applies module + strong evidence when challenge converged", () => {
    const result = routeProposal({
      blast_radius: "module",
      evidence_quality: "strong",
      challenge_converged: true,
    });
    expect(result).toEqual({
      action: "auto_apply",
      reason: "module-level change with strong evidence and converged challenge - safe to auto-apply",
    });
  });

  it("defers module + strong evidence when challenge did not converge", () => {
    const result = routeProposal({
      blast_radius: "module",
      evidence_quality: "strong",
      challenge_converged: false,
    });
    expect(result).toEqual({
      action: "defer",
      reason: "module-level change needs converged challenge before auto-apply",
    });
  });

  it("defers module + moderate evidence", () => {
    const result = routeProposal({
      blast_radius: "module",
      evidence_quality: "moderate",
      challenge_converged: true,
    });
    expect(result).toEqual({
      action: "defer",
      reason: "module-level change needs strong evidence (have moderate)",
    });
  });

  it("escalates system + strong evidence when challenge converged", () => {
    const result = routeProposal({
      blast_radius: "system",
      evidence_quality: "strong",
      challenge_converged: true,
    });
    expect(result).toEqual({
      action: "escalate",
      reason: "system-level change with strong evidence and converged challenge requires human approval",
    });
  });

  it("defers system + strong evidence when challenge did not converge", () => {
    const result = routeProposal({
      blast_radius: "system",
      evidence_quality: "strong",
      challenge_converged: false,
    });
    expect(result).toEqual({
      action: "defer",
      reason: "system-level change needs converged challenge before escalation",
    });
  });

  it("rejects weak evidence for any blast radius", () => {
    for (const radius of ["local", "module", "system"]) {
      const result = routeProposal({
        blast_radius: radius,
        evidence_quality: "weak",
        challenge_converged: true,
      });
      expect(result).toEqual({
        action: "defer",
        reason: "evidence too weak (weak) to act on",
      });
    }
  });
});
```

Verification for this step:

```bash
npx vitest run tests/dev-loop/decide.test.js
```

Expected before implementing Task 2: failures for `cold_start`, `requires_human_judgment`, module convergence handling, and system convergence handling.

## Task 2: Implement deterministic routing in `decide.mjs`

File to modify:
- `/home/swami/swayambhu/repo/scripts/dev-loop/decide.mjs`

Keep `EVIDENCE_RANK`, `evidenceRank()`, `shouldAutoApply()`, and `generateApprovalId()` unchanged. Replace only `routeProposal()` with this exact function:

```js
export function routeProposal({
  blast_radius,
  evidence_quality,
  challenge_converged = false,
  requires_human_judgment = false,
  cold_start = false,
}) {
  const rank = evidenceRank(evidence_quality);

  if (cold_start) {
    return { action: "cold_start", reason: "state requires cold start recovery" };
  }

  if (requires_human_judgment) {
    return { action: "escalate", reason: "change requires human judgment" };
  }

  if (rank < EVIDENCE_RANK.moderate) {
    return { action: "defer", reason: `evidence too weak (${evidence_quality}) to act on` };
  }

  if (blast_radius === "system") {
    if (rank >= EVIDENCE_RANK.strong && challenge_converged) {
      return {
        action: "escalate",
        reason: "system-level change with strong evidence and converged challenge requires human approval",
      };
    }
    return {
      action: "defer",
      reason: "system-level change needs converged challenge before escalation",
    };
  }

  if (blast_radius === "module") {
    if (rank >= EVIDENCE_RANK.strong && challenge_converged) {
      return {
        action: "auto_apply",
        reason: "module-level change with strong evidence and converged challenge - safe to auto-apply",
      };
    }
    if (rank >= EVIDENCE_RANK.strong) {
      return {
        action: "defer",
        reason: "module-level change needs converged challenge before auto-apply",
      };
    }
    return {
      action: "defer",
      reason: `module-level change needs strong evidence (have ${evidence_quality})`,
    };
  }

  return {
    action: "auto_apply",
    reason: `local change with ${evidence_quality} evidence - safe to auto-apply`,
  };
}
```

Notes:
- `apply_and_note` disappears entirely.
- `cold_start` and `requires_human_judgment` override the blast-radius table.
- The analyst’s `reason` remains classification rationale; loop code should store routing rationale separately as `route_reason`.

Verification for this step:

```bash
npx vitest run tests/dev-loop/decide.test.js
```

Expected after this step: all tests in `tests/dev-loop/decide.test.js` pass.

## Task 3: Restructure Stage 5 in `cc-analyze.md`

File to modify:
- `/home/swami/swayambhu/repo/scripts/dev-loop/cc-analyze.md`

Do not touch Stage 3 or Stage 4. Replace only the Stage 5 section with the following exact content:

```md
## Stage 5: DECIDE

Write `decisions.json` with classification for each proposal:
```json
{
  "decisions": [{
    "seq": 1,
    "summary": "what the fix does",
    "reason": "why this classification is justified",
    "blast_radius": "local|module|system",
    "evidence_quality": "weak|moderate|strong",
    "challenge_converged": true,
    "requires_human_judgment": false,
    "cold_start": false,
    "escalation_details": null
  }]
}
```

The loop will compute the action deterministically. Do not output `action`.
Do not apply fixes. Do not run tests. Do not write `files_changed`, `verified`,
or `revert_reason`.

Classification definitions:

- `blast_radius`
  - `local`: isolated change in one file or one tightly scoped behavior
  - `module`: change spans multiple files in one subsystem or meaningfully alters module behavior
  - `system`: cross-cutting, kernel-level, or architecture-affecting change
- `evidence_quality`
  - `weak`: mostly intuition, sparse evidence, or unresolved uncertainty
  - `moderate`: clear evidence from code and context, but not fully locked down
  - `strong`: direct code evidence with a well-supported causal explanation
- `challenge_converged`
  - `true`: Codex challenge rounds converged or objections were resolved well enough to proceed
  - `false`: objections remain unresolved, challenge was skipped, or confidence did not converge
- `requires_human_judgment`
  - `true`: patron design judgment is required even if the change is technically feasible
  - `false`: no patron judgment needed
- `cold_start`
  - `true`: the right action is to re-seed state next cycle rather than patch code this cycle
  - `false`: normal routing applies
- `escalation_details`
  - brief, concrete context for the patron when `requires_human_judgment` is true or a system-level escalation is likely
  - otherwise `null`
```

Important details for the edit:
- Remove the routing table entirely.
- Remove the entire “For `auto_apply` decisions” execution subsection.
- Keep the blast-radius and evidence-quality definitions, but convert them into classification guidance instead of routing instructions.

Verification for this step:
- Read the rendered Stage 5 and confirm it contains no `action`, no routing table, and no “apply the fix / run npm test” instructions.
- Confirm the only decision fields emitted by the analyst are the eight classification fields above.

## Task 4: Move routing and auto-apply execution into `loop.mjs`

Files to modify:
- `/home/swami/swayambhu/repo/scripts/dev-loop/loop.mjs`

This task has four code edits that should land together.

### 4.1 Import `routeProposal`

Change the existing import:

```js
import { generateApprovalId } from './decide.mjs';
```

to:

```js
import { generateApprovalId, routeProposal } from './decide.mjs';
```

### 4.2 Add a dedicated CC apply helper

Add this constant near `CC_PROMPT_PATH`:

```js
const CC_APPLY_SYSTEM_PROMPT = [
  'You are a fresh Claude Code process spawned by the dev loop orchestrator.',
  'Your only job is to apply one already-decided proposal, run npm test, and write the result JSON requested in the user message.',
  'Do not perform extra analysis, routing, or documentation updates.',
].join('\n');
```

Add this helper below `runCC()`:

```js
async function runAutoApplyDecision(timestamp, decision) {
  const runDir = join(STATE_DIR, 'runs', timestamp);
  const proposalPath = join(runDir, `proposal-${decision.seq}.md`);
  const resultPath = join(runDir, `applied-${decision.seq}.json`);

  const userMessage = [
    `Apply proposal ${decision.seq}.`,
    `Run directory: ${runDir}`,
    `Proposal file: ${proposalPath}`,
    `Repository root: ${__root}`,
    'Read the proposal file, apply only that fix, then run npm test from the repository root.',
    'If npm test fails, revert your changes with git checkout -- .',
    `Write ${resultPath} with JSON exactly in this shape:`,
    '{"applied":true,"tests_passed":true,"files_changed":["relative/path.js"],"revert_reason":null}',
    'If you cannot apply the change, write {"applied":false,"tests_passed":false,"files_changed":[],"revert_reason":"why"}.',
    'If tests fail after applying, revert and write {"applied":true,"tests_passed":false,"files_changed":[],"revert_reason":"npm test failed"}.',
  ].join('\n');

  const ccArgs = [
    '-p', userMessage,
    '--dangerously-skip-permissions',
    '--output-format', 'text',
    '--append-system-prompt', CC_APPLY_SYSTEM_PROMPT,
    '--no-session-persistence',
    '--model', 'opus',
  ];

  return new Promise((resolve) => {
    let stderr = '';

    const child = spawn('claude', ccArgs, {
      cwd: __root,
      env: { ...process.env },
    });

    const timer = setTimeout(() => {
      console.log(`[AUTO_APPLY] Timeout for proposal ${decision.seq} - killing process`);
      child.kill('SIGTERM');
    }, CC_TIMEOUT_MS);

    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('close', async (code) => {
      clearTimeout(timer);

      if (code !== 0) {
        resolve({
          applied: false,
          tests_passed: false,
          files_changed: [],
          revert_reason: `claude exited with code ${code}${stderr ? `: ${stderr.slice(0, 200)}` : ''}`,
        });
        return;
      }

      try {
        const result = JSON.parse(await readFile(resultPath, 'utf8'));
        resolve({
          applied: Boolean(result.applied),
          tests_passed: Boolean(result.tests_passed),
          files_changed: Array.isArray(result.files_changed) ? result.files_changed : [],
          revert_reason: result.revert_reason || null,
        });
      } catch (error) {
        resolve({
          applied: false,
          tests_passed: false,
          files_changed: [],
          revert_reason: `missing or invalid ${resultPath}: ${error.message}`,
        });
      }
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        applied: false,
        tests_passed: false,
        files_changed: [],
        revert_reason: `failed to spawn claude: ${error.message}`,
      });
    });
  });
}
```

### 4.3 Replace `PROCESS DECISIONS` with deterministic routing

Replace the current `PROCESS DECISIONS` block with this exact block:

```js
  // ── PROCESS DECISIONS ──
  if (ccResult?.decisions?.decisions) {
    const existingPending = (await loadQueue(STATE_DIR, 'pending')).map(p => p.id);
    const runDir = join(STATE_DIR, 'runs', timestamp);

    for (const decision of ccResult.decisions.decisions) {
      const routed = routeProposal(decision);
      decision.classification_reason = decision.reason;
      decision.action = routed.action;
      decision.route_reason = routed.reason;

      if (decision.action === 'cold_start') {
        state.cold_start_next = true;
        console.log(`[LOOP] CC recommends cold start: ${decision.summary}`);
        continue;
      }

      if (decision.action === 'auto_apply') {
        console.log(`[LOOP] Auto-applying proposal ${decision.seq}: ${decision.summary}`);
        const result = await runAutoApplyDecision(timestamp, decision);
        decision.verified = result.applied && result.tests_passed;
        decision.files_changed = result.files_changed;
        if (!decision.verified && result.revert_reason) {
          decision.revert_reason = result.revert_reason;
        }

        if (decision.verified) {
          console.log(`[LOOP] Auto-apply verified for proposal ${decision.seq}`);
        } else {
          console.log(`[LOOP] Auto-apply failed for proposal ${decision.seq}: ${decision.revert_reason || 'unknown error'}`);
        }
        continue;
      }

      if (decision.action === 'escalate') {
        const approvalId = generateApprovalId(timestamp, decision.seq || 0, existingPending);
        decision.approval_id = approvalId;

        try {
          const pendingItem = {
            id: approvalId,
            summary: decision.summary,
            blast_radius: decision.blast_radius,
            evidence_quality: decision.evidence_quality,
            challenge_converged: decision.challenge_converged,
            run_timestamp: timestamp,
            proposal_file: `proposal-${decision.seq}.md`,
            escalation_details: decision.escalation_details || null,
            created_at: new Date().toISOString(),
          };
          const pendingPath = join(STATE_DIR, 'queue', 'pending', `${approvalId}.json`);
          writeFileSync(pendingPath, JSON.stringify(pendingItem, null, 2));

          let why = null;
          let whatChanges = decision.escalation_details || null;
          try {
            const proposalPath = join(runDir, `proposal-${decision.seq}.md`);
            const proposal = readFileSync(proposalPath, 'utf-8');
            const issueMatch = proposal.match(/## (?:Issue|Problem)\s*\n([\s\S]*?)(?=\n## |\n#[^#]|$)/i);
            if (issueMatch) {
              why = issueMatch[1].trim().split('\n\n')[0].replace(/\n/g, ' ').slice(0, 300);
            }
            if (!whatChanges) {
              const fixMatch = proposal.match(/## (?:Fix|Proposed Fix|Solution)\s*\n([\s\S]*?)(?=\n## |\n#[^#]|$)/i);
              if (fixMatch) {
                whatChanges = fixMatch[1].trim().split('\n\n')[0].replace(/\n/g, ' ').slice(0, 300);
              }
            }
          } catch {}

          const msg = formatApprovalMessage({
            id: approvalId,
            summary: decision.summary,
            blastRadius: decision.blast_radius,
            evidence: decision.evidence_quality,
            challengeResult: decision.challenge_converged ? 'converged' : 'not converged',
            why,
            whatChanges,
            details: decision.escalation_details || undefined,
          });
          const slackDm = rubric.notifications?.slack_dm;
          await sendSlack(msg, slackDm ? { channel: slackDm } : undefined);
          console.log(`[LOOP] Escalated ${approvalId} via Slack`);
        } catch (e) {
          console.log(`[LOOP] Failed to escalate ${approvalId}: ${e.message}`);
        }
        continue;
      }

      console.log(`[LOOP] Deferred proposal ${decision.seq}: ${decision.route_reason}`);
    }

    await writeFile(join(runDir, 'decisions.json'), JSON.stringify(ccResult.decisions, null, 2));

    await restartWorkersIfNeeded(ccResult.decisions.decisions, 'CC analysis');

    try {
      const compiled = await maybeCompileReasoningArtifacts(runDir, ccResult.decisions);
      if (compiled.length) console.log(`[LOOP] Compiled ${compiled.length} reasoning artifact(s)`);
    } catch (e) {
      console.log(`[LOOP] Reasoning compilation failed (non-fatal): ${e.message}`);
    }
  }
```

### 4.4 Remove the earlier pre-processing blocks

Delete these now-stale blocks from their old position above `PROCESS DECISIONS`:

```js
  // ── RESTART WORKERS IF CC APPLIED CODE CHANGES ──
  if (ccResult?.decisions?.decisions) {
    await restartWorkersIfNeeded(ccResult.decisions.decisions, 'CC analysis');
  }

  // ── COMPILE REASONING ARTIFACTS (best-effort) ──
  if (ccResult?.decisions?.decisions) {
    try {
      const runDir = join(STATE_DIR, 'runs', timestamp);
      const compiled = await maybeCompileReasoningArtifacts(runDir, ccResult.decisions);
      if (compiled.length) console.log(`[LOOP] Compiled ${compiled.length} reasoning artifact(s)`);
    } catch (e) {
      console.log(`[LOOP] Reasoning compilation failed (non-fatal): ${e.message}`);
    }
  }
```

Without this move, worker restarts and artifact compilation will execute before `action`, `verified`, and `files_changed` exist.

Verification for this step:

```bash
node --check scripts/dev-loop/loop.mjs
npx vitest run tests/dev-loop/decide.test.js
```

Manual behavior check after syntax passes:
- A decision with `{ cold_start: true }` sets `state.cold_start_next = true`.
- A decision with `{ blast_radius: "module", evidence_quality: "strong", challenge_converged: true }` produces `action: "auto_apply"` in the rewritten `decisions.json`.
- A decision with `{ blast_radius: "system", evidence_quality: "strong", challenge_converged: true }` produces an approval request and pending queue entry.
- A decision with weak evidence logs a defer and does nothing else.

## Final pass

Run the minimal verification set after all tasks:

```bash
npx vitest run tests/dev-loop/decide.test.js
node --check scripts/dev-loop/loop.mjs
```

Expected end state:
- `cc-analyze.md` emits classification-only decisions.
- `decide.mjs` is the only place where routing policy lives.
- `loop.mjs` computes `action` itself and persists the enriched `decisions.json`.
- `auto_apply` execution happens only in `loop.mjs`.
- `apply_and_note` no longer exists anywhere in the routing path.
