#!/usr/bin/env node

import { existsSync, readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dirname, "../..");
const ENV_PATH = process.env.SWAYAMBHU_ENV_FILE || join(ROOT, ".env");
const DEFAULT_BASE_URL = process.env.SWAYAMBHU_COMPUTE_BASE_URL
  || process.env.SWAYAMBHU_DEV_LOOP_JOBS_BASE_URL
  || process.env.JOBS_BASE_URL
  || "https://akash.swayambhu.dev";

let envLoaded = false;

export function parseDotEnv(text) {
  const entries = {};
  for (const rawLine of String(text || "").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (!key) continue;
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    entries[key] = value;
  }
  return entries;
}

export function loadDotEnvIfPresent() {
  if (envLoaded) return;
  envLoaded = true;
  if (!existsSync(ENV_PATH)) return;
  const parsed = parseDotEnv(readFileSync(ENV_PATH, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function buildHeaders() {
  return {
    "Content-Type": "application/json",
    "CF-Access-Client-Id": requireEnv("CF_ACCESS_CLIENT_ID"),
    "CF-Access-Client-Secret": requireEnv("CF_ACCESS_CLIENT_SECRET"),
    "Authorization": `Bearer ${requireEnv("COMPUTER_API_KEY")}`,
  };
}

export function buildRemoteCleanupCommand() {
  return [
    "set -eu",
    "export GIT_PAGER=cat",
    "export PAGER=cat",
    "export LESS=FRX",
    "export GIT_TERMINAL_PROMPT=0",
    "export TERM=dumb",
    "for target in /home/swayambhu/workspace /home/swayambhu/reasoning /home/swayambhu/jobs; do",
    "  mkdir -p \"$target\"",
    "  find \"$target\" -mindepth 1 -maxdepth 1 -exec rm -rf {} +",
    "  echo \"CLEANED $target\"",
    "done",
    "cat > /home/swayambhu/reasoning/INDEX.md <<'EOF'",
    "# Reasoning Artifacts",
    "",
    "No local reasoning artifacts are available in this fresh environment yet.",
    "EOF",
    "echo \"SEEDED /home/swayambhu/reasoning/INDEX.md\"",
    "find /home/swayambhu -maxdepth 1 -name '.kv_store_pending*' -print | while read -r target; do",
    "  [ -n \"$target\" ] || continue",
    "  [ -e \"$target\" ] || continue",
    "  rm -rf \"$target\"",
    "  echo \"CLEANED $target\"",
    "done",
    "echo READY",
  ].join("\n");
}

export async function executeRemoteComputeCommand(command, { wait = 120, baseUrl = DEFAULT_BASE_URL } = {}) {
  loadDotEnvIfPresent();
  const response = await fetch(`${baseUrl}/execute?wait=${wait}`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({ command }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Remote compute failed: ${response.status} ${response.statusText} ${body}`);
  }

  return response.json();
}

export async function cleanRemoteComputeSurfaces(options = {}) {
  const payload = await executeRemoteComputeCommand(buildRemoteCleanupCommand(), {
    wait: options.wait || 120,
    baseUrl: options.baseUrl || DEFAULT_BASE_URL,
  });

  if (payload.exit_code !== 0) {
    const stderr = (payload.output || []).map((item) => item.data || "").join("").trim();
    throw new Error(`Remote cleanup command failed with exit ${payload.exit_code}: ${stderr}`);
  }

  const lines = (payload.output || [])
    .map((item) => item.data || "")
    .join("")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return {
    process_id: payload.id || null,
    lines,
  };
}
