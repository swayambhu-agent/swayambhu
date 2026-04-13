import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { formatDateTime } from '../lib/format.js';
import { LoadError } from './ui/LoadError.jsx';
import { JsonTree } from './ui/JsonView.jsx';

function ageLabel(ts) {
  if (!ts) return '';
  const deltaMs = Date.now() - new Date(ts).getTime();
  if (!Number.isFinite(deltaMs)) return '';
  const minutes = Math.max(0, Math.round(deltaMs / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function statusTone(status) {
  if (status === 'fulfilled') return 'border-emerald-800 bg-emerald-950/20 text-emerald-300';
  if (status === 'rejected') return 'border-rose-800 bg-rose-950/20 text-rose-300';
  return 'border-amber-800 bg-amber-950/20 text-amber-300';
}

function RequestSummaryBar({ summary, onFilter, activeFilter }) {
  const pills = [
    ['all', 'All', summary.total, 'text-gray-300 border-gray-700 bg-bg-card'],
    ['pending', 'Pending', summary.pending, 'text-amber-300 border-amber-800 bg-amber-950/20'],
    ['fulfilled', 'Fulfilled', summary.fulfilled, 'text-emerald-300 border-emerald-800 bg-emerald-950/20'],
    ['rejected', 'Rejected', summary.rejected, 'text-rose-300 border-rose-800 bg-rose-950/20'],
  ];

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-bg-panel px-4 py-3 text-xs">
      <div className="text-[10px] uppercase tracking-[0.2em] text-gray-500">Work Requests</div>
      <div className="flex flex-wrap gap-2 md:ml-auto">
        {pills.map(([id, label, count, tone]) => (
          <button
            key={id}
            type="button"
            onClick={() => onFilter(id)}
            className={`rounded-full border px-3 py-1 transition ${tone} ${activeFilter === id ? 'ring-1 ring-accent/60' : 'opacity-80 hover:opacity-100'}`}
          >
            {label} <span className="font-mono text-[10px]">{count}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function RequestsTab({ patronKey, requestsRev }) {
  const [data, setData] = useState({ summary: { total: 0, pending: 0, fulfilled: 0, rejected: 0 }, requests: [] });
  const [selectedId, setSelectedId] = useState(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await api('/requests', patronKey);
      setData(next);
      setSelectedId((current) => current || next.requests?.[0]?.id || null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [patronKey]);

  useEffect(() => { load(); }, [load, requestsRev]);

  const visibleRequests = useMemo(() => {
    if (statusFilter === 'all') return data.requests || [];
    return (data.requests || []).filter((item) => item.status === statusFilter);
  }, [data.requests, statusFilter]);

  useEffect(() => {
    if (visibleRequests.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!visibleRequests.some((item) => item.id === selectedId)) {
      setSelectedId(visibleRequests[0].id);
    }
  }, [visibleRequests, selectedId]);

  const selected = visibleRequests.find((item) => item.id === selectedId) || null;

  if (loading && !data.requests.length) {
    return <p className="p-4 text-sm text-gray-500">Loading requests...</p>;
  }
  if (error && !data.requests.length) {
    return <LoadError error={error} onRetry={load} />;
  }

  return (
    <div className="flex h-full overflow-hidden">
      <div className="flex w-[360px] flex-shrink-0 flex-col border-r border-border">
        <RequestSummaryBar
          summary={data.summary || { total: 0, pending: 0, fulfilled: 0, rejected: 0 }}
          activeFilter={statusFilter}
          onFilter={setStatusFilter}
        />
        <div className="flex-1 overflow-y-auto scrollbar-thin p-3">
          {visibleRequests.length === 0 ? (
            <div className="rounded border border-dashed border-border p-4 text-xs text-gray-500">
              No requests in this filter.
            </div>
          ) : (
            <div className="space-y-2">
              {visibleRequests.map((item) => {
                const active = item.id === selectedId;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSelectedId(item.id)}
                    className={`w-full rounded-xl border p-3 text-left transition ${active ? 'border-accent bg-accent/10' : 'border-border bg-bg-card/70 hover:border-gray-600'}`}
                  >
                    <div className="mb-2 flex items-center gap-2">
                      <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${statusTone(item.status)}`}>
                        {item.status}
                      </span>
                      <span className="ml-auto text-[10px] text-gray-500">{ageLabel(item.updated_at)}</span>
                    </div>
                    <div className="text-xs font-semibold text-gray-100">{item.summary || '(no summary)'}</div>
                    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-gray-500">
                      <span>{item.requester_name || item.requester?.id || item.source || 'unknown requester'}</span>
                      {item.next_session && <span>next {item.next_session}</span>}
                      <span>{formatDateTime(item.updated_at || item.created_at)}</span>
                    </div>
                    {item.note && (
                      <div className="mt-2 line-clamp-2 text-[11px] text-gray-400">{item.note}</div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin bg-bg-panel/40 p-4">
        {!selected ? (
          <div className="flex h-full items-center justify-center text-sm text-gray-500">
            Select a request to inspect its state.
          </div>
        ) : (
          <div className="space-y-4 fade-in">
            <div className="rounded-2xl border border-border bg-bg-panel p-5">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <span className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] ${statusTone(selected.status)}`}>
                  {selected.status}
                </span>
                <span className="text-[11px] text-gray-500">{selected.id}</span>
              </div>
              <h2 className="text-lg font-semibold text-gray-100">{selected.summary || '(no summary)'}</h2>
              <div className="mt-3 grid gap-3 text-xs text-gray-400 md:grid-cols-2 xl:grid-cols-4">
                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-gray-600">Requester</div>
                  <div>{selected.requester_name || selected.requester?.id || selected.source || 'unknown'}</div>
                </div>
                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-gray-600">Created</div>
                  <div>{formatDateTime(selected.created_at)}</div>
                </div>
                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-gray-600">Updated</div>
                  <div>{formatDateTime(selected.updated_at)}</div>
                </div>
                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-gray-600">Conversation Ref</div>
                  <div className="break-all">{selected.ref || '—'}</div>
                </div>
              </div>
            </div>

            {selected.note && (
              <section className="rounded-2xl border border-border bg-bg-panel p-5">
                <div className="mb-2 text-[10px] uppercase tracking-[0.2em] text-gray-500">Latest Note</div>
                <div className="whitespace-pre-wrap text-sm text-gray-200">{selected.note}</div>
              </section>
            )}

            {selected.result && (
              <section className="rounded-2xl border border-emerald-900/60 bg-emerald-950/10 p-5">
                <div className="mb-2 text-[10px] uppercase tracking-[0.2em] text-emerald-400">Result</div>
                <div className="whitespace-pre-wrap text-sm text-emerald-100">{selected.result}</div>
              </section>
            )}

            {selected.error && (
              <section className="rounded-2xl border border-rose-900/60 bg-rose-950/10 p-5">
                <div className="mb-2 text-[10px] uppercase tracking-[0.2em] text-rose-400">Error</div>
                <div className="whitespace-pre-wrap text-sm text-rose-100">{selected.error}</div>
              </section>
            )}

            <section className="rounded-2xl border border-border bg-bg-panel p-5">
              <div className="mb-3 text-[10px] uppercase tracking-[0.2em] text-gray-500">Raw Request</div>
              <JsonTree data={selected} defaultOpen />
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
