import { useState, useCallback, useEffect } from 'react';
import { api, API_URL } from '../lib/api.js';
import { HB_SAFETY } from '../lib/config.js';

export default function DirectMessageBar({ patronKey }) {
  const [pending, setPending] = useState(null);     // { message, sent_at } or null
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [sending, setSending] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const d = await api('/direct', patronKey);
      setPending(d.pending ? d.message : null);
    } catch {}
  }, [patronKey]);

  useEffect(() => { refresh(); }, [refresh]);
  // Safety-net poll to detect when the agent consumes the message
  useEffect(() => {
    const iv = setInterval(refresh, HB_SAFETY);
    return () => clearInterval(iv);
  }, [refresh]);

  const send = async () => {
    if (!draft.trim() || sending) return;
    setSending(true);
    try {
      await fetch(`${API_URL}/direct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: draft.trim() }),
      });
      setDraft('');
      setEditing(false);
      await refresh();
    } catch {}
    setSending(false);
  };

  const del = async () => {
    try {
      await fetch(`${API_URL}/direct`, {
        method: 'DELETE',
      });
      setPending(null);
      setDraft('');
      setEditing(false);
    } catch {}
  };

  const startEdit = () => {
    setDraft(pending?.message || '');
    setEditing(true);
  };

  // Show pending message
  if (pending && !editing) {
    return (
      <div className="bg-cyan-950/30 border-b border-cyan-900/50 px-4 py-1.5 flex items-center gap-3 text-xs">
        <span className="text-cyan-600 font-semibold flex-shrink-0">DIRECT</span>
        <span className="bg-cyan-900/40 text-cyan-400 px-1.5 py-0.5 rounded text-[10px] font-semibold flex-shrink-0">PENDING</span>
        <span className="text-cyan-300/80 truncate flex-1">{pending.message}</span>
        <span className="text-gray-600 flex-shrink-0">{pending.sent_at ? new Date(pending.sent_at).toLocaleTimeString() : ''}</span>
        <button onClick={startEdit} className="text-cyan-600 hover:text-cyan-400 transition">edit</button>
        <button onClick={del} className="text-red-700 hover:text-red-400 transition">delete</button>
      </div>
    );
  }

  // Show input (compose or edit mode)
  if (editing) {
    return (
      <div className="bg-cyan-950/30 border-b border-cyan-900/50 px-4 py-1.5 flex items-center gap-2 text-xs">
        <span className="text-cyan-600 font-semibold flex-shrink-0">DIRECT</span>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') send(); if (e.key === 'Escape') { setEditing(false); setDraft(''); } }}
          placeholder="Message to agent (read in next session)..."
          className="flex-1 bg-transparent border border-cyan-900/50 rounded px-2 py-1 text-cyan-200 placeholder-gray-600 focus:outline-none focus:border-cyan-700"
          autoFocus
        />
        <button
          onClick={send}
          disabled={!draft.trim() || sending}
          className="text-cyan-500 hover:text-cyan-300 disabled:text-gray-700 transition font-semibold"
        >{sending ? '...' : 'send'}</button>
        <button
          onClick={() => { setEditing(false); setDraft(''); }}
          className="text-gray-600 hover:text-gray-400 transition"
        >cancel</button>
      </div>
    );
  }

  // Collapsed — just a small trigger button
  return (
    <div className="bg-bg-panel border-b border-border px-4 py-1 flex items-center text-xs">
      <button
        onClick={() => setEditing(true)}
        className="text-gray-600 hover:text-cyan-500 transition"
      >+ direct message</button>
    </div>
  );
}
