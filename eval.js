// Swayambhu — Evaluation stub (Module 3)
// Mechanical σ/α computation. Returns typed zeros in M3 — Module 5 replaces
// with real embeddings + NLI pipeline. Same interface, richer data.

export function evaluateAction(ledger, desires, assumptions) {
  const toolOutcomes = ledger.tool_calls.map(tc => ({
    tool: tc.tool,
    ok: tc.ok,
  }));

  const candidateCheckIds = Object.values(assumptions).map(a => a.slug);

  return {
    sigma: 0,
    alpha: {},
    salience: 0,
    eval_method: "stub",
    tool_outcomes: toolOutcomes,
    plan_success_criteria: ledger.plan.success,
    assumptions_relied_on: ledger.plan.relies_on || [],
    candidate_check_ids: candidateCheckIds,
  };
}
