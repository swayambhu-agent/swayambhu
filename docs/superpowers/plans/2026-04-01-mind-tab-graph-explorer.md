# Mind Tab Graph Explorer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Mind tab's four-column flow graph with a scalable graph explorer: one entity at center, upstream/downstream connections radiating out, sidebar for entity browsing.

**Architecture:** Extend `GET /mind` API to include principles. Replace `MindFlowGraph` + `MindDetailPanels` components with a single `MindGraphExplorer` component containing a sidebar, SVG graph area, and detail strip. MindTab shell, MindHealthBar, and header counters stay unchanged.

**Tech Stack:** React 18 (browser Babel), Tailwind CSS, SVG for graph connections, inline HTML for nodes (not SVG text — proper alignment).

**Reference:** `docs/superpowers/specs/2026-04-01-mind-tab-design.md`

---

### Task 1: API — Add principles to GET /mind

**Files:**
- Modify: `dashboard-api/worker.js`

- [ ] **Step 1: Add principles to the /mind endpoint**

Find the `/mind` route in `dashboard-api/worker.js`. Add `principle:*` key listing and reading to the existing parallel reads. After the existing `Promise.all` for samskaras/desires/experiences, add principles:

```javascript
// Add to the initial Promise.all:
const principleKeys = await kvListAll(env.KV, { prefix: "principle:" });

// Add to the allKeys batch read:
...principleKeys.map(k => k.name),

// Build principles array (after the existing samskaras/desires/experiences builders):
const principles = principleKeys
  .map(k => ({ key: k.name, text: values[k.name] }))
  .filter(p => p.text);
```

Add `principles` to the return object:

```javascript
return json({ principles, samskaras, desires, experiences, operator_health: operatorHealth });
```

- [ ] **Step 2: Commit**

```bash
git add dashboard-api/worker.js
git commit -m "feat(mind): add principles to GET /mind endpoint"
```

---

### Task 2: SPA — MindGraphExplorer component (sidebar + graph + detail)

**Files:**
- Modify: `site/patron/index.html`

This replaces both `MindFlowGraph` and `MindDetailPanels` with a single `MindGraphExplorer` component.

- [ ] **Step 1: Replace MindFlowGraph and MindDetailPanels**

Delete both `MindFlowGraph` and `MindDetailPanels` function definitions entirely. Replace with the new `MindGraphExplorer`:

```javascript
function MindGraphExplorer({ data, selected, onSelect }) {
  const { principles = [], samskaras = [], desires = [], experiences = [] } = data;

  // Build connection map for the selected entity
  const connections = useMemo(() => {
    if (!selected) return { upstream: [], downstream: [] };
    const { type, key } = selected;

    const upstream = [];
    const downstream = [];

    if (type === 'principle') {
      // Principles are roots — no upstream
      // Downstream: desires that reference this principle
      const pNum = key.replace('principle:', '');
      desires.forEach(d => {
        const sources = d.source_principles || [];
        if (sources.some(s => s === pNum || s === `p${pNum}` || s === key)) {
          downstream.push({ ...d, _type: 'desire' });
        }
      });
    }

    if (type === 'desire') {
      // Upstream: principles that shaped it
      const d = desires.find(d => d.key === key);
      if (d?.source_principles) {
        d.source_principles.forEach(pRef => {
          const p = principles.find(p =>
            p.key === pRef || p.key === `principle:${pRef}` || p.key.endsWith(`:${pRef}`)
          );
          if (p) upstream.push({ ...p, _type: 'principle' });
        });
      }
      // Upstream: experiences (session correlation — all recent for now)
      experiences.slice(0, 5).forEach(e => {
        upstream.push({ ...e, _type: 'experience' });
      });
    }

    if (type === 'samskara') {
      // Upstream: experiences (session correlation)
      experiences.slice(0, 5).forEach(e => {
        upstream.push({ ...e, _type: 'experience' });
      });
    }

    if (type === 'experience') {
      // Downstream: samskaras it may have deepened
      samskaras.forEach(s => {
        downstream.push({ ...s, _type: 'samskara' });
      });
      // Downstream: desires it may have magnified
      desires.forEach(d => {
        downstream.push({ ...d, _type: 'desire' });
      });
    }

    return { upstream, downstream };
  }, [selected, principles, samskaras, desires, experiences]);

  // Get the selected entity's full data
  const centerEntity = useMemo(() => {
    if (!selected) return null;
    const { type, key } = selected;
    if (type === 'principle') return principles.find(p => p.key === key);
    if (type === 'desire') return desires.find(d => d.key === key);
    if (type === 'samskara') return samskaras.find(s => s.key === key);
    if (type === 'experience') return experiences.find(e => e.key === key);
    return null;
  }, [selected, principles, samskaras, desires, experiences]);

  // Entity display helpers
  const typeColor = (t) => ({ principle: '#f59e0b', desire: '#a78bfa', samskara: '#22c55e', experience: '#06b6d4' }[t] || '#666');
  const strengthColor = (s) => s > 0.7 ? '#22c55e' : s > 0.3 ? '#f59e0b' : '#ef4444';
  const trunc = (t, n) => t && t.length > n ? t.slice(0, n - 1) + '…' : (t || '');

  // Sidebar item renderer
  const SidebarItem = ({ entity, type }) => {
    const isActive = selected?.type === type && selected?.key === entity.key;
    const col = typeColor(type);
    return (
      <div
        onClick={() => onSelect({ type, key: entity.key })}
        className="cursor-pointer rounded px-1.5 py-1 mb-0.5 text-xs transition"
        style={{
          background: isActive ? `${col}22` : 'transparent',
          border: isActive ? `1px solid ${col}44` : '1px solid transparent',
          color: isActive ? '#e5e5e5' : '#888',
        }}
      >
        {type === 'principle' && trunc(entity.text || entity.key, 28)}
        {type === 'desire' && (
          <span><span style={{ color: entity.direction === 'avoidance' ? '#ef4444' : '#22c55e' }}>
            {entity.direction === 'avoidance' ? '↓' : '↑'}
          </span> {trunc(entity.description || entity.slug, 24)}</span>
        )}
        {type === 'samskara' && (
          <span className="flex justify-between">
            <span>{trunc(entity.pattern, 22)}</span>
            <span style={{ color: strengthColor(entity.strength), fontSize: 10 }}>{entity.strength?.toFixed(2)}</span>
          </span>
        )}
        {type === 'experience' && (
          <span><span style={{ color: '#06b6d4', fontSize: 10 }}>σ{entity.surprise_score?.toFixed(1)}</span> {trunc(entity.narrative || entity.action_taken, 20)}</span>
        )}
      </div>
    );
  };

  // Connected node renderer (for the graph area)
  const ConnectedNode = ({ entity, type, side }) => {
    const col = typeColor(type);
    return (
      <div
        onClick={() => onSelect({ type, key: entity.key })}
        className="cursor-pointer rounded-md mb-2 transition"
        style={{
          padding: '8px 10px',
          background: `${col}0d`,
          border: `1px solid ${col}30`,
          maxWidth: 200,
        }}
      >
        <div style={{ fontSize: 10, color: col, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 2 }}>{type}</div>
        {type === 'principle' && <div style={{ fontSize: 12, color: '#e5e5e5' }}>{trunc(entity.text, 40)}</div>}
        {type === 'desire' && (
          <div style={{ fontSize: 12, color: '#e5e5e5' }}>
            <span style={{ color: entity.direction === 'avoidance' ? '#ef4444' : '#22c55e' }}>
              {entity.direction === 'avoidance' ? '↓' : '↑'}
            </span> {trunc(entity.description || entity.slug, 35)}
          </div>
        )}
        {type === 'samskara' && (
          <>
            <div style={{ fontSize: 12, color: '#e5e5e5' }}>{trunc(entity.pattern, 35)}</div>
            <div style={{ fontSize: 10, color: strengthColor(entity.strength), marginTop: 2 }}>
              strength: {entity.strength?.toFixed(2)}
            </div>
          </>
        )}
        {type === 'experience' && (
          <>
            <div style={{ fontSize: 11, color: '#06b6d4' }}>σ={entity.surprise_score?.toFixed(2)}</div>
            <div style={{ fontSize: 12, color: '#d4d4d4', marginTop: 2 }}>{trunc(entity.narrative || entity.action_taken, 40)}</div>
          </>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Sidebar */}
      <div className="overflow-y-auto flex-shrink-0 border-r border-border" style={{ width: 200 }}>
        {[
          { label: 'Principles', type: 'principle', items: principles, color: '#f59e0b' },
          { label: 'Desires', type: 'desire', items: desires, color: '#a78bfa' },
          { label: 'Samskaras', type: 'samskara', items: samskaras, color: '#22c55e' },
          { label: 'Experiences', type: 'experience', items: experiences, color: '#06b6d4' },
        ].map(({ label, type, items, color }) => (
          <div key={type} className="border-b border-border" style={{ padding: '8px 10px' }}>
            <div style={{ fontSize: 10, color, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>
              {label} ({items.length})
            </div>
            {items.slice(0, 10).map(entity => (
              <SidebarItem key={entity.key} entity={entity} type={type} />
            ))}
            {items.length > 10 && (
              <div className="text-xs text-gray-600 px-1.5 py-1">+{items.length - 10} more</div>
            )}
          </div>
        ))}
      </div>

      {/* Graph area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {!selected ? (
          <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
            Select an entity from the sidebar to explore its connections
          </div>
        ) : (
          <>
            {/* Graph: upstream → center → downstream */}
            <div className="flex-1 flex items-stretch overflow-auto p-4 gap-4">
              {/* Upstream */}
              <div className="flex flex-col justify-center" style={{ minWidth: 180 }}>
                {connections.upstream.length > 0 ? (
                  <>
                    <div style={{ fontSize: 9, color: '#666', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6, textAlign: 'center' }}>
                      upstream
                    </div>
                    {connections.upstream.map(e => (
                      <ConnectedNode key={e.key} entity={e} type={e._type} side="left" />
                    ))}
                  </>
                ) : (
                  <div className="text-xs text-gray-700 text-center italic">
                    {selected.type === 'principle' ? 'immutable root' : 'no upstream found'}
                  </div>
                )}
              </div>

              {/* Connection lines (left) */}
              <div className="flex items-center" style={{ width: 40 }}>
                {connections.upstream.length > 0 && (
                  <svg width="40" height="100%" style={{ overflow: 'visible' }}>
                    <line x1="0" y1="50%" x2="40" y2="50%" stroke="#555" strokeWidth="1" strokeDasharray="4,3" />
                  </svg>
                )}
              </div>

              {/* Center node */}
              <div className="flex flex-col justify-center" style={{ minWidth: 220 }}>
                <div
                  className="rounded-lg p-4"
                  style={{
                    background: `${typeColor(selected.type)}18`,
                    border: `2px solid ${typeColor(selected.type)}`,
                    maxWidth: 280,
                  }}
                >
                  <div style={{ fontSize: 10, color: typeColor(selected.type), textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>
                    {selected.type}
                  </div>
                  {selected.type === 'principle' && centerEntity && (
                    <div style={{ fontSize: 14, color: '#e5e5e5', lineHeight: 1.5 }}>{centerEntity.text}</div>
                  )}
                  {selected.type === 'desire' && centerEntity && (
                    <>
                      <div style={{ fontSize: 14, color: '#e5e5e5', lineHeight: 1.5 }}>
                        <span style={{ color: centerEntity.direction === 'avoidance' ? '#ef4444' : '#22c55e', fontSize: 18 }}>
                          {centerEntity.direction === 'avoidance' ? '↓' : '↑'}
                        </span>{' '}
                        {centerEntity.description || centerEntity.slug}
                      </div>
                      <div className="text-xs text-gray-500 mt-2">
                        {centerEntity.direction} · {centerEntity.source_principles?.join(', ')}
                      </div>
                    </>
                  )}
                  {selected.type === 'samskara' && centerEntity && (
                    <>
                      <div style={{ fontSize: 14, color: '#e5e5e5', lineHeight: 1.5 }}>{centerEntity.pattern}</div>
                      <div style={{ marginTop: 8 }}>
                        <div style={{ height: 6, background: 'rgba(255,255,255,0.08)', borderRadius: 3 }}>
                          <div style={{
                            width: `${(centerEntity.strength || 0) * 100}%`, height: '100%',
                            background: strengthColor(centerEntity.strength), borderRadius: 3,
                          }} />
                        </div>
                        <div style={{ fontSize: 18, fontWeight: 'bold', color: strengthColor(centerEntity.strength), marginTop: 4, fontFamily: 'monospace' }}>
                          {centerEntity.strength?.toFixed(2)}
                        </div>
                      </div>
                    </>
                  )}
                  {selected.type === 'experience' && centerEntity && (
                    <>
                      <div className="text-xs mb-2">
                        <span style={{ color: '#06b6d4' }}>σ={centerEntity.surprise_score?.toFixed(2)}</span>
                        <span className="text-gray-600 mx-1">·</span>
                        <span style={{ color: '#f59e0b' }}>salience={centerEntity.salience?.toFixed(2)}</span>
                      </div>
                      {centerEntity.action_taken && (
                        <div className="text-xs text-gray-400 mb-1">Action: {centerEntity.action_taken}</div>
                      )}
                      <div style={{ fontSize: 13, color: '#d4d4d4', lineHeight: 1.5 }}>
                        {centerEntity.narrative || centerEntity.outcome}
                      </div>
                      {centerEntity.timestamp && (
                        <div className="text-xs text-gray-600 mt-2">{new Date(centerEntity.timestamp).toLocaleString()}</div>
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* Connection lines (right) */}
              <div className="flex items-center" style={{ width: 40 }}>
                {connections.downstream.length > 0 && (
                  <svg width="40" height="100%" style={{ overflow: 'visible' }}>
                    <line x1="0" y1="50%" x2="40" y2="50%" stroke="#555" strokeWidth="1" strokeDasharray="4,3" />
                  </svg>
                )}
              </div>

              {/* Downstream */}
              <div className="flex flex-col justify-center" style={{ minWidth: 180 }}>
                {connections.downstream.length > 0 ? (
                  <>
                    <div style={{ fontSize: 9, color: '#666', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6, textAlign: 'center' }}>
                      downstream
                    </div>
                    {connections.downstream.map(e => (
                      <ConnectedNode key={e.key} entity={e} type={e._type} side="right" />
                    ))}
                  </>
                ) : (
                  <div className="text-xs text-gray-700 text-center italic">no downstream found</div>
                )}
              </div>
            </div>

            {/* Detail strip */}
            <div className="border-t border-border px-4 py-2 flex gap-6 items-center text-xs" style={{ background: 'rgba(255,255,255,0.02)' }}>
              <div>
                <span style={{ color: typeColor(selected.type) }}>{selected.type}</span>
                <span className="text-gray-600 ml-2 font-mono">{selected.key}</span>
              </div>
              <div className="ml-auto text-gray-500">
                {connections.upstream.length > 0 && (
                  <span className="mr-4">← {connections.upstream.length} upstream</span>
                )}
                {connections.downstream.length > 0 && (
                  <span>{connections.downstream.length} downstream →</span>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Update MindTab to use MindGraphExplorer**

Find the `MindTab` component's return statement. Replace the `MindFlowGraph` and `MindDetailPanels` lines:

```javascript
// Before:
<MindFlowGraph data={data} selected={selected} onSelect={setSelected} />
<MindDetailPanels data={data} selected={selected} onSelect={setSelected} />

// After:
<MindGraphExplorer data={data} selected={selected} onSelect={setSelected} />
```

- [ ] **Step 3: Verify it renders**

Start the dashboard, open Mind tab. Sidebar should show entity lists.
Click any entity — graph should show center node with connections.

- [ ] **Step 4: Commit**

```bash
git add site/patron/index.html
git commit -m "feat(mind): graph explorer replaces four-column flow graph"
```

---

### Task 3: Polish — empty states and auto-select

**Files:**
- Modify: `site/patron/index.html`

- [ ] **Step 1: Auto-select first entity on load**

In the `MindTab` component, add an effect that auto-selects the first
available entity when data loads and nothing is selected:

```javascript
useEffect(() => {
  if (data && !selected) {
    // Auto-select first principle, or first desire, or first samskara, or first experience
    const first = data.principles?.[0] || data.desires?.[0] || data.samskaras?.[0] || data.experiences?.[0];
    if (first) {
      const type = first.text !== undefined && !first.pattern ? 'principle'
        : first.direction !== undefined ? 'desire'
        : first.pattern !== undefined ? 'samskara'
        : 'experience';
      setSelected({ type, key: first.key });
    }
  }
}, [data, selected]);
```

- [ ] **Step 2: Handle empty data gracefully**

The MindGraphExplorer already shows "Select an entity" when nothing is
selected, and the sidebar shows "(0)" counts for empty sections. Verify
these work when all stores are empty (fresh bootstrap).

- [ ] **Step 3: Commit**

```bash
git add site/patron/index.html
git commit -m "feat(mind): auto-select first entity, empty state handling"
```
