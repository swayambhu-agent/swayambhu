import { useState, useEffect, useCallback, useMemo } from 'react';
import { api } from '../lib/api.js';
import { JsonView } from './ui/JsonView.jsx';
import { LoadError } from './ui/LoadError.jsx';

export default function MutationsTab({ patronKey }) {
  const [staged, setStaged] = useState([]);
  const [inflight, setInflight] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [filter, setFilter] = useState('all');

  const loadMutations = useCallback(() => {
    setLoading(true); setError(null);
    Promise.all([
      api('/kv?prefix=mutation_staged:', patronKey),
      api('/kv?prefix=mutation_rollback:', patronKey),
    ]).then(([s, c]) => {
      setStaged((s.keys || []).map(k => ({ ...k, status: 'staged' })));
      setInflight((c.keys || []).map(k => ({ ...k, status: 'inflight' })));
      setLoading(false);
    }).catch(e => { setError(e.message); setLoading(false); });
  }, [patronKey]);

  useEffect(() => { loadMutations(); }, [loadMutations]);

  const all = useMemo(() => {
    return [...staged, ...inflight].sort((a, b) => {
      // Extract mutation ID for sorting
      return b.key.localeCompare(a.key);
    });
  }, [staged, inflight]);

  const filtered = filter === 'all' ? all : all.filter(m => m.status === filter);

  const loadDetail = async (key) => {
    if (expandedId === key) { setExpandedId(null); return; }
    setExpandedId(key);
    try {
      const d = await api(`/kv/${encodeURIComponent(key)}`, patronKey);
      setDetail(d.value);
    } catch { setDetail('(error)'); }
  };

  const STATUS_COLORS = {
    staged: { bar: 'bg-yellow-500', text: 'text-yellow-400', label: 'Staged' },
    inflight: { bar: 'bg-blue-500', text: 'text-blue-400', label: 'Inflight' },
    promoted: { bar: 'bg-green-500', text: 'text-green-400', label: 'Promoted' },
    rolled_back: { bar: 'bg-red-500', text: 'text-red-400', label: 'Rolled Back' },
  };

  if (loading) return <p className="text-gray-500 text-sm">Loading proposals...</p>;
  if (error) return <LoadError error={error} onRetry={loadMutations} />;

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="flex gap-2 mb-4">
        {['all', 'staged', 'inflight'].map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1 rounded text-xs border transition ${
              filter === f
                ? 'border-accent text-accent bg-accent/10'
                : 'border-border text-gray-500 hover:text-gray-300'
            }`}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
            <span className="ml-1 text-gray-600">
              ({f === 'all' ? all.length : f === 'staged' ? staged.length : inflight.length})
            </span>
          </button>
        ))}
      </div>

      <div className="space-y-2">
        {filtered.length === 0 && <p className="text-gray-500 text-xs">No proposals found</p>}
        {filtered.map(m => {
          const sc = STATUS_COLORS[m.status] || STATUS_COLORS.staged;
          return (
            <div key={m.key}>
              <button
                onClick={() => loadDetail(m.key)}
                className={`w-full text-left px-3 py-2 rounded border transition ${
                  expandedId === m.key
                    ? 'border-accent bg-accent/5'
                    : 'border-border hover:border-gray-600 bg-bg-card'
                }`}
              >
                <div className="flex items-center gap-2">
                  <div className={`w-1.5 h-6 rounded-full ${sc.bar}`}></div>
                  <span className="text-xs text-gray-300 flex-1 truncate">{m.key}</span>
                  <span className={`text-xs ${sc.text}`}>{sc.label}</span>
                </div>
              </button>
              {expandedId === m.key && detail && (
                <div className="ml-6 mt-1 mb-2 bg-bg rounded p-3 text-xs max-h-80 overflow-y-auto scrollbar-thin fade-in">
                  <JsonView data={detail} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
