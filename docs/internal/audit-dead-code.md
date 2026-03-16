# Dead Code and Duplication Audit

Generated: 2026-03-15

---

## 1. Dead Code

### 1.1 Exported but Never Imported

| Location | What | Confidence | Action |
|----------|------|------------|--------|
| `hook-protect.js` | Resolved | DANGER_SIGNALS deleted (system key refactor). `applyKVOperationDirect` export removed — now module-private. |
| `hook-protect.js` | Resolved | Same as above. |


### 1.2 Properties Assigned but Never Read

| Location | What | Confidence | Action |
|----------|------|------------|--------|
| `brainstem.js` | Resolved | `kvWritesThisSession` property and increment deleted. |
| `brainstem.js` | Resolved | `patronPublicKey` property and assignment deleted. |

### 1.3 Stub Functions (Effectively Dead)

| Location | What | Confidence | Action |
|----------|------|------------|--------|
| `hook-main.js` | Resolved | `getKVUsage()` stub deleted. Removed `kvUsage` from context chain (wake → orient → tripwires → reflect). |

### 1.4 KV Keys: Seeded but Never Read at Runtime

| Key | Seeded by | Confidence | Action |
|-----|-----------|------------|--------|
❌| `identity:did` | `seed-local-kv.mjs:46` | Certain | Orphaned — no runtime code reads this key. Future identity verification feature. Keep if planned, delete seed if not. |
| `provider:gmail:code` | `seed-local-kv.mjs` (via provider loop) | Resolved | Now loaded at runtime via `meta.provider` in `check_email` and `send_email` tools. Provider code injected into Worker Loader isolate as a second module. |
| `provider:gmail:meta` | `seed-local-kv.mjs` (via provider loop) | Resolved | Same as above. |
| `cache:kv_index` | `hook-main.js` | Resolved | Write deleted — was written every wake cycle but never read. |

### 1.5 Unreferenced Template Variables

| Location | What | Confidence | Action |
|----------|------|------------|--------|
| `hook-reflect.js` / `prompts/deep-reflect.md` | Resolved | `kvIndex` template var and `{{context.kvIndex}}` removed. `kvUsage` template var also removed (dead stub chain). |

### 1.6 Backward Compatibility Code (v0.1 — Can Be Deleted per CLAUDE.md)

| Location | What | Confidence | Action |
|----------|------|------------|--------|
| `hook-reflect.js` | Resolved | `deep_reflect_schedule` legacy write deleted from `applyReflectOutput`. |
| `hook-reflect.js` | Resolved | `prompt:deep` fallback deleted from `loadReflectPrompt`. |
| `hook-reflect.js` | Resolved | `deep_reflect_schedule` fallback deleted from `isReflectDue`. |
| `hook-reflect.js` | Resolved | `last_deep_reflect_session` / `last_deep_reflect` legacy field names removed — consolidated to `last_reflect_session` / `last_reflect`. |

### 1.7 Unused Dependency

| Package | Location | Confidence | Action |
|---------|----------|------------|--------|
| `ethers` | `package.json` | Resolved | Moved to `devDependencies`. |

### 1.8 Reference to Deleted File

| Location | What | Confidence | Action |
|----------|------|------------|--------|
| `tests/brainstem.test.js` | Resolved | `kv_read` reference updated to `kv_query`. |
| `specs/chunked-content-reader.md:121` | References `kv_read` tool | Certain | Update or delete reference |

---

## 2. Duplicated Logic

### 2.1 Gmail API Helpers — Triple Copy

| Files | What | Confidence | Action |
|-------|------|------------|--------|
| `providers/gmail.js`, `tools/check_email.js`, `tools/send_email.js` | Resolved | Tools use `meta.provider` to import `providers/gmail.js` via Worker Loader multi-module support. Gmail helpers live in one place. |

### 2.2 ScopedKV — Duplicated Between Brainstem and DevBrainstem

| Files | What | Confidence | Action |
|-------|------|------------|--------|
| `brainstem.js` (`ScopedKV` class) and `brainstem-dev.js` (`_buildScopedKV()`) | Accepted | Intentional — different execution modes (CF isolate vs direct call). Logic must match but can't share code due to CF WorkerEntrypoint constraint. Consider adding a parity test. |

### 2.3 SYSTEM_KEY_PREFIXES / SYSTEM_KEY_EXACT — Duplicated Between Kernel and Hook

| Files | What | Confidence | Action |
|-------|------|------------|--------|
| `brainstem.js` and `hook-protect.js` | Resolved | `hook-protect.js` no longer maintains its own copy. `applyKVOperation` calls `K.isSystemKey()` (kernel RPC). `hook-reflect.js` calls `K.getSystemKeyPatterns()` for prompt context. Single source of truth is now `brainstem.js`. |

### 2.4 Config Loading — Duplicated Three Times

| Files | What | Confidence | Action |
|-------|------|------------|--------|
| `brainstem-dev.js` and `brainstem.js` | Resolved | Extracted `loadEagerConfig()` on Brainstem. All 4 call sites now use it. Also fixed missing `loadPatronContext()` in dev chat path. |

### 2.5 KV Namespace ID — Hardcoded in 5 Scripts

| Files | What | Confidence | Action |
|-------|------|------------|--------|
| `scripts/*` | Resolved | Extracted to `scripts/shared.mjs` — single source of truth for KV namespace ID, Miniflare factory (`getKV()`), and `dispose()`. All 6 scripts now import from shared. |

### 2.6 Miniflare Boilerplate — Copy-Pasted in Every Script

| Files | What | Confidence | Action |
|-------|------|------------|--------|
| All 6 scripts in `scripts/` | Resolved | Same fix as 2.5 — `scripts/shared.mjs` exports `getKV()` and `dispose()`. |

### 2.7 Verdict Processing — Similar Pattern for Staged Modifications

| Files | What | Confidence | Action |
|-------|------|------------|--------|
❌| `hook-modifications.js` (`processReflectVerdicts` and `processDeepReflectVerdicts`) | Both handle `withdraw` and `modify` verdicts with identical logic (~8 lines). Deep reflect adds `apply`, `reject`, `promote`, `rollback`, `defer`. | Accepted | Duplication is stable, small, and serves readability. Different trust tiers — not worth abstracting. |

---

## 3. Orphaned Files

| File | What | Status | Action |
|------|------|--------|--------|
| `providers/gmail.js` | Resolved | No longer orphaned — loaded at runtime via `meta.provider` and imported directly by dev brainstem and tests. |
| `tools/kv_read.js` | Resolved | Deleted. References cleaned up in tests. |
| `specs/chunked-content-reader.md` | Untracked spec file. References `kv_read` tool. No implementation exists. | Investigate | Either implement or delete. |
| `docs/INFRA_MIGRATION.md` | Exists but not referenced anywhere. | Investigate | May be documentation-only — keep or delete based on relevance. |
| `skills/akash-terminal.md` | Skill definition. Loaded dynamically as LLM context. | Alive | Keep. |

---

## 4. Unused Dependencies

| Package | Declared In | Used By | Confidence | Action |
|---------|------------|---------|------------|--------|
| `ethers` | `package.json` (devDependencies) | Only `scripts/generate-identity.js` | Resolved | Moved to devDependencies. |
| `wrangler` | `package.json` (dependencies) | CLI tool, not imported by code | N/A | Keep — needed for `wrangler dev` |
| `vitest` | `package.json` (devDependencies) | Test framework | N/A | Keep |

---

## 5. Remaining Items

Only items not yet resolved:

1. ❌ `identity:did` — orphaned KV key, kept for future identity verification feature
2. ❌ Verdict processing duplication — accepted as intentional (small, stable, readable)
3. `specs/chunked-content-reader.md` — investigate: implement or delete
4. `docs/INFRA_MIGRATION.md` — investigate: keep or delete
5. `brainstem.js:120-121` — `getPatronId()` / `getPatronContact()` on KernelRPC have no callers from hook code (hook-reflect now uses them via RPC, so this is resolved)
