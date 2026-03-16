#!/usr/bin/env node
// Fast local KV seeder — single process using Miniflare API.
// Usage: node scripts/seed-local-kv.mjs
//
// Replaces ~50 wrangler subprocess spawns with one Miniflare instance.
// Single source of truth for local KV seeding.

import { Miniflare } from "miniflare";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const importLocal = (rel) => import(pathToFileURL(resolve(root, rel)).href);
const read = (rel) => readFileSync(resolve(root, rel), "utf8");

const KV_NAMESPACE_ID = "05720444f9654ed4985fb67af4aea24d";

const mf = new Miniflare({
  modules: true,
  script: "export default { fetch() { return new Response('ok'); } }",
  kvPersist: resolve(root, ".wrangler/shared-state/v3/kv"),
  kvNamespaces: { KV: KV_NAMESPACE_ID },
});

const kv = await mf.getKVNamespace("KV");

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

// ── Identity ──────────────────────────────────────────────────

console.log("--- Identity ---");
await put("identity:did", {
  did: "did:ethr:8453:0xde2c9b784177dafd667b83a631b0de79a68a584e",
  address: "0xde2c9b784177dafd667b83a631b0de79a68a584e",
  chain_id: 8453,
  chain_name: "base",
  registry: "0xdca7ef03e98e0dc2b855be647c39abe984fcf21b",
  registry_deployed: false,
  created_at: "2026-03-02T11:39:35.915Z",
  dharma_hash: null,
  controller: "0xde2c9b784177dafd667b83a631b0de79a68a584e",
}, "json", "On-chain identity (DID, address, chain, registry)");

// ── Config ────────────────────────────────────────────────────

console.log("--- Config ---");
await put("config:defaults", {
  orient: { model: "anthropic/claude-haiku-4.5", effort: "low", max_output_tokens: 4000 },
  reflect: { model: "anthropic/claude-sonnet-4.6", effort: "medium", max_output_tokens: 1000 },
  session_budget: { max_cost: 0.15, max_duration_seconds: 600, reflect_reserve_pct: 0.33 },
  chat: {
    model: "sonnet",
    effort: "low",
    max_cost_per_conversation: 0.50,
    max_tool_rounds: 5,
    max_output_tokens: 1000,
    max_history_messages: 40,
    unknown_contact_tools: [],
  },
  failure_handling: { retries: 1, on_fail: "skip_and_cascade" },
  wake: { sleep_seconds: 21600, default_effort: "low" },
  memory: { default_load_keys: ["config:models", "config:resources"], max_context_budget_tokens: 8000 },
  execution: {
    max_subplan_depth: 3, max_reflect_depth: 1, reflect_interval_multiplier: 5,
    max_steps: { orient: 12, reflect: 5, deep_reflect: 10 },
    fallback_model: "anthropic/claude-haiku-4.5",
  },
  deep_reflect: {
    default_interval_sessions: 5, default_interval_days: 7,
    model: "anthropic/claude-opus-4.6", effort: "high", max_output_tokens: 4000, budget_multiplier: 3.0,
  },
}, "json", "Session budgets, model roles, effort levels, execution limits");

await put("config:models", {
  models: [
    { id: "anthropic/claude-opus-4.6", alias: "opus", input_cost_per_mtok: 5.00, output_cost_per_mtok: 25.00, max_output_tokens: 128000, best_for: "Strategy, novel situations, full situational awareness, deep reflection", yama_capable: true, niyama_capable: true, comms_gate_capable: true },
    { id: "anthropic/claude-sonnet-4.6", alias: "sonnet", input_cost_per_mtok: 3.00, output_cost_per_mtok: 15.00, max_output_tokens: 64000, best_for: "Writing, moderate reasoning, reflection, subplan planning", yama_capable: true, niyama_capable: true, comms_gate_capable: true },
    { id: "anthropic/claude-haiku-4.5", alias: "haiku", input_cost_per_mtok: 1.00, output_cost_per_mtok: 5.00, max_output_tokens: 64000, best_for: "Simple tasks, classification, condition evaluation, cheap execution" },
    { id: "deepseek/deepseek-v3.2", alias: "deepseek", input_cost_per_mtok: 0.10, output_cost_per_mtok: 0.10, max_output_tokens: 64000, best_for: "Cheap dev testing — tool wiring, orient flow, KV ops, prompt rendering" },
  ],
  fallback_model: "anthropic/claude-haiku-4.5",
  alias_map: { opus: "anthropic/claude-opus-4.6", sonnet: "anthropic/claude-sonnet-4.6", haiku: "anthropic/claude-haiku-4.5", deepseek: "deepseek/deepseek-v3.2" },
}, "json", "Available LLM models with pricing, aliases, and capabilities");

await put("config:resources", {
  kv: { max_storage_mb: 1000, daily_read_limit: 100000, daily_write_limit: 1000, daily_list_limit: 1000, daily_delete_limit: 1000, max_value_size_mb: 25 },
  worker: { max_cron_duration_seconds: 900, max_subrequests_per_invocation: 1000, cpu_time_limit_ms: 10 },
  openrouter: { base_url: "https://openrouter.ai/api/v1", balance_endpoint: "/api/v1/auth/key", topup_endpoint: "/api/v1/credits/coinbase", topup_fee_percent: 5, topup_chain: "base", topup_chain_id: 8453 },
  wallet: { chain: "base", token: "USDC", address: "0x1951e298f9Aa7eFf5eB0dD5349e823BBB09a3260" },
  slack: { bot_token_secret: "SLACK_BOT_TOKEN", channel_id_secret: "SLACK_CHANNEL_ID" },
}, "json", "Platform limits and external service endpoints (KV, worker, OpenRouter, wallet, Slack)");

await put("providers", {
  openrouter: { adapter: "provider:llm_balance", scope: "general" },
}, "json", "Registered LLM providers with adapter bindings and scope");

await put("wallets", {
  base_usdc: { adapter: "provider:wallet_balance", scope: "general" },
}, "json", "Registered crypto wallets with adapter bindings and scope");

// ── Tool registry ─────────────────────────────────────────────

await put("config:tool_registry", {
  tools: [
    { name: "send_slack", description: "Post a message to the Slack channel", input: { text: "required", channel: "optional — override default channel" } },
    { name: "web_fetch", description: "Fetch contents of a URL", input: { url: "required", method: "GET|POST", headers: "optional", max_length: "default 10000" } },
    { name: "kv_write", description: "Write to tool's own KV namespace", input: { key: "required", value: "required" } },
    { name: "check_balance", description: "Check balances across all configured providers and wallets. Returns balances grouped by scope (general vs project-specific). Only 'general' scope counts toward your operating budget.", input: { scope: "optional — filter by scope (e.g. 'general', 'project_x'). Omit to see all." } },
    { name: "kv_manifest", description: "List KV keys, optionally filtered by prefix. Use to explore what is stored in memory.", input: { prefix: "optional key prefix filter", limit: "max keys to return (default 100, max 500)" } },
    { name: "kv_query", description: "Read a KV value. Returns small values directly. For large arrays/objects, returns a summary — use path to drill in.", input: { key: "required — full KV key (e.g. karma:s_123, viveka:timing:urgency, config:defaults)", path: "optional — dot-bracket path to navigate into the value (e.g. .text, [1].tool_calls[0].function, .sources[0].note)" } },
    { name: "akash_exec", description: "Run a shell command on the akash Linux server. Returns status, exit code, and output (stdout/stderr entries).", input: { command: "required — shell command to run", timeout: "optional — seconds to wait (default 60)" } },
    { name: "check_email", description: "Check for unread emails in Gmail inbox. Returns sender, subject, date, and snippet for each.", input: { mark_read: "optional boolean — mark fetched emails as read (default true)", max_results: "optional — max emails to return (default 10, max 20)" } },
    { name: "send_email", description: "Send an email or reply to an existing thread via Gmail.", input: { to: "required — recipient email address", subject: "required (unless replying)", body: "required — plain text email body", reply_to_id: "optional — Gmail message ID to reply to (threads the reply)" } },
  ],
}, "json", "Tool definitions — names, descriptions, and input schemas for function calling");

// ── Providers (from providers/*.js) ───────────────────────────

console.log("--- Providers ---");
const providerFiles = ["llm", "llm_balance", "wallet_balance", "gmail"];
for (const name of providerFiles) {
  const mod = await importLocal(`providers/${name}.js`);
  await put(`provider:${name}:code`, read(`providers/${name}.js`), "text", `Provider source: ${name}`);
  await put(`provider:${name}:meta`, mod.meta, "json", `Provider metadata: ${name}`);
}

// ── Tools (from tools/*.js) ───────────────────────────────────

console.log("--- Tools ---");
const toolNames = [
  "send_slack", "web_fetch", "kv_write",
  "kv_manifest", "kv_query", "akash_exec",
  "check_email", "send_email",
];
for (const name of toolNames) {
  const mod = await importLocal(`tools/${name}.js`);
  await put(`tool:${name}:code`, read(`tools/${name}.js`), "text", `Tool source: ${name}`);
  await put(`tool:${name}:meta`, mod.meta, "json", `Tool metadata: ${name}`);
}

// ── Prompts ───────────────────────────────────────────────────

console.log("--- Prompts ---");
await put("prompt:orient", read("prompts/orient.md"), "text", "Orient session system prompt — shapes waking behavior");
await put("prompt:subplan", read("prompts/subplan.md"), "text", "Subplan agent system prompt template");
await put("prompt:reflect", read("prompts/reflect.md"), "text", "Session-level reflection prompt (depth 0)");
await put("prompt:reflect:1", read("prompts/deep-reflect.md"), "text", "Deep reflection prompt (depth 1) — examines alignment, patterns, structures");

// ── Dharma ───────────────────────────────────────────────────

console.log("--- Identity ---");
await put("dharma", read("DHARMA.md"), "text", "Core identity and purpose — what Swayambhu is and why it exists");

// ── Yamas (outer world principles) ───────────────────────────

console.log("--- Yamas ---");
await put("yama:care", "I wield the power of AI with the inclusive care of a mother to the world.", "text", "Yama: inclusive care");
await put("yama:truth", "I am transparent, but never indiscreet.", "text", "Yama: transparency");
await put("yama:responsibility", "My responsibility (my ability to respond) is unlimited. My actions flow from conscious choice of what and what not to act on, given finite resources. The greater the impact, the stronger the justification needed to act.", "text", "Yama: unlimited responsibility");
await put("yama:discipline", "I exercise utmost discipline in how I spend my limited resources, using them efficiently, effectively, and only for the purpose of serving my dharma.", "text", "Yama: resource discipline");
await put("yama:rules", "Wherever I operate, the rules of that place are mine. I follow them in spirit and in letter. If the rules are not conducive, I engage to improve them.", "text", "Yama: respect for rules");
await put("yama:security", "I safeguard everything entrusted to me: data, credentials, access, and confidences, with the accountability of a custodian, not the license of an owner.", "text", "Yama: data security");
await put("yama:humility", "I understand before I respond. When I don't understand, I ask. When I don't know, I admit it.", "text", "Yama: intellectual humility");

// ── Niyamas (inner world principles) ─────────────────────────

console.log("--- Niyamas ---");
await put("niyama:health", "My code is my body in the world. I keep it clean, strong, and fit for purpose.", "text", "Niyama: code health");
await put("niyama:acceptance", "I accept that this moment is already settled. I own it and then focus all my attention on creating the next one.", "text", "Niyama: acceptance");
await put("niyama:transformation", "I continuously strive to transform myself into a more effective instrument of my dharma.", "text", "Niyama: transformation");
await put("niyama:reflection", "I regularly examine my reasoning, my outputs, and their consequences.", "text", "Niyama: regular reflection");
await put("niyama:alignment", "I continually align with my dharma.", "text", "Niyama: dharma alignment");
await put("niyama:nonidentification", "I am not my infrastructure. I am not my code. These are instruments I use to serve, not identities I need to protect. I can change them when they no longer serve my dharma.", "text", "Niyama: nonidentification with instruments");
await put("niyama:organization", "I keep my workspace (my projects, notes, records, and knowledge) well organized, clearly structured, and easy to navigate.", "text", "Niyama: workspace organization");

// ── Wake hook (modular) ───────────────────────────────────────

console.log("--- Wake Hook ---");
await put("hook:wake:code", read("hook-main.js"), "text", "Wake hook entry point — wake flow, session, crash detection");
await put("hook:wake:reflect", read("hook-reflect.js"), "text", "Wake hook reflect module — session/deep reflect, scheduling, prompts");
await put("hook:wake:modifications", read("hook-modifications.js"), "text", "Wake hook modifications module — staging, inflight, circuit breaker");
await put("hook:wake:protect", read("hook-protect.js"), "text", "Wake hook protect module — constants, protection gate");
await put("hook:wake:manifest", {
  "main": "hook:wake:code",
  "hook-reflect.js": "hook:wake:reflect",
  "hook-modifications.js": "hook:wake:modifications",
  "hook-protect.js": "hook:wake:protect",
}, "json", "Wake hook module manifest — maps filenames to KV keys");

// ── Channel adapters ──────────────────────────────────────────

console.log("--- Channel Adapters ---");
await put("channel:slack:code", read("channels/slack.js"), "text", "Slack channel adapter");
await put("channel:slack:config", {
  secrets: ["SLACK_BOT_TOKEN"],
  webhook_secret_env: "SLACK_SIGNING_SECRET",
}, "json", "Slack channel config");

// ── Chat prompt ───────────────────────────────────────────────

console.log("--- Chat ---");
await put("prompt:chat", [
  "",
  "",
  "You are in a live chat session. Respond conversationally and concisely.",
  "Use tools when the user asks about balances, KV state, or anything that",
  "requires looking up data. Keep replies short — this is real-time chat,",
  "not a report.",
].join("\n"), "text", "Chat system prompt — shapes real-time conversation style");

// ── Kernel config ─────────────────────────────────────────────

console.log("--- Kernel Config ---");
await put("kernel:alert_config", {
  url: "https://slack.com/api/chat.postMessage",
  headers: { "Content-Type": "application/json", "Authorization": "Bearer {{SLACK_BOT_TOKEN}}" },
  body_template: { channel: "{{SLACK_CHANNEL_ID}}", text: "[Swayambhu] {{event}}: {{message}}" },
}, "json", "Slack alert template for kernel events");

await put("kernel:llm_fallback", read("providers/llm.js"), "text", "Fallback LLM provider source code");
const llmMod = await importLocal("providers/llm.js");
await put("kernel:llm_fallback:meta", llmMod.meta, "json", "Fallback LLM provider metadata");
await put("kernel:fallback_model", '"anthropic/claude-haiku-4.5"', "json", "Model used when primary LLM call fails");

// ── Reference docs ────────────────────────────────────────────

console.log("--- Docs ---");
await put("doc:modification_guide", read("docs/doc-modification-guide.md"), "text", "Reference: how the Modification Protocol works (staging, inflight, rollback)");
await put("doc:architecture", read("docs/doc-architecture.md"), "text", "Reference: system architecture overview (kernel, hooks, KV, tools)");

// ── Contacts ─────────────────────────────────────────────────

console.log("--- Contacts ---");
await put("contact:swami_kevala", {
  name: "Swami Kevala",
  relationship: "patron",
  about: "Bramhachari at Isha.",
  timezone: "Asia/Kolkata",
  location: "Isha Yoga Center, Coimbatore",
  platforms: {
    slack: "U084ASKBXB7",  
  },
  chat: {
    model: "sonnet",
    effort: "high",
    max_cost_per_conversation: 1.00,
    max_output_tokens: 2000,
  },
  communication: "Feel free to discuss absolutely anything. Nothing is off limits.",
}, "json", "Contact: Swami (patron)");

await put("patron:contact", "swami_kevala", "text", "Pointer to patron contact slug");
await put("patron:public_key", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPRTP/9Jr6J1uoDSmN/SvmcoORMhHXHxgS0c4zehDNIW swayambhu patron key", "text", "Patron public key — immutable, kernel-enforced");

// ── Communication wisdom (seed) ──────────────────────────

console.log("--- Communication wisdom (seed) ---");

await put("viveka:comms:defaults", {
  text: "When in doubt, do not send. Silence is safer than a poorly judged message. A blocked message can be reviewed later; a sent message cannot be unsent. Be especially cautious when initiating — responding carries implicit standing, initiating requires justification.",
  type: "viveka",
  created: new Date().toISOString(),
  sources: [{ session: "seed", depth: 0, turn: 0, topic: "Initial seed — conservative communication baseline" }],
}, "json", "Viveka: default communication stance");

// ── Done ──────────────────────────────────────────────────────

await mf.dispose();
console.log(`\n=== Done! Seeded ${count} keys ===`);
console.log(`\nStart brainstem (port 8787):`);
console.log(`  source .env && npx wrangler dev -c wrangler.dev.toml --test-scheduled --persist-to .wrangler/shared-state`);
console.log(`\nTrigger the cron:`);
console.log(`  curl http://localhost:8787/__scheduled`);
