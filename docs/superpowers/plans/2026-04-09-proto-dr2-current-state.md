# Proto-DR-2 Current State

Date: 2026-04-09

Status: implemented as test scaffolding; not currently a top-priority live architecture track

## Purpose

This note records the current practical state of proto-DR-2 / `userspace_review`
so a future session can pick it up without reconstructing the recent work.

It answers:

- what has already been implemented
- what was actually tested
- what conclusions currently hold
- how to rerun the tests correctly
- when to use proto-DR-2 versus normal live DR

## Current judgment

Proto-DR-2 is now usable as a review/lab scaffold, but the immediate reason
for building it weakened after the combined `read-path + write-path` hygiene
fixes landed.

What happened:

- Earlier variant evidence strongly suggested a missing reflective-governance /
  meta-policy surface.
- After the morning `read + write` fixes, live DR no longer showed the obvious
  bad smuggling pattern on the specific issue we were tracking.
- Live DR still has not naturally used the new `meta_policy_notes` / `review_note:*`
  path on ordinary runs.

So the current conclusion is:

- proto-DR-2 is worth keeping
- but it is currently scaffolding, not the next urgent architecture project
- it should be used when a future issue clearly does not fit cleanly into
  normal first-order buckets (`pattern`, `tactic`, `prompt patch`, etc.)

## What is implemented

### 1. Read-only `userspace_review` harness

Files:

- [userspace_review.md](/home/swami/swayambhu/repo/prompts/userspace_review.md)
- [state-lab-userspace-review.mjs](/home/swami/swayambhu/repo/scripts/state-lab-userspace-review.mjs)
- [userspace-review-result.schema.json](/home/swami/swayambhu/repo/schemas/userspace-review-result.schema.json)

This is the bundle-based proto-DR-2 path.

It:

- copies a review evidence bundle into `state-lab/reviews/.../context`
- prompts a model in read-only mode
- validates/parses a structured JSON diagnosis

This is the correct way to test cross-run architectural diagnosis.

### 2. State-lab Stage B continuation/lab support

Files:

- [state-lab.mjs](/home/swami/swayambhu/repo/scripts/state-lab.mjs)
- [2026-04-07-dr2-lab-runtime-design.md](/home/swami/swayambhu/repo/docs/superpowers/specs/2026-04-07-dr2-lab-runtime-design.md)

The local `state-lab` path now supports the shape needed for lab-style work:

- baseline/candidate branches
- bounded continuation
- branch-local service startup
- comparison summaries

This is still a proto path, but it is real enough to use.

### 3. Non-live deep-reflect meta-policy surface

Files:

- [deep_reflect.md](/home/swami/swayambhu/repo/prompts/deep_reflect.md)
- [meta-policy.js](/home/swami/swayambhu/repo/meta-policy.js)
- [userspace.js](/home/swami/swayambhu/repo/userspace.js)
- [state-lab.mjs](/home/swami/swayambhu/repo/scripts/state-lab.mjs)

Deep-reflect may now emit `meta_policy_notes`.

Those notes are:

- normalized through [meta-policy.js](/home/swami/swayambhu/repo/meta-policy.js)
- stored on `reflect:1:*`
- also written to a dedicated non-live queue under `review_note:*`
- intentionally not copied into `last_reflect`

Important boundary:

- session reflect does **not** emit architecture/meta-policy notes
- this was explicitly rolled back after testing because that role is too local

### 4. Analysis / dev-loop support

Files:

- [analyze-sessions.mjs](/home/swami/swayambhu/repo/scripts/analyze-sessions.mjs)
- [classify.mjs](/home/swami/swayambhu/repo/scripts/dev-loop/classify.mjs)
- [context.mjs](/home/swami/swayambhu/repo/scripts/dev-loop/context.mjs)
- [batch-run.mjs](/home/swami/swayambhu/repo/scripts/dev-loop/batch-run.mjs)

The analysis path now:

- loads all `reflect:{depth}:*` records, not just `reflect:1:*`
- loads `review_note:*`
- counts/audits `meta_policy_notes`
- passes `review_notes` into dev-loop context

This means future sessions can check both:

- whether notes were emitted
- and whether smuggling decreased

## What was actually tested

### A. Evidence-bundle proto-DR-2 diagnosis

Spec:

- [2026-04-09-proto-dr2-meta-policy-gap-spec.json](/home/swami/swayambhu/repo/docs/superpowers/plans/2026-04-09-proto-dr2-meta-policy-gap-spec.json)

Successful runs:

- Claude:
  [userspace-review-result.json](/home/swami/swayambhu/state-lab/reviews/2026-04-09T10-26-30-730Z-proto-dr2-meta-policy-gap-claude/userspace-review-result.json)
- Codex:
  [userspace-review-result.json](/home/swami/swayambhu/state-lab/reviews/2026-04-09T11-45-04-634Z-2026-04-09-proto-dr2-meta-policy-gap-spec/userspace-review-result.json)

Result:

- both the earlier Claude run and the later Codex run independently surfaced
  the intended `#5`-type diagnosis from the evidence bundle
- namely: there was no clean first-class route from operational traces to
  `userspace_review` / lab-ready meta-policy hypotheses

Important limitation:

- this bundle mostly reflected pre-fix variant evidence
- so it established that the gap was real in the earlier state
- it did **not** prove that the gap remained equally live after the morning
  `read + write` fixes

### B. Post-fix live DR runs

Relevant deep-reflect outputs inspected directly:

- generation 2:
  [output.json](/home/swayambhu/jobs/j_1775736346743_wfzh/output.json)
- generation 3:
  [output.json](/home/swayambhu/jobs/j_1775736872737_u1wg/output.json)

What those live DR runs showed:

- no `meta_policy_notes`
- no `review_note:*` creation
- but also no bad smuggling on the specific issue being watched

Generation 2:

- treated the issue as normal first-order cognition
- produced ordinary tactic/pattern-level updates
- did **not** misuse the new tactic in a way that the smuggling audit flagged

Generation 3:

- noticed the more subtle issue around `idle trap / circuit breaker`
- traced it to a prompt-level overreach
- produced:
  - one pattern
  - one waiting tactic
  - one targeted `prompt:plan` patch
  - reasoning artifacts
- still no `meta_policy_notes`

Interpretation:

- live DR is currently willing to stay inside normal first-order containers
  when it sees a concrete prompt/tactic fix
- that means the new review-note channel is not automatically exercised by
  every architectural-looking concern
- and that is fine if no bad smuggling is happening

## Current practical conclusion

For the original question that triggered this work:

- the combined `read-path + write-path` fixes appear to have resolved the
  specific smuggling instance we were tracking
- proto-DR-2 remains useful, but not urgent

So the right operational stance is:

- keep proto-DR-2 available
- do not force its use on issues that DR can now express cleanly as
  first-order cognition
- use it when a future issue clearly does not fit normal live buckets

## How to test proto-DR-2 in the future

There are two different tests.

### 1. Diagnostic test: evidence bundle

Use this when the question is:

- "is there a real architectural gap here?"
- "does this belong to `userspace_review` rather than DR-1?"

Recommended command:

```bash
node scripts/state-lab-userspace-review.mjs \
  --spec docs/superpowers/plans/2026-04-09-proto-dr2-meta-policy-gap-spec.json \
  --runner codex \
  --timeout-ms 300000
```

Alternate runners:

```bash
node scripts/state-lab-userspace-review.mjs \
  --spec docs/superpowers/plans/2026-04-09-proto-dr2-meta-policy-gap-spec.json \
  --runner claude \
  --timeout-ms 300000

node scripts/state-lab-userspace-review.mjs \
  --spec docs/superpowers/plans/2026-04-09-proto-dr2-meta-policy-gap-spec.json \
  --runner gemini \
  --timeout-ms 300000
```

What success looks like:

- the result explicitly says this is a structural / representational /
  review-boundary problem
- not just "add another tactic"
- not just "tweak prompt wording"

Where to inspect:

- `state-lab/reviews/<timestamp>-<slug>/userspace-review-result.json`
- plus the runner stderr/raw files in the same directory

### 2. Live DR test: note-channel usage

Use this when the question is:

- "will ordinary deep-reflect naturally emit `meta_policy_notes` here?"

Process:

1. Let the system run forward until the next DR generation.
2. Watch:
   - `dr:state:1`
   - latest `reflect:1:*`
   - `review_note:*`
3. Inspect the DR job workdir directly if KV is lagging:
   - `/home/swayambhu/jobs/<job_id>/output.json`

Useful commands:

```bash
node scripts/analyze-sessions.mjs | jq '{session_counter, dr_state, reflections, review_notes}'
```

```bash
node -e "fetch('http://localhost:8790/kv?prefix='+encodeURIComponent('review_note:'),{headers:{'X-Patron-Key':'test'}}).then(r=>r.json()).then(console.log)"
```

```bash
cat /home/swayambhu/jobs/<job_id>/output.json
```

Important caveat:

- the job workdir often finishes before KV updates `dr:state`
- so if `dr:state` is stuck at `dispatched`, inspect the job directory directly

### 3. Smuggling check

If live DR does not emit `meta_policy_notes`, that is only a problem if it
starts misusing other fields again.

Check:

- `tactic` smuggling
- `carry_forward` policy smuggling
- `experience.observation` contamination
- outbound internal-state leakage

Useful command:

```bash
node scripts/dev-loop/batch-run.mjs --cycles 5 --label proto-dr2-check
```

Then inspect:

- `dev-loop/<label>/batch-summary.json`

Also inspect the actual DR output if needed.

## When future sessions should use proto-DR-2

Use proto-DR-2 when all of the following are true:

- the issue appears across multiple sessions / runs
- DR-1 cannot express it cleanly as a `pattern`, `tactic`, `prompt patch`,
  or similar first-order change
- smuggling into the wrong field is actually happening
- the issue looks like a missing representational surface, review-boundary
  problem, or lab-validation gap

Do **not** reach for proto-DR-2 first when:

- the issue is clearly a prompt bug
- the issue is clearly a normal tactic/pattern update
- a recent hygiene fix has already made the problem expressible cleanly

## Current open question

The main unresolved question is not whether proto-DR-2 works at all.

It does, in the bundle-review sense.

The unresolved question is:

- under what conditions will ordinary live deep-reflect choose
  `meta_policy_notes` rather than ordinary first-order fixes?

That should be answered only when the next genuine architecture gap appears.

## Related files

- [2026-04-07-dr2-lab-runtime-design.md](/home/swami/swayambhu/repo/docs/superpowers/specs/2026-04-07-dr2-lab-runtime-design.md)
- [2026-04-07-userspace-review-roles.md](/home/swami/swayambhu/repo/docs/superpowers/specs/2026-04-07-userspace-review-roles.md)
- [2026-04-09-proto-dr2-meta-policy-gap-spec.json](/home/swami/swayambhu/repo/docs/superpowers/plans/2026-04-09-proto-dr2-meta-policy-gap-spec.json)
- [userspace_review.md](/home/swami/swayambhu/repo/prompts/userspace_review.md)
- [state-lab-userspace-review.mjs](/home/swami/swayambhu/repo/scripts/state-lab-userspace-review.mjs)
- [meta-policy.js](/home/swami/swayambhu/repo/meta-policy.js)
- [deep_reflect.md](/home/swami/swayambhu/repo/prompts/deep_reflect.md)
