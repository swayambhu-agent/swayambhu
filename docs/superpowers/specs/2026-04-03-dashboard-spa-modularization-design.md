# Dashboard SPA Modularization

Split the 2300-line single-file React SPA into modular component files
with esbuild bundling and compiled Tailwind CSS. Zero CDN dependencies
at runtime.

## Problem

All 22 React components, shared utilities, and styles live in one
`site/patron/index.html` file. This makes it hard to navigate, edit,
and reason about individual components. Babel standalone compiles JSX
in the browser at load time. Multiple CDN dependencies (React, Tailwind,
marked, highlight.js, Google Fonts) add external failure points.

## Design

### File structure

```
site/patron/
  index.html          ← thin shell (~30 lines)
  config.js           ← patron-editable config (timezone, heartbeat intervals)
  app.js              ← esbuild output (gitignored)
  app.js.map          ← source map (gitignored)
  app.css             ← tailwind output (gitignored)
  src/
    main.jsx          ← entry: imports App, calls createRoot
    input.css         ← tailwind directives + custom CSS (~30 lines)
    app.jsx           ← App component (header, tabs, heartbeat)
    lib/
      api.js          ← api(), cachedApi(), apiMulti(), API_URL, stableCache
      config.js       ← HB_*, TIMEZONE, LOCALE, TRUNCATE_* (reads window.DASHBOARD_CONFIG)
      format.js       ← formatTime(), formatDateTime(), looksLikeCode(), looksLikeMarkdown()
      colors.js       ← EVENT_COLORS map
    components/
      LoginScreen.jsx
      TimelineTab.jsx       ← includes ContextPanel + DraggableDivider (tightly coupled)
      ReflectionsTab.jsx
      MindTab.jsx           ← includes MindHealthBar + MindGraphExplorer
      ChatTab.jsx
      ContactsTab.jsx
      KVExplorerTab.jsx
      MutationsTab.jsx
      DirectMessageBar.jsx
      ui/
        JsonView.jsx        ← JsonView + JsonTree + JsonTreeString
        ExpandableText.jsx  ← ExpandableString + ExpandableText + HighlightedCode
        LoadError.jsx
```

Small tightly-coupled components stay together in the same file (e.g.,
MindHealthBar + MindGraphExplorer inside MindTab.jsx). Shared UI
primitives go in `components/ui/`.

### Build tooling

**JS build** — esbuild bundles `src/main.jsx` into `app.js`:
```bash
npx esbuild site/patron/src/main.jsx \
  --bundle --outfile=site/patron/app.js \
  --sourcemap --jsx=automatic \
  --format=esm --target=es2020
```

React, react-dom, marked, and highlight.js are npm dependencies. For
highlight.js, import only `hljs/lib/core` plus languages: json,
javascript, bash (the three used in the dashboard for karma entries,
KV values, and code blocks).

**CSS build** — Tailwind compiles to `app.css`:
```bash
npx @tailwindcss/cli -i site/patron/src/input.css -o site/patron/app.css
```

`input.css` contains tailwind directives plus the custom CSS currently
inline in the HTML (scrollbar styles, pulse-dot animation, md-prose class).

**Tailwind config** — `tailwind.config.js` at repo root, with custom
theme colors (bg, bg-panel, bg-card, border, accent, deep, etc.)
currently defined inline in index.html.

**Dev workflow:**
- `build:dashboard` npm script runs both esbuild + tailwind
- esbuild watch mode for dev (~50ms rebuilds)
- `start.sh` runs build before starting dev server
- `app.js`, `app.js.map`, `app.css` are gitignored (generated)

### The HTML shell

`index.html` goes from 2300 lines to ~30:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Swayambhu — Patron Dashboard</title>
  <link rel="stylesheet" href="app.css">
</head>
<body class="bg-bg text-gray-300 font-mono">
  <div id="root"></div>
  <script src="config.js"></script>
  <script type="module" src="app.js"></script>
</body>
</html>
```

`config.js` stays non-bundled — it's the patron-editable config file.
Loaded before app.js so `window.DASHBOARD_CONFIG` is available.

### Fonts

System font stack replaces Google Fonts:
`ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`

Visually close to JetBrains Mono. Zero external requests.

### Dependencies dropped

| Was | Becomes |
|-----|---------|
| React 18 from unpkg CDN | npm dependency, bundled by esbuild |
| Babel standalone from unpkg CDN | Removed — esbuild handles JSX |
| Tailwind from CDN | npm dependency, compiled to app.css |
| marked from jsdelivr CDN | npm dependency, bundled by esbuild |
| highlight.js from jsdelivr CDN | npm dependency (trimmed), bundled |
| Google Fonts (JetBrains Mono) | System monospace font stack |

### What doesn't change

- `config.js` — still a separate file, still patron-editable
- Component behavior — no functional changes, just file boundaries
- API calls — same endpoints, same patterns
- Heartbeat — just-shipped pulse system unchanged
- Dev server (`dev-serve.mjs`) — still serves static files, no-cache

## Files touched

| File | Change |
|------|--------|
| site/patron/index.html | Replace 2300 lines with ~30 line shell |
| site/patron/src/*.jsx | New — extracted components |
| site/patron/src/lib/*.js | New — extracted utilities |
| site/patron/src/input.css | New — tailwind directives + custom CSS |
| tailwind.config.js | New — theme colors from inline config |
| package.json | Add react, react-dom, marked, highlight.js, @tailwindcss/cli |
| .gitignore | Add site/patron/app.js, app.js.map, app.css |
| scripts/start.sh | Run dashboard build before dev server |

## Design decisions

**Why esbuild over vite/webpack?** Single-purpose, zero config, 50ms
builds. No dev server of its own needed — the existing no-cache static
server works fine.

**Why compile Tailwind?** The dashboard uses only static class name
strings (including EVENT_COLORS). No runtime class generation. A
compiled CSS file is smaller, faster, and removes the CDN dependency.

**Why system fonts?** One fewer external request. The dashboard is a
monospace terminal-style UI where system mono fonts look nearly
identical to JetBrains Mono.

**Why keep tightly-coupled components together?** MindHealthBar is
only used inside MindTab. ContextPanel is only used inside TimelineTab.
Splitting them into separate files creates more imports without better
isolation. Split when they're reused.

**Why gitignore build output?** `app.js` and `app.css` are generated
from `src/`. Committing them creates merge conflicts and stale
artifacts. The build is fast enough to run on every checkout.
