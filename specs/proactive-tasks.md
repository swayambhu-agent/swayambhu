# Proactive Task Generation

## Problem

When the inbox is empty, act sessions have nothing to do. They wake, orient, check email, find nothing, and exit. This is by design — act is a dumb executor that follows instructions. But the system wastes sessions because no layer is generating work in the absence of inbound triggers.

Deep reflect has the context to identify useful work (session history, vikalpas, sankalpas, system state, wisdom), but currently only produces reflective output — observations, commitments, and assumptions. It doesn't tell act what to *do*.

## Design

### Core idea

Deep reflect generates a `tasks` array as part of its output. These are concrete, actionable items that act sessions should work through when there's no higher-priority inbound work. Session reflect carries them forward and updates their status. Act checks for pending tasks when the inbox is empty.

### Task lifecycle

```
Deep reflect or session reflect creates tasks
  → stored in last_reflect.tasks
    → act executes highest-priority pending task
      → session reflect marks done / updates / carries forward
        → next deep reflect reviews, prunes, generates new tasks
```

Both deep reflect and session reflect can create tasks. Deep reflect creates them from multi-session patterns and strategic thinking. Session reflect creates them from immediate observations — e.g. a Slack message requesting something, a tool failure that needs follow-up, a time-sensitive action. Both use the same ID format (`{session_id}:t{n}`) and schema. Deep reflect prunes and prioritizes the full list on each run.

### Deep reflect prompt addition

Add to `prompts/deep-reflect.md`, in the "What to produce" section, after the vikalpas schema:

```json
"tasks": [
  {
    "id": "{{session_id}}:t1",
    "task": "What to do, concretely enough that act can execute it",
    "why": "Why this matters — connects to sankalpas, dharma, or observed gaps",
    "priority": "high|medium|low"
  }
]
```

And a new section in the guidance:

```markdown
### On Tasks

When there is no pending inbound work, act sessions have nothing to do.
Tasks are how you give them something to do. Look at your sankalpas, your
vikalpas, your observations about system health and capability gaps, and
generate tasks that advance your dharma or improve your effectiveness.

Tasks should be concrete enough that an act session can execute them with
tools — not aspirational, not meta. "Research current Isha Foundation news
and send a summary to Swami via Slack" is a task. "Become more proactive"
is not.

Use your judgment on quantity and type. If the system is healthy and
there's genuinely nothing useful to do, an empty task list is fine.
Review and prune tasks each deep reflect — remove completed, stale,
or no-longer-relevant items.
```

### Task schema

```
id:       "{session_id}:t{n}" — same convention as vikalpas
task:     string — concrete instruction act can follow
why:      string — motivation, for session reflect's benefit
priority: "high" | "medium" | "low"
status:   "pending" | "done" | "dropped" — managed by session reflect
done_session: string | null — session ID that completed it
```

Deep reflect creates tasks with `status: "pending"`. Session reflect updates status. When deep reflect runs again, it sees the full task list (including done/dropped) and emits a fresh list — only pending tasks it wants to keep or new ones. Completed and dropped tasks are naturally pruned.

### Session reflect changes

Add to `prompts/reflect.md`:

In the output schema, add `task_updates` as optional:

```json
"task_updates": [
  { "id": "s_...:t1", "status": "done", "result": "what happened" },
  { "id": "s_...:t2", "status": "dropped", "reason": "why" }
],

"new_tasks": [
  {
    "id": "{{session_id}}:t1",
    "task": "Concrete instruction",
    "why": "Why this matters",
    "priority": "high|medium|low"
  }
]
```

In the guidance, add a section:

```markdown
### Checking tasks

If `last_reflect` contains a `tasks` array with pending items, check
whether this session's karma shows progress on any of them. Update via
`task_updates`:
- `done` — task was completed this session. Include `result`.
- `dropped` — task is no longer relevant. Include `reason`.

You can also create new tasks via `new_tasks` when this session revealed
something that needs follow-up — a request from a contact, a tool failure
worth retesting, a time-sensitive action. Keep tasks concrete and
actionable. Deep reflect will review and prune on its next run.
```

### reflect.js changes

In `executeReflect`, after the vikalpa carry-forward logic, add analogous task carry-forward:

```javascript
// Carry forward tasks, apply updates, append new tasks
let tasks = prevLastReflect?.tasks || [];
if (output.task_updates) {
  const missed = [];
  for (const update of output.task_updates) {
    const existing = tasks.find(t => t.id === update.id);
    if (!existing) {
      missed.push(update);
      continue;
    }
    if (update.status === "done") {
      existing.status = "done";
      existing.result = update.result;
      existing.done_session = sessionId;
    } else if (update.status === "dropped") {
      existing.status = "dropped";
      existing.reason = update.reason;
    }
  }
  if (missed.length) {
    await K.karmaRecord({ event: "task_updates_missed", missed });
  }
}
if (output.new_tasks) {
  for (const task of output.new_tasks) {
    tasks.push({ ...task, status: "pending" });
  }
}
```

Write `tasks` into `last_reflect` the same way vikalpas are:

```javascript
await K.kvWriteSafe("last_reflect", {
  ...output,
  vikalpas,
  tasks,
  session_id: sessionId,
});
```

In `applyReflectOutput` (deep reflect path), pass through `output.tasks` into `last_reflect` and the reflect record, same as vikalpas.

### Act prompt changes

No changes. The act prompt already receives `last_reflect` as context, which will now contain the `tasks` array. The existing instruction "Orient yourself using the context above. Then act — check what needs checking, do what needs doing" is sufficient. Act will see pending tasks and work on them. If it doesn't, session reflect will notice and that's useful signal for deep reflect.

### What this does NOT include

- **No changes to act prompt.** Act is dumb. It reads context and acts. Tasks are in the context.
- **No automatic scheduling changes.** If deep reflect decides sessions should be less frequent, it already has `next_session_config` for that.
- **No priority-based ordering in code.** Priority is guidance for the act model, not kernel logic. Act reads the tasks and uses judgment.

## Files changed

| File | Change |
|------|--------|
| `prompts/deep-reflect.md` | Add `tasks` to output schema, add "On Tasks" guidance section |
| `prompts/reflect.md` | Add `task_updates` to output schema, add "Checking tasks" section |
| `reflect.js` | Task carry-forward in `executeReflect`, task passthrough in `applyReflectOutput` |
| `tests/session.test.js` | Tests for task carry-forward, done, dropped, missed updates |
