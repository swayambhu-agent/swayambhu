import { useState, useMemo, useRef, useEffect } from 'react';
import { TRUNCATE_JSON } from '../../lib/config.js';
import { looksLikeCode, looksLikeMarkdown, marked, hljs } from '../../lib/format.js';

export function HighlightedCode({ code }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) {
      ref.current.textContent = code;
      hljs.highlightElement(ref.current);
    }
  }, [code]);
  return (
    <pre className="rounded text-xs overflow-x-auto"><code ref={ref} className="javascript">{code}</code></pre>
  );
}

export function ExpandableString({ text, limit = TRUNCATE_JSON }) {
  const [expanded, setExpanded] = useState(false);
  const isCode = looksLikeCode(text);
  const isMd = !isCode && looksLikeMarkdown(text);
  const hasToggle = isCode || isMd;
  const [mode, setMode] = useState(isCode ? 'code' : 'raw');
  const displayText = expanded || text.length <= limit ? text : text.slice(0, limit) + '\u2026';

  if (text.length <= limit && !hasToggle) {
    return <span className="text-green-400 [overflow-wrap:anywhere] whitespace-pre-wrap leading-relaxed">"{text}"</span>;
  }

  const nextMode = mode === 'raw' ? (isCode ? 'code' : 'rendered') : 'raw';
  const nextLabel = nextMode === 'raw' ? 'raw' : isCode ? 'highlighted' : 'rendered';

  return (
    <div className="inline">
      {hasToggle && (
        <button
          onClick={(e) => { e.stopPropagation(); setMode(nextMode); }}
          className="text-[10px] text-gray-500 hover:text-accent border border-gray-700 rounded px-1.5 py-0.5 mr-1 mb-1"
        >{nextLabel}</button>
      )}
      {mode === 'code' ? (
        <HighlightedCode code={displayText} />
      ) : mode === 'rendered' ? (
        <div
          className="md-prose text-xs"
          dangerouslySetInnerHTML={{ __html: marked.parse(displayText) }}
        />
      ) : (
        <span className="text-green-400 [overflow-wrap:anywhere] whitespace-pre-wrap leading-relaxed">
          "{displayText}"
        </span>
      )}
      {text.length > limit && (
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
          className="ml-1 text-accent/70 hover:text-accent text-[10px] underline"
        >{expanded ? 'less' : 'more'}</button>
      )}
    </div>
  );
}

export function JsonView({ data, depth = 0 }) {
  if (data === null || data === undefined) return <span className="text-gray-500">null</span>;
  if (typeof data === 'string') {
    if (data.length > TRUNCATE_JSON) return <ExpandableString text={data} />;
    return <span className="text-green-400 [overflow-wrap:anywhere] whitespace-pre-wrap leading-relaxed">"{data}"</span>;
  }
  if (typeof data === 'number') return <span className="text-amber-400">{data}</span>;
  if (typeof data === 'boolean') return <span className="text-purple-400">{String(data)}</span>;
  if (Array.isArray(data)) {
    if (data.length === 0) return <span className="text-gray-500">[]</span>;
    return (
      <div className="ml-4">
        <span className="text-gray-500">[</span>
        {data.map((item, i) => (
          <div key={i} className="ml-2">
            <JsonView data={item} depth={depth + 1} />
            {i < data.length - 1 && <span className="text-gray-600">,</span>}
          </div>
        ))}
        <span className="text-gray-500">]</span>
      </div>
    );
  }
  if (typeof data === 'object') {
    const entries = Object.entries(data);
    if (entries.length === 0) return <span className="text-gray-500">{'{}'}</span>;
    return (
      <div className="ml-4">
        <span className="text-gray-500">{'{'}</span>
        {entries.map(([k, v], i) => (
          <div key={k} className="ml-2">
            <span className="text-cyan-400">"{k}"</span>
            <span className="text-gray-500">: </span>
            <JsonView data={v} depth={depth + 1} />
            {i < entries.length - 1 && <span className="text-gray-600">,</span>}
          </div>
        ))}
        <span className="text-gray-500">{'}'}</span>
      </div>
    );
  }
  return <span>{String(data)}</span>;
}

export function JsonTreeString({ text }) {
  const [expanded, setExpanded] = useState(false);

  // Detect JSON strings and offer to render as a tree
  const parsed = useMemo(() => {
    if (text.length < 2) return null;
    const c = text[0];
    if (c !== '{' && c !== '[') return null;
    try { return JSON.parse(text); } catch { return null; }
  }, [text]);

  if (parsed) {
    return <JsonTree data={parsed} />;
  }

  const long = text.length > 120;
  const display = long && !expanded ? text.slice(0, 120) + '...' : text;
  return (
    <>
      <span className="text-green-400 [overflow-wrap:anywhere] whitespace-pre-wrap">"{display}"</span>
      {long && (
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
          className="text-accent/70 hover:text-accent text-[10px] underline ml-1"
        >{expanded ? 'less' : `(${text.length} chars)`}</button>
      )}
    </>
  );
}

// Collapsible JSON tree -- nodes start collapsed, click to expand
export function JsonTree({ data, label, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);

  if (data === null || data === undefined) {
    return <span className="text-gray-500">{label ? <><span className="text-cyan-400">"{label}"</span><span className="text-gray-500">: </span></> : null}null</span>;
  }
  const labelEl = label != null
    ? <><span className={typeof label === 'number' ? "text-gray-400" : "text-cyan-400"}>{typeof label === 'number' ? label : `"${label}"`}</span><span className="text-gray-500">: </span></>
    : null;

  if (typeof data === 'string') {
    return (
      <div className="leading-relaxed">
        {labelEl}
        <JsonTreeString text={data} />
      </div>
    );
  }
  if (typeof data === 'number') {
    return <div>{labelEl}<span className="text-amber-400">{data}</span></div>;
  }
  if (typeof data === 'boolean') {
    return <div>{labelEl}<span className="text-purple-400">{String(data)}</span></div>;
  }

  const isArray = Array.isArray(data);
  const entries = isArray ? data.map((v, i) => [i, v]) : Object.entries(data);
  const isEmpty = entries.length === 0;
  const preview = isArray ? `[${entries.length}]` : `{${entries.length}}`;

  if (isEmpty) {
    return (
      <div>
        {label && <><span className="text-cyan-400">"{label}"</span><span className="text-gray-500">: </span></>}
        <span className="text-gray-500">{isArray ? '[]' : '{}'}</span>
      </div>
    );
  }

  return (
    <div>
      <div
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        className="cursor-pointer hover:bg-white/5 rounded px-1 -mx-1 select-none"
      >
        <span className="text-gray-500 inline-block w-3 text-center">{open ? '\u25BE' : '\u25B8'}</span>
        {label != null && <><span className={isArray && typeof label === 'number' ? "text-gray-400" : "text-cyan-400"}>{typeof label === 'number' ? label : `"${label}"`}</span><span className="text-gray-500">: </span></>}
        <span className="text-gray-500">{preview}</span>
      </div>
      {open && (
        <div className="ml-4 border-l border-gray-800 pl-2">
          {entries.map(([k, v]) => (
            <JsonTree key={k} data={v} label={k} defaultOpen={entries.length === 1} />
          ))}
        </div>
      )}
    </div>
  );
}
