# Skill: Tool Authoring

How to create, modify, and remove tools via the proposal system.

---

## 1. What Is a Tool

A tool is an executable code module with two named exports: a `meta` object and an `execute()` function. When the LLM invokes a tool, the kernel builds an execution context and calls `execute(ctx)`. The tool receives everything it needs through `ctx` — there are no other imports available.

---

## 2. Where Tool State Lives

A tool's state spans four KV locations. All four must be consistent for a tool to work.

| KV key | Format | What it controls | Who can write |
|--------|--------|-----------------|---------------|
| `tool:{name}:code` | text | Source code (meta + execute) | Agent via `proposal_requests` (code key) |
| `tool:{name}:meta` | JSON | Operational config (kv_access, timeout_ms) | Agent via `kv_operations` in deep reflect (system key) |
| `kernel:tool_grants` | JSON | Security grants (secrets, provider, communication/inbound gates) | **Patron only** (kernel-only key) |
| `config:tool_registry` | JSON | LLM function schema (name, description, input parameters) | Agent via `kv_operations` in deep reflect (system key) |

### The grants boundary

You **cannot** modify `kernel:tool_grants`. This means:

- You can write code that uses `secrets.MY_API_KEY` or `provider.call(...)` in `execute()`
- But those will be empty/undefined until the **patron** adds the corresponding grants
- Grant fields (`secrets`, `communication`, `inbound`, `provider`) in your `meta` export are **inert** — the kernel reads these from `kernel:tool_grants`, not from your code

**When your tool needs new grants:** State the requirements clearly in your proposal's `claims` array so the patron knows what to configure.

### Deployment path

Code changes aren't live immediately. The path is: `proposal_requests` → deep reflect accepts → governor compiles accepted code into the deployed bundle → tool becomes callable. Meta and registry updates via `kv_operations` take effect immediately.

---

## 3. The Tool Contract

### meta export

```javascript
export const meta = {
  kv_access: "none",    // "none" | "own" | "read_all"
  timeout_ms: 15000,    // max execution time
  // Optional:
  kv_secrets: ["secret_name"],  // secrets stored in KV at secret:{name}
};
```

| Field | Values | Effect |
|-------|--------|--------|
| `kv_access` | `"none"` | No KV access |
| | `"own"` | Scoped to `tooldata:{toolName}:` prefix |
| | `"read_all"` | Full KV read access (blocks `sealed:` keys) |
| `timeout_ms` | number | Kernel kills execution after this duration |
| `kv_secrets` | string[] | Loaded from `secret:{name}` keys into `ctx.secrets` |

### execute function

```javascript
export async function execute(ctx) {
  // ctx contains:
  //   ...inputArgs    — all arguments from the LLM tool call (spread)
  //   secrets         — env secrets (from grants) + KV secrets (from meta.kv_secrets)
  //   fetch           — fetch function for HTTP requests
  //   kv              — scoped KV wrapper (only if kv_access != "none")
  //   provider        — provider module (only if grant has provider binding)
  //   config          — config:defaults object
  return { /* JSON-serializable result */ };
}
```

**Constraints:**
- Named exports only — no `export default` (the kernel looks for `execute`, `call`, or `check`)
- Must return a JSON-serializable value
- No imports — no npm, no Node APIs. Everything comes through `ctx`
- Your tool should return a clear error when expected `ctx` fields are missing (e.g., secrets not yet granted)

### Existing tools as structural examples

| Tool | Pattern | Load with |
|------|---------|-----------|
| `web_fetch` | Minimal — fetch only, no KV, no secrets | `kv_query("tool:web_fetch:code")` |
| `kv_query` | `read_all` KV access | `kv_query("tool:kv_query:code")` |
| `test_model` | Provider binding (`llm`) | `kv_query("tool:test_model:code")` |
| `send_slack` | Communication-gated, env secrets | `kv_query("tool:send_slack:code")` |

---

## 4. Creating a New Tool

### Decision checklist

1. **Is this a tool or a skill?** If it's a workflow using existing tools, write a skill instead.
2. **What access does it need?** KV scope, secrets, provider bindings?
3. **Will it need patron grants?** If it needs env secrets or a provider, it will deploy but won't function until the patron updates `kernel:tool_grants`.

### Three coordinated outputs (deep reflect)

Creating a tool requires three outputs in a single deep reflect response:

**1. `proposal_requests`** — the code (code key, governor deploys):
```json
{
  "claims": ["Add url_status tool for checking URL health"],
  "ops": [{"op": "put", "key": "tool:url_status:code", "value": "...source code..."}],
  "checks": [{"type": "kv_assert", "key": "tool:url_status:code", "predicate": "exists"}]
}
```

**2. `kv_operations`** — the operational meta (system key, immediate):
```json
{"op": "put", "key": "tool:url_status:meta", "value": {"kv_access": "none", "timeout_ms": 15000}}
```

**3. `kv_operations`** — the registry entry (system key, immediate):
```json
{"op": "patch", "key": "config:tool_registry", "old_string": "...last tool entry...", "new_string": "...last tool entry + new entry..."}
```

### From session reflect (depth 0)

Session reflect can only stage `proposal_requests`. It **cannot** write system keys (`tool:*:meta`, `config:tool_registry`). Note the meta and registry requirements in `session_summary` so deep reflect completes them.

### Minimal code template

```javascript
export const meta = { kv_access: "none", timeout_ms: 15000 };

export async function execute({ arg1, arg2, fetch }) {
  // Your logic here
  return { success: true, data: "result" };
}
```

Load `skill:tool-authoring:ref` before constructing proposals — it has full JSON examples.

---

## 5. Modifying an Existing Tool

### put vs patch

- **`put`** — replaces the entire code value. Use when rewriting most of the tool.
- **`patch`** — surgical find-and-replace. Use for targeted fixes.

**Patch warning:** `old_string` must match the KV text byte-for-byte. Always read the current code first:
```
kv_query("tool:{name}:code")
```
Then construct your patch from the actual text, not from memory.

### When to coordinate with meta or registry

- **Meta:** If your code change adds KV access or changes timeout, include a `kv_operations` entry for `tool:{name}:meta`.
- **Registry:** If you change the tool's description or input arguments, include a `kv_operations` patch on `config:tool_registry`.

---

## 6. Removing a Tool

### Three coordinated outputs

**1. `proposal_requests`** — delete the code:
```json
{"claims": ["Remove url_status — no longer needed"], "ops": [{"op": "delete", "key": "tool:url_status:code"}], "checks": []}
```

**2. `kv_operations`** — delete the meta:
```json
{"op": "delete", "key": "tool:url_status:meta"}
```

**3. `kv_operations`** — remove from registry (patch to remove the entry from the tools array).

### Before removing

Check for dependencies — other tools, skills, or prompts that reference this tool:
```
kv_query("config:tool_registry")
kv_manifest("skill:")
```

Stale entries in `kernel:tool_grants` for a removed tool are harmless — the kernel only looks up grants when executing a tool that exists.

### Check gotcha

There is no `not_exists` predicate. For delete proposals, either omit checks or use a `tool_call` check with `kv_query` to verify the key is gone.

---

## 7. Testing and Verification

- Write `checks` for every code proposal — `kv_assert` confirms the code was written; `tool_call` can exercise the tool end-to-end.
- `test_model` tests LLM provider calls — useful for provider-dependent tools, not for arbitrary tool logic.
- After deployment, monitor karma for `tool_error` events. Record findings in `proposal_observations` while inflight.
- Load `doc:proposal_guide` for the full proposal lifecycle (inflight → promote → rollback).

---

## 8. Reference

Before constructing any `proposal_requests` or `kv_operations` for tool changes, load:

```
kv_query("skill:tool-authoring:ref")
```

Complete JSON examples for creating, modifying, and removing tools, plus a common mistakes checklist.
