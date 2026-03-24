#!/usr/bin/env node
// Migrates all viveka references in KV — keys, values, and stale entries.
// Preserves historical records (karma, reflect outputs) untouched.
// Safe to run multiple times.

import { readFileSync } from "fs";
import { resolve } from "path";
import { getKV, root, dispose } from "./shared.mjs";

const read = (rel) => readFileSync(resolve(root, rel), "utf8");
const kv = await getKV();

let renamed = 0, reseeded = 0, patched = 0, deleted = 0;

// ── 1. Rename viveka:* keys → upaya:* ────────────────────────

const vivList = await kv.list({ prefix: "viveka:" });
for (const { name: oldKey, metadata } of vivList.keys) {
  const newKey = oldKey.replace(/^viveka:/, "upaya:");
  const raw = await kv.get(oldKey, "text");
  let value = raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.type === "viveka") {
      parsed.type = "upaya";
      value = JSON.stringify(parsed);
    }
  } catch { /* not JSON */ }
  await kv.put(newKey, value, metadata ? { metadata } : undefined);
  await kv.delete(oldKey);
  console.log(`  rename: ${oldKey} → ${newKey}`);
  renamed++;
}

// ── 2. Re-seed source-of-truth keys from updated disk files ──
//    These were seeded before the rename and still have "viveka" in text.

const reseedMap = {
  "prompt:act":           () => read("prompts/act.md"),
  "prompt:reflect":       () => read("prompts/reflect.md"),
  "prompt:reflect:1":     () => read("prompts/deep-reflect.md"),
  "hook:act:code":        () => read("act.js"),
  "hook:reflect:code":    () => read("reflect.js"),
  "kernel:source:kernel.js":   () => read("kernel.js"),
  "kernel:source:hook-chat.js": () => read("hook-chat.js"),
  "doc:design_rationale": () => read("docs/agent/design-rationale.md"),
  "doc:proposal_guide": () => read("docs/agent/proposal-guide.md"),
  "doc:wisdom_guide":     () => read("docs/agent/wisdom-guide.md"),
  "skill:skill-authoring": () => read("skills/skill-authoring.md"),
};

for (const [key, readFn] of Object.entries(reseedMap)) {
  const { value: existing, metadata } = await kv.getWithMetadata(key, "text");
  if (!existing) continue; // key doesn't exist, skip
  const fresh = readFn();
  if (existing !== fresh) {
    await kv.put(key, fresh, metadata ? { metadata } : undefined);
    console.log(`  reseed: ${key}`);
    reseeded++;
  }
}

// Re-seed config:tool_registry (JSON — need to re-read tool descriptions)
{
  const { value: raw, metadata } = await kv.getWithMetadata("config:tool_registry", "text");
  if (raw && raw.includes("viveka")) {
    const updated = raw.replace(/viveka/g, "upaya");
    await kv.put("config:tool_registry", updated, metadata ? { metadata } : undefined);
    console.log(`  patch:  config:tool_registry`);
    patched++;
  }
}

// ── 3. Patch last_reflect (live config read by future sessions) ──

{
  const { value: raw, metadata } = await kv.getWithMetadata("last_reflect", "text");
  if (raw && raw.includes("viveka")) {
    const updated = raw.replace(/viveka/g, "upaya").replace(/Viveka/g, "Upaya");
    await kv.put("last_reflect", updated, metadata ? { metadata } : undefined);
    console.log(`  patch:  last_reflect`);
    patched++;
  }
}

// ── 4. Delete stale hook keys from old architecture ──────────

const staleKeys = [
  "hook:wake:proposals",
  "hook:wake:reflect",
  "hook:wake:code",
  "hook:wake:manifest",
  "hook:wake:protect",
];

for (const key of staleKeys) {
  const val = await kv.get(key, "text");
  if (val !== null) {
    await kv.delete(key);
    console.log(`  delete: ${key} (stale)`);
    deleted++;
  }
}

// ── Summary ──────────────────────────────────────────────────

console.log(`\nDone: ${renamed} renamed, ${reseeded} reseeded, ${patched} patched, ${deleted} stale deleted.`);
console.log("Karma and reflect history left untouched (historical records).");
await dispose();
