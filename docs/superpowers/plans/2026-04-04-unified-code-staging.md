# Unified Code Self-Modification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace disconnected code staging + proposal systems with a single working path: DR stages code → governor deploys with batch scoping and rollback snapshots.

**Architecture:** Remove proposal handling from reflect.js and governor. Make governor read `code_staging:*` keys (scoped by execution_id from `deploy:pending`), snapshot canonical code before applying, then deploy. DR output gains `code_stage_requests` field processed by `applyDrResults`.

**Tech Stack:** Cloudflare Workers (kernel, governor), KV storage.

---

### Task 1: Governor — replace proposal-based deploy with code_staging flow

**Files:**
- Modify: `governor/worker.js` (performDeploy, applyProposalToKV, performRollback)
- Modify: `governor/builder.js` (add listKeysWithPrefix export if needed)
- Test: `tests/governor-deploy.test.js`

- [ ] **Step 1: Write tests for code_staging-based deploy**

Add to `tests/governor-deploy.test.js`:

```js
describe("code_staging deploy", () => {
  it("applies staged code matching deploy:pending execution_id", async () => {
    const kv = makeKVStore({
      "tool:kv_query:code": "old code",
      "tool:kv_query:meta": JSON.stringify({ description: "Read KV" }),
      "code_staging:tool:kv_query:code": JSON.stringify({
        code: "new code",
        staged_at: "2026-04-04T10:00:00Z",
        execution_id: "x_123",
      }),
      "deploy:pending": JSON.stringify({
        requested_at: "2026-04-04T10:00:01Z",
        execution_id: "x_123",
      }),
    });

    // Mock deploy function
    const mockDeploy = vi.fn(async () => ({ id: "d_1", etag: "e_1" }));

    // Import and test
    const { applyStagedCode } = await import('../governor/worker.js');
    const applied = await applyStagedCode(kv, "x_123");
    expect(applied).toHaveLength(1);
    expect(applied[0].target).toBe("tool:kv_query:code");
    expect(await kv.get("tool:kv_query:code", "text")).toBe("new code");
  });

  it("ignores staged code from different execution_id", async () => {
    const kv = makeKVStore({
      "code_staging:tool:foo:code": JSON.stringify({
        code: "stale code",
        execution_id: "x_old",
      }),
      "deploy:pending": JSON.stringify({
        execution_id: "x_new",
      }),
    });

    const { applyStagedCode } = await import('../governor/worker.js');
    const applied = await applyStagedCode(kv, "x_new");
    expect(applied).toHaveLength(0);
  });

  it("snapshots canonical code before applying", async () => {
    const kv = makeKVStore({
      "tool:kv_query:code": "original code",
      "code_staging:tool:kv_query:code": JSON.stringify({
        code: "new code",
        execution_id: "x_123",
      }),
    });

    const { snapshotCanonicalCode } = await import('../governor/worker.js');
    const snapshot = await snapshotCanonicalCode(kv, ["tool:kv_query:code"], "v_test");
    expect(snapshot["tool:kv_query:code"]).toBe("original code");
  });

  it("clears consumed code_staging keys after apply", async () => {
    const kv = makeKVStore({
      "tool:kv_query:code": "old",
      "code_staging:tool:kv_query:code": JSON.stringify({
        code: "new",
        execution_id: "x_123",
      }),
    });

    const { applyStagedCode } = await import('../governor/worker.js');
    await applyStagedCode(kv, "x_123");
    expect(await kv.get("code_staging:tool:kv_query:code")).toBeNull();
  });
});
```

Note: The actual test structure must match the existing test helpers in `tests/governor-deploy.test.js`. Read that file first to match the mock KV pattern. The tests above show the LOGIC — adapt to the actual test framework.

- [ ] **Step 2: Rewrite performDeploy in governor/worker.js**

Replace the proposal-reading logic in `performDeploy` (lines 70-142) with:

```js
async function performDeploy(kv, env) {
  const pending = await kv.get("deploy:pending", "json");
  const executionId = pending?.execution_id;

  // 1. Read all staged code matching this batch
  const allStaged = await listKeysWithPrefix(kv, "code_staging:");
  const batch = [];
  for (const key of allStaged) {
    const record = await kv.get(key, "json");
    if (record?.execution_id === executionId) {
      const target = key.replace("code_staging:", "");
      batch.push({ key, target, code: record.code, record });
    }
  }

  if (batch.length === 0) {
    // Nothing to deploy — just rebuild from current state
  }

  // 2. Snapshot canonical code before applying (for rollback)
  const versionId = `v_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  if (batch.length > 0) {
    const snapshot = {};
    for (const { target } of batch) {
      const current = await kv.get(target, "text");
      if (current !== null) snapshot[target] = current;
    }
    await kv.put(`deploy:snapshot:${versionId}`, JSON.stringify({
      files: snapshot,
      created_at: new Date().toISOString(),
    }), { metadata: { type: "deploy", format: "json" } });
  }

  // 3. Apply staged code to canonical keys
  for (const { target, code, key: stagingKey } of batch) {
    await kv.put(target, code, {
      metadata: { type: "code", format: "text", updated_at: new Date().toISOString() },
    });
    await kv.delete(stagingKey);
  }

  // 4. Read all code from KV (now includes applied changes)
  const { files, metadata } = await readCodeFromKV(kv);

  // 5. Generate index.js
  const indexJS = generateIndexJS(metadata);
  files["index.js"] = indexJS;

  // 6. Compute hashes
  const codeHashes = {};
  for (const [path, code] of Object.entries(files)) {
    codeHashes[path] = hashCode(code);
  }

  // 7. Deploy
  const deployResult = await deploy(env, files);

  // 8. Record deployment
  await recordDeployment(kv, versionId, batch.map(b => b.target), codeHashes);

  // 9. Sync to GitHub (best-effort)
  let gitSync = null;
  try {
    if (batch.length > 0) {
      const changedFiles = {};
      for (const { target } of batch) {
        const path = keyToFilePath(target);
        if (path) changedFiles[path] = await kv.get(target, 'text');
      }
      if (Object.keys(changedFiles).length > 0) {
        gitSync = await syncToGitHub(env, changedFiles, `deploy: ${versionId}`);
      }
    }
  } catch {}

  return {
    version_id: versionId,
    staged_applied: batch.length,
    files_count: Object.keys(files).length,
    git_sync: gitSync,
  };
}
```

- [ ] **Step 3: Remove applyProposalToKV**

Delete the `applyProposalToKV` function (lines 145-163) — no longer needed.

- [ ] **Step 4: Update performRollback to use snapshots**

Replace the current `performRollback` (lines 167-206) with snapshot-based rollback:

```js
async function performRollback(kv, env) {
  const history = await kv.get("deploy:history", "json") || [];
  if (history.length < 2) throw new Error("No prior version to rollback to");

  const current = history[0];
  const snapshotKey = `deploy:snapshot:${current.version_id}`;
  const snapshot = await kv.get(snapshotKey, "json");

  if (snapshot?.files) {
    // Restore canonical code from snapshot
    for (const [key, code] of Object.entries(snapshot.files)) {
      await kv.put(key, code, {
        metadata: { type: "code", format: "text", updated_at: new Date().toISOString() },
      });
    }
  }

  // Trigger fresh deploy from restored state
  const result = await performDeploy(kv, env);
  return { rolled_back_from: current.version_id, ...result };
}
```

- [ ] **Step 5: Update recordDeployment signature**

`recordDeployment` currently takes `acceptedProposals` as third arg. Change to `changedKeys` (array of strings). Read `governor/deployer.js` to find the exact function and update it.

- [ ] **Step 6: Export applyStagedCode and snapshotCanonicalCode for testing**

Extract the staging logic into named functions that tests can import.

- [ ] **Step 7: Run tests**

Run: `npm test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add governor/worker.js governor/deployer.js tests/governor-deploy.test.js
git commit -m "feat: replace proposal-based deploy with code_staging flow"
```

---

### Task 2: DR output — add code_stage_requests to applyDrResults

**Files:**
- Modify: `userspace.js` (applyDrResults, around line 853)
- Modify: `prompts/deep_reflect.md` (output schema)
- Test: `tests/userspace.test.js`

- [ ] **Step 1: Update DR prompt output schema**

In `prompts/deep_reflect.md`, update the Output section to include `code_stage_requests`:

```markdown
## Output

Respond with ONLY a JSON object:
{
  "kv_operations": [
    // pattern, desire, tactic, and (rarely) principle changes
  ],
  "code_stage_requests": [
    // Optional: code changes for tools, hooks, providers, channels
    // { "target": "tool:foo:code", "code": "export function execute..." }
  ],
  "deploy": false,
  "reflection": "what changed and why",
  "note_to_future_self": "what to watch in the next deep-reflect",
  "next_reflect": {
    "after_sessions": 20,
    "after_days": 7
  }
}
```

- [ ] **Step 2: Update applyDrResults to handle code_stage_requests**

In `userspace.js`, after the kv_operations processing in `applyDrResults` (around line 870), add:

```js
  // Code staging — DR can stage code changes for governor deployment
  if (output.code_stage_requests?.length) {
    for (const req of output.code_stage_requests) {
      try {
        await K.stageCode(req.target, req.code);
      } catch (err) {
        blocked.push({ key: req.target, error: err.message });
      }
    }
    if (output.deploy) {
      await K.signalDeploy();
      await K.karmaRecord({ event: "deploy_requested_by_dr", staged: output.code_stage_requests.length });
    }
  }
```

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add userspace.js prompts/deep_reflect.md
git commit -m "feat: applyDrResults handles code_stage_requests from DR output"
```

---

### Task 3: Remove proposal system from reflect.js and prompts

**Files:**
- Modify: `reflect.js` (remove proposal handling at lines ~176-184 and ~435-448)
- Modify: `prompts/reflect.md` (remove proposal_requests/verdicts from schema)
- Modify: `tests/helpers/mock-kernel.js` (remove proposal mocks)

- [ ] **Step 1: Remove proposal handling from reflect.js session reflect**

In `reflect.js`, find the proposal handling block (around lines 176-184):
```js
  if (output.proposal_verdicts) {
    await K.processProposalVerdicts(output.proposal_verdicts, 0);
  }
  if (output.proposal_requests) {
    for (const req of output.proposal_requests) {
      await K.createProposal(req, sessionId, 0);
    }
  }
```

Remove this entire block.

- [ ] **Step 2: Remove proposal handling from reflect.js deep reflect**

Find the deep reflect proposal handling (around lines 435-448):
```js
  if (output.proposal_verdicts) {
    await K.processProposalVerdicts(output.proposal_verdicts, depth);
  }
  if (output.proposal_requests) {
    for (const req of output.proposal_requests) {
      const id = await K.createProposal(req, sessionId, depth);
      if (id && depth >= 1) {
        await K.updateProposalStatus(id, "accepted", { accepted_by_depth: depth });
      }
    }
  }
```

Remove this entire block.

- [ ] **Step 3: Remove proposal fields from prompts/reflect.md**

In `prompts/reflect.md`, remove the `proposal_requests` and `proposal_verdicts` sections from the output schema. Keep everything else (session_summary, note_to_future_self, kv_operations, task_updates, etc).

- [ ] **Step 4: Remove proposal mocks from mock-kernel.js**

In `tests/helpers/mock-kernel.js` (around line 142), remove:
```js
createProposal: vi.fn(async () => "p_test_123"),
loadProposals: vi.fn(async () => ({})),
updateProposalStatus: vi.fn(async () => {}),
processProposalVerdicts: vi.fn(async () => {}),
```

- [ ] **Step 5: Remove proposal methods from mock-kernel.js kvWriteGated**

In the mock's `kvWriteGated`, the code key check currently says "requires proposal_requests". Update it to say code keys go through `stageCode`:
```js
// Code keys go through K.stageCode(), not direct writes
if (key.match(/^(tool|hook|provider|channel):.*:code$/)) {
  return { ok: false, error: `Code key "${key}" requires K.stageCode()` };
}
```

- [ ] **Step 6: Run tests**

Run: `npm test`
Expected: PASS (some tests may need updating if they reference proposals)

- [ ] **Step 7: Commit**

```bash
git add reflect.js prompts/reflect.md tests/helpers/mock-kernel.js
git commit -m "refactor: remove proposal system — code staging is the only path"
```

---

### Task 4: Integration test — full DR → stage → deploy flow

**Files:**
- Test: `tests/governor-deploy.test.js`

- [ ] **Step 1: Write end-to-end test**

```js
describe("full DR → stage → deploy flow", () => {
  it("DR output with code_stage_requests leads to governor deployment", async () => {
    // 1. Simulate DR output processing
    const kv = makeKVStore({
      "tool:kv_query:code": "original tool code",
      "tool:kv_query:meta": JSON.stringify({ description: "Read KV" }),
    });

    // Simulate stageCode + signalDeploy (what applyDrResults would call)
    const executionId = "x_test_123";
    await kv.put("code_staging:tool:kv_query:code", JSON.stringify({
      code: "// Updated by DR\nexport function execute(ctx) { return ctx.kv.get(ctx.key); }",
      staged_at: new Date().toISOString(),
      execution_id: executionId,
    }));
    await kv.put("deploy:pending", JSON.stringify({
      requested_at: new Date().toISOString(),
      execution_id: executionId,
    }));

    // 2. Governor picks it up
    const { applyStagedCode } = await import('../governor/worker.js');
    const applied = await applyStagedCode(kv, executionId);

    expect(applied).toHaveLength(1);
    expect(applied[0].target).toBe("tool:kv_query:code");

    // 3. Canonical code updated
    const newCode = await kv.get("tool:kv_query:code", "text");
    expect(newCode).toContain("Updated by DR");

    // 4. Staging key cleaned up
    expect(await kv.get("code_staging:tool:kv_query:code")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: PASS

- [ ] **Step 3: Commit and push**

```bash
git add tests/governor-deploy.test.js
git commit -m "test: add DR → stage → deploy integration test"
git push
```
