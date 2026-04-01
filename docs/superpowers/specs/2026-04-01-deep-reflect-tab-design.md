# Design: Deep Reflect Tab — Pipeline Debugger

## Problem

The Reflections tab shows deep-reflect output text but doesn't help
debug the cognitive pipeline. You can't see: what experiences fed into
a DR, what the S/D operators decided, why a samskara was created or
eroded, or whether the pipeline is healthy (eval working, experiences
recording, DR firing on schedule).

The old Reflections tab also shows vikalpas/sankalpas which no longer
exist in the v2 architecture.

## Design

Rename "Reflections" tab to "Deep Reflect". Replace the content with
a pipeline debugger showing two timescales: the accumulation period
(act sessions between DRs) and the DR execution itself.

Filter DR sessions out of the Timeline tab — they belong here.

### Layout: Two Panels

**DR selector** (top bar): dropdown to select which DR cycle to inspect.
Shows cost, duration, model used.

**Left panel** (280px, scrollable): the accumulation period.

- **Pipeline health indicators**: eval computation count, Tier 3
  fallback count, strength update count, experience count. Each with
  a status dot (green/amber/red).
- **Experiences produced**: all experiences recorded during the
  accumulation period. Each shows session number, σ score, narrative
  snippet, and whether it was selected as DR input. "Selected" badge
  in green, "not selected" in gray.

**Right panel** (flex, scrollable): the DR execution.

- **Reflection text**: the agent's own words, in a styled blockquote.
- **S operator output**: list of samskara changes. Each entry shows:
  - Action: CREATED (green) / DEEPENED (amber) / ERODED (red) / DELETED (red)
  - Samskara key and pattern text
  - Before → after strength (for deepened/eroded)
  - Source experiences (for created)
- **D operator output**: list of desire changes. Each entry shows:
  - Action: CREATED / EVOLVED / RETIRED
  - Before → after description (for evolved)
  - Which experiences magnified it, which principles shaped it
- **Execution trace** (compact): LLM calls with model, cost, duration.
  Tool calls with name and target. Collapsible.

### Tab Changes

- Rename "Reflections" → "Deep Reflect"
- Filter DR sessions out of Timeline tab (use existing `type: "deep_reflect"` from `/sessions` API)
- Remove vikalpas/sankalpas rendering (v1 concepts, no longer in architecture)

### Data Sources

**Accumulation period:**
- Act session karma for the period between two DRs (existing `/kv/karma:*`)
- Experience keys with timestamps in the period (`experience:*`)
- Samskara strength changes from karma entries

**DR execution:**
- DR session karma (`/kv/karma:{dr_session_id}`)
- DR output (`/kv/reflect:1:{dr_session_id}`) — reflection text, kv_operations
- Before/after samskara state inferred from kv_operations in the DR output

### New API Endpoint

**`GET /deep-reflect/:sessionId`** — returns structured DR execution data:

```json
{
  "session_id": "s_44",
  "accumulation": {
    "act_sessions": 19,
    "experiences_total": 7,
    "experiences_selected": 5,
    "eval_count": 19,
    "tier3_fallbacks": 4,
    "strength_updates": 47,
    "period": { "from_session": 25, "to_session": 43 }
  },
  "experiences": [
    {
      "key": "experience:1711352400",
      "session": "s_31",
      "surprise_score": 0.8,
      "salience": 0.95,
      "narrative": "Slack silent fail #2",
      "selected": true
    }
  ],
  "execution": {
    "karma": [...],
    "reflection": "...",
    "s_output": [
      { "action": "created", "key": "samskara:slack:silent", "pattern": "...", "strength_after": 0.3, "sources": ["s_31", "s_42"] },
      { "action": "deepened", "key": "samskara:comms:caution", "pattern": "...", "strength_before": 0.70, "strength_after": 0.85 },
      { "action": "eroded", "key": "samskara:patron:morning", "pattern": "...", "strength_before": 0.45, "strength_after": 0.18, "reason": "s_40" }
    ],
    "d_output": [
      { "action": "evolved", "key": "desire:serve", "before": "Help patrons effectively", "after": "Serve what is asked, not what I imagine is needed", "sources": ["s_35"], "principles": ["p2", "p9"] }
    ],
    "cost": 0.12,
    "duration_ms": 45000,
    "model": "claude-opus-4.6"
  }
}
```

The `s_output` and `d_output` are derived from the DR's `kv_operations`
— each write to a `samskara:*` or `desire:*` key is compared against
the state before the DR to determine action type and compute diffs.

### Implementation Scope

**API** (dashboard-api/worker.js):
- New `GET /deep-reflect/:sessionId` endpoint
- Modify `GET /sessions` to separate act and DR sessions (already has `type` field)

**SPA** (site/patron/index.html):
- Rename Reflections tab to "Deep Reflect"
- Replace ReflectionsTab component with DeepReflectTab
- Filter DR sessions from TimelineTab
- Two-panel layout: accumulation (left) + execution (right)

**No changes to**: kernel, session, reflect, eval, memory, prompts.
Pure read-only visualization.

### Visual Design

- DR selector: purple accent (#a78bfa)
- Accumulation panel: cyan for experiences (#06b6d4), status dots for health
- S operator: green (#22c55e) for created/deepened, red (#ef4444) for eroded/deleted
- D operator: purple (#a78bfa) for evolved/created
- Execution trace: blue for LLM calls, purple for tools (matches Timeline tab)
- Selected experience badge: green. Not selected: gray.
