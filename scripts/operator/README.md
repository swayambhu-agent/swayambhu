Operator tooling lives here.

These scripts are intentionally outside the runtime hot path. They support
branch/snapshot management, external dev-loop orchestration, local service
control, and other operator workflows used to inspect and evolve the agent.

Runtime code may invoke internalized `lib/*` entry modules, but it should not
grow new dependencies on `scripts/operator/*` without an explicit reason.
