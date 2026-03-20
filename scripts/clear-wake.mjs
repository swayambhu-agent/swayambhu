#!/usr/bin/env node
// Clear wake_config so the next /__scheduled trigger runs immediately.
import { getKV, dispose } from "./shared.mjs";
const kv = await getKV();
await kv.delete("wake_config");
await dispose();
console.log("  wake_config cleared");
