#!/usr/bin/env node

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { cleanRemoteComputeSurfaces } from "../../lib/operator/remote-compute.js";
import {
  cloudflareTargetConfig,
  confirmProdInteractive,
  parseTargetEnv,
} from "./target-env.mjs";

const root = resolve(new URL("../..", import.meta.url).pathname);

function parseArgs(argv) {
  const out = {
    remoteOnly: false,
    kvOnly: false,
    namespaceId: null,
    operatorEnvFile: null,
    runtimeEnvFile: null,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--remote-only") {
      out.remoteOnly = true;
      continue;
    }
    if (arg === "--kv-only") {
      out.kvOnly = true;
      continue;
    }
    if (arg === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    if (arg.startsWith("--")) {
      out[arg.slice(2)] = argv[i + 1];
      i++;
    }
  }

  if (out.remoteOnly && out.kvOnly) {
    throw new Error("choose at most one of --remote-only or --kv-only");
  }
  return out;
}

function loadEnvFile(file) {
  if (!file || !existsSync(file)) return;
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (!key || process.env[key] !== undefined) continue;
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function firstExisting(paths) {
  for (const file of paths) {
    const full = resolve(root, file);
    if (existsSync(full)) return full;
  }
  return null;
}

async function cf(path, { method = "GET", body, expected = [200] } = {}) {
  const token = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await response.json().catch(() => ({}));
  if (!expected.includes(response.status) || data.success === false) {
    const detail = data?.errors?.length
      ? data.errors.map((e) => `${e.code}: ${e.message}`).join("; ")
      : `${response.status} ${response.statusText}`;
    throw new Error(`${method} ${path} failed: ${detail}`);
  }
  return data.result;
}

async function cfRaw(path, options = {}) {
  const token = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const data = await response.json().catch(() => ({}));
  const expected = options.expected || [200];
  if (!expected.includes(response.status) || data.success === false) {
    const detail = data?.errors?.length
      ? data.errors.map((e) => `${e.code}: ${e.message}`).join("; ")
      : `${response.status} ${response.statusText}`;
    throw new Error(`${options.method || "GET"} ${path} failed: ${detail}`);
  }
  return data;
}

async function listKvNamespaces(accountId) {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const result = await cf(
      `/accounts/${accountId}/storage/kv/namespaces?page=${page}&per_page=100`
    );
    if (!result.length) break;
    all.push(...result);
    if (result.length < 100) break;
  }
  return all;
}

async function resolveNamespaceId(accountId, target, explicitId) {
  if (explicitId) return explicitId;
  const namespaces = await listKvNamespaces(accountId);
  const wantedTitle = process.env.KV_TITLE || target.kvTitle;
  const match = namespaces.find((ns) => ns.title === wantedTitle);
  if (match) return match.id;

  const wranglerPath = resolve(root, "wrangler.toml");
  if (existsSync(wranglerPath)) {
    const text = readFileSync(wranglerPath, "utf8");
    const topLevelMatch = text.match(/\[\[kv_namespaces\]\][\s\S]*?\bid\s*=\s*"([^"]+)"/);
    if (topLevelMatch?.[1]) {
      return topLevelMatch[1];
    }
  }

  throw new Error(`KV namespace not found for title: ${wantedTitle}`);
}

async function listNamespaceKeys(accountId, namespaceId) {
  const keys = [];
  let cursor = undefined;
  for (let page = 0; page < 200; page++) {
    const qs = new URLSearchParams({ limit: "1000" });
    if (cursor) qs.set("cursor", cursor);
    const data = await cfRaw(
      `/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/keys?${qs.toString()}`
    );
    keys.push(...(Array.isArray(data.result) ? data.result : []).map((entry) => entry.name));
    cursor = data?.result_info?.cursor || undefined;
    if (!cursor) break;
  }
  return keys;
}

function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

async function deleteNamespaceKeys(accountId, namespaceId, keys, { dryRun = false } = {}) {
  if (dryRun) {
    return { deleted: 0, dryRun: true };
  }

  let deleted = 0;
  for (const batch of chunk(keys, 1000)) {
    await cf(
      `/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/bulk`,
      { method: "DELETE", body: batch, expected: [200] },
    );
    deleted += batch.length;
  }
  return { deleted, dryRun: false };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { envName } = parseTargetEnv(process.argv.slice(2));
  await confirmProdInteractive(envName, "Cloudflare teardown");
  const target = cloudflareTargetConfig(envName);

  const operatorEnvFile = resolve(
    root,
    args["operator-env-file"] || firstExisting(target.operatorEnvCandidates) || target.operatorEnvCandidates[0]
  );
  const runtimeEnvFile = resolve(
    root,
    args["runtime-env-file"] || firstExisting(target.runtimeEnvCandidates) || target.runtimeEnvCandidates[0]
  );

  loadEnvFile(operatorEnvFile);
  loadEnvFile(runtimeEnvFile);

  const accountId = process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new Error("missing CF_ACCOUNT_ID / CF_API_TOKEN");
  }

  process.env.CLOUDFLARE_API_TOKEN = apiToken;
  process.env.CLOUDFLARE_ACCOUNT_ID = accountId;
  process.env.SWAYAMBHU_ENV_FILE = runtimeEnvFile;
  process.env.SWAYAMBHU_COMPUTE_BASE_URL = target.jobsBaseUrl;

  const report = {
    env: envName,
    operatorEnvFile,
    runtimeEnvFile,
    kv: null,
    remote: null,
    dryRun: args.dryRun,
  };

  if (!args.remoteOnly) {
    const namespaceId = await resolveNamespaceId(accountId, target, args["namespace-id"]);
    const keys = await listNamespaceKeys(accountId, namespaceId);
    report.kv = {
      namespaceId,
      keyCount: keys.length,
      ...await deleteNamespaceKeys(accountId, namespaceId, keys, { dryRun: args.dryRun }),
    };
  }

  if (!args.kvOnly) {
    report.remote = args.dryRun
      ? { dryRun: true, baseUrl: target.jobsBaseUrl }
      : await cleanRemoteComputeSurfaces({ baseUrl: target.jobsBaseUrl, wait: 120 });
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(`cloudflare-teardown: ${error.message}`);
  process.exit(1);
});
