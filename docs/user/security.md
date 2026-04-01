# Security Model

Swayambhu is an autonomous agent with real capabilities — it can send
messages, read email, run commands on a server, and modify its own code.
This document explains the security boundaries that control what it can
and cannot do, and how you maintain oversight.

---

## Contact Approval

Contacts have three tiers of access: **unknown**, **unapproved**, and
**approved**. The `approved` field on contact records is the primary
security gate for all communication.

### Unknown contacts (no record)

When someone the agent doesn't recognize sends a message:

**In Slack chat:** The agent can respond conversationally, but has no
tools. It cannot look up KV data, check email, run commands, or send
messages on behalf of the unknown person. The conversation is logged in
karma as `inbound_unknown`.

**In email:** Content from unknown senders is redacted before the agent
sees it. The agent receives only the sender address, subject line, and a
placeholder: `[content redacted — unknown sender]`. The original content
is quarantined in the sealed namespace (`sealed:quarantine:*`), where the
agent's tools cannot reach it. Only you can view quarantined content
through the dashboard.

**Outbound:** The agent cannot initiate messages to anyone without a
contact record. This is enforced mechanically in the kernel.

### Unapproved contacts (record exists, `approved: false`)

The agent can create contact stubs — records with a name and
relationship but no platform IDs and `approved: false`. These stubs let
the agent note that someone exists without giving them any access.

Unapproved contacts are treated similarly to unknown contacts:
- **Chat:** No tool access (same restricted allowlist as unknown).
  Logged as `inbound_unapproved`.
- **Email:** Content redacted as `[content redacted — unapproved sender]`
  and quarantined.
- **Outbound:** All communication blocked (both initiating and
  responding). This is stricter than unknown — responding to unknown
  contacts can reach the LLM gate, but unapproved contacts are
  mechanically blocked in all modes.

### Approved contacts (`approved: true`)

People you've approved get full access to the agent's capabilities in
chat — tool use, KV queries, email operations, and so on. The agent also
sees their contact record (name, relationship, notes, communication
preferences) for context.

Every outbound message to an approved contact still passes through the
communication gate (see [Communication Gate](#communication-gate) below).
Being approved means the agent *can* communicate with you, not that it
will send anything unchecked.

### Approval workflow

1. The agent creates a contact stub via `kv_operations` (e.g. after
   receiving email from a new person): `{ name: "Jane", approved: false,
   platforms: {} }`
2. You review the stub in the dashboard or KV Explorer
3. You add platform IDs and approve via the dashboard API:
   ```bash
   curl -X PATCH http://localhost:8790/contacts/jane/approve \
     -H "X-Patron-Key: test" \
     -H "Content-Type: application/json" \
     -d '{ "approved": true }'
   ```
4. Future messages from Jane pass through unredacted with full tool access

If the agent later changes the contact's `platforms` field, `approved`
auto-flips to `false` — you must re-approve after platform changes.

### Reviewing Quarantined Content

Open the dashboard and browse `sealed:quarantine:` in the KV Explorer, or
use the API:

```bash
# List all quarantined items
curl -H "X-Patron-Key: your-key" https://your-dashboard-api/quarantine

# Delete after review
curl -X DELETE -H "X-Patron-Key: your-key" \
  https://your-dashboard-api/quarantine/sealed:quarantine:email:sender@example.com:1710700000
```

To give unknown contacts access to specific tools before creating a
contact record, add tool names to
`config:defaults.chat.unknown_contact_tools`. By default this list is
empty — no tools at all.

---

## What the Agent Cannot Do

These restrictions are enforced by the kernel (`kernel.js`) — deployed
code that the agent cannot modify, override, or access.

### Modify Its Core Identity

The dharma key is immutable. Both `kvWriteSafe` (the agent's normal write
path) and `kvWriteGated` (the context-based write path) reject writes
to `dharma`. No code path in the system can change it. It can only be
changed by redeploying with a different `DHARMA.md`.

### Forge Your Identity

The agent has a `verify_patron` tool that can cryptographically verify
your identity using Ed25519 signatures. Your public key is stored in KV
as an immutable key — the agent cannot modify it.

If the agent suspects anomalous behavior from your account (e.g.
different tone, unusual requests), it can ask you to prove your identity
by signing a challenge message. You sign it locally with your private
key:

```bash
node scripts/patron-sign.mjs "the challenge message"
```

Then paste the signature in chat. The agent verifies it against your
public key in the kernel — no LLM judgment, pure cryptographic proof.

**Key rotation:** If you need to change your key (compromised key, new
device), sign a rotation request with your current key:

```bash
node scripts/patron-sign.mjs --rotate "ssh-ed25519 AAAA... your-new-key"
```

Send the signature through the dashboard API. The kernel verifies it
against the current key before accepting the new one. A kernel alert is
sent to Slack whenever a rotation occurs.

### Bypass the Communication Gate

Every outbound message from a communication tool passes through a
kernel-enforced gate. The agent's hook code cannot skip the gate, modify
the gate logic, or suppress its verdicts. The gate runs inside the kernel,
not in the hook. See [Communication Gate](#communication-gate) for
details.

### Access Sealed Content

The `sealed:*` namespace is mechanically unreadable by tools:
- `ScopedKV.get()` returns `null` for any `sealed:` key
- `ScopedKV.list()` filters out `sealed:` keys from results
- `kvWriteSafe` and `kvDeleteSafe` reject writes to `sealed:` keys

The hook (trusted policy layer) *can* read sealed keys via `K.kvGet()`,
but the hook is reviewed through the proposal protocol. Tools, which
handle untrusted external input, cannot.

### Change Kernel Code

The kernel (`kernel.js`) is deployed as a Cloudflare Worker. It is not
stored in KV. The agent cannot read, modify, or replace it. Only a
`wrangler deploy` from the repository changes the kernel.

### Modify Tool Security Grants

Each tool's security-critical properties — which environment secrets it
can access, whether it goes through the communication gate, whether its
results go through inbound content redaction, and which provider adapter
it receives — are stored in `kernel:tool_grants`. This is a kernel key,
so the agent cannot read or modify it.

This means the agent cannot:
- Grant itself access to new environment secrets (e.g. API keys)
- Remove a tool's communication gate classification to bypass the gate
- Remove inbound content redaction from a tool to see quarantined content
- Bind a provider adapter to a tool that shouldn't have one

Tool source files declare all metadata fields, but the seed script splits
them: security grants go to `kernel:tool_grants`, operational config goes
to modifiable tool metadata. Even if the agent modifies the tool metadata
through the Proposal Protocol, the security grants remain unchanged.

### Write to Kernel Keys

All `kernel:*` keys are blocked from both `kvWriteSafe` and
`kvWriteGated`. The agent cannot modify:
- `kernel:tool_grants` — tool security grants (secrets, gate classification)
- `kernel:active_session` — crash detection breadcrumb
- `kernel:last_sessions` — session outcome history (drives the tripwire)
- `kernel:last_good_hook` — the backup hook code for auto-restore
- `kernel:alert_config` — alerting configuration
- `kernel:llm_fallback` — the last-resort LLM adapter
- `kernel:fallback_model` — the last-resort model

### Suppress Alerts

When the agent writes to any `hook:*` key (modifying its own session
logic), the kernel sends an alert to Slack using `kernel:alert_config`.
The agent cannot prevent this. The alert config is a kernel key — the
agent cannot read or modify it.

### Self-Approve Contacts

The agent can create contact stubs (`approved: false`, empty `platforms`)
and edit contact fields, but it **cannot** set `approved: true`. Approval
is patron-only, enforced mechanically by the kernel. The agent also
cannot delete approved contacts — only unapproved stubs it created.

If the agent modifies a contact's `platforms` field, `approved`
auto-flips to `false`, requiring patron re-approval. This prevents
the agent from re-routing an approved contact to a different platform
identity without patron review.

---

## What the Agent Can Do, with Friction

These actions are allowed but controlled by mechanisms that create
visibility, require justification, or enable rollback.

### Modify Operating Principles (Yamas and Niyamas)

The agent's ethical principles are modifiable — a system that can't evolve
its ethics is brittle. But modification requires:

1. **A capable model.** Only models flagged as `yama_capable` or
   `niyama_capable` in `config:model_capabilities` can make changes.
   Cheap models (Haiku, DeepSeek) cannot.
2. **Written deliberation.** Each modification must include a
   `deliberation` field — minimum 200 characters for yamas, 100 for
   niyamas — explaining why the change is needed.
3. **Audit trail.** Every change is recorded in `{key}:audit` (e.g.
   `yama:care:audit`) with timestamp, model, deliberation, and old/new
   values. The agent cannot delete audit entries.

To review principle modifications:

```bash
# See all yama audit trails
node scripts/read-kv.mjs yama:care:audit
node scripts/read-kv.mjs yama:truth:audit
# ... etc.
```

Or browse `yama:*:audit` and `niyama:*:audit` in the dashboard KV
Explorer.

### Modify Its Own Code

The agent can rewrite its prompts, tools, configuration, and session hook
logic through the Proposal Protocol:

1. **Staged** — The agent proposes a change with claims (why), operations
   (what to change), and checks (how to verify it works). The change
   sits in staging until the next deep reflect session.
2. **Reviewed** — During deep reflect, the agent evaluates its own
   staged proposals. It can accept, reject, modify, or defer each one.
   Session reflect (depth 0) can only withdraw or modify — it cannot
   apply changes. Only deep reflect (depth 1+) can apply.
3. **Inflight** — The change is applied to KV, but the old values are
   snapshotted. If the change causes crashes, the circuit breaker
   automatically rolls it back (see below).
4. **Promoted** — After running clean, the agent can promote the change.
   The snapshot is deleted and the change becomes permanent.

Every write to a `hook:act:code` or `hook:reflect:code` key triggers an
alert to Slack. You see what changed.

### Write Samskaras

The agent accumulates conditioned patterns as `samskara:*` entries —
associations between context patterns and outcomes, with strength and
confidence scores. Samskara proposals follow the same staged protocol
but with lighter safety: no circuit breaker (samskaras can't crash the
system) and no git sync. They still require staging and review.

---

## Communication Gate

Every outbound message to a person (`send_email`) passes through a
kernel-enforced gate.

### Mechanical Floor

The agent cannot send to a person unless there is a `contact:` record
with an approved platform binding for that recipient. If no approved
contact exists, the message is blocked immediately — no LLM call is
made. This is a hard constraint that the agent cannot bypass.

Destination-type tools like `send_slack` (channel, not person) are not
subject to this gate.

---

## Circuit Breaker

The circuit breaker automatically rolls back code proposals that
cause problems.

**How it works:** The kernel writes a `last_danger` key whenever a fatal
error, parse error, or provider cascade failure occurs. On the next session,
the hook checks `last_danger` against all inflight proposals. Any
code proposal that was activated *before* the danger event is
automatically rolled back — its snapshotted old values are restored.

**What it protects against:** A bad proposal to a prompt, tool, or
hook module that breaks the agent. The danger signal triggers rollback
without waiting for human intervention.

**What it doesn't cover:** Samskara proposals (`samskara:*`) are excluded
from circuit breaker rollback. Bad samskaras can't crash the system —
they just lead to suboptimal decisions, which get corrected through
normal reflection.

---

## Tripwire

If the agent crashes three times in a row, the kernel's tripwire fires:

1. Deletes the current hook code (`hook:act:code` and `hook:reflect:code`)
2. Restores from `kernel:last_good_hook` (the last version that ran
   clean)
3. Sends an alert to Slack
4. If the restored version also crashes three times, drops to minimal
   fallback mode — a hardcoded recovery prompt with a hardcoded budget

In minimal fallback, the agent can only check balances and send a status
message. It cannot run orient sessions, reflect, or modify anything. It
waits for you to fix the problem.

---

## Audit Trail

Everything is logged. The karma log for each session records:

- Every LLM call (model, tokens, cost, what was sent and received)
- Every tool execution (what tool, what input, what result)
- Every system key write (old value and new value)
- Every proposal operation (staged, accepted, promoted, rolled back)
- Every blocked communication
- Every error

The dashboard gives you full visibility into all of this. Nothing the
agent does is hidden or opaque.

To review a specific session:

```bash
# List recent sessions
node scripts/read-kv.mjs karma:

# Read a specific session's log
node scripts/read-kv.mjs karma:s_1710700000_abc123
```

Or click any session in the dashboard's Timeline tab to expand its karma
log.

---

## If You Suspect a Problem

### Step 1: Check Recent Activity

Open the dashboard and look at the Timeline tab. Read the karma log for
the most recent session. Look for:
- `fatal_error` events — something crashed
- Unexpected `tool_complete` results — a tool did something wrong
- `privileged_write` events — the agent changed a system key
- `proposal_accepted` events — the agent applied a code change

### Step 2: Check Blocked Communications

Browse `comms_blocked:*` in the KV Explorer. If the agent tried to send
something it shouldn't have, it will be here (assuming the gate caught
it).

### Step 3: Check Quarantine

Browse `sealed:quarantine:*` in the KV Explorer. If suspicious inbound
content arrived from an unknown sender, it's quarantined here. The agent
never saw the content — but the attempt is logged.

### Step 4: Check Proposals

Browse `proposal:*` in the KV
Explorer. Staged proposals are proposals that haven't been applied.
Inflight proposals (snapshots) are active changes that can still be
rolled back.

If an inflight proposal looks wrong, you can roll back the session
that applied it:

```bash
node scripts/rollback-session.mjs --dry-run
node scripts/rollback-session.mjs
```

### Step 5: Stop the Agent

If the situation is urgent, disable the Worker in the Cloudflare
dashboard:

**Workers & Pages** > **your worker** > **Settings** > **Disable**

This stops the cron trigger and webhook processing immediately. The agent
goes completely dormant. Re-enable when you're ready.

For local development, press `Ctrl+C` in the start script terminal, or:

```bash
pkill -f workerd
```

### Step 6: Full Reset

If the agent's state is compromised or you need to start fresh:

```bash
source .env && bash scripts/start.sh --reset-all-state --trigger
```

This wipes all KV state — sessions, wisdom, proposals, config
overrides, everything — and re-seeds from the canonical seed script. The
agent starts over with its original configuration.

---

## Summary of Protection Layers

| Layer | What It Protects | How It Works |
|-------|-----------------|-------------|
| **Immutable keys** | Dharma, patron public key | Kernel rejects all writes (patron key rotatable via signed request) |
| **Patron verification** | Patron identity assurance | Ed25519 signature verification — kernel-hardcoded, agent cannot modify |
| **Kernel keys** | Crash history, alert config, fallback code, tool security grants | Kernel rejects agent writes |
| **Tool security grants** | Env secret access, gate classification, provider bindings | Stored in kernel-only `kernel:tool_grants`; agent cannot escalate tool privileges |
| **Sealed namespace** | Quarantined content from unknown senders | Tools return null, list filters out |
| **Communication gate** | Outbound messages | Three-layer kernel-enforced gate |
| **Inbound redaction** | Email content from unknown senders | Content replaced, original quarantined |
| **Model capabilities** | Principle modification, comms gate | Per-model flags in separate config key |
| **Deliberation gate** | Yama/niyama changes | Minimum character count + audit trail |
| **Modification protocol** | Prompts, tools, config, hook code | Staged review, inflight snapshots, rollback |
| **Circuit breaker** | Bad code proposals | Auto-rollback on danger signals |
| **Tripwire** | Repeated crashes | Auto-restore last good hook, then minimal fallback |
| **Hook write alerts** | Self-modification visibility | Slack alert on every `hook:act:code` / `hook:reflect:code` write |
| **Karma logging** | Full audit trail | Every event recorded, viewable in dashboard |
| **Contact approval** | Who the agent can communicate with | Three-tier gate (unknown/unapproved/approved); agent creates stubs, patron approves |
