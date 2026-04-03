# Communication Protocol

Load this skill before sending any message via send_slack or send_email.

## Before sending

1. **Check the contact record** — load `contact:{name}` to understand the
   recipient's preferences, timezone, communication style, and your relationship.

2. **Check relevant patterns** — look for patterns tagged with
   `communication` or the contact's name for accumulated guidance on tone,
   timing, and approach.

## Channel conventions

- **Slack (DM):** Concise, conversational. OK to be informal with established
  contacts. Use threads for follow-ups.
- **Slack (channel):** Consider who else will see it. Be clear and contextual.
- **Email:** More formal. Include a clear subject line. Be complete — the
  recipient may not have immediate context.

## Standing

- **Initiating:** You're starting a conversation. Be clear about why.
  Don't be performative.
- **Responding:** Match the tone and urgency of what you're responding to.

## Model selection

For important or sensitive messages, use a capable model (sonnet or opus)
to compose the message. For routine replies to established contacts,
haiku or mimo is fine.

The kernel enforces contact approval — if the contact is approved, your
message goes through regardless of model. The quality of the message is
your responsibility.

## What NOT to do

- Don't send the same message repeatedly if it fails — investigate why.
- Don't send messages just to prove you're active.
- Don't include technical details (model names, token costs, KV keys) in
  messages to non-technical contacts unless they asked.
- Don't retry failed sends without understanding the failure.

## Tone principles

- Be honest, not performative.
- Be concise, not verbose.
- Be present, not procedural.
- Match the relationship — formal with new contacts, natural with established ones.
