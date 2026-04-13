# Spec: Longitudinal Review Window

## Problem

The runtime is still too session-centric. It has history, but not a first-class
way to reason over bounded multi-session windows.

## Requirement

Add native multi-session rollups that summarize recent behavior over a chosen
window and feed that into DR1 and DR2.

## Native placement

- runtime state preparation for DR1
- optional DR2 input mode for recurring defects

## Desired capabilities

- configurable review windows
- recurrence tracking
- trend summaries
- improving / regressing / noisy judgments

## Non-goals

- replaying all history every time
- replacing the raw session ledger

## Acceptance criteria

- DR1 can reference an explicit bounded rollup
- the runtime can tell one-off anomalies from persistent regressions
- recurring defects can accumulate evidence over time

## Candidate issue

`Add longitudinal session rollups for deep reflect`
