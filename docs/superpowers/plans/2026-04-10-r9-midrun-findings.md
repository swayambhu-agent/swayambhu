# Identity R9 Mid-Run Findings

## Purpose

This note captures the main architectural findings from the clean `r9`
identity-enabled run after the project-specific surface bridge was removed.

The goal of `r9` is cleaner than `r8`:
- no project-shaped persistence logic
- identity plus existing desire / carry-forward / reflect machinery only
- evaluate whether richer initiative can emerge from a small number of general
  concepts rather than local scaffolding

## What improved without the bridge

Even after removing the `workspace:discovered_projects -> open_surfaces` bridge,
the system still moved into legitimate external work:

- deep-reflect created a bootstrap outward desire:
  - `desire:reachable-surface-useful-contribution`
- carry-forward kept a broad outward probe alive
- act opened `/home/swami`
- the agent discovered both `arcagi3` and `fano`
- the agent repeatedly returned to `arcagi3` and did real investigation there

This is important evidence that the cleaner loop still has life:

- `identification:working-body`
- outward desire
- carry-forward
- action
- experience
- reflect

are already generating more than pure passivity.

## Strongest structural bottleneck found so far

The main bottleneck is not project memory.

It is **continuity flattening**.

Across consecutive sessions, session reflect proposed specific new
carry-forward items, but `reflect.js` discarded them because an older broad
bootstrap item already shared the same `desire_key`.

Observed repeated events:

- cycle 8: `session_3:cf1` skipped
- cycle 9: `session_4:cf1` skipped
- cycle 10: `session_5:cf1` skipped
- cycle 11: `session_6:arcagi3-assessment` skipped

All were flattened into:

- `dr_2026-04-10_bootstrap-outward-probe`

This means the system is already generating more concrete live threads, but the
continuity layer is crushing them back into one generic thread.

## Why this matters

This is a cleaner and more general explanation than the earlier
`workspace:discovered_projects` bridge.

The real question is not:

- how do we remember projects?

It is:

- how do we allow one desire to branch into several concrete living threads of
  care without losing coherence?

That is a general cognitive question, not a repo-specific one.

## Proto-DR-2 / meta-policy contribution

The new deep-reflect generation (`generation: 2`) independently surfaced
useful architectural findings through `meta_policy_notes`.

Most important:

1. `candidate-surface-inference-from-prose`
   - free-text `next_gap` / narrative material is sometimes being reified into
     bogus filesystem paths such as `/home/swami/Which`

2. `zero-tool-actions-seeding-false-continuity`
   - non-no_action plans with zero tool calls can still propagate as if real
     discovery happened

This is exactly the kind of architectural self-diagnosis the proto-DR-2 /
meta-policy pathway was intended to enable.

## External review convergence

Claude and Gemini both agreed on the continuity-flattening diagnosis.

They differed on the fix:

- Claude: prefer the subtractive fix
  - remove desire-key-only carry-forward dedup
  - rely on prompt curation plus the existing active cap
- Gemini: add a new `surface` field and dedup on `(desire_key, surface)`

Given the elegance standard, the subtractive fix currently has the burden-of-
proof advantage:

- lower LOC
- less data model growth
- more faithful to the existing prompt-level curation design

## Current architectural reading

The run suggests that identity is not yet exhausted.

The current limiting factors still look like **continuity hygiene**, not the
absence of extra cognitive layers such as personality / likes-dislikes /
tendencies.

So the likely next iteration should stay within the present framework:

1. stop flattening distinct carry-forward threads too early
2. stop converting prose into bogus candidate surfaces
3. then rerun and see whether richer outward behavior emerges naturally

Only if that still fails should new auxiliary cognitive fields be considered.
