# Dashboard SPA Modularization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the 2300-line single-file dashboard SPA into modular component files with esbuild bundling and compiled Tailwind CSS, zero CDN dependencies.

**Architecture:** Extract components and utilities from `site/patron/index.html` into `site/patron/src/` with proper imports/exports. esbuild bundles to `app.js`, Tailwind compiles to `app.css`. The HTML shell becomes ~30 lines loading those two files plus `config.js`.

**Tech Stack:** React 18 (npm), esbuild, Tailwind CSS (@tailwindcss/cli), marked, highlight.js (core + json/js/bash).

---

### Task 1: Install dependencies and set up build tooling

**Files:**
- Modify: `package.json`
- Create: `tailwind.config.js`
- Create: `site/patron/src/input.css`
- Modify: `.gitignore`

- [ ] **Step 1: Install npm dependencies**

```bash
npm install react react-dom marked highlight.js esbuild @tailwindcss/cli
```

- [ ] **Step 2: Add build scripts to package.json**

Add to the `"scripts"` section in `package.json`:

```json
"build:dashboard": "esbuild site/patron/src/main.jsx --bundle --outfile=site/patron/app.js --sourcemap --jsx=automatic --format=esm --target=es2020 && npx @tailwindcss/cli -i site/patron/src/input.css -o site/patron/app.css --minify",
"watch:dashboard": "esbuild site/patron/src/main.jsx --bundle --outfile=site/patron/app.js --sourcemap --jsx=automatic --format=esm --target=es2020 --watch"
```

- [ ] **Step 3: Create tailwind.config.js at repo root**

```js
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./site/patron/src/**/*.{jsx,js}'],
  theme: {
    extend: {
      colors: {
        bg: '#0a0a0f',
        'bg-panel': '#0f0f18',
        'bg-card': '#14142a',
        border: '#1e1e3a',
        accent: '#f59e0b',
        'accent-dim': 'rgba(245, 158, 11, 0.12)',
        deep: '#a78bfa',
        'deep-dim': 'rgba(167, 139, 250, 0.15)',
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
```

- [ ] **Step 4: Create site/patron/src/input.css**

```css
@import "tailwindcss";

/* Custom scrollbar */
.scrollbar-thin::-webkit-scrollbar { width: 6px; }
.scrollbar-thin::-webkit-scrollbar-track { background: transparent; }
.scrollbar-thin::-webkit-scrollbar-thumb { background: #1e1e3a; border-radius: 3px; }

/* Animations */
@keyframes pulse-dot { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
.pulse-dot { animation: pulse-dot 1.5s ease-in-out infinite; }
@keyframes fade-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
.fade-in { animation: fade-in 0.3s ease-out; }

/* Markdown prose */
.md-prose { color: #d1d5db; line-height: 1.7; }
.md-prose h1, .md-prose h2, .md-prose h3 { color: #f59e0b; font-weight: 700; margin: 0.75em 0 0.25em; }
.md-prose h1 { font-size: 1.1em; } .md-prose h2 { font-size: 1em; } .md-prose h3 { font-size: 0.95em; }
.md-prose p { margin: 0.4em 0; }
.md-prose ul, .md-prose ol { margin: 0.4em 0; padding-left: 1.5em; }
.md-prose li { margin: 0.2em 0; }
.md-prose code { background: #1e1e3a; padding: 0.1em 0.3em; border-radius: 3px; font-size: 0.9em; color: #a5b4fc; }
.md-prose pre { background: #0a0a0f; padding: 0.5em; border-radius: 4px; overflow-x: auto; margin: 0.4em 0; }
.md-prose pre code { background: none; padding: 0; }
.md-prose strong { color: #e5e7eb; }
.md-prose em { color: #9ca3af; }
.md-prose a { color: #60a5fa; text-decoration: underline; }
.md-prose blockquote { border-left: 2px solid #1e1e3a; padding-left: 0.75em; color: #9ca3af; margin: 0.4em 0; }

/* Divider */
.divider-dragging { cursor: col-resize !important; user-select: none !important; }
```

- [ ] **Step 5: Add build output to .gitignore**

Append to `.gitignore`:

```
# Dashboard build output
site/patron/app.js
site/patron/app.js.map
site/patron/app.css
```

- [ ] **Step 6: Commit**

```bash
git add package.json tailwind.config.js site/patron/src/input.css .gitignore
git commit -m "chore: add dashboard build tooling (esbuild + tailwind)"
```

Note: Don't run `npm install` yet if it would modify package-lock.json — just add the deps. The actual build will be tested in a later task.

---

### Task 2: Extract shared utilities (lib/)

**Files:**
- Create: `site/patron/src/lib/config.js`
- Create: `site/patron/src/lib/api.js`
- Create: `site/patron/src/lib/format.js`
- Create: `site/patron/src/lib/colors.js`

These are the shared utilities that multiple components import. Extract them verbatim from `index.html` lines 66-185.

- [ ] **Step 1: Create site/patron/src/lib/config.js**

Extract lines 66-78 from index.html. This reads `window.DASHBOARD_CONFIG`:

```js
// Dashboard config — reads patron-editable config.js loaded before app.js
const CFG = window.DASHBOARD_CONFIG || {};

export const TIMEZONE = CFG.timezone || undefined;
export const LOCALE = CFG.locale || undefined;
export const TRUNCATE_JSON = CFG.truncate?.jsonString || 800;
export const TRUNCATE_TEXT = CFG.truncate?.textBlock || 800;

const HB = CFG.heartbeat || {};
export const HB_NORMAL = HB.normalMs || 5000;
export const HB_ACTIVE = HB.activeMs || 2000;
export const HB_HIDDEN = HB.hiddenMs || 15000;
export const HB_SAFETY = HB.safetyMs || 60000;
```

- [ ] **Step 2: Create site/patron/src/lib/format.js**

Extract lines 80-109 from index.html. The `marked` and `hljs` setup plus formatters:

```js
import { marked } from 'marked';
import hljs from 'highlight.js/lib/core';
import json from 'highlight.js/lib/languages/json';
import javascript from 'highlight.js/lib/languages/javascript';
import bash from 'highlight.js/lib/languages/bash';
import { TIMEZONE, LOCALE } from './config.js';

// Register only the languages the dashboard uses
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

export { marked, hljs };

export function looksLikeCode(text) {
  return /^\s*(import |export |const |let |var |function |async |class |\/\/|\/\*|module\.)/.test(text);
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

export function looksLikeMarkdown(text) {
  return /^#{1,3}\s|^\*\*|^\-\s|^\d+\.\s|\[.*\]\(.*\)|```/.test(text);
}

export function tryParseJSON(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try { return JSON.parse(t); } catch { return null; }
  }
  return null;
}
```

- [ ] **Step 3: Create site/patron/src/lib/api.js**

Extract lines 111-156 from index.html:

```js
export const API_URL = (location.hostname === 'localhost' || location.protocol === 'file:')
  ? 'http://localhost:8790'
  : 'https://swayambhu-dashboard-api.swayambhu1.workers.dev';

export const kvReadCount = { current: 0 };

export async function api(path, key, timeoutMs = 8000) {
  kvReadCount.current++;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_URL}${path}`, {
      headers: { 'X-Patron-Key': key },
      signal: ctrl.signal,
    });
    if (res.status === 401) throw new Error('UNAUTHORIZED');
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('TIMEOUT');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const stableCache = {};
const STABLE_PREFIXES = ['dharma', 'wisdom', 'prompt:', 'tool:', 'provider:'];

export async function cachedApi(path, key) {
  const cacheKey = path;
  if (stableCache[cacheKey]) return stableCache[cacheKey];
  const data = await api(path, key);
  if (STABLE_PREFIXES.some(p => path.includes(p))) {
    stableCache[cacheKey] = data;
  }
  return data;
}

export async function apiMulti(keys, patronKey) {
  if (!keys.length) return {};
  const encoded = keys.map(k => encodeURIComponent(k)).join(',');
  return api(`/kv/multi?keys=${encoded}`, patronKey);
}
```

- [ ] **Step 4: Create site/patron/src/lib/colors.js**

Extract lines 158-185 from index.html:

```js
export const EVENT_COLORS = {
  act_start: { bg: 'bg-green-900/30', border: 'border-green-700', text: 'text-green-400', dot: 'bg-green-500' },
  act_complete: { bg: 'bg-green-900/20', border: 'border-green-800', text: 'text-green-500', dot: 'bg-green-600' },
  llm_call: { bg: 'bg-blue-900/30', border: 'border-blue-700', text: 'text-blue-400', dot: 'bg-blue-500' },
  llm_response: { bg: 'bg-blue-900/20', border: 'border-blue-800', text: 'text-blue-400', dot: 'bg-blue-400' },
  tool_call: { bg: 'bg-purple-900/30', border: 'border-purple-700', text: 'text-purple-400', dot: 'bg-purple-500' },
  tool_result: { bg: 'bg-purple-900/20', border: 'border-purple-800', text: 'text-purple-400', dot: 'bg-purple-400' },
  fallback: { bg: 'bg-orange-900/30', border: 'border-orange-700', text: 'text-orange-400', dot: 'bg-orange-500' },
  fatal: { bg: 'bg-red-900/30', border: 'border-red-700', text: 'text-red-400', dot: 'bg-red-500' },
  error: { bg: 'bg-red-900/20', border: 'border-red-800', text: 'text-red-400', dot: 'bg-red-400' },
  mutation: { bg: 'bg-yellow-900/30', border: 'border-yellow-700', text: 'text-yellow-400', dot: 'bg-yellow-500' },
  kv_operations_requested: { bg: 'bg-yellow-900/20', border: 'border-yellow-800', text: 'text-yellow-400', dot: 'bg-yellow-400' },
  reflect: { bg: 'bg-teal-900/30', border: 'border-teal-700', text: 'text-teal-400', dot: 'bg-teal-500' },
  act: { bg: 'bg-cyan-900/30', border: 'border-cyan-700', text: 'text-cyan-400', dot: 'bg-cyan-500' },
  subplan: { bg: 'bg-indigo-900/30', border: 'border-indigo-700', text: 'text-indigo-400', dot: 'bg-indigo-500' },
  dr_dispatched: { bg: 'bg-teal-900/30', border: 'border-teal-700', text: 'text-teal-400', dot: 'bg-teal-500' },
  dr_failed: { bg: 'bg-red-900/30', border: 'border-red-700', text: 'text-red-400', dot: 'bg-red-500' },
  dr_expired: { bg: 'bg-orange-900/30', border: 'border-orange-700', text: 'text-orange-400', dot: 'bg-orange-500' },
  dr_applied: { bg: 'bg-teal-900/30', border: 'border-teal-700', text: 'text-teal-400', dot: 'bg-teal-500' },
  dr_dispatch_failed: { bg: 'bg-red-900/20', border: 'border-red-800', text: 'text-red-400', dot: 'bg-red-400' },
  dr_apply_blocked: { bg: 'bg-yellow-900/30', border: 'border-yellow-700', text: 'text-yellow-400', dot: 'bg-yellow-500' },
  dr_cycle_error: { bg: 'bg-red-900/30', border: 'border-red-700', text: 'text-red-400', dot: 'bg-red-500' },
};

export function eventColor(type) {
  return EVENT_COLORS[type] || { bg: 'bg-gray-900/30', border: 'border-gray-700', text: 'text-gray-400', dot: 'bg-gray-500' };
}
```

- [ ] **Step 5: Commit**

```bash
git add site/patron/src/lib/
git commit -m "feat: extract shared dashboard utilities to src/lib/"
```

---

### Task 3: Extract UI primitive components

**Files:**
- Create: `site/patron/src/components/ui/JsonView.jsx`
- Create: `site/patron/src/components/ui/ExpandableText.jsx`
- Create: `site/patron/src/components/ui/LoadError.jsx`

These are small reusable components used by multiple tabs. Extract them verbatim from index.html, adding imports.

- [ ] **Step 1: Create JsonView.jsx**

Extract `ExpandableString` (lines 188-231), `JsonView` (233-275), `JsonTreeString` (277-305), `JsonTree` (308-366) from index.html. These are tightly coupled — they reference each other.

Read the exact JSX from those line ranges in `site/patron/index.html` and write the file. The file should:
- Import `{ useState }` from `'react'`
- Import `{ TRUNCATE_JSON }` from `'../lib/config.js'`
- Import `{ looksLikeCode, marked, hljs }` from `'../lib/format.js'`
- Export all four functions

- [ ] **Step 2: Create ExpandableText.jsx**

Extract `HighlightedCode` (lines 659-670), `looksLikeMarkdown` helper (line 655), `tryParseJSON` (672-677), `ExpandableText` (680-725) from index.html.

The file should:
- Import `{ useState, useRef, useEffect }` from `'react'`
- Import `{ TRUNCATE_TEXT }` from `'../lib/config.js'`
- Import `{ marked, hljs, looksLikeCode, looksLikeMarkdown, tryParseJSON }` from `'../lib/format.js'`
- Import `{ JsonTree }` from `'./JsonView.jsx'`
- Export `HighlightedCode` and `ExpandableText`

Note: `looksLikeMarkdown` and `tryParseJSON` are already in `lib/format.js` (Task 2), so just import them — don't redefine.

- [ ] **Step 3: Create LoadError.jsx**

Extract `LoadError` (lines 773-785) from index.html:

```jsx
export function LoadError({ error, onRetry }) {
  return (
    <div className="p-8 text-center">
      <p className="text-red-400 text-sm mb-2">{error}</p>
      {onRetry && (
        <button onClick={onRetry} className="text-accent text-xs hover:underline">
          Retry
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add site/patron/src/components/ui/
git commit -m "feat: extract UI primitives (JsonView, ExpandableText, LoadError)"
```

---

### Task 4: Extract tab components (part 1 — Timeline, KV Explorer, Reflections)

**Files:**
- Create: `site/patron/src/components/TimelineTab.jsx`
- Create: `site/patron/src/components/KVExplorerTab.jsx`
- Create: `site/patron/src/components/ReflectionsTab.jsx`

Each tab component is self-contained — manages its own state, calls `api()` directly.

- [ ] **Step 1: Create TimelineTab.jsx**

Extract `TimelineTab` (lines 414-652), `ContextPanel` (728-770), `DraggableDivider` (1549-1569) from index.html. These are tightly coupled (ContextPanel and DraggableDivider only appear inside TimelineTab's layout).

Read the exact JSX from those line ranges. The file should:
- Import React hooks from `'react'`
- Import `{ api }` from `'../lib/api.js'`
- Import `{ formatTime, formatDateTime }` from `'../lib/format.js'`
- Import `{ eventColor }` from `'../lib/colors.js'`
- Import `{ HB_SAFETY }` from `'../lib/config.js'`
- Import `{ JsonTree }` from `'./ui/JsonView.jsx'`
- Import `{ ExpandableText }` from `'./ui/ExpandableText.jsx'`
- Export `TimelineTab` as default

ContextPanel and DraggableDivider are NOT exported — they live in the same file.

- [ ] **Step 2: Create KVExplorerTab.jsx**

Extract `KVExplorerTab` (lines 788-890) from index.html.

The file should:
- Import React hooks from `'react'`
- Import `{ api }` from `'../lib/api.js'`
- Import `{ JsonTree }` from `'./ui/JsonView.jsx'`
- Import `{ LoadError }` from `'./ui/LoadError.jsx'`
- Export `KVExplorerTab` as default

- [ ] **Step 3: Create ReflectionsTab.jsx**

Extract `ReflectionsTab` (lines 893-1082) from index.html.

The file should:
- Import React hooks from `'react'`
- Import `{ api }` from `'../lib/api.js'`
- Import `{ formatDateTime }` from `'../lib/format.js'`
- Import `{ ExpandableText }` from `'./ui/ExpandableText.jsx'`
- Import `{ JsonTree }` from `'./ui/JsonView.jsx'`
- Import `{ LoadError }` from `'./ui/LoadError.jsx'`
- Export `ReflectionsTab` as default

- [ ] **Step 4: Commit**

```bash
git add site/patron/src/components/TimelineTab.jsx site/patron/src/components/KVExplorerTab.jsx site/patron/src/components/ReflectionsTab.jsx
git commit -m "feat: extract TimelineTab, KVExplorerTab, ReflectionsTab"
```

---

### Task 5: Extract tab components (part 2 — Mutations, Contacts, Chat, Mind)

**Files:**
- Create: `site/patron/src/components/MutationsTab.jsx`
- Create: `site/patron/src/components/ContactsTab.jsx`
- Create: `site/patron/src/components/ChatTab.jsx`
- Create: `site/patron/src/components/MindTab.jsx`

- [ ] **Step 1: Create MutationsTab.jsx**

Extract `MutationsTab` (lines 1085-1188) from index.html.

The file should:
- Import React hooks from `'react'`
- Import `{ api }` from `'../lib/api.js'`
- Import `{ formatDateTime }` from `'../lib/format.js'`
- Import `{ JsonTree }` from `'./ui/JsonView.jsx'`
- Import `{ LoadError }` from `'./ui/LoadError.jsx'`
- Export `MutationsTab` as default

- [ ] **Step 2: Create ContactsTab.jsx**

Extract `ContactsTab` (lines 1191-1355) from index.html.

The file should:
- Import React hooks from `'react'`
- Import `{ api }` from `'../lib/api.js'`
- Import `{ LoadError }` from `'./ui/LoadError.jsx'`
- Export `ContactsTab` as default

- [ ] **Step 3: Create ChatTab.jsx**

Extract `ChatTab` (lines 1358-1546) from index.html. Note: ChatTab has its own local `formatTime` and `formatDate` — keep those as local functions inside the file.

The file should:
- Import React hooks from `'react'`
- Import `{ api }` from `'../lib/api.js'`
- Import `{ TIMEZONE, LOCALE, HB_SAFETY }` from `'../lib/config.js'`
- Import `{ marked }` from `'../lib/format.js'`
- Import `{ LoadError }` from `'./ui/LoadError.jsx'`
- Export `ChatTab` as default

- [ ] **Step 4: Create MindTab.jsx**

Extract `MindTab` (lines 1680-1726), `MindHealthBar` (1728-1774), `MindGraphExplorer` (1776-2047) from index.html. These three are tightly coupled.

The file should:
- Import React hooks from `'react'`
- Import `{ api }` from `'../lib/api.js'`
- Import `{ formatDateTime }` from `'../lib/format.js'`
- Import `{ ExpandableText }` from `'./ui/ExpandableText.jsx'`
- Import `{ LoadError }` from `'./ui/LoadError.jsx'`
- Export `MindTab` as default

MindHealthBar and MindGraphExplorer are NOT exported — internal to the file.

- [ ] **Step 5: Commit**

```bash
git add site/patron/src/components/MutationsTab.jsx site/patron/src/components/ContactsTab.jsx site/patron/src/components/ChatTab.jsx site/patron/src/components/MindTab.jsx
git commit -m "feat: extract MutationsTab, ContactsTab, ChatTab, MindTab"
```

---

### Task 6: Extract LoginScreen and DirectMessageBar

**Files:**
- Create: `site/patron/src/components/LoginScreen.jsx`
- Create: `site/patron/src/components/DirectMessageBar.jsx`

- [ ] **Step 1: Create LoginScreen.jsx**

Extract `LoginScreen` (lines 369-411) from index.html.

The file should:
- Import `{ useState }` from `'react'`
- Export `LoginScreen` as default

- [ ] **Step 2: Create DirectMessageBar.jsx**

Extract `DirectMessageBar` (lines 1572-1676) from index.html.

The file should:
- Import React hooks from `'react'`
- Import `{ api }` from `'../lib/api.js'`
- Import `{ HB_SAFETY }` from `'../lib/config.js'`
- Export `DirectMessageBar` as default

- [ ] **Step 3: Commit**

```bash
git add site/patron/src/components/LoginScreen.jsx site/patron/src/components/DirectMessageBar.jsx
git commit -m "feat: extract LoginScreen and DirectMessageBar"
```

---

### Task 7: Create App component and main entry point

**Files:**
- Create: `site/patron/src/app.jsx`
- Create: `site/patron/src/main.jsx`

- [ ] **Step 1: Create app.jsx**

Extract `App` (lines 2050-2333) from index.html. This is the root component with the header, tab bar, heartbeat, and tab switching.

The file should:
- Import React hooks from `'react'`
- Import `{ api }` from `'./lib/api.js'`
- Import `{ HB_NORMAL, HB_HIDDEN, HB_SAFETY }` from `'./lib/config.js'`
- Import `{ formatTime, formatDateTime }` from `'./lib/format.js'`
- Import each tab component from `'./components/...'`
- Import `LoginScreen` from `'./components/LoginScreen.jsx'`
- Import `DirectMessageBar` from `'./components/DirectMessageBar.jsx'`
- Export `App` as default

Read the exact JSX from lines 2050-2333 in index.html. The `App` function includes:
- State: patronKey, health, mindCounts, balances, countdown, activeTab, selectedEntry, leftPct, sessionsRev, chatsRev, reflectionsRev
- Refs: containerRef, lastPulseN, inflightRef
- Functions: loadHealth, loadMindCounts, refreshSessions (stub that child calls), refreshChats (stub)
- Heartbeat useEffect
- Countdown timer useEffect
- JSX: login gate, header bar, tab buttons, DirectMessageBar, tab panels

- [ ] **Step 2: Create main.jsx**

This is the entry point esbuild bundles from:

```jsx
import { createRoot } from 'react-dom/client';
import App from './app.jsx';

const root = createRoot(document.getElementById('root'));
root.render(<App />);
```

- [ ] **Step 3: Commit**

```bash
git add site/patron/src/app.jsx site/patron/src/main.jsx
git commit -m "feat: create App component and main entry point"
```

---

### Task 8: Replace index.html with thin shell and verify build

**Files:**
- Modify: `site/patron/index.html` (replace 2300 lines with ~30)
- Modify: `scripts/start.sh` (add build step)

- [ ] **Step 1: Replace index.html**

Replace the entire contents of `site/patron/index.html` with:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Swayambhu — Patron Dashboard</title>
  <link rel="icon" type="image/png" href="../avatar.png">
  <link rel="stylesheet" href="app.css">
</head>
<body class="bg-bg text-gray-300 font-mono min-h-screen">
  <div id="root"></div>
  <script src="config.js" onerror="/* optional config — defaults used */"></script>
  <script type="module" src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Add build step to start.sh**

In `scripts/start.sh`, before the "Starting dashboard SPA" section (around line 224), add:

```bash
echo "=== Building dashboard ==="
npm run build:dashboard
```

- [ ] **Step 3: Run the build**

```bash
npm run build:dashboard
```

Expected: `site/patron/app.js`, `site/patron/app.js.map`, `site/patron/app.css` are created.

- [ ] **Step 4: Fix import errors**

The build will likely surface import errors (missing exports, wrong paths). Fix them one at a time. Common issues:
- Component references a function that's in a different file now — add the import
- React hooks need explicit import from `'react'` (no longer global)
- `marked` needs import from `'marked'` (no longer global)
- `hljs` needs import from the format.js re-export

- [ ] **Step 5: Verify the dashboard works**

```bash
source .env && bash scripts/start.sh
```

Open `http://localhost:3001/patron/` in a browser. Verify:
- Login works
- Timeline tab loads and shows sessions
- Watch/heartbeat works
- All tabs render without errors
- Console has no errors

- [ ] **Step 6: Commit**

```bash
git add site/patron/index.html scripts/start.sh
git commit -m "feat: replace monolithic index.html with modular build"
```

---

### Task 9: Clean up and final verification

**Files:**
- Verify all files

- [ ] **Step 1: Run the full test suite**

```bash
npm test
```

Expected: All existing tests pass (dashboard has no unit tests — this is visual verification only).

- [ ] **Step 2: Verify build output sizes**

```bash
ls -lh site/patron/app.js site/patron/app.css
wc -l site/patron/src/**/*.jsx site/patron/src/**/*.js site/patron/src/**/*.css
```

Expected: app.js ~200-300KB (includes React + deps), app.css ~10-20KB (compiled Tailwind). Source files should total ~2300 lines (same code, just split across files).

- [ ] **Step 3: Verify no stale references**

```bash
grep -r "text/babel\|cdn.tailwindcss\|unpkg.com/react\|babel.min.js\|googleapis.com/css" site/patron/
```

Expected: No matches. All CDN references should be gone.

- [ ] **Step 4: Commit final state**

```bash
git add -A site/patron/src/
git commit -m "chore: dashboard SPA modularization complete"
git push
```
