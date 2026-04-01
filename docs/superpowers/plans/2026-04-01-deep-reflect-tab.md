# Deep Reflect Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Reflections tab with a Deep Reflect pipeline debugger showing two timescales: the accumulation period (act sessions between DRs) and the DR execution with S/D operator outputs.

**Architecture:** New `GET /deep-reflect/:sessionId` API endpoint computes accumulation stats and structures DR output. SPA replaces `ReflectionsTab` with `DeepReflectTab` — DR selector, left panel (accumulation), right panel (execution). Timeline tab filters out DR sessions.

**Tech Stack:** React 18 (browser Babel), Tailwind CSS, Cloudflare Workers KV.

**Reference:** `docs/superpowers/specs/2026-04-01-deep-reflect-tab-design.md`

---

### Task 1: API — GET /deep-reflect/:sessionId endpoint

**Files:**
- Modify: `dashboard-api/worker.js`

- [ ] **Step 1: Add the route**

In `dashboard-api/worker.js`, add a new route inside the auth-required section. Find a good spot after the `/mind` route. The route matches `/deep-reflect/` followed by a session ID.

```javascript
// GET /deep-reflect/:sessionId — structured DR execution data
const drMatch = path.match(/^\/deep-reflect\/(.+)$/);
if (drMatch) {
  const drSessionId = decodeURIComponent(drMatch[1]);

  // Load DR output
  const drOutput = await env.KV.get(`reflect:1:${drSessionId}`, "json");
  if (!drOutput) return json({ error: "DR session not found" }, 404);

  // Load DR karma
  const drKarma = await env.KV.get(`karma:${drSessionId}`, "json");

  // Find the previous DR to determine accumulation period
  const allReflectKeys = await kvListAll(env.KV, { prefix: "reflect:1:" });
  const drSessionIds = allReflectKeys
    .filter(k => !k.name.includes("schedule"))
    .map(k => k.name.replace("reflect:1:", ""))
    .sort();
  const drIndex = drSessionIds.indexOf(drSessionId);
  const prevDrSessionId = drIndex > 0 ? drSessionIds[drIndex - 1] : null;

  // Load all session IDs and karma keys
  const allKarmaKeys = await kvListAll(env.KV, { prefix: "karma:" });
  const allSessionIds = allKarmaKeys.map(k => k.name.replace("karma:", "")).sort();

  // Find act sessions in the accumulation period (between prev DR and this DR)
  const actSessions = allSessionIds.filter(id => {
    if (id === drSessionId) return false;
    if (drSessionIds.includes(id)) return false; // skip other DRs
    if (prevDrSessionId && id <= prevDrSessionId) return false;
    if (id > drSessionId) return false;
    return true;
  });

  // Load experiences from the accumulation period
  const experienceKeys = await kvListAll(env.KV, { prefix: "experience:" });
  const periodExperiences = [];
  for (const ek of experienceKeys) {
    const exp = await env.KV.get(ek.name, "json");
    if (!exp) continue;
    // Include if timestamp falls in accumulation period
    periodExperiences.push({ key: ek.name, ...exp });
  }
  // Sort by timestamp, newest first
  periodExperiences.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));

  // Compute accumulation stats from act session karma
  let evalCount = 0, tier3Count = 0, strengthUpdates = 0;
  for (const sid of actSessions.slice(-20)) { // sample last 20 for perf
    const karma = await env.KV.get(`karma:${sid}`, "json");
    if (!karma) continue;
    for (const entry of karma) {
      if (entry.event === 'llm_call' && entry.step?.includes('eval_tier3')) tier3Count++;
      if (entry.event === 'llm_call' && entry.step?.includes('eval')) evalCount++;
    }
  }

  // Parse S/D operator output from DR's kv_operations
  const sOutput = [];
  const dOutput = [];
  for (const op of (drOutput.kv_operations || [])) {
    if (op.key?.startsWith('samskara:')) {
      sOutput.push({
        action: op.op === 'delete' ? 'deleted' : 'written',
        key: op.key,
        pattern: op.value?.pattern,
        strength: op.value?.strength,
      });
    }
    if (op.key?.startsWith('desire:')) {
      dOutput.push({
        action: op.op === 'delete' ? 'retired' : 'written',
        key: op.key,
        description: op.value?.description,
        direction: op.value?.direction,
        source_principles: op.value?.source_principles,
      });
    }
  }

  // DR execution cost and duration from karma
  let cost = 0, durationMs = 0;
  let model = null;
  if (drKarma) {
    for (const entry of drKarma) {
      if (entry.cost) cost += entry.cost;
      if (entry.event === 'llm_call' && entry.model) model = entry.model;
    }
    const times = drKarma.filter(e => e.t).map(e => e.t);
    if (times.length >= 2) durationMs = Math.max(...times) - Math.min(...times);
  }

  return json({
    session_id: drSessionId,
    accumulation: {
      act_sessions: actSessions.length,
      experiences_total: periodExperiences.length,
      eval_count: evalCount,
      tier3_fallbacks: tier3Count,
      period: {
        from_session: actSessions[0] || null,
        to_session: actSessions[actSessions.length - 1] || null,
      },
    },
    experiences: periodExperiences.slice(0, 20).map(e => ({
      key: e.key,
      surprise_score: e.surprise_score,
      salience: e.salience,
      narrative: e.narrative,
      action_taken: e.action_taken,
      timestamp: e.timestamp,
    })),
    execution: {
      reflection: drOutput.reflection,
      note_to_future_self: drOutput.note_to_future_self,
      s_output: sOutput,
      d_output: dOutput,
      cost: Math.round(cost * 10000) / 10000,
      duration_ms: durationMs,
      model,
      karma_count: drKarma?.length || 0,
    },
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add dashboard-api/worker.js
git commit -m "feat(dr-tab): add GET /deep-reflect/:sessionId endpoint"
```

---

### Task 2: SPA — DeepReflectTab component

**Files:**
- Modify: `site/patron/index.html`

This replaces the existing `ReflectionsTab` component with `DeepReflectTab`.

- [ ] **Step 1: Rename tab in the tabs array**

Find the tabs array and change reflections to deep-reflect:

```javascript
// Change:
{ id: 'reflections', label: 'Reflections' },
// To:
{ id: 'reflections', label: 'Deep Reflect' },
```

Keep the id as `'reflections'` to avoid changing the mount point and active tab logic.

- [ ] **Step 2: Replace ReflectionsTab with DeepReflectTab**

Delete the entire `ReflectionsTab` function (lines ~887-983). Replace with:

```javascript
function ReflectionsTab({ patronKey }) {
  const [drSessions, setDrSessions] = useState([]);
  const [selectedDr, setSelectedDr] = useState(null);
  const [drData, setDrData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [drLoading, setDrLoading] = useState(false);

  // Load DR session list
  useEffect(() => {
    api('/sessions', patronKey).then(d => {
      const drs = (d.sessions || [])
        .filter(s => s.type === 'deep_reflect')
        .reverse(); // newest first
      setDrSessions(drs);
      if (drs.length > 0) setSelectedDr(drs[0].id);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [patronKey]);

  // Load selected DR data
  useEffect(() => {
    if (!selectedDr) return;
    setDrLoading(true);
    api(`/deep-reflect/${encodeURIComponent(selectedDr)}`, patronKey)
      .then(d => { setDrData(d); setDrLoading(false); })
      .catch(() => setDrLoading(false));
  }, [selectedDr, patronKey]);

  if (loading) return <div className="p-8 text-gray-500 text-sm">Loading deep reflect sessions...</div>;
  if (drSessions.length === 0) return <div className="p-8 text-gray-500 text-sm">No deep reflect sessions yet</div>;

  return (
    <div className="flex flex-col h-full">
      {/* DR selector bar */}
      <div className="px-4 py-2 bg-bg-panel border-b border-border flex items-center gap-3 text-xs flex-shrink-0">
        <span className="text-purple-400 font-semibold">Deep Reflect</span>
        <select
          value={selectedDr || ''}
          onChange={e => setSelectedDr(e.target.value)}
          className="bg-bg-card border border-border text-gray-200 px-2 py-1 rounded text-xs"
        >
          {drSessions.map((s, i) => (
            <option key={s.id} value={s.id}>
              DR #{drSessions.length - i} \u2014 {s.id}
            </option>
          ))}
        </select>
        {drData && (
          <div className="ml-auto flex gap-3 text-gray-500">
            <span>Cost: <span className="text-gray-200">${drData.execution?.cost?.toFixed(4)}</span></span>
            <span>Duration: <span className="text-gray-200">{Math.round((drData.execution?.duration_ms || 0) / 1000)}s</span></span>
            {drData.execution?.model && (
              <span>Model: <span className="text-gray-200">{drData.execution.model}</span></span>
            )}
          </div>
        )}
      </div>

      {drLoading ? (
        <div className="p-8 text-gray-500 text-sm">Loading DR #{selectedDr}...</div>
      ) : drData ? (
        <div className="flex flex-1 overflow-hidden">
          {/* Left: Accumulation period */}
          <div className="overflow-y-auto flex-shrink-0 border-r border-border" style={{ width: 280 }}>
            <div className="px-3 py-2 border-b border-border" style={{ background: 'rgba(255,255,255,0.02)' }}>
              <div style={{ fontSize: 10, color: '#06b6d4', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 2 }}>Accumulation Period</div>
              <div className="text-xs text-gray-500">
                {drData.accumulation?.act_sessions || 0} act sessions
                {drData.accumulation?.period?.from_session && (
                  <span> \u00b7 {drData.accumulation.period.from_session.slice(2, 15)} to {drData.accumulation.period.to_session?.slice(2, 15)}</span>
                )}
              </div>
            </div>

            {/* Pipeline health */}
            <div className="px-3 py-2 border-b border-border">
              <div style={{ fontSize: 10, color: '#888', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Pipeline Health</div>
              <div className="space-y-1 text-xs">
                <div className="flex items-center gap-1.5">
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} />
                  <span className="text-gray-300">Eval: {drData.accumulation?.eval_count || 0} computed</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: (drData.accumulation?.tier3_fallbacks || 0) > 0 ? '#f59e0b' : '#22c55e', display: 'inline-block' }} />
                  <span className="text-gray-300">Tier 3 fallback: {drData.accumulation?.tier3_fallbacks || 0}x</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} />
                  <span className="text-gray-300">Experiences: {drData.accumulation?.experiences_total || 0} recorded</span>
                </div>
              </div>
            </div>

            {/* Experiences */}
            <div className="px-3 py-2">
              <div style={{ fontSize: 10, color: '#06b6d4', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>
                Experiences ({drData.experiences?.length || 0})
              </div>
              {(drData.experiences || []).map(e => (
                <div key={e.key} className="mb-1.5 rounded" style={{ padding: '5px 8px', background: 'rgba(6,182,212,0.06)', borderLeft: '2px solid #06b6d4' }}>
                  <div style={{ fontSize: 10, display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: '#06b6d4' }}>\u03c3={e.surprise_score?.toFixed(1) ?? '?'}</span>
                    <span style={{ color: '#f59e0b', fontSize: 9 }}>sal={e.salience?.toFixed(2) ?? '?'}</span>
                  </div>
                  <div style={{ fontSize: 11, color: '#bbb', marginTop: 2 }}>{e.narrative?.slice(0, 60) || e.action_taken || '(no narrative)'}{e.narrative?.length > 60 ? '\u2026' : ''}</div>
                </div>
              ))}
              {(!drData.experiences || drData.experiences.length === 0) && (
                <div className="text-xs text-gray-600">No experiences in this period</div>
              )}
            </div>
          </div>

          {/* Right: DR Execution */}
          <div className="flex-1 overflow-y-auto">
            {/* Reflection text */}
            <div className="p-4">
              <div style={{ fontSize: 10, color: '#888', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Reflection</div>
              {drData.execution?.reflection ? (
                <div style={{ fontSize: 12, color: '#d4d4d4', lineHeight: 1.6, padding: 12, background: 'rgba(255,255,255,0.03)', borderRadius: 6, borderLeft: '3px solid #a78bfa' }}>
                  {drData.execution.reflection}
                </div>
              ) : (
                <div className="text-xs text-gray-600">No reflection text</div>
              )}
            </div>

            {/* S Operator Output */}
            {drData.execution?.s_output?.length > 0 && (
              <div className="px-4 pb-4">
                <div style={{ fontSize: 10, color: '#22c55e', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>S Operator \u2192 Samskaras</div>
                {drData.execution.s_output.map((s, i) => {
                  const isDelete = s.action === 'deleted';
                  const col = isDelete ? '#ef4444' : '#22c55e';
                  return (
                    <div key={i} className="mb-2 rounded-md" style={{ padding: '8px 10px', background: `${col}0a`, border: `1px solid ${col}25` }}>
                      <div className="flex justify-between items-center">
                        <div>
                          <span style={{ fontSize: 10, color: col, fontWeight: 600, textTransform: 'uppercase' }}>{isDelete ? 'DELETED' : 'WRITTEN'}</span>
                          <span className="text-gray-300 text-xs ml-2">{s.key}</span>
                        </div>
                        {s.strength != null && (
                          <span style={{ fontSize: 12, color: col, fontWeight: 'bold', fontFamily: 'monospace' }}>{s.strength.toFixed(2)}</span>
                        )}
                      </div>
                      {s.pattern && <div className="text-gray-400 text-xs mt-1">"{s.pattern}"</div>}
                    </div>
                  );
                })}
              </div>
            )}

            {/* D Operator Output */}
            {drData.execution?.d_output?.length > 0 && (
              <div className="px-4 pb-4">
                <div style={{ fontSize: 10, color: '#a78bfa', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>D Operator \u2192 Desires</div>
                {drData.execution.d_output.map((d, i) => {
                  const isRetire = d.action === 'retired';
                  const col = isRetire ? '#ef4444' : '#a78bfa';
                  const arrow = d.direction === 'avoidance' ? '\u2193' : '\u2191';
                  const arrowCol = d.direction === 'avoidance' ? '#ef4444' : '#22c55e';
                  return (
                    <div key={i} className="mb-2 rounded-md" style={{ padding: '8px 10px', background: `${col}0a`, border: `1px solid ${col}25` }}>
                      <div className="flex items-center gap-1.5">
                        <span style={{ fontSize: 10, color: col, fontWeight: 600, textTransform: 'uppercase' }}>{isRetire ? 'RETIRED' : 'WRITTEN'}</span>
                        <span className="text-gray-300 text-xs">{d.key}</span>
                      </div>
                      {d.description && (
                        <div className="text-gray-200 text-xs mt-1">
                          <span style={{ color: arrowCol }}>{arrow}</span> {d.description}
                        </div>
                      )}
                      {d.source_principles?.length > 0 && (
                        <div className="text-gray-500 text-xs mt-1">Principles: {d.source_principles.join(', ')}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* No S/D output */}
            {(!drData.execution?.s_output?.length && !drData.execution?.d_output?.length) && (
              <div className="px-4 pb-4">
                <div className="text-xs text-gray-600">No samskara or desire changes in this DR</div>
              </div>
            )}

            {/* Execution trace */}
            <div className="px-4 pb-4">
              <div style={{ fontSize: 10, color: '#888', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Execution Trace</div>
              <div className="text-xs text-gray-500">
                {drData.execution?.karma_count || 0} karma entries \u00b7 ${drData.execution?.cost?.toFixed(4) || '0'} \u00b7 {Math.round((drData.execution?.duration_ms || 0) / 1000)}s
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="p-8 text-gray-500 text-sm">Select a DR session</div>
      )}
    </div>
  );
}
```

Note: We keep the component name as `ReflectionsTab` internally to avoid changing the mount point. Only the tab label changes to "Deep Reflect".

- [ ] **Step 3: Verify it renders**

Start dashboard, click "Deep Reflect" tab. Should show DR session selector (may be empty if no DRs have run yet). If DRs exist, selecting one should show the two-panel layout.

- [ ] **Step 4: Commit**

```bash
git add site/patron/index.html
git commit -m "feat(dr-tab): DeepReflectTab replaces ReflectionsTab"
```

---

### Task 3: SPA — Filter DR sessions from Timeline

**Files:**
- Modify: `site/patron/index.html`

- [ ] **Step 1: Filter DR sessions from the TimelineTab session list**

Find the `refreshSessions` function in `TimelineTab` (around line 419). After sessions are loaded and mapped, filter out deep_reflect sessions:

```javascript
// In the refreshSessions callback, after building the list:
const list = (d.sessions || []).filter(s => s.type !== 'deep_reflect').reverse();
```

This removes DR sessions from the Timeline dropdown. They now live exclusively in the Deep Reflect tab.

- [ ] **Step 2: Remove the purple badge code**

Find the session selector in TimelineTab that shows the diamond symbol and purple badge for deep_reflect sessions (around lines 571-584). Since DR sessions are now filtered out, the purple badge code is dead. Remove:

- The diamond prefix in the option text: `{s.type === 'deep_reflect' ? '\u25C6 ' : ''}` — simplify to just `{s.id}`
- The purple border styling conditional for deep_reflect
- The "DEEP REFLECT" badge span

The select element becomes simpler — just shows act session IDs without type-based styling.

- [ ] **Step 3: Verify Timeline no longer shows DR sessions**

Open Timeline tab. DR sessions should not appear in the dropdown. The Deep Reflect tab should be the only place to see them.

- [ ] **Step 4: Commit**

```bash
git add site/patron/index.html
git commit -m "feat(dr-tab): filter DR sessions from Timeline tab"
```
