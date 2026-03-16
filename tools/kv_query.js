export const meta = { secrets: [], kv_access: "read_all", timeout_ms: 5000 };

export async function execute({ key, path, kv }) {
  if (!key) return { error: "missing required param: key" };

  const raw = await kv.get(key);
  if (raw === null) return { error: `no value found for key: ${key}` };

  const data = typeof raw === "string" ? JSON.parse(raw) : raw;

  if (!path) return present(data);

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

  return present(current);
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

// Return the value directly for small/simple data, summarize for large structures.
function present(value) {
  if (value === null || value === undefined) return { value: null };
  if (typeof value === "boolean" || typeof value === "number") return { value };
  if (typeof value === "string") return { value };

  if (Array.isArray(value)) {
    return {
      type: "array",
      count: value.length,
      items: value.map((item, i) => `${i}: ${briefSignature(item)}`),
    };
  }

  if (typeof value === "object") {
    const keys = Object.keys(value);
    const hasNestedArray = keys.some(k => Array.isArray(value[k]));
    if (keys.length <= 10 && !hasNestedArray) return value;
    // Large or complex object — summarize fields
    const fields = {};
    for (const [k, v] of Object.entries(value)) {
      fields[k] = describeValue(v);
    }
    return { type: "object", fields };
  }
  return { value };
}

function describeValue(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return String(v);
  if (typeof v === "number") return String(v);
  if (typeof v === "string") {
    if (v.length <= 120) return JSON.stringify(v);
    return `string (${v.length} chars)`;
  }
  if (Array.isArray(v)) return `array (${v.length} items)`;
  if (typeof v === "object") return `object (${Object.keys(v).length} keys)`;
  return String(v);
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
