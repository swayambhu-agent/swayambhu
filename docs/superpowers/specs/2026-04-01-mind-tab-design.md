# Design: Mind Tab — Cognitive Graph Explorer

## Problem

The dashboard shows session-level data but cannot show the cognitive
system working as a whole. The original Mind tab design (four-column
flow graph) doesn't scale — with hundreds of experiences and dozens of
samskaras, you can't show everything at once.

## Design: Graph Explorer

One entity at the center, its connections radiating out. Navigate by
clicking connected nodes. Scales to any number of entities because only
the neighborhood is shown.

### Layout

Three regions:

**Left sidebar** (200px, scrollable): all entities grouped by type.
Four collapsible sections:
- **Principles** (amber) — 14 entries, immutable
- **Desires** (purple) — approach ↑ / avoidance ↓
- **Samskaras** (green) — pattern + strength score
- **Experiences** (cyan) — σ score + narrative snippet

Click any entity in the sidebar → it becomes the center node.
Selected entity is highlighted in the sidebar.

**Center graph** (flex, main area): the selected entity with upstream
(left) and downstream (right) connections.

```
[upstream nodes] ——→ [CENTER NODE] ——→ [downstream nodes]
```

Each entity type has characteristic connections:

| Center Type | Upstream (what feeds in) | Downstream (what flows out) |
|-------------|-------------------------|----------------------------|
| Principle | (none — immutable root) | Desires it shaped |
| Desire | Principles that shaped it + experiences that magnified it | Actions it generated |
| Samskara | Experiences that formed/deepened it | Actions it informed |
| Experience | Action that produced it | Samskaras it deepened + desires it magnified |

Click any connected node in the graph → it becomes the new center.
Navigation is fluid — walk the entire cognitive web node by node.

**Bottom detail strip** (compact, ~60px): key info about the selected
entity. Upstream/downstream counts. Entity-specific fields.

### Operator Health Bar

Same as current implementation — compact bar above the graph showing:
bootstrap status, DR timing, store counts. No changes needed.

### Header Bar Extension

Same as current — cognitive health counters in the always-visible
header. No changes needed.

### Data Sources

Same `GET /mind` endpoint, extended to include principles:

```json
{
  "principles": [
    { "key": "principle:2", "text": "I continually align with my dharma." }
  ],
  "samskaras": [...],
  "desires": [...],
  "experiences": [...],
  "operator_health": {...}
}
```

### Relationship Inference

Connections between entities are inferred at render time using
session-based correlation (same as before):

- **Principle → Desire**: desire's `source_principles` field references
  the principle
- **Experience → Samskara**: samskara strength changed in a session
  where the experience was recorded
- **Experience → Desire**: desire evolved in a deep-reflect that
  processed the experience
- **Desire → Action**: plan's action was generated with this desire
  active (from karma data)
- **Samskara → Action**: plan's `relies_on` references the samskara

For v1, keep inference simple. Principle→Desire uses the explicit
`source_principles` field. Other connections use session correlation.
If no connections can be inferred, show the entity alone with a note.

### Visual Design

Entity type colors (unchanged):
- Principles: amber (#f59e0b)
- Desires: purple (#a78bfa)
- Samskaras: green (#22c55e), amber (#f59e0b), red (#ef4444) by strength
- Experiences: cyan (#06b6d4)
- Actions: gray (#666)

Center node: larger, 2px border, filled background.
Connected nodes: standard size, 1px border.
Connection lines: solid for explicit relationships, dashed for inferred.

### Implementation Changes

This replaces the current MindFlowGraph and MindDetailPanels components.
The MindTab shell, MindHealthBar, header counters, and API endpoint
stay as-is.

**API changes** (dashboard-api/worker.js):
- Extend `GET /mind` to include `principles` array (read `principle:*`
  keys)

**SPA changes** (site/patron/index.html):
- Replace `MindFlowGraph` with `MindGraphExplorer` — sidebar + center
  graph + detail strip
- Remove `MindDetailPanels` (absorbed into graph explorer)
- Update `MindTab` to pass data to new component

**No changes to**: kernel, session, reflect, eval, memory, prompts.
