#!/usr/bin/env node
// Read keys from local KV store via Miniflare API.
//
// Usage:
//   node scripts/read-kv.mjs                     # list all keys
//   node scripts/read-kv.mjs karma:              # list keys with prefix
//   node scripts/read-kv.mjs karma:s_123_abc     # read a specific key's value
//   node scripts/read-kv.mjs --json karma:s_123  # output raw JSON (for piping)

import { getKV, dispose } from "./shared.mjs";

const args = process.argv.slice(2);
const jsonFlag = args.includes("--json");
const query = args.find(a => a !== "--json") || "";

const kv = await getKV();

try {
  // Try reading as exact key first
  if (query && !query.endsWith(":")) {
    let val = await kv.get(query, "json").catch(() => null);
    if (val === null) val = await kv.get(query, "text");
    if (val !== null) {
      if (jsonFlag) {
        process.stdout.write(typeof val === "string" ? val : JSON.stringify(val));
      } else {
        console.log(`=== ${query} ===`);
        console.log(typeof val === "string" ? val : JSON.stringify(val, null, 2));
      }
      await dispose();
      process.exit(0);
    }
  }

  // List keys (optionally with prefix)
  const prefix = query.endsWith(":") ? query : query || undefined;
  const list = await kv.list({ prefix, limit: 500 });

  if (list.keys.length === 0) {
    // If query didn't end with ":", it might have been an exact key miss
    if (query && !query.endsWith(":")) {
      console.error(`Key not found: ${query}`);
      console.error(`(Try "${query}:" to list keys with that prefix)`);
    } else {
      console.error(`No keys found${prefix ? ` with prefix "${prefix}"` : ""}`);
    }
    await dispose();
    process.exit(1);
  }

  if (jsonFlag) {
    process.stdout.write(JSON.stringify(list.keys.map(k => k.name)));
  } else {
    console.log(`${list.keys.length} keys${prefix ? ` (prefix: ${prefix})` : ""}:\n`);
    for (const k of list.keys) {
      const meta = k.metadata ? ` ${JSON.stringify(k.metadata)}` : "";
      console.log(`  ${k.name}${meta}`);
    }
  }
} finally {
  await dispose();
}
