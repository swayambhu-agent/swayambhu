# Reflect Priority Convergence After Clean Identity Run

## What the clean run established

After removing the prose-to-path and hidden-bias machinery from `userspace.js`,
the identity-enabled system still rediscovered real outward surfaces through
grounded action. In `identity-proactivity-30-r10-clean-substrate`, the agent
listed `/home/swami`, found `arcagi3` and `fano`, and produced concrete index
artifacts there without any project-specific persistence bridge.

This supports the stronger interpretation:

- identity plus the existing action/experience/desire loop can generate real
  outward exploration
- the earlier project-memory bridge was not the root mechanism

## What still looks broken

The remaining distortion is now smaller and more structural:

- session reflect can promote an internal service/working-body follow-up into
  `carry_forward` immediately after a session that opened legitimate external
  surfaces
- that follow-up can then dominate subsequent sessions, pulling the system
  inward before the new external line has been deepened

The clearest observed case is the `Slack channel health` thread created from
`org-index.md` immediately after the run had opened `fano` and `arcagi3`.

However, the later clean run also showed partial self-correction:

- after the Slack thread was diagnosed and reported, session reflect created a
  second carry-forward item:
  `Assess discovered non-self work surfaces (ARC-AGI-3, Fano Platform) and
  select one to advance concretely while awaiting Slack provisioning.`

So the system is not permanently trapped inward. It can reopen an outward line.
That lowers the required intervention:

- the remaining bug is probably not "reflect fundamentally cannot prioritize
  outward work"
- it is more likely that invalid continuity anchors and coarse carry-forward
  linking make the first inward pivot stick longer than it should

The strongest confirming evidence came in the next two sessions:

- session 5 created an outward follow-up:
  `Assess discovered non-self work surfaces (ARC-AGI-3, Fano Platform)...`
- session 6 completed that assessment, stored `workspace:fano_platform_scan`,
  and replaced it with a more concrete deliverable thread:
  `Select and execute a concrete, bounded deliverable on the Fano Platform...`

This is the clearest sign so far that simple concepts are beginning to compose:

- identity opens outward legitimacy
- desire keeps the work pointed outside the working body
- carry-forward preserves continuity
- experience from the prior probe narrows the next surface
- the next carry-forward item becomes more concrete instead of more abstract

## Claude / Gemini convergence

Claude and Gemini did not fully converge on the same root cause.

- Claude isolated the live issue more accurately:
  - session reflect invented a phantom `desire_key`
    (`desire:purposeful-service`)
  - `reflect.js` then used that nonexistent key as a dedup anchor
  - the internal thread gained an accidental continuity lock
- Gemini mostly reaffirmed the earlier circumstances-builder diagnosis
  - useful, but stale after the cleanup already applied

The part worth carrying forward is Claude's narrower point:

- the current problem is less about identity and more about how session reflect
  authors continuity

## Strongest current diagnosis

Two small structural weaknesses appear together:

1. `prompt:reflect` does not tell session reflect how to prioritize carry-forward
   after a session opens a legitimate external surface.
2. `reflect.js` dedups on `desire_key` without validating that the key actually
   exists in the current desire state.

Together they allow a cheap reflect model to:

- invent a desire link
- create an internal follow-up thread
- let that invented link monopolize continuity

But the cycle-10 evidence suggests the prompt side is only a secondary nudge.
The strongest hard bug is still the invalid `desire_key` being allowed to act as
real carry-forward structure.

## Smallest general candidate fix

Do not add new ontology.

Prefer this small package:

1. In `executeReflect()`, include the active desire keys in the session reflect
   input.
2. In `prompt:reflect`, add a short rule:
   - when this session opened a legitimate non-self surface and that surface
     remains undeepened, prefer carry-forward that continues that surface before
     switching to working-body or internal maintenance
   - only set `desire_key` when it matches one of the active desire keys shown
     in the session data; otherwise omit it
3. In `reflect.js`, only let `desire_key` participate in dedup if it matches an
   existing current desire

If later runs show that outward recovery already happens reliably without the
prompt addition, the smallest final fix may shrink further to:

- show active desire keys to reflect
- validate `desire_key` in `reflect.js`
- otherwise leave priority behavior alone

This stays within the existing framework:

- no new fields
- no environment-specific heuristics
- no project-specific memory
- no new ontology beyond the already existing desire/carry-forward loop

## Why this is still the deeper move

The issue is not "how do we make the agent remember fano?"

The deeper issue is:

- who is allowed to define continuity between sessions
- and what kinds of links are legitimate continuity anchors

That belongs squarely in the general cognitive framework.
