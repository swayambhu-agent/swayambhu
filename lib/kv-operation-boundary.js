import { validateWithSchema } from "./runtime-validation.js";

export const MAX_MODEL_KV_OPS_PER_BATCH = 50;

export const SOURCE_ALLOWED_OPS = Object.freeze({
  reflect: new Set(["put", "delete", "patch"]),
  "deep-reflect": new Set(["put", "delete", "patch"]),
  "userspace-review": new Set(["put", "delete", "patch", "field_merge"]),
  "authority-review": new Set(["put", "delete", "patch", "field_merge"]),
});

const RECOGNIZED_FIELDS = [
  "op",
  "key",
  "value",
  "old_string",
  "new_string",
  "fields",
  "metadata",
  "deliberation",
];

function isPlainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function buildRawExcerpt(rawOp) {
  if (!isPlainObject(rawOp)) {
    return {
      raw_type: Array.isArray(rawOp) ? "array" : rawOp === null ? "null" : typeof rawOp,
    };
  }

  const excerpt = {};
  if (Object.hasOwn(rawOp, "op")) excerpt.op = rawOp.op;
  if (Object.hasOwn(rawOp, "operation")) excerpt.operation = rawOp.operation;
  if (Object.hasOwn(rawOp, "key")) excerpt.key = rawOp.key;
  if (Object.hasOwn(rawOp, "value")) {
    excerpt.value_type = rawOp.value === null
      ? "null"
      : Array.isArray(rawOp.value)
      ? "array"
      : typeof rawOp.value;
  }
  if (Object.hasOwn(rawOp, "fields")) {
    excerpt.fields = isPlainObject(rawOp.fields)
      ? Object.keys(rawOp.fields)
      : Array.isArray(rawOp.fields)
      ? "array"
      : typeof rawOp.fields;
  }
  if (Object.hasOwn(rawOp, "old_string")) excerpt.has_old_string = true;
  if (Object.hasOwn(rawOp, "new_string")) excerpt.has_new_string = true;
  if (Object.hasOwn(rawOp, "deliberation")) {
    excerpt.deliberation_length = typeof rawOp.deliberation === "string"
      ? rawOp.deliberation.length
      : null;
  }
  return excerpt;
}

function classifyKvOperationSchemaError(rawOp) {
  if (!isPlainObject(rawOp)) return null;
  const hints = [];
  if (!Object.hasOwn(rawOp, "op") && Object.hasOwn(rawOp, "operation")) {
    hints.push("Expected canonical field 'op'; found 'operation'.");
  }
  const opValue = Object.hasOwn(rawOp, "op") ? rawOp.op : rawOp.operation;
  if (opValue === "set") {
    hints.push("Unsupported op 'set'; canonical op is 'put'.");
  }
  return hints.length ? hints.join(" ") : null;
}

function extractRecognizedFields(rawOp) {
  const extracted = {};
  for (const field of RECOGNIZED_FIELDS) {
    if (Object.hasOwn(rawOp, field)) {
      extracted[field] = rawOp[field];
    }
  }
  return extracted;
}

function prepareKernelWriteOp(op) {
  switch (op.op) {
    case "put":
      return {
        op: "put",
        key: op.key,
        value: op.value,
        ...(op.metadata ? { metadata: op.metadata } : {}),
        ...(op.deliberation ? { deliberation: op.deliberation } : {}),
      };
    case "delete":
      return {
        op: "delete",
        key: op.key,
        ...(op.deliberation ? { deliberation: op.deliberation } : {}),
      };
    case "patch":
      return {
        op: "patch",
        key: op.key,
        old_string: op.old_string,
        new_string: op.new_string,
        ...(op.metadata ? { metadata: op.metadata } : {}),
        ...(op.deliberation ? { deliberation: op.deliberation } : {}),
      };
    case "field_merge":
      return {
        op: "field_merge",
        key: op.key,
        fields: op.fields,
        ...(op.metadata ? { metadata: op.metadata } : {}),
        ...(op.deliberation ? { deliberation: op.deliberation } : {}),
      };
    default:
      return op;
  }
}

function validateKeyStructure(key) {
  if (typeof key !== "string" || key.length === 0) {
    return "key must be a non-empty string";
  }
  if (/[\u0000-\u001F]/.test(key)) {
    return `key "${key}" contains control characters`;
  }
  if (key.includes("\n") || key.includes("\r")) {
    return `key "${key}" contains embedded newlines`;
  }
  if (key.startsWith(":")) {
    return `key "${key}" has an empty prefix segment`;
  }
  if (key.endsWith(":")) {
    return `key "${key}" has an empty suffix segment`;
  }
  return null;
}

async function validateSemanticShape(op) {
  if (op.op === "put" && op.key.startsWith("experience:")) {
    const result = validateWithSchema("experience-record", op.value);
    if (!result.ok) {
      return { ok: false, stage: "schema", error: result.error };
    }
  }
  return { ok: true };
}

function buildRejected(rawOp, stage, error, diagnosticHint = null) {
  return {
    raw: rawOp,
    raw_op_excerpt: buildRawExcerpt(rawOp),
    stage,
    error,
    ...(diagnosticHint ? { diagnostic_hint: diagnosticHint } : {}),
  };
}

export async function prepareModelKvOperations(rawOps, options = {}) {
  const { source, validators = [] } = options;

  if (rawOps == null) {
    return { ok: true, accepted: [], rejected: [], batchRejected: false };
  }

  const batchValidation = validateWithSchema("kv-operation-batch", rawOps);
  if (!batchValidation.ok) {
    return {
      ok: false,
      accepted: [],
      rejected: [buildRejected(rawOps, "schema", batchValidation.error, null)],
      batchRejected: true,
    };
  }

  if (rawOps.length > MAX_MODEL_KV_OPS_PER_BATCH) {
    return {
      ok: false,
      accepted: [],
      rejected: [buildRejected(rawOps, "schema", `kv-operation-batch: batch exceeds ${MAX_MODEL_KV_OPS_PER_BATCH} items`, null)],
      batchRejected: true,
    };
  }

  const allowedOps = SOURCE_ALLOWED_OPS[source];
  if (!allowedOps) {
    return {
      ok: false,
      accepted: [],
      rejected: [buildRejected(rawOps, "source", `Unknown model KV-op source "${source}"`, null)],
      batchRejected: true,
    };
  }

  const accepted = [];
  const rejected = [];
  for (const rawOp of rawOps) {
    if (!isPlainObject(rawOp)) {
      rejected.push(buildRejected(rawOp, "schema", "kv-operation: each batch member must be a plain object"));
      continue;
    }

    const extracted = extractRecognizedFields(rawOp);
    const schemaValidation = validateWithSchema("kv-operation", extracted);
    if (!schemaValidation.ok) {
      rejected.push(buildRejected(rawOp, "schema", schemaValidation.error, classifyKvOperationSchemaError(rawOp)));
      continue;
    }

    const keyError = validateKeyStructure(extracted.key);
    if (keyError) {
      rejected.push(buildRejected(rawOp, "schema", keyError, classifyKvOperationSchemaError(rawOp)));
      continue;
    }

    if (!allowedOps.has(extracted.op)) {
      rejected.push(buildRejected(rawOp, "source", `Operation "${extracted.op}" is not allowed for source "${source}"`, classifyKvOperationSchemaError(rawOp)));
      continue;
    }

    const semanticValidation = await validateSemanticShape(extracted);
    if (!semanticValidation.ok) {
      rejected.push(buildRejected(rawOp, semanticValidation.stage, semanticValidation.error, classifyKvOperationSchemaError(rawOp)));
      continue;
    }

    let candidate = extracted;
    let customError = null;
    for (const validator of validators) {
      const result = await validator({ op: candidate, source });
      if (!result || result.ok === false) {
        customError = result?.error || "validator rejected kv operation";
        break;
      }
      if (result?.op) {
        candidate = result.op;
      }
    }
    if (customError) {
      rejected.push(buildRejected(rawOp, "validator", customError, classifyKvOperationSchemaError(rawOp)));
      continue;
    }

    accepted.push(candidate);
  }

  if (rejected.length > 0) {
    return { ok: false, accepted: [], rejected, batchRejected: true };
  }

  return { ok: true, accepted, rejected: [], batchRejected: false };
}

export async function applyModelKvOperations(K, rawOps, options = {}) {
  const { source, context = source, validators = [] } = options;

  const prepared = await prepareModelKvOperations(rawOps, { source, validators });

  if (prepared.batchRejected) {
    for (const rejection of prepared.rejected) {
      await K.karmaRecord({
        event: "kv_operation_schema_rejected",
        source,
        stage: rejection.stage,
        error: rejection.error,
        raw_op_excerpt: rejection.raw_op_excerpt,
        ...(rejection.diagnostic_hint ? { diagnostic_hint: rejection.diagnostic_hint } : {}),
      });
    }
    await K.karmaRecord({
      event: "kv_operation_batch_rejected",
      source,
      rejected_count: prepared.rejected.length,
      first_error: prepared.rejected[0]?.error || "unknown error",
    });
    return {
      ok: false,
      batchRejected: true,
      applied: 0,
      blocked: [],
      rejected: prepared.rejected,
      accepted: [],
    };
  }

  const blocked = [];
  let applied = 0;
  for (const op of prepared.accepted) {
    const result = await K.kvWriteGated(prepareKernelWriteOp(op), context);
    if (!result?.ok) {
      blocked.push({ key: op.key, error: result?.error || "unknown error" });
      continue;
    }
    applied += 1;
  }

  if (blocked.length > 0) {
    await K.karmaRecord({
      event: "kv_writes_blocked",
      source,
      context,
      blocked,
    });
  }

  return {
    ok: blocked.length === 0,
    batchRejected: false,
    applied,
    blocked,
    rejected: [],
    accepted: prepared.accepted,
  };
}

export { classifyKvOperationSchemaError };
