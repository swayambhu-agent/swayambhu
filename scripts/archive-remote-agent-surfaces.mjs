#!/usr/bin/env node

import { existsSync, readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dirname, "..");
const ENV_PATH = join(ROOT, ".env");
const BASE_URL = process.env.SWAYAMBHU_COMPUTE_BASE_URL || "https://akash.swayambhu.dev";

function loadDotEnv() {
  if (!existsSync(ENV_PATH)) return;
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function buildRemoteCommand(timestamp) {
  const archiveRoot = `/home/swayambhu/reset-archives/${timestamp}`;
  return [
    "set -eu",
    `ARCHIVE_ROOT='${archiveRoot}'`,
    "mkdir -p \"$ARCHIVE_ROOT\"",
    "for target in /home/swayambhu/workspace /home/swayambhu/reasoning /home/swayambhu/jobs; do",
    "  if [ -e \"$target\" ]; then",
    "    base=$(basename \"$target\")",
    "    mv \"$target\" \"$ARCHIVE_ROOT/$base\"",
    "    echo \"ARCHIVED $target -> $ARCHIVE_ROOT/$base\"",
    "  fi",
    "done",
    "find /home/swayambhu -maxdepth 1 -name '.kv_store_pending*' -print | while read -r target; do",
    "  [ -n \"$target\" ] || continue",
    "  [ -e \"$target\" ] || continue",
    "  base=$(basename \"$target\")",
    "  mv \"$target\" \"$ARCHIVE_ROOT/$base\"",
    "  echo \"ARCHIVED $target -> $ARCHIVE_ROOT/$base\"",
    "done",
    "mkdir -p /home/swayambhu/workspace /home/swayambhu/reasoning /home/swayambhu/jobs",
    "echo \"READY /home/swayambhu/workspace /home/swayambhu/reasoning /home/swayambhu/jobs\"",
    "echo \"ARCHIVE_ROOT $ARCHIVE_ROOT\"",
  ].join("\n");
}

async function main() {
  loadDotEnv();
  const headers = {
    "Content-Type": "application/json",
    "CF-Access-Client-Id": requireEnv("CF_ACCESS_CLIENT_ID"),
    "CF-Access-Client-Secret": requireEnv("CF_ACCESS_CLIENT_SECRET"),
    "Authorization": `Bearer ${requireEnv("COMPUTER_API_KEY")}`,
  };

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const command = buildRemoteCommand(timestamp);
  const response = await fetch(`${BASE_URL}/execute?wait=120`, {
    method: "POST",
    headers,
    body: JSON.stringify({ command }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Remote archive failed: ${response.status} ${response.statusText} ${body}`);
  }

  const payload = await response.json();
  if (payload.exit_code !== 0) {
    const stderr = (payload.output || []).map((item) => item.data || "").join("");
    throw new Error(`Remote archive command failed with exit ${payload.exit_code}: ${stderr}`);
  }

  const lines = (payload.output || [])
    .map((item) => item.data || "")
    .join("")
    .trim();

  if (lines) {
    console.log(lines);
  } else {
    console.log(`ARCHIVE_ROOT /home/swayambhu/reset-archives/${timestamp}`);
  }
}

main().catch((error) => {
  console.error(`archive-remote-agent-surfaces: ${error.message}`);
  process.exit(1);
});
