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

Seeds 70 keys into local KV. Runs in ~2s via Miniflare API (replacing
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
| Tools | 19 | 9 tools × (`tool:{name}:code` from file + `tool:{name}:meta` from import) + 1 `kernel:tool_grants` |
| Prompts | 5 | `prompt:orient`, `prompt:subplan`, `prompt:reflect`, `prompt:reflect:1`, `prompt:chat` — from `prompts/*.md` or inline |
| Dharma | 1 | `dharma` — from `DHARMA.md` |
| Yamas | 7 | `yama:care`, `yama:truth`, `yama:responsibility`, `yama:discipline`, `yama:rules`, `yama:security`, `yama:humility` — inline text |
| Niyamas | 7 | `niyama:health`, `niyama:acceptance`, `niyama:transformation`, `niyama:reflection`, `niyama:alignment`, `niyama:nonidentification`, `niyama:organization` — inline text |
| Hooks | 2 | `hook:act:code`, `hook:reflect:code` (from `act.js` and `reflect.js` source files) |
| Channel | 2 | `channel:slack:code` (from file), `channel:slack:config` (inline) |
| Kernel | 5 | `kernel:alert_config`, `kernel:llm_fallback`, `kernel:llm_fallback:meta`, `kernel:fallback_model`, `kernel:tool_grants` |
| Docs | 2 | `doc:proposal_guide`, `doc:architecture` — from `docs/doc-*.md` |
| Contacts | 3 | `contact:swami_kevala`, `patron:contact`, `patron:public_key` |
| Upaya | 1 | `upaya:comms:defaults` — seed communication wisdom |
| Skills | 3 | `skill:model-config`, `skill:model-config:ref`, `skill:skill-authoring` — from `skills/*.json` + `skills/*.md` |
| **Total** | **73** | |

### Source file reading

Tool and provider code is read as raw text (`readFileSync`) for the
`:code` keys, and dynamically imported for the `:meta` keys. This means
the seed script validates that all tool/provider modules parse correctly.

### Tool meta splitting

For each tool, the seed script splits `export const meta` into two
destinations:

- **Grant fields** (`secrets`, `communication`, `inbound`, `provider`) →
  accumulated into `kernel:tool_grants` (kernel-only, agent cannot modify)
- **Operational fields** (`kv_access`, `timeout_ms`, `kv_secrets`) →
  stored in `tool:{name}:meta` (agent-modifiable via Proposal Protocol)

The tool source files remain the single source of truth — they still
declare all fields. The split only happens at seed time and in
`sync-tool-grants.mjs`.

Prompts are read from `prompts/` directory. Hook modules are read from
the repo root (`act.js`, etc.). Channel adapters from `channels/`.

---

## scripts/sync-tool-grants.mjs — Grant Sync

Syncs `kernel:tool_grants` from tool source files without re-seeding all
KV state. Use this after adding a new tool, changing a tool's security
fields (secrets, communication, inbound, provider), or when you want to
update grants without wiping runtime state.

```bash
node scripts/sync-tool-grants.mjs
```

Output shows which tools have grants and which fields:

```
kernel:tool_grants synced:
  send_slack: secrets, communication
  check_email: secrets, inbound, provider
  send_email: secrets, communication, provider
  ...
```

The script reads each `tools/*.js` module, extracts the grant fields from
`export const meta`, assembles the grants object, and writes it to
`kernel:tool_grants` in local KV.

---

## scripts/patron-sign.mjs — Patron Signature

Signs messages with the patron's Ed25519 private key. Used to prove
identity to the agent (via `verify_patron` tool) or to authorize key
rotation.

```bash
# Sign a challenge message
node scripts/patron-sign.mjs "challenge-nonce-12345"

# Sign with a non-default key
node scripts/patron-sign.mjs --key ~/.ssh/swayambhu_ed25519 "message"

# Generate a rotation signature for a new public key
node scripts/patron-sign.mjs --rotate "ssh-ed25519 AAAA... new-key"
```

The script reads the private key from `~/.ssh/id_ed25519` by default
(override with `--key`). Uses Node's `crypto.createPrivateKey` which
handles OpenSSH format natively. Outputs a base64-encoded Ed25519
signature to stdout.

In `--rotate` mode, signs the canonical message `rotate:{newPublicKey}`
which `rotatePatronKey()` in the kernel expects.

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

Undoes the most recent session's KV changes.

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
3. **Proposal snapshots** — for any `proposal_accepted` events,
   loads the snapshot and restores all snapshotted keys. Deletes the
   snapshot record
4. **Staged proposals** — deletes `proposal_staged:*` records
   created this session
5. **Session counter** — decrements `session_counter`
6. **Session ID list** — pops the last entry from `cache:session_ids`
7. **Session history** — pops matching entry from `kernel:last_sessions`
8. **KV index cache** — deletes `cache:kv_index` (rebuilt on next session)
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

## scripts/reset-schedule.mjs — Reset Schedule Timer

Sets `session_schedule.next_session_after` to a past date so the next cron trigger
runs immediately instead of being skipped.

```bash
node scripts/reset-schedule.mjs
```

Reads the existing `session_schedule`, updates `next_session_after` to
`"2020-01-01T00:00:00Z"`, writes it back. If no `session_schedule` exists
(first run), skips.

Uses `process.exit(0)` to force exit — Miniflare's `dispose()` can hang
if the workerd subprocess won't quit.

Called by `start.sh` when starting without `--reset-all-state` to ensure
the schedule timer doesn't block the next session.

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

### /trigger proxy

`POST /trigger` proxies to `http://localhost:8787/__scheduled` — triggers a
session from the dashboard SPA. Returns `{ ok, status }` or
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
| `--trigger` | Trigger a session after services are ready |
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
   - Without reset: runs `reset-schedule.mjs` to ensure next session runs
4. **Start services** (all via `setsid` for process group management):
   - Kernel: `npx wrangler dev -c wrangler.dev.toml --test-scheduled --persist-to .wrangler/shared-state` (port 8787)
   - Dashboard API: `npx wrangler dev --port 8790 --persist-to ../.wrangler/shared-state` (from `dashboard-api/`)
   - Dashboard SPA: `node scripts/dev-serve.mjs 3001`
5. **Wait for ready** — polls kernel and dashboard API with curl
   (up to 30s each)
6. **Trigger session** (if `--trigger`): `curl http://localhost:8787/__scheduled`

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
