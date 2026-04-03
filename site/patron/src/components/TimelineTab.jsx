import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { api } from '../lib/api.js';
import { formatTime } from '../lib/format.js';
import { eventColor } from '../lib/colors.js';
import { JsonTree } from './ui/JsonView.jsx';

// ── Draggable Divider ─────────────────────────────────────
function DraggableDivider({ onDrag }) {
  const handleMouseDown = useCallback((e) => {
    e.preventDefault();
    document.body.classList.add('divider-dragging');
    const onMove = (ev) => onDrag(ev.clientX);
    const onUp = () => {
      document.body.classList.remove('divider-dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [onDrag]);

  return (
    <div
      onMouseDown={handleMouseDown}
      style={{ width: 4, minWidth: 4, cursor: 'col-resize', background: '#1e1e3a' }}
    ></div>
  );
}

// ── Context Panel ─────────────────────────────────────────
function PromptViewer({ patronKey, requestKey }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const load = async () => {
    if (data) { setOpen(!open); return; }
    setLoading(true);
    try {
      const d = await api(`/kv/${encodeURIComponent(requestKey)}`, patronKey);
      setData(d?.value || d || null);
    } catch { setData({ error: "prompt data expired or unavailable" }); }
    setLoading(false);
    setOpen(true);
  };

  return (
    <div className="mb-3">
      <button onClick={load} className="text-[10px] text-accent hover:underline">
        {loading ? "loading..." : open ? "▾ hide prompt" : "▸ show prompt"}
      </button>
      {open && data && (
        <div className="mt-1 border border-border rounded p-2 bg-bg">
          <JsonTree data={data} defaultOpen={false} />
        </div>
      )}
    </div>
  );
}

function ContextPanel({ patronKey, selectedEntry }) {
  if (!selectedEntry) {
    return (
      <div className="h-full flex items-center justify-center p-4">
        <p className="text-gray-600 text-xs text-center">
          Select an event in the timeline<br/>to see details here
        </p>
      </div>
    );
  }

  const entry = selectedEntry;
  const c = eventColor(entry.type);

  return (
    <div className="h-full flex flex-col">
      {/* Pinned header */}
      <div className={`flex-shrink-0 ${c.bg} border ${c.border} rounded px-3 py-2 m-4 mb-0`}>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${c.dot}`}></span>
          {entry._idx != null && <span className="text-gray-600 text-[10px]">#{entry._idx + 1}</span>}
          <span className={`${c.text} font-bold text-sm`}>{entry.type}</span>
          {entry.ts && (
            <span className="text-gray-500 text-xs ml-auto">{formatTime(entry.ts)}</span>
          )}
        </div>
        {entry.tool && (
          <div className="mt-1 ml-4">
            <span className="text-purple-300 text-sm font-semibold">{entry.tool}</span>
          </div>
        )}
        {entry.model && (
          <div className="mt-1 ml-4 text-blue-300 text-xs">{entry.model}</div>
        )}
      </div>

      {/* Collapsible JSON tree */}
      <div className="flex-1 overflow-y-auto scrollbar-thin p-4 text-xs font-mono">
        {entry.request_key && <PromptViewer patronKey={patronKey} requestKey={entry.request_key} />}
        <JsonTree data={entry} defaultOpen={true} />
      </div>
    </div>
  );
}

// ── Timeline Tab ──────────────────────────────────────────
function TimelineTab({ patronKey, onSelectEntry, sessionsRev }) {
  const [sessions, setSessions] = useState([]);       // [{id, type, ts}]
  const [selectedSession, setSelectedSession] = useState(null);
  const [karma, setKarma] = useState([]);
  const [loading, setLoading] = useState(false);
  const [watching, setWatching] = useState(false);
  const karmaRef = useRef([]);
  const autoStartedRef = useRef(false);

  const refreshSessions = useCallback(async () => {
    try {
      const d = await api('/sessions', patronKey);
      const list = (d.sessions || []).filter(s => s.type !== 'deep_reflect').reverse();
      if (list.length > 0) {
        setSessions(list);
        setSelectedSession(prev => prev || list[0].id);
        return list;
      }
    } catch {}
    // Fallback: try cache:session_ids
    try {
      const d = await api('/kv/cache:session_ids', patronKey);
      const ids = d.value || [];
      if (ids.length > 0) {
        const list = ids.reverse().map(id => ({ id, type: 'act', ts: null }));
        setSessions(list);
        setSelectedSession(prev => prev || list[0].id);
        return list;
      }
    } catch {}
    return [];
  }, [patronKey]);

  useEffect(() => {
    refreshSessions();
  }, [refreshSessions, sessionsRev]);

  const loadKarma = useCallback(async (sid) => {
    if (!sid) return;
    setLoading(true);
    try {
      const d = await api(`/kv/karma:${sid}`, patronKey);
      if (d.error) {
        // Session not found — refresh session list
        const fresh = await refreshSessions();
        if (fresh.length > 0 && !fresh.some(s => s.id === sid)) {
          setSelectedSession(fresh[fresh.length - 1].id);
        }
        setKarma([]); karmaRef.current = [];
        setLoading(false);
        return;
      }
      const entries = (d.value || []).map(e => ({
        ...e,
        type: e.type || e.event,
        ts: e.ts || (e.t ? new Date(e.t).toISOString() : null),
      }));
      setKarma(entries);
      karmaRef.current = entries;
    } catch { setKarma([]); karmaRef.current = []; }
    setLoading(false);
  }, [patronKey]);

  useEffect(() => {
    if (selectedSession) loadKarma(selectedSession);
  }, [selectedSession, loadKarma]);

  // Reload karma when pulse detects session changes (while watching)
  useEffect(() => {
    if (watching && selectedSession && sessionsRev > 0) loadKarma(selectedSession);
  }, [sessionsRev]);

  const toggleWatch = () => {
    if (watching) {
      setWatching(false);
    } else {
      setWatching(true);
      loadKarma(selectedSession);
    }
  };

  // Auto-start watching on first session load
  useEffect(() => {
    if (selectedSession && !autoStartedRef.current) {
      autoStartedRef.current = true;
      setWatching(true);
    }
  }, [selectedSession]);

  // Precompute request-response pairs (tool_start↔tool_complete)
  const [selectedIdx, setSelectedIdx] = useState(null);
  const pairs = useMemo(() => {
    const map = {};
    const byStepId = {}; // step_id -> index of tool_start
    karma.forEach((e, i) => {
      if (e.type === 'tool_call' || e.type === 'tool_start') {
        if (e.step_id) byStepId[e.step_id] = i;
      } else if (e.type === 'tool_complete' || e.type === 'tool_result') {
        const startIdx = e.step_id ? byStepId[e.step_id] : undefined;
        if (startIdx != null) {
          map[startIdx] = i;
          map[i] = startIdx;
        }
      }
    });
    return map;
  }, [karma]);
  const pairedIdx = selectedIdx != null ? pairs[selectedIdx] : null;

  // Compute running stats
  const stats = useMemo(() => {
    if (!karma.length) return null;
    const first = karma[0];
    const last = karma[karma.length - 1];
    const elapsed = first.ts && last.ts
      ? Math.round((new Date(last.ts) - new Date(first.ts)) / 1000)
      : 0;
    const cost = karma.reduce((sum, e) => sum + (e.cost || 0), 0);
    const llmCalls = karma.filter(e => e.type === 'llm_call').length;
    const toolCalls = karma.filter(e => e.type === 'tool_call' || e.type === 'tool_start').length;
    return { elapsed, cost, llmCalls, toolCalls, total: llmCalls + toolCalls };
  }, [karma]);

  return (
    <div className="flex flex-col h-full">
      {/* Session selector + stats */}
      <div className="flex items-center gap-3 mb-2 flex-wrap text-xs">
        <select
          value={selectedSession || ''}
          onChange={(e) => setSelectedSession(e.target.value)}
          className="bg-bg border border-border rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-accent"
        >
          {sessions.map(s => (
            <option key={s.id} value={s.id}>{s.id}</option>
          ))}
        </select>
        <button
          onClick={toggleWatch}
          className={`px-2 py-1 rounded font-semibold border transition ${
            watching
              ? 'bg-green-900/30 border-green-700 text-green-400'
              : 'bg-bg border-border text-gray-400 hover:border-accent hover:text-accent'
          }`}
        >
          {watching && <span className="inline-block w-2 h-2 rounded-full bg-green-400 pulse-dot mr-1.5"></span>}
          {watching ? 'Watching' : 'Watch'}
        </button>
        {stats && (
          <>
            <span className="text-gray-700">|</span>
            <span className="whitespace-nowrap"><span className="text-gray-500">Requests: </span><span className="text-accent">{stats.total}</span> <span className="text-gray-600">({stats.llmCalls} LLM, {stats.toolCalls} tool)</span></span>
            <span className="whitespace-nowrap"><span className="text-gray-500">Elapsed: </span><span className="text-gray-300">{stats.elapsed}s</span></span>
            {stats.cost > 0 && (
              <span className="whitespace-nowrap"><span className="text-gray-500">Cost: </span><span className="text-green-400">${stats.cost.toFixed(4)}</span></span>
            )}
          </>
        )}
      </div>

      {/* Karma entries — grouped into Act and Deep Reflect sections */}
      <div className="flex-1 overflow-y-auto scrollbar-thin space-y-1.5">
        {loading && <p className="text-gray-500 text-sm">Loading karma...</p>}
        {!loading && karma.length === 0 && (
          <p className="text-gray-500 text-sm">No karma entries found</p>
        )}
        {(() => {
          // Classify entries into act session vs deep reflect
          const isDrEvent = (e) =>
            (e.event || e.type || '').startsWith('dr_') ||
            ((e.event || e.type) === 'tool_start' && e.step_id?.startsWith('dr_')) ||
            ((e.event || e.type) === 'tool_complete' && e.step_id?.startsWith('dr_'));

          const actEntries = [];
          const drEntries = [];
          karma.forEach((entry, i) => {
            if (isDrEvent(entry)) {
              drEntries.push({ entry, i });
            } else {
              actEntries.push({ entry, i });
            }
          });

          const renderEntry = ({ entry, i }) => {
            const c = eventColor(entry.type);
            const isResponse = ['llm_response', 'tool_complete', 'tool_result'].includes(entry.type);
            const isSelected = selectedIdx === i;
            const isPaired = pairedIdx === i;
            return (
              <div
                key={i}
                onClick={() => { setSelectedIdx(i); onSelectEntry({ ...entry, _idx: i }); }}
                className={`${c.bg} border ${c.border} rounded px-3 py-2 cursor-pointer hover:brightness-125 transition text-xs fade-in ${isResponse ? 'opacity-75' : ''} ${isSelected ? 'ring-1 ring-accent' : ''} ${isPaired ? 'ring-1 ring-accent/50 brightness-125' : ''}`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-gray-600 text-[10px] w-5 text-right flex-shrink-0 tabular-nums">{i + 1}</span>
                  <span className={`w-2 h-2 rounded-full ${c.dot} flex-shrink-0 ${isResponse ? 'w-1.5 h-1.5' : ''}`}></span>
                  <span className={`${c.text} ${isResponse ? '' : 'font-semibold'}`}>{entry.type}</span>
                  {(isSelected || isPaired) && pairs[i] != null && (
                    <span className="text-accent/60 text-[10px]">{isResponse ? 'response' : 'request'}</span>
                  )}
                  {entry.ts && (
                    <span className="text-gray-500 ml-auto">{formatTime(entry.ts)}</span>
                  )}
                </div>
                {entry.tool && <span className="text-purple-300 ml-4">{entry.tool}</span>}
                {entry.model && <span className="text-blue-300 ml-4">{entry.model}</span>}
                {entry.summary && <p className="text-gray-400 ml-4 mt-1 truncate">{entry.summary}</p>}
                {entry.error && <p className="text-red-300 ml-4 mt-1 truncate">{entry.error}</p>}
              </div>
            );
          };

          return (
            <>
              {actEntries.length > 0 && (
                <>
                  <div className="flex items-center gap-2 pt-1 pb-0.5">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-green-500">Act</span>
                    <div className="flex-1 border-t border-green-900/50"></div>
                  </div>
                  {actEntries.map(renderEntry)}
                </>
              )}
              {drEntries.length > 0 && (
                <>
                  <div className="flex items-center gap-2 pt-3 pb-0.5">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-teal-500">Deep Reflect</span>
                    <div className="flex-1 border-t border-teal-900/50"></div>
                  </div>
                  {drEntries.map(renderEntry)}
                </>
              )}
            </>
          );
        })()}
      </div>
    </div>
  );
}

export default TimelineTab;
export { ContextPanel, DraggableDivider };
