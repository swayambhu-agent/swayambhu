#!/usr/bin/env node
// Delete a KV key. Usage: node scripts/delete-kv.mjs <key>
import { getKV, dispose } from "./shared.mjs";
const key = process.argv[2];
if (!key) { console.error("Usage: node scripts/delete-kv.mjs <key>"); process.exit(1); }
const kv = await getKV();
await kv.delete(key);
console.log(`deleted: ${key}`);
await dispose();
