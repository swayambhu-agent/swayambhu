# Spec: Ground-Truth Review Context

## Problem

The runtime does not systematically compare its own behavior against the
ground-truth implementation surface: code, config, prompts, schemas, and
quality rules.

## Requirement

Add a native review-context builder that materializes relevant implementation
artifacts as evidence for DR1 and DR2.

## Native placement

- DR1 first, for diagnosis and root-cause tracing
- DR2 for proposal and challenge context
- DR3 when changes touch sensitive authority surfaces

## Desired capabilities

- collect implicated files from source maps
- package relevant config, prompt, and schema fragments
- include explicit invariant or rubric checks
- distinguish runtime belief from code truth

## Non-goals

- loading the entire repo into every review
- replacing source maps

## Acceptance criteria

- DR1 can receive concrete code/config context for a failure
- DR2 proposals can cite implicated files and invariants
- review notes distinguish trace evidence from code-truth evidence

## Minimum viable scope

The first implementation should serve DR1 only. Broader DR2 and DR3 reuse can
follow once the context builder has proven useful and stable.

## Candidate issue

`Build native code and rubric review context for DR`
