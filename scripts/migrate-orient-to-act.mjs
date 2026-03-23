#!/usr/bin/env node
// Migrate KV: rename all "orient" references to "act"
// Handles: prompt key rename, config:defaults, karma entries, reflect entries,
// last_reflect, hook metadata, and karma_summary entries.

import { getKV, dispose } from "./shared.mjs";

const kv = await getKV();
let changes = 0;

function replaceOrient(str) {
  return str
    .replace(/orient_turn_/g, "act_turn_")
    .replace(/orient_parse_error/g, "act_parse_error")
    .replace(/next_orient_context/g, "next_act_context")
    .replace(/"orient"/g, '"act"')
    .replace(/prompt:orient/g, "prompt:act")
    .replace(/config\.orient/g, "config.act")
    .replace(/defaults\.orient/g, "defaults.act");
}

// 1. Rename prompt:orient → prompt:act
const promptText = await kv.get("prompt:orient", "text");
if (promptText) {
  await kv.put("prompt:act", promptText, {
    metadata: { format: "text", description: "Act session system prompt — shapes waking behavior" },
  });
  await kv.delete("prompt:orient");
  console.log("✓ prompt:orient → prompt:act");
  changes++;
} else {
  console.log("  prompt:orient not found (already migrated?)");
}

// 2. config:defaults — rename "orient" key to "act"
const defaults = await kv.get("config:defaults", "json");
if (defaults?.orient) {
  defaults.act = defaults.orient;
  delete defaults.orient;
  await kv.put("config:defaults", JSON.stringify(defaults), {
    metadata: { type: "config", format: "json", updated_at: new Date().toISOString() },
  });
  console.log("✓ config:defaults: orient → act");
  changes++;
}

// 3. last_reflect — rename next_orient_context
const lastReflect = await kv.get("last_reflect", "json");
if (lastReflect) {
  let changed = false;
  if (lastReflect.next_orient_context) {
    lastReflect.next_act_context = lastReflect.next_orient_context;
    delete lastReflect.next_orient_context;
    changed = true;
  }
  const str = JSON.stringify(lastReflect);
  if (str.includes("orient")) {
    const updated = JSON.parse(replaceOrient(str));
    await kv.put("last_reflect", JSON.stringify(updated), {
      metadata: { updated_at: new Date().toISOString() },
    });
    console.log("✓ last_reflect updated");
    changes++;
  } else if (changed) {
    await kv.put("last_reflect", JSON.stringify(lastReflect), {
      metadata: { updated_at: new Date().toISOString() },
    });
    console.log("✓ last_reflect updated (next_orient_context → next_act_context)");
    changes++;
  }
}

// 4. All karma:* entries — replace orient_turn_N → act_turn_N in step names
const karmaKeys = await listAll(kv, "karma:");
for (const key of karmaKeys) {
  const raw = await kv.get(key, "text");
  if (!raw || !raw.includes("orient")) continue;
  const updated = replaceOrient(raw);
  await kv.put(key, updated, {
    metadata: await getMeta(kv, key),
  });
  console.log(`✓ ${key} updated`);
  changes++;
}

// 5. All karma_summary:* entries
const summaryKeys = await listAll(kv, "karma_summary:");
for (const key of summaryKeys) {
  const raw = await kv.get(key, "text");
  if (!raw || !raw.includes("orient")) continue;
  const updated = replaceOrient(raw);
  await kv.put(key, updated, {
    metadata: await getMeta(kv, key),
  });
  console.log(`✓ ${key} updated`);
  changes++;
}

// 6. All reflect:0:* and reflect:1:* entries
const reflectKeys = [
  ...await listAll(kv, "reflect:0:"),
  ...await listAll(kv, "reflect:1:"),
];
for (const key of reflectKeys) {
  const raw = await kv.get(key, "text");
  if (!raw || !raw.includes("orient")) continue;
  const updated = replaceOrient(raw);
  await kv.put(key, updated, {
    metadata: await getMeta(kv, key),
  });
  console.log(`✓ ${key} updated`);
  changes++;
}

// 7. hook:act:code metadata description
const actMeta = await getMetaObj(kv, "hook:act:code");
if (actMeta?.description?.includes("orient")) {
  actMeta.description = actMeta.description.replace(/orient/g, "act");
  const code = await kv.get("hook:act:code", "text");
  await kv.put("hook:act:code", code, { metadata: actMeta });
  console.log("✓ hook:act:code metadata updated");
  changes++;
}

// 8. Update hook:act:code content (the actual act.js source in KV)
const actCode = await kv.get("hook:act:code", "text");
if (actCode && actCode.includes("orient")) {
  const updated = replaceOrient(actCode)
    .replace(/orientPrompt/g, "actPrompt")
    .replace(/orientModel/g, "actModel")
    .replace(/orientBudgetCap/g, "actBudgetCap")
    .replace(/buildOrientContext/g, "buildActContext");
  await kv.put("hook:act:code", updated, {
    metadata: await getMeta(kv, "hook:act:code"),
  });
  console.log("✓ hook:act:code content updated");
  changes++;
}

// 9. Update hook:reflect:code content (reflect.js source in KV references orient)
const reflectCode = await kv.get("hook:reflect:code", "text");
if (reflectCode && reflectCode.includes("orient")) {
  const updated = replaceOrient(reflectCode)
    .replace(/orientPrompt/g, "actPrompt");
  await kv.put("hook:reflect:code", updated, {
    metadata: await getMeta(kv, "hook:reflect:code"),
  });
  console.log("✓ hook:reflect:code content updated");
  changes++;
}

// 10. prompt:reflect:1 (deep reflect prompt in KV)
const deepPrompt = await kv.get("prompt:reflect:1", "text");
if (deepPrompt && deepPrompt.includes("orient")) {
  const updated = deepPrompt
    .replace(/orient prompt/g, "act prompt")
    .replace(/orient cost/g, "act cost")
    .replace(/orientPrompt/g, "actPrompt")
    .replace(/next_orient_context/g, "next_act_context")
    .replace(/Your orient prompt/g, "Your act prompt")
    .replace(/Examine your orient prompt/g, "Examine your act prompt")
    .replace(/orient prompts/g, "act prompts")
    .replace(/prompt:orient/g, "prompt:act")
    .replace(/prajna:orient/g, "prajna:act");
  await kv.put("prompt:reflect:1", updated, {
    metadata: await getMeta(kv, "prompt:reflect:1"),
  });
  console.log("✓ prompt:reflect:1 updated");
  changes++;
}

// 11. prompt:reflect (session reflect prompt)
const reflectPrompt = await kv.get("prompt:reflect", "text");
if (reflectPrompt && reflectPrompt.includes("orient")) {
  const updated = reflectPrompt
    .replace(/next_orient_context/g, "next_act_context");
  await kv.put("prompt:reflect", updated, {
    metadata: await getMeta(kv, "prompt:reflect"),
  });
  console.log("✓ prompt:reflect updated");
  changes++;
}

// 12. dashboard session type in cache:session_ids (if it stores type)
// This is just an array of IDs, no orient references — skip.

console.log(`\nDone. ${changes} KV entries updated.`);
await dispose();

// ── Helpers ──────────────────────────────────────────────────

async function listAll(kv, prefix) {
  const keys = [];
  let cursor;
  do {
    const result = await kv.list({ prefix, cursor });
    keys.push(...result.keys.map(k => k.name));
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);
  return keys;
}

async function getMeta(kv, key) {
  const { metadata } = await kv.getWithMetadata(key);
  return metadata || {};
}

async function getMetaObj(kv, key) {
  const { metadata } = await kv.getWithMetadata(key);
  return metadata;
}
