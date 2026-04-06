// Parse output.json from Claude CLI --output-format json.
// The CLI wraps responses in an envelope: { type: "result", result: "...", usage: {...}, ... }
// The actual payload (e.g. DR output with reflection/kv_operations) is inside the result
// field as a string, potentially wrapped in markdown code fences.
//
// Returns { payload, meta } where:
//   payload — the semantic content (parsed JSON object), or null if extraction failed
//   meta    — envelope metadata (cost, usage, session_id), or null if not an envelope

export function parseJobOutput(raw) {
  if (!raw || typeof raw !== 'string') return { payload: null, meta: null };

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return { payload: null, meta: null }; }

  // Already a direct payload (no envelope)?
  if (parsed.reflection || parsed.kv_operations?.length) {
    return { payload: parsed, meta: null };
  }

  // Claude CLI envelope?
  if (parsed.type === "result" && typeof parsed.result === "string") {
    const meta = {
      session_id: parsed.session_id || null,
      total_cost_usd: parsed.total_cost_usd || null,
      usage: parsed.usage || null,
      stop_reason: parsed.stop_reason || null,
      duration_ms: parsed.duration_ms || null,
    };

    let payload = extractJSON(parsed.result);

    // Fallback: CC may have tried to Write output.json but was denied permission.
    // The actual JSON content lives in the permission_denials array.
    if (!payload && Array.isArray(parsed.permission_denials)) {
      const writeAttempt = parsed.permission_denials.find(
        d => d.tool_name === 'Write' &&
             d.tool_input?.file_path?.endsWith('/output.json')
      );
      if (writeAttempt?.tool_input?.content) {
        payload = extractJSON(writeAttempt.tool_input.content);
      }
    }

    return { payload, meta };
  }

  // Unknown shape — return as-is (caller decides what to do)
  return { payload: parsed, meta: null };
}

// Extract JSON from a string that may be plain JSON, fenced in markdown, or mixed text.
function extractJSON(text) {
  if (!text || typeof text !== 'string') return null;

  // Direct parse
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); }
  catch { /* fall through */ }

  // Strip markdown code fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); }
    catch { /* fall through */ }
  }

  // Find outermost { }
  const braceContent = findBraces(trimmed, '{', '}');
  if (braceContent) {
    try { return JSON.parse(braceContent); }
    catch { /* no valid JSON */ }
  }

  return null;
}

function findBraces(text, open, close) {
  const start = text.indexOf(open);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}
