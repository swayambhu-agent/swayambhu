#!/usr/bin/env node
// Fast local KV seeder — single process using Miniflare API.
// Usage: node scripts/seed-local-kv.mjs
//
// Reads all config from files (config/, principles/, prompts/, etc.)
// and writes to the local KV store. No inline data — the script is
// purely mechanical.

import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";
import { pathToFileURL } from "url";
import { getKV, root, dispose } from "./shared.mjs";

const importLocal = (rel) => import(pathToFileURL(resolve(root, rel)).href);
const read = (rel) => readFileSync(resolve(root, rel), "utf8");
const readJSON = (rel) => JSON.parse(read(rel));

const kv = await getKV();

let count = 0;

async function put(key, value, format = "json", description) {
  const val = typeof value === "object" && format === "json"
    ? JSON.stringify(value)
    : value;
  const metadata = { format };
  if (description) metadata.description = description;
  await kv.put(key, val, { metadata });
  count++;
}

console.log("=== Seeding local KV ===\n");

// ── Config (from config/*.json) ──────────────────────────────

console.log("--- Config ---");

const configMap = {
  "config:defaults":            "config/defaults.json",
  "config:models":              "config/models.json",
  "config:model_capabilities":  "config/model-capabilities.json",
  "config:resources":           "config/resources.json",
  "config:tool_registry":       "config/tool-registry.json",
  "config:subagents":           "config/subagents.json",
  "kernel:alert_config":        "config/alerts.json",
};

for (const [key, file] of Object.entries(configMap)) {
  await put(key, readJSON(file), "json", file);
}

// Identity
await put("identity:did", readJSON("config/identity.json"), "json", "On-chain identity");

// Providers and wallets
const { providers, wallets } = readJSON("config/providers.json");
await put("providers", providers, "json", "Registered LLM providers");
await put("wallets", wallets, "json", "Registered crypto wallets");

// Kernel fallback
const kernelConf = readJSON("config/kernel.json");
await put("kernel:fallback_model", JSON.stringify(kernelConf.fallback_model), "json", "Fallback model for failed LLM calls");

// Key tiers (kernel reads this at boot to enforce KV write protection)
await put("kernel:key_tiers", {
  immutable: ["dharma", "patron:public_key"],
  kernel_only: ["karma:*", "sealed:*", "event:*", "event_dead:*", "kernel:*", "patron:direct"],
  protected: [
    "config:*", "prompt:*", "tool:*", "provider:*", "channel:*",
    "hook:*", "contact:*", "contact_platform:*", "code_staging:*",
    "secret:*", "skill:*", "task:*",
    "providers", "wallets", "patron:contact", "patron:identity_snapshot",
    "desire:*", "pattern:*", "principle:*", "tactic:*",
  ],
}, "json", "KV write-protection tiers — kernel-only, agent cannot modify");

// Source map — tells the agent where its own infrastructure code lives.
// kernel:* tier so the agent can read but not modify the pointers.
await put("kernel:source_map", {
  kernel: "kernel:source:kernel.js",
  comms: "kernel:source:hook-communication.js",
  act_library: "hook:act:code",
  reflection: "hook:reflect:code",
  tools: "tool:*:code",
  providers: "provider:*:code",
  channels: "channel:*:code",
}, "json", "Pointers to infrastructure source code — agent reads these to debug execution path issues");

// Event handlers
await put("config:event_handlers", {
  handlers: {
    session_request: ["sessionTrigger"],
    job_complete: ["sessionTrigger"],
    patron_direct: ["sessionTrigger"],
  },
  deferred: {
    inbound_message: ["comms"],
    comms_request: ["comms"],
  },
}, "json", "Event bus routing — immediate handlers + deferred processors");

// ── Providers (from providers/*.js) ───────────────────────────

console.log("--- Providers ---");
const providerFiles = ["llm", "llm_balance", "wallet_balance", "gmail", "compute"];
for (const name of providerFiles) {
  const mod = await importLocal(`providers/${name}.js`);
  await put(`provider:${name}:code`, read(`providers/${name}.js`), "text", `Provider source: ${name}`);
  await put(`provider:${name}:meta`, mod.meta, "json", `Provider metadata: ${name}`);
}

// Kernel LLM fallback source
await put("kernel:llm_fallback", read(kernelConf.llm_fallback_provider), "text", "Fallback LLM provider source code");
const llmMod = await importLocal(kernelConf.llm_fallback_provider);
await put("kernel:llm_fallback:meta", llmMod.meta, "json", "Fallback LLM provider metadata");

// ── Tools (from tools/*.js) ───────────────────────────────────

console.log("--- Tools ---");
const toolNames = [
  "send_slack", "web_fetch",
  "kv_manifest", "kv_query", "computer",
  "check_email", "send_email", "test_model",
  "web_search", "start_job", "collect_jobs",
  "google_docs", "send_whatsapp", "request_message",
];
const GRANT_FIELDS = ["secrets", "communication", "inbound", "provider"];
const toolGrants = {};
for (const name of toolNames) {
  const mod = await importLocal(`tools/${name}.js`);
  await put(`tool:${name}:code`, read(`tools/${name}.js`), "text", `Tool source: ${name}`);
  // Strip security fields from KV-stored meta — these live in kernel:tool_grants
  const operationalMeta = { ...mod.meta };
  const grant = {};
  for (const field of GRANT_FIELDS) {
    if (field in operationalMeta) {
      grant[field] = operationalMeta[field];
      delete operationalMeta[field];
    }
  }
  if (Object.keys(grant).length) toolGrants[name] = grant;
  await put(`tool:${name}:meta`, operationalMeta, "json", `Tool metadata: ${name}`);
}
await put("kernel:tool_grants", toolGrants, "json", "Security grants per tool (kernel-only, agent cannot modify)");

// ── Prompts (from prompts/*.md) ──────────────────────────────

console.log("--- Prompts ---");
await put("prompt:plan", read("prompts/plan.md"), "text", "Plan phase system prompt — decides what action to take");
await put("prompt:act", read("prompts/act.md"), "text", "Act phase system prompt — executes the plan using tools");
await put("prompt:reflect", read("prompts/reflect.md"), "text", "Session-level reflection prompt (depth 0)");
// prompt:reflect:1 removed — depth-1 in-session reflect replaced by async DR operator
// Old prompt preserved as prompts/deep_reflect_old.md for reference
await put("prompt:communication", read("prompts/communication.md"), "text", "Communication system prompt");
await put("prompt:deep_reflect", read("prompts/deep_reflect.md"), "text", "Deep-reflect S/D operator prompt — dispatched as CC analysis job on akash");

// doc:* keys removed — rationale lives as comments in kernel.js, behavioral
// guidance lives in prompts. Single source of truth: the code itself.

// ── Dharma ───────────────────────────────────────────────────

console.log("--- Dharma ---");
await put("dharma", read("DHARMA.md"), "text", "Core identity and purpose");

// ── Principles (from principles.md — single file, parsed by ## headings) ──

console.log("--- Principles ---");
{
  const raw = read("principles.md");
  const sections = raw.split(/^## /m).slice(1); // skip header before first ##
  for (const section of sections) {
    const newline = section.indexOf("\n");
    const name = section.slice(0, newline).trim();
    const body = section.slice(newline + 1).trim();
    if (name && body) {
      await put(`principle:${name}`, body, "text", `Principle: ${name}`);
    }
  }
}

// ── Policy code (mutable — agent can stage changes via K.stageCode) ──

console.log("--- Policy Code ---");
await put("hook:act:code", read("act.js"), "text", "Session policy — act flow, context building");
await put("hook:reflect:code", read("reflect.js"), "text", "Reflection policy — session/deep reflect, scheduling");

// ── Kernel source (immutable — stored at kernel:* prefix) ─────

console.log("--- Kernel Source ---");
await put("kernel:source:kernel.js", read("kernel.js"), "text", "Kernel source");
await put("kernel:source:hook-communication.js", read("hook-communication.js"), "text", "Communication handler source");

// ── Channel adapters ──────────────────────────────────────────

console.log("--- Channel Adapters ---");
const channels = readJSON("config/channels.json");
for (const [name, config] of Object.entries(channels)) {
  await put(`channel:${name}:code`, read(`channels/${name}.js`), "text", `Channel adapter: ${name}`);
  await put(`channel:${name}:config`, config, "json", `Channel config: ${name}`);
}

// ── Contacts (from config/contacts.json) ──────────────────────

console.log("--- Contacts ---");
const contactsConf = readJSON("config/contacts.json");
for (const [slug, data] of Object.entries(contactsConf.contacts)) {
  await put(`contact:${slug}`, data, "json", `Contact: ${data.name || slug}`);
}
for (const [binding, data] of Object.entries(contactsConf.platform_bindings)) {
  await put(`contact_platform:${binding}`, data, "json", `Platform binding: ${binding}`);
}
await put("patron:contact", contactsConf.patron.slug, "text", "Patron contact slug");
await put("patron:public_key", contactsConf.patron.public_key, "text", "Patron public key (immutable)");

// ── Seed patterns (from config/seed-patterns.json) ────────────────

console.log("--- Seed Patterns ---");
const seedPatterns = readJSON("config/seed-patterns.json");
for (const [key, value] of Object.entries(seedPatterns)) {
  // Add created timestamp at seed time
  if (!value.created) value.created = new Date().toISOString();
  await put(key, value, "json", `Seed pattern: ${key}`);
}

// ── Session schedule (seed with past time so first session runs immediately) ──

console.log("--- Session Schedule ---");
await put("session_schedule", {
  next_session_after: new Date(Date.now() - 1000).toISOString(),
  interval_seconds: readJSON("config/defaults.json").schedule?.interval_seconds || 21600,
}, "json", "Session schedule — seeded in the past for immediate first session");

// ── DR lifecycle state ────────────────────────────────────────

console.log("--- DR State ---");
await put("dr:state:1", {
  status: "idle",
  generation: 0,
  consecutive_failures: 0,
}, "json", "DR lifecycle state — idle, ready for first dispatch");

// ── Secrets (local dev placeholders) ─────────────────────────

console.log("--- Secrets ---");
await put("secret:inference", "test-secret", "text", "Shared auth token for inference server (local dev)");

// ── Skills (from skills/*.json + skills/*.md) ─────────────────

console.log("--- Skills ---");
const skillNames = ["model-config", "skill-authoring", "tool-authoring", "computer", "claude-code", "codex", "comms"];
for (const name of skillNames) {
  const meta = readJSON(`skills/${name}.json`);
  await put(`skill:${name}`, {
    ...meta,
    instructions: read(`skills/${name}.md`),
  }, "json", `Skill: ${name}`);
  // Seed :ref companion if it exists
  try { await put(`skill:${name}:ref`, read(`skills/${name}-ref.md`), "text", `Skill reference: ${name}`); }
  catch {}
}

// ── Done ──────────────────────────────────────────────────────

await dispose();
console.log(`\n=== Done! Seeded ${count} keys ===`);
console.log(`\nStart kernel (port 8787):`);
console.log(`  source .env && npx wrangler dev -c wrangler.dev.toml --test-scheduled --persist-to .wrangler/shared-state`);
console.log(`\nTrigger the cron:`);
console.log(`  curl http://localhost:8787/__scheduled`);
