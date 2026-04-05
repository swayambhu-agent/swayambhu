import React, { useState, useEffect, useRef, useCallback } from 'react';
import { api } from './lib/api.js';
import { HB_NORMAL, HB_HIDDEN } from './lib/config.js';
import LoginScreen from './components/LoginScreen.jsx';
import TimelineTab, { ContextPanel, DraggableDivider } from './components/TimelineTab.jsx';
import ReflectionsTab from './components/ReflectionsTab.jsx';
import MindTab from './components/MindTab.jsx';
import ChatTab from './components/ChatTab.jsx';
import ContactsTab from './components/ContactsTab.jsx';
import KVExplorerTab from './components/KVExplorerTab.jsx';
import MutationsTab from './components/MutationsTab.jsx';
import DirectMessageBar from './components/DirectMessageBar.jsx';

export default function App() {
  const [patronKey, setPatronKey] = useState(() => sessionStorage.getItem('patronKey'));
  const [health, setHealth] = useState(null);
  const [mindCounts, setMindCounts] = useState(null);
  const [balances, setBalances] = useState(null);
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

  const handleLogin = (key) => {
    sessionStorage.setItem('patronKey', key);
    setPatronKey(key);
  };

  const handleLogout = () => {
    sessionStorage.removeItem('patronKey');
    setPatronKey(null);
    setHealth(null);
    setBalances(null);
  };

  // Load health + balances on auth, poll every 10s
  const loadHealth = useCallback(async () => {
    if (!patronKey) return;
    try {
      const h = await api('/health', patronKey);
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
      if (err.message === 'UNAUTHORIZED') handleLogout();
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

  // ── Heartbeat: single poll loop replaces all per-tab intervals ──
  const lastPulseN = useRef(-1);
  const inflightRef = useRef({});
  const [sessionsRev, setSessionsRev] = useState(0);
  const [chatsRev, setChatsRev] = useState(0);
  const [reflectionsRev, setReflectionsRev] = useState(0);

  useEffect(() => {
    if (!patronKey) return;

    // Load initial data on mount
    loadHealth();
    loadMindCounts();

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
  }, [patronKey, loadHealth, loadMindCounts]);

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

  if (!patronKey) return <LoginScreen onLogin={handleLogin} />;

  const tabs = [
    { id: 'timeline', label: 'Runs' },
    { id: 'chat', label: 'Chat' },
    { id: 'contacts', label: 'Contacts' },
    { id: 'kv', label: 'Index' },
    { id: 'reflections', label: 'Deep Reflect' },
    { id: 'mutations', label: 'Modifications' },
    { id: 'mind', label: 'Mind' },
  ];

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* Header + status bar */}
      <div className="bg-bg-panel border-b border-border px-4 py-2 flex items-center gap-4 text-xs">
        <span className="text-accent font-bold tracking-widest text-sm">SWAYAMBHU</span>
        <span className="text-gray-600">patron</span>
        {health && (
          <>
            <span className="text-gray-600">|</span>
            <span className="text-gray-500">Runs:</span>
            <span className="text-accent font-semibold">{health.sessionCounter || 0}</span>
            {countdown && (
              <>
                <span className="text-gray-600">|</span>
                <span className="text-gray-500">Next run:</span>
                <span className={`font-semibold ${countdown === 'now' ? 'text-green-400' : 'text-blue-400'}`}>
                  {countdown}
                </span>
              </>
            )}
            <span className="text-gray-600">|</span>
            <span className={`ml-1 px-2 py-0.5 rounded text-xs font-semibold ${
              health.session
                ? 'bg-green-900/30 text-green-400'
                : countdown === 'now'
                  ? 'bg-yellow-900/30 text-yellow-400'
                  : 'bg-gray-800 text-gray-500'
            }`}>{health.session ? 'In session' : countdown === 'now' ? 'Starting' : 'Idle'}</span>
          </>
        )}
        {mindCounts && (
          <span className="text-gray-600 border-l border-gray-800 pl-3 ml-1 cursor-pointer hover:text-gray-400 transition"
            onClick={() => setActiveTab('mind')}
            title={`${mindCounts.patterns} patterns, ${mindCounts.desires} desires, ${mindCounts.experiences} experiences — ${mindCounts.sessionsSinceDr} sessions since last DR`}
          >
            DR:{mindCounts.sessionsSinceDr}
          </span>
        )}
        <div className="flex items-center gap-2 ml-auto">
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
      <div className="bg-bg-panel border-b border-border px-4 flex gap-1">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-3 py-1.5 text-xs font-semibold transition border-b-2 ${
              activeTab === tab.id
                ? 'border-accent text-accent'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            {tab.label}
          </button>
        ))}
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
        <div style={{ display: activeTab === 'contacts' ? 'flex' : 'none', width: '100%', height: '100%' }}>
          <ContactsTab patronKey={patronKey} />
        </div>
        <div style={{ display: activeTab === 'kv' ? 'block' : 'none' }} className="flex-1 p-4 overflow-hidden">
          <KVExplorerTab patronKey={patronKey} />
        </div>
        <div style={{ display: activeTab === 'reflections' ? 'block' : 'none' }} className="flex-1 p-4 overflow-hidden">
          <ReflectionsTab patronKey={patronKey} reflectionsRev={reflectionsRev} />
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
