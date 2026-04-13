# Spec: Finding-to-Review Routing

## Problem

The runtime has DR2 and DR3, but the path from observed problem to review
action is still under-structured.

## Requirement

Add a native routing layer that promotes mature findings into the correct next
step.

Routing inputs should come from:

- deterministic audit findings
- defect-ledger state
- longitudinal evidence
- ground-truth review context where available

## Authority-sensitive definition

For this spec, a finding is authority-sensitive when the likely remedy touches a
surface that can change runtime behavior beyond a narrow local repair, such as:

- core policy or authority logic
- deployment or promotion behavior
- tool grants or security-sensitive config
- cross-session cognition primitives

## Native placement

- between DR1 outputs and DR2 inputs
- partly in runtime policy, partly in DR2 preparation

## Routing outcomes

- ignore
- watch only
- keep as defect
- create review note for DR2
- escalate to DR3
- request operator approval

## Non-goals

- replacing DR2
- forcing all findings into proposal mode

## Acceptance criteria

- low-confidence findings do not spam DR2
- recurring high-confidence defects can automatically become DR2 inputs
- authority-sensitive findings escalate cleanly to DR3

## Candidate issue

`Add native routing from audit findings to DR2 and DR3`
