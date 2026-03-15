# Claude Code Project Notes

## Environment Setup

Before running Swayambhu, source the local env file:

```bash
source .env
```

This loads `OPENROUTER_API_KEY` needed for LLM access.

## Local Dev Startup

### Shared state

All local workers and the seed script must use the same `--persist-to` path
so they share one KV store. The canonical path is `.wrangler/shared-state`
(relative to repo root). The seed script already has this baked in.

### Starting dev environment

One script handles everything — `start.sh`. By default it starts all
services and preserves existing KV state. Use `--wake` to trigger a wake
cycle after startup. Use `--reset-all-state` to wipe state and re-seed
from scratch. Use `--set` to override any `config:defaults` value after seeding.

```bash
# Start services only (dashboard, brainstem — no wake)
source .env && bash scripts/start.sh

# Start + trigger a wake cycle
source .env && bash scripts/start.sh --wake

# Full reset + wake
source .env && bash scripts/start.sh --reset-all-state --wake

# Full reset with config overrides (dot-path into config:defaults)
source .env && bash scripts/start.sh --reset-all-state --set orient.model=deepseek --set reflect.model=deepseek
```

The script automatically:
- Kills stale workers (`pkill -f workerd`)
- Waits for ports to actually free (avoids port conflict footgun)
- Starts brainstem, dashboard API, and dashboard SPA
- Waits for services to be ready
- Triggers `/__scheduled` if `--wake` is passed

### IMPORTANT: `pkill -f workerd` kills ALL workers

This kills both brainstem (8787) and dashboard API (8790). The start
script handles restarting both automatically.

### Ports

| Service        | Port | Notes                                    |
|----------------|------|------------------------------------------|
| Brainstem      | 8787 | `--test-scheduled` enables `/__scheduled` |
| Dashboard API  | 8790 | SPA hardcodes this for localhost          |
| Dashboard SPA  | 3001 | `dev-serve.mjs` — no-cache static server  |

### Dashboard auth

The operator key for local dev is `test` (set in `dashboard-api/wrangler.toml`).
Enter it in the dashboard login prompt.

## Testing

### Unit tests

```bash
npm test          # vitest — all unit tests, no network, no Workers runtime
```

Tests cover:
- `tests/brainstem.test.js` — kernel logic (104 tests)
- `tests/wake-hook.test.js` — wake flow, reflect, modifications (62 tests)
- `tests/tools.test.js` — tool/provider execute(), module structure (100 tests)
- `tests/chat.test.js` — chat system (12 tests)

Shared mocks in `tests/helpers/`: `mock-kv.js` (KV store), `mock-kernel.js`
(KernelRPC mock).

### Integration testing (dev mode)

After seeding + starting wrangler dev, trigger a wake cycle:

```bash
curl http://localhost:8787/__scheduled
```

Watch stderr for tagged output: `[KARMA]`, `[TOOL]`, `[LLM]`, `[HOOK]`.

### Switching models

The seed script seeds canonical production models (Claude). To use cheaper
models for basic dev testing, use `--set` with `--reset-all-state`:

```bash
# Full reset with DeepSeek for all roles (~30x cheaper)
source .env && bash scripts/start.sh --reset-all-state --set orient.model=deepseek --set reflect.model=deepseek

# Override just orient model
source .env && bash scripts/start.sh --reset-all-state --set orient.model=deepseek
```

Model aliases (e.g. `deepseek` for `deepseek/deepseek-v3.2`) are resolved
at runtime via `config:models` alias_map. You can also use full model IDs.

**Use cheap models for:** tool wiring, orient flow, KV ops, prompt rendering,
budget enforcement, basic wake cycles.

**Use real models for:** reflection hierarchy, Modification Protocol, deep reflect,
anything needing structured JSON adherence.

## Code Layout

### Wake hook (modular)

The wake hook is split into 4 ES modules loaded via manifest:

| Source file | KV key | Contents |
|-------------|--------|----------|
| `hook-main.js` | `hook:wake:code` | Entry point: `wake()`, `runSession()`, `detectCrash()`, Worker Loader export |
| `hook-reflect.js` | `hook:wake:reflect` | `executeReflect()`, `runReflect()`, scheduling, default prompts |
| `hook-modifications.js` | `hook:wake:modifications` | Modification Protocol: staging, inflight, circuit breaker, verdicts |
| `hook-protect.js` | `hook:wake:protect` | Constants, `isSystemKey()`, `applyKVOperation()` |

Manifest at `hook:wake:manifest` maps filenames to KV keys. The kernel
loads all modules and passes them to Worker Loader. Dependency graph
(no cycles): protect ← modifications ← reflect ← main.

Modifications support a `patch` op (`{ op: "patch", key, old_string, new_string }`)
for surgical find-and-replace edits within a KV value. Rejects if old_string
is missing or ambiguous. Rollback restores the full pre-patch snapshot.

### Yamas and Niyamas (operating principles)

`yama:*` (outer world) and `niyama:*` (inner world) keys in KV. Kernel-injected
into every LLM prompt after dharma. Mutable via `kvWritePrivileged` but with
kernel-enforced friction: requires `deliberation` field (min 200 chars for yamas,
100 for niyamas) and a `yama_capable/niyama_capable` model. Audit trail at
`{key}:audit`.

### Tools and providers

Tool code lives in `tools/*.js`, provider adapters in `providers/*.js`.
Single source of truth — dev imports them directly, seed script reads
them into KV for prod. **No `export default`** in these files (required
for `wrapAsModule` compatibility).

### Key scripts

| Script | Purpose |
|--------|---------|
| `source .env && bash scripts/start.sh` | Restart workers, preserve state, trigger wake |
| `source .env && bash scripts/start.sh --reset-all-state` | Full reset: wipe state, seed with production models |
| `source .env && bash scripts/start.sh --reset-all-state --set path=value` | Full reset with config overrides |
| `node scripts/seed-local-kv.mjs` | Seed local KV (~2s) — uses Miniflare API directly |
| `node scripts/read-kv.mjs [key-or-prefix]` | Inspect local KV (list keys, read values) |
| `node scripts/rollback-session.mjs` | Undo last session's KV changes (`--dry-run` to preview, `--yes` to skip confirm) |

## Working Style — MANDATORY

**Do NOT make code changes without explicit approval.** When the user asks
a question or raises an issue, respond with your analysis, thoughts, and
proposed approach first. Wait for the user to say "yes", "do it", "go ahead",
or otherwise clearly approve before writing or editing any files. This
applies to ALL changes — even small ones, even "obvious" fixes. The only
exception is when the user gives an explicit instruction to implement
something (e.g. "Implement the following plan:" or "add X to Y").

## Development Philosophy

This is v0.1 — no backwards compatibility needed. Feel free to change data
formats, KV schemas, karma structures, API shapes, etc. without migration
or fallback logic. Old local data can always be wiped with a re-seed.

### Why `--persist-to`?

Wrangler's `--local` flag and `wrangler dev` use different storage backends
by default (`blobs/` vs `miniflare-*.sqlite`). Using `--persist-to` on both
the seed script and all `wrangler dev` instances forces them to the same
SQLite store, so seeded keys are visible to running workers.
