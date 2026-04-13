# Native Internalization Specs

These specs capture the key native capability gaps revealed by the old operator
loop.

They are intentionally modular:

- each spec describes one native requirement
- each spec can become one or more GitHub issues
- only two are immediate implementation targets right now:
  - `06-burst-session-control.md`
  - `07-unified-teardown-control.md`

## Specs

1. [Native Defect Ledger](./01-native-defect-ledger.md)
2. [Mechanical Audit Stage](./02-native-mechanical-audit-stage.md)
3. [Longitudinal Review Window](./03-longitudinal-review-window.md)
4. [Ground-Truth Review Context](./04-ground-truth-review-context.md)
5. [Finding-to-Review Routing](./05-finding-to-review-routing.md)
6. [Burst Session Control](./06-burst-session-control.md)
7. [Unified Teardown Control](./07-unified-teardown-control.md)

## Priority

Best implementation order overall:

1. mechanical audit stage
2. longitudinal review window
3. native defect ledger
4. ground-truth review context
5. finding-to-review routing
6. burst session control
7. unified teardown control

Best implementation order for the immediate work:

1. burst session control
2. unified teardown control

These two immediate items are not higher architectural priorities. They are the
current implementation targets because they unblock local experimentation while
the deeper cognition specs remain future work.
