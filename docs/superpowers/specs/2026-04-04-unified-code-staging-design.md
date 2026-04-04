# Unified Code Self-Modification System

Replace the disconnected code staging + proposal systems with a single
path: DR stages code → governor deploys.

## Problem

Two disconnected code modification systems exist:

1. **Code staging** (kernel primitives): `K.stageCode()` writes to
   `code_staging:*`, `K.signalDeploy()` signals governor. But the
   governor never reads `code_staging:*` — it reads `proposal:*`.

2. **Proposal system** (reflect.js): calls `K.createProposal()`,
   `K.processProposalVerdicts()` — methods that don't exist in the
   kernel. Dead code that was never wired.

The agent cannot modify its own code. The staging primitive works
but nothing picks up the staged code. The proposal path has the
lifecycle logic but no kernel implementation.

## Design

### Single path: stageCode → signalDeploy → governor deploys

```
DR output.json includes code_stage_requests
    ↓
applyDrResults calls K.stageCode() for each request
    ↓
K.stageCode writes code_staging:{key} with execution_id
    ↓
applyDrResults calls K.signalDeploy()
    ↓
Governor reads deploy:pending
    ↓
Reads code_staging:* matching batch execution_id
    ↓
Snapshots current canonical code for rollback
    ↓
Applies staged code to canonical *:code keys
    ↓
Builds index.js, deploys via CF API
    ↓
Clears consumed code_staging:* keys
```

### Only DR can stage code

Session reflect and act sessions cannot call stageCode. DR runs on
Opus with full context and is the natural gatekeeper for code
changes. Trust hierarchy: dharma > principles > DR > session reflect
\> act planner.

### DR output schema

```json
{
  "kv_operations": [],
  "code_stage_requests": [
    { "target": "tool:foo:code", "code": "export function execute..." }
  ],
  "deploy": true,
  "reflection": "...",
  "note_to_future_self": "..."
}
```

`code_stage_requests` is optional. When present, `applyDrResults`
calls `K.stageCode(target, code)` for each entry. If `deploy: true`,
calls `K.signalDeploy()` after all staging is done.

### Batch-scoped deploys

Governor only deploys staged code matching the `execution_id` from
`deploy:pending`. Prevents deploying stale leftovers from abandoned
sessions or mixing batches.

Governor flow in `performDeploy`:
1. Read `deploy:pending` → get `execution_id`
2. List `code_staging:*` keys
3. Filter to records where `execution_id` matches
4. Snapshot current canonical code to `deploy:snapshot:{version_id}`
5. Apply each staged record to its canonical key
6. Delete consumed `code_staging:*` keys
7. Build index.js from `readCodeFromKV()`
8. Deploy via CF API
9. Record in `deploy:history`

### Pre-deploy snapshots for rollback

Before applying staged code, governor writes:
```json
deploy:snapshot:{version_id} = {
  files: {
    "tool:foo:code": "previous code...",
    "hook:act:code": "previous code..."
  },
  created_at: "ISO8601",
  deploy_version: "v_..."
}
```

Rollback reads the snapshot and restores canonical keys.

### Remove proposal system

Delete from codebase:
- `reflect.js`: proposal handling at lines ~177 and ~436
- `prompts/reflect.md`: proposal_requests/verdicts output fields
- `tests/helpers/mock-kernel.js`: proposal method mocks
- `governor/worker.js`: `applyProposalToKV()`, proposal reading in
  `performDeploy()`

Replace governor's `performDeploy` with code_staging-based flow.

## Implementation scope

| File | Change |
|------|--------|
| governor/worker.js | Replace proposal-based performDeploy with code_staging flow, add pre-deploy snapshots, batch-scope by execution_id |
| governor/builder.js | No change (readCodeFromKV reads canonical keys, which are updated by governor) |
| userspace.js | applyDrResults handles code_stage_requests → K.stageCode + K.signalDeploy |
| reflect.js | Remove proposal handling (createProposal, processProposalVerdicts calls) |
| prompts/reflect.md | Remove proposal_requests/verdicts from output schema |
| prompts/deep_reflect.md | Add code_stage_requests to output schema |
| tests/helpers/mock-kernel.js | Remove proposal method mocks |
| tests/governor-deploy.test.js | Update to test code_staging-based deploys |
| kernel.js | No change (stageCode + signalDeploy already correct) |

## Design decisions

**Why remove proposals instead of keeping them?** The kernel already
doesn't implement proposal methods. reflect.js calls them but they're
dead code. Two half-implemented systems is worse than one complete
system.

**Why only DR can stage code?** Code changes have global impact
(every future session). They need the most capable model (Opus)
with full context. Session reflect on mimo-v2-pro and the act
planner on minimax should not write code.

**Why batch-scope by execution_id?** Without it, the governor
could deploy stale staged code from an abandoned session. The
execution_id links the staging batch to the deploy signal.

**Why snapshot before deploy?** The current rollback only redeploys
current KV state — if the bad code is already in canonical keys,
rollback deploys the same bad code. Snapshots store the previous
good code.

**Why code_stage_requests in DR output instead of kv_operations?**
Code staging has different semantics from KV writes — it goes
through a separate validation path (isCodeKey check), uses a
different storage prefix, and triggers governor deployment. Mixing
it with kv_operations would require the kernel to distinguish
"this is a config write" from "this is a code deploy" in the same
operation list.
