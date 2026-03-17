#!/usr/bin/env node
// Sync kernel:tool_grants from tool source files without re-seeding all KV.
// Usage: node scripts/sync-tool-grants.mjs
//
// Reads each tools/*.js module, extracts security grant fields
// (secrets, communication, inbound, provider), and writes the
// assembled grants object to kernel:tool_grants.

import { resolve } from "path";
import { pathToFileURL } from "url";
import { getKV, root, dispose } from "./shared.mjs";

const importLocal = (rel) => import(pathToFileURL(resolve(root, rel)).href);

const kv = await getKV();

const toolNames = [
  "send_slack", "web_fetch", "kv_write",
  "kv_manifest", "kv_query", "akash_exec",
  "check_email", "send_email",
];

const GRANT_FIELDS = ["secrets", "communication", "inbound", "provider"];
const toolGrants = {};

for (const name of toolNames) {
  const mod = await importLocal(`tools/${name}.js`);
  const grant = {};
  for (const field of GRANT_FIELDS) {
    if (mod.meta?.[field] !== undefined) {
      grant[field] = mod.meta[field];
    }
  }
  if (Object.keys(grant).length) toolGrants[name] = grant;
}

await kv.put("kernel:tool_grants", JSON.stringify(toolGrants), {
  metadata: { format: "json", description: "Security grants per tool — secrets, communication gate, inbound gate, provider bindings (kernel-only)" },
});

console.log("kernel:tool_grants synced:");
for (const [tool, grant] of Object.entries(toolGrants)) {
  console.log(`  ${tool}: ${Object.keys(grant).join(", ")}`);
}

await dispose();
