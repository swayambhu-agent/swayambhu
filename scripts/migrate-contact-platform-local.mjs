#!/usr/bin/env node
// Migrate local KV from old contact schema to contact_platform: schema.
// Works against the local Miniflare SQLite store (no wrangler needed).
//
// Usage: node scripts/migrate-contact-platform-local.mjs [--dry-run]

import { getKV, dispose } from "./shared.mjs";

const dryRun = process.argv.includes("--dry-run");
const kv = await getKV();

if (dryRun) console.log("=== DRY RUN ===\n");

// 1. Create contact_platform:slack:U084ASKBXB7
const platformKey = "contact_platform:slack:U084ASKBXB7";
const platformValue = { slug: "swami_kevala", approved: true };
console.log(`1. Creating ${platformKey}`);
if (!dryRun) {
  await kv.put(platformKey, JSON.stringify(platformValue), {
    metadata: { type: "contact_platform", format: "json", updated_at: new Date().toISOString() },
  });
}

// 2. Update contact:swami_kevala — remove approved/platforms, keep the rest
const contactKey = "contact:swami_kevala";
const existing = await kv.get(contactKey, "json");
console.log(`2. Updating ${contactKey}`);
if (existing) {
  const { approved, platforms, ...clean } = existing;
  console.log(`   Removing fields: approved=${approved}, platforms=${JSON.stringify(platforms)}`);
  if (!dryRun) {
    await kv.put(contactKey, JSON.stringify(clean), {
      metadata: { type: "contact", format: "json", updated_at: new Date().toISOString() },
    });
  }
} else {
  console.log("   WARNING: contact:swami_kevala not found — skipping");
}

// 3. Delete old contact_index
const indexKey = "contact_index:slack:U084ASKBXB7";
const indexExists = await kv.get(indexKey);
console.log(`3. Deleting ${indexKey}${indexExists ? "" : " (already gone)"}`);
if (!dryRun && indexExists) {
  await kv.delete(indexKey);
}

// 4. Delete patron:identity_snapshot to force fresh snapshot on next boot
const snapshotKey = "patron:identity_snapshot";
console.log(`4. Deleting ${snapshotKey} (will regenerate on next boot)`);
if (!dryRun) {
  await kv.delete(snapshotKey);
}

console.log("\n=== Migration complete ===");
console.log("Next wake will create a fresh patron identity snapshot.");

await dispose();
