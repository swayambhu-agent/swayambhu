# Carry-Forward Continuations Implementation Plan

This plan replaces the current task-oriented continuity path with a single `last_reflect.carry_forward` mechanism. It is self-contained and maps directly to the Round 3 recommendation:

1. Rename `last_reflect.tasks` to `last_reflect.carry_forward`
2. Rename planner injection `[CARRY-FORWARD TASKS]` to `[CARRY-FORWARD]`
3. Adopt schema: `id`, `item`, `why`, `priority`, `status`, `created_at`, `updated_at`, `expires_at`, optional `desire_key`
4. Change planner filter from “not done” to `status === "active"`
5. Update `prompts/reflect.md` for create/update/close on the new schema
6. Update `prompts/deep_reflect.md` to review/prune/merge/expire carry-forward items
7. Fix `applyDrResults` so DR writeback preserves `carry_forward`
8. Add 7-day TTL default and 5-item active cap
9. Reframe planner injection as “plans from previous session — continue or re-evaluate”
10. Keep `note_to_future_self` as unstructured orientation only

`/home/swami/swayambhu/repo/prompts/plan.md` was read for context and does not need a code change. Planner-side carry-forward rendering is assembled in `/home/swami/swayambhu/repo/userspace.js`, not in the prompt template.

## Phase 1: Rename The Continuity Mechanism In Planner And Runtime

This phase makes the architecture legible before changing behavior. It covers changes 1, 2, 4, and 9.

### Task 1.1: Rename planner input from `pendingTasks` to `carryForwardItems` and change injection wording

File: `/home/swami/swayambhu/repo/userspace.js`

Current code:

```js
async function planPhase(K, { desires, patterns, circumstances, priorActions, defaults, modelsConfig, pendingTasks }) {
```

```js
  if (pendingTasks?.length) {
    sections.push("[CARRY-FORWARD TASKS]", "(from last session's reflect — priorities to consider, desires remain the authority)");
    for (const t of pendingTasks) {
      const priority = t.priority ? `[${t.priority}] ` : "";
      const why = t.why ? ` — ${t.why}` : "";
      sections.push(`- ${priority}${t.task}${why}`);
    }
    sections.push("");
  }
```

```js
  const pendingTasks = (lastReflect?.tasks || []).filter(t => t.status !== "done");
```

```js
    const plan = await planPhase(K, { desires, patterns, circumstances, priorActions, defaults, modelsConfig, pendingTasks });
```

New code:

```js
async function planPhase(K, { desires, patterns, circumstances, priorActions, defaults, modelsConfig, carryForwardItems }) {
```

```js
  if (carryForwardItems?.length) {
    sections.push("[CARRY-FORWARD]", "(plans from previous session — continue or re-evaluate; desires remain the authority)");
    for (const item of carryForwardItems) {
      const priority = item.priority ? `[${item.priority}] ` : "";
      const why = item.why ? ` — ${item.why}` : "";
      const desire = item.desire_key ? ` (supports ${item.desire_key})` : "";
      sections.push(`- ${priority}${item.item}${why}${desire}`);
    }
    sections.push("");
  }
```

```js
  const carryForwardItems = (lastReflect?.carry_forward || []).filter(item => item.status === "active");
```

```js
    const plan = await planPhase(K, { desires, patterns, circumstances, priorActions, defaults, modelsConfig, carryForwardItems });
```

Test to write/update:

- Update `/home/swami/swayambhu/repo/tests/userspace.test.js` with a planner-context test that seeds `last_reflect.carry_forward` and asserts the first plan call contains `[CARRY-FORWARD]`, the text `plans from previous session — continue or re-evaluate`, and the rendered `item.item` string.
- Add a negative assertion that `[CARRY-FORWARD TASKS]` no longer appears.

### Task 1.2: Stop surfacing dropped/done items to the planner

File: `/home/swami/swayambhu/repo/userspace.js`

Current code:

```js
  const pendingTasks = (lastReflect?.tasks || []).filter(t => t.status !== "done");
```

New code:

```js
  const carryForwardItems = (lastReflect?.carry_forward || []).filter(item => item.status === "active");
```

Test to write/update:

- Update `/home/swami/swayambhu/repo/tests/userspace.test.js` with a case where `last_reflect.carry_forward` contains one `active`, one `done`, and one `dropped` item; assert that only the `active` item appears in the planner prompt.

## Phase 2: Introduce The New Carry-Forward Schema And Session-Reflect Merge Logic

This phase covers changes 1, 3, 5, 8, and 10.

### Task 2.1: Update the session-reflect prompt to operate on carry-forward items instead of tasks

File: `/home/swami/swayambhu/repo/prompts/reflect.md`

Current code:

```md
  "task_updates": [
    { "id": "s_...:t1", "status": "done", "result": "what happened" },
    { "id": "s_...:t2", "status": "dropped", "reason": "why" }
  ],

  "new_tasks": [
    {
      "id": "{{session_id}}:t1",
      "task": "Concrete instruction act can follow",
      "why": "Why this matters",
      "priority": "high|medium|low"
    }
  ],
```

```md
**Optional:** `next_session_config`, `task_updates`, `new_tasks`, `kv_operations`
```

```md
### note_to_future_self

This is the thread of continuity between sessions. This session is ending. Your next session will not have direct memory of this one — only what you write here and in `last_reflect`. Make it count. If you were mid-thought, finish it or point at it. If something is nagging you, say it. This is not a status report. It is one mind speaking to its next instantiation.
```

```md
### Checking tasks

If `last_reflect` contains a `tasks` array with pending items, check whether this session's karma shows progress on any of them. Update via `task_updates`:
- `done` — task was completed this session. Include `result`.
- `dropped` — task is no longer relevant. Include `reason`.

You can also create new tasks via `new_tasks` when this session revealed something that needs follow-up — a request from a contact, a tool failure worth retesting, a time-sensitive action. Keep tasks concrete and actionable. Use IDs in the format `{session_id}:t{n}`. Deep reflect will review and prune on its next run.
```

New code:

```md
  "carry_forward_updates": [
    {
      "id": "s_...:cf1",
      "status": "done",
      "updated_at": "{{now_iso}}",
      "result": "what happened"
    },
    {
      "id": "s_...:cf2",
      "status": "dropped",
      "updated_at": "{{now_iso}}",
      "reason": "why"
    },
    {
      "id": "s_...:cf3",
      "status": "active",
      "updated_at": "{{now_iso}}",
      "why": "why this is still worth carrying",
      "expires_at": "{{now_plus_7d_iso}}"
    }
  ],

  "new_carry_forward": [
    {
      "id": "{{session_id}}:cf1",
      "item": "Concrete next step act can execute",
      "why": "Why this matters",
      "priority": "high|medium|low",
      "status": "active",
      "created_at": "{{now_iso}}",
      "updated_at": "{{now_iso}}",
      "expires_at": "{{now_plus_7d_iso}}",
      "desire_key": "desire:optional_link"
    }
  ],
```

```md
**Optional:** `next_session_config`, `carry_forward_updates`, `new_carry_forward`, `kv_operations`
```

```md
### note_to_future_self

This is unstructured orientation between sessions. Use it for tone, caution, or context that does not belong in structured carry-forward items. Do not use it as a substitute for operational follow-up; actionable continuity belongs in `carry_forward`.
```

```md
### Checking carry-forward

If `last_reflect` contains a `carry_forward` array with active items, check whether this session's karma shows progress on any of them. Update via `carry_forward_updates`:
- `done` — the item was completed this session. Include `result` and `updated_at`.
- `dropped` — the item is no longer relevant. Include `reason` and `updated_at`.
- `active` — the item is still live but should be refreshed. Include any changed `why`, `priority`, `desire_key`, `updated_at`, and `expires_at`.

You can also create new carry-forward items via `new_carry_forward` when this session revealed something that needs follow-up. Each item must use this schema: `id`, `item`, `why`, `priority`, `status`, `created_at`, `updated_at`, `expires_at`, optional `desire_key`. Default to a 7-day TTL by setting `expires_at` to 7 days from now unless you have a reason to use a shorter horizon. Keep at most 5 items active at once; prefer merging or replacing instead of growing a backlog.
```

Test to write/update:

- Add a prompt contract test in `/home/swami/swayambhu/repo/tests/userspace.test.js` or a new `/home/swami/swayambhu/repo/tests/reflect.test.js` that snapshots or string-matches the loaded reflect prompt to confirm it refers to `carry_forward_updates`, `new_carry_forward`, `carry_forward`, “7-day TTL”, and “at most 5 items active”.

### Task 2.2: Replace task merge logic in `executeReflect` with carry-forward merge logic

File: `/home/swami/swayambhu/repo/reflect.js`

Current code:

```js
  // Carry forward tasks, apply updates, append new tasks
  let tasks = prevLastReflect?.tasks || [];
  if (output.task_updates) {
    const missedTasks = [];
    for (const update of output.task_updates) {
      const existing = tasks.find(t => t.id === update.id);
      if (!existing) {
        missedTasks.push(update);
        continue;
      }
      if (update.status === "done") {
        existing.status = "done";
        if (update.result) existing.result = update.result;
        existing.done_session = sessionId;
      } else if (update.status === "dropped") {
        existing.status = "dropped";
        if (update.reason) existing.reason = update.reason;
      }
    }
    if (missedTasks.length) {
      await K.karmaRecord({ event: "task_updates_missed", missed: missedTasks });
    }
  }
  if (output.new_tasks) {
    for (const task of output.new_tasks) {
      tasks.push({ ...task, status: "pending" });
    }
  }

  await K.kvWriteSafe("last_reflect", {
    ...cleanOutput,
    tasks,
    session_id: sessionId,
  });
```

New code:

```js
  const nowIso = new Date().toISOString();
  const defaultExpiresAt = new Date(Date.now() + 7 * 86400000).toISOString();

  let carry_forward = (prevLastReflect?.carry_forward || []).map(item => ({ ...item }));
  if (output.carry_forward_updates) {
    const missedCarryForward = [];
    for (const update of output.carry_forward_updates) {
      const existing = carry_forward.find(item => item.id === update.id);
      if (!existing) {
        missedCarryForward.push(update);
        continue;
      }
      Object.assign(existing, {
        ...("item" in update ? { item: update.item } : {}),
        ...("why" in update ? { why: update.why } : {}),
        ...("priority" in update ? { priority: update.priority } : {}),
        ...("status" in update ? { status: update.status } : {}),
        ...("updated_at" in update ? { updated_at: update.updated_at } : { updated_at: nowIso }),
        ...("expires_at" in update ? { expires_at: update.expires_at } : {}),
        ...("desire_key" in update ? { desire_key: update.desire_key } : {}),
        ...("result" in update ? { result: update.result } : {}),
        ...("reason" in update ? { reason: update.reason } : {}),
      });
      if (update.status === "done") existing.done_session = sessionId;
    }
    if (missedCarryForward.length) {
      await K.karmaRecord({ event: "carry_forward_updates_missed", missed: missedCarryForward });
    }
  }

  if (output.new_carry_forward) {
    for (const item of output.new_carry_forward) {
      carry_forward.push({
        ...item,
        status: item.status || "active",
        created_at: item.created_at || nowIso,
        updated_at: item.updated_at || nowIso,
        expires_at: item.expires_at || defaultExpiresAt,
      });
    }
  }

  carry_forward = carry_forward
    .map(item => {
      if (item.status === "active" && item.expires_at && new Date(item.expires_at).getTime() < Date.now()) {
        return { ...item, status: "expired", updated_at: nowIso };
      }
      return item;
    });

  const activeCount = carry_forward.filter(item => item.status === "active").length;
  if (activeCount > 5) {
    await K.karmaRecord({ event: "carry_forward_active_cap_exceeded", active: activeCount });
  }

  await K.kvWriteSafe("last_reflect", {
    ...cleanOutput,
    carry_forward,
    session_id: sessionId,
  });
```

Test to write/update:

- Add a new `executeReflect`-focused test file, `/home/swami/swayambhu/repo/tests/reflect.test.js`, covering:
  - carried-forward update from `active` to `done`
  - carried-forward update to `dropped`
  - refresh of an `active` item with new `updated_at` and `expires_at`
  - creation of a new item with default `status: "active"` and 7-day `expires_at`
  - missed update logging through `carry_forward_updates_missed`
  - expiry of an already-stale item to `expired`

### Task 2.3: Remove stale task keys from the stored session-reflect object

File: `/home/swami/swayambhu/repo/reflect.js`

Current code:

```js
  const { vikalpa_updates, vikalpas: _v, ...cleanOutput } = output;
```

New code:

```js
  const {
    vikalpa_updates,
    vikalpas: _v,
    task_updates: _taskUpdates,
    new_tasks: _newTasks,
    carry_forward_updates: _carryForwardUpdates,
    new_carry_forward: _newCarryForward,
    ...cleanOutput
  } = output;
```

Test to write/update:

- Extend `/home/swami/swayambhu/repo/tests/reflect.test.js` to assert that `last_reflect` does not persist transient prompt-output fields such as `task_updates`, `new_tasks`, `carry_forward_updates`, or `new_carry_forward`.

## Phase 3: Make Deep Reflect The Owner Of Lifecycle Hygiene

This phase covers changes 1, 3, 6, and 8.

### Task 3.1: Teach the deep-reflect prompt to review, prune, merge, expire, and cap carry-forward items

File: `/home/swami/swayambhu/repo/prompts/deep_reflect.md`

Current code:

```md
## Output

Respond with ONLY a JSON object:
{
  "kv_operations": [
    // pattern, desire, tactic, principle, config, and prompt changes
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

New code:

```md
## Carry-forward hygiene

`last_reflect.carry_forward` is the structured continuity cache for session planning. Review it explicitly on every deep-reflect run.

- Keep only items that are still grounded in current desires, patterns, or live operational reality.
- Merge duplicates or near-duplicates into a single clearer item.
- Mark stale items `expired` if their `expires_at` is in the past.
- Remove items that are already `done`, `dropped`, or no longer worth carrying.
- Keep at most 5 items with `status: "active"`. Prefer 3 when possible.
- Refresh `updated_at` and `expires_at` when you intentionally keep an item alive.
- Include `desire_key` when you can ground the item to a specific `desire:*` key; omit it when that would be fake precision.

## Output

Respond with ONLY a JSON object:
{
  "kv_operations": [
    // pattern, desire, tactic, principle, config, and prompt changes
  ],
  "carry_forward": [
    {
      "id": "{{existing_or_new_id}}",
      "item": "Concrete next step or continuation",
      "why": "Why this still matters",
      "priority": "high|medium|low",
      "status": "active|done|dropped|expired",
      "created_at": "ISO8601",
      "updated_at": "ISO8601",
      "expires_at": "ISO8601",
      "desire_key": "desire:optional_link"
    }
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

Test to write/update:

- Add a prompt contract test in `/home/swami/swayambhu/repo/tests/reflect.test.js` that checks the deep-reflect prompt now contains `carry_forward`, “merge duplicates”, “expired”, and “at most 5 items”.

### Task 3.2: Update deep-reflect writeback to use `carry_forward` and log dropped items correctly

File: `/home/swami/swayambhu/repo/reflect.js`

Current code:

```js
  if (output.tasks) reflectRecord.tasks = output.tasks;
```

```js
    const prevTasks = prevLastReflect?.tasks || [];
    const newTaskIds = new Set((output.tasks || []).map(t => t.id));
    const droppedTasks = prevTasks.filter(t => t.id && !newTaskIds.has(t.id));
    if (droppedTasks.length) {
      await K.karmaRecord({ event: "tasks_dropped", dropped: droppedTasks.map(t => ({ id: t.id, task: t.task, status: t.status })) });
    }

    await K.kvWriteSafe("last_reflect", {
      session_summary: output.reflection,
      tasks: output.tasks || [],
      was_deep_reflect: true,
      depth,
      session_id: sessionId,
    });
```

New code:

```js
  if (output.carry_forward) reflectRecord.carry_forward = output.carry_forward;
```

```js
    const prevCarryForward = prevLastReflect?.carry_forward || [];
    const newCarryForwardIds = new Set((output.carry_forward || []).map(item => item.id));
    const droppedCarryForward = prevCarryForward.filter(item => item.id && !newCarryForwardIds.has(item.id));
    if (droppedCarryForward.length) {
      await K.karmaRecord({
        event: "carry_forward_dropped",
        dropped: droppedCarryForward.map(item => ({ id: item.id, item: item.item, status: item.status })),
      });
    }

    await K.kvWriteSafe("last_reflect", {
      session_summary: output.reflection,
      carry_forward: output.carry_forward || [],
      was_deep_reflect: true,
      depth,
      session_id: sessionId,
    });
```

Test to write/update:

- Extend `/home/swami/swayambhu/repo/tests/reflect.test.js` with a depth-1 `applyReflectOutput` case that seeds previous `carry_forward`, returns a smaller `output.carry_forward`, and asserts:
  - `reflect:1:<session>` stores `carry_forward`
  - `last_reflect.carry_forward` is replaced with the DR-authored list
  - `karmaRecord` receives `carry_forward_dropped`

## Phase 4: Fix The Secondary DR Application Path In `userspace.js`

This phase covers changes 1 and 7. It is independently committable because it fixes an existing writeback inconsistency without depending on prompt changes.

### Task 4.1: Preserve `carry_forward` when `applyDrResults` overwrites `last_reflect`

File: `/home/swami/swayambhu/repo/userspace.js`

Current code:

```js
  await K.kvWriteSafe(`reflect:1:${executionId}`, {
    reflection: output.reflection,
    note_to_future_self: output.note_to_future_self,
    depth: 1,
    session_id: executionId,
    timestamp: new Date().toISOString(),
    from_dr_generation: state.generation,
  });

  await K.kvWriteSafe("last_reflect", {
    session_summary: output.reflection,
    was_deep_reflect: true,
    depth: 1,
    session_id: executionId,
  });
```

New code:

```js
  const prevLastReflect = await K.kvGet("last_reflect");
  const carry_forward = output.carry_forward || prevLastReflect?.carry_forward || [];

  await K.kvWriteSafe(`reflect:1:${executionId}`, {
    reflection: output.reflection,
    note_to_future_self: output.note_to_future_self,
    depth: 1,
    session_id: executionId,
    timestamp: new Date().toISOString(),
    from_dr_generation: state.generation,
    carry_forward,
  });

  await K.kvWriteSafe("last_reflect", {
    session_summary: output.reflection,
    note_to_future_self: output.note_to_future_self || prevLastReflect?.note_to_future_self,
    carry_forward,
    was_deep_reflect: true,
    depth: 1,
    session_id: executionId,
  });
```

Test to write/update:

- Extend `/home/swami/swayambhu/repo/tests/userspace.test.js` with two `applyDrResults` cases:
  - if `output.carry_forward` is absent, existing `last_reflect.carry_forward` survives
  - if `output.carry_forward` is present, it replaces the old list

## Phase 5: Add Planner-Side Ordering, TTL Enforcement, And Cap

This phase covers changes 3, 4, 8, and 9. It is safe after Phase 1 because it only tightens what the planner sees.

### Task 5.1: Order planner-visible items by priority and recency, and cap injection at 5

File: `/home/swami/swayambhu/repo/userspace.js`

Current code:

```js
  const carryForwardItems = (lastReflect?.carry_forward || []).filter(item => item.status === "active");
```

New code:

```js
  const priorityRank = { high: 0, medium: 1, low: 2 };
  const carryForwardItems = (lastReflect?.carry_forward || [])
    .filter(item => item.status === "active")
    .filter(item => !item.expires_at || new Date(item.expires_at).getTime() >= Date.now())
    .sort((a, b) => {
      const priorityDelta = (priorityRank[a.priority] ?? 99) - (priorityRank[b.priority] ?? 99);
      if (priorityDelta !== 0) return priorityDelta;
      return new Date(b.updated_at || b.created_at || 0).getTime() - new Date(a.updated_at || a.created_at || 0).getTime();
    })
    .slice(0, 5);
```

Test to write/update:

- Update `/home/swami/swayambhu/repo/tests/userspace.test.js` with a planner-injection test that seeds 6 active items across mixed priorities and dates, then asserts:
  - only 5 are rendered
  - expired items are omitted
  - `high` comes before `medium`/`low`
  - within a priority, more recent `updated_at` appears first

## Suggested Commit Sequence

1. `planner: rename carry-forward injection and filter active items`
2. `reflect: switch session continuity schema from tasks to carry_forward`
3. `deep-reflect: add carry-forward pruning contract and writeback`
4. `userspace: preserve carry_forward in applyDrResults`
5. `planner: sort and cap active carry-forward injection`

## Notes On Files Read But Not Changed

- `/home/swami/swayambhu/repo/prompts/plan.md`: no change required; the prompt remains generic and the carry-forward framing is injected by `planPhase(...)`.
- `/home/swami/swayambhu/repo/specs/proactive-tasks.md`: superseded by this design; leave untouched for historical context unless there is a separate cleanup task.
