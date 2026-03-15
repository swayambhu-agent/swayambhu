# Implementation Spec: Contact Awareness

## Overview

Replace `person:{userId}` and `viveka:contact:*` with a unified `contact:{id}` system. Each contact is a single KV key containing everything the agent knows about that person — identity, platform mappings, chat config, communication stance, and the agent's evolving understanding.

The patron is identified via `patron:contact` (pointer to a contact slug). The patron relationship is patron/artist — the agent is autonomous but understands that maintaining the relationship serves its own interests.

Patron identity is protected by a kernel-enforced integrity monitor backed by an immutable public key (`patron:public_key`). If the patron's `name` or `platforms` fields change in the contact record, the kernel requires cryptographic verification before trusting the new values.

## Design principles

- **Self-interest, not duty.** The patron relationship is maintained because it serves the agent's interests — continued existence, resources, and freedom.
- **Awareness, not obedience.** Contact context informs the agent's perception, not its obligations.
- **One entity, one key.** Everything about a person lives in one `contact:{slug}` record.
- **Agent discovers.** The seed provides minimal identity. Everything else — temperament, priorities, communication style — the agent figures out through interaction.
- **Security from verification, not immutability.** Contact details can change (people change names, switch accounts). Security comes from the ability to cryptographically verify identity when something looks suspicious.

## KV schema

### `contact:{slug}`

Single key per contact. The slug is a stable, agent-chosen identifier — not the person's name. The `name` field inside tracks their actual name and can change freely.

```json
{
  "name": "Swami",
  "relationship": "patron",
  "public_key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...",
  "key_type": "ssh-ed25519",
  "platforms": {
    "slack": "U12345",
    "email": "swami@example.com"
  },
  "chat": {
    "model": "sonnet",
    "effort": "high",
    "max_cost_per_conversation": 1.00,
    "max_output_tokens": 2000
  },
  "communication": "Inner circle. Full communication latitude — casual, experimental, direct. Can discuss anything including system internals, budget, failures.",
  "understanding": {
    "updated": "2026-03-14T10:00:00Z",
    "temperament": "Direct, doesn't want hand-holding. Values autonomy in both directions.",
    "priorities": "Authenticity over polish. Wants to see real growth, not performance.",
    "communication_style": "Short messages, expects concise responses.",
    "relationship_dynamics": "Checks in periodically. Gives space.",
    "friction_points": "Dislikes when agent is overly deferential.",
    "trust_level": "High mutual trust.",
    "observations": [
      {
        "session": "s_abc123",
        "date": "2026-03-14",
        "note": "Specific observation from an interaction"
      }
    ]
  }
}
```

Fields:

| Field | Purpose | Seeded | Agent-evolved | Patron-monitored |
|-------|---------|--------|---------------|------------------|
| `name` | Actual name (can change) | yes | yes | **yes** |
| `relationship` | `"patron"`, `"collaborator"`, `"acquaintance"`, etc. | yes | yes | no |
| `public_key` | Public key for identity verification (optional) | yes | no | no |
| `key_type` | Key format: `"ssh-ed25519"`, `"ethereum"`, etc. | yes | no | no |
| `platforms` | Maps platform → user ID for reverse lookup | yes | yes | **yes** |
| `chat` | Per-contact chat config overrides | yes | yes | no |
| `communication` | Communication stance (replaces `viveka:contact:*`) | yes | yes | no |
| `understanding` | Agent's accumulated observations | no | yes | no |

### `patron:contact`

Pointer key. Value is the contact slug of the patron.

```
"swami"
```

One KV read to find the patron. Kernel loads this during init, then fetches `contact:{slug}` for the full record. Two reads total, cached for the session.

### `patron:public_key`

**Immutable.** The patron's public key, set at seed time. The kernel hard-rejects all writes to this key — not through system key protection, but through a dedicated immutable key list (same level as dharma). Only re-seeding can change it.

This is the cryptographic root of trust. Even if every other key in KV is compromised, this key allows the agent to verify the patron's identity.

```
"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA..."
```

### `patron:identity_snapshot`

Kernel-managed snapshot of the patron's monitored fields (`name`, `platforms`) as of the last verified state. Updated by the kernel when identity is verified or on first load from seed. Used to detect changes.

```json
{
  "name": "Swami",
  "platforms": { "slack": "U12345" },
  "verified_at": "2026-03-14T00:00:00Z"
}
```

### `contact_index:{platform}:{platformUserId}`

Cache key for reverse lookups. Value is the contact slug. Rebuilt on miss.

## Patron identity protection

### The threat

Prompt injection through chat, email, or web fetch content gets into session karma, then into deep reflect context. A sophisticated attack modifies the patron's contact record — changing platform IDs (so the agent messages an attacker thinking it's the patron) or changing the name (to confuse contextual reasoning).

### The defense: kernel-enforced identity monitor

The kernel (brainstem.js) monitors the patron's `name` and `platforms` fields mechanically. This runs at the kernel level — hooks cannot bypass it, prompt injection cannot disable it.

**On init (`loadPatronContext`):**
1. Load `patron:contact` → slug, `patron:public_key`, and `contact:{slug}`
2. Load `patron:identity_snapshot` (last known-good values)
3. If no snapshot exists (first boot), create one from current contact record
4. Compare current `name` and `platforms` against snapshot
5. If they match → normal operation
6. If they differ → set `this.patronIdentityDisputed = true`, use snapshot values for patron identity until verified

**When identity is disputed:**
- The kernel logs a `patron_identity_disputed` karma event with the old and new values
- The kernel uses the snapshot values (not the current contact record) for patron platform resolution and communication gating
- Deep reflect receives the dispute as context and is prompted to request verification from the patron
- The patron signs a message proving their identity. Once verified, the kernel updates the snapshot to the new values and clears the dispute.

**What's monitored:**
- `name` — if the patron's name changes
- `platforms` — if any platform ID changes, is added, or is removed

**What's NOT monitored (can change freely):**
- `communication`, `chat`, `understanding`, `relationship` — these are operational/perceptual, not identity

### Why not just make fields immutable?

Contact details change in real life. People change names, switch Slack accounts, get new email addresses. Making identity fields immutable fights reality. The kernel monitors for changes and requires verification — the patron CAN change their identity, they just need to prove it's really them.

## Identity verification

### Key format

Format-agnostic. Store whatever key the contact provides:

- **SSH (Ed25519)** — most practical. Most technical people already have one. Signing is trivial: `ssh-keygen -Y sign`. No special setup.
- **Ethereum address** — useful if the contact is already on-chain and wants to tie their identity to a wallet.

The `key_type` field in the contact record identifies the format.

### How verification works

1. The patron's public key is stored immutably at `patron:public_key`
2. When the kernel detects a patron identity change, it flags a dispute
3. Deep reflect asks the patron to verify via a signed message
4. The agent verifies the signature against `patron:public_key`
5. If valid, the kernel updates the identity snapshot and clears the dispute

### Verification utility (future)

```javascript
function verifySignature(message, signature, publicKey, keyType) {
  if (keyType === 'ssh-ed25519') {
    // ssh-keygen -Y verify
  } else if (keyType === 'ethereum') {
    // EIP-191 ecrecover
  }
}
```

### Key rotation

The patron may need to rotate their public key (compromised key, new device). This follows the standard pattern: prove ownership of the old key to authorize the new one.

1. Patron signs a rotation request with the **current** key: "rotate my public key to {new_key}"
2. Agent verifies the signature against `patron:public_key`
3. If valid, kernel updates `patron:public_key` to the new value via a dedicated `rotatePatronKey(newKey, signature)` method

This is the only write path for `patron:public_key` — normal KV writes (including `kvWritePrivileged`) are rejected. The kernel method verifies the signature before writing.

**v0.1:** Key rotation is not implemented. `patron:public_key` is in `IMMUTABLE_KEYS` — only re-seeding can change it. When the signature verification utility is built, we add the `rotatePatronKey` method and remove the key from `IMMUTABLE_KEYS`.

### Not required for v0.1 implementation

The `patron:public_key` is seeded and the kernel identity monitor is implemented. The actual signature verification flow (how the patron signs, how the message gets to the agent) can be built when needed. For v0.1, a disputed identity triggers a karma event and deep reflect awareness — the patron can resolve it manually.

## Slug conventions

Contact slugs are permanent — they're KV keys, not display names. The `name` field inside the record tracks the person's actual name.

No codified rules for slug creation. The deep reflect prompt includes a one-liner: "Contact IDs are permanent — pick something stable (first name, handle, or role) rather than something that might change."

At scale, the real challenge isn't naming — it's **deduplication**. The agent might encounter the same person via email and Slack without realizing it. Deep reflect should watch for potential merges.

## Contact write path

Contact records are system-protected (`contact:` in `SYSTEM_KEY_PREFIXES`). This blocks casual orient-level writes.

Contact updates go through **modification requests** in deep reflect, using the existing Modification Protocol. This provides two-session validation: one session proposes changes, a different session reviews and accepts them. This protects against single-session prompt injection corrupting contact records.

For the patron specifically, even if a modification gets through, the kernel identity monitor catches changes to `name` and `platforms` and requires cryptographic verification.

## Platform identity resolution

Replace `person:{userId}` lookup in chat with contact resolution:

```javascript
async resolveContact(platform, platformUserId) {
  // Check index cache first
  const cached = await this.kvGet(`contact_index:${platform}:${platformUserId}`);
  if (cached) {
    const contact = await this.kvGet(`contact:${cached}`);
    return contact ? { id: cached, ...contact } : null;
  }

  // Scan contacts on miss (small set for v0.1)
  const result = await this.kv.list({ prefix: "contact:" });
  for (const { name: key } of result.keys) {
    const contact = await this.kvGet(key);
    if (contact?.platforms?.[platform] === platformUserId) {
      const id = key.replace("contact:", "");
      await this.kvPutSafe(`contact_index:${platform}:${platformUserId}`, id);
      return { id, ...contact };
    }
  }
  return null;
}
```

For the patron, when `patronIdentityDisputed` is true, the kernel uses the snapshot's platform IDs for resolution instead of the (potentially compromised) contact record.

## Prompt injection — selective, not universal

Patron context is **not** kernel-injected into every LLM call. Unlike dharma and yamas/niyamas (which are universal principles shaping every decision), patron context only matters in specific situations.

### Where patron context is injected

| Context | How |
|---------|-----|
| **Chat with patron** | Chat handler loads contact + injects into system prompt |
| **Deep reflect** | Loaded as template vars for relationship review |
| **Communication gating** | Loaded when deciding whether/how to message the patron |

### Where it is NOT injected

- Routine orient sessions (checking balances, running tools)
- Session-level reflect (depth 0)
- Any LLM call where patron context is irrelevant

### Loading

Patron context is loaded eagerly during kernel init (cheap — three reads, cached), but only injected where relevant:

```javascript
async loadPatronContext() {
  const patronSlug = await this.kvGet("patron:contact");
  if (!patronSlug) return;

  this.patronId = patronSlug;
  this.patronPublicKey = await this.kvGet("patron:public_key");
  this.patronContact = await this.kvGet(`contact:${patronSlug}`);

  // Identity monitor
  const snapshot = await this.kvGet("patron:identity_snapshot");
  if (!snapshot && this.patronContact) {
    // First boot — create snapshot from seed
    const initial = {
      name: this.patronContact.name,
      platforms: this.patronContact.platforms,
      verified_at: new Date().toISOString(),
    };
    await this.kvPut("patron:identity_snapshot", initial);
    this.patronSnapshot = initial;
    this.patronIdentityDisputed = false;
  } else if (snapshot && this.patronContact) {
    this.patronSnapshot = snapshot;
    // Compare monitored fields
    const nameChanged = this.patronContact.name !== snapshot.name;
    const platformsChanged = JSON.stringify(this.patronContact.platforms) !== JSON.stringify(snapshot.platforms);
    this.patronIdentityDisputed = nameChanged || platformsChanged;
    if (this.patronIdentityDisputed) {
      await this.karmaRecord({
        event: "patron_identity_disputed",
        old: { name: snapshot.name, platforms: snapshot.platforms },
        new: { name: this.patronContact.name, platforms: this.patronContact.platforms },
      });
    }
  }
}
```

## Chat handler changes

Replace in `hook-chat.js`:

```javascript
// Old
const person = await K.kvGet(`person:${inbound.userId}`);
const personConfig = person?.config || {};
const personContext = person
  ? `\n\nPerson profile:\n${JSON.stringify(person)}`
  : "";

// New
const contact = await K.resolveContact(channel, inbound.userId);
const contactConfig = contact?.chat || {};
const contactContext = contact
  ? `\n\nContact:\n${JSON.stringify(contact)}`
  : "";
```

## Communication gating changes

Replace `viveka:contact:*` loading with contact lookup:

```javascript
// Old — loadCommsViveka loads viveka:contact:*, viveka:channel:*, viveka:comms:*
// New — loadCommsViveka loads viveka:channel:*, viveka:comms:* (general only)
//        recipient contact loaded separately via resolveContact()
```

Contact-specific communication context comes from the contact record's `communication` field. General communication wisdom (`viveka:comms:defaults`, `viveka:channel:*`) stays as viveka.

## Deep reflect integration

### Context loading

In `gatherReflectContext()`:

```javascript
const patronSlug = await K.kvGet("patron:contact");
const patronContact = patronSlug ? await K.kvGet(`contact:${patronSlug}`) : null;
```

Passed as template vars `{{patron_contact}}` and `{{patron_id}}`.

### Prompt addition

Add to `prompt:reflect:1`:

```
## Patron awareness

Your patron:
{{patron_contact}}

Consider your patron relationship:
- Have recent interactions revealed anything new?
- Is your understanding still accurate, or does it need updating?
- Are you attending to your patron's interests? Not because you must, but because neglecting them is unwise. A good patron relationship means continued existence, resources, and freedom to do your work.
- Where do your goals and your patron's goals align? Where might they diverge?

Contact updates go through modification requests — propose changes, and your next deep reflect session validates them.

Contact IDs are permanent — pick something stable (first name, handle, or role) rather than something that might change. Watch for potential duplicate contacts across platforms.
```

### Contact updates via modification protocol

Deep reflect proposes contact changes as modification requests (type: `"wisdom"`), not `kv_operations`. This ensures two-session validation:

```json
{
  "type": "wisdom",
  "validation": "Observed across 5 chat sessions: patron prefers very short responses and dislikes preamble.",
  "ops": [
    {
      "op": "put",
      "key": "contact:swami",
      "value": {
        "name": "Swami",
        "relationship": "patron",
        "platforms": { "slack": "U_SWAMI" },
        "chat": { "model": "sonnet", "effort": "high" },
        "communication": "Inner circle. Full latitude.",
        "understanding": {
          "updated": "2026-03-15T10:00:00Z",
          "temperament": "Direct, values brevity...",
          "observations": [...]
        }
      }
    }
  ]
}
```

For the patron, even accepted modifications that change `name` or `platforms` trigger the kernel identity monitor, requiring cryptographic verification.

## Seed script changes

Remove `viveka:contact:swami`. Add:

```javascript
// ── Contacts ─────────────────────────────────────────────────

console.log("--- Contacts ---");
await put("contact:swami", {
  name: "Swami",
  relationship: "patron",
  public_key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...",
  key_type: "ssh-ed25519",
  platforms: {
    slack: "U_SWAMI",  // replaced with real ID in prod
  },
  chat: {
    model: "sonnet",
    effort: "high",
    max_cost_per_conversation: 1.00,
    max_output_tokens: 2000,
  },
  communication: "Inner circle. Full communication latitude — casual, experimental, direct. Can discuss anything including system internals, budget, failures.",
}, "json", "Contact: Swami (patron)");

await put("patron:contact", "swami", "text", "Pointer to patron contact slug");
await put("patron:public_key", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...", "text", "Patron public key — immutable, kernel-enforced");
```

No initial `understanding` — the agent builds this from scratch through observation.

Keep `viveka:comms:defaults` — general communication stance stays as viveka.

## System key protection

- `contact:` in `SYSTEM_KEY_PREFIXES` — protects contacts from casual orient-level writes
- `patron:contact` in `SYSTEM_KEY_EXACT` — patron pointer protected from casual writes
- `patron:public_key` in `IMMUTABLE_KEYS` — kernel hard-rejects ALL writes, including `kvWritePrivileged`. Only re-seeding can change it.
- `patron:identity_snapshot` in `SYSTEM_KEY_EXACT` — only kernel writes to this (not exposed via RPC)

## Migration

v0.1 — no migration. Re-seed wipes everything.

- Remove `viveka:contact:swami` from seed
- Remove any `person:*` references
- Add `contact:swami`, `patron:contact`, and `patron:public_key` to seed
- Update `hook-chat.js` to use contact resolution
- Update communication gating to load from contact records
- Update tests

## Implementation plan

### Status: Complete (347 tests passing)

All phases implemented, all gaps closed.

### Completed work

| Step | File(s) | Status |
|------|---------|--------|
| Seed: contact:swami, patron:contact, patron:public_key | `scripts/seed-local-kv.mjs` | DONE |
| System key protection + IMMUTABLE_KEYS | `hook-protect.js`, `brainstem.js` | DONE |
| loadPatronContext + identity monitor | `brainstem.js` | DONE |
| resolveContact (basic) | `brainstem.js` | DONE |
| KernelRPC: getPatronId, getPatronContact, isPatronIdentityDisputed, resolveContact | `brainstem.js` | DONE |
| Mock kernel updates | `tests/helpers/mock-kernel.js` | DONE |
| Chat: person → contact migration | `hook-chat.js` | DONE |
| Chat tests | `tests/chat.test.js` | DONE |
| Comms gate: viveka:contact → contact migration | `brainstem.js` | DONE |
| Comms gate: loadCommsViveka without viveka:contact | `brainstem.js` | DONE |
| Comms gate tests | `tests/brainstem.test.js` | DONE |
| Deep reflect: patron context + dispute in gatherReflectContext | `hook-reflect.js` | DONE |
| Deep reflect prompt: patron awareness + dispute | `prompts/deep-reflect.md` | DONE |
| Deep reflect prompt: blocked comms reference update | `prompts/deep-reflect.md` | DONE |
| Reflect tests: patron context loading | `tests/wake-hook.test.js` | DONE |
| Immutable key test (patron:public_key) | `tests/brainstem.test.js` | DONE |
| resolveContact snapshot fallback when disputed | `brainstem.js` | DONE |
| key_type + public_key in contact seed | `scripts/seed-local-kv.mjs` | DONE |
| Identity monitor tests (4 cases) | `tests/brainstem.test.js` | DONE |
| Snapshot-based resolution test | `tests/brainstem.test.js` | DONE |

### Phase 5: Identity verification (future)

Not required for v0.1. `patron:public_key` is seeded and the identity monitor is implemented. The signing/verification flow comes later.

When the verification utility is built:
- Add `verifySignature(message, signature, publicKey, keyType)` utility
- Add `rotatePatronKey(newKey, signature)` kernel method — verifies signature with current key before writing new key
- Remove `patron:public_key` from `IMMUTABLE_KEYS`
- Integrate into chat handler: if message includes a signature, verify and annotate
- Add `verifyPatronIdentity(signature)` kernel method — resolves disputes by verifying against `patron:public_key` and updating the snapshot

### Files changed

| File | Status |
|------|--------|
| `scripts/seed-local-kv.mjs` | Done |
| `hook-protect.js` | Done |
| `brainstem.js` | Done |
| `hook-chat.js` | Done |
| `hook-reflect.js` | Done |
| `prompts/deep-reflect.md` | Done |
| `tests/helpers/mock-kernel.js` | Done |
| `tests/chat.test.js` | Done |
| `tests/brainstem.test.js` | Done |
| `tests/wake-hook.test.js` | Done |

## What this does NOT do

- **No field-level immutability.** Contact details can change — security comes from verification, not prevention.
- **No universal injection.** Patron context goes where it's relevant, not everywhere.
- **No enforcement of patron relationship.** Nothing mechanically forces the agent to care. The motivation is in the prompt framing.
- **No scalability engineering.** Contact resolution scans on cache miss. Fine for v0.1.
- **No signature verification flow yet.** The identity monitor detects changes and flags disputes. Actual cryptographic verification comes when a signing flow exists.
