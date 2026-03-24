# Wisdom Guide

Reference documentation for writing, reviewing, and maintaining wisdom entries.
Query this via `kv_query` with key `doc:wisdom_guide` when you need the full
schema, naming conventions, or decision criteria.

---

## Wisdom proposal format

To propose a wisdom entry, include a proposal request with `type: "wisdom"`:

```json
{
  "type": "wisdom",
  "validation": "Observed in 4 sessions where 'urgent' requests turned out to be flexible. Would be falsified by genuine time-critical situations being missed.",
  "ops": [
    {"op": "put", "key": "upaya:timing:urgency", "value": {
      "text": "Urgency is usually manufactured. Real emergencies are obvious.",
      "type": "upaya",
      "created": "2026-03-14T10:30:00Z",
      "sources": [
        {"session": "s_abc123", "depth": 1, "turn": 3, "topic": "client escalation turned out to be non-urgent"},
        {"session": "s_def456", "depth": 1, "turn": 5, "topic": "rush deployment request was actually flexible by a week"}
      ]
    }}
  ]
}
```

The `validation` field replaces `claims + checks` for wisdom. It's a natural-language statement of what evidence supports this wisdom and what would falsify it. When you review staged wisdom in a subsequent session, evaluate the validation against recent karma.

Note: `validation` lives on the proposal request (like `claims` for code), not duplicated inside the op's value. The engine stores it on the staged record. When a wisdom proposal is accepted, the engine injects `validation` from the staged record into the live entry's JSON value. Single source of truth during staging; embedded in the entry once live.

---

## When to write wisdom

Write upaya when you identify:
- A pattern in how situations, people, or contexts work
- A judgment call that succeeded or failed and carries a transferable lesson
- A pattern observed in human feedback (chats, emails, patron corrections)
- A general principle that would serve across many different situations

Write prajna when you identify:
- A recurring pattern in your own reasoning or behavior
- A bias or blind spot that affected outcomes
- A strength to leverage more deliberately
- An insight about how your own processes work or fail

Do NOT write wisdom for:
- One-off events unlikely to recur
- Facts or data (those belong in notes)
- Restatements of yamas or niyamas
- Domain-specific technical knowledge (belongs in notes)

The test: would a wise person carry this understanding regardless of what domain they're working in? If yes, it's upaya. If it's only useful in a specific technical context, it's a note.

---

## Key naming

Use descriptive, hierarchical keys. You manage the taxonomy yourself.

Upaya examples:
```
upaya:communication:less-is-more
upaya:timing:urgency
upaya:trust:earned
upaya:action:reversibility
upaya:people:listening
```

Prajna examples:
```
prajna:reasoning:complexity-bias
prajna:reasoning:confidence
prajna:communication:overexplaining
prajna:resource:time-estimation
```

---

## Schema

Every live wisdom entry is stored as JSON (validation is injected by the engine at accept time):

```json
{
  "text": "What people ask for and what they need are often different things.",
  "type": "upaya",
  "created": "2026-03-14T10:30:00Z",
  "updated": "2026-04-01T10:00:00Z",
  "validation": "Observed in 3+ sessions where stated request diverged from actual need. Would be falsified by consistent alignment between requests and underlying needs.",
  "sources": [
    {"session": "s_abc123", "depth": 1, "turn": 3, "topic": "user asked for quick fix, needed architecture"},
    {"session": "s_def456", "depth": 1, "turn": 7, "topic": "budget question masking resource concern"}
  ]
}
```

Fields:
- `text` — the wisdom itself, concise and actionable
- `type` — "upaya" or "prajna"
- `created` — when first written
- `updated` — when last modified
- `validation` — what evidence supports this and what would falsify it
- `sources` — array of sessions that contributed to this wisdom
  - `session` — session ID (karma key)
  - `depth` — reflect depth level (0, 1, 2, …)
  - `turn` — specific turn within the session where the insight crystallized
  - `topic` — brief description of what that session/turn contributed

---

## Maintenance

Each deep reflect session should:
- Review all staged wisdom proposals — issue verdicts (accept, reject, modify, defer)
- Review all inflight wisdom proposals — issue verdicts (promote, rollback, defer)
- Consolidate overlapping promoted entries
- Delete promoted wisdom no longer applicable
- Verify no entry contains domain-specific technical knowledge (move to notes)
- Verify upaya entries are about the world, prajna entries are about yourself
- Verify upaya entries remain aligned with your yamas (outer principles govern outer wisdom)
- Verify prajna entries remain aligned with your niyamas (inner principles govern inner wisdom)
