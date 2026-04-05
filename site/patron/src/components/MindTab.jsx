import { useState, useEffect, useCallback, useMemo } from 'react';
import { api } from '../lib/api.js';
import { ExpandableText } from './ui/ExpandableText.jsx';

function MindHealthBar({ health, counts, onRefresh }) {
  const bootstrap = health?.bootstrap_complete;
  const sincedr = health?.sessions_since_dr ?? '?';
  const nextdr = health?.next_dr_due;
  const currentSession = (health?.last_deep_reflect_session || 0) + sincedr;
  const sessionsUntilDr = nextdr ? Math.max(0, nextdr - currentSession) : '?';

  return (
    <div className="px-4 py-2 bg-bg-panel border-b border-border flex gap-5 flex-wrap items-center text-xs">
      <div className="flex items-center gap-1.5">
        <span style={{
          width: 7, height: 7, borderRadius: '50%', display: 'inline-block',
          background: bootstrap ? '#22c55e' : '#f59e0b',
        }} />
        <span className="text-gray-500">Bootstrap:</span>
        <span className="text-gray-200">{bootstrap ? 'Complete' : 'Pending'}</span>
      </div>

      <div className="text-gray-500">
        Last DR: <span className="text-purple-400 font-semibold">{sincedr} sessions ago</span>
      </div>

      <div className="text-gray-500">
        Next DR: <span className="text-gray-200">~{sessionsUntilDr} sessions</span>
      </div>

      {health?.last_reflect_output && (
        <div className="text-gray-500">
          DR output: <span className="text-green-400">
            {health.last_reflect_output.has_kv_operations ? 'wrote KV' : 'observations only'}
          </span>
        </div>
      )}

      <div className="flex items-center gap-3 ml-auto text-gray-500">
        <span><span className="text-green-400">{'\u25cf'}</span> {counts.patterns} patterns</span>
        <span><span className="text-purple-400">{'\u25cf'}</span> {counts.desires} desires</span>
        <span><span className="text-amber-400">{'\u25cf'}</span> {counts.tactics} tactics</span>
        <span><span className="text-cyan-400">{'\u25cf'}</span> {counts.experiences} experiences</span>
        {onRefresh && (
          <button onClick={onRefresh} className="text-gray-600 hover:text-gray-400 transition ml-2 text-sm" title="Refresh">
            {'\u21bb'}
          </button>
        )}
      </div>
    </div>
  );
}

function MindGraphExplorer({ data, selected, onSelect }) {
  const { principles = [], tactics = [], patterns = [], desires = [], experiences = [] } = data;

  // Build connection map for the selected entity
  const connections = useMemo(() => {
    if (!selected) return { upstream: [], downstream: [] };
    const { type, key } = selected;
    const upstream = [];
    const downstream = [];

    if (type === 'principle') {
      const pNum = key.replace('principle:', '');
      desires.forEach(d => {
        const sources = d.source_principles || [];
        if (sources.some(s => s === pNum || s === `p${pNum}` || s === key)) {
          downstream.push({ ...d, _type: 'desire' });
        }
      });
      tactics.forEach(t => {
        const sources = t.source_principles || [];
        if (sources.some(s => s === pNum || s === `p${pNum}` || s === key)) {
          downstream.push({ ...t, _type: 'tactic' });
        }
      });
    }
    if (type === 'tactic') {
      const t = tactics.find(t => t.key === key);
      if (t?.source_principles) {
        t.source_principles.forEach(pRef => {
          const p = principles.find(p =>
            p.key === pRef || p.key === `principle:${pRef}` || p.key.endsWith(`:${pRef}`)
          );
          if (p) upstream.push({ ...p, _type: 'principle' });
        });
      }
      if (t?.source_experiences) {
        t.source_experiences.forEach(eRef => {
          const e = experiences.find(e => e.key === eRef || e.key === `experience:${eRef}`);
          if (e) upstream.push({ ...e, _type: 'experience' });
        });
      }
    }
    if (type === 'desire') {
      const d = desires.find(d => d.key === key);
      if (d?.source_principles) {
        d.source_principles.forEach(pRef => {
          const p = principles.find(p =>
            p.key === pRef || p.key === `principle:${pRef}` || p.key.endsWith(`:${pRef}`)
          );
          if (p) upstream.push({ ...p, _type: 'principle' });
        });
      }
      if (d?.source_experiences) {
        d.source_experiences.forEach(eRef => {
          const e = experiences.find(e => e.key === eRef || e.key === `experience:${eRef}`);
          if (e) upstream.push({ ...e, _type: 'experience' });
        });
      }
    }
    if (type === 'pattern') {
      // Only show experiences that reference this pattern via source_experiences
      const s = patterns.find(s => s.key === key);
      if (s?.source_experiences) {
        s.source_experiences.forEach(eRef => {
          const e = experiences.find(e => e.key === eRef || e.key === `experience:${eRef}`);
          if (e) upstream.push({ ...e, _type: 'experience' });
        });
      }
    }
    if (type === 'experience') {
      // Only show entities that actually reference this experience
      const eKey = key;
      desires.forEach(d => {
        if (d.source_experiences?.some(s => s === eKey || `experience:${s}` === eKey))
          downstream.push({ ...d, _type: 'desire' });
      });
      tactics.forEach(t => {
        if (t.source_experiences?.some(s => s === eKey || `experience:${s}` === eKey))
          downstream.push({ ...t, _type: 'tactic' });
      });
      patterns.forEach(s => {
        if (s.source_experiences?.some(se => se === eKey || `experience:${se}` === eKey))
          downstream.push({ ...s, _type: 'pattern' });
      });
    }
    return { upstream, downstream };
  }, [selected, principles, tactics, patterns, desires, experiences]);

  const centerEntity = useMemo(() => {
    if (!selected) return null;
    const { type, key } = selected;
    if (type === 'principle') return principles.find(p => p.key === key);
    if (type === 'desire') return desires.find(d => d.key === key);
    if (type === 'tactic') return tactics.find(t => t.key === key);
    if (type === 'pattern') return patterns.find(s => s.key === key);
    if (type === 'experience') return experiences.find(e => e.key === key);
    return null;
  }, [selected, principles, tactics, patterns, desires, experiences]);

  const typeColor = (t) => ({ principle: '#f59e0b', tactic: '#fb923c', desire: '#a78bfa', pattern: '#22c55e', experience: '#06b6d4' }[t] || '#666');
  const strengthColor = (s) => s > 0.7 ? '#22c55e' : s > 0.3 ? '#f59e0b' : '#ef4444';
  const trunc = (t, n) => t && t.length > n ? t.slice(0, n - 1) + '\u2026' : (t || '');

  const renderSidebarItem = (entity, type) => {
    const isActive = selected?.type === type && selected?.key === entity.key;
    const col = typeColor(type);
    return (
      <div
        key={entity.key}
        onClick={() => onSelect({ type, key: entity.key })}
        className="cursor-pointer rounded px-1.5 py-1 mb-0.5 text-xs transition"
        style={{
          background: isActive ? `${col}22` : 'transparent',
          border: isActive ? `1px solid ${col}44` : '1px solid transparent',
          color: isActive ? '#e5e5e5' : '#888',
        }}
      >
        {type === 'principle' && trunc(typeof entity.text === 'string' ? entity.text : entity.key, 28)}
        {type === 'desire' && (
          <span>
            <span style={{ color: '#22c55e' }}>
              {'\u2191'}
            </span>{' '}{trunc(entity.description || entity.slug, 24)}
          </span>
        )}
        {type === 'tactic' && (
          <span>
            <span style={{ color: '#fb923c' }}>{'\u25b8'}</span>{' '}{trunc(entity.description || entity.slug, 24)}
          </span>
        )}
        {type === 'pattern' && (
          <span style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>{trunc(entity.pattern, 22)}</span>
            <span style={{ color: strengthColor(entity.strength), fontSize: 10 }}>{entity.strength?.toFixed(2)}</span>
          </span>
        )}
        {type === 'experience' && (
          <span>
            <span style={{ color: '#06b6d4', fontSize: 10 }}>{'\u03c3'}{entity.surprise_score?.toFixed(1)}</span>{' '}
            {trunc(entity.narrative || entity.action_taken, 20)}
          </span>
        )}
      </div>
    );
  };

  const renderConnectedNode = (entity, type) => {
    const col = typeColor(type);
    return (
      <div
        key={entity.key}
        onClick={() => onSelect({ type, key: entity.key })}
        className="cursor-pointer rounded-md mb-2 transition hover:brightness-125"
        style={{ padding: '8px 10px', background: `${col}0d`, border: `1px solid ${col}30`, maxWidth: 210 }}
      >
        <div style={{ fontSize: 9, color: col, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 2 }}>{type}</div>
        {type === 'principle' && <div style={{ fontSize: 12, color: '#e5e5e5', lineHeight: 1.4 }}>{trunc(typeof entity.text === 'string' ? entity.text : '', 50)}</div>}
        {type === 'desire' && (
          <div style={{ fontSize: 12, color: '#e5e5e5' }}>
            <span style={{ color: '#22c55e' }}>
              {'\u2191'}
            </span>{' '}{trunc(entity.description || entity.slug, 35)}
          </div>
        )}
        {type === 'tactic' && (
          <div style={{ fontSize: 12, color: '#e5e5e5' }}>
            <span style={{ color: '#fb923c' }}>{'\u25b8'}</span>{' '}{trunc(entity.description || entity.slug, 35)}
          </div>
        )}
        {type === 'pattern' && (
          <>
            <div style={{ fontSize: 12, color: '#e5e5e5' }}>{trunc(entity.pattern, 35)}</div>
            <div style={{ fontSize: 10, color: strengthColor(entity.strength), marginTop: 2 }}>
              strength: {entity.strength?.toFixed(2)}
            </div>
          </>
        )}
        {type === 'experience' && (
          <>
            <div style={{ fontSize: 11, color: '#06b6d4' }}>{'\u03c3'}={entity.surprise_score?.toFixed(2)}</div>
            <div style={{ fontSize: 12, color: '#d4d4d4', marginTop: 2 }}>{trunc(entity.narrative || entity.action_taken, 40)}</div>
          </>
        )}
      </div>
    );
  };

  const renderCenterNode = () => {
    if (!selected || !centerEntity) return null;
    const col = typeColor(selected.type);
    return (
      <div className="rounded-lg p-4" style={{ background: `${col}18`, border: `2px solid ${col}`, maxWidth: 300 }}>
        <div style={{ fontSize: 10, color: col, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>{selected.type}</div>
        {selected.type === 'principle' && (
          <div style={{ fontSize: 14, color: '#e5e5e5', lineHeight: 1.6 }}>{typeof centerEntity.text === 'string' ? centerEntity.text : JSON.stringify(centerEntity.text)}</div>
        )}
        {selected.type === 'desire' && (
          <>
            <div style={{ fontSize: 14, color: '#e5e5e5', lineHeight: 1.5 }}>
              <span style={{ color: '#22c55e', fontSize: 18 }}>
                {'\u2191'}
              </span>{' '}
              {centerEntity.description || centerEntity.slug}
            </div>
            <div className="text-xs text-gray-500 mt-2">
              {centerEntity.direction} {'\u00b7'} {centerEntity.source_principles?.join(', ')}
            </div>
          </>
        )}
        {selected.type === 'tactic' && (
          <>
            <div style={{ fontSize: 14, color: '#e5e5e5', lineHeight: 1.5 }}>
              <span style={{ color: '#fb923c', fontSize: 18 }}>{'\u25b8'}</span>{' '}
              {centerEntity.description || centerEntity.slug}
            </div>
            <div className="text-xs text-gray-500 mt-2">
              {centerEntity.slug && <span>{centerEntity.slug}</span>}
              {centerEntity.source_principles?.length > 0 && (
                <span>{centerEntity.slug ? ` ${'\u00b7'} ` : ''}principles: {centerEntity.source_principles.join(', ')}</span>
              )}
            </div>
            {centerEntity.created_at && (
              <div className="text-xs text-gray-600 mt-2">{new Date(centerEntity.created_at).toLocaleString()}</div>
            )}
          </>
        )}
        {selected.type === 'pattern' && (
          <>
            <div style={{ fontSize: 14, color: '#e5e5e5', lineHeight: 1.5 }}>{centerEntity.pattern}</div>
            <div style={{ marginTop: 8 }}>
              <div style={{ height: 6, background: 'rgba(255,255,255,0.08)', borderRadius: 3 }}>
                <div style={{ width: `${(centerEntity.strength || 0) * 100}%`, height: '100%', background: strengthColor(centerEntity.strength), borderRadius: 3 }} />
              </div>
              <div style={{ fontSize: 20, fontWeight: 'bold', color: strengthColor(centerEntity.strength), marginTop: 4, fontFamily: 'monospace' }}>
                {centerEntity.strength?.toFixed(2)}
              </div>
            </div>
          </>
        )}
        {selected.type === 'experience' && (
          <>
            <div className="text-xs mb-2">
              <span style={{ color: '#06b6d4' }}>{'\u03c3'}={centerEntity.surprise_score?.toFixed(2)}</span>
              <span className="text-gray-600 mx-1">{'\u00b7'}</span>
              <span style={{ color: '#f59e0b' }}>salience={centerEntity.salience?.toFixed(2)}</span>
            </div>
            {centerEntity.action_taken && (
              <div className="text-xs text-gray-400 mb-1">
                <span className="text-gray-500">Action: </span>
                <ExpandableText text={centerEntity.action_taken} limit={120} color="text-gray-400" />
              </div>
            )}
            <div style={{ fontSize: 13, lineHeight: 1.5 }}>
              <ExpandableText text={centerEntity.narrative || centerEntity.outcome || ''} limit={150} color="text-gray-300" />
            </div>
            {centerEntity.timestamp && <div className="text-xs text-gray-600 mt-2">{new Date(centerEntity.timestamp).toLocaleString()}</div>}
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
          { label: 'Tactics', type: 'tactic', items: tactics, color: '#fb923c' },
          { label: 'Patterns', type: 'pattern', items: patterns, color: '#22c55e' },
          { label: 'Experiences', type: 'experience', items: experiences, color: '#06b6d4' },
        ].map(({ label, type, items, color }) => (
          <div key={type} className="border-b border-border" style={{ padding: '8px 10px' }}>
            <div style={{ fontSize: 10, color, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>
              {label} ({items.length})
            </div>
            {items.slice(0, 10).map(entity => renderSidebarItem(entity, type))}
            {items.length > 10 && <div className="text-xs text-gray-600 px-1.5 py-1">showing 10 of {items.length}</div>}
          </div>
        ))}
      </div>

      {/* Graph area */}
      <div className="flex-1 flex flex-col overflow-auto">
        {!selected ? (
          <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
            Select an entity from the sidebar to explore its connections
          </div>
        ) : (
          <>
            <div className="flex-1 flex items-start overflow-auto p-4 gap-2">
              {/* Upstream column */}
              <div className="flex flex-col justify-start pt-4" style={{ minWidth: 180, maxWidth: 220 }}>
                {connections.upstream.length > 0 ? (
                  <>
                    <div style={{ fontSize: 9, color: '#666', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6, textAlign: 'center' }}>upstream</div>
                    {connections.upstream.map(e => renderConnectedNode(e, e._type))}
                  </>
                ) : (
                  <div className="text-xs text-gray-500 text-center italic">
                    {selected.type === 'principle' ? 'immutable root' : 'no upstream found'}
                  </div>
                )}
              </div>

              {/* Left connector */}
              <div className="flex items-center" style={{ width: 30, flexShrink: 0 }}>
                {connections.upstream.length > 0 && (
                  <div style={{ width: '100%', height: 1, borderTop: '1px dashed #444' }} />
                )}
              </div>

              {/* Center */}
              <div className="flex flex-col justify-start items-center pt-4" style={{ minWidth: 240 }}>
                {renderCenterNode()}
              </div>

              {/* Right connector */}
              <div className="flex items-center" style={{ width: 30, flexShrink: 0 }}>
                {connections.downstream.length > 0 && (
                  <div style={{ width: '100%', height: 1, borderTop: '1px dashed #444' }} />
                )}
              </div>

              {/* Downstream column */}
              <div className="flex flex-col justify-start pt-4" style={{ minWidth: 180, maxWidth: 220 }}>
                {connections.downstream.length > 0 ? (
                  <>
                    <div style={{ fontSize: 9, color: '#666', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6, textAlign: 'center' }}>downstream</div>
                    {connections.downstream.map(e => renderConnectedNode(e, e._type))}
                  </>
                ) : (
                  <div className="text-xs text-gray-500 text-center italic">no downstream found</div>
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
                {connections.upstream.length > 0 && <span className="mr-4">{'\u2190'} {connections.upstream.length} upstream</span>}
                {connections.downstream.length > 0 && <span>{connections.downstream.length} downstream {'\u2192'}</span>}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function MindTab({ patronKey }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);

  const loadData = useCallback(async () => {
    try {
      const result = await api('/mind', patronKey);
      setData(result);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  }, [patronKey]);

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    if (data && !selected) {
      const first = data.principles?.[0] || data.desires?.[0] || data.tactics?.[0] || data.patterns?.[0] || data.experiences?.[0];
      if (first) {
        const type = first.pattern !== undefined ? 'pattern'
          : first.direction !== undefined ? 'desire'
          : first.surprise_score !== undefined ? 'experience'
          : first.slug !== undefined && first.source_principles !== undefined ? 'tactic'
          : 'principle';
        setSelected({ type, key: first.key });
      }
    }
  }, [data, selected]);

  if (loading) return <div className="p-8 text-gray-500">Loading cognitive state...</div>;
  if (error) return <div className="p-8 text-red-400">Error: {error}</div>;
  if (!data) return <div className="p-8 text-gray-500">No data</div>;

  return (
    <div className="flex flex-col h-full">
      <MindHealthBar health={data.operator_health} counts={{
        patterns: data.patterns.length,
        desires: data.desires.length,
        tactics: (data.tactics || []).length,
        experiences: data.experiences.length,
      }} onRefresh={loadData} />
      <MindGraphExplorer data={data} selected={selected} onSelect={setSelected} />
    </div>
  );
}
