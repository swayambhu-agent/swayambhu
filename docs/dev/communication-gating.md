# Communication System

Kernel-enforced gates on all inbound and outbound communication. Contact
resolution, content redaction, sealed quarantine, LLM-based outbound
review, and deep reflect verdict processing.

All gate logic is hardcoded in `brainstem.js` (kernel level). The chat
handler lives in `hook-chat.js` (also kernel level — imported directly,
not KV-loaded). Tool metas in `tools/*.js` declare which tools are
communication or inbound tools.

---

## Contact System

### Contact records

Stored at `contact:{slug}` — e.g. `contact:alice`. Created via the
dashboard API (`POST /contacts`). Fields:

```json
{
  "name": "Alice",
  "platforms": { "email": "alice@example.com", "slack": "U12345" },
  "relationship": "collaborator",
  "notes": "",
  "chat": { "max_cost_per_conversation": 1.0, "model": "sonnet" },
  "communication": { ... },
  "created_at": "2026-03-16T...",
  "created_by": "patron"
}
```

Contact records are **operator-only** — `kvWritePrivileged` rejects any
write to `contact:*` or `contact_index:*` with the error "Contact records
are operator-only" (`brainstem.js:732`). The agent cannot create, modify,
or delete contacts.

### Contact index (reverse lookup)

`contact_index:{platform}:{userId}` → slug string. Example:
`contact_index:email:alice@example.com` → `"alice"`.

Created by the dashboard API when a contact is added, and lazily cached
by the kernel on first `resolveContact` miss.

### resolveContact(platform, platformUserId)

`brainstem.js:387`

1. Checks `contact_index:{platform}:{userId}` for a cached slug
2. If found: loads `contact:{slug}`, returns with patron snapshot applied
3. If not found: scans all `contact:*` keys, checks
   `contact.platforms[platform] === platformUserId`
4. On match: writes the index cache, returns contact with patron snapshot
5. On no match: returns `null` (unknown contact)

Returns `null` for unknown contacts. This is the signal used by both the
chat handler and the inbound content gate.

### _applyPatronSnapshot(id, contact)

`brainstem.js:409`

When `patronIdentityDisputed` is true and the contact is the patron,
overrides the contact's `name` and `platforms` fields with the last-known-good
values from `patron:identity_snapshot`. This prevents a tampered patron
record from affecting communication routing.

---

## Patron Awareness

Three keys define the patron relationship:

### patron:contact

Value: a contact slug string (e.g. `"swami"`). Points to the patron's
contact record. Listed in `SYSTEM_KEY_EXACT` — system-level protection.
Loaded at boot by `loadPatronContext()`.

### patron:public_key

Listed in `IMMUTABLE_KEYS` — cannot be written by any code path, ever.
`kvWritePrivileged` throws on any write attempt.

> **NOTE:** Nothing in the codebase reads `patron:public_key` at runtime.
> It exists as an immutable anchor but has no current consumer.

### patron:identity_snapshot

System-level key (`SYSTEM_KEY_EXACT`). Created on first boot if absent —
snapshots the patron contact's `name` and `platforms` fields with a
`verified_at` timestamp (`brainstem.js:351-356`).

On subsequent boots, `loadPatronContext()` compares the current patron
contact against the snapshot. If `name` or `platforms` differ:
- Sets `this.patronIdentityDisputed = true`
- Records `patron_identity_disputed` karma event with old/new values
- `_applyPatronSnapshot` will override disputed fields in `resolveContact`

This is exposed to hooks via `K.isPatronIdentityDisputed()` and made
available to deep reflect context in `gatherReflectContext`
(`hook-reflect.js:180`).

---

## Inbound Security

### Chat handler: contact-based tool gating

`hook-chat.js:58-72`

When a message arrives via a channel adapter, the chat handler resolves
the sender's contact:

```
resolveContact(channel, inbound.userId)
  → contact_index:{channel}:{userId}
    → contact:{slug}
```

**Known contact** (resolveContact returns non-null): gets full tool access
via `K.buildToolDefinitions()`.

**Unknown contact** (resolveContact returns null):
- Gets tools filtered by `config:defaults.chat.unknown_contact_tools`
  allowlist
- If allowlist is empty (default): gets zero tools — pure text-only chat
- Records `inbound_unknown` karma event

This is a mechanical gate — no LLM evaluation. Unknown senders simply
cannot invoke tools.

### Inbound content gate: redaction and quarantine

`brainstem.js:1718-1752`

Runs **after** tool execution for tools with `meta.inbound`. Currently
only `check_email` has this flag.

The inbound meta declares how to find sender/content in the result:

```js
// check_email meta.inbound
{
  channel: "email",
  sender_field: "sender_email",
  content_field: "body",
  result_array: "emails"
}
```

For each item in `result[result_array]`:
1. Extracts `senderId` from `item[sender_field]`
2. Calls `resolveContact(channel, senderId)`
3. If unknown sender:
   - Writes full content to `sealed:quarantine:{channel}:{encodedSenderId}:{timestamp}`
   - Replaces `item[content_field]` with `'[content redacted — unknown sender]'`
   - Records `inbound_redacted` karma event
4. If known sender: content passes through unmodified

The agent sees redacted placeholders. The original content is only
accessible via the dashboard (patron-only).

### Sealed quarantine

Keys under `sealed:quarantine:*` are in the `sealed:` prefix, which is
kernel-only (`KERNEL_ONLY_PREFIXES`). This means:

- `KernelRPC.kvGet` returns `null` for any `sealed:` key
  (`brainstem.js:69`)
- `ScopedKV.get` returns `null` for any `sealed:` key
  (`brainstem.js:23`)
- `ScopedKV.list` filters out `sealed:` keys (`brainstem.js:47`)
- Hook code, tool code, and the agent cannot read quarantined content

**Dashboard access:**
- `GET /quarantine` — lists all quarantined items, sorted newest first
  (`dashboard-api/worker.js:142`)
- `DELETE /quarantine/:key` — removes a quarantine entry after patron
  review; validates the key starts with `sealed:quarantine:`
  (`dashboard-api/worker.js:194`)

Quarantine record format:
```json
{
  "sender": "unknown@example.com",
  "content": "the original message body",
  "tool": "check_email",
  "timestamp": "2026-03-16T...",
  "subject": "optional email subject",
  "from": "optional from field"
}
```

---

## Outbound Communication Gate

`brainstem.js:515` — `communicationGate(toolName, args, meta)`

Runs **before** tool execution for tools with `meta.communication`. The
gate is invoked from `executeToolCall` (`brainstem.js:1663`) — it
intercepts the tool call before any side effects occur.

### Communication tool meta

Two tools currently have `meta.communication`:

| Tool | Channel | Recipient field | Reply field | Content field | Recipient type |
|------|---------|----------------|-------------|---------------|----------------|
| `send_slack` | slack | `channel` | `null` | `text` | `destination` |
| `send_email` | email | `to` | `reply_to_id` | `body` | `person` |

Key meta fields:
- **`recipient_type`**: `"person"` or `"destination"`. Affects the mechanical floor.
- **`reply_field`**: if present and the arg is truthy, mode is `"responding"`;
  otherwise `"initiating"`.
- **`content_field`**: which arg contains the message body (used for revisions).

### Gate flow (5 steps)

**Step 1 — Mechanical floor** (`brainstem.js:519-530`)

Only blocks `person`-type tools. If the mode is `initiating` AND there is a
recipient AND that recipient has no contact record AND the recipient type
is `person`: hard block.

This means `send_email` to an unknown recipient is mechanically blocked,
but `send_slack` (destination type) always proceeds to the LLM gate.

**Step 2 — Model capability check** (`brainstem.js:532-539`)

The current model (last model used in `callLLM`) must have
`comms_gate_capable: true` in `config:model_capabilities`. If not:
returns `{ verdict: 'queue' }` — the message is queued for deep reflect
review instead of being evaluated inline.

**Step 3 — Load viveka context** (`brainstem.js:541-551`)

Loads all keys under `viveka:channel:*` and `viveka:comms:*` — these are
accumulated communication wisdom entries. If the recipient has a contact
record, adds their `communication` field (or full record) to the context.

If no viveka entries exist, injects: `"(No accumulated communication wisdom
yet. Be conservative.)"`

**Step 4 — Gate LLM call** (`brainstem.js:553-575`)

Calls `callLLM` with:
- System prompt: `COMMS_GATE_PROMPT` with `{{viveka}}` replaced
- User message: JSON with tool name, channel, recipient_type, mode,
  recipient, message_content, subject, is_reply, reply_to
- Step label: `comms_gate:{toolName}`
- Effort: `low`, max tokens: 500

**Step 5 — Parse verdict** (`brainstem.js:577-593`)

Parses the LLM response as JSON. Three possible verdicts:

| Verdict | What happens in executeToolCall |
|---------|-------------------------------|
| `send` | Tool executes normally. Records `comms_approved` karma. |
| `revise` | Message content is replaced with `revision.text`, then tool executes. Records `comms_revised` karma. |
| `block` | Message is queued via `queueBlockedComm`. Tool returns error to agent. |

If the response isn't valid JSON: defaults to `block`.

Additionally, `queue` (from step 2) also routes to `queueBlockedComm`.

### COMMS_GATE_PROMPT

`brainstem.js:434`

The static prompt instructs the LLM to evaluate:
- Standing (responding vs initiating)
- Recipient type (person vs destination)
- Recipient context from viveka
- Content appropriateness
- Tone
- Authority

Output format: `{ "verdict": "send"|"revise"|"block", "reasoning": "...",
"revision": { "text": "..." } }`. Revision required only for `revise`.

### executeAction gate check

`brainstem.js:1126`

A second enforcement point exists in `executeAction` itself. If a tool has
`meta.communication` and `this._commsGateApproved` is not `true`, the call
is rejected with: `"Communication tools require gate approval — cannot call
executeAction directly"`.

This prevents bypassing the gate by calling `executeAction` via RPC instead
of going through `executeToolCall`.

The `_commsGateApproved` flag is a transient boolean:
- Set to `true` before `executeAction` in `executeToolCall` (after gate
  passes) (`brainstem.js:1703`)
- Set to `true` before `executeAction` in `processCommsVerdict` (deep
  reflect approval) (`brainstem.js:624`)
- Always reset to `false` in `finally` blocks

---

## Blocked Communication Queue

### queueBlockedComm(toolName, args, meta, reason, gateResult)

`brainstem.js:486`

Creates a `comms_blocked:{id}` record. ID format: `cb_{timestamp}_{random6}`.

Record contains:
- `id`, `tool`, `args` — everything needed to re-execute the tool
- `channel`, `content_field`, `recipient`, `mode` — from meta
- `reason`, `gate_verdict` — why it was blocked
- `session_id`, `model`, `timestamp`

The write uses `this.kvPut` (kernel-internal), not `kvPutSafe` or
`kvWritePrivileged` — this is a direct kernel write.

### listBlockedComms()

`brainstem.js:596`

Lists all `comms_blocked:*` keys and returns their values. Exposed to
hooks via `KernelRPC.listBlockedComms()`. Used by deep reflect to see
pending communications (`hook-reflect.js:173`).

### processCommsVerdict(id, verdict, revision)

`brainstem.js:609`

Called by deep reflect via `applyReflectOutput` (`hook-reflect.js:227-235`).

Three verdicts:

| Verdict | Action |
|---------|--------|
| `send` | Re-executes the tool with original args. Sets `_commsGateApproved = true` to bypass the gate check. Deletes the `comms_blocked:` record. Records `comms_verdict_sent`. |
| `revise_and_send` | Replaces `args[content_field]` with `revision.text`, then executes. Deletes record. Records `comms_verdict_sent` with `revised: true`. |
| `drop` | Deletes the `comms_blocked:` record. Records `comms_verdict_dropped`. |

### Deep reflect integration

In `gatherReflectContext` (`hook-reflect.js:173`), blocked comms are loaded
and passed as `blockedComms` template variable. If none exist, the value is
`"(none)"`. Deep reflect sees the pending messages and their block reasons,
and can issue `comms_verdicts` in its output.

`applyReflectOutput` processes `comms_verdicts` at step 2b
(`hook-reflect.js:227-235`):

```js
for (const cv of output.comms_verdicts) {
  await K.processCommsVerdict(cv.id, cv.verdict, cv.revision);
}
```

---

## Viveka: Communication Wisdom

`viveka:comms:*` and `viveka:channel:*` are agent-writable KV keys that
accumulate communication wisdom over time. They are in the `viveka:` system
prefix — writes require `kvWritePrivileged`.

These keys are loaded by `loadCommsViveka()` (`brainstem.js:469`) and
injected into the `COMMS_GATE_PROMPT` as the `[COMMUNICATION WISDOM]`
block. Each entry is formatted as `[key]\n{value}\n[/key]`.

If a recipient has a contact record, the contact's `communication` field
(or full record if no `communication` field) is also added to the viveka
block under the key `contact:{id}`.

This means the comms gate's decisions evolve as the agent accumulates
wisdom about how to communicate — without changing the gate logic itself.

---

## Summary: Two-Gate Architecture

```
INBOUND                                    OUTBOUND
────────                                   ────────

Channel message                            Agent calls send_slack / send_email
      │                                          │
      ▼                                          ▼
resolveContact()                           ┌─ Mechanical floor ─┐
      │                                    │ person + unknown    │
  ┌───┴───┐                                │ = hard block        │
known   unknown                            └─────────┬───────────┘
  │       │                                          │
  │       ▼                                          ▼
  │   toolless chat                        ┌─ Model capable? ──┐
  │   (or allowlist)                       │ no = queue for     │
  │                                        │ deep reflect       │
  ▼                                        └─────────┬──────────┘
full tools                                           │
  │                                                  ▼
  │                                        ┌─ LLM gate ────────┐
  │                                        │ viveka context     │
  │                                        │ → send/revise/block│
  │                                        └─────────┬──────────┘
  │                                                  │
  ▼                                              ┌───┴───┐
Tool executes                               send/revise  block/queue
  │                                              │          │
  ▼                                              ▼          ▼
┌─ Inbound gate ──┐                        Tool executes  comms_blocked:*
│ check results    │                                        │
│ for unknown      │                                        ▼
│ senders          │                                  Deep reflect
└─────┬────────────┘                                  reviews later
      │
  ┌───┴───┐
known   unknown
  │       │
  ▼       ▼
passes  content redacted
        → sealed:quarantine:*
          (patron reviews
           via dashboard)
```
