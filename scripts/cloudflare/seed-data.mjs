import { readFileSync } from "fs";
import { resolve } from "path";
import { pathToFileURL } from "url";
import { root } from "./shared.mjs";

const importLocal = (rel) => import(pathToFileURL(resolve(root, rel)).href);
const read = (rel) => readFileSync(resolve(root, rel), "utf8");
const readJSON = (rel) => JSON.parse(read(rel));

export async function collectSeedEntries({
  now = new Date(),
  inferenceSecret = null,
  jobsBaseUrl = null,
  jobsBaseDir = null,
  emailRelayUrl = null,
} = {}) {
  const entries = [];

  function put(key, value, format = "json", description) {
    entries.push({ key, value, format, description });
  }

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
    const value = readJSON(file);
    if (key === "config:defaults") {
      if (jobsBaseUrl) value.jobs.base_url = jobsBaseUrl;
      if (jobsBaseDir) value.jobs.base_dir = jobsBaseDir;
      if (emailRelayUrl) {
        value.email = {
          ...(value.email || {}),
          relay_url: emailRelayUrl,
        };
      }
    }
    put(key, value, "json", file);
  }

  put("identity:did", readJSON("config/identity.json"), "json", "On-chain identity");

  const { providers, wallets } = readJSON("config/providers.json");
  put("providers", providers, "json", "Registered LLM providers");
  put("wallets", wallets, "json", "Registered crypto wallets");

  const kernelConf = readJSON("config/kernel.json");
  put("kernel:fallback_model", JSON.stringify(kernelConf.fallback_model), "json", "Fallback model for failed LLM calls");

  put("kernel:key_tiers", {
    immutable: ["dharma", "principle:*", "patron:public_key"],
    kernel_only: ["karma:*", "sealed:*", "event:*", "event_dead:*", "kernel:*", "patron:direct"],
    protected: [
      "config:*", "prompt:*", "tool:*", "provider:*", "channel:*",
      "hook:*", "contact:*", "contact_platform:*", "code_staging:*",
      "secret:*", "skill:*", "task:*",
      "providers", "wallets", "patron:contact", "patron:identity_snapshot",
      "desire:*", "pattern:*",
    ],
  }, "json", "KV write-protection tiers — kernel-only, agent cannot modify");

  put("config:event_handlers", {
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

  const providerFiles = ["llm", "llm_balance", "wallet_balance", "gmail", "email-relay", "compute"];
  for (const name of providerFiles) {
    const mod = await importLocal(`providers/${name}.js`);
    put(`provider:${name}:code`, read(`providers/${name}.js`), "text", `Provider source: ${name}`);
    put(`provider:${name}:meta`, mod.meta, "json", `Provider metadata: ${name}`);
  }

  put("kernel:llm_fallback", read(kernelConf.llm_fallback_provider), "text", "Fallback LLM provider source code");
  const llmMod = await importLocal(kernelConf.llm_fallback_provider);
  put("kernel:llm_fallback:meta", llmMod.meta, "json", "Fallback LLM provider metadata");

  const toolNames = [
    "send_slack", "web_fetch",
    "kv_manifest", "kv_query", "computer",
    "check_email", "send_email", "test_model",
    "web_search", "start_job", "collect_jobs",
    "google_docs", "send_whatsapp", "request_message",
  ];
  const grantFields = ["secrets", "communication", "inbound", "provider"];
  const toolGrants = {};
  for (const name of toolNames) {
    const mod = await importLocal(`tools/${name}.js`);
    put(`tool:${name}:code`, read(`tools/${name}.js`), "text", `Tool source: ${name}`);
    const operationalMeta = { ...mod.meta };
    const grant = {};
    for (const field of grantFields) {
      if (field in operationalMeta) {
        grant[field] = operationalMeta[field];
        delete operationalMeta[field];
      }
    }
    if (Object.keys(grant).length) toolGrants[name] = grant;
    put(`tool:${name}:meta`, operationalMeta, "json", `Tool metadata: ${name}`);
  }
  put("kernel:tool_grants", toolGrants, "json", "Security grants per tool (kernel-only, agent cannot modify)");

  put("prompt:plan", read("prompts/plan.md"), "text", "Plan phase system prompt — decides what action to take");
  put("prompt:act", read("prompts/act.md"), "text", "Act phase system prompt — executes the plan using tools");
  put("prompt:communication", read("prompts/communication.md"), "text", "Communication system prompt");
  put("prompt:deep_reflect", read("prompts/deep_reflect.md"), "text", "Deep-reflect S/D operator prompt — dispatched as CC analysis job on akash");

  put("dharma", read("DHARMA.md"), "text", "Core identity and purpose");

  const rawPrinciples = read("principles.md");
  const sections = rawPrinciples.split(/^## /m).slice(1);
  for (const section of sections) {
    const newline = section.indexOf("\n");
    const name = section.slice(0, newline).trim();
    const body = section.slice(newline + 1).trim();
    if (name && body) {
      put(`principle:${name}`, body, "text", `Principle: ${name}`);
    }
  }

  put("hook:act:code", read("act.js"), "text", "Session policy — act flow, context building");
  put("kernel:source:kernel.js", read("kernel.js"), "text", "Kernel source");
  put("kernel:source:hook-communication.js", read("hook-communication.js"), "text", "Communication handler source");

  const channels = readJSON("config/channels.json");
  for (const [name, config] of Object.entries(channels)) {
    put(`channel:${name}:code`, read(`channels/${name}.js`), "text", `Channel adapter: ${name}`);
    put(`channel:${name}:config`, config, "json", `Channel config: ${name}`);
  }

  const contactsConf = readJSON("config/contacts.json");
  for (const [slug, data] of Object.entries(contactsConf.contacts)) {
    put(`contact:${slug}`, data, "json", `Contact: ${data.name || slug}`);
  }
  for (const [binding, data] of Object.entries(contactsConf.platform_bindings)) {
    put(`contact_platform:${binding}`, data, "json", `Platform binding: ${binding}`);
  }
  put("patron:contact", contactsConf.patron.slug, "text", "Patron contact slug");
  put("patron:public_key", contactsConf.patron.public_key, "text", "Patron public key (immutable)");

  const seedPatterns = readJSON("config/seed-patterns.json");
  for (const [key, value] of Object.entries(seedPatterns)) {
    const seededValue = { ...value };
    if (!seededValue.created) seededValue.created = now.toISOString();
    put(key, seededValue, "json", `Seed pattern: ${key}`);
  }

  const defaults = readJSON("config/defaults.json");
  if (jobsBaseUrl) defaults.jobs.base_url = jobsBaseUrl;
  if (jobsBaseDir) defaults.jobs.base_dir = jobsBaseDir;
  if (emailRelayUrl) {
    defaults.email = {
      ...(defaults.email || {}),
      relay_url: emailRelayUrl,
    };
  }
  put("session_schedule", {
    next_session_after: new Date(now.getTime() - 1000).toISOString(),
    interval_seconds: defaults.schedule?.interval_seconds || 21600,
  }, "json", "Session schedule — seeded in the past for immediate first session");

  put("dr:state:1", {
    status: "idle",
    generation: 0,
    consecutive_failures: 0,
  }, "json", "DR lifecycle state — idle, ready for first dispatch");

  if (inferenceSecret) {
    put("secret:inference", inferenceSecret, "text", "Shared auth token for inference server");
  }

  const skillNames = ["model-config", "skill-authoring", "tool-authoring", "computer", "claude-code", "codex", "comms"];
  for (const name of skillNames) {
    const meta = readJSON(`skills/${name}.json`);
    put(`skill:${name}`, {
      ...meta,
      instructions: read(`skills/${name}.md`),
    }, "json", `Skill: ${name}`);
    try {
      put(`skill:${name}:ref`, read(`skills/${name}-ref.md`), "text", `Skill reference: ${name}`);
    } catch {}
  }

  return entries;
}
