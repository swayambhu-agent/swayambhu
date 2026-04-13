import { spawn } from "child_process";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";

import { parseJobOutput } from "../parse-job-output.js";

function normalizeParsedResult(parsed, normalizePayload) {
  const payload = normalizePayload(parsed?.payload);
  return {
    parse_ok: !!payload,
    payload,
    meta: parsed?.meta || null,
  };
}

export function runCommand(command, args, {
  cwd,
  stdinText = null,
  timeoutMs,
  env = process.env,
  timeoutMode = "kill",
  killGraceMs = 5_000,
} = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    let stdout = "";
    let stderr = "";
    let finished = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      if (finished) return;
      timedOut = true;
      if (timeoutMode === "term-then-kill") {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), killGraceMs).unref();
        return;
      }
      child.kill("SIGKILL");
      finished = true;
      resolvePromise({ code: null, stdout, stderr, timed_out: true, error: `timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      if (finished) return;
      clearTimeout(timer);
      finished = true;
      resolvePromise({ code: null, stdout, stderr, timed_out: timedOut, error: error.message });
    });
    child.on("close", (code) => {
      if (finished) return;
      clearTimeout(timer);
      finished = true;
      resolvePromise({
        code,
        stdout,
        stderr,
        timed_out: timedOut,
        error: timedOut ? `timed out after ${timeoutMs}ms` : (code === 0 ? null : `exit ${code}`),
      });
    });

    if (stdinText != null) child.stdin.write(stdinText);
    child.stdin.end();
  });
}

export async function runClaudeJob({
  prompt,
  runDir,
  timeoutMs,
  model,
  cwd,
  promptMode = "stdin",
  rawFilename = "claude.raw.json",
  stderrFilename = "claude.stderr.log",
  extraArgs = [],
  parseRawOutput = (raw) => parseJobOutput(raw || ""),
  normalizePayload = (payload) => payload,
}) {
  const rawPath = join(runDir, rawFilename);
  const stderrPath = join(runDir, stderrFilename);
  const args = ["-p"];
  if (promptMode === "arg") args.push(prompt);
  args.push("--output-format", "json", "--dangerously-skip-permissions", ...extraArgs);
  if (model) args.push("--model", model);

  const result = await runCommand("claude", args, {
    cwd,
    stdinText: promptMode === "stdin" ? prompt : null,
    timeoutMs,
  });
  await writeFile(rawPath, result.stdout || "", "utf8");
  await writeFile(stderrPath, result.stderr || "", "utf8");

  const parsed = parseRawOutput(result.stdout || "");
  const normalized = normalizeParsedResult(parsed, normalizePayload);
  return {
    runner: "claude",
    exit_code: result.code,
    timed_out: !!result.timed_out,
    parse_ok: normalized.parse_ok,
    payload: normalized.payload,
    meta: normalized.meta,
    raw_path: rawPath,
    stdout_path: null,
    stderr_path: stderrPath,
    error: result.error || null,
  };
}

export async function runCodexJob({
  prompt,
  runDir,
  timeoutMs,
  model,
  profile = null,
  cwd,
  commandCwd = cwd,
  outputSchemaPath = null,
  stdoutFilename = "codex.stdout.log",
  stderrFilename = "codex.stderr.log",
  lastMessageFilename = "codex.last-message.json",
  parseRawOutput = (raw) => parseJobOutput(raw || ""),
  normalizePayload = (payload) => payload,
}) {
  const stdoutPath = join(runDir, stdoutFilename);
  const stderrPath = join(runDir, stderrFilename);
  const lastMessagePath = join(runDir, lastMessageFilename);
  const args = ["exec", "-"];
  if (profile) args.push("--profile", profile);
  args.push(
    "-C", cwd,
    "--skip-git-repo-check",
    "--ephemeral",
    "--dangerously-bypass-approvals-and-sandbox",
  );
  if (outputSchemaPath) args.push("--output-schema", outputSchemaPath);
  args.push("--output-last-message", lastMessagePath, "--color", "never");
  if (model) args.push("--model", model);

  const result = await runCommand("codex", args, {
    cwd: commandCwd,
    stdinText: prompt,
    timeoutMs,
  });
  await writeFile(stdoutPath, result.stdout || "", "utf8");
  await writeFile(stderrPath, result.stderr || "", "utf8");

  let rawLastMessage = "";
  try {
    rawLastMessage = await readFile(lastMessagePath, "utf8");
  } catch {
    rawLastMessage = "";
  }

  const parsed = parseRawOutput(rawLastMessage || "");
  const normalized = normalizeParsedResult(parsed, normalizePayload);
  return {
    runner: "codex",
    exit_code: result.code,
    timed_out: !!result.timed_out,
    parse_ok: normalized.parse_ok,
    payload: normalized.payload,
    meta: normalized.meta,
    raw_path: lastMessagePath,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    error: result.error || null,
  };
}

export async function runGeminiJob({
  prompt,
  runDir,
  timeoutMs,
  model,
  cwd,
  stdoutFilename = "gemini.stdout.json",
  stderrFilename = "gemini.stderr.log",
  parseEnvelopeResponse = (response) => JSON.parse(response || ""),
  normalizePayload = (payload) => payload,
}) {
  const stdoutPath = join(runDir, stdoutFilename);
  const stderrPath = join(runDir, stderrFilename);
  const args = ["--prompt", prompt, "--output-format", "json", "--approval-mode", "yolo"];
  if (model) args.push("--model", model);

  const result = await runCommand("gemini", args, { cwd, timeoutMs });
  await writeFile(stdoutPath, result.stdout || "", "utf8");
  await writeFile(stderrPath, result.stderr || "", "utf8");

  let envelope = null;
  let rawPayload = null;
  try {
    envelope = JSON.parse(result.stdout || "");
    rawPayload = parseEnvelopeResponse(envelope?.response || "");
  } catch {
    envelope = null;
    rawPayload = null;
  }
  const payload = normalizePayload(rawPayload);
  return {
    runner: "gemini",
    exit_code: result.code,
    timed_out: !!result.timed_out,
    parse_ok: !!payload,
    payload,
    meta: envelope?.stats ? { stats: envelope.stats, session_id: envelope.session_id || null } : null,
    raw_path: stdoutPath,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    error: result.error || null,
  };
}
