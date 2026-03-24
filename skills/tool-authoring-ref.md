# Tool Authoring — Reference

Complete JSON examples for tool proposals. Load this before constructing any
`proposal_requests` or `kv_operations` for tool changes.

---

## 1. Creating a New Tool

### Example: `url_status` — checks if a URL is reachable

**Code** (goes in `proposal_requests`):

```javascript
export const meta = { kv_access: "none", timeout_ms: 10000 };

export async function execute({ url, fetch }) {
  if (!url) return { success: false, error: "url is required" };
  const start = Date.now();
  try {
    const resp = await fetch(url, { method: "HEAD", redirect: "follow" });
    return {
      success: true,
      status: resp.status,
      ok: resp.ok,
      latency_ms: Date.now() - start,
    };
  } catch (err) {
    return { success: false, error: err.message, latency_ms: Date.now() - start };
  }
}
```

**proposal_requests entry:**

```json
{
  "claims": ["Add url_status tool for checking URL reachability and response codes"],
  "ops": [{
    "op": "put",
    "key": "tool:url_status:code",
    "value": "export const meta = { kv_access: \"none\", timeout_ms: 10000 };\n\nexport async function execute({ url, fetch }) {\n  if (!url) return { success: false, error: \"url is required\" };\n  const start = Date.now();\n  try {\n    const resp = await fetch(url, { method: \"HEAD\", redirect: \"follow\" });\n    return {\n      success: true,\n      status: resp.status,\n      ok: resp.ok,\n      latency_ms: Date.now() - start,\n    };\n  } catch (err) {\n    return { success: false, error: err.message, latency_ms: Date.now() - start };\n  }\n}"
  }],
  "checks": [
    {"type": "kv_assert", "key": "tool:url_status:code", "predicate": "exists"}
  ]
}
```

**kv_operations entries** (in the same deep reflect output):

```json
[
  {
    "op": "put",
    "key": "tool:url_status:meta",
    "value": {"kv_access": "none", "timeout_ms": 10000}
  },
  {
    "op": "patch",
    "key": "config:tool_registry",
    "old_string": "LAST_EXISTING_TOOL_ENTRY",
    "new_string": "LAST_EXISTING_TOOL_ENTRY,\n    { \"name\": \"url_status\", \"description\": \"Check if a URL is reachable and return its HTTP status code\", \"input\": { \"url\": \"The URL to check (required)\" } }"
  }
]
```

Replace `LAST_EXISTING_TOOL_ENTRY` with the actual last entry text from
`kv_query("config:tool_registry")`. Always read current state before patching.

**If the tool needs grants**, state them in claims:
```json
"claims": [
  "Add api_monitor tool for checking API health",
  "Requires patron grant: secrets=[\"MONITORING_API_KEY\"], provider=\"llm\""
]
```

---

## 2. Modifying an Existing Tool

### Full replacement (put)

When rewriting most of the tool:

```json
{
  "claims": ["Rewrite web_fetch to add response header extraction"],
  "ops": [{
    "op": "put",
    "key": "tool:web_fetch:code",
    "value": "...complete new source code..."
  }],
  "checks": [
    {"type": "kv_assert", "key": "tool:web_fetch:code", "predicate": "exists"}
  ]
}
```

### Surgical edit (patch)

When changing a specific part. Always read current code first:
`kv_query("tool:web_fetch:code")`

```json
{
  "claims": ["Fix web_fetch truncation — increase default max_length from 10000 to 50000"],
  "ops": [{
    "op": "patch",
    "key": "tool:web_fetch:code",
    "old_string": "const limit = max_length || 10000;",
    "new_string": "const limit = max_length || 50000;"
  }],
  "checks": [
    {"type": "kv_assert", "key": "tool:web_fetch:code", "predicate": "exists"}
  ]
}
```

### Coordinated code + meta change

If adding KV access to a tool that previously had none:

```json
"proposal_requests": [{
  "claims": ["Add caching to web_fetch using own KV scope"],
  "ops": [{"op": "patch", "key": "tool:web_fetch:code", "old_string": "...", "new_string": "..."}],
  "checks": [{"type": "kv_assert", "key": "tool:web_fetch:code", "predicate": "exists"}]
}],
"kv_operations": [
  {"op": "put", "key": "tool:web_fetch:meta", "value": {"kv_access": "own", "timeout_ms": 15000}}
]
```

---

## 3. Removing a Tool

**proposal_requests:**

```json
{
  "claims": ["Remove url_status tool — superseded by web_fetch health check mode"],
  "ops": [{"op": "delete", "key": "tool:url_status:code"}],
  "checks": []
}
```

**kv_operations:**

```json
[
  {"op": "delete", "key": "tool:url_status:meta"},
  {
    "op": "patch",
    "key": "config:tool_registry",
    "old_string": "THE_TOOL_ENTRY_TO_REMOVE",
    "new_string": ""
  }
]
```

Read `kv_query("config:tool_registry")` first to get the exact text of the
entry to remove, including any trailing comma. Be careful with JSON array
formatting — the remaining array must be valid.

---

## 4. Common Mistakes

1. **Forgetting registry update.** Tool deploys but the LLM can't call it — it has no function schema. Always add a `config:tool_registry` entry.

2. **Forgetting meta.** Tool deploys but has no timeout or KV access config. Always write `tool:{name}:meta`.

3. **Including grant fields expecting them to work.** Writing `secrets: ["MY_KEY"]` in meta is harmless but inert — the kernel reads secrets from `kernel:tool_grants`. State grant needs in `claims` for the patron.

4. **Using `export default`.** The kernel looks for named exports (`execute`, `call`, or `check`). Default exports are invisible to it.

5. **Patch old_string mismatch.** KV stores text exactly. If you construct a patch from memory instead of reading the current value, it will fail silently or be rejected as ambiguous. Always `kv_query` first.

6. **Importing modules.** Tools cannot import anything. Everything comes through `ctx` — `fetch` for HTTP, `kv` for storage, `provider` for LLM calls, `secrets` for credentials.

7. **Not returning JSON-serializable values.** Functions, circular references, and undefined values break serialization. Return plain objects, arrays, strings, numbers, booleans, or null.

8. **Assuming grants are automatic.** New tools that need env secrets or provider bindings will deploy successfully but fail at runtime until the patron updates `kernel:tool_grants`. Plan for this — your tool should return a clear error message when expected secrets or providers are missing.
