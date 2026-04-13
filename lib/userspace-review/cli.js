import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { runClaudeJob, runCodexJob, runGeminiJob } from "./runners.js";

export function nowTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function slugifyLabel(input, fallback) {
  const slug = String(input || fallback)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return slug || fallback;
}

export function loadDotEnv(rootDir) {
  const envPath = process.env.SWAYAMBHU_ENV_FILE || join(rootDir, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

export async function runSelectedRunner({
  runner,
  prompt,
  runDir,
  timeoutMs,
  claudeModel = null,
  codexModel = null,
  codexProfile = null,
  geminiModel = null,
  claudeOptions = {},
  codexOptions = {},
  geminiOptions = {},
}) {
  if (runner === "claude") {
    return runClaudeJob({
      prompt,
      runDir,
      timeoutMs,
      model: claudeModel,
      ...claudeOptions,
    });
  }

  if (runner === "gemini") {
    return runGeminiJob({
      prompt,
      runDir,
      timeoutMs,
      model: geminiModel,
      ...geminiOptions,
    });
  }

  if (runner !== "codex") {
    throw new Error(`Unsupported runner: ${runner}`);
  }

  return runCodexJob({
    prompt,
    runDir,
    timeoutMs,
    model: codexModel,
    profile: codexProfile,
    ...codexOptions,
  });
}
