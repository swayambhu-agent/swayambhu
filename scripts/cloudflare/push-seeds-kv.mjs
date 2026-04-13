#!/usr/bin/env node
// Seed a remote Cloudflare KV namespace using the same manifest as local dev.

import { collectSeedEntries } from "./assemble-seeds.mjs";
import { confirmProdInteractive, parseTargetEnv } from "./target-env.mjs";

function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    if (arg.startsWith("--")) {
      out[arg.slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

const args = parseArgs(process.argv.slice(2));
const { envName } = parseTargetEnv(process.argv.slice(2));
await confirmProdInteractive(envName, "Cloudflare KV push");
const accountId = args["account-id"] || process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
const namespaceId =
  args["namespace-id"] ||
  (envName === "prod"
    ? process.env.CF_PROD_KV_NAMESPACE_ID || process.env.CLOUDFLARE_PROD_KV_NAMESPACE_ID
    : process.env.CF_STAGING_KV_NAMESPACE_ID || process.env.CLOUDFLARE_STAGING_KV_NAMESPACE_ID);
const apiToken = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;

if (!accountId || !namespaceId || !apiToken) {
  console.error("Usage: CLOUDFLARE_API_TOKEN=... node scripts/cloudflare/push-seeds-kv.mjs [--env staging|prod] [--prod] --account-id <id> --namespace-id <id> [--dry-run]");
  process.exit(1);
}

const inferenceSecret = process.env.AKASH_INFERENCE_SECRET || process.env.INFERENCE_SECRET || null;
const jobsBaseUrl = args["jobs-base-url"] || process.env.SEED_JOBS_BASE_URL || null;
const jobsBaseDir = args["jobs-base-dir"] || process.env.SEED_JOBS_BASE_DIR || null;
const emailRelayUrl = args["email-relay-url"] || process.env.SEED_EMAIL_RELAY_URL || null;
const entries = await collectSeedEntries({
  targetEnv: envName,
  inferenceSecret,
  jobsBaseUrl,
  jobsBaseDir,
  emailRelayUrl,
});
const payload = entries.map(({ key, value, format, description }) => ({
  key,
  value: format === "json" && typeof value === "object" ? JSON.stringify(value) : String(value),
  metadata: {
    format,
    ...(description ? { description } : {}),
  },
}));

console.log(`Prepared ${payload.length} KV writes for ${envName} namespace ${namespaceId}.`);
if (args.dryRun) {
  console.log("Dry run only. First 10 keys:");
  for (const entry of payload.slice(0, 10)) console.log(`  ${entry.key}`);
  process.exit(0);
}

let written = 0;
for (const batch of chunk(payload, 1000)) {
  const resp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/bulk`,
    {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(batch),
    }
  );

  const json = await resp.json();
  if (!resp.ok || !json.success) {
    console.error("KV bulk write failed:", JSON.stringify(json, null, 2));
    process.exit(1);
  }
  written += batch.length;
  console.log(`Wrote ${written}/${payload.length} keys`);
}

console.log("Remote KV seed complete.");
