# Challenge to Proposal 2

## Objection 1: The proposal targets the wrong failing subsystem

**Claim:** The observed `401 unauthorized` is not evidence that Gmail authentication repair is the blocker. The current email path fails at the relay-auth boundary, before any SMTP/IMAP call is attempted.

**Evidence:** `services/email-gateway.mjs:237-239` returns `401` immediately when `checkAuth(req)` fails. The `/check-email` handler only returns `502` for actual IMAP failures (`services/email-gateway.mjs:266-280`). The live tool path is `tools/check_email.js:4-21` -> `providers/email-relay.js:6-35`, which uses `EMAIL_RELAY_SECRET` and optional CF Access headers, not `providers/gmail.js`. The email-relay design explicitly says "No OAuth anywhere" and that Gmail credentials live only on Akash (`docs/superpowers/specs/2026-04-04-akash-email-relay-design.md:5-8`, `:32-33`, `:118-156`).

**Falsification test:** Reproduce the failure with a bad `EMAIL_RELAY_SECRET` and valid Gmail credentials. If that yields the same `401`, this objection stands. If the run's exact `401` can be traced to an IMAP/Gmail-layer failure instead of relay auth, this objection is false.

## Objection 2: The "unbreakable no-action loop" claim is false as written

**Claim:** Current userspace already contains two built-in escape hatches, so the loop is not mechanically unbreakable even at the existing budget.

**Evidence:** `userspace.js:356-373` injects an `[IDLE TRAP OVERRIDE]` at `2 * exploration_unlock_streak`, telling the planner not to cite tactics for continued inaction and to consider alternative approaches. Separately, `userspace.js:472-505` allows one exploratory plan after `no_action_streak >= exploration_unlock_streak` when capacity is healthy. The current run already recorded `healthy: true` and then `capacity_rich_no_action` at streak `3` (`context.json:57-66`, `:93-100`). The behavior is also codified by test: `tests/userspace.test.js:787-835` expects `plan_exploratory_without_desire` and `runAgentTurn()` at streak 3.

**Falsification test:** Replay the current state with `no_action_streak: 3`, `capacity.healthy: true`, no pending requests, and a cheap exploratory action. If userspace still mechanically forces `no_action` and never executes `runAgentTurn`, this objection is false.

## Objection 3: "Wait for DR" is not yet equivalent to "stay stuck indefinitely"

**Claim:** The proposal overstates the immediacy of the DR risk. On this snapshot, DR had only just been dispatched, and the system already has stale-job recovery.

**Evidence:** The run snapshot says DR generation 5 was dispatched at `2026-04-07T14:48:50.402Z` and was merely "dispatched" at analysis time, not stale (`analysis.json:27-29`). `config/defaults.json:62-72` sets `deep_reflect.ttl_minutes` to `60`. `userspace.js:1254-1266` auto-expires over-TTL dispatched jobs, and `userspace.js:1346-1380` returns failed DR state to `idle` and makes it due again after backoff. The dev-loop design also treats stale-job cleanup as a first-class expectation and notes DR uses Anthropic subscription rather than OpenRouter spend (`docs/superpowers/specs/2026-04-04-autonomous-dev-loop-design.md:451-455`).

**Falsification test:** Let the job pass the configured TTL. If it remains indefinitely in `dispatched` without `dr_expired`, `dr_failed`, or redispatch eligibility, this objection is false.

## Objection 4: The recommended `$1.00` value is arbitrary and its sufficiency claim is unmeasured

**Claim:** The proposal asserts that `$1.00` is "enough" for diagnosis and repair without any measured repair trace, and the full dollar is not actually available to the act loop.

**Evidence:** The session budget reserves `33%` for reflect (`config/defaults.json:14-18`), and the act loop enforces `actBudgetCap = max_cost * (1 - reflectReservePct)` (`userspace.js:1018-1026`). So a `$1.00` cap yields only about `$0.67` for act work, not `$1.00`. The current run's observed no-action plan + reflect cost is about `$0.00218` total (`context.json:68-80`, `:127-139`), which shows current costs are tiny but does not measure the actual cost of relay-auth diagnosis, secret rotation, service restart, or verification. The proposal picks a round number without a costed path.

**Falsification test:** Replay the actual repair workflow end-to-end under a `$1.00` session cap and record real spend. If the required diagnosis/repair reliably completes within the effective act cap and not under any materially smaller cap, this objection is false.

## Objection 5: A persistent global budget increase is a poor interim lever under unchanged probe churn

**Claim:** The proposal recommends changing a global default, but the underlying probe-churn mechanism remains untouched. That can increase spend on every future external probe wake without proving progress on the actual fault.

**Evidence:** This run explicitly shows `schedule_gate_bypassed` due to `external_wake` from `dev_loop` (`context.json:20-28`). The current frugality evidence is drawn from a tightly constrained no-action session that spent `$0.0017286` on planning (`context.json:68-80`) and never entered act cycles. Once `session_budget.max_cost` is raised globally, every future probe wake inherits the larger ceiling. The proposal provides no rollback criterion, no expiry, and no condition under which the interim value is automatically removed.

**Falsification test:** Raise `config:defaults.session_budget.max_cost` to `$1.00` while leaving probe scheduling unchanged, then measure the next several external probe wakes. If mean per-session spend stays near the current no-action baseline and the agent does not consume materially more budget during churn, this objection is false.

## Overall Assessment

Proposal 2 is arguing from a real symptom, but its causal chain is weak. The strongest evidence in the repo points to a relay-auth/config boundary problem, not a proven Gmail-auth cost problem. The codebase also already contains escape hatches for repeated healthy idleness and a recovery path for stale DR jobs. A global budget bump may still be justified later, but this proposal does not yet prove that it is the right first fix or that `$1.00` is the right value.

## Recommendation

Do not accept Proposal 2 as written. First disambiguate the observed `401` as relay-auth vs IMAP failure. Second, let DR either complete or hit its configured TTL and recover. Third, if budget is still shown to be the limiting factor after that classification, use a bounded temporary override with a measured repair trace and an explicit rollback condition rather than a blanket persistent default increase.
