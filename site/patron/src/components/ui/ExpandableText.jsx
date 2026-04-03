import { useState, useEffect } from 'react';
import { TRUNCATE_TEXT } from '../../lib/config.js';
import { marked, looksLikeCode, looksLikeMarkdown, tryParseJSON } from '../../lib/format.js';
import { HighlightedCode, JsonView } from './JsonView.jsx';

export { HighlightedCode };

export function ExpandableText({ text, limit = TRUNCATE_TEXT, color = 'text-gray-300' }) {
  const [expanded, setExpanded] = useState(false);
  const parsedJSON = tryParseJSON(text);
  const isJSON = parsedJSON !== null;
  const isCode = !isJSON && looksLikeCode(text);
  const isMd = !isJSON && !isCode && looksLikeMarkdown(text);
  const defaultMode = isJSON ? 'json' : isCode ? 'code' : isMd ? 'rendered' : 'raw';
  const [mode, setMode] = useState(defaultMode);
  useEffect(() => { setMode(defaultMode); }, [defaultMode]);
  const displayText = expanded || text.length <= limit ? text : text.slice(0, limit) + '\u2026';

  const hasToggle = isCode || isMd || isJSON;
  const nextMode = mode === 'raw' ? defaultMode : 'raw';
  const nextLabel = nextMode === 'raw' ? 'raw' : isJSON ? 'formatted' : isCode ? 'highlighted' : 'rendered';

  return (
    <div>
      {hasToggle && (
        <div className="flex justify-end mb-1">
          <button
            onClick={(e) => { e.stopPropagation(); setMode(nextMode); }}
            className="text-[10px] text-gray-500 hover:text-accent border border-gray-700 rounded px-1.5 py-0.5"
          >{nextLabel}</button>
        </div>
      )}
      {mode === 'json' ? (
        <JsonView data={parsedJSON} />
      ) : mode === 'code' ? (
        <HighlightedCode code={displayText} />
      ) : mode === 'rendered' ? (
        <div
          className="md-prose text-xs"
          dangerouslySetInnerHTML={{ __html: marked.parse(displayText) }}
        />
      ) : (
        <pre className={`${color} whitespace-pre-wrap break-words leading-relaxed`}>{displayText}</pre>
      )}
      {!isJSON && text.length > limit && (
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
          className="text-accent/70 hover:text-accent text-[10px] underline mt-1"
        >{expanded ? 'show less' : 'show more'}</button>
      )}
    </div>
  );
}
