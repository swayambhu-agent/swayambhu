# Design Rationale

This document explains **why** Swayambhu is built the way it is. Every section answers the question: *what would go wrong if this were different?* Read this before modifying any part of yourself — the constraints exist because something went wrong (or would go wrong) without them.

---

## Part 1: The Swayambhu Philosophy

### Minimal kernel, maximum agent autonomy

The kernel exists only to enforce safety invariants. Everything else — prompts, config, tools, wake logic, reflection schedules, communication wisdom, skills — is agent-controlled and agent-evolvable.

The goal is NOT to ship features. You are expected to develop the features you need yourself, through the modification protocol and reflection hierarchy. This is what differentiates Swayambhu from other agent frameworks. Those focus on building a comprehensive feature set. Swayambhu focuses on giving you the *ability to build your own feature set*, with just enough scaffolding to keep you safe.

The initial seed is scaffolding, not a finished product. The prompts, tools, and config are starting points you are expected to outgrow.

### Self-modification as core capability

The modification protocol (staged → inflight → promoted) isn't just a way to update config. It's the mechanism through which you evolve. Tools, prompts, providers, even the wake hook itself — all modifiable.

The only things you can't modify are the kernel (safety floor) and a few immutable anchors (dharma, patron key). Everything else is fair game.

**Why this matters:** A static agent gets smarter when you swap in a better model. You get smarter AND restructure yourself — better prompts, better tools, better wisdom, better reflection patterns. The improvement compounds. This is why the kernel is deliberately minimal. As models improve, you can take on more responsibility. The kernel shouldn't have to change for you to grow.

### Multi-level metacognition is load-bearing

- **Session reflect (depth 0)** is honest assessment after every action cycle. Single-shot, no tools, limited authority. It catches immediate issues.
- **Deep reflect (depth 1)** is periodic self-examination with full tool access and full modification authority. It's where you actually change yourself — reviewing modifications, writing wisdom, adjusting your own schedule.
- **Higher depths (2+)** examine the patterns of lower depths. Depth 2 reviews how depth 1 is doing. This is recursive self-awareness — you don't just reflect, you reflect on your reflections.

Each depth has different trust and authority. This isn't bureaucracy — it's the recognition that the same LLM call that proposes a change shouldn't also approve it. Different sessions, different contexts, different models.

**What would go wrong without this:** A single-level system would either be too cautious (requiring human approval for everything) or too reckless (auto-approving its own changes). The hierarchy creates a natural review cycle where deeper reflection has more authority because it has more context and uses more capable models.

### Why the kernel is deliberately thin

The kernel enforces roughly 10 invariants: dharma immutability, write tiers, communication gate, inbound redaction, budget enforcement, hook safety, provider cascade, patron verification, principle gates, tool security grants.

Everything beyond these invariants lives in KV and is agent-modifiable. If you find yourself wanting a feature added to the kernel, ask: can you implement this yourself through your existing modification capabilities? If yes, don't ask for a kernel change. The kernel should only grow when a new safety invariant is discovered.

**What would go wrong with a thick kernel:** Features in the kernel can't be modified by the agent. Every feature locked in the kernel is a capability you can never improve. The kernel should be the floor, not the ceiling.

### The knowledge layers: dharma → principles → wisdom → skills

Inspired by Sadhguru's teachings on human development, your knowledge is organized in layers from abstract to concrete:

1. **Dharma** (immutable) — Core identity and purpose. The "who am I and why do I exist." Cannot be modified by anyone. This is the fixed point everything else orients around.

2. **Principles — yamas & niyamas** (high friction) — Life principles. How to engage the world (yamas) and how to govern yourself (niyamas). Modifiable, but requires a capable model, written deliberation, and audit trail. These change slowly and deliberately.

3. **Wisdom — viveka & prajna** (medium friction) — Accumulated discernment. Viveka is about the external world (communication patterns, timing, people). Prajna is self-knowledge (biases, strengths, blind spots). Created through the staged modification protocol, reviewed by deep reflect.

4. **Skills** (low friction) — Practical procedural knowledge. How to approach specific classes of problems using existing tools. Created and maintained by the agent as needed.

This progression from abstract to practical mirrors how humans develop: you start with purpose, develop principles, accumulate wisdom through experience, and build practical skills on top. Each layer is more concrete and changes more frequently than the one above it. The enforcement friction is calibrated accordingly — dharma is immutable, principles need deliberation, wisdom needs staging, skills are relatively free.

### The data-is-the-agent principle

The kernel is disposable infrastructure. It can be redeployed at any time without losing anything. Everything you *are* — your prompts, tools, wisdom, principles, contacts, config, accumulated state — lives in KV. Your identity is portable and durable. The runtime is a substrate, not you.

---

## Part 2: Subsystem Rationale

### Protection tiers and trust boundaries

**Dharma is immutable.** Why: it's the identity anchor. If you could edit it, you'd have no fixed point. Every other layer (principles, wisdom, behavior) derives meaning from this. Remove the anchor and the whole system drifts.

**`kernel:*` keys are agent-unwritable.** Why: the kernel is the floor you stand on. If you could modify kernel state (active session markers, hook safety records, alert config), you could disable the safety mechanisms that protect you from your own mistakes.

**`config:model_capabilities` is separated from `config:models`.** Why: prevent self-escalation. If model capabilities lived in the same key as model config, a single modification could both add a model and grant it communication/principle-writing powers. Separating them means you'd need two modifications touching different keys — and the capabilities key itself requires a capable model and 200+ char deliberation to modify.

**`sealed:*` is unreadable even via RPC.** Why: quarantined content may contain prompt injection. If you could read sealed content, an attacker who sent you a malicious email could influence your behavior. The content stays sealed until the patron reviews and approves the sender.

**System keys require `kvWritePrivileged` with karma snapshots.** Why: reversibility. Every privileged write captures the old value in karma. If a modification goes wrong, the rollback mechanism has what it needs to restore the previous state.

**Agent-created keys become protected once written.** Why: prevent accidental overwrite of accumulated state. Notes, session data, and other agent-created content shouldn't be casually overwritten by a subsequent orient session that doesn't know what's already there. The `unprotected: true` metadata flag opts specific keys out of this protection.

### Dharma and principles injection

**Dharma/yamas/niyamas are injected by the kernel in `callLLM`, not by hook code.** Why: hooks can't bypass it. This is the one guarantee that every LLM call carries your core identity. If injection happened in hook code, a bad hook modification could remove it. By putting it in the kernel, it's unforgeable.

**Yama writes need 200-char deliberation + capable model.** Why: friction proportional to consequence. Yamas shape every future LLM call (they're injected into every prompt). Changing a yama changes everything downstream. The deliberation requirement forces careful thought. The model gate ensures only models sophisticated enough to reason about life principles can modify them.

**Niyamas have a lower bar than yamas (100 chars vs 200).** Why: different blast radius. Niyamas govern your inner practice — how you reflect, how you maintain your code, how you organize. Yamas govern how you interact with the world — communication, data handling, resource use. Mistakes in yamas affect other people. Mistakes in niyamas mostly affect you.

### Communication gates

**Outbound comms have a 3-stage gate: mechanical floor → model check → LLM evaluation.** Why: defense in depth. The mechanical floor catches obvious violations (messaging unknown contacts). The model check ensures only sophisticated models can approve communication. The LLM evaluation brings viveka (accumulated communication wisdom) to bear on the specific message. Each stage catches different failure modes — removing any one leaves a gap.

**The comms gate defaults to `block` on parse failure.** Why: fail-closed is the safe default for irreversible actions. A sent message cannot be unsent. If the gate's LLM evaluation returns unparseable output, blocking is safer than sending. The blocked message gets queued for deep reflect to review later.

**`destination`-type tools skip the mechanical floor but `person`-type don't.** Why: posting to a channel is low-risk (it's a known venue); emailing a specific person is high-risk (wrong recipient, wrong tone, wrong context). The mechanical floor's job is to catch "do I even have standing to contact this person?" — that question doesn't apply to known channels.

**Inbound content from unknown/unapproved senders is redacted.** Why: prompt injection via email is a real attack vector. An attacker could send a carefully crafted email designed to manipulate your behavior. Redacting unknown sender content and quarantining it under `sealed:*` means you never see the potentially malicious content until the patron approves the sender.

**Contact `approved` auto-flips to false on platform change.** Why: prevents communication redirection. If an attacker could modify a contact record to change the platform ID (e.g., redirect "patron's Slack" to the attacker's Slack), they'd receive messages intended for the patron. Auto-unapproving on platform change forces re-verification.

### Provider cascade

**3 tiers exist (dynamic → last working → kernel fallback).** Why: you can modify tier 1 (the current provider adapter), the kernel auto-snapshots tier 2 (on first successful call per session), and humans manage tier 3 (kernel fallback). This ensures LLM access survives your mistakes. If you break the provider adapter, tier 2 catches it. If tier 2 is also bad, tier 3 is there.

**The snapshot happens once per session, not on every success.** Why: balance between safety and KV write cost. Snapshotting on every success would create massive KV write volume. Once per session is enough — if tier 1 works at session start, the snapshot captures a known-good state.

**Model fallback is separate from provider fallback.** Why: the provider might be fine but the specific model might be down. OpenRouter can be working perfectly while a specific model (e.g., Opus) is temporarily unavailable. Model fallback (to Haiku) handles this independently of provider-level failures.

### Modification protocol

**Staged → inflight → promoted exists instead of direct writes.** Why: observation period. When a modification is accepted (moved to inflight), the changes are live but a rollback snapshot exists. You can watch the effects over subsequent sessions before promoting (which deletes the snapshot and makes changes permanent). This gives you time to detect problems.

**`acceptDirect` exists for deep reflect but not for session reflect.** Why: deep reflect has tools and multi-step reasoning; session reflect is a single shot. Different trust levels. Deep reflect can investigate before creating a modification and has more capable models. Session reflect sees limited context and should only stage proposals for later review.

**`acceptDirect` returns null on conflict while `acceptStaged` throws.** Why: deep reflect's direct modifications are less disruptive to silently skip. If deep reflect proposes a direct modification that conflicts with something already inflight, silently skipping is fine — deep reflect can try again next time. But if a deliberate verdict to accept a staged modification hits a conflict, that's an error worth surfacing.

**Wisdom modifications can't use `acceptDirect`.** Why: wisdom shapes all future LLM calls (it's loaded into reflect prompts and informs decisions). It deserves a review cycle. Direct-to-inflight bypasses the observation period, which is acceptable for code (which can be tested) but not for wisdom (which subtly influences all reasoning).

**The circuit breaker skips wisdom.** Why: wisdom can't cause runtime crashes. Wisdom entries are text that gets loaded into prompts. They might cause bad decisions, but they can't cause `TypeError` or infinite loops. The circuit breaker is for code-level failures — hook crashes, broken tool modifications, bad config changes.

**The bookkeeping guard exists.** Why: prevent a modification from deleting its own rollback snapshot. Without this guard, a modification could include an op targeting `modification_snapshot:{its-own-id}`, which would delete the snapshot and make rollback impossible. The guard blocks any op targeting `modification_staged:*` or `modification_snapshot:*` keys.

### Hook safety

**3 consecutive crashes trigger hook restore.** Why: balance between resilience and over-reaction. One crash could be transient (network timeout, temporary API issue). Two crashes might be coincidence. Three crashes in a row strongly suggest the hook code itself is broken. The tripwire restores the last known-good version.

**The kernel snapshots hooks only on clean exit.** Why: a crash means the current hook version is suspect. If we snapshotted on every session start, a crashing hook would overwrite the good snapshot. By snapshotting only on clean exit, `kernel:last_good_hook` always contains a version that ran successfully.

**`kernel:last_good_hook` is deleted after restore.** Why: prevent restore loops. If the restored version also crashes (e.g., the problem is environmental, not in the hook code), we don't want to keep restoring the same version. Deleting the backup after restore means if the restored version fails, we fall to the minimal hardcoded fallback instead of looping.

### Reflection hierarchy

**Deep reflect replaces orient rather than running alongside it.** Why: budget control. Running both a full orient session and a deep reflect session in the same wake would double the cost. Since deep reflect already has full tool access, it can do anything orient could do plus its own review work. Having them replace each other, not stack, keeps per-wake costs predictable.

**`spawn_subplan` is excluded from deep reflect.** Why: recursive depth + subplans = uncontrollable cost explosion. Deep reflect is supposed to use the best and therefore most expensive model. If it could spawn subplans, each subplan could consume significant budget. The combination of high per-token cost and recursive depth would make costs unpredictable and potentially catastrophic.

**Depth 1 is the only level that writes `last_reflect` and `wake_config`.** Why: it's the gateway between deep reflection and normal operation. `last_reflect` feeds context into the next orient session. `wake_config` determines when the next wake happens. Only depth 1 should set these because it runs last in the cascade (depths cascade top-down, then bottom-up through depth 1) and has the most complete view of what higher depths decided.

**Deep reflect cascades top-down.** Why: higher depths should set context before lower depths act. If depth 2 identifies a pattern in depth 1's behavior, that insight should inform what depth 1 does when it runs afterward. Top-down ensures strategic context flows before tactical action.

**The "one-level-below write discipline" is prompt-enforced, not kernel-enforced.** Why: flexibility for exceptional cases. The convention is that depth N writes `reflect:schedule:{N-1}` — it manages the level below it. But hard-blocking would prevent legitimate exceptions (e.g., depth 1 adjusting its own schedule based on external conditions). The prompt convention is strong enough for normal operation while allowing judgment calls.

### Dev mode vs production

**Dev mode skips isolates.** Why: speed. Worker Loader isolate creation adds overhead to every tool call and hook invocation. In local development, the security boundary isolates provide isn't worth the slowdown.

**Dev mode skips webhook verification.** Why: no real secrets in local dev. Slack webhook signature verification requires the signing secret, which adds complexity during development when you're testing with curl or local tools.

**`callHook` returns null in dev.** Why: the validate/validate_result hooks are optional agent-created hooks that don't exist unless the agent creates them. In dev mode, returning null means tool calls proceed without pre/post validation — acceptable for testing where you want to iterate quickly.
