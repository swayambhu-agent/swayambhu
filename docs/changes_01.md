# Remove KV List Scanning from Brainstem

## Problem

`listKVKeys()` calls `kv.list({ limit: 1000 })` once. Past 1000 keys, safety-critical scans (circuit breaker, conflict detection, mutation loading) become silently incomplete. But the brainstem creates every key it needs to scan — it already knows what exists.

## Change 1: Track active mutations explicitly

Maintain two KV keys:

* `active_candidates` — array of mutation IDs
* `active_staged` — array of mutation IDs

Update them at every point the brainstem creates, removes, or transitions a mutation:

* `stageMutation`: append ID to `active_staged`
* `applyStagedAsCandidate`: remove from `active_staged`, append to `active_candidates`
* `applyDirectAsCandidate`: append to `active_candidates`
* `promoteCandidate`: remove from `active_candidates`
* `rollbackCandidate`: remove from `active_candidates`
* `processReflectVerdicts` (withdraw): remove from `active_staged`
* `processDeepReflectVerdicts` (reject/withdraw): remove from `active_staged`. (promote/rollback): remove from `active_candidates`

Initialize both as empty arrays on first read if they don't exist.

## Change 2: Replace all listKVKeys() usage in safety mechanisms

Every brainstem method that currently calls `listKVKeys()` and filters by prefix should instead read the tracked arrays and do direct key reads:

* `runCircuitBreaker`: read `active_candidates`, get each `mutation_candidate:{id}` directly
* `findCandidateConflict`: read `active_candidates`, get each `mutation_candidate:{id}` directly
* `loadStagedMutations`: read `active_staged`, get each `mutation_staged:{id}` directly
* `loadCandidateMutations`: read `active_candidates`, get each `mutation_candidate:{id}` directly

## Change 3: Remove listKVKeys() and kvIndex from brainstem

Remove `listKVKeys()` entirely. Remove kvIndex from `wake()` and from orient/reflect context building. Orient gets its world view from the manifest tool instead.

## Change 4: Seed manifest tool

Add to `seed-local-kv.sh` a new tool `tool:kv_manifest` that:

* Takes no input
* Does prefix-scoped `kv.list({ prefix })` for a set of known prefixes: `config:`, `prompt:`, `tool:`, `tooldata:`, `provider:`, `functions:`, `karma:`, `reflect:`, `mutation_staged:`, `mutation_candidate:`, `secret:`, `session`, `wake_config`, `dharma`, `wisdom`
* Returns an object with counts per prefix and lists of actual key names for small categories (config, prompt, tool, functions, provider) and just counts for large categories (karma, reflect, tooldata)
* Writes the result to a `manifest` KV key and also returns it

kv_access should be `read_all` for reads, plus ability to write the `manifest` key. Give it appropriate meta.

## What NOT to change

* Don't change how mutations are created, applied, promoted, or rolled back — only add the array tracking alongside existing logic
* Don't change the circuit breaker's rollback logic, conflict detection logic, or mutation lifecycle — only change how they discover which IDs to examine
