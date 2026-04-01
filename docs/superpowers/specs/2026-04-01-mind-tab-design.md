# Design: Mind Tab — Cognitive Health Dashboard

## Problem

The dashboard shows session-level data (timeline, karma, chat) but cannot
show the cognitive system working as a whole. You can see what the agent
did, but not how its mind is developing — which samskaras are forming,
which desires are evolving, how experiences flow into beliefs and actions.

## Design

### Architecture: Header Bar + Mind Tab

**Header bar** (always visible): compact cognitive health indicators
added to the existing header. Samskara count, desire count, experience
count, sessions since last deep-reflect. Glanceable — tells you whether
to look deeper.

**Mind tab**: new tab alongside Timeline, Chat, Contacts, KV Explorer,
Reflections, Modifications. The deep-dive view.

### Mind Tab Layout: Hybrid (Graph + Detail Panels)

Three sections, top to bottom:

**1. Operator Health Bar** (compact, always visible within tab)

Single row showing:
- Bootstrap status (complete / in progress / not started)
- Last deep-reflect: N sessions ago
- Last S operator output: +N created, N deepened, N eroded
- Last D operator output: N evolved
- Next deep-reflect: ~N sessions
- Store counts: N samskaras, N desires, N experiences

Data source: `reflect:schedule:1`, last `reflect:1:*` entry, counts
from `samskara:*`, `desire:*`, `experience:*` prefix listings.

**2. Flow Graph** (compact, ~180px height)

Directed graph showing the cognitive cycle left to right:

```
Experiences (ε) → [S/D operators] → Samskaras (s) + Desires (d) → Actions (a) → feedback loop → ε
```

Each column shows actual entities from KV:
- **Experiences**: recent episodes with σ score, sorted by recency
- **Samskaras**: all samskaras with strength bars, color-coded (green >0.7, amber 0.3-0.7, red <0.3)
- **Desires**: active desires with approach (↑) / avoidance (↓) indicators
- **Actions**: recent actions from karma with success/failure status

Lines connect related entities:
- Solid lines: confirmed relationships (experience fed into samskara creation/deepening)
- Dashed lines: inferred relationships (samskara informed an action)
- Line opacity scales with strength/confidence of the connection

The S/D operator badge sits between experiences and samskaras/desires,
with dashed lines showing what the operators produced.

The feedback loop arrow curves from actions back to experiences,
completing the cycle visually.

**Click interaction**: clicking any node in the graph highlights its
connections (other lines dim) and expands the corresponding detail
panel below.

**3. Detail Panels** (expandable, below graph)

Three side-by-side panels. One expands when a node is clicked:

**Samskara detail:**
- Pattern text
- Strength score (large)
- Created session, last tested session
- Strength-over-time sparkline (from karma history of strength updates)
- Connected experiences (clickable, jumps to experience detail)

**Desire detail:**
- Description with approach/avoidance indicator
- Source principles
- Last evolved session
- Magnified from which experience(s)

**Experience detail:**
- Session number
- Surprise score (σ) and salience
- Full narrative text
- What it fed into: which samskaras were deepened, which desires were
  magnified (clickable cross-references)

### Dashboard Header Extension

Add to existing header (alongside session count, next session, balances):

```
● 4 samskaras  ● 2 desires  ● 12 experiences  DR: 3 sessions ago
```

Color-coded dots match Mind tab colors (green/purple/cyan). Clicking
any metric navigates to the Mind tab.

### Data Sources

All data comes from existing KV stores via the dashboard API:

| Data | KV Source | API Endpoint |
|------|-----------|-------------|
| Samskaras | `samskara:*` | `GET /kv?prefix=samskara:` + batch read |
| Desires | `desire:*` | `GET /kv?prefix=desire:` + batch read |
| Experiences | `experience:*` | `GET /kv?prefix=experience:` + batch read |
| Operator health | `reflect:schedule:1`, `reflect:1:*` (latest) | `GET /kv/{key}` |
| Strength history | `karma:*` (samskara write events) | Existing `/kv/karma:*` |
| Actions | `karma:*` (tool_call events) | Existing `/kv/karma:*` |
| Bootstrap status | Presence of `desire:*` and `samskara:*` keys | Derived from counts |

### New API Endpoints

**`GET /mind`** — single endpoint returning the complete cognitive state:

```json
{
  "samskaras": [
    { "key": "samskara:slack-silent", "pattern": "...", "strength": 0.92 }
  ],
  "desires": [
    { "key": "desire:serve", "slug": "serve", "direction": "approach", "description": "..." }
  ],
  "experiences": [
    { "key": "experience:1711352400", "surprise_score": 0.8, "salience": 0.95, "narrative": "..." }
  ],
  "operator_health": {
    "bootstrap_complete": true,
    "last_deep_reflect_session": 44,
    "sessions_since_dr": 3,
    "next_dr_due": 49,
    "last_s_output": { "created": 1, "deepened": 2, "eroded": 0 },
    "last_d_output": { "evolved": 1 }
  }
}
```

This avoids N+1 API calls from the SPA. One fetch loads the entire
Mind tab.

### Relationship Inference

The graph needs to show connections between entities. These aren't
stored explicitly — they're inferred:

**Experience → Samskara**: an experience "fed into" a samskara if:
- The experience's session matches a karma entry that updated that samskara's strength
- Or the samskara was created in a deep-reflect that ran after the experience

**Experience → Desire**: an experience was "magnified into" a desire if:
- The desire was created/evolved in a deep-reflect that had that experience in its input set

**Samskara → Action**: a samskara "informed" an action if:
- The plan's `relies_on` field references that samskara key
- Or the samskara was surfaced by embedding selection during that session

For v1, keep relationship inference simple: session-based correlation.
If a samskara strength changed in the same session an experience was
recorded, they're connected. If a desire evolved in the same deep-reflect
that read certain experiences, they're connected.

### Implementation Scope

**SPA changes** (site/patron/index.html):
- New Mind tab component
- Flow graph renderer (SVG, no external dependencies)
- Detail panel components with expand/collapse
- Header bar extension with cognitive health counters
- Click interaction: node → highlight connections + expand panel

**API changes** (dashboard-api/worker.js):
- New `GET /mind` endpoint that batch-reads cognitive state
- Derive operator health from reflect schedule and latest reflect output

**No changes to**: kernel.js, session.js, reflect.js, eval.js, memory.js.
The Mind tab is pure read-only visualization of existing KV state.

### Visual Design

Follow existing dashboard patterns:
- Dark background (#0a0a0f)
- Samskara color: green (#22c55e)
- Desire color: purple (#a78bfa)
- Experience color: cyan (#06b6d4)
- Violation/erosion: red (#ef4444)
- High surprise: amber (#f59e0b)
- Deep-reflect events: purple (#a78bfa)
- Strength bars: color-coded by range (green >0.7, amber 0.3-0.7, red <0.3)
