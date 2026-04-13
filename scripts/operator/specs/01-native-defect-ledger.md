# Spec: Native Defect Ledger

## Problem

The runtime has cognition entities such as patterns, desires, tactics, and
identifications, but it has no first-class memory for tracked architecture
defects across sessions.

## Requirement

Add a native defect ledger with durable entries for recurring or important
runtime failures.

## Native placement

- the mechanical audit stage creates or updates defect records from deterministic findings
- DR1 can refine severity, confidence, and narrative around existing defects
- DR1 may also create a new defect candidate when it discovers a failure no
  deterministic rule caught
- DR2 consumes mature defects as structured review targets.
- DR3 consumes defects whose remedy crosses authority boundaries.

## Desired shape

Suggested fields:

- stable fingerprint
- summary
- evidence refs
- severity
- blast radius
- self-repairability
- status
- first_seen_at
- last_seen_at
- confidence
- next_review_due

## Non-goals

- replacing patterns or desires
- collapsing all cognition memory into one record type

## Acceptance criteria

- repeated observation of the same failure updates one stable defect record
- a defect can accumulate evidence across sessions
- DR2 can target a defect record directly

## Boundary with longitudinal review

The longitudinal review window computes recurrence evidence over bounded session
windows. The defect ledger stores the durable state of one tracked defect. The
window produces evidence; the ledger persists the defect.

## Candidate issue

`Add native defect ledger for tracked architecture failures`
