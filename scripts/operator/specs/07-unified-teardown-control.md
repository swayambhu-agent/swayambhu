# Spec: Unified Teardown Control

## Problem

Experiment reset is fragmented across local state deletion, local process
cleanup, remote workspace cleanup, and other scratch surfaces.

## Requirement

Add one supported teardown/reset path that can wipe named experimental scopes
locally and, when enabled, on the remote compute surface.

## Native placement

- long-term: runtime/admin control plane for the conceptual requirement
- immediate implementation: operator script backed by the existing authenticated
  remote compute path

## Desired scopes

- local persisted runtime state
- local snapshots and scratch artifacts
- remote workspace
- remote reasoning artifacts
- remote jobs scratch

## Design constraints

- reset scopes should be explicit
- remote cleanup must use authenticated runtime-side controls
- local teardown should not depend on manual file-by-file cleanup

## Non-goals

- deleting source code checkouts
- replacing infrastructure lifecycle tooling

## Acceptance criteria

- one command can reset local, remote, or both
- the script reports exactly what it reset
- remote cleanup succeeds through the existing authenticated compute path
- the reset path is idempotent

## Candidate issue

`Add unified local and remote teardown controls for experiments`
