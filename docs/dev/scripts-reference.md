# Scripts & Dev Tools

All scripts live in `scripts/`. They interact with local KV via the
Miniflare API (not wrangler CLI) for speed.

---

## scripts/shared.mjs — Miniflare Factory

Single source of truth for the local KV namespace ID and persist path.

```js
const KV_NAMESPACE_ID = "05720444f9654ed4985fb67af4aea24d";
// kvPersist: .wrangler/shared-state/v3/kv
```

Exports:
- `getKV()` — creates a Miniflare instance and returns the KV namespace
- `dispose()` — cleans up the Miniflare instance
- `root` — absolute path to the repo root

Every script that reads or writes KV imports from `shared.mjs` to ensure
they all hit the same SQLite-backed store that `wrangler dev` uses.

---

## scripts/seed-local-kv.mjs — KV Seeder

Seeds 69 keys into local KV. Runs in ~2s via Miniflare API (replacing
~50 wrangler subprocess spawns from an earlier approach).

### How it works

1. Creates a Miniflare KV instance via `shared.mjs`
2. Defines a `put(key, value, format, description)` helper that tracks
   count
3. Seeds keys by category, reading source files with `readFileSync` and
   importing modules with dynamic `import()`
4. Reports total count on completion

### Seeded categories

| Category | Keys | How seeded |
|----------|------|------------|
| Identity | 1 | `identity:did` — hardcoded DID document |
| Config | 7 | `config:defaults`, `config:models`, `config:model_capabilities`, `config:resources`, `config:tool_registry`, `providers`, `wallets` — inline JSON |
| Providers | 8 | 4 providers × (`provider:{name}:code` from file + `provider:{name}:meta` from import) |
| Tools | 16 | 8 tools × (`tool:{name}:code` from file + `tool:{name}:meta` from import) |
| Prompts | 5 | `prompt:orient`, `prompt:subplan`, `prompt:reflect`, `prompt:reflect:1`, `prompt:chat` — from `prompts/*.md` or inline |
| Dharma | 1 | `dharma` — from `DHARMA.md` |
| Yamas | 7 | `yama:care`, `yama:truth`, `yama:responsibility`, `yama:discipline`, `yama:rules`, `yama:security`, `yama:humility` — inline text |
| Niyamas | 7 | `niyama:health`, `niyama:acceptance`, `niyama:transformation`, `niyama:reflection`, `niyama:alignment`, `niyama:nonidentification`, `niyama:organization` — inline text |
| Wake hook | 5 | `hook:wake:code`, `hook:wake:reflect`, `hook:wake:modifications`, `hook:wake:protect` (from source files) + `hook:wake:manifest` (inline JSON) |
| Channel | 2 | `channel:slack:code` (from file), `channel:slack:config` (inline) |
| Kernel | 4 | `kernel:alert_config`, `kernel:llm_fallback`, `kernel:llm_fallback:meta`, `kernel:fallback_model` |
| Docs | 2 | `doc:modification_guide`, `doc:architecture` — from `docs/doc-*.md` |
| Contacts | 3 | `contact:swami_kevala`, `patron:contact`, `patron:public_key` |
| Viveka | 1 | `viveka:comms:defaults` — seed communication wisdom |
| **Total** | **69** | |

### Source file reading

Tool and provider code is read as raw text (`readFileSync`) for the
`:code` keys, and dynamically imported for the `:meta` keys. This means
the seed script validates that all tool/provider modules parse correctly.

Prompts are read from `prompts/` directory. Hook modules are read from
the repo root (`hook-main.js`, etc.). Channel adapters from `channels/`.

---

## scripts/read-kv.mjs — KV Inspector

Read and explore local KV state.

```bash
node scripts/read-kv.mjs                     # list all keys
node scripts/read-kv.mjs karma:              # list keys with prefix
node scripts/read-kv.mjs karma:s_123_abc     # read a specific key
node scripts/read-kv.mjs --json karma:s_123  # raw JSON output (for piping)
```

Behavior:
- If the query doesn't end with `:`, tries an exact key read first
- If exact read returns null (or query ends with `:`), lists keys with
  that prefix
- `--json` flag outputs raw values suitable for piping to `jq`
- Lists up to 500 keys per query

---

## scripts/rollback-session.mjs — Session Rollback

Undoes the most recent wake session's KV changes.

```bash
node scripts/rollback-session.mjs              # with confirmation prompt
node scripts/rollback-session.mjs --dry-run    # preview only
node scripts/rollback-session.mjs --yes        # skip confirmation
```

### What it reverses

1. **Session artifacts** — deletes `karma:{id}`, `reflect:0:{id}`, and
   any `reflect:{depth}:{id}` keys
2. **Privileged writes** — reads `privileged_write` events from karma,
   reverses in order. Keys that didn't exist before are deleted; keys that
   had old values are restored
3. **Modification snapshots** — for any `modification_accepted` events,
   loads the snapshot and restores all snapshotted keys. Deletes the
   snapshot record
4. **Staged modifications** — deletes `modification_staged:*` records
   created this session
5. **Session counter** — decrements `session_counter`
6. **Session ID list** — pops the last entry from `cache:session_ids`
7. **Session history** — pops matching entry from `kernel:last_sessions`
8. **KV index cache** — deletes `cache:kv_index` (rebuilt on next wake)
9. **Last reflect** — restores from previous session's `reflect:0:{prevId}`
10. **Danger signal** — deletes `last_danger` if set by this session

### Warnings

The script cannot automatically reverse:
- `kv_write` tool writes (no `old_value` recorded in karma for tool-scoped
  writes)
- `last_danger` from a different session (warns but leaves in place)
- Orphan sessions not in `cache:session_ids`

Deduplication: restores take priority over deletes for the same key. Last
restore entry for each key wins.

---

## scripts/dump-sessions.mjs — Session Summaries

Reads `cache:session_ids` and prints session summaries.

```bash
node scripts/dump-sessions.mjs
```

For each session: loads `reflect:0:{id}`, extracts `session_summary` and
`note_to_future_self`. Handles parse errors by trying to extract JSON from
markdown code fences in `raw` output. Also handles `budget_exceeded`
sessions. Prints the tool registry at the end.

---

## scripts/reset-wake-timer.mjs — Reset Wake Timer

Sets `wake_config.next_wake_after` to a past date so the next cron trigger
runs immediately instead of being skipped.

```bash
node scripts/reset-wake-timer.mjs
```

Reads the existing `wake_config`, updates `next_wake_after` to
`"2020-01-01T00:00:00Z"`, writes it back. If no `wake_config` exists
(first run), skips.

Uses `process.exit(0)` to force exit — Miniflare's `dispose()` can hang
if the workerd subprocess won't quit.

Called by `start.sh` when starting without `--reset-all-state` to ensure
the wake timer doesn't block the next cycle.

---

## scripts/dev-serve.mjs — Dashboard SPA Server

Zero-cache static file server for the dashboard.

```bash
node scripts/dev-serve.mjs [port]    # default: 3001
```

- Serves the `site/` directory
- `Cache-Control: no-store` on every response
- Directory paths serve `index.html`
- MIME types for html, js, mjs, css, json, png, jpg, svg, ico

### /wake proxy

`POST /wake` proxies to `http://localhost:8787/__scheduled` — triggers a
wake cycle from the dashboard SPA. Returns `{ ok, status }` or
`{ ok: false, error }`.

---

## scripts/generate-identity.js — DID Keypair Generation

Generates an Ethereum keypair for Swayambhu's `did:ethr` decentralized
identity on Base.

```bash
node scripts/generate-identity.js              # interactive display
node scripts/generate-identity.js --json       # machine-readable output
node scripts/generate-identity.js --seed-kv    # write identity:did to local KV
```

Uses `ethers.Wallet.createRandom()`. Generates:
- DID: `did:ethr:8453:{address}`
- Address, private key, public key
- Chain: Base mainnet (8453)
- Registry: ERC-1056 address

The KV payload (`identity:did`) includes:
- `did`, `address`, `chain_id`, `chain_name`
- `registry`, `registry_deployed` (false until on-chain deployment)
- `dharma_hash` (null until dharma is finalized)
- `controller` (initially self-controlled)

The identity key is separate from the wallet key by design:
- Identity key: signs VCs, controls DID Document, authenticates
- Wallet key: signs financial transactions
- Either can be rotated independently

---

## scripts/start.sh — Dev Environment Startup

One-command startup for the full dev environment.

```bash
source .env && bash scripts/start.sh [options]
```

### Flags

| Flag | Effect |
|------|--------|
| `--wake` | Trigger a wake cycle after services are ready |
| `--reset-all-state` | Wipe `.wrangler/shared-state/`, re-seed from scratch |
| `--yes` | Skip confirmation prompt for reset |
| `--set path=value` | Override `config:defaults` value after seeding (can be repeated) |

### Startup sequence

1. **Kill stale processes** — `pkill -f workerd`, then `pkill -9` for
   survivors, plus `pkill -f dev-serve.mjs`
2. **Wait for ports** — checks 8787, 8790, 3001 are free (up to 15s)
3. **Reset or preserve state**:
   - With `--reset-all-state`: deletes `.wrangler/shared-state/`, runs
     `seed-local-kv.mjs`, applies `--set` overrides
   - Without reset: runs `reset-wake-timer.mjs` to ensure next wake runs
4. **Start services** (all via `setsid` for process group management):
   - Brainstem: `npx wrangler dev -c wrangler.dev.toml --test-scheduled --persist-to .wrangler/shared-state` (port 8787)
   - Dashboard API: `npx wrangler dev --port 8790 --persist-to ../.wrangler/shared-state` (from `dashboard-api/`)
   - Dashboard SPA: `node scripts/dev-serve.mjs 3001`
5. **Wait for ready** — polls brainstem and dashboard API with curl
   (up to 30s each)
6. **Trigger wake** (if `--wake`): `curl http://localhost:8787/__scheduled`

### Config overrides

`--set` overrides use dot-path notation into `config:defaults`:

```bash
--set orient.model=deepseek --set reflect.model=deepseek
```

Applied via an inline Node script that:
1. Reads `config:defaults` from KV
2. Parses dot-path to navigate the object
3. Auto-detects value type (boolean, number, or string)
4. Writes updated config back to KV

> **NOTE:** `--set` without `--reset-all-state` prints a warning but
> doesn't error — the overrides have no effect because the config is
> already in KV and the seed script wasn't run.

### Cleanup

Registers a trap on INT/TERM/EXIT that kills all started process groups.
Uses `setsid` + `kill -- -$pgid` for reliable cleanup of wrangler
subprocesses.
