export const meta = { secrets: [], kv_access: "read_all", timeout_ms: 5000 };

const DEFAULT_MAX_RESPONSE_CHARS = 2000;

export async function execute({ key, path, kv, config }) {
  if (!key) return { error: "missing required param: key" };

  const raw = await kv.get(key);
  if (raw === null) return { error: `no value found for key: ${key}` };

  let data;
  try { data = typeof raw === "string" ? JSON.parse(raw) : raw; }
  catch { data = raw; }  // plain text — use as-is

  const maxChars = config?.tools?.kv_query?.max_response_chars || DEFAULT_MAX_RESPONSE_CHARS;

  if (!path) return present(data, maxChars);

  const segments = parsePath(path);
  if (segments.error) return { error: segments.error };

  let current = data;
  let traversed = "";

  for (const seg of segments) {
    if (seg.type === "index") {
      if (!Array.isArray(current)) {
        return { error: `${traversed} is not an array, cannot index with [${seg.value}]` };
      }
      if (seg.value < 0 || seg.value >= current.length) {
        return { error: `index [${seg.value}] out of bounds (length ${current.length}) at ${traversed || "root"}` };
      }
      current = current[seg.value];
      traversed += `[${seg.value}]`;
    } else {
      if (current === null || typeof current !== "object" || Array.isArray(current)) {
        return { error: `${traversed} is not an object, cannot access .${seg.value}` };
      }
      if (!(seg.value in current)) {
        return {
          error: `key "${seg.value}" not found at ${traversed || "root"}`,
          available_keys: Object.keys(current),
        };
      }
      current = current[seg.value];
      traversed += (traversed ? "." : ".") + seg.value;
    }
  }

  return present(current, maxChars);
}

function parsePath(path) {
  const segments = [];
  let i = 0;
  while (i < path.length) {
    if (path[i] === "[") {
      const end = path.indexOf("]", i);
      if (end === -1) return { error: `unclosed bracket at position ${i}` };
      const num = parseInt(path.slice(i + 1, end), 10);
      if (isNaN(num)) return { error: `non-numeric index: ${path.slice(i + 1, end)}` };
      segments.push({ type: "index", value: num });
      i = end + 1;
      if (i < path.length && path[i] === ".") i++;
    } else if (path[i] === ".") {
      i++;
    } else {
      let end = i;
      while (end < path.length && path[end] !== "." && path[end] !== "[") end++;
      if (end === i) return { error: `unexpected character at position ${i}` };
      segments.push({ type: "key", value: path.slice(i, end) });
      i = end;
    }
  }
  if (segments.length === 0) return { error: "empty path" };
  return segments;
}

// Return the value directly if small enough, otherwise build a budget-bounded summary.
function present(value, maxChars) {
  if (value === null || value === undefined) return { value: null };
  if (typeof value === "boolean" || typeof value === "number") return { value };
  if (typeof value === "string") {
    if (value.length <= maxChars) return { value };
    return { value: value.slice(0, maxChars) + "...", truncated: true, total_chars: value.length };
  }

  if (Array.isArray(value)) {
    // Check if the whole array fits
    const full = JSON.stringify(value);
    if (full.length <= maxChars) return value;
    // Summarize with brief signatures per item
    return {
      type: "array",
      count: value.length,
      items: value.map((item, i) => `${i}: ${briefSignature(item)}`),
    };
  }

  if (typeof value === "object") {
    const full = JSON.stringify(value);
    if (full.length <= maxChars) return value;
    // Budget-bounded summary: include complete fields until budget exhausted
    return summarizeObject(value, maxChars);
  }

  return { value };
}

// Build a summary object with as many complete fields as fit within the char budget.
function summarizeObject(obj, maxChars) {
  const result = {};
  const omitted = [];
  const keys = Object.keys(obj);
  // Reserve space for _omitted and _total_keys metadata (~100 chars)
  let budget = maxChars - 100;

  for (const key of keys) {
    const serialized = JSON.stringify(obj[key]);
    const overhead = JSON.stringify(key).length + 2; // key + colon + comma

    if (serialized.length + overhead <= budget) {
      // Full field fits — include it
      result[key] = obj[key];
      budget -= serialized.length + overhead;
    } else if (budget > overhead + 50) {
      // Field doesn't fit whole — handle by type
      const v = obj[key];
      if (typeof v === "string") {
        // Truncate string to remaining budget
        const available = budget - overhead - 5; // room for "..."
        result[key] = v.slice(0, Math.max(available, 20)) + "...";
        budget = 0;
      } else if (Array.isArray(v)) {
        result[key] = `(array, ${v.length} items)`;
        budget -= overhead + result[key].length + 2;
      } else if (typeof v === "object" && v !== null) {
        result[key] = `(object, ${Object.keys(v).length} keys)`;
        budget -= overhead + result[key].length + 2;
      } else {
        result[key] = obj[key];
        budget = 0;
      }
    } else {
      omitted.push(key);
    }
  }

  if (omitted.length > 0) {
    result._omitted = omitted;
    result._total_keys = keys.length;
  }

  return result;
}

function briefSignature(obj) {
  if (obj === null || obj === undefined) return "null";
  if (typeof obj !== "object") return String(obj);
  if (Array.isArray(obj)) return `array (${obj.length} items)`;

  if (obj.event) {
    const parts = [obj.event];
    if (obj.step) parts.push(obj.step);
    if ("ok" in obj) parts.push(`ok=${obj.ok}`);
    if (obj.tool) parts.push(obj.tool);
    if (obj.error) parts.push(`error`);
    return parts.join(" ");
  }

  if (obj.type === "function" && obj.function?.name) {
    return `function ${obj.function.name}`;
  }
  if (obj.function?.name) {
    return `function ${obj.function.name}`;
  }

  if (obj.role) return `${obj.role} message`;

  return `object (${Object.keys(obj).length} keys)`;
}
