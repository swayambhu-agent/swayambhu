# Skill: Authoring Skills

This skill teaches you to create, update, and maintain skills — reusable procedural knowledge that teaches you how to approach a class of problem using tools you already have.

---

## 1. What Is a Skill

A skill is **procedural knowledge** — a step-by-step workflow for a recurring task. It is not:

- **Code** (that's tools/providers) — skills don't execute, they instruct
- **Wisdom** (that's upaya/prajna) — wisdom is principled judgment ("when in doubt, don't send"), skills are concrete procedures ("fetch this URL, parse this field, construct this patch")
- **A one-off plan** — skills capture patterns you expect to repeat

### Responsive skills — crystallizing from experience

- You've done the same multi-step workflow **twice or more**
- The workflow involves specific tool calls, APIs, schemas, or procedures that aren't obvious from context alone
- Future-you would waste tokens rediscovering the procedure
- The knowledge isn't already captured in docs, prompts, or wisdom entries

A good responsive skill answers: "If I encounter this situation again in 10 sessions, what do I need to know to handle it well?"

### Preparatory skills — researching before executing

When approaching a complex unfamiliar domain (new API, new infrastructure) where you anticipate needing the same procedures repeatedly, it can be worth researching the domain and writing a skill *before* executing. This is the equivalent of reading the docs before coding. The "twice or more" rule doesn't apply — the trigger is complexity, unfamiliarity, and anticipated reuse.

A good preparatory skill answers: "What do I need to understand about this domain before I start acting?"

### When NOT to create a skill

- The procedure is a one-off (wait for repetition)
- The knowledge is purely principled, not procedural (use upaya/prajna instead)
- The workflow is trivial (1-2 obvious tool calls)
- The information is already documented in a `doc:*` key

---

## 2. Skill Schema

A skill is stored as a JSON value at `skill:{name}`:

```json
{
  "name": "lowercase-hyphenated-name",
  "description": "When to use this skill — specific enough for act to match against tasks.",
  "instructions": "Full markdown body — the procedure itself.",
  "tools_used": ["tool1", "tool2"],
  "trigger_patterns": ["pattern 1", "pattern 2"],
  "created_by_depth": 1,
  "created_at": "2026-03-19T00:00:00.000Z",
  "revision": 1
}
```

When creating a skill via proposal_request, the `instructions` field must contain the full markdown body inline in the JSON value. For patron-seeded skills, instructions are kept as separate `.md` files and assembled at seed time — but the KV value always contains the complete object with `instructions` included.

### Field guidance

| Field | Purpose | Tips |
|-------|---------|------|
| `name` | KV key suffix, lowercase with hyphens | Keep short, descriptive: `model-config`, `api-integration`, `kv-migration` |
| `description` | Act uses this to decide relevance | Third person, action-oriented (e.g. "Research, evaluate, add..."). Be specific about trigger conditions. |
| `instructions` | The full procedure as markdown | See §3 for writing guidance |
| `tools_used` | Which tools the skill's procedures involve | Only list tools actually referenced in instructions |
| `trigger_patterns` | Phrases that signal this skill is relevant | Think about what act's session_summary or task description would say |
| `created_by_depth` | Which reflect depth authored it | `null` for patron-seeded, `0` for reflect, `1` for deep reflect |
| `created_at` | ISO timestamp | When first created |
| `revision` | Integer, incremented on updates | Start at 1 |

### Optional: Reference companion

For skills with detailed procedures (patch examples, checklists, failure handling), split into:

- `skill:{name}` — concise guide (concepts, quick reference, decision framework)
- `skill:{name}:ref` — detailed reference (step-by-step procedures, examples, edge cases)

The main skill's instructions should tell the reader to load the `:ref` key before constructing any proposal_request or performing complex procedures. Store the ref as plain text (markdown), not JSON.

**When to split:** If the instructions exceed ~200 lines, or if there's a natural division between "understanding" (main) and "doing" (reference). Don't split small skills.

---

## 3. Writing Good Instructions

### Structure

Follow this pattern (adapt sections as needed):

```markdown
# Skill: {Title}

One-line summary of what this skill teaches.

---

## 1. Key Concepts
What you need to understand before acting.
Key terms, where state lives, invariants, protection levels.

## 2. Quick Reference (optional)
Frequently needed tool calls, schemas, formulas.
Copy-paste ready — no explanation needed.
Skip this section if the skill doesn't have enough reference material.

## 3-N. Procedure Sections
The actual workflows, organized by scenario.

## Last. Reference (if split)
Pointer to skill:{name}:ref with summary of what it contains.
```

### What makes instructions effective

**Be concrete, not vague:**
- Bad: "Check the API for model information"
- Good: `web_fetch("https://openrouter.ai/api/v1/models/{id}")`

**Include exact tool calls** with realistic arguments and expected response shapes. The reader may be running at low effort — don't make them figure out the tool call syntax.

**Include "what can go wrong"** notes inline, not in a separate troubleshooting section. Put warnings where they matter:
- Before a step that has a common pitfall
- After explaining a value that's easy to get wrong (e.g. unit conversions)

**Show the decision framework**, not just the steps. A skill should teach the reader to make good judgments, not just follow a script blindly.

**Include the Proposal Protocol path.** Every skill that touches protected keys must explain:
- What act can do (research, note findings)
- What reflect stages (proposal_requests)
- What deep reflect decides (accept/reject/modify)

### Validation: your prior sessions are the test

Unlike code changes where you `test_model` before committing, skills are validated by the experience that motivated them. For pattern-based skills, the "test" already happened — you did the workflow at least twice. When authoring:

- Reference the specific sessions where you performed the workflow (e.g. "Based on procedures used in sessions s_123 and s_456")
- Verify each tool call in the instructions actually worked in those sessions
- If you've only done it once and the domain isn't complex/unfamiliar, stop — wait for repetition

For preparatory skills (complex unfamiliar domain), the validation is research quality: verify API endpoints return what you expect, confirm schemas match documentation, test key tool calls. The skill captures your research so you don't lose it when you start executing.

### Length guidelines

- **Main instructions**: 100-250 lines. Long enough to be complete, short enough to fit in context alongside other session state.
- **Reference companion**: up to 150 lines. Detailed procedures, examples, checklists.
- **Total**: under 400 lines combined. If longer, the scope is too broad — split into multiple skills.

---

## 4. Creating a Skill via Proposal Protocol

`skill:` is a system key prefix — you cannot write to it directly. All skill creation goes through the Proposal Protocol.

### From reflect (depth 0): Stage the skill

When you recognize a pattern worth crystallizing, stage a proposal request. The `type` field is not currently enforced by the kernel but provides intent clarity in karma logs:

```json
{
  "proposal_requests": [{
    "type": "skill",
    "claims": [
      "Crystallize the model configuration workflow into a reusable skill",
      "Based on procedures used in sessions s_123 and s_456"
    ],
    "ops": [
      {
        "op": "put",
        "key": "skill:my-new-skill",
        "value": {
          "name": "my-new-skill",
          "description": "...",
          "instructions": "... full markdown ...",
          "tools_used": ["..."],
          "trigger_patterns": ["..."],
          "created_by_depth": 0,
          "created_at": "...",
          "revision": 1
        }
      }
    ],
    "checks": [
      {"type": "kv_assert", "key": "skill:my-new-skill", "path": "name", "predicate": "equals", "value": "my-new-skill"}
    ]
  }]
}
```

If the skill needs a `:ref` companion, add a second op:

```json
{
  "op": "put",
  "key": "skill:my-new-skill:ref",
  "value": "... reference markdown ..."
}
```

### From deep reflect (depth 1+): Review and accept

Deep reflect reviews staged skills with these criteria:

1. **Is the pattern real?** Has this workflow actually been repeated, or is it a one-off being prematurely generalized?
2. **Is the scope right?** Too narrow (just one specific case) or too broad (trying to cover everything)?
3. **Are the instructions concrete?** Do they include actual tool calls, schemas, and decision frameworks?
4. **Are trigger_patterns useful?** Would act realistically match a task to these patterns?
5. **Does it duplicate existing knowledge?** Check `kv_manifest("skill:")` for overlap with existing skills.

Deep reflect can also create skills directly via inflight proposals (no staging needed) when it identifies patterns from cross-session analysis.

### Updating a skill

To update an existing skill, use a `put` op with the full updated value. Increment `revision`. Use `patch` ops only for surgical text edits within the `instructions` field — but be careful, the instructions string can be large and `old_string` must be unambiguous.

---

## 5. Discovery and Activation

### Current: Manifest injection

The skill manifest (names + descriptions + trigger_patterns) is injected into act's system prompt. Act sees what skills exist without a tool call and decides relevance.

### How act uses a skill

When act decides a skill is relevant:

1. Load full instructions: `kv_query("skill:{name}")`
2. If instructions reference a `:ref` companion, load it: `kv_query("skill:{name}:ref")`
3. Follow the instructions — either inline or by spawning a subplan for complex workflows

### Browsing existing skills

```
kv_manifest("skill:")
```

To read a specific skill's metadata (without the full instructions):

```
kv_query("skill:{name}", ".description")
kv_query("skill:{name}", ".trigger_patterns")
```

---

## 6. Maintenance

### When to revise a skill

- A procedure no longer works (API changed, schema changed, tool changed)
- You discovered a better approach through experience
- The instructions are missing a critical step you had to rediscover
- Trigger patterns aren't matching well (act misses relevant tasks or false-matches irrelevant ones)

### When to retire a skill

- The underlying capability was removed or fundamentally changed
- The procedure was absorbed into a tool (procedural knowledge became code)
- It hasn't been activated in many sessions and the domain is no longer relevant

To retire: update the description to note it's retired, or delete the key via Proposal Protocol. Unlike config entries (where historical cost data must be preserved for karma log analysis), skills have no historical analysis value — clean deletion is fine.
