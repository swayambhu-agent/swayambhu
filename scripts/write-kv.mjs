#!/usr/bin/env node
// Write a KV key. Usage:
//   node scripts/write-kv.mjs <key> <json-value>
//   echo '...' | node scripts/write-kv.mjs <key> --stdin
import { getKV, dispose } from "./shared.mjs";

const key = process.argv[2];
if (!key) {
  console.error("Usage: node scripts/write-kv.mjs <key> <json-value>");
  console.error("       echo '{...}' | node scripts/write-kv.mjs <key> --stdin");
  process.exit(1);
}

let raw;
if (process.argv[3] === "--stdin") {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  raw = Buffer.concat(chunks).toString();
} else {
  raw = process.argv.slice(3).join(" ");
}

if (!raw) { console.error("No value provided"); process.exit(1); }

// Detect format: try JSON parse, fall back to text
let value, format;
try {
  value = JSON.parse(raw);
  format = "json";
} catch {
  value = raw;
  format = "text";
}

const kv = await getKV();
const serialized = format === "json" ? JSON.stringify(value) : value;
await kv.put(key, serialized, {
  metadata: { type: "manual", format, updated_at: new Date().toISOString() },
});
console.log(`wrote ${key} (${format}, ${serialized.length} bytes)`);
await dispose();
