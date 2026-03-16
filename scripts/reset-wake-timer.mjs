#!/usr/bin/env node
// Reset wake_config.next_wake_after to the past so the next wake isn't skipped.
// Uses Miniflare with a hard process.exit() to avoid dispose() hangs.

import { getKV } from "./shared.mjs";

const kv = await getKV();
const raw = await kv.get("wake_config");

if (raw) {
  const cfg = JSON.parse(raw);
  cfg.next_wake_after = "2020-01-01T00:00:00Z";
  await kv.put("wake_config", JSON.stringify(cfg), { metadata: { format: "json" } });
  console.log("  reset next_wake_after to past");
} else {
  console.log("  no wake_config found (first run?) — skipping");
}

// Force exit — mf.dispose() can hang if workerd subprocess won't quit
process.exit(0);
