# Samskara Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the cognitive architecture from v1 (assumptions + insights + wisdom + statistical memory) to v2 (unified samskara model with {pattern, strength}).

**Architecture:** Four stores collapse into two: `samskara:*` replaces `assumption:*`, `mu:*`, `prajna:*`, `upaya:*`, `insight:*`. Experience schema drops affinity_vector and active lists, adds salience scalar. Seven operators collapse to three agent operators (A, S, D). Review becomes mechanical computation. One EMA parameter governs samskara strength.

**Tech Stack:** Vitest, Cloudflare Workers, KV store, existing inference pipeline (embeddings + NLI).

**Reference:** `swayambhu-cognitive-architecture.md` (v2.0 spec)

---

### Task 1: Schema — Replace assumption/mu validators with samskara

**Files:**
- Modify: `tests/schema.test.js`

- [ ] **Step 1: Replace validateAssumption and validateMu with validateSamskara**

Replace the `validateAssumption` function (lines 19-28) and `validateMu` function (lines 30-38) with:

```javascript
function validateSamskara(s) {
  const errors = [];
  if (typeof s.pattern !== "string" || !s.pattern) errors.push("pattern must be a non-empty string");
  if (typeof s.strength !== "number" || s.strength < 0 || s.strength > 1) errors.push("strength must be a number between 0 and 1");
  return errors;
}
```

- [ ] **Step 2: Replace validateExperience with simplified version**

Replace the `validateExperience` function (lines 40-52) with:

```javascript
function validateExperience(e) {
  const errors = [];
  if (typeof e.timestamp !== "string") errors.push("timestamp must be an ISO 8601 string");
  if (typeof e.action_taken !== "string") errors.push("action_taken must be a string");
  if (typeof e.outcome !== "string") errors.push("outcome must be a string");
  if (typeof e.surprise_score !== "number") errors.push("surprise_score must be a number");
  if (typeof e.salience !== "number") errors.push("salience must be a number");
  if (typeof e.narrative !== "string") errors.push("narrative must be a string");
  if (e.embedding !== null && !Array.isArray(e.embedding)) errors.push("embedding must be a number array or null");
  return errors;
}
```

- [ ] **Step 3: Replace assumption/mu test blocks with samskara tests**

Remove the `describe("Assumption", ...)` and `describe("Mu (Statistical Memory)", ...)` blocks. Add:

```javascript
describe("Samskara", () => {
  it("validates a well-formed samskara", () => {
    const samskara = {
      pattern: "Slack fails silently — success responses don't guarantee delivery",
      strength: 0.85,
    };
    expect(validateSamskara(samskara)).toEqual([]);
  });

  it("rejects missing pattern", () => {
    const samskara = { strength: 0.5 };
    const errors = validateSamskara(samskara);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/pattern/);
  });

  it("rejects strength out of range", () => {
    expect(validateSamskara({ pattern: "test", strength: 1.5 }).length).toBeGreaterThan(0);
    expect(validateSamskara({ pattern: "test", strength: -0.1 }).length).toBeGreaterThan(0);
  });

  it("accepts strength at boundaries", () => {
    expect(validateSamskara({ pattern: "test", strength: 0 })).toEqual([]);
    expect(validateSamskara({ pattern: "test", strength: 1 })).toEqual([]);
  });
});
```

- [ ] **Step 4: Update experience test block**

Replace the experience test data in the `describe("Experience", ...)` block to match the simplified schema:

```javascript
describe("Experience", () => {
  it("validates a well-formed experience", () => {
    const experience = {
      timestamp: "2026-03-20T10:00:00.000Z",
      action_taken: "Sent a greeting to the patron",
      outcome: "Message delivered successfully",
      surprise_score: 0.1,
      salience: 0.3,
      narrative: "Routine greeting. No issues.",
      embedding: null,
    };
    expect(validateExperience(experience)).toEqual([]);
  });

  it("accepts embedding as array of numbers", () => {
    const experience = {
      timestamp: "2026-03-20T10:00:00.000Z",
      action_taken: "test",
      outcome: "test",
      surprise_score: 0.5,
      salience: 0.7,
      narrative: "test",
      embedding: [0.1, 0.2, 0.3],
    };
    expect(validateExperience(experience)).toEqual([]);
  });

  it("rejects missing salience", () => {
    const experience = {
      timestamp: "2026-03-20T10:00:00.000Z",
      action_taken: "test",
      outcome: "test",
      surprise_score: 0.5,
      narrative: "test",
      embedding: null,
    };
    const errors = validateExperience(experience);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/salience/);
  });
});
```

- [ ] **Step 5: Run tests, verify pass**

Run: `npm test -- tests/schema.test.js`
Expected: All schema tests pass.

- [ ] **Step 6: Commit**

```bash
git add tests/schema.test.js
git commit -m "refactor(v2): replace assumption/mu schemas with samskara"
```

---

### Task 2: Memory — Replace updateMu with updateSamskaraStrength

**Files:**
- Modify: `memory.js`
- Modify: `tests/memory.test.js`

- [ ] **Step 1: Write failing tests for updateSamskaraStrength**

In `tests/memory.test.js`, replace the `describe("updateMu", ...)` block with:

```javascript
describe("updateSamskaraStrength", () => {
  it("moves strength toward 1 on confirmation (low surprise)", () => {
    const result = updateSamskaraStrength(0.5, 0.1); // surprise=0.1 → confirmation
    // strength = 0.5 * 0.7 + (1-0.1) * 0.3 = 0.35 + 0.27 = 0.62
    expect(result).toBeCloseTo(0.62, 2);
  });

  it("moves strength toward 0 on violation (high surprise)", () => {
    const result = updateSamskaraStrength(0.5, 0.9); // surprise=0.9 → violation
    // strength = 0.5 * 0.7 + (1-0.9) * 0.3 = 0.35 + 0.03 = 0.38
    expect(result).toBeCloseTo(0.38, 2);
  });

  it("uses custom alpha", () => {
    const result = updateSamskaraStrength(0.5, 0.0, 0.5); // full confirmation, alpha=0.5
    // strength = 0.5 * 0.5 + 1.0 * 0.5 = 0.25 + 0.5 = 0.75
    expect(result).toBeCloseTo(0.75, 2);
  });

  it("clamps result to [0, 1]", () => {
    expect(updateSamskaraStrength(1.0, 0.0)).toBeLessThanOrEqual(1);
    expect(updateSamskaraStrength(0.0, 1.0)).toBeGreaterThanOrEqual(0);
  });

  it("returns unchanged for zero surprise with strength near 1", () => {
    const result = updateSamskaraStrength(0.95, 0.0);
    expect(result).toBeGreaterThan(0.95);
    expect(result).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/memory.test.js`
Expected: FAIL — `updateSamskaraStrength` is not defined.

- [ ] **Step 3: Implement updateSamskaraStrength in memory.js**

Replace the `updateMu` function (lines 28-52) with:

```javascript
// EMA strength update for samskaras. Confirmation (low surprise) moves
// strength toward 1. Violation (high surprise) moves strength toward 0.
// Same α as surprise tracking — they measure the same signal.
const EMA_ALPHA = 0.3;

export function updateSamskaraStrength(currentStrength, surprise, alpha = EMA_ALPHA) {
  const updated = currentStrength * (1 - alpha) + (1 - surprise) * alpha;
  return Math.max(0, Math.min(1, updated));
}
```

Also update the import in the export — remove the old `updateMu` export name.

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- tests/memory.test.js`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add memory.js tests/memory.test.js
git commit -m "refactor(v2): replace updateMu with updateSamskaraStrength EMA"
```

---

### Task 3: Eval — Update evaluateAction for samskaras

**Files:**
- Modify: `eval.js`
- Modify: `tests/eval.test.js`

- [ ] **Step 1: Update evaluateAction signature and internals**

Change the function signature from `evaluateAction(K, ledger, desires, assumptions, config)` to `evaluateAction(K, ledger, desires, samskaras, config)`.

Replace all internal references to `assumptions` with `samskaras`, and `assumption` type entries with `samskara`:

- Line 93: `const candidateCheckIds = Object.values(samskaras).map(a => a.slug);` — change to use samskara pattern as ID: `Object.keys(samskaras)`
- Lines 104-105: `const desireEntries = Object.entries(desires)` stays. `const assumptionEntries = Object.entries(assumptions)` → `const samskaraEntries = Object.entries(samskaras)`
- Line 107: condition becomes `if (samskaraEntries.length === 0)`
- Lines 108-114: Empty samskaras → σ=1 (unchanged logic, update comment to reference samskaras)
- Lines 128-136: Build samskara pairs:

```javascript
for (const [key, s] of samskaraEntries) {
  pairs.push({
    id: key,
    type: "samskara",
    slug: key,
    text: s.pattern,
    embedding: s._embedding || null,
  });
}
```

- In `computeMetrics` (lines 25-50): Change `c.type === "assumption"` to `c.type === "samskara"`. The `assumptionScores` output becomes `samskaraScores` — a map of samskara keys to `{direction, surprise}`.

- The return object changes: `assumption_scores` → `samskara_scores`, `assumptions_relied_on` → `samskaras_relied_on`, `candidate_check_ids` removed (replaced by samskara keys).

- [ ] **Step 2: Update eval tests**

In `tests/eval.test.js`, update all test fixtures:
- Replace assumption fixtures with samskara fixtures: `{ pattern: "...", strength: 0.8 }` format
- Update assertion field names: `assumption_scores` → `samskara_scores`
- The "empty assumptions → max surprise" test already works — update its name to "empty samskaras → max surprise"
- Update `candidate_check_ids` assertions to match new output shape

- [ ] **Step 3: Run tests**

Run: `npm test -- tests/eval.test.js`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add eval.js tests/eval.test.js
git commit -m "refactor(v2): evaluateAction uses samskaras instead of assumptions"
```

---

### Task 4: Act formatting — Replace formatAssumptions with formatSamskaras

**Files:**
- Modify: `act.js`

- [ ] **Step 1: Replace formatAssumptions**

Rename `formatAssumptions` to `formatSamskaras`. Update the function body:

```javascript
export function formatSamskaras(s) {
  if (!s || Object.keys(s).length === 0) return "(no samskaras)";
  const arr = Object.entries(s).map(([key, val]) => ({
    key,
    pattern: val.pattern,
    strength: val.strength,
  }));
  return JSON.stringify(arr, null, 2);
}
```

- [ ] **Step 2: Commit**

```bash
git add act.js
git commit -m "refactor(v2): formatAssumptions → formatSamskaras"
```

---

### Task 5: Session — Rewrite for samskara model

**Files:**
- Modify: `session.js`
- Modify: `tests/session.test.js`

This is the largest task. The session loop changes from assumption/mu/experience writes to samskara strength updates and simplified experience writes.

- [ ] **Step 1: Update imports**

In `session.js`, change:
```javascript
import { updateMu, callInference, embeddingCacheKey } from './memory.js';
import { renderActPrompt, buildToolSet, formatDesires, formatAssumptions, formatCircumstances } from './act.js';
```
to:
```javascript
import { updateSamskaraStrength, callInference, embeddingCacheKey } from './memory.js';
import { renderActPrompt, buildToolSet, formatDesires, formatSamskaras, formatCircumstances } from './act.js';
```

- [ ] **Step 2: Replace loadAssumptions with loadSamskaras**

```javascript
async function loadSamskaras(K) {
  const list = await K.kvList({ prefix: "samskara:" });
  const samskaras = {};
  for (const entry of list.keys) {
    const val = await K.kvGet(entry.name);
    if (val) samskaras[entry.name] = val;
  }
  return samskaras;
}
```

No TTL filtering — samskaras don't have TTL. Strength handles decay.

- [ ] **Step 3: Update planPhase to use samskaras**

Change the function signature from `planPhase(K, { desires, assumptions, ... })` to `planPhase(K, { desires, samskaras, ... })`.

Update the user content:
```javascript
const userContent = [
  "[DESIRES]", formatDesires(desires), "",
  "[SAMSKARAS]", formatSamskaras(samskaras), "",
  "[CIRCUMSTANCES]", formatCircumstances(circumstances),
  "",
  "Respond with a JSON plan object: { action, success, relies_on, defer_if, no_action }",
  "If no action is warranted, respond: { no_action: true, reason: \"...\" }",
].join("\n");
```

Update the `relies_on` validation to check samskara keys instead of assumption slugs:
```javascript
if (plan.relies_on?.length) {
  const knownKeys = new Set(Object.keys(samskaras));
  const unknown = plan.relies_on.filter(k => !knownKeys.has(k));
  if (unknown.length) {
    await K.karmaRecord({ event: "plan_unknown_relies_on", unknown_keys: unknown, stripped: true });
    plan.relies_on = plan.relies_on.filter(k => knownKeys.has(k));
  }
}
```

- [ ] **Step 4: Rewrite writeMemory for samskara strength + simplified experience**

Replace the entire `writeMemory` function:

```javascript
async function writeMemory(K, { ledger, evalResult, review, desires, samskaras, inferenceConfig }) {
  const now = new Date().toISOString();

  // Samskara strength updates — from eval's per-samskara surprise scores
  if (evalResult.samskara_scores) {
    for (const [key, score] of Object.entries(evalResult.samskara_scores)) {
      const existing = samskaras[key];
      if (!existing) continue;
      const newStrength = updateSamskaraStrength(existing.strength, score.surprise);
      await K.kvWriteSafe(key, { ...existing, strength: newStrength });
    }
  }

  // Experience writes — if salience exceeds threshold
  const salienceThreshold = 0.5;
  const salience = evalResult.salience > 0
    ? evalResult.salience
    : (review?.salience_estimate || 0);

  if (salience > salienceThreshold) {
    let embedding = null;
    if (inferenceConfig) {
      try {
        const resp = await callInference(inferenceConfig.url, inferenceConfig.secret, '/embed', {
          texts: [review?.narrative || review?.assessment || ledger.final_text || '']
        });
        embedding = resp.embeddings?.[0] || null;
      } catch {
        await K.karmaRecord({ event: "experience_embedding_failed" });
      }
    }

    const experienceKey = `experience:${Date.now()}`;
    await K.kvWriteSafe(experienceKey, {
      timestamp: now,
      action_taken: ledger.plan?.action || "no_action",
      outcome: ledger.final_text || review?.assessment || "",
      surprise_score: evalResult.sigma,
      salience,
      narrative: review?.narrative || review?.assessment || ledger.plan?.reason || "",
      embedding,
    });
  }
}
```

- [ ] **Step 5: Update the main run() function**

Key changes in `run()`:
- Replace `loadAssumptions` call with `loadSamskaras`
- Replace `assumptions` variable everywhere with `samskaras`
- Remove embedding cache for assumptions (samskaras get cached instead)
- Update `cacheEmbeddings` call to use `'pattern'` as the text field:
  ```javascript
  await cacheEmbeddings(K, samskaras, 'pattern', embedModel, inferenceConfig);
  ```
- Update deep-reflect job processing to filter `samskara:*` keys instead of `assumption:*`
- Pass `samskaras` to `planPhase`, `evaluateAction`, `writeMemory`
- Update the no-action path to pass `samskaras` instead of `assumptions`

- [ ] **Step 6: Update session tests**

In `tests/session.test.js`:
- Replace all `assumption:` KV fixtures with `samskara:` fixtures using `{pattern, strength}` schema
- Update `evaluateAction` mock to return `samskara_scores` instead of `assumption_scores`
- Replace `describe("session memory writes")` tests:
  - "writes mu via updateMu" → "updates samskara strength on confirmation"
  - "writes mu with violation" → "updates samskara strength on violation"
  - Remove "does not write mu when assumption_scores is empty"
  - Update experience assertions to check simplified schema (no affinity_vector, no active_assumptions)
- Update deep-reflect job tests to filter `samskara:*` instead of `desire:*` + `assumption:*`
- Update mock callLLM responses to use `[SAMSKARAS]` in plan prompts

- [ ] **Step 7: Run all tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add session.js tests/session.test.js
git commit -m "refactor(v2): session uses samskaras, simplified experience writes"
```

---

### Task 6: Reflect — Update for S operator and samskara manifest

**Files:**
- Modify: `reflect.js`

- [ ] **Step 1: Replace loadWisdomManifest with loadSamskaraManifest**

```javascript
async function loadSamskaraManifest(K) {
  const list = await K.kvList({ prefix: "samskara:", limit: 200 });
  return list.keys.map(k => ({
    key: k.name,
    summary: k.metadata?.summary || k.name,
  }));
}
```

- [ ] **Step 2: Update all callers**

Replace `loadWisdomManifest` calls in `executeReflect` and `gatherReflectContext` with `loadSamskaraManifest`. Update template variable names:
- `wisdom_manifest` → `samskara_manifest`

- [ ] **Step 3: Update gatherReflectContext**

In `gatherReflectContext`:
- Remove `desireEmbeddings` loading for experience selection (experiences no longer have affinity vectors to compare)
- Update `selectExperiences` call — pass empty array for desire embeddings or update the function
- Remove `muEntries` loading (no more `mu:*` keys)
- Update template vars: remove `mu_entries`, replace `wisdom_manifest` with `samskara_manifest`

- [ ] **Step 4: Update default prompts**

In `defaultDeepReflectPrompt(depth)` (line 681+):
- Replace wisdom/prajna/upaya references with samskara references
- Update `kv_operations` guidance to reference `samskara:*` and `desire:*` keys

- [ ] **Step 5: Commit**

```bash
git add reflect.js
git commit -m "refactor(v2): reflect uses samskara manifest, removes wisdom/mu"
```

---

### Task 7: Kernel — Update key tiers

**Files:**
- Modify: `kernel.js`
- Modify: `tests/kernel.test.js`

- [ ] **Step 1: Update DEFAULT_KEY_TIERS**

In `kernel.js` (line 45-55), replace `upaya:*`, `prajna:*`, `assumption:*` with `samskara:*` in the protected tier:

```javascript
static DEFAULT_KEY_TIERS = {
  immutable: ["dharma", "principle:*", "patron:public_key"],
  kernel_only: ["karma:*", "sealed:*", "event:*", "event_dead:*", "kernel:*", "patron:direct"],
  protected: [
    "config:*", "prompt:*", "tool:*", "provider:*", "channel:*",
    "hook:*", "contact:*", "contact_platform:*", "code_staging:*",
    "secret:*", "doc:*", "samskara:*", "skill:*", "task:*",
    "providers", "wallets", "patron:contact", "patron:identity_snapshot",
    "desire:*",
  ],
};
```

- [ ] **Step 2: Update metadata type system**

Find the metadata definitions (around line 1865) and replace `upaya`/`prajna` entries with `samskara`:

```javascript
samskara: { type: "samskara", format: "json" },
```

Remove `upaya` and `prajna` metadata entries.

- [ ] **Step 3: Update kernel tests**

In `tests/kernel.test.js`, update any tests that reference `assumption:*`, `upaya:*`, `prajna:*`, or `mu:*` keys to use `samskara:*` instead.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add kernel.js tests/kernel.test.js
git commit -m "refactor(v2): kernel key tiers use samskara:* prefix"
```

---

### Task 8: Prompts — Update act and deep-reflect prompts

**Files:**
- Modify: `prompts/act.md`
- Modify: `prompts/deep-reflect.md`

- [ ] **Step 1: Update act prompt**

In `prompts/act.md`, replace the "Your upaya" section (lines 29-33):

```markdown
## Your samskaras

Your `samskara:*` keys contain accumulated impressions from experience —
patterns about how things work, at varying levels of depth. Strong
samskaras (high strength) have been confirmed across many experiences.
Weak ones are provisional. Query relevant samskaras via `kv_query` when
they may inform your task.
```

- [ ] **Step 2: Update deep-reflect prompt**

In `prompts/deep-reflect.md`, replace the Wisdom section (lines 104-109):

```markdown
### Samskaras

{{samskara_manifest}}

Samskaras are impressions left by experience — patterns about how things work.
Each has a strength (0-1) reflecting how well-confirmed it is. Strong samskaras
have been confirmed across diverse experiences. Weak ones are provisional or
recently violated.

Create new samskaras when you recognize patterns across experiences. Refine
pattern text when understanding sharpens. The mechanical strength update
handles confirmation/violation — your role is pattern recognition, not
counting. Write via `kv_operations` with schema: `{pattern: "...", strength: 0.3}`.
Initial strength for new samskaras: 0.3 (one signal).
```

Also update the vikalpas section — these were originally "assumptions you're operating on." With the samskara model, vikalpas become operational notes that aren't samskaras (temporary session-level assumptions). Their role is unchanged but the relationship to the belief store changes. Update the description:

```markdown
### Vikalpas

Operational hypotheses for this reflection cycle — things you're testing or
watching that haven't earned samskara status yet. Only track vikalpas that
are changing your behavior.
```

- [ ] **Step 3: Commit**

```bash
git add prompts/act.md prompts/deep-reflect.md
git commit -m "refactor(v2): prompts reference samskaras instead of assumptions/wisdom"
```

---

### Task 9: Seed script and config — Update for samskara prefix

**Files:**
- Modify: `scripts/seed-local-kv.mjs`
- Modify: `config/seed-wisdom.json`

- [ ] **Step 1: Rename seed wisdom file and update content**

Rename `config/seed-wisdom.json` to `config/seed-samskaras.json`. Update content:

```json
{
  "samskara:comms:defaults": {
    "pattern": "When in doubt, do not send. Silence is safer than a poorly judged message. A message sent cannot be unsent, but a message held can always be sent later with better judgment.",
    "strength": 0.3
  }
}
```

- [ ] **Step 2: Update seed script**

In `scripts/seed-local-kv.mjs`:
- Update the wisdom seeding section (around lines 203-211) to read from `config/seed-samskaras.json`
- Update `kernel:key_tiers` seeding to replace `upaya:*`, `prajna:*`, `assumption:*` with `samskara:*`
- Remove any `mu:*` references from seeding

- [ ] **Step 3: Run seed and verify**

```bash
source .env && bash scripts/start.sh --reset-all-state
node scripts/read-kv.mjs samskara:
```

Expected: `samskara:comms:defaults` key exists with `{pattern, strength}` schema.

- [ ] **Step 4: Commit**

```bash
git add scripts/seed-local-kv.mjs config/seed-samskaras.json
git rm config/seed-wisdom.json
git commit -m "refactor(v2): seed script uses samskara:* prefix"
```

---

### Task 10: Docs — Update CLAUDE.md and architecture docs

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/dev/architecture.md`
- Modify: `docs/dev/kv-schema.md`
- Modify: `docs/dev/testing.md`
- Modify: `docs/TESTING.md`

- [ ] **Step 1: Update CLAUDE.md**

Verify the cognitive architecture KV keys table already reflects `samskara:*` (should be done from earlier edits). Ensure no remaining references to `assumption:*`, `mu:*`, `prajna:*`, `upaya:*`, `insight:*` in the file.

- [ ] **Step 2: Update architecture docs**

Search for and replace references to assumptions, mu, prajna, upaya, insights across all docs in `docs/dev/`. Replace with samskara references where appropriate. Delete stale docs:
- `docs/dev/wisdom-guide.md` — no longer needed (samskara model replaces wisdom)
- `docs/agent/wisdom-guide.md` — same

- [ ] **Step 3: Commit**

```bash
git add -A docs/ CLAUDE.md
git commit -m "docs(v2): update all references for samskara model"
```

---

### Task 11: Integration test — Run first session with samskara model

**Files:** None (manual verification)

- [ ] **Step 1: Full reset and start**

```bash
source .env && bash scripts/start.sh --reset-all-state --trigger
```

- [ ] **Step 2: Verify bootstrap sequence**

```bash
node scripts/read-kv.mjs karma:
node scripts/read-kv.mjs experience:
node scripts/read-kv.mjs samskara:
node scripts/read-kv.mjs desire:
```

Expected:
- Karma shows session_start, plan (no_action since no desires), session_complete
- Experience recorded (σ=1 bootstrap experience)
- No samskaras yet (S operator hasn't run)
- No desires yet (D operator hasn't run)

- [ ] **Step 3: Verify no stale prefixes**

```bash
node scripts/read-kv.mjs assumption:
node scripts/read-kv.mjs mu:
node scripts/read-kv.mjs prajna:
node scripts/read-kv.mjs upaya:
node scripts/read-kv.mjs insight:
```

Expected: No keys found for any of these prefixes.

- [ ] **Step 4: Commit any fixes**

If integration testing reveals issues, fix and commit individually.

---

### Task 12: Cleanup — Delete stale files and references

**Files:**
- Delete: `specs/wisdom-management.md` (replaced by samskara model)
- Delete: `scripts/migrate-viveka-to-upaya.mjs` (obsolete migration)
- Modify: Various docs that reference old prefixes

- [ ] **Step 1: Delete stale specs and scripts**

```bash
git rm specs/wisdom-management.md
git rm scripts/migrate-viveka-to-upaya.mjs
```

- [ ] **Step 2: Search for remaining stale references**

```bash
grep -r "assumption:" --include="*.js" --include="*.md" --include="*.json" .
grep -r "upaya:" --include="*.js" --include="*.md" --include="*.json" .
grep -r "prajna:" --include="*.js" --include="*.md" --include="*.json" .
grep -r "mu:" --include="*.js" --include="*.md" --include="*.json" .
grep -r "updateMu" --include="*.js" .
```

Fix any remaining references (except in git history, design lineage docs, and test fixtures that have already been updated).

- [ ] **Step 3: Final test run**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(v2): delete stale wisdom/assumption artifacts"
```
