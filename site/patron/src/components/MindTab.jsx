import { useState, useEffect, useCallback, useMemo } from 'react';
import { api } from '../lib/api.js';
import { ExpandableText } from './ui/ExpandableText.jsx';

function typeColor(type) {
  return ({ principle: '#f59e0b', tactic: '#fb923c', desire: '#a78bfa', pattern: '#22c55e', experience: '#06b6d4' }[type] || '#666');
}

function strengthColor(value) {
  return value > 0.7 ? '#22c55e' : value > 0.3 ? '#f59e0b' : '#ef4444';
}

function trunc(text, limit) {
  return text && text.length > limit ? `${text.slice(0, limit - 1)}…` : (text || '');
}

function experienceSigma(entity) {
  return entity?.pattern_delta?.sigma ?? entity?.surprise_score ?? null;
}

function experienceNarrative(entity) {
  return entity?.observation || entity?.text_rendering?.narrative || entity?.narrative || entity?.outcome || entity?.action_taken || '';
}

function desireLabel(desireKey) {
  return (desireKey || '').replace(/^desire:/, '');
}

function affinityItems(entity, limit = 2) {
  const positive = (entity?.desire_alignment?.top_positive || []).map((item) => ({ ...item, polarity: 'positive' }));
  const negative = (entity?.desire_alignment?.top_negative || []).map((item) => ({ ...item, polarity: 'negative' }));
  return [...positive, ...negative]
    .filter(item => item?.desire_key && typeof item?.score === 'number')
    .slice(0, limit);
}

function DesireAffinityPills({ entity, limit = 2, compact = false }) {
  const items = affinityItems(entity, limit);
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => {
        const positive = item.polarity === 'positive';
        return (
          <span
            key={`${item.polarity}:${item.desire_key}`}
            className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px]"
            style={{
              borderColor: positive ? '#166534' : '#7f1d1d',
              background: positive ? 'rgba(34,197,94,0.10)' : 'rgba(239,68,68,0.10)',
              color: positive ? '#86efac' : '#fca5a5',
            }}
            title={`${positive ? 'Advances' : 'Conflicts with'} ${item.desire_key}`}
          >
            <span>{positive ? '\u2191' : '\u2193'}</span>
            <span>{desireLabel(item.desire_key)}</span>
            <span className="font-mono">{compact ? item.score.toFixed(1) : item.score.toFixed(2)}</span>
          </span>
        );
      })}
    </div>
  );
}

function entityLabel(entity, type, limit = 32) {
  if (type === 'principle') return trunc(typeof entity.text === 'string' ? entity.text : entity.key, limit);
  if (type === 'desire' || type === 'tactic') return trunc(entity.description || entity.slug, limit);
  if (type === 'pattern') return trunc(entity.pattern, limit);
  if (type === 'experience') return trunc(experienceNarrative(entity), limit);
  return trunc(entity.key, limit);
}

function pickDefaultSelection(data) {
  const ordered = [
    ['desire', data.desires],
    ['pattern', data.patterns],
    ['tactic', data.tactics || []],
    ['experience', data.experiences],
    ['principle', data.principles],
  ];
  for (const [type, items] of ordered) {
    if (items?.length) return { type, key: items[0].key };
  }
  return null;
}

function isCarryForwardActive(item) {
  if (!item) return false;
  if (item.status && item.status !== 'active') return false;
  if (item.expires_at && new Date(item.expires_at).getTime() < Date.now()) return false;
  return true;
}

function MindHealthBar({ health, counts, onRefresh }) {
  const bootstrap = health?.bootstrap_complete;
  const sincedr = health?.sessions_since_dr ?? '?';
  const nextdr = health?.next_dr_due;
  const currentSession = (health?.last_deep_reflect_session || 0) + sincedr;
  const sessionsUntilDr = nextdr ? Math.max(0, nextdr - currentSession) : '?';

  return (
    <div className="px-4 py-2 bg-bg-panel border-b border-border flex gap-x-5 gap-y-2 flex-wrap items-center text-xs">
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

      <div className="flex items-center gap-3 flex-wrap text-gray-500 w-full md:w-auto md:ml-auto">
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

function InventoryList({ title, color, items, type, selected, onSelect, limit = 6, emptyLabel = 'none' }) {
  const visible = items.slice(0, limit);
  return (
    <div className="rounded border border-border bg-bg-panel/40 p-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="text-[10px] uppercase tracking-wider" style={{ color }}>{title}</div>
        <div className="text-[10px] text-gray-600">{items.length}</div>
      </div>
      {visible.length > 0 ? (
        <div className="space-y-2">
          {visible.map((entity) => {
            const active = selected?.type === type && selected?.key === entity.key;
            return (
              <button
                key={entity.key}
                onClick={() => onSelect({ type, key: entity.key })}
                className={`w-full text-left rounded border px-3 py-2 text-xs transition ${active ? 'text-gray-100' : 'text-gray-400 hover:text-gray-200'}`}
                style={{
                  borderColor: active ? color : `${color}33`,
                  background: active ? `${color}16` : `${color}08`,
                }}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="leading-5">{entityLabel(entity, type, 72)}</span>
                  {type === 'pattern' && entity.strength != null && (
                    <span className="text-[10px] font-mono" style={{ color: strengthColor(entity.strength) }}>
                      {entity.strength.toFixed(2)}
                    </span>
                  )}
                  {type === 'experience' && experienceSigma(entity) != null && (
                    <span className="text-[10px] font-mono text-cyan-400">{'\u03c3'}={experienceSigma(entity).toFixed(1)}</span>
                  )}
                </div>
                {type === 'experience' && (
                  <div className="mt-2">
                    <DesireAffinityPills entity={entity} limit={1} compact />
                  </div>
                )}
              </button>
            );
          })}
          {items.length > limit && <div className="text-[11px] text-gray-600">showing {limit} of {items.length}</div>}
        </div>
      ) : (
        <div className="text-xs text-gray-600">{emptyLabel}</div>
      )}
    </div>
  );
}

function getCenterEntity(data, selected) {
  if (!selected) return null;
  const collections = {
    principle: data.principles || [],
    desire: data.desires || [],
    tactic: data.tactics || [],
    pattern: data.patterns || [],
    experience: data.experiences || [],
  };
  return collections[selected.type]?.find(entity => entity.key === selected.key) || null;
}

function getConnections(data, selected) {
  const principles = data.principles || [];
  const desires = data.desires || [];
  const tactics = data.tactics || [];
  const patterns = data.patterns || [];
  const experiences = data.experiences || [];
  if (!selected) return { upstream: [], downstream: [] };

  const upstream = [];
  const downstream = [];
  const key = selected.key;

  if (selected.type === 'principle') {
    const refBase = key.replace('principle:', '');
    desires.forEach((entity) => {
      const refs = entity.source_principles || [];
      if (refs.some(ref => ref === key || ref === refBase || ref === `p${refBase}`)) {
        downstream.push({ ...entity, _type: 'desire' });
      }
    });
    tactics.forEach((entity) => {
      const refs = entity.source_principles || [];
      if (refs.some(ref => ref === key || ref === refBase || ref === `p${refBase}`)) {
        downstream.push({ ...entity, _type: 'tactic' });
      }
    });
  }

  if (selected.type === 'desire') {
    const entity = desires.find(item => item.key === key);
    entity?.source_principles?.forEach((ref) => {
      const match = principles.find(p => p.key === ref || p.key === `principle:${ref}` || p.key.endsWith(`:${ref}`));
      if (match) upstream.push({ ...match, _type: 'principle' });
    });
    entity?.source_experiences?.forEach((ref) => {
      const match = experiences.find(e => e.key === ref || e.key === `experience:${ref}`);
      if (match) upstream.push({ ...match, _type: 'experience' });
    });
  }

  if (selected.type === 'tactic') {
    const entity = tactics.find(item => item.key === key);
    entity?.source_principles?.forEach((ref) => {
      const match = principles.find(p => p.key === ref || p.key === `principle:${ref}` || p.key.endsWith(`:${ref}`));
      if (match) upstream.push({ ...match, _type: 'principle' });
    });
    entity?.source_experiences?.forEach((ref) => {
      const match = experiences.find(e => e.key === ref || e.key === `experience:${ref}`);
      if (match) upstream.push({ ...match, _type: 'experience' });
    });
  }

  if (selected.type === 'pattern') {
    const entity = patterns.find(item => item.key === key);
    entity?.source_experiences?.forEach((ref) => {
      const match = experiences.find(e => e.key === ref || e.key === `experience:${ref}`);
      if (match) upstream.push({ ...match, _type: 'experience' });
    });
  }

  if (selected.type === 'experience') {
    desires.forEach((entity) => {
      if (entity.source_experiences?.some(ref => ref === key || `experience:${ref}` === key)) downstream.push({ ...entity, _type: 'desire' });
    });
    tactics.forEach((entity) => {
      if (entity.source_experiences?.some(ref => ref === key || `experience:${ref}` === key)) downstream.push({ ...entity, _type: 'tactic' });
    });
    patterns.forEach((entity) => {
      if (entity.source_experiences?.some(ref => ref === key || `experience:${ref}` === key)) downstream.push({ ...entity, _type: 'pattern' });
    });
  }

  return { upstream, downstream };
}

function SelectedEntityBody({ entity, type }) {
  if (!entity) return null;

  if (type === 'principle') {
    return (
      <div style={{ fontSize: 14, color: '#e5e5e5', lineHeight: 1.6 }}>
        {typeof entity.text === 'string' ? entity.text : JSON.stringify(entity.text)}
      </div>
    );
  }

  if (type === 'desire') {
    return (
      <>
        <div style={{ fontSize: 14, color: '#e5e5e5', lineHeight: 1.5 }}>
          <span style={{ color: '#22c55e', fontSize: 18 }}>{'\u2191'}</span>{' '}
          {entity.description || entity.slug}
        </div>
        <div className="text-xs text-gray-500 mt-2">
          {entity.direction}
          {entity.source_principles?.length > 0 ? ` · ${entity.source_principles.join(', ')}` : ''}
        </div>
      </>
    );
  }

  if (type === 'tactic') {
    return (
      <>
        <div style={{ fontSize: 14, color: '#e5e5e5', lineHeight: 1.5 }}>
          <span style={{ color: '#fb923c', fontSize: 18 }}>{'\u25b8'}</span>{' '}
          {entity.description || entity.slug}
        </div>
        <div className="text-xs text-gray-500 mt-2">
          {entity.slug && <span>{entity.slug}</span>}
          {entity.source_principles?.length > 0 && (
            <span>{entity.slug ? ' · ' : ''}principles: {entity.source_principles.join(', ')}</span>
          )}
        </div>
        {entity.created_at && (
          <div className="text-xs text-gray-600 mt-2">{new Date(entity.created_at).toLocaleString()}</div>
        )}
      </>
    );
  }

  if (type === 'pattern') {
    return (
      <>
        <div style={{ fontSize: 14, color: '#e5e5e5', lineHeight: 1.5 }}>{entity.pattern}</div>
        <div style={{ marginTop: 8 }}>
          <div style={{ height: 6, background: 'rgba(255,255,255,0.08)', borderRadius: 3 }}>
            <div
              style={{
                width: `${(entity.strength || 0) * 100}%`,
                height: '100%',
                background: strengthColor(entity.strength),
                borderRadius: 3,
              }}
            />
          </div>
          <div style={{ fontSize: 20, fontWeight: 'bold', color: strengthColor(entity.strength), marginTop: 4, fontFamily: 'monospace' }}>
            {entity.strength?.toFixed(2)}
          </div>
        </div>
      </>
    );
  }

  if (type === 'experience') {
    const sigma = experienceSigma(entity);
    return (
      <>
        <div className="text-xs mb-2">
          {sigma != null && <span style={{ color: '#06b6d4' }}>{'\u03c3'}={sigma.toFixed(2)}</span>}
          {entity.salience != null && (
            <>
              {sigma != null && <span className="text-gray-600 mx-1">{'\u00b7'}</span>}
              <span style={{ color: '#f59e0b' }}>salience={entity.salience.toFixed(2)}</span>
            </>
          )}
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.5 }}>
          <ExpandableText text={experienceNarrative(entity)} limit={180} color="text-gray-300" />
        </div>
        {affinityItems(entity, 4).length > 0 && (
          <div className="mt-3">
            <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">Desire affinity</div>
            <DesireAffinityPills entity={entity} limit={4} />
            {entity.desire_alignment?.affinity_magnitude != null && (
              <div className="text-xs text-gray-500 mt-2">
                magnitude {entity.desire_alignment.affinity_magnitude.toFixed(2)}
              </div>
            )}
          </div>
        )}
        {entity.timestamp && <div className="text-xs text-gray-600 mt-2">{new Date(entity.timestamp).toLocaleString()}</div>}
      </>
    );
  }

  return null;
}

function DebuggerMindView({ data, selected, onSelect, connections, centerEntity, lastReflect }) {
  const activeCarryForward = (lastReflect?.carry_forward || []).filter(isCarryForwardActive);
  const validationItems = [
    data.operator_health?.sessions_since_dr === 0
      ? 'No post-DR act has run yet, so desire usage is still unverified.'
      : `${data.operator_health.sessions_since_dr} act session(s) have run since the last DR.`,
    data.patterns.length === 0
      ? 'No stable pattern layer exists yet.'
      : `${data.patterns.length} pattern(s) currently shape evaluation.`,
    (data.tactics || []).length === 0
      ? 'No tactic layer exists yet.'
      : `${data.tactics.length} tactic(s) are available to the planner.`,
    activeCarryForward.length === 0
      ? 'No active carry-forward items are waiting for the next act.'
      : `${activeCarryForward.length} active carry-forward item(s) are waiting for the next act.`,
  ];

  const statusCards = [
    {
      label: 'Bootstrap',
      value: data.operator_health?.bootstrap_complete ? 'healthy' : 'pending',
      color: data.operator_health?.bootstrap_complete ? 'text-green-400' : 'text-yellow-400',
    },
    {
      label: 'Post-DR act',
      value: data.operator_health?.sessions_since_dr === 0 ? 'pending first act' : `${data.operator_health.sessions_since_dr} since DR`,
      color: data.operator_health?.sessions_since_dr === 0 ? 'text-yellow-400' : 'text-gray-200',
    },
    {
      label: 'Latest DR',
      value: data.operator_health?.last_reflect_output?.has_kv_operations ? 'wrote substrate' : 'observations only',
      color: data.operator_health?.last_reflect_output?.has_kv_operations ? 'text-green-400' : 'text-cyan-400',
    },
    {
      label: 'Next DR',
      value: data.operator_health?.next_dr_due != null ? `session ${data.operator_health.next_dr_due}` : 'unknown',
      color: 'text-gray-200',
    },
  ];

  return (
    <div className="hidden md:flex flex-1 flex-col overflow-hidden">
      <div className="border-b border-border px-4 py-2 flex items-center gap-2 text-xs">
        <span className="text-gray-500">View</span>
        <span className="rounded border border-accent bg-accent/10 px-2 py-1 text-accent font-semibold">Debugger</span>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
          {statusCards.map((card) => (
            <div key={card.label} className="rounded border border-border bg-bg-panel/50 px-3 py-3">
              <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">{card.label}</div>
              <div className={`text-sm font-semibold ${card.color}`}>{card.value}</div>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-[280px_minmax(0,1fr)_320px] gap-4 min-h-0">
          <div className="space-y-3">
            <InventoryList
              title="Active Desires"
              color="#a78bfa"
              items={data.desires}
              type="desire"
              selected={selected}
              onSelect={onSelect}
              emptyLabel="no desires yet"
            />
            <InventoryList
              title="Patterns"
              color="#22c55e"
              items={data.patterns}
              type="pattern"
              selected={selected}
              onSelect={onSelect}
              emptyLabel="no patterns yet"
            />
            <InventoryList
              title="Tactics"
              color="#fb923c"
              items={data.tactics || []}
              type="tactic"
              selected={selected}
              onSelect={onSelect}
              emptyLabel="no tactics yet"
            />
            <InventoryList
              title="Recent Experiences"
              color="#06b6d4"
              items={data.experiences}
              type="experience"
              selected={selected}
              onSelect={onSelect}
              emptyLabel="no experiences yet"
            />
          </div>

          <div className="space-y-3 min-w-0">
            {selected && centerEntity ? (
              <>
                <div className="rounded-lg p-4" style={{ background: `${typeColor(selected.type)}14`, border: `1px solid ${typeColor(selected.type)}` }}>
                  <div style={{ fontSize: 10, color: typeColor(selected.type), textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>
                    {selected.type}
                  </div>
                  <SelectedEntityBody entity={centerEntity} type={selected.type} />
                  <div className="text-[11px] text-gray-600 mt-3 font-mono break-all">{selected.key}</div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded border border-border bg-bg-panel/50 p-3">
                    <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">Upstream</div>
                    {connections.upstream.length > 0 ? (
                      <div className="space-y-2">
                        {connections.upstream.map((entity) => (
                          <button
                            key={entity.key}
                            onClick={() => onSelect({ type: entity._type, key: entity.key })}
                            className="w-full text-left rounded border px-3 py-2 text-xs text-gray-300 hover:text-gray-100 transition"
                            style={{ borderColor: `${typeColor(entity._type)}33`, background: `${typeColor(entity._type)}08` }}
                          >
                            <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: typeColor(entity._type) }}>{entity._type}</div>
                            {entityLabel(entity, entity._type, 90)}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="text-xs text-gray-600 italic">{selected.type === 'principle' ? 'immutable root' : 'no upstream evidence'}</div>
                    )}
                  </div>

                  <div className="rounded border border-border bg-bg-panel/50 p-3">
                    <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">Downstream</div>
                    {connections.downstream.length > 0 ? (
                      <div className="space-y-2">
                        {connections.downstream.map((entity) => (
                          <button
                            key={entity.key}
                            onClick={() => onSelect({ type: entity._type, key: entity.key })}
                            className="w-full text-left rounded border px-3 py-2 text-xs text-gray-300 hover:text-gray-100 transition"
                            style={{ borderColor: `${typeColor(entity._type)}33`, background: `${typeColor(entity._type)}08` }}
                          >
                            <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: typeColor(entity._type) }}>{entity._type}</div>
                            {entityLabel(entity, entity._type, 90)}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="text-xs text-gray-600 italic">no downstream impact yet</div>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <div className="rounded border border-border bg-bg-panel/40 p-4 text-sm text-gray-600">
                Select an entity to inspect it.
              </div>
            )}
          </div>

          <div className="space-y-3">
            <div className="rounded border border-border bg-bg-panel/50 p-3">
              <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">What looks healthy</div>
              <div className="space-y-2 text-xs">
                <div className="text-green-400">Desire layer is active: {data.desires.length} desire(s).</div>
                <div className="text-gray-300">Latest DR output: {data.operator_health?.last_reflect_output?.has_kv_operations ? 'wrote substrate changes' : 'observations only'}.</div>
                <div className="text-gray-300">Latest experience store: {data.experiences.length} retained experience(s).</div>
              </div>
            </div>

            <div className="rounded border border-border bg-bg-panel/50 p-3">
              <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">What still needs validation</div>
              <div className="space-y-2 text-xs">
                {validationItems.map((item) => (
                  <div key={item} className="text-gray-300">{item}</div>
                ))}
              </div>
            </div>

            <div className="rounded border border-border bg-bg-panel/50 p-3">
              <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">Latest reflect note</div>
              {lastReflect?.note_to_future_self ? (
                <div className="text-xs text-gray-300 leading-5">{lastReflect.note_to_future_self}</div>
              ) : (
                <div className="text-xs text-gray-600">No note stored.</div>
              )}
              {lastReflect?.session_summary && (
                <div className="text-xs text-gray-500 mt-3 leading-5">{lastReflect.session_summary}</div>
              )}
            </div>

            <div className="rounded border border-border bg-bg-panel/50 p-3">
              <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">Carry-forward</div>
              {activeCarryForward.length > 0 ? (
                <div className="space-y-2">
                  {activeCarryForward.slice(0, 5).map((item) => (
                    <div key={item.id} className="rounded border border-amber-900/40 bg-amber-950/10 px-3 py-2 text-xs">
                      <div className="flex flex-wrap items-center gap-2 mb-1">
                        <span className="text-amber-400 font-semibold">{item.priority || 'active'}</span>
                        {item.desire_key && <span className="text-gray-500">{item.desire_key}</span>}
                      </div>
                      <div className="text-gray-200 leading-5">{item.item}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-gray-600">No active carry-forward items.</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function MobileMindExplorer({ data, selected, onSelect, connections, centerEntity }) {
  const sections = [
    { label: 'Principles', type: 'principle', items: data.principles, color: '#f59e0b' },
    { label: 'Desires', type: 'desire', items: data.desires, color: '#a78bfa' },
    { label: 'Tactics', type: 'tactic', items: data.tactics || [], color: '#fb923c' },
    { label: 'Patterns', type: 'pattern', items: data.patterns, color: '#22c55e' },
    { label: 'Experiences', type: 'experience', items: data.experiences, color: '#06b6d4' },
  ];

  const renderEntityButton = (entity, type) => {
    const active = selected?.type === type && selected?.key === entity.key;
    const color = typeColor(type);
    const sigma = type === 'experience' ? experienceSigma(entity) : null;
    return (
      <button
        key={entity.key}
        onClick={() => onSelect({ type, key: entity.key })}
        className="w-full text-left rounded border px-3 py-2 transition"
        style={{
          borderColor: active ? `${color}` : `${color}33`,
          background: active ? `${color}18` : `${color}08`,
        }}
      >
        <div className="flex items-start justify-between gap-2">
          <span className="text-gray-200 text-xs leading-5">{entityLabel(entity, type, 72)}</span>
          {type === 'pattern' && entity.strength != null && (
            <span className="text-[10px] font-mono" style={{ color: strengthColor(entity.strength) }}>
              {entity.strength.toFixed(2)}
            </span>
          )}
          {type === 'experience' && sigma != null && (
            <span className="text-[10px] font-mono text-cyan-400">{'\u03c3'}={sigma.toFixed(1)}</span>
          )}
        </div>
        {type === 'experience' && (
          <div className="mt-2">
            <DesireAffinityPills entity={entity} limit={1} compact />
          </div>
        )}
      </button>
    );
  };

  const renderConnectionList = (items, label) => (
    <div className="rounded border border-border bg-bg-panel/50 p-3">
      <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">{label}</div>
      {items.length > 0 ? (
        <div className="space-y-2">
          {items.map((entity) => renderEntityButton(entity, entity._type))}
        </div>
      ) : (
        <div className="text-xs text-gray-600 italic">none</div>
      )}
    </div>
  );

  return (
    <div className="md:hidden flex-1 overflow-y-auto">
      <div className="p-4 space-y-4">
        <div className="space-y-3">
          {sections.map(({ label, type, items, color }) => (
            <div key={type} className="rounded border border-border bg-bg-panel/40 p-3">
              <div className="text-[10px] uppercase tracking-wider mb-2" style={{ color }}>
                {label} ({items.length})
              </div>
              {items.length > 0 ? (
                <div className="space-y-2">
                  {items.slice(0, 4).map((entity) => renderEntityButton(entity, type))}
                  {items.length > 4 && (
                    <div className="text-[11px] text-gray-600">showing 4 of {items.length}</div>
                  )}
                </div>
              ) : (
                <div className="text-xs text-gray-600">none yet</div>
              )}
            </div>
          ))}
        </div>

        {selected && centerEntity ? (
          <div className="space-y-3">
            <div className="rounded-lg p-4" style={{ background: `${typeColor(selected.type)}18`, border: `1px solid ${typeColor(selected.type)}` }}>
              <div style={{ fontSize: 10, color: typeColor(selected.type), textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>
                {selected.type}
              </div>
              <SelectedEntityBody entity={centerEntity} type={selected.type} />
              <div className="text-[11px] text-gray-600 mt-3 font-mono break-all">{selected.key}</div>
            </div>
            {renderConnectionList(connections.upstream, 'Upstream')}
            {renderConnectionList(connections.downstream, 'Downstream')}
          </div>
        ) : (
          <div className="rounded border border-border bg-bg-panel/40 p-4 text-sm text-gray-600">
            Select an entity to inspect it.
          </div>
        )}
      </div>
    </div>
  );
}

function MindGraphExplorer({ data, selected, onSelect }) {
  const { principles = [], tactics = [], patterns = [], desires = [], experiences = [] } = data;

  // Build connection map for the selected entity
  const connections = useMemo(() => getConnections({ principles, tactics, patterns, desires, experiences }, selected), [selected, principles, tactics, patterns, desires, experiences]);

  const centerEntity = useMemo(() => getCenterEntity({ principles, tactics, patterns, desires, experiences }, selected), [selected, principles, tactics, patterns, desires, experiences]);

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
        {type === 'principle' && entityLabel(entity, type, 28)}
        {type === 'desire' && (
          <span>
            <span style={{ color: '#22c55e' }}>
              {'\u2191'}
            </span>{' '}{entityLabel(entity, type, 24)}
          </span>
        )}
        {type === 'tactic' && (
          <span>
            <span style={{ color: '#fb923c' }}>{'\u25b8'}</span>{' '}{entityLabel(entity, type, 24)}
          </span>
        )}
        {type === 'pattern' && (
          <span style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>{entityLabel(entity, type, 22)}</span>
            <span style={{ color: strengthColor(entity.strength), fontSize: 10 }}>{entity.strength?.toFixed(2)}</span>
          </span>
        )}
        {type === 'experience' && (
          <span>
            <span style={{ color: '#06b6d4', fontSize: 10 }}>{'\u03c3'}{experienceSigma(entity)?.toFixed(1)}</span>{' '}
            {entityLabel(entity, type, 20)}
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
        {type === 'principle' && <div style={{ fontSize: 12, color: '#e5e5e5', lineHeight: 1.4 }}>{entityLabel(entity, type, 50)}</div>}
        {type === 'desire' && (
          <div style={{ fontSize: 12, color: '#e5e5e5' }}>
            <span style={{ color: '#22c55e' }}>
              {'\u2191'}
            </span>{' '}{entityLabel(entity, type, 35)}
          </div>
        )}
        {type === 'tactic' && (
          <div style={{ fontSize: 12, color: '#e5e5e5' }}>
            <span style={{ color: '#fb923c' }}>{'\u25b8'}</span>{' '}{entityLabel(entity, type, 35)}
          </div>
        )}
        {type === 'pattern' && (
          <>
            <div style={{ fontSize: 12, color: '#e5e5e5' }}>{entityLabel(entity, type, 35)}</div>
            <div style={{ fontSize: 10, color: strengthColor(entity.strength), marginTop: 2 }}>
              strength: {entity.strength?.toFixed(2)}
            </div>
          </>
        )}
        {type === 'experience' && (
          <>
            <div style={{ fontSize: 11, color: '#06b6d4' }}>{'\u03c3'}={experienceSigma(entity)?.toFixed(2)}</div>
            <div style={{ fontSize: 12, color: '#d4d4d4', marginTop: 2 }}>{entityLabel(entity, type, 40)}</div>
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
        <SelectedEntityBody entity={centerEntity} type={selected.type} />
      </div>
    );
  };

  return (
    <>
      <MobileMindExplorer
        data={data}
        selected={selected}
        onSelect={onSelect}
        connections={connections}
        centerEntity={centerEntity}
      />

      <div className="hidden md:flex flex-1 overflow-hidden">
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
    </>
  );
}

export default function MindTab({ patronKey }) {
  const [data, setData] = useState(null);
  const [lastReflect, setLastReflect] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [viewMode, setViewMode] = useState('debugger');
  const connections = useMemo(() => data ? getConnections(data, selected) : { upstream: [], downstream: [] }, [data, selected]);
  const centerEntity = useMemo(() => data ? getCenterEntity(data, selected) : null, [data, selected]);

  const loadData = useCallback(async () => {
    try {
      const [mind, reflectKv] = await Promise.all([
        api('/mind', patronKey),
        api('/kv/last_reflect', patronKey).catch(() => null),
      ]);
      setData(mind);
      setLastReflect(reflectKv?.value || null);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  }, [patronKey]);

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    if (data && !selected) {
      const nextSelection = pickDefaultSelection(data);
      if (nextSelection) setSelected(nextSelection);
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
      <div className="hidden md:flex border-b border-border bg-bg-panel px-4 py-2 gap-2 text-xs">
        <button
          onClick={() => setViewMode('debugger')}
          className={`rounded border px-2.5 py-1 transition ${viewMode === 'debugger' ? 'border-accent bg-accent/10 text-accent' : 'border-border text-gray-500 hover:text-gray-300'}`}
        >
          Debugger
        </button>
        <button
          onClick={() => setViewMode('graph')}
          className={`rounded border px-2.5 py-1 transition ${viewMode === 'graph' ? 'border-accent bg-accent/10 text-accent' : 'border-border text-gray-500 hover:text-gray-300'}`}
        >
          Graph
        </button>
      </div>
      {viewMode === 'graph' ? (
        <MindGraphExplorer data={data} selected={selected} onSelect={setSelected} />
      ) : (
        <>
          <MobileMindExplorer data={data} selected={selected} onSelect={setSelected} connections={connections} centerEntity={centerEntity} />
          <DebuggerMindView
            data={data}
            selected={selected}
            onSelect={setSelected}
            connections={connections}
            centerEntity={centerEntity}
            lastReflect={lastReflect}
          />
        </>
      )}
    </div>
  );
}
