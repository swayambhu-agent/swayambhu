import React, { useState, useEffect, useRef, useCallback } from 'react';
import { api } from './lib/api.js';
import { HB_NORMAL, HB_HIDDEN } from './lib/config.js';
import TimelineTab, { ContextPanel, DraggableDivider } from './components/TimelineTab.jsx';
import ReflectionsTab from './components/ReflectionsTab.jsx';
import Dr2Tab from './components/Dr2Tab.jsx';
import MindTab from './components/MindTab.jsx';
import ChatTab from './components/ChatTab.jsx';
import ContactsTab from './components/ContactsTab.jsx';
import KVExplorerTab from './components/KVExplorerTab.jsx';
import MutationsTab from './components/MutationsTab.jsx';
import DirectMessageBar from './components/DirectMessageBar.jsx';
import RequestsTab from './components/RequestsTab.jsx';

export default function App() {
  const patronKey = null;
  const [authError, setAuthError] = useState(null);
  const [health, setHealth] = useState(null);
  const [mindCounts, setMindCounts] = useState(null);
  const [balances, setBalances] = useState(null);
  const [requestSummary, setRequestSummary] = useState(null);
  const [countdown, setCountdown] = useState(null);
  const [activeTab, setActiveTab] = useState('timeline');
  const [selectedEntry, setSelectedEntry] = useState(null);
  const [leftPct, setLeftPct] = useState(50); // percentage for left panel
  const containerRef = useRef(null);
  const handleDividerDrag = useCallback((clientX) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const pct = Math.max(20, Math.min(80, ((clientX - rect.left) / rect.width) * 100));
    setLeftPct(pct);
  }, []);

  // Load health + balances, poll every 10s
  const loadHealth = useCallback(async () => {
    try {
      const h = await api('/health', patronKey);
      setAuthError(null);
      setHealth(h);
      const tryLoadBalances = async (sid) => {
        if (!sid) return false;
        try {
          const k = await api(`/kv/karma:${sid}`, patronKey);
          const entries = k.value || [];
          const end = [...entries].reverse().find(e => (e.event === 'act_complete' || e.event === 'reflect_complete') && e.balances);
          if (end?.balances) { setBalances(end.balances); return true; }
          const start = entries.find(e => e.event === 'act_start' && e.balances);
          if (start?.balances) { setBalances(start.balances); return true; }
        } catch {}
        return false;
      };
      if (!(await tryLoadBalances(h.session))) {
        try {
          const d = await api('/kv/cache:session_ids', patronKey);
          const ids = d.value || [];
          if (ids.length) await tryLoadBalances(ids[ids.length - 1]);
        } catch {}
      }
    } catch (err) {
      if (err.message === 'UNAUTHORIZED') setAuthError('Cloudflare Access authentication required for the patron dashboard.');
    }
  }, [patronKey]);

  const loadMindCounts = useCallback(async () => {
    try {
      const d = await api('/mind', patronKey);
      setMindCounts({
        patterns: d.patterns?.length || 0,
        desires: d.desires?.length || 0,
        experiences: d.experiences?.length || 0,
        sessionsSinceDr: d.operator_health?.sessions_since_dr ?? '?',
      });
    } catch {}
  }, [patronKey]);

  const loadRequestSummary = useCallback(async () => {
    try {
      const d = await api('/requests', patronKey);
      setRequestSummary(d.summary || null);
    } catch {}
  }, [patronKey]);

  // ── Heartbeat: single poll loop replaces all per-tab intervals ──
  const lastPulseN = useRef(-1);
  const inflightRef = useRef({});
  const [sessionsRev, setSessionsRev] = useState(0);
  const [chatsRev, setChatsRev] = useState(0);
  const [reflectionsRev, setReflectionsRev] = useState(0);
  const [requestsRev, setRequestsRev] = useState(0);

  useEffect(() => {
    // Load initial data on mount
    loadHealth();
    loadMindCounts();
    loadRequestSummary();

    function getInterval() {
      if (document.hidden) return HB_HIDDEN;
      return HB_NORMAL;
    }

    const guard = (key, fn) => {
      if (inflightRef.current[key]) return;
      inflightRef.current[key] = true;
      fn().finally(() => { inflightRef.current[key] = false; });
    };

    async function heartbeat() {
      try {
        const pulse = await api("/pulse", patronKey);
        if (!pulse || pulse.n === lastPulseN.current) return;
        lastPulseN.current = pulse.n;

        const changed = new Set(pulse.changed || []);

        if (changed.has("sessions"))     setSessionsRev(r => r + 1);
        if (changed.has("health"))       guard("health", loadHealth);
        if (changed.has("mind"))         guard("mind", loadMindCounts);
        if (changed.has("reflections"))  setReflectionsRev(r => r + 1);
        if (changed.has("chats"))        setChatsRev(r => r + 1);
        if (changed.has("requests"))     {
          setRequestsRev(r => r + 1);
          guard("requests", loadRequestSummary);
        }
      } catch {}
    }

    let intervalId = setInterval(heartbeat, getInterval());

    const onVisChange = () => {
      clearInterval(intervalId);
      intervalId = setInterval(heartbeat, getInterval());
    };
    document.addEventListener("visibilitychange", onVisChange);

    return () => {
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisChange);
    };
  }, [patronKey, loadHealth, loadMindCounts, loadRequestSummary]);

  // Countdown timer for next session
  useEffect(() => {
    const nextSession = health?.schedule?.next_session_after;
    if (!nextSession) return;
    const target = new Date(nextSession).getTime();
    const tick = () => {
      const diff = target - Date.now();
      if (diff <= 0) { setCountdown('now'); return; }
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setCountdown(`${h}h ${m}m ${s}s`);
    };
    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [health?.schedule?.next_session_after]);

  if (authError && !health) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <div className="bg-bg-panel border border-border rounded-lg p-8 w-full max-w-lg">
          <h1 className="text-accent font-bold text-lg tracking-widest mb-2">SWAYAMBHU</h1>
          <p className="text-gray-300 text-sm mb-2">Patron Dashboard</p>
          <p className="text-red-400 text-sm">{authError}</p>
        </div>
      </div>
    );
  }

  const tabs = [
    { id: 'timeline', label: 'Runs' },
    { id: 'requests', label: 'Requests' },
    { id: 'chat', label: 'Chat' },
    { id: 'contacts', label: 'Contacts' },
    { id: 'kv', label: 'Index' },
    { id: 'reflections', label: 'DR-1' },
    { id: 'dr2', label: 'DR-2' },
    { id: 'mutations', label: 'Modifications' },
    { id: 'mind', label: 'Mind' },
  ];

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* Header + status bar */}
      <div className="bg-bg-panel border-b border-border px-4 py-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0">
          <span className="text-accent font-bold tracking-widest text-sm">SWAYAMBHU</span>
          <span className="text-gray-600">patron</span>
          {health && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-gray-600 hidden sm:inline">|</span>
              <span className="text-gray-500">Runs:</span>
              <span className="text-accent font-semibold">{health.sessionCounter || 0}</span>
              {countdown && (
                <>
                  <span className="text-gray-600 hidden sm:inline">|</span>
                  <span className="text-gray-500">Next run:</span>
                  <span className={`font-semibold ${countdown === 'now' ? 'text-green-400' : 'text-blue-400'}`}>
                    {countdown}
                  </span>
                </>
              )}
              <span className="text-gray-600 hidden sm:inline">|</span>
              <span className={`px-2 py-0.5 rounded text-xs font-semibold ${
                health.session
                  ? 'bg-green-900/30 text-green-400'
                  : countdown === 'now'
                    ? 'bg-yellow-900/30 text-yellow-400'
                    : 'bg-gray-800 text-gray-500'
              }`}>{health.session ? 'In session' : countdown === 'now' ? 'Starting' : 'Idle'}</span>
            </div>
          )}
          {mindCounts && (
            <button
              type="button"
              className="text-gray-600 cursor-pointer hover:text-gray-400 transition md:border-l md:border-gray-800 md:pl-3 md:ml-1"
              onClick={() => setActiveTab('mind')}
              title={`${mindCounts.patterns} patterns, ${mindCounts.desires} desires, ${mindCounts.experiences} experiences — ${mindCounts.sessionsSinceDr} sessions since last DR`}
            >
              DR:{mindCounts.sessionsSinceDr}
            </button>
          )}
          {requestSummary && (
            <button
              type="button"
              className="cursor-pointer rounded-full border border-amber-900/70 bg-amber-950/20 px-2.5 py-1 text-[11px] text-amber-300 transition hover:border-amber-700 hover:text-amber-200"
              onClick={() => setActiveTab('requests')}
              title={`${requestSummary.pending} pending, ${requestSummary.fulfilled} fulfilled, ${requestSummary.rejected} rejected`}
            >
              Requests:{requestSummary.pending}
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 w-full md:w-auto md:ml-auto md:justify-end">
          {health && balances && (() => {
            const extract = (v) => typeof v === 'object' && v !== null ? v.balance : v;
            const items = [
              ...Object.entries(balances.providers || {}).map(([n, v]) => [n, extract(v)]),
              ...Object.entries(balances.wallets || {}).map(([n, v]) => [n, extract(v)]),
            ].filter(([, v]) => v != null && typeof v !== 'object');
            if (!items.length) return null;
            return (
              <>
                {items.map(([name, val]) => (
                  <React.Fragment key={name}>
                    <span className="text-gray-500">{name}:</span>
                    <span className={`font-semibold ${val > 5 ? 'text-green-400' : val > 1 ? 'text-yellow-400' : 'text-red-400'}`}>
                      ${typeof val === 'number' ? val.toFixed(2) : val}
                    </span>
                  </React.Fragment>
                ))}
                <span className="text-gray-700 mx-1">|</span>
              </>
            );
          })()}
          <button
            onClick={handleLogout}
            className="text-gray-600 hover:text-gray-400 transition"
          >logout</button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="bg-bg-panel border-b border-border px-2 sm:px-4 overflow-x-auto scrollbar-thin">
        <div className="flex gap-1 min-w-max">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-shrink-0 px-3 py-1.5 text-xs font-semibold transition border-b-2 ${
                activeTab === tab.id
                  ? 'border-accent text-accent'
                  : 'border-transparent text-gray-500 hover:text-gray-300'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Direct message bar */}
      <DirectMessageBar patronKey={patronKey} />

      {/* Content — all tabs stay mounted (display:none) to preserve state */}
      <div ref={containerRef} className="flex-1 flex overflow-hidden">
        <div style={{ display: activeTab === 'timeline' ? 'flex' : 'none', width: '100%', height: '100%' }}>
          <div style={{ width: `${leftPct}%` }} className="flex-shrink-0 p-4 overflow-hidden flex flex-col">
            <TimelineTab patronKey={patronKey} onSelectEntry={setSelectedEntry} sessionsRev={sessionsRev} />
          </div>
          <DraggableDivider onDrag={handleDividerDrag} />
          <div style={{ width: `${100 - leftPct}%` }} className="flex-shrink-0 overflow-hidden bg-bg-panel flex flex-col">
            <ContextPanel patronKey={patronKey} selectedEntry={selectedEntry} />
          </div>
        </div>
        <div style={{ display: activeTab === 'chat' ? 'flex' : 'none', width: '100%', height: '100%' }}>
          <ChatTab patronKey={patronKey} chatsRev={chatsRev} />
        </div>
        <div style={{ display: activeTab === 'requests' ? 'flex' : 'none', width: '100%', height: '100%' }}>
          <RequestsTab patronKey={patronKey} requestsRev={requestsRev} />
        </div>
        <div style={{ display: activeTab === 'contacts' ? 'flex' : 'none', width: '100%', height: '100%' }}>
          <ContactsTab patronKey={patronKey} />
        </div>
        <div style={{ display: activeTab === 'kv' ? 'block' : 'none' }} className="flex-1 p-4 overflow-hidden">
          <KVExplorerTab patronKey={patronKey} />
        </div>
        <div style={{ display: activeTab === 'reflections' ? 'block' : 'none' }} className="flex-1 p-4 overflow-hidden">
          <ReflectionsTab patronKey={patronKey} reflectionsRev={reflectionsRev} />
        </div>
        <div style={{ display: activeTab === 'dr2' ? 'block' : 'none' }} className="flex-1 p-4 overflow-hidden">
          <Dr2Tab patronKey={patronKey} reflectionsRev={reflectionsRev} />
        </div>
        <div style={{ display: activeTab === 'mutations' ? 'block' : 'none' }} className="flex-1 p-4 overflow-hidden">
          <MutationsTab patronKey={patronKey} />
        </div>
        <div style={{ display: activeTab === 'mind' ? 'block' : 'none' }} className="flex-1 overflow-auto">
          <MindTab patronKey={patronKey} />
        </div>
      </div>
    </div>
  );
}
