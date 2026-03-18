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

Stored at `contact:{slug}` — e.g. `contact:alice`. Can be created by the
dashboard API (`POST /contacts`) or by the agent via `kv_operations`.
Fields:

```json
{
  "name": "Alice",
  "approved": true,
  "platforms": { "email": "alice@example.com", "slack": "U12345" },
  "relationship": "collaborator",
  "notes": "",
  "chat": { "max_cost_per_conversation": 1.0, "model": "sonnet" },
  "communication": { ... },
  "created_at": "2026-03-16T...",
  "created_by": "patron"
}
```

The `approved` field is the primary gate for all communication. Contacts
must be approved before the agent can send to them, receive unredacted
content from them, or give them tool access in chat.

**Agent contact rules** (enforced by `kvWritePrivileged` in
`brainstem.js`):

| Action | Allowed? | Constraints |
|--------|----------|-------------|
| Create contact | Yes | Must have `approved: false` and empty `platforms: {}` |
| Edit contact fields | Yes | Cannot set `approved: true` |
| Change `platforms` | Yes | Auto-flips `approved` to `false` (requires re-approval) |
| Delete unapproved contact | Yes | Agent can clean up its own stubs |
| Delete approved contact | No | Operator-only |
| Set `approved: true` | No | Operator-only (via dashboard PATCH endpoint) |
| Patch `approved` field | No | Blocked explicitly to prevent string-level bypass |

**Write path:** Agent `kv_operations` → `applyKVOperation` in
`hook-protect.js` → routes `contact:*` keys to `kvWritePrivileged` →
kernel-enforced rules above. `contact_index:*` keys remain
kernel-managed (rejected by `kvWritePrivileged`).

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

Returns `null` for unknown contacts. Returns the full contact object
(including `approved` field) for known contacts. Both values are used by
the chat handler, communication gate, and inbound content gate to
enforce the three-tier access model: unknown → unapproved → approved.

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

Listed in `IMMUTABLE_KEYS` — blocked by `kvPut`, `kvPutSafe`, and
`kvWritePrivileged`. The only write path is `rotatePatronKey()`, which
bypasses the guard via direct `this.kv.put()` after verifying a
rotation signature from the current key holder.

Read by the `verify_patron` built-in tool via
`verifyPatronSignature()`. Parses the SSH ed25519 wire format to
extract the 32-byte raw key, then verifies signatures using
`crypto.subtle.verify("Ed25519", ...)`. The agent calls this tool
when it needs to confirm the patron's identity — e.g. after the
patron identity monitor detects anomalous behavior.

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

**Approved contact** (`contact?.approved === true`): gets full tool access
via `K.buildToolDefinitions()`.

**Unapproved contact** (contact exists but `approved` is false/missing):
- Gets tools filtered by `config:defaults.chat.unknown_contact_tools`
  allowlist (same as unknown)
- If allowlist is empty (default): gets zero tools — pure text-only chat
- Records `inbound_unapproved` karma event

**Unknown contact** (resolveContact returns null):
- Gets tools filtered by `config:defaults.chat.unknown_contact_tools`
  allowlist
- If allowlist is empty (default): gets zero tools — pure text-only chat
- Records `inbound_unknown` karma event

This is a mechanical gate — no LLM evaluation. Only approved contacts
get tool access.

### Inbound content gate: redaction and quarantine

`brainstem.js:1718-1752`

Runs **after** tool execution for tools whose `kernel:tool_grants` entry
includes an `inbound` field. Currently only `check_email` has this grant.

The inbound grant declares how to find sender/content in the result:

```js
// kernel:tool_grants.check_email.inbound
{
  channel: "email",
  sender_field: "sender_email",
  content_field: "body",
  result_array: "emails"
}
```

> **NOTE:** Tool source files still declare `inbound` in `export const
> meta`, but it is stripped from KV-stored `tool:{name}:meta` at seed time.
> The kernel reads inbound configuration exclusively from
> `kernel:tool_grants`, which the agent cannot modify.

For each item in `result[result_array]`:
1. Extracts `senderId` from `item[sender_field]`
2. Calls `resolveContact(channel, senderId)`
3. If unknown sender (`!contact`):
   - Writes full content to `sealed:quarantine:{channel}:{encodedSenderId}:{timestamp}`
     with `reason: "unknown sender"`
   - Replaces `item[content_field]` with `'[content redacted — unknown sender]'`
   - Records `inbound_redacted` karma event
4. If unapproved sender (`contact` exists but `!contact.approved`):
   - Same quarantine and redaction as unknown, but with
     `reason: "unapproved sender"` and message
     `'[content redacted — unapproved sender]'`
5. If approved sender: content passes through unmodified

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
  "reason": "unknown sender",
  "timestamp": "2026-03-16T...",
  "subject": "optional email subject",
  "from": "optional from field"
}
```

---

## Outbound Communication Gate

`brainstem.js:515` — `communicationGate(toolName, args, meta)`

Runs **before** tool execution for tools whose `kernel:tool_grants` entry
includes a `communication` field. The gate is invoked from
`executeToolCall` (`brainstem.js:1663`) — it intercepts the tool call
before any side effects occur.

> **NOTE:** Tool source files still declare `communication` in
> `export const meta`, but it is stripped from KV-stored `tool:{name}:meta`
> at seed time. The kernel reads communication gate configuration
> exclusively from `kernel:tool_grants`, which the agent cannot modify.
> This prevents the agent from bypassing the gate by removing the
> `communication` field from tool metadata.

### Communication tool grants

Two tools currently have a `communication` grant in `kernel:tool_grants`:

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

**Step 1 — Mechanical floor** (`brainstem.js:538-561`)

Only blocks `person`-type tools. Two checks:

1. **No contact record** + initiating mode → hard block. Responding to
   unknown contacts falls through to the LLM gate (they already reached
   out).
2. **Unapproved contact** (contact exists but `approved` is false) →
   hard block for **both** initiating and responding. All communication
   with unapproved contacts is blocked until the operator approves.

This means `send_email` to an unknown or unapproved recipient is
mechanically blocked, but `send_slack` (destination type) always
proceeds to the LLM gate.

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
resolveContact()                           ┌─ Mechanical floor ──────┐
      │                                    │ person + unknown         │
  ┌───┼────────┐                           │   = block initiating     │
  │   │        │                           │ person + unapproved      │
approved │  unknown                        │   = block ALL            │
  │  unapproved │                          └─────────┬────────────────┘
  │       │     ▼                                    │
  │       │   toolless chat                          ▼
  │       ▼   (or allowlist)               ┌─ Model capable? ──┐
  │   toolless chat                        │ no = queue for     │
  │   (or allowlist)                       │ deep reflect       │
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
│ for unknown /    │                                        ▼
│ unapproved       │                                  Deep reflect
│ senders          │                                  reviews later
└─────┬────────────┘
      │
  ┌───┼────────┐
  │   │        │
approved │  unknown
  │  unapproved │
  │       │     ▼
  ▼       ▼   [redacted — unknown sender]
passes  [redacted — unapproved sender]
        → sealed:quarantine:*
          (patron reviews
           via dashboard)
```
