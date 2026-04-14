import Ajv2020 from "ajv/dist/2020.js";

import kvOperationSchema from "../schemas/kv-operation.schema.json" with { type: "json" };
import kvOperationBatchSchema from "../schemas/kv-operation-batch.schema.json" with { type: "json" };
import experienceRecordSchema from "../schemas/experience-record.schema.json" with { type: "json" };

const SCHEMAS = new Map([
  ["kv-operation", kvOperationSchema],
  ["kv-operation-batch", kvOperationBatchSchema],
  ["experience-record", experienceRecordSchema],
]);

const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
  allowUnionTypes: true,
});

const validatorCache = new Map();

function getSchema(schemaName) {
  const schema = SCHEMAS.get(schemaName);
  if (!schema) {
    throw new Error(`Unknown runtime schema "${schemaName}"`);
  }
  return schema;
}

function getValidator(schemaName) {
  if (validatorCache.has(schemaName)) {
    return validatorCache.get(schemaName);
  }
  const schema = getSchema(schemaName);
  const validate = ajv.compile(schema);
  validatorCache.set(schemaName, validate);
  return validate;
}

function formatErrorDetails(errors = []) {
  return errors.map((error) => ({
    instancePath: error.instancePath || "",
    keyword: error.keyword,
    message: error.message || "validation error",
    params: error.params || {},
  }));
}

export function validateWithSchema(schemaName, value) {
  const validate = getValidator(schemaName);
  const ok = validate(value);
  if (ok) {
    return { ok: true, value };
  }

  const details = formatErrorDetails(validate.errors || []);
  const primary = details[0];
  return {
    ok: false,
    error: primary
      ? `${schemaName}: ${primary.instancePath || "/"} ${primary.message}`.trim()
      : `${schemaName}: validation failed`,
    details,
  };
}

export function getRegisteredRuntimeSchemas() {
  return [...SCHEMAS.keys()];
}
