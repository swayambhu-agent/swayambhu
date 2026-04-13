# Spec: Mechanical Audit Stage

## Problem

The runtime depends too heavily on generative reflection to notice certain
classes of defect. Some failures are better caught by deterministic checks.

## Requirement

Add a deterministic audit stage that runs before DR1 synthesis and emits
grounded findings.

## Native placement

- a deterministic pre-pass before DR1
- its outputs become inputs to DR1, not an optional side effect

## Examples of audit targets

- malformed desires
- tactics that are really meta-policy
- contaminated experiences
- policy leakage into carry-forward
- outbound messages that leak internal runtime language

## Non-goals

- replacing DR1
- turning all diagnosis into rules

## Acceptance criteria

- the same bad trace yields materially the same findings across runs
- findings are visible to DR1 as grounded evidence
- audit rules are narrow, testable, and versioned
- when the defect ledger exists, the audit stage can create or update defect
  records directly

## Transitional note

If the audit stage lands before the defect ledger, its outputs are transient
findings rather than durable defect records.

## Candidate issue

`Add deterministic audit pass before deep reflect`
