#!/usr/bin/env node
// Clear session_schedule so the next /__scheduled trigger runs immediately.
import { getKV, dispose } from "./shared.mjs";
const kv = await getKV();
await kv.delete("session_schedule");
await dispose();
console.log("  session_schedule cleared");
