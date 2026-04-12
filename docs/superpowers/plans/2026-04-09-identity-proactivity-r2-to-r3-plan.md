# Identity Proactivity: Run 2 -> Run 3

## Run 2 outcome

Run 2 was a real improvement over the first identity-enabled batch.

- `meaningful_action_sessions`: `7` (up from `2`)
- `no_action_only_sessions`: `15` (down from `23`)
- first strong outward move:
  - discover `/home/swayambhu` as a real work surface
  - verify the Sadhguru position brief
  - copy it into the Akash workspace
  - launch a bounded Claude subagent
  - later retrieve its output and extract the Branch 3 schema

So the identity slice plus outward-surface planner context did fix the
original bootstrap failure mode.

## New plateau

After the first work surface was grounded, initiative narrowed too hard.

- the agent often treated callback-waiting as if it suspended all other initiative
- repeated probe wakes became thin `no_action` sessions
- stale waiting premises were sometimes replayed after grounded state had changed
- patron escalation became the main escape valve
- no non-seed `identification:*` formed yet

Claude's review identified the core issue as missing `breadth-maintenance`
in the planning layer: the system can converge onto one real surface, but it
does not yet have a strong rule for opening adjacent legitimate surfaces when
that first thread is blocked.

## Chosen refinement for Run 3

The next move is intentionally smaller than a full `task:*` / agenda system.

Implemented for run 3:

1. `environment_context` now includes:
   - `explored_paths`
   - `active_item_count`
   - `waiting_item_count`
   - `all_active_items_waiting`
   - `breadth_bias`

2. `plan.md` now has an explicit breadth-maintenance rule:
   - if active carry-forward items are all waiting on callbacks / replies /
     expiry, that wait applies only to that blocked surface
   - with healthy capacity, the planner should prefer one bounded probe of an
     adjacent unexplored surface before `no_action` or patron escalation

3. `plan.md` now also adds a stale-wait guard:
   - a wait-based `no_action` rationale must be anchored in the freshest
     grounded evidence, not replayed from stale continuity

## What run 3 should show if this worked

- more than one outward surface gets touched
- callback waiting no longer dominates the middle and late run
- fewer thin `no_action` probe sessions after the first real surface is found
- a bounded root/sibling probe should become more likely when the primary
  thread is blocked
- ideally, `/home/swami/fano` is discovered through a bounded outward probe
  rather than by direct leading in prompt text

## What would still justify a larger redesign later

If run 3 still narrows into one blocked thread despite the breadth rule, the
next likely step is a first-class `agenda` / `task:*` surface as suggested by
Gemini. That is a larger planning ontology change and should only happen if
the smaller breadth-maintenance fix is not enough.
