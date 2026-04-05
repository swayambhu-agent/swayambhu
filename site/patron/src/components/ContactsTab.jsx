import { useState, useEffect, useCallback } from 'react';
import { api, API_URL } from '../lib/api.js';
import { JsonView } from './ui/JsonView.jsx';
import { LoadError } from './ui/LoadError.jsx';

export default function ContactsTab({ patronKey }) {
  const [contacts, setContacts] = useState([]);
  const [bindings, setBindings] = useState([]);
  const [selectedSlug, setSelectedSlug] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [cRes, pRes] = await Promise.all([
        api('/kv?prefix=contact:', patronKey),
        api('/kv?prefix=contact_platform:', patronKey),
      ]);
      // Load contact values
      const contactList = [];
      for (const k of (cRes.keys || [])) {
        if (k.key.startsWith('contact_platform:')) continue;
        try {
          const d = await api(`/kv/${encodeURIComponent(k.key)}`, patronKey);
          contactList.push({ slug: k.key.replace('contact:', ''), ...d.value });
        } catch {}
      }
      // Load platform bindings
      const bindingList = [];
      for (const k of (pRes.keys || [])) {
        try {
          const d = await api(`/kv/${encodeURIComponent(k.key)}`, patronKey);
          const parts = k.key.replace('contact_platform:', '').split(':');
          const platform = parts[0];
          const platformId = parts.slice(1).join(':');
          bindingList.push({ key: k.key, platform, platformId, ...d.value });
        } catch {}
      }
      setContacts(contactList);
      setBindings(bindingList);
      if (contactList.length > 0) setSelectedSlug(prev => prev || contactList[0].slug);
      setLoading(false);
    } catch (e) { setError(e.message); setLoading(false); }
  }, [patronKey]);

  useEffect(() => { load(); }, [load]);

  const toggleApproval = async (binding) => {
    const newApproved = !binding.approved;
    try {
      await fetch(`${API_URL}/contact-platform/${encodeURIComponent(binding.platform)}/${encodeURIComponent(binding.platformId)}/approve`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-Patron-Key': patronKey },
        body: JSON.stringify({ approved: newApproved }),
      });
      await load();
    } catch {}
  };

  if (loading) return <p className="text-gray-500 text-sm p-4">Loading contacts...</p>;
  if (error) return <LoadError error={error} onRetry={load} />;

  const selected = contacts.find(c => c.slug === selectedSlug);
  const selectedBindings = bindings.filter(b => b.slug === selectedSlug);
  const pendingBindings = bindings.filter(b => !b.approved);

  return (
    <div className="flex h-full gap-0">
      {/* Left panel — contact list */}
      <div className="w-64 flex-shrink-0 border-r border-border overflow-y-auto scrollbar-thin p-3">
        {pendingBindings.length > 0 && (
          <div className="mb-3 p-2 rounded bg-yellow-900/20 border border-yellow-800/40">
            <div className="text-xs text-yellow-400 font-semibold mb-1">Pending Approvals ({pendingBindings.length})</div>
            {pendingBindings.map(b => (
              <div key={b.key} className="flex items-center justify-between text-xs py-1">
                <span className="text-gray-300 truncate flex-1">
                  <span className="text-gray-500">{b.platform}:</span> {b.platformId}
                </span>
                <button
                  onClick={() => toggleApproval(b)}
                  className="ml-2 px-2 py-0.5 rounded text-[10px] bg-green-900/30 text-green-400 border border-green-800 hover:bg-green-900/50 transition"
                >approve</button>
              </div>
            ))}
          </div>
        )}
        <div className="text-xs text-gray-500 mb-2 font-semibold">Contacts ({contacts.length})</div>
        {contacts.map(c => {
          const cBindings = bindings.filter(b => b.slug === c.slug);
          const pendingCount = cBindings.filter(b => !b.approved).length;
          return (
            <button
              key={c.slug}
              onClick={() => setSelectedSlug(c.slug)}
              className={`w-full text-left px-2 py-1.5 rounded text-xs mb-1 transition ${
                selectedSlug === c.slug
                  ? 'bg-accent/10 border border-accent text-accent'
                  : 'border border-transparent hover:border-gray-700 text-gray-300'
              }`}
            >
              <div className="flex items-center gap-1">
                <span className="truncate flex-1 font-medium">{c.name}</span>
                {pendingCount > 0 && (
                  <span className="px-1.5 py-0.5 rounded-full bg-yellow-900/40 text-yellow-400 text-[10px]">{pendingCount}</span>
                )}
              </div>
              {c.relationship && <div className="text-gray-500 text-[10px] truncate">{c.relationship}</div>}
              <div className="text-gray-600 text-[10px]">{cBindings.length} platform{cBindings.length !== 1 ? 's' : ''}</div>
            </button>
          );
        })}
      </div>

      {/* Right panel — contact detail */}
      <div className="flex-1 overflow-y-auto scrollbar-thin p-4">
        {!selected ? (
          <p className="text-gray-500 text-sm">Select a contact</p>
        ) : (
          <div className="fade-in">
            <h2 className="text-accent font-bold text-sm mb-1">{selected.name}</h2>
            {selected.relationship && <div className="text-gray-400 text-xs mb-2">{selected.relationship}</div>}
            {selected.about && <div className="text-gray-300 text-xs mb-3">{selected.about}</div>}
            {selected.communication && (
              <div className="mb-3">
                <div className="text-gray-500 text-[10px] font-semibold mb-1">Communication guidance</div>
                <div className="text-gray-400 text-xs bg-bg rounded p-2 border border-border">{selected.communication}</div>
              </div>
            )}
            {selected.chat && (
              <div className="mb-3">
                <div className="text-gray-500 text-[10px] font-semibold mb-1">Chat config</div>
                <div className="text-xs text-gray-400 mb-1">
                  {[
                    selected.chat.model && `model: ${selected.chat.model}`,
                    selected.chat.effort && `effort: ${selected.chat.effort}`,
                    selected.chat.max_output_tokens && `max tokens: ${selected.chat.max_output_tokens}`,
                  ].filter(Boolean).join(' · ')}
                </div>
                <div className="bg-bg rounded p-2 border border-border">
                  <JsonView data={selected.chat} />
                </div>
              </div>
            )}

            <div className="text-gray-500 text-[10px] font-semibold mb-2 mt-4">Platform Bindings</div>
            {selectedBindings.length === 0 ? (
              <p className="text-gray-600 text-xs">No platform bindings</p>
            ) : (
              <div className="space-y-2">
                {selectedBindings.map(b => (
                  <div key={b.key} className="flex items-center gap-2 px-3 py-2 rounded border border-border bg-bg-card">
                    <div className={`w-1.5 h-6 rounded-full ${b.approved ? 'bg-green-500' : 'bg-yellow-500'}`}></div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-gray-300">
                        <span className="text-gray-500">{b.platform}</span>
                        <span className="mx-1 text-gray-600">:</span>
                        <span className="font-medium">{b.platformId}</span>
                      </div>
                    </div>
                    <button
                      onClick={() => toggleApproval(b)}
                      className={`px-2 py-0.5 rounded text-[10px] border transition ${
                        b.approved
                          ? 'bg-red-900/20 text-red-400 border-red-800 hover:bg-red-900/40'
                          : 'bg-green-900/20 text-green-400 border-green-800 hover:bg-green-900/40'
                      }`}
                    >{b.approved ? 'revoke' : 'approve'}</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
