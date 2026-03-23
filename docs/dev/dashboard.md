# Dashboard API & Operator Interface

Separate Cloudflare Worker providing read (and limited write) access to
the same KV namespace used by the kernel. Stateless — no database, no
session, just KV reads and CORS headers.

---

## Architecture

```
┌─────────────────────────┐     ┌──────────────────────────┐
│  Operator SPA            │     │  Public Site              │
│  site/operator/          │     │  site/                    │
│  port 3001 (dev)         │     │  site/reflections/        │
└──────────┬──────────────┘     └──────────┬───────────────┘
           │                               │
           │ X-Operator-Key header         │ no auth
           ▼                               ▼
┌──────────────────────────────────────────────────────────┐
│  Dashboard API Worker                                     │
│  dashboard-api/worker.js                                  │
│  port 8790 (dev)                                          │
│                                                           │
│  Reads from same KV namespace as kernel                │
│  Writes only: contacts, quarantine delete                 │
└──────────────────────────────────────────────────────────┘
```

The dashboard API and kernel share the same KV namespace ID
(`05720444f9654ed4985fb67af4aea24d` in `dashboard-api/wrangler.toml`).
In dev, both use `--persist-to .wrangler/shared-state` to share the same
SQLite-backed store.

---

## Authentication

`dashboard-api/worker.js:16`

```js
function auth(request, env) {
  const key = request.headers.get("X-Operator-Key");
  return key && key === env.OPERATOR_KEY;
}
```

Single shared key via `X-Operator-Key` header. Compared against
`env.OPERATOR_KEY` (set in `wrangler.toml` vars — `"test"` for local dev,
overridden by secret in production).

- No rate limiting
- No CSRF protection
- No session/cookie auth — every request must include the header
- CORS allows all origins (`Access-Control-Allow-Origin: *`)

---

## CORS

`dashboard-api/worker.js:3`

All responses include:
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PATCH, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, X-Operator-Key
```

`OPTIONS` preflight requests return 204 with no auth check.

---

## Endpoints

### Public (no auth)

#### GET /reflections

Returns the 20 most recent depth-1 reflections for the public reflections
page.

- Lists `reflect:1:*` keys, filters out schedule keys
  (`reflect:1:schedule`), sorts newest first
- Returns `session_id`, `timestamp`, `reflection`, `note_to_future_self`
  for each

Response: `{ reflections: [...] }`

### Authenticated (X-Operator-Key required)

#### GET /health

System status snapshot. Reads 5 keys in parallel:

| Key | Field | Description |
|-----|-------|-------------|
| `session_counter` | `sessionCounter` | Total session count |
| `wake_config` | `wakeConfig` | Current sleep/wake configuration |
| `last_reflect` | `lastReflect` | Most recent reflection output |
| `kernel:active_session` | `session` | Currently running session ID (if any) |
| `session` | `session` (fallback) | Legacy session key |

> **NOTE:** The `session` key (without `kernel:` prefix) is read as a
> fallback but nothing in the codebase writes it. The kernel writes
> `kernel:active_session`.

#### GET /sessions

Discovers all sessions (orient and deep reflect).

1. Lists all `karma:*` keys (ground truth — every session has karma)
2. Lists all `reflect:1:*` keys (deep reflect sessions have these)
3. Builds session list: each karma key becomes a session, tagged as
   `deep_reflect` if a matching `reflect:1:` key exists, otherwise `orient`
4. Sorted by session ID (contains timestamp) — newest last

Response: `{ sessions: [{ id, type, ts }] }`

#### GET /kv?prefix=

Lists all KV keys, optionally filtered by prefix. Uses paginated
`kvListAll` (same 100-page safety limit as the kernel).

Response: `{ keys: [{ key, metadata }] }`

#### GET /kv/multi?keys=key1,key2,key3

Batch read of multiple keys. Each key is read with metadata to determine
format (json or text). Keys that don't exist return `null`.

Response: `{ "key1": value1, "key2": null, ... }`

#### GET /kv/:key

Single key read. Returns value with format detection based on metadata.

Response: `{ key, value, type: "json"|"text" }` or `{ error: "not found" }`
(404)

> **NOTE:** The route matching for `/kv/:key` explicitly excludes
> `/kv/multi` (`path !== "/kv/multi"`) to prevent the multi endpoint
> from being treated as a key read.

#### GET /quarantine

Lists all `sealed:quarantine:*` entries. The dashboard API reads sealed
keys directly from KV (it's not subject to the `KernelRPC.kvGet` sealed
key block — it uses `env.KV.get` directly).

Returns items sorted by timestamp descending (newest first).

Response: `{ items: [{ key, sender, content, tool, timestamp, ... }] }`

#### POST /contacts

Creates a new contact record. Validates:
- Required fields: `slug`, `name`
- No duplicate slugs (checks for existing `contact:{slug}`)

Writes:
- `contact:{slug}` — the contact record (identity metadata only, no
  `approved` or `platforms` fields)
- `contact_platform:{platform}:{userId}` — one platform binding per
  platform (if platforms provided), each with `{ slug, approved: true }`

Response: `{ ok: true, slug, contact }` or error (400/409)

#### PATCH /contact-platform/:platform/:id/approve

Sets approval status on a platform binding. Body: `{ "approved": true|false }`.

Updates the `contact_platform:{platform}:{id}` record with:
- `approved` — the new status

Response: `{ ok: true, platform, id, approved }` or error (400/404)

#### DELETE /quarantine/:key

Removes a quarantine entry after patron review. Validates the key starts
with `sealed:quarantine:` — cannot be used to delete arbitrary keys.

Response: `{ ok: true }`

---

## Operator SPA

`site/operator/index.html` — Single-file React application.

### Stack

- React 18 (UMD, loaded from CDN)
- Babel standalone (in-browser JSX transpilation)
- Tailwind CSS (CDN)
- JetBrains Mono font
- marked.js (Markdown rendering)
- highlight.js (code syntax highlighting)

No build step. The entire app is one HTML file plus one config file.

### Login

On load, prompts for operator key. Stored in component state (not
persisted). All API calls include it as `X-Operator-Key` header.
Local dev key: `"test"`.

### Tabs

Four tabs in the navigation:

#### Timeline

`TimelineTab` (`site/operator/index.html:403`)

- Lists sessions from `GET /sessions`
- Shows session type (orient vs deep_reflect), timestamp
- Click a session to load its karma log via `GET /kv/multi?keys=karma:{id}`
- Karma entries displayed as a timeline with event-based color coding
- **Watch mode**: polls every `watchIntervalMs` (default 2000ms) to
  live-update during an active session
- Detail panel shows full JSON for selected karma entries

#### KV Explorer

`KVExplorerTab` (`site/operator/index.html:780`)

- Lists all KV keys via `GET /kv`, optionally filtered by prefix
- Click a key to read its value via `GET /kv/:key`
- JSON values rendered with collapsible `JsonView` component
- Text values rendered as plaintext

#### Reflections

`ReflectionsTab` (`site/operator/index.html:885`)

- Lists reflect outputs across all depths
- Displays `reflection`, `note_to_future_self`, depth, session_id
- JSON viewer for full record inspection

#### Modifications

`MutationsTab` (`site/operator/index.html:984`)

- Shows staged and inflight modifications
- Color-coded by status: yellow (staged), active (inflight)
- Displays claims, ops, checks, and check results

### Config

`site/operator/config.js` — loaded before the React app.

```js
window.DASHBOARD_CONFIG = {
  timezone: "Asia/Kolkata",      // IANA timezone for timestamps
  locale: "en-IN",               // date/time locale
  truncate: {
    jsonString: 800,             // max chars in JSON viewer strings
    textBlock: 800,              // max chars in text blocks
  },
  watchIntervalMs: 2000,         // live polling interval
};
```

All settings have fallback defaults in the React code if the config file
is missing or a field is omitted.

---

## Public Site

### Landing page — site/index.html

Title: "Swayambhu — Self-Created". Static page with JetBrains Mono font,
dark theme. No API calls, no auth.

### Public reflections — site/reflections/index.html

Title: "Swayambhu — Reflections". Fetches from `GET /reflections` (no auth
required). Displays depth-1 reflections in a timeline format with
reflection text and `note_to_future_self`.

Both pages use the same dark color scheme (amber accent, purple for deep
reflect) and JetBrains Mono + system sans-serif fonts.

---

## Dev Serving

`scripts/dev-serve.mjs` — Node.js static file server.

- Serves `site/` directory on port 3001 (configurable via CLI arg)
- `Cache-Control: no-store` on every response — no caching during dev
- Directory paths serve `index.html`
- MIME types for html, js, mjs, css, json, png, jpg, svg, ico

### /wake proxy

`POST /wake` is proxied to `http://localhost:8787/__scheduled` — triggers
a wake cycle from the dashboard. Returns `{ ok: true, status }` on
success or `{ ok: false, error }` on failure.

### Startup

Started by `scripts/start.sh` as part of the dev environment. The start
script waits for port 3001 to be ready before reporting success.

```
Dashboard SPA: http://localhost:3001/operator/
```
