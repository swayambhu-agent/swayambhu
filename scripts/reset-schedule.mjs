#!/usr/bin/env node
// Reset session_schedule.next_session_after to the past so the next session isn't skipped.
// Uses Miniflare with a hard process.exit() to avoid dispose() hangs.

import { getKV } from "./shared.mjs";

const kv = await getKV();
const raw = await kv.get("session_schedule");

if (raw) {
  const cfg = JSON.parse(raw);
  cfg.next_session_after = "2020-01-01T00:00:00Z";
  await kv.put("session_schedule", JSON.stringify(cfg), { metadata: { format: "json" } });
  console.log("  reset next_session_after to past");
} else {
  console.log("  no session_schedule found (first run?) — skipping");
}

// Force exit — mf.dispose() can hang if workerd subprocess won't quit
process.exit(0);
