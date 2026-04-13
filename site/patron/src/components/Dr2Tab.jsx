import { useEffect, useState } from 'react';
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

function formatTimestamp(ts) {
  if (!ts) return null;
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function Dr2Tab({ patronKey, reflectionsRev }) {
  const [drSessions, setDrSessions] = useState([]);
  const [selectedDr, setSelectedDr] = useState(null);
  const [reflectRecord, setReflectRecord] = useState(null);
  const [loading, setLoading] = useState(true);
  const [recordLoading, setRecordLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api('/sessions', patronKey)
      .then((d) => {
        if (cancelled) return;
        const drs = (d.sessions || []).filter((s) => s.type === 'deep_reflect').reverse();
        setDrSessions(drs);
        setSelectedDr((prev) => (prev && drs.some((s) => s.id === prev) ? prev : drs[0]?.id || null));
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [patronKey, reflectionsRev]);

  useEffect(() => {
    if (!selectedDr) {
      setReflectRecord(null);
      return;
    }
    let cancelled = false;
    setRecordLoading(true);
    api(`/kv/${encodeURIComponent(`reflect:1:${selectedDr}`)}`, patronKey)
      .then((d) => {
        if (cancelled) return;
        setReflectRecord(d?.value || null);
        setRecordLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setReflectRecord(null);
        setRecordLoading(false);
      });
    return () => { cancelled = true; };
  }, [selectedDr, patronKey, reflectionsRev]);

  if (loading) return <div className="p-8 text-gray-500 text-sm">Loading DR-2 sessions...</div>;
  if (drSessions.length === 0) return <div className="p-8 text-gray-500 text-sm">No DR sessions yet</div>;

  const notes = Array.isArray(reflectRecord?.meta_policy_notes) ? reflectRecord.meta_policy_notes : [];

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-shrink-0 flex-wrap items-start gap-2 border-b border-border bg-bg-panel px-4 py-2 text-xs md:items-center">
        <span className="font-semibold text-cyan-400">DR-2</span>
        <select
          value={selectedDr || ''}
          onChange={(e) => setSelectedDr(e.target.value)}
          className="min-w-0 flex-1 rounded border border-border bg-bg-card px-2 py-1 text-xs text-gray-200 md:min-w-[18rem] md:flex-none"
        >
          {drSessions.map((s, i) => (
            <option key={s.id} value={s.id}>
              {formatDrSessionLabel(s, drSessions.length - i)}
            </option>
          ))}
        </select>
        <div className="w-full text-gray-500 md:ml-auto md:w-auto">
          Meta-policy notes: <span className="text-gray-200">{notes.length}</span>
        </div>
      </div>

      {recordLoading ? (
        <div className="p-8 text-sm text-gray-500">Loading...</div>
      ) : (
        <div className="flex-1 overflow-y-auto p-4">
          <div className="mb-4 grid gap-2 sm:grid-cols-3">
            <div className="rounded border border-border bg-bg-panel px-3 py-2 text-xs">
              <div className="text-gray-500">Captured</div>
              <div className="text-gray-200">{formatTimestamp(reflectRecord?.timestamp) || 'unknown'}</div>
            </div>
            <div className="rounded border border-border bg-bg-panel px-3 py-2 text-xs">
              <div className="text-gray-500">Generation</div>
              <div className="text-gray-200">{reflectRecord?.from_dr_generation != null ? String(reflectRecord.from_dr_generation) : 'unknown'}</div>
            </div>
            <div className="rounded border border-border bg-bg-panel px-3 py-2 text-xs">
              <div className="text-gray-500">Session</div>
              <div className="break-all font-mono text-gray-300">{selectedDr}</div>
            </div>
          </div>

          {notes.length > 0 ? (
            <div className="space-y-3">
              {notes.map((note, index) => (
                <div key={`${note.slug || 'note'}:${index}`} className="rounded border border-cyan-900/40 bg-cyan-950/10 p-4">
                  <div className="mb-2 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wider">
                    <span className="rounded border border-cyan-800/60 bg-cyan-900/20 px-2 py-1 text-cyan-300">
                      {note.slug || `note-${index + 1}`}
                    </span>
                    {note.subsystem && <span className="text-gray-500">{note.subsystem}</span>}
                    {note.target_review && <span className="text-gray-500">{note.target_review}</span>}
                    {typeof note.confidence === 'number' && <span className="text-gray-500">confidence {note.confidence.toFixed(2)}</span>}
                  </div>

                  {note.summary && <div className="text-sm font-semibold text-gray-100">{note.summary}</div>}
                  {note.observation && (
                    <div className="mt-3">
                      <div className="mb-1 text-[10px] uppercase tracking-wider text-gray-500">Observation</div>
                      <div className="text-sm leading-6 text-gray-300">{note.observation}</div>
                    </div>
                  )}
                  {note.rationale && (
                    <div className="mt-3">
                      <div className="mb-1 text-[10px] uppercase tracking-wider text-gray-500">Rationale</div>
                      <div className="text-sm leading-6 text-gray-300">{note.rationale}</div>
                    </div>
                  )}
                  {note.proposed_experiment && (
                    <div className="mt-3 rounded border border-amber-900/40 bg-amber-950/10 px-3 py-2">
                      <div className="mb-1 text-[10px] uppercase tracking-wider text-amber-400">Proposed experiment</div>
                      <div className="text-sm leading-6 text-amber-100">{note.proposed_experiment}</div>
                    </div>
                  )}
                  <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
                    <span>non-live: {note.non_live ? 'yes' : 'no'}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded border border-border bg-bg-panel px-4 py-4 text-sm text-gray-500">
              No `meta_policy_notes` were stored for this DR session.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
