#!/usr/bin/env node
// Write a KV key. Usage:
//   node scripts/write-kv.mjs <key> <file>        — read from file (.json → json, else text)
//   node scripts/write-kv.mjs <key> <json-value>  — inline JSON
//   echo '...' | node scripts/write-kv.mjs <key> --stdin
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { getKV, root, dispose } from "./shared.mjs";

const key = process.argv[2];
if (!key) {
  console.error("Usage: node scripts/write-kv.mjs <key> <file>");
  console.error("       node scripts/write-kv.mjs <key> <json-value>");
  console.error("       echo '{...}' | node scripts/write-kv.mjs <key> --stdin");
  process.exit(1);
}

let raw, fileSource;
if (process.argv[3] === "--stdin") {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  raw = Buffer.concat(chunks).toString();
} else {
  const arg = process.argv.slice(3).join(" ");
  const filePath = resolve(root, arg);
  if (existsSync(filePath) && !arg.startsWith("{")) {
    raw = readFileSync(filePath, "utf8");
    fileSource = arg;
  } else {
    raw = arg;
  }
}

if (!raw) { console.error("No value provided"); process.exit(1); }

// Detect format: .json file or parseable JSON → json, else text
let value, format;
if (fileSource?.endsWith(".json")) {
  value = JSON.parse(raw);
  format = "json";
} else {
  try {
    value = JSON.parse(raw);
    format = "json";
  } catch {
    value = raw;
    format = "text";
  }
}

const kv = await getKV();
const serialized = format === "json" ? JSON.stringify(value) : value;
await kv.put(key, serialized, {
  metadata: { type: "manual", format, updated_at: new Date().toISOString() },
});
console.log(`${key} ← ${fileSource || "inline"} (${format}, ${serialized.length} bytes)`);
await dispose();
