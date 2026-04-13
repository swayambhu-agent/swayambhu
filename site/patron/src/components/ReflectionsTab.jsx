import { useState, useEffect } from 'react';
import { api } from '../lib/api.js';

function formatDrSessionLabel(session, indexFromNewest) {
  if (session?.ts) {
    const when = new Date(session.ts).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    return `DR #${indexFromNewest} · ${when}`;
  }
  const shortId = session?.id ? session.id.slice(0, 18) : 'unknown';
  return `DR #${indexFromNewest} · ${shortId}`;
}

function experienceSummary(exp) {
  return exp.observation || exp.narrative || '(no observation)';
}

function desireLabel(desireKey) {
  return (desireKey || '').replace(/^desire:/, '');
}

function affinityItems(exp, limit = 2) {
  const positive = (exp?.desire_alignment?.top_positive || []).map((item) => ({ ...item, polarity: 'positive' }));
  const negative = (exp?.desire_alignment?.top_negative || []).map((item) => ({ ...item, polarity: 'negative' }));
  return [...positive, ...negative]
    .filter(item => item?.desire_key && typeof item?.score === 'number')
    .slice(0, limit);
}

function renderTextish(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value, null, 2);
}

function formatTimestamp(ts) {
  if (!ts) return null;
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function ReflectionsTab({ patronKey, reflectionsRev }) {
  const [drSessions, setDrSessions] = useState([]);
  const [selectedDr, setSelectedDr] = useState(null);
  const [drData, setDrData] = useState(null);
  const [reflectRecord, setReflectRecord] = useState(null);
  const [loading, setLoading] = useState(true);
  const [drLoading, setDrLoading] = useState(false);

  useEffect(() => {
    api('/sessions', patronKey).then(d => {
      const drs = (d.sessions || []).filter(s => s.type === 'deep_reflect').reverse();
      setDrSessions(drs);
      if (drs.length > 0) setSelectedDr(prev => prev || drs[0].id);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [patronKey, reflectionsRev]);

  useEffect(() => {
    if (!selectedDr) return;
    setDrLoading(true);
    Promise.all([
      api(`/deep-reflect/${encodeURIComponent(selectedDr)}`, patronKey),
      api(`/kv/${encodeURIComponent(`reflect:1:${selectedDr}`)}`, patronKey).catch(() => null),
    ])
      .then(([deepReflect, reflectKv]) => {
        setDrData(deepReflect);
        setReflectRecord(reflectKv?.value || null);
        setDrLoading(false);
      })
      .catch(() => {
        setDrData(null);
        setReflectRecord(null);
        setDrLoading(false);
      });
  }, [selectedDr, patronKey]);

  if (loading) return <div className="p-8 text-gray-500 text-sm">Loading DR-1 sessions...</div>;
  if (drSessions.length === 0) return <div className="p-8 text-gray-500 text-sm">No deep reflect sessions yet</div>;

  const strengthColor = (s) => s > 0.7 ? '#22c55e' : s > 0.3 ? '#f59e0b' : '#ef4444';
  const patternChanges = drData?.execution?.s_output?.length || 0;
  const desireChanges = drData?.execution?.d_output?.length || 0;
  const experienceCount = drData?.experiences?.length || 0;
  const carryForwardItems = reflectRecord?.carry_forward || [];
  const activeCarryForward = carryForwardItems.filter(item => item.status !== 'done' && item.status !== 'dropped');
  const metadataItems = [
    { label: 'Captured', value: formatTimestamp(reflectRecord?.timestamp) },
    { label: 'Generation', value: reflectRecord?.from_dr_generation != null ? String(reflectRecord.from_dr_generation) : null },
    { label: 'Session', value: selectedDr },
    { label: 'Karma', value: drData?.execution?.karma_count != null ? `${drData.execution.karma_count} entries` : null },
  ].filter(item => item.value);

  return (
    <div className="flex flex-col h-full">
      {/* DR selector bar */}
      <div className="px-4 py-2 bg-bg-panel border-b border-border flex flex-wrap items-start md:items-center gap-2 text-xs flex-shrink-0">
        <span className="text-purple-400 font-semibold">DR-1</span>
        <select
          value={selectedDr || ''}
          onChange={e => setSelectedDr(e.target.value)}
          className="bg-bg-card border border-border text-gray-200 px-2 py-1 rounded text-xs min-w-0 flex-1 md:flex-none md:min-w-[18rem] max-w-full"
        >
          {drSessions.map((s, i) => (
            <option key={s.id} value={s.id}>
              {formatDrSessionLabel(s, drSessions.length - i)}
            </option>
          ))}
        </select>
        {drData?.execution && (
          <div className="w-full md:w-auto md:ml-auto flex flex-wrap gap-x-3 gap-y-1 text-gray-500">
            <span>Cost: <span className="text-gray-200">${drData.execution.cost?.toFixed(4)}</span></span>
            <span>Duration: <span className="text-gray-200">{Math.round((drData.execution.duration_ms || 0) / 1000)}s</span></span>
            {drData.execution.model && (
              <span>Model: <span className="text-gray-200">{drData.execution.model}</span></span>
            )}
          </div>
        )}
      </div>

      {drLoading ? (
        <div className="p-8 text-gray-500 text-sm">Loading...</div>
      ) : drData ? (
        <div className="flex flex-1 overflow-hidden flex-col lg:flex-row">
          <div className="flex-1 overflow-y-auto min-w-0">
            <div className="p-4">
              <div className="flex flex-wrap gap-2 mb-4">
                <div className="rounded border border-border bg-bg-panel px-3 py-2 text-xs">
                  <div className="text-gray-500">Patterns changed</div>
                  <div className="text-green-400 font-semibold">{patternChanges}</div>
                </div>
                <div className="rounded border border-border bg-bg-panel px-3 py-2 text-xs">
                  <div className="text-gray-500">Desires changed</div>
                  <div className="text-purple-400 font-semibold">{desireChanges}</div>
                </div>
                <div className="rounded border border-border bg-bg-panel px-3 py-2 text-xs">
                  <div className="text-gray-500">Experiences considered</div>
                  <div className="text-cyan-400 font-semibold">{experienceCount}</div>
                </div>
                <div className="rounded border border-border bg-bg-panel px-3 py-2 text-xs">
                  <div className="text-gray-500">Carry-forward active</div>
                  <div className="text-amber-400 font-semibold">{activeCarryForward.length}</div>
                </div>
              </div>
            </div>

            <div className="px-4 pb-4">
              <div style={{ fontSize: 10, color: '#888', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>What changed</div>
              {(!drData.execution?.s_output?.length && !drData.execution?.d_output?.length) && (
                <div className="rounded-md border border-border bg-bg-panel px-3 py-3 text-xs text-gray-500">
                  No pattern or desire changes were applied in this DR run.
                </div>
              )}
            </div>

            {drData.execution?.d_output?.length > 0 && (
              <div className="px-4 pb-4">
                <div style={{ fontSize: 10, color: '#a78bfa', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>D Operator {'\u2192'} Desires</div>
                {drData.execution.d_output.map((d, i) => {
                  const isRetire = d.action === 'retired';
                  const col = isRetire ? '#ef4444' : '#a78bfa';
                  const arrow = '\u2191';
                  const arrowCol = '#22c55e';
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

            {drData.execution?.s_output?.length > 0 && (
              <div className="px-4 pb-4">
                <div style={{ fontSize: 10, color: '#22c55e', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>S Operator {'\u2192'} Patterns</div>
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
                          <span style={{ fontSize: 12, color: strengthColor(s.strength), fontWeight: 'bold', fontFamily: 'monospace' }}>{s.strength.toFixed(2)}</span>
                        )}
                      </div>
                      {s.pattern && <div className="text-gray-400 text-xs mt-1">"{s.pattern}"</div>}
                    </div>
                  );
                })}
              </div>
            )}

            <div className="px-4 pb-4">
              <div style={{ fontSize: 10, color: '#f59e0b', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Carry-forward</div>
              {activeCarryForward.length > 0 ? (
                <div className="space-y-2">
                  {activeCarryForward.map((item) => (
                    <div key={item.id} className="rounded border border-amber-900/40 bg-amber-950/10 px-3 py-2 text-xs">
                      <div className="flex flex-wrap items-center gap-2 mb-1">
                        <span className="text-amber-400 font-semibold">{item.priority || 'active'}</span>
                        {item.desire_key && <span className="text-gray-500">{item.desire_key}</span>}
                        {item.status && <span className="text-gray-600">{item.status}</span>}
                      </div>
                      <div className="text-gray-200">{item.item}</div>
                      {item.why && <div className="text-gray-500 mt-1">{item.why}</div>}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-md border border-border bg-bg-panel px-3 py-3 text-xs text-gray-500">
                  No active carry-forward items were preserved with this DR.
                </div>
              )}
            </div>

            <div className="px-4 pb-6">
              <div style={{ fontSize: 10, color: '#888', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Why DR concluded this</div>
              {drData.execution?.note_to_future_self && (
                <div style={{ fontSize: 12, color: '#f59e0b', lineHeight: 1.6, padding: 12, marginBottom: 12, background: 'rgba(245,158,11,0.06)', borderRadius: 6, borderLeft: '3px solid #f59e0b' }}>
                  <div style={{ fontSize: 10, color: '#f59e0b', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Note to future self</div>
                  <pre className="whitespace-pre-wrap break-words font-sans">{renderTextish(drData.execution.note_to_future_self)}</pre>
                </div>
              )}
              {drData.execution?.reflection ? (
                <div style={{ fontSize: 12, color: '#d4d4d4', lineHeight: 1.6, padding: 12, background: 'rgba(255,255,255,0.03)', borderRadius: 6, borderLeft: '3px solid #a78bfa' }}>
                  <pre className="whitespace-pre-wrap break-words font-sans">{renderTextish(drData.execution.reflection)}</pre>
                </div>
              ) : (
                <div className="text-xs text-gray-600">No reflection text</div>
              )}
            </div>
          </div>

          <div className="overflow-y-auto flex-shrink-0 border-t lg:border-t-0 lg:border-l border-border w-full lg:w-[320px] bg-bg-panel/30">
            <div className="px-4 py-3 border-b border-border">
              <div style={{ fontSize: 10, color: '#06b6d4', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Accumulation period</div>
              <div className="text-xs text-gray-300">{drData.accumulation?.act_sessions || 0} act sessions</div>
              <div className="text-xs text-gray-500 mt-1">from {drData.accumulation?.period?.from_session || 'start'} to {drData.accumulation?.period?.to_session || 'current'}</div>
            </div>

            <div className="px-4 py-3 border-b border-border">
              <div style={{ fontSize: 10, color: '#888', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Pipeline health</div>
              <div className="space-y-2 text-xs text-gray-300">
                <div className="flex items-center justify-between gap-2">
                  <span>Eval computed</span>
                  <span className="text-gray-500">{drData.accumulation?.eval_count || 0}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span>Tier 3 fallback</span>
                  <span className="text-gray-500">{drData.accumulation?.tier3_fallbacks || 0}x</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span>Experiences recorded</span>
                  <span className="text-gray-500">{drData.accumulation?.experiences_total || 0}</span>
                </div>
              </div>
            </div>

            <div className="px-4 py-3 border-b border-border">
              <div style={{ fontSize: 10, color: '#888', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Execution metadata</div>
              <div className="space-y-2 text-xs">
                {metadataItems.map(item => (
                  <div key={item.label} className="flex items-start justify-between gap-3">
                    <span className="text-gray-500">{item.label}</span>
                    <span className={`text-right ${item.label === 'Session' ? 'text-gray-400 font-mono break-all' : 'text-gray-200'}`}>{item.value}</span>
                  </div>
                ))}
                <div className="flex items-start justify-between gap-3">
                  <span className="text-gray-500">Cost</span>
                  <span className="text-gray-200">${drData.execution?.cost?.toFixed(4) || '0.0000'}</span>
                </div>
                <div className="flex items-start justify-between gap-3">
                  <span className="text-gray-500">Duration</span>
                  <span className="text-gray-200">{Math.round((drData.execution?.duration_ms || 0) / 1000)}s</span>
                </div>
                {drData.execution?.model && (
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-gray-500">Model</span>
                    <span className="text-gray-200 text-right">{drData.execution.model}</span>
                  </div>
                )}
              </div>
            </div>

            <div className="px-4 py-3">
              <div style={{ fontSize: 10, color: '#06b6d4', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>
                Evidence considered ({drData.experiences?.length || 0})
              </div>
              {(drData.experiences || []).map(e => (
                <div key={e.key} className="mb-2 rounded" style={{ padding: '6px 8px', background: 'rgba(6,182,212,0.06)', borderLeft: '2px solid #06b6d4' }}>
                  <div style={{ fontSize: 10, display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: '#06b6d4' }}>{'\u03c3'}={e.surprise_score?.toFixed(1) || '?'}</span>
                    <span style={{ color: '#f59e0b', fontSize: 9 }}>sal={e.salience?.toFixed(2) || '?'}</span>
                  </div>
                  {affinityItems(e, 2).length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {affinityItems(e, 2).map((item) => {
                        const positive = item.polarity === 'positive';
                        return (
                          <span
                            key={`${item.polarity}:${item.desire_key}`}
                            className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px]"
                            style={{
                              borderColor: positive ? '#166534' : '#7f1d1d',
                              background: positive ? 'rgba(34,197,94,0.10)' : 'rgba(239,68,68,0.10)',
                              color: positive ? '#86efac' : '#fca5a5',
                            }}
                            title={`${positive ? 'Advances' : 'Conflicts with'} ${item.desire_key}`}
                          >
                            <span>{positive ? '\u2191' : '\u2193'}</span>
                            <span>{desireLabel(item.desire_key)}</span>
                            <span className="font-mono">{item.score.toFixed(1)}</span>
                          </span>
                        );
                      })}
                    </div>
                  )}
                  <div style={{ fontSize: 11, color: '#bbb', marginTop: 2 }}>
                    {experienceSummary(e).slice(0, 90)}
                    {experienceSummary(e).length > 90 ? '\u2026' : ''}
                  </div>
                </div>
              ))}
              {(!drData.experiences || drData.experiences.length === 0) && (
                <div className="text-xs text-gray-600">No experiences in this period</div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="p-8 text-gray-500 text-sm">Select a DR session</div>
      )}
    </div>
  );
}

export default ReflectionsTab;
