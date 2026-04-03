import { useState, useEffect } from 'react';
import { api } from '../lib/api.js';

function ReflectionsTab({ patronKey, reflectionsRev }) {
  const [drSessions, setDrSessions] = useState([]);
  const [selectedDr, setSelectedDr] = useState(null);
  const [drData, setDrData] = useState(null);
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
    api(`/deep-reflect/${encodeURIComponent(selectedDr)}`, patronKey)
      .then(d => { setDrData(d); setDrLoading(false); })
      .catch(() => { setDrData(null); setDrLoading(false); });
  }, [selectedDr, patronKey]);

  if (loading) return <div className="p-8 text-gray-500 text-sm">Loading deep reflect sessions...</div>;
  if (drSessions.length === 0) return <div className="p-8 text-gray-500 text-sm">No deep reflect sessions yet</div>;

  const strengthColor = (s) => s > 0.7 ? '#22c55e' : s > 0.3 ? '#f59e0b' : '#ef4444';

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
              DR #{drSessions.length - i} {'\u2014'} {s.id}
            </option>
          ))}
        </select>
        {drData?.execution && (
          <div className="ml-auto flex gap-3 text-gray-500">
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
        <div className="flex flex-1 overflow-hidden">
          {/* Left: Accumulation period */}
          <div className="overflow-y-auto flex-shrink-0 border-r border-border" style={{ width: 280 }}>
            <div className="px-3 py-2 border-b border-border" style={{ background: 'rgba(255,255,255,0.02)' }}>
              <div style={{ fontSize: 10, color: '#06b6d4', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 2 }}>Accumulation Period</div>
              <div className="text-xs text-gray-500">{drData.accumulation?.act_sessions || 0} act sessions</div>
            </div>

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

            <div className="px-3 py-2">
              <div style={{ fontSize: 10, color: '#06b6d4', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>
                Experiences ({drData.experiences?.length || 0})
              </div>
              {(drData.experiences || []).map(e => (
                <div key={e.key} className="mb-1.5 rounded" style={{ padding: '5px 8px', background: 'rgba(6,182,212,0.06)', borderLeft: '2px solid #06b6d4' }}>
                  <div style={{ fontSize: 10, display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: '#06b6d4' }}>{'\u03c3'}={e.surprise_score?.toFixed(1) || '?'}</span>
                    <span style={{ color: '#f59e0b', fontSize: 9 }}>sal={e.salience?.toFixed(2) || '?'}</span>
                  </div>
                  <div style={{ fontSize: 11, color: '#bbb', marginTop: 2 }}>
                    {(e.narrative || e.action_taken || '(no narrative)').slice(0, 60)}
                    {(e.narrative || '').length > 60 ? '\u2026' : ''}
                  </div>
                </div>
              ))}
              {(!drData.experiences || drData.experiences.length === 0) && (
                <div className="text-xs text-gray-600">No experiences in this period</div>
              )}
            </div>
          </div>

          {/* Right: DR Execution */}
          <div className="flex-1 overflow-y-auto">
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

            {(!drData.execution?.s_output?.length && !drData.execution?.d_output?.length) && (
              <div className="px-4 pb-4 text-xs text-gray-600">No pattern or desire changes in this DR</div>
            )}

            <div className="px-4 pb-4">
              <div style={{ fontSize: 10, color: '#888', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Execution Trace</div>
              <div className="text-xs text-gray-500">
                {drData.execution?.karma_count || 0} karma entries {'\u00b7'} ${drData.execution?.cost?.toFixed(4) || '0'} {'\u00b7'} {Math.round((drData.execution?.duration_ms || 0) / 1000)}s
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

export default ReflectionsTab;
