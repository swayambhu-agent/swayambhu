import { useState, useEffect, useCallback, useMemo } from 'react';
import { api } from '../lib/api.js';
import { JsonTree } from './ui/JsonView.jsx';
import { LoadError } from './ui/LoadError.jsx';

export default function MutationsTab({ patronKey }) {
  const [staged, setStaged] = useState([]);
  const [deploys, setDeploys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [detail, setDetail] = useState(null);

  const load = useCallback(() => {
    setLoading(true); setError(null);
    Promise.all([
      api('/kv?prefix=code_staging:', patronKey),
      api('/kv?prefix=deploy:version:', patronKey),
    ]).then(([s, d]) => {
      setStaged((s.keys || []).sort((a, b) => b.key.localeCompare(a.key)));
      setDeploys((d.keys || []).sort((a, b) => b.key.localeCompare(a.key)));
      setLoading(false);
    }).catch(e => { setError(e.message); setLoading(false); });
  }, [patronKey]);

  useEffect(() => { load(); }, [load]);

  const loadDetail = async (key) => {
    if (expandedId === key) { setExpandedId(null); return; }
    setExpandedId(key);
    try {
      const d = await api(`/kv/${encodeURIComponent(key)}`, patronKey);
      setDetail(d.value || d);
    } catch { setDetail('(error)'); }
  };

  if (loading) return <p className="text-gray-500 text-sm p-4">Loading code staging...</p>;
  if (error) return <LoadError error={error} onRetry={load} />;

  return (
    <div className="h-full overflow-y-auto scrollbar-thin p-4">
      {/* Staged code changes */}
      <h3 className="text-xs font-bold text-yellow-400 mb-2">
        Staged ({staged.length})
      </h3>
      {staged.length === 0 && <p className="text-gray-600 text-xs mb-4">No pending code changes</p>}
      {staged.map(s => (
        <div key={s.key} className="mb-2">
          <button
            onClick={() => loadDetail(s.key)}
            className={`w-full text-left px-3 py-2 rounded border text-xs transition ${
              expandedId === s.key
                ? 'bg-yellow-900/20 border-yellow-700 text-yellow-300'
                : 'bg-bg-card border-border text-gray-400 hover:border-yellow-700'
            }`}
          >
            <span className="inline-block w-2 h-2 rounded-full bg-yellow-500 mr-2"></span>
            {s.key.replace('code_staging:', '')}
          </button>
          {expandedId === s.key && detail && (
            <div className="mt-1 ml-4 p-2 border border-border rounded bg-bg text-xs">
              <JsonTree data={detail} defaultOpen={true} />
            </div>
          )}
        </div>
      ))}

      {/* Deploy history */}
      <h3 className="text-xs font-bold text-green-400 mt-6 mb-2">
        Deploy History ({deploys.length})
      </h3>
      {deploys.length === 0 && <p className="text-gray-600 text-xs">No deployments yet</p>}
      {deploys.map(d => (
        <div key={d.key} className="mb-2">
          <button
            onClick={() => loadDetail(d.key)}
            className={`w-full text-left px-3 py-2 rounded border text-xs transition ${
              expandedId === d.key
                ? 'bg-green-900/20 border-green-700 text-green-300'
                : 'bg-bg-card border-border text-gray-400 hover:border-green-700'
            }`}
          >
            <span className="inline-block w-2 h-2 rounded-full bg-green-500 mr-2"></span>
            {d.key.replace('deploy:version:', '')}
            {d.metadata?.deployed_at && (
              <span className="text-gray-500 ml-2">
                {new Date(d.metadata.deployed_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </button>
          {expandedId === d.key && detail && (
            <div className="mt-1 ml-4 p-2 border border-border rounded bg-bg text-xs">
              <JsonTree data={detail} defaultOpen={false} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
