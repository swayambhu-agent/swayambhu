import { useState, useEffect, useCallback, useMemo } from 'react';
import { api } from '../lib/api.js';
import { JsonView } from './ui/JsonView.jsx';
import { ExpandableText } from './ui/ExpandableText.jsx';
import { LoadError } from './ui/LoadError.jsx';

function KVExplorerTab({ patronKey }) {
  const [index, setIndex] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedKey, setExpandedKey] = useState(null);
  const [keyValue, setKeyValue] = useState(null);
  const [keyLoading, setKeyLoading] = useState(false);

  const loadIndex = useCallback(() => {
    setLoading(true); setError(null);
    api('/kv', patronKey)
      .then(d => { setIndex(d.keys || []); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [patronKey]);

  useEffect(() => { loadIndex(); }, [loadIndex]);

  // Group by prefix
  const grouped = useMemo(() => {
    const groups = {};
    index.forEach(entry => {
      const key = entry.key;
      const colon = key.indexOf(':');
      const prefix = colon > 0 ? key.slice(0, colon) : '_root';
      if (!groups[prefix]) groups[prefix] = [];
      groups[prefix].push(entry);
    });
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
  }, [index]);

  const [collapsedGroups, setCollapsedGroups] = useState(new Set());

  const toggleGroup = (prefix) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      next.has(prefix) ? next.delete(prefix) : next.add(prefix);
      return next;
    });
  };

  const fetchKey = async (key) => {
    if (expandedKey === key) { setExpandedKey(null); return; }
    setExpandedKey(key);
    setKeyLoading(true);
    try {
      const d = await api(`/kv/${encodeURIComponent(key)}`, patronKey);
      setKeyValue(d.value);
    } catch { setKeyValue('(error fetching)'); }
    setKeyLoading(false);
  };

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      {loading && <p className="text-gray-500 text-sm">Loading index...</p>}
      {error && <LoadError error={error} onRetry={loadIndex} />}
      <div className="flex items-center gap-3 mb-3">
        <span className="text-xs text-gray-500">{index.length} keys total</span>
        <button onClick={loadIndex} className="text-gray-600 hover:text-gray-400 text-xs">refresh</button>
      </div>
      {grouped.map(([prefix, entries]) => (
        <div key={prefix} className="mb-2">
          <button
            onClick={() => toggleGroup(prefix)}
            className="flex items-center gap-2 text-sm font-semibold text-accent hover:text-amber-300 transition w-full text-left py-1"
          >
            <span className="text-gray-500">{collapsedGroups.has(prefix) ? '\u25b8' : '\u25be'}</span>
            {prefix}
            <span className="text-gray-600 text-xs font-normal">({entries.length})</span>
          </button>
          {!collapsedGroups.has(prefix) && (
            <div className="ml-4 space-y-0.5">
              {entries.map(entry => (
                <div key={entry.key}>
                  <button
                    onClick={() => fetchKey(entry.key)}
                    className={`text-xs py-1 px-2 rounded w-full text-left transition ${
                      expandedKey === entry.key
                        ? 'bg-accent/10 text-accent'
                        : 'text-gray-400 hover:text-gray-200 hover:bg-bg-card'
                    }`}
                  >
                    {entry.key}
                  </button>
                  {expandedKey === entry.key && (
                    <div className="ml-2 mt-1 mb-2 bg-bg rounded p-2 text-xs fade-in">
                      {keyLoading ? (
                        <span className="text-gray-500">Loading...</span>
                      ) : typeof keyValue === 'string' ? (
                        <ExpandableText text={keyValue} />
                      ) : (
                        <JsonView data={keyValue} />
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default KVExplorerTab;
