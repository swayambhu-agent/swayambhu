import { marked } from 'marked';
import hljs from 'highlight.js/lib/core';
import json from 'highlight.js/lib/languages/json';
import javascript from 'highlight.js/lib/languages/javascript';
import bash from 'highlight.js/lib/languages/bash';
import { TIMEZONE, LOCALE } from './config.js';

hljs.registerLanguage('json', json);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('bash', bash);

// Configure marked to use highlight.js for code blocks
try {
  const renderer = { code({ text, lang }) {
    let h;
    try {
      h = lang && hljs.getLanguage(lang)
        ? hljs.highlight(text, { language: lang }).value
        : hljs.highlightAuto(text).value;
    } catch { h = text; }
    return '<pre><code class="hljs">' + h + '</code></pre>';
  }};
  if (marked.use) { marked.use({ renderer }); }
  else { marked.setOptions({ renderer }); }
} catch (e) { console.warn('marked config failed:', e); }

export function looksLikeCode(text) {
  return /^\s*(import |export |const |let |var |function |async |class |\/\/|\/\*|module\.)/.test(text);
}

export function looksLikeMarkdown(text) {
  return /^#{1,3}\s|^\s*[-*]\s|\*\*|__|\[.*\]\(|```/m.test(text);
}

export function tryParseJSON(text) {
  const t = text.trim();
  if ((t[0] === '{' && t[t.length - 1] === '}') || (t[0] === '[' && t[t.length - 1] === ']')) {
    try { return JSON.parse(t); } catch {}
  }
  return null;
}

export function formatTime(ts) {
  const opts = { hour: '2-digit', minute: '2-digit', second: '2-digit' };
  if (TIMEZONE) opts.timeZone = TIMEZONE;
  return new Date(ts).toLocaleTimeString(LOCALE, opts);
}

export function formatDateTime(ts) {
  const opts = { dateStyle: 'medium', timeStyle: 'short' };
  if (TIMEZONE) opts.timeZone = TIMEZONE;
  return new Date(ts).toLocaleString(LOCALE, opts);
}

export { marked, hljs };
