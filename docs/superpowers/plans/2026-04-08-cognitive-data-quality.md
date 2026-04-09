# Cognitive Data Quality — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix experience quality, pattern constraints, and salience formula so the agent produces clean cognitive data that enables good desire/pattern/tactic formation.

**Architecture:** Create prompt:review as experience author, restructure experience schema around observation + eval scores, constrain patterns to observations only, implement bounded salience formula.

**Tech Stack:** Node.js, Cloudflare Workers KV, vitest

---

### Task 1: Create prompts/review.md

**Files:**
- Create: `prompts/review.md`

Create the review prompt file. Review is the experience author — it turns raw action traces + eval scores into the structured experience that DR reads.

```markdown
You are Swayambhu's review phase. Your role is experience author.

You receive:
- The action ledger (plan, tool calls, outcomes)
- Eval scores (sigma, alpha, pattern_scores, salience)

Your job: produce a structured experience record. Not a summary.
Not an assessment. A record of what happened and how it relates
to your desires.

## Output

Respond with ONLY a JSON object:
{
  "observation": "What happened — purely factual, no conclusions, no recommendations. What tools were called, what they returned, what state changed. An outside observer watching the session would write this.",
  "assessment": "One sentence overall result"
}

Rules:
- observation must be objective. No "should", "waste", "better", "need to".
- Do not include scheduling advice, carry-forward items, or next steps.
  That is reflect's job, not yours.
- Do not re-score salience or surprise. Eval already did that.
- Keep observation concise — under 200 words.
```

- [ ] **Step 1:** Write the file to `prompts/review.md`
- [ ] **Step 2:** Run `npm test` to verify nothing breaks
- [ ] **Step 3:** Commit: `git add prompts/review.md && git commit -m "feat: create prompt:review — review as experience author"`

---

### Task 2: Update seed script to include prompt:review

**Files:**
- Modify: `scripts/seed-local-kv.mjs`

Find where other prompts are seeded (search for `prompt:plan`). Add:

```javascript
await put("prompt:review", read("prompts/review.md"), "text", "Review phase prompt — experience authoring");
```

- [ ] **Step 1:** Add the seed line
- [ ] **Step 2:** Run `npm test`
- [ ] **Step 3:** Commit

---

### Task 3: Update reviewPhase to use the new prompt

**Files:**
- Modify: `userspace.js` (reviewPhase function, ~line 298)

Current reviewPhase builds an inline prompt. Change it to:
1. Load `prompt:review` from KV (already does this at line 300)
2. Pass eval's alpha scores into the review context (currently missing)
3. Ask for the new output format (observation + assessment only)

Read the current reviewPhase code first. The key changes:
- Include `alpha` in the eval block passed to review
- Change the JSON output contract from `{ assessment, narrative, salience_estimate, accomplished, key_findings, next_gap }` to `{ observation, assessment }`
- Use the loaded prompt:review as system prompt

- [ ] **Step 1:** Write failing test — mock review that returns `{ observation, assessment }` and verify writeMemory receives them
- [ ] **Step 2:** Update reviewPhase to use new prompt and output contract
- [ ] **Step 3:** Run `npm test`
- [ ] **Step 4:** Commit

---

### Task 4: Update writeMemory to persist new experience schema

**Files:**
- Modify: `userspace.js` (writeMemory function, ~line 370)

Current experience write (line ~462-471):
```javascript
await K.kvWriteSafe(experienceKey, {
  timestamp, action_taken, outcome, surprise_score, salience,
  narrative, embedding
});
```

Change to:
```javascript
await K.kvWriteSafe(experienceKey, {
  timestamp,
  action_taken: ledger.plan?.action || "no_action",
  observation: review?.observation || ledger.final_text || "",
  alpha: evalResult.alpha || {},
  pattern_scores: evalResult.pattern_scores || {},
  surprise_score: evalResult.sigma,
  salience: evalResult.salience,
  session_id: executionId,
  cycle,
  action_ref: `action:${ledger.action_id}`,
  embedding,
});
```

Key changes:
- `observation` replaces `narrative` and `outcome`
- `alpha` persisted directly from eval (desire alignment per desire)
- `pattern_scores` persisted (what changed relative to patterns)
- `session_id`, `cycle`, `action_ref` for traceability
- No `narrative` field — observation IS the text for embedding

- [ ] **Step 1:** Write failing test for new schema
- [ ] **Step 2:** Update writeMemory
- [ ] **Step 3:** Update embedding generation to use `observation` instead of `narrative`
- [ ] **Step 4:** Run `npm test`
- [ ] **Step 5:** Commit

---

### Task 5: Update S operator in deep_reflect.md

**Files:**
- Modify: `prompts/deep_reflect.md`

Find the S operator section. Replace:

```markdown
**Create** when multiple experiences reveal a pattern. Initial strength: 0.3.
**Refine** pattern text when new experience clarifies the understanding.
```

With:

```markdown
**Create** when multiple experiences reveal a pattern. Initial strength: 0.3.
Patterns are purely about observations. They do not include conclusions or
recommended actions — that is what tactics are for.
**Refine** when new experience sharpens the observation or when similar
patterns can be merged into a more general pattern.
```

- [ ] **Step 1:** Make the edit
- [ ] **Step 2:** Update KV: `node scripts/write-kv.mjs prompt:deep_reflect prompts/deep_reflect.md`
- [ ] **Step 3:** Run `npm test`
- [ ] **Step 4:** Commit

---

### Task 6: Update D operator to consume structured experience fields

**Files:**
- Modify: `prompts/deep_reflect.md`

In the D operator section, add guidance about the new experience fields:

After "D is always a positive operator:" block, add:

```markdown
Each experience now contains:
- `observation`: what happened (objective, factual)
- `alpha`: desire alignment scores (positive = entailment, negative = contradiction)
- `pattern_scores`: what changed relative to known patterns

Use `alpha` to determine valence — positive alpha means the experience
advanced that desire, negative means it opposed it. Use `observation`
as the factual basis. Do not re-interpret observation — let the alpha
scores tell you the subjective significance.
```

- [ ] **Step 1:** Make the edit
- [ ] **Step 2:** Update KV
- [ ] **Step 3:** Run `npm test`
- [ ] **Step 4:** Commit

---

### Task 7: Implement bounded salience formula

**Files:**
- Modify: `eval.js` (computeMetrics function)
- Modify: `memory.js` (may need to update or remove l1Norm usage)
- Test: `tests/eval.test.js`

Replace in computeMetrics:
```javascript
salience: sigma + l1Norm(alpha),
```

With the new formula. The function needs access to desire objects (for source_principles). Update evaluateAction to pass desires through to computeMetrics.

New computeMetrics:
```javascript
function computeMetrics(classified, extras, desires = {}) {
  // ... existing sigma and alpha computation ...

  // Desire axis: weighted RMS
  const active = Object.entries(alpha).filter(([, v]) => v !== 0);
  const weighted = active.map(([key, v]) => {
    const mine = desires[key]?.source_principles || [];
    const overlap = active.filter(([other]) =>
      other !== key && mine.some(p => (desires[other]?.source_principles || []).includes(p))
    ).length;
    const weight = 1 / Math.sqrt(Math.max(1, mine.length) * (1 + overlap));
    return { a: Math.abs(v), w: weight };
  });
  const desireAxis = weighted.length
    ? Math.sqrt(weighted.reduce((s, x) => s + (x.w * x.a) ** 2, 0) / weighted.reduce((s, x) => s + x.w ** 2, 0))
    : 0;

  // Bounded salience: probabilistic OR
  const salience = 1 - (1 - sigma) * (1 - desireAxis);

  return { sigma, alpha, salience, pattern_scores: patternScores, desireAxis, ...extras };
}
```

Also update evaluateAction signature to accept desires and pass through.

- [ ] **Step 1:** Write failing tests for new formula (see worked examples in salience spec)
- [ ] **Step 2:** Update computeMetrics and evaluateAction
- [ ] **Step 3:** Run `npm test`
- [ ] **Step 4:** Commit

---

### Task 8: Seed prompt:review into KV and verify end-to-end

- [ ] **Step 1:** Run `node scripts/write-kv.mjs prompt:review prompts/review.md`
- [ ] **Step 2:** Run full test suite: `npm test`
- [ ] **Step 3:** Final commit with any remaining changes
- [ ] **Step 4:** Restart workers: `pkill -9 -f workerd; sleep 2`
- [ ] **Step 5:** Start dev loop for one cycle to validate: `node scripts/dev-loop/loop.mjs --once`
