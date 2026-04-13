#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";
import { resolve } from "path";
import { spawnSync } from "child_process";
import { cloudflareTargetConfig, parseTargetEnv } from "./target-env.mjs";

const root = resolve(new URL("../..", import.meta.url).pathname);

function parseArgs(argv) {
  const out = {
    domain: null,
    apiHost: null,
    agentHost: null,
    siteProject: null,
    runtimeName: null,
    dashboardName: null,
    kvTitle: null,
    accessEmails: null,
    accessAuthDomain: null,
    runtimeEnvFile: null,
    operatorEnvFile: null,
    workersSubdomain: null,
    env: null,
    prod: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (!arg.startsWith("--")) continue;
    out[arg.slice(2)] = argv[i + 1];
    i++;
  }
  return out;
}

function printHelp() {
  console.log(`Cloudflare bootstrap for Swayambhu.

Usage:
  node scripts/cloudflare/setup.mjs [--env staging]
  node scripts/cloudflare/setup.mjs --env prod --prod

Optional flags:
  --env <staging|prod>               Default: staging
  --prod                             Required confirmation when using --env prod
  --zone <cloudflare-zone>            Default: target env zone
  --domain <hostname>                 Default: target env site hostname
  --api-host <hostname>               Default: target env API hostname
  --agent-host <hostname>             Default: target env agent hostname
  --site-project <pages-project>      Default: target env Pages project
  --runtime-name <worker-name>        Default: target env runtime worker
  --dashboard-name <worker-name>      Default: target env dashboard worker
  --kv-title <namespace-title>        Default: target env KV namespace title
  --access-emails <csv>               Default: ACCESS_EMAILS env or token owner email
  --access-auth-domain <auth-domain>  Required only if Zero Trust org must be created
  --runtime-env-file <path>           Default: target env file candidates
  --operator-env-file <path>          Default: target env file candidates
  --workers-subdomain <slug>          Optional workers.dev slug override

Environment:
  Staging loads operator creds from .env.patron first and runtime secrets from .env.
  Prod loads operator creds from .env.patron.prod first and runtime secrets from .env.prod.

Required operator env vars:
  CF_API_TOKEN or CLOUDFLARE_API_TOKEN
  CF_ACCOUNT_ID or CLOUDFLARE_ACCOUNT_ID

Useful optional env vars:
  ACCESS_EMAILS
  PATRON_KEY
  CF_ACCESS_AUTH_DOMAIN
  SITE_DOMAIN
`);
}

function loadEnvFile(file) {
  if (!existsSync(file)) return;
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rest] = match;
    if (process.env[key] !== undefined) continue;
    let value = rest.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function firstExisting(paths) {
  for (const file of paths) {
    if (file && existsSync(file)) return file;
  }
  return paths.find(Boolean) || null;
}

function section(title) {
  console.log(`\n== ${title} ==`);
}

function info(message) {
  console.log(message);
}

function fail(message) {
  console.error(`\nError: ${message}`);
  process.exit(1);
}

function csvList(value) {
  return (value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-");
}

function tomlString(value) {
  return JSON.stringify(value);
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function writeFile(file, contents) {
  writeFileSync(file, contents, "utf8");
}

function run(command, args, options = {}) {
  const printable = [command, ...args].join(" ");
  const proc = spawnSync(command, args, {
    cwd: options.cwd || root,
    env: { ...process.env, ...(options.env || {}) },
    input: options.input,
    stdio: options.input !== undefined ? ["pipe", "inherit", "inherit"] : "inherit",
  });

  if (proc.status !== 0) {
    fail(`command failed: ${printable}`);
  }
}

function randomSecret(bytes = 24) {
  return randomBytes(bytes).toString("hex");
}

async function cf(path, { method = "GET", body, headers = {}, expected = [200] } = {}) {
  const token = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;
  const url = `https://api.cloudflare.com/client/v4${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
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

async function cfMaybe(path, options = {}) {
  try {
    return await cf(path, options);
  } catch (error) {
    return null;
  }
}

async function verifyToken(accountId) {
  section("Verify Cloudflare Auth");
  const tokenCheck = await cf("/user/tokens/verify");
  info(`API token status: ${tokenCheck.status}`);
  const user = await cf("/user");
  info(`Operator email: ${user.email}`);
  const account = await cf(`/accounts/${accountId}`);
  info(`Account: ${account.name}`);
  return { user, account };
}

async function ensureZone(domain) {
  const zones = await cf(`/zones?name=${encodeURIComponent(domain)}`);
  if (!zones.length) fail(`Cloudflare zone not found for ${domain}`);
  return zones[0];
}

async function ensureWorkersSubdomain(accountId, requested) {
  section("Workers Subdomain");
  const existing = await cfMaybe(`/accounts/${accountId}/workers/subdomain`);
  if (existing?.subdomain) {
    info(`workers.dev subdomain: ${existing.subdomain}.workers.dev`);
    return existing.subdomain;
  }

  const candidate = requested || `swayambhu-${randomBytes(3).toString("hex")}`;
  const result = await cf(`/accounts/${accountId}/workers/subdomain`, {
    method: "PUT",
    body: { subdomain: candidate },
  });
  info(`Created workers.dev subdomain: ${result.subdomain}.workers.dev`);
  return result.subdomain;
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

async function ensureKvNamespace(accountId, title) {
  section("KV Namespace");
  const namespaces = await listKvNamespaces(accountId);
  const existing = namespaces.find((ns) => ns.title === title);
  if (existing) {
    info(`Reusing KV namespace ${title}: ${existing.id}`);
    return existing.id;
  }
  const created = await cf(`/accounts/${accountId}/storage/kv/namespaces`, {
    method: "POST",
    body: { title },
  });
  info(`Created KV namespace ${title}: ${created.id}`);
  return created.id;
}

async function ensureZeroTrustOrg(accountId, authDomain, domain) {
  section("Zero Trust Organization");
  try {
    const org = await cf(`/accounts/${accountId}/access/organizations`);
    info(`Zero Trust org: ${org.name} (${org.auth_domain})`);
    return org;
  } catch (error) {
    info(`Zero Trust org lookup unavailable: ${error.message}`);
    if (!authDomain) {
      info("Continuing without org bootstrap. If Access app creation fails later, set CF_ACCESS_AUTH_DOMAIN and add org-level Access permissions.");
      return null;
    }
    try {
      const created = await cf(`/accounts/${accountId}/access/organizations`, {
        method: "POST",
        body: {
          name: domain,
          auth_domain: authDomain,
        },
      });
      info(`Created Zero Trust org: ${created.auth_domain}`);
      return created;
    } catch (createError) {
      info(`Zero Trust org create unavailable: ${createError.message}`);
      info("Continuing. Existing Zero Trust setup may still be sufficient for Access app creation.");
      return null;
    }
  }
}

async function ensurePagesProject(projectName) {
  section("Pages Project");
  const existing = await cfMaybe(`/accounts/${process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID}/pages/projects/${projectName}`);
  if (existing) {
    info(`Reusing Pages project: ${projectName}`);
    return existing;
  }
  run("npx", ["wrangler", "pages", "project", "create", projectName, "--production-branch", "main"], {
    cwd: root,
    env: {
      CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN,
      CLOUDFLARE_ACCOUNT_ID: process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID,
      NODE_OPTIONS: "--dns-result-order=ipv4first",
    },
  });
  return cf(`/accounts/${process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID}/pages/projects/${projectName}`);
}

async function upsertDnsCname(zoneId, hostname, target, proxied) {
  const result = await cf(
    `/zones/${zoneId}/dns_records?name=${encodeURIComponent(hostname)}`
  );
  const existing = result.find((record) => record.name === hostname);
  const body = {
    type: "CNAME",
    name: hostname,
    content: target,
    proxied,
  };
  if (existing) {
    return cf(`/zones/${zoneId}/dns_records/${existing.id}`, {
      method: "PATCH",
      body,
    });
  }
  return cf(`/zones/${zoneId}/dns_records`, {
    method: "POST",
    body,
  });
}

async function ensurePagesDomain(accountId, projectName, domain, pagesHost, zoneId) {
  section("Pages Custom Domain");
  const existing = await cf(`/accounts/${accountId}/pages/projects/${projectName}/domains`);
  if (!existing.find((entry) => entry.name === domain)) {
    await cf(`/accounts/${accountId}/pages/projects/${projectName}/domains`, {
      method: "POST",
      body: { name: domain },
    });
    info(`Attached Pages custom domain: ${domain}`);
  } else {
    info(`Pages custom domain already attached: ${domain}`);
  }

  await upsertDnsCname(zoneId, domain, pagesHost, true);
  info(`Ensured DNS CNAME ${domain} -> ${pagesHost}`);
}

async function waitForPagesDomainActive(accountId, projectName, domain) {
  section("Wait For Pages Domain");
  for (let i = 0; i < 60; i++) {
    const domains = await cf(`/accounts/${accountId}/pages/projects/${projectName}/domains`);
    const match = domains.find((entry) => entry.name === domain);
    if (match?.status === "active") {
      info(`Pages domain active: ${domain}`);
      return;
    }
    const status = match?.status || "unknown";
    info(`Pages domain status: ${status} (${i + 1}/60)`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  fail(`Timed out waiting for Pages domain ${domain} to become active`);
}

async function ensureAccessApp(accountId, name, destinations, emails) {
  section("Cloudflare Access");
  const apps = await cf(`/accounts/${accountId}/access/apps`);
  const existing = apps.find((app) => app.name === name);
  const payload = {
    type: "self_hosted",
    name,
    destinations: destinations.map((uri) => ({ type: "public", uri })),
    app_launcher_visible: false,
    session_duration: "24h",
    auto_redirect_to_identity: false,
    enable_binding_cookie: false,
    http_only_cookie_attribute: false,
    allowed_idps: [],
    options_preflight_bypass: true,
  };

  let app;
  if (existing) {
    app = await cf(`/accounts/${accountId}/access/apps/${existing.id}`, {
      method: "PUT",
      body: payload,
    });
    info(`Updated Access app: ${name}`);
  } else {
    app = await cf(`/accounts/${accountId}/access/apps`, {
      method: "POST",
      body: payload,
    });
    info(`Created Access app: ${name}`);
  }

  const policyName = "Allow operator emails";
  const hasPolicy = (app.policies || []).find((policy) => policy.name === policyName);
  if (!hasPolicy) {
    await cf(`/accounts/${accountId}/access/apps/${app.id}/policies`, {
      method: "POST",
      body: {
        name: policyName,
        decision: "allow",
        include: emails.map((email) => ({ email: { email } })),
        exclude: [],
        require: [],
        session_duration: "24h",
      },
    });
    info(`Created Access policy for: ${emails.join(", ")}`);
  } else {
    info(`Access policy already exists: ${policyName}`);
  }
}

function buildRuntimeConfig({ runtimeName, kvNamespaceId, agentHost, jobsBaseUrl, jobsBaseDir, emailRelayUrl }) {
  return `name = ${tomlString(runtimeName)}
main = "index.js"
compatibility_date = "2025-06-01"
compatibility_flags = ["nodejs_compat"]

[vars]
JOBS_BASE_URL = ${tomlString(jobsBaseUrl)}
JOBS_BASE_DIR = ${tomlString(jobsBaseDir)}
EMAIL_RELAY_URL = ${tomlString(emailRelayUrl)}

[[kv_namespaces]]
binding = "KV"
id = ${tomlString(kvNamespaceId)}

[triggers]
crons = ["* * * * *"]

[[routes]]
pattern = ${tomlString(agentHost)}
custom_domain = true
`;
}

function buildDashboardConfig({ dashboardName, kvNamespaceId, apiHost, accessEmails }) {
  return `name = ${tomlString(dashboardName)}
main = "worker.js"
compatibility_date = "2025-06-01"

[vars]
PATRON_KEY = "bootstrap-placeholder"
ACCESS_EMAILS = ${tomlString(accessEmails.join(","))}

[[kv_namespaces]]
binding = "KV"
id = ${tomlString(kvNamespaceId)}

[[routes]]
pattern = ${tomlString(apiHost)}
custom_domain = true
`;
}

function pushSecret(configPath, secretName, secretValue, cwd) {
  if (!secretValue) return;
  run(
    "npx",
    ["wrangler", "secret", "put", secretName, "--config", configPath],
    {
      cwd,
      input: secretValue,
      env: {
        CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN,
        CLOUDFLARE_ACCOUNT_ID: process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID,
        NODE_OPTIONS: "--dns-result-order=ipv4first",
      },
    }
  );
}

async function verifyEndpoints({ domain, apiHost, agentHost }) {
  section("Verify Deployment");

  const checks = [
    [`https://${domain}`, 200],
    [`https://${domain}/patron/`, 302],
    [`https://${apiHost}/health`, 302],
    [`https://${agentHost}/channel/slack`, 404],
  ];

  for (const [url, expected] of checks) {
    const response = await fetch(url, { method: "HEAD", redirect: "manual" });
    info(`${url} -> ${response.status}`);
    if (response.status !== expected) {
      fail(`unexpected status for ${url}: expected ${expected}, got ${response.status}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const { envName } = parseTargetEnv(process.argv.slice(2));
  const target = cloudflareTargetConfig(envName);

  const operatorEnvFile = resolve(
    root,
    args["operator-env-file"] ||
      process.env.OPERATOR_ENV_FILE ||
      firstExisting(target.operatorEnvCandidates)
  );
  const runtimeEnvFile = resolve(
    root,
    args["runtime-env-file"] ||
      process.env.RUNTIME_ENV_FILE ||
      firstExisting(target.runtimeEnvCandidates)
  );

  loadEnvFile(operatorEnvFile);
  loadEnvFile(runtimeEnvFile);

  const accountId = process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;
  if (!accountId) fail("missing CF_ACCOUNT_ID / CLOUDFLARE_ACCOUNT_ID");
  if (!apiToken) fail("missing CF_API_TOKEN / CLOUDFLARE_API_TOKEN");

  process.env.CLOUDFLARE_API_TOKEN = apiToken;
  process.env.CLOUDFLARE_ACCOUNT_ID = accountId;

  section("Env Files");
  info(`Operator env file: ${operatorEnvFile}${existsSync(operatorEnvFile) ? "" : " (missing)"}`);
  info(`Runtime env file: ${runtimeEnvFile}${existsSync(runtimeEnvFile) ? "" : " (missing)"}`);

  const zoneName = args.zone || process.env.CF_ZONE_NAME || target.zoneName;
  const domain = args.domain || process.env.SITE_DOMAIN || target.domain;
  const apiHost = args["api-host"] || process.env.API_HOST || target.apiHost;
  const agentHost = args["agent-host"] || process.env.AGENT_HOST || target.agentHost;
  const siteProject = args["site-project"] || process.env.SITE_PROJECT || target.siteProject;
  const runtimeName = args["runtime-name"] || process.env.RUNTIME_NAME || target.runtimeName;
  const dashboardName = args["dashboard-name"] || process.env.DASHBOARD_NAME || target.dashboardName;
  const kvTitle = args["kv-title"] || process.env.KV_TITLE || target.kvTitle;

  const { user } = await verifyToken(accountId);
  const zone = await ensureZone(zoneName);
  await ensureWorkersSubdomain(accountId, args["workers-subdomain"] || process.env.WORKERS_SUBDOMAIN);

  const accessEmails = csvList(
    args["access-emails"] || process.env.ACCESS_EMAILS || process.env.CF_ACCESS_EMAILS || user.email
  );
  if (!accessEmails.length) fail("missing ACCESS_EMAILS and could not derive operator email");

  await ensureZeroTrustOrg(
    accountId,
    args["access-auth-domain"] || process.env.CF_ACCESS_AUTH_DOMAIN,
    domain
  );

  const kvNamespaceId = await ensureKvNamespace(accountId, kvTitle);

  const tmpDir = resolve(root, "tmp", target.tmpDirName);
  ensureDir(tmpDir);
  const runtimeConfigPath = resolve(tmpDir, "wrangler.runtime.toml");
  const dashboardConfigPath = resolve(tmpDir, "wrangler.dashboard.toml");
  writeFile(
    runtimeConfigPath,
    buildRuntimeConfig({
      runtimeName,
      kvNamespaceId,
      agentHost,
      jobsBaseUrl: args["jobs-base-url"] || process.env.JOBS_BASE_URL || target.jobsBaseUrl,
      jobsBaseDir: "/srv/swayambhu/jobs",
      emailRelayUrl: args["email-relay-url"] || process.env.EMAIL_RELAY_URL || target.emailRelayUrl,
    })
  );
  writeFile(
    dashboardConfigPath,
    buildDashboardConfig({ dashboardName, kvNamespaceId, apiHost, accessEmails })
  );

  const patronKey = process.env.PATRON_KEY || randomSecret();
  const runtimeSecrets = [
    "OPENROUTER_API_KEY",
    "BRAVE_SEARCH_API_KEY",
    "SLACK_BOT_TOKEN",
    "SLACK_CHANNEL_ID",
    "SLACK_SIGNING_SECRET",
    "CF_ACCESS_CLIENT_ID",
    "CF_ACCESS_CLIENT_SECRET",
    "EMAIL_RELAY_SECRET",
    "COMPUTER_API_KEY",
    "WALLET_ADDRESS",
    "WALLET_PRIVATE_KEY",
  ];

  section("Push Worker Secrets");
  for (const secret of runtimeSecrets) {
    pushSecret(runtimeConfigPath, secret, process.env[secret], root);
  }
  pushSecret(dashboardConfigPath, "PATRON_KEY", patronKey, resolve(root, "dashboard-api"));

  section("Seed KV");
  run(
    "node",
    [
      "scripts/cloudflare/push-seeds-kv.mjs",
      "--account-id",
      accountId,
      "--namespace-id",
      kvNamespaceId,
      "--env",
      envName,
      ...(envName === "prod" ? ["--prod"] : []),
    ],
    {
      cwd: root,
      env: {
        CLOUDFLARE_API_TOKEN: apiToken,
        CF_ACCOUNT_ID: accountId,
      },
    }
  );

  section("Build Site");
  run("npm", ["run", "build:site"], {
    cwd: root,
    env: {
      SITE_API_BASE: `https://${apiHost}`,
      DASHBOARD_AUTH_MODE: "access",
    },
  });

  section("Deploy Runtime Worker");
  run("npx", ["wrangler", "deploy", "--config", runtimeConfigPath], {
    cwd: root,
    env: {
      CLOUDFLARE_API_TOKEN: apiToken,
      CLOUDFLARE_ACCOUNT_ID: accountId,
      NODE_OPTIONS: "--dns-result-order=ipv4first",
    },
  });

  section("Deploy Dashboard API Worker");
  run("npx", ["wrangler", "deploy", "--config", dashboardConfigPath], {
    cwd: resolve(root, "dashboard-api"),
    env: {
      CLOUDFLARE_API_TOKEN: apiToken,
      CLOUDFLARE_ACCOUNT_ID: accountId,
      NODE_OPTIONS: "--dns-result-order=ipv4first",
    },
  });

  await ensurePagesProject(siteProject);

  section("Deploy Pages Site");
  run(
    "npx",
    [
      "wrangler",
      "pages",
      "deploy",
      "site",
      "--project-name",
      siteProject,
      "--branch",
      target.pagesBranch,
      "--commit-dirty=true",
    ],
    {
      cwd: root,
      env: {
        CLOUDFLARE_API_TOKEN: apiToken,
        CLOUDFLARE_ACCOUNT_ID: accountId,
        NODE_OPTIONS: "--dns-result-order=ipv4first",
      },
    }
  );

  const pagesHost = `${siteProject}.pages.dev`;
  await ensurePagesDomain(accountId, siteProject, domain, pagesHost, zone.id);
  await waitForPagesDomainActive(accountId, siteProject, domain);

  await ensureAccessApp(accountId, target.accessAppName, [`${domain}/patron/*`, `${apiHost}/*`], accessEmails);

  await verifyEndpoints({ domain, apiHost, agentHost });

  section("Done");
  info(`Target env: ${envName}`);
  info(`Public site: https://${domain}`);
  info(`Patron UI: https://${domain}/patron/ (Cloudflare Access)`);
  info(`Dashboard API: https://${apiHost} (Cloudflare Access)`);
  info(`Runtime worker: https://${agentHost}`);
  info(`KV namespace: ${kvNamespaceId}`);
  info(`Workers.dev subdomain ready`);
}

main().catch((error) => fail(error.message));
