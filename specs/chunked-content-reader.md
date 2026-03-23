# Chunked Content Reader

## Problem

Long content (email threads, web pages, documents, large KV values) can
blow up LLM context windows and token budgets. Currently `check_email`
returns full email bodies and `web_fetch` returns full page content.
A 10-reply email thread can be 20KB+ (50K tokens). Ten such emails in
an act session would overflow the context window.

Truncation is the wrong fix — it chops blindly and may cut the important
part. The agent should decide what to read and how much.

## Design

### Core concept: content handles

Tools that return large content return a **preview + handle** instead of
the full content. The agent uses a generic `read_content` tool to fetch
chunks by handle.

### Tool changes

Tools that produce large content add a `content_handle` pattern:

```javascript
// check_email returns:
{
  id: "msg_1",
  from: "ilya@openai.com",
  sender_email: "ilya@openai.com",
  subject: "Collaboration inquiry",
  date: "2026-03-15T10:00:00Z",
  body_preview: "Hi, I saw your work on autonomous agents and wanted to...",
  body_length: 8500,
  content_handle: "email:msg_1:body"
}

// web_fetch returns:
{
  url: "https://example.com/article",
  title: "Some Article",
  body_preview: "This article explores the intersection of...",
  body_length: 45000,
  content_handle: "web:sha256abc:body"
}
```

`body_preview` is the first N characters (e.g. 500). Enough for the
agent to decide if it needs more. `content_handle` is an opaque
reference to the full content stored temporarily in KV.

### New tool: `read_content`

```javascript
export const meta = {
  secrets: [],
  kv_access: "read_all",
  timeout_ms: 5000,
};

// Read a chunk of content by handle.
// handle: opaque content reference from a tool result
// offset: character offset to start reading from (default 0)
// limit:  max characters to return (default 5000)
export async function execute({ handle, offset, limit, kv }) {
  const data = await kv.get(`content_cache:${handle}`);
  if (!data) return { error: "content expired or not found" };

  const start = offset || 0;
  const end = start + (limit || 5000);
  const chunk = data.slice(start, end);

  return {
    handle,
    chunk,
    offset: start,
    length: chunk.length,
    total_length: data.length,
    has_more: end < data.length,
  };
}
```

### Content cache

Tools store full content in KV at `content_cache:{handle}` with a short
TTL (e.g. 1 hour via `expirationTtl`). This is ephemeral — not part of
the agent's permanent state. Just a buffer for the current session to
read from.

```javascript
// Inside check_email, after fetching each message:
const handle = `email:${msg.id}:body`;
await kv.put(`content_cache:${handle}`, msg.body, { expirationTtl: 3600 });
```

### Inbound gate interaction

The inbound content gate operates on the preview, not the full content.
For unknown senders:
- `body_preview` is redacted to `[content redacted — unknown sender]`
- `content_handle` is removed (agent can't read the full content)
- Full content is quarantined under `sealed:quarantine:*` as today

For known senders:
- Preview + handle returned normally
- Agent reads chunks as needed via `read_content`

### Preview length

Default 500 characters. Configurable per tool in meta if needed. Long
enough to understand context, short enough to keep act sessions lean
when processing many items.

## Scope

Tools that would use this pattern:
- `check_email` — email bodies (especially threads)
- `web_fetch` — web page content
- `kv_read` — large KV values (if any)
- Future: `read_document`, `read_pdf`, etc.

## Benefits

- Agent controls what it reads — no blind truncation
- Token-efficient: act scans previews, only deep-reads what matters
- Generic: one pattern for all content types
- Composable with inbound gate: handle removal = mechanical content block
- Content cache is ephemeral (TTL) — no state bloat

## Complexity

- Tools need to write to `content_cache:*` (requires `kv_access: "own"` or a new scope)
- Cache cleanup via TTL (Cloudflare KV supports `expirationTtl` natively)
- `read_content` tool needs `kv_access: "read_all"` to read `content_cache:*`
- Tool registry needs `read_content` added
- Existing tools (check_email, web_fetch) need migration to preview + handle pattern

## Status

Parked. Current approach (full content) works for most cases. Implement
when long content becomes a problem in practice (act budget overruns,
context window overflow, email thread explosion).
