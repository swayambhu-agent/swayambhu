// ── Event type colors ─────────────────────────────────────
export const EVENT_COLORS = {
  act_start: { bg: 'bg-green-900/30', border: 'border-green-700', text: 'text-green-400', dot: 'bg-green-500' },
  act_complete: { bg: 'bg-green-900/20', border: 'border-green-800', text: 'text-green-500', dot: 'bg-green-600' },
  llm_call: { bg: 'bg-blue-900/30', border: 'border-blue-700', text: 'text-blue-400', dot: 'bg-blue-500' },
  llm_response: { bg: 'bg-blue-900/20', border: 'border-blue-800', text: 'text-blue-400', dot: 'bg-blue-400' },
  tool_call: { bg: 'bg-purple-900/30', border: 'border-purple-700', text: 'text-purple-400', dot: 'bg-purple-500' },
  tool_result: { bg: 'bg-purple-900/20', border: 'border-purple-800', text: 'text-purple-400', dot: 'bg-purple-400' },
  fallback: { bg: 'bg-orange-900/30', border: 'border-orange-700', text: 'text-orange-400', dot: 'bg-orange-500' },
  fatal: { bg: 'bg-red-900/30', border: 'border-red-700', text: 'text-red-400', dot: 'bg-red-500' },
  error: { bg: 'bg-red-900/20', border: 'border-red-800', text: 'text-red-400', dot: 'bg-red-400' },
  mutation: { bg: 'bg-yellow-900/30', border: 'border-yellow-700', text: 'text-yellow-400', dot: 'bg-yellow-500' },
  kv_operations_requested: { bg: 'bg-yellow-900/20', border: 'border-yellow-800', text: 'text-yellow-400', dot: 'bg-yellow-400' },
  reflect: { bg: 'bg-teal-900/30', border: 'border-teal-700', text: 'text-teal-400', dot: 'bg-teal-500' },
  act: { bg: 'bg-cyan-900/30', border: 'border-cyan-700', text: 'text-cyan-400', dot: 'bg-cyan-500' },
  subplan: { bg: 'bg-indigo-900/30', border: 'border-indigo-700', text: 'text-indigo-400', dot: 'bg-indigo-500' },
  dr_dispatched: { bg: 'bg-teal-900/30', border: 'border-teal-700', text: 'text-teal-400', dot: 'bg-teal-500' },
  dr_failed: { bg: 'bg-red-900/30', border: 'border-red-700', text: 'text-red-400', dot: 'bg-red-500' },
  dr_expired: { bg: 'bg-orange-900/30', border: 'border-orange-700', text: 'text-orange-400', dot: 'bg-orange-500' },
  dr_applied: { bg: 'bg-teal-900/30', border: 'border-teal-700', text: 'text-teal-400', dot: 'bg-teal-500' },
  dr_dispatch_failed: { bg: 'bg-red-900/20', border: 'border-red-800', text: 'text-red-400', dot: 'bg-red-400' },
  dr_apply_blocked: { bg: 'bg-yellow-900/30', border: 'border-yellow-700', text: 'text-yellow-400', dot: 'bg-yellow-500' },
  dr_cycle_error: { bg: 'bg-red-900/30', border: 'border-red-700', text: 'text-red-400', dot: 'bg-red-500' },
};

export function eventColor(type) {
  return EVENT_COLORS[type] || { bg: 'bg-gray-900/30', border: 'border-gray-700', text: 'text-gray-400', dot: 'bg-gray-500' };
}
