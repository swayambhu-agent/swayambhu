# Spec: Burst Session Control

## Problem

There is no first-class native way to run many sessions back-to-back for
experimentation. The old operator loop solved this by repeatedly clearing the
schedule gate and forcing sessions.

## Requirement

Add a bounded burst-mode runtime control that runs sessions immediately one
after another for a fixed count.

## Native placement

- long-term: runtime control plane plus session scheduling logic
- immediate implementation: admin surface for local experimentation

## Proposed shape

Schedule state may carry:

- `burst_remaining`
- `burst_origin`
- `burst_reason`

Admin control may allow:

- setting a burst count
- running the burst immediately
- observing progress and remaining count

## Semantics

- each completed session consumes one burst unit
- if units remain, the next session is scheduled immediately
- when the burst is exhausted, normal cadence resumes

## Non-goals

- unbounded infinite fast mode
- replacing normal scheduling defaults

## Acceptance criteria

- an operator can request `N` back-to-back sessions
- each completed session decrements the remaining count
- normal schedule resumes when the burst finishes
- burst state is visible and auditable

## Candidate issue

`Add bounded burst mode for consecutive local sessions`
