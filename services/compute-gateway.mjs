#!/usr/bin/env node
// Swayambhu Compute Gateway.
//
// Purpose:
// - host runtime-owned machine jobs inside swayambhu-runtime
// - preserve a temporary /execute compatibility path for cutover
// - move toward typed runtime jobs via /jobs

import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import { createServer } from "http";
import path from "path";

const PORT = Number(process.env.PORT || 3600);
const SECRET = process.env.COMPUTER_API_KEY;
const JOBS_ROOT = process.env.JOBS_ROOT || "/srv/swayambhu/jobs";
const ENABLE_EXECUTE = process.env.COMPUTE_ENABLE_EXECUTE === "1";
const MAX_BODY = Number(process.env.COMPUTE_MAX_BODY_BYTES || 262144);
const MAX_WAIT_SECONDS = Number(process.env.COMPUTE_MAX_WAIT_SECONDS || 300);
const MAX_OUTPUT_BYTES = Number(process.env.COMPUTE_MAX_OUTPUT_BYTES || 1048576);
const DEEP_REFLECT_RUNNER = process.env.DEEP_REFLECT_RUNNER || "/usr/local/bin/sway-deep-reflect-runner";
const DEEP_REFLECT_MAX_CONCURRENT = Number(process.env.DEEP_REFLECT_MAX_CONCURRENT || 1);

if (!SECRET) {
  console.error("Missing COMPUTER_API_KEY");
  process.exit(1);
}

await fs.mkdir(JOBS_ROOT, { recursive: true });

function checkAuth(req) {
  return req.headers.authorization === `Bearer ${SECRET}`;
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) throw new Error(`body too large (max ${MAX_BODY} bytes)`);
  }
  return body ? JSON.parse(body) : {};
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function clampWait(rawWait) {
  const wait = Number(rawWait || 60);
  if (!Number.isFinite(wait) || wait < 1) return 60;
  return Math.min(wait, MAX_WAIT_SECONDS);
}

function sanitizeJobId(raw) {
  const id = String(raw || "").trim();
  if (!id) return `dr_${Date.now()}_${randomUUID().slice(0, 8)}`;
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error("invalid job id");
  return id;
}

function pushChunk(output, stream, data, budget) {
  const text = data.toString();
  if (budget.remaining <= 0) return;
  const sliced = text.slice(0, budget.remaining);
  budget.remaining -= sliced.length;
  output.push({ stream, data: sliced });
}

async function compatExecute(command, waitSeconds) {
  if (!command || typeof command !== "string") {
    return { status: "failed", exit_code: 2, output: [{ stream: "stderr", data: "command is required\n" }] };
  }

  const output = [];
  const budget = { remaining: MAX_OUTPUT_BYTES };
  const id = `exec_${Date.now()}_${randomUUID().slice(0, 8)}`;

  return await new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], {
      cwd: JOBS_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    let timer = null;

    child.stdout.on("data", (chunk) => pushChunk(output, "stdout", chunk, budget));
    child.stderr.on("data", (chunk) => pushChunk(output, "stderr", chunk, budget));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        status: "failed",
        exit_code: null,
        output: [{ stream: "stderr", data: `${err.message || String(err)}\n` }],
        id,
      });
    });

    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        status: signal ? "killed" : "completed",
        exit_code: signal ? null : code,
        output,
        id,
      });
    });

    timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
      settled = true;
      resolve({
        status: "timed_out",
        exit_code: null,
        output,
        id,
      });
    }, waitSeconds * 1000);
  });
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfPresent(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function countRunningDeepReflectJobs() {
  const entries = await fs.readdir(JOBS_ROOT, { withFileTypes: true }).catch(() => []);
  let count = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const meta = await readJsonIfPresent(path.join(JOBS_ROOT, entry.name, "job.json"));
    if (!meta || meta.type !== "deep_reflect") continue;
    const hasExit = await fileExists(path.join(JOBS_ROOT, entry.name, "exit_code"));
    if (!hasExit) count += 1;
  }
  return count;
}

async function startDeepReflectJob(payload) {
  const running = await countRunningDeepReflectJobs();
  if (running >= DEEP_REFLECT_MAX_CONCURRENT) {
    return { code: 429, body: { ok: false, error: `deep_reflect concurrency limit reached (${running}/${DEEP_REFLECT_MAX_CONCURRENT})` } };
  }

  const runnerExists = await fileExists(DEEP_REFLECT_RUNNER);
  if (!runnerExists) {
    return { code: 503, body: { ok: false, error: `deep_reflect runner missing: ${DEEP_REFLECT_RUNNER}` } };
  }

  const jobId = sanitizeJobId(payload.job_id);
  const jobDir = path.join(JOBS_ROOT, jobId);
  const manifestPath = path.join(jobDir, "manifest.json");
  const metaPath = path.join(jobDir, "job.json");
  const stdoutPath = path.join(jobDir, "runner.stdout.log");
  const stderrPath = path.join(jobDir, "runner.stderr.log");

  await fs.mkdir(jobDir, { recursive: true });
  await fs.writeFile(manifestPath, JSON.stringify(payload, null, 2));

  const meta = {
    id: jobId,
    type: "deep_reflect",
    status: "running",
    created_at: new Date().toISOString(),
    workdir: jobDir,
    manifest_path: manifestPath,
    runner: DEEP_REFLECT_RUNNER,
  };
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));

  const stdoutHandle = await fs.open(stdoutPath, "a");
  const stderrHandle = await fs.open(stderrPath, "a");

  try {
    const child = spawn(DEEP_REFLECT_RUNNER, [manifestPath], {
      cwd: jobDir,
      env: {
        ...process.env,
        SWAY_JOB_ID: jobId,
        SWAY_JOB_DIR: jobDir,
      },
      detached: true,
      stdio: ["ignore", stdoutHandle.fd, stderrHandle.fd],
    });

    child.unref();
    meta.pid = child.pid;
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
  } finally {
    await stdoutHandle.close();
    await stderrHandle.close();
  }

  return {
    code: 202,
    body: {
      ok: true,
      id: jobId,
      status: "running",
      type: "deep_reflect",
      workdir: jobDir,
    },
  };
}

async function readJobState(jobId) {
  const safeId = sanitizeJobId(jobId);
  const jobDir = path.join(JOBS_ROOT, safeId);
  const metaPath = path.join(jobDir, "job.json");
  const meta = await readJsonIfPresent(metaPath);
  if (!meta) return null;

  const exitFile = path.join(jobDir, "exit_code");
  const hasExit = await fileExists(exitFile);
  if (!hasExit) {
    return { ...meta, status: "running" };
  }

  const exitRaw = await fs.readFile(exitFile, "utf8").catch(() => "");
  const exitCode = Number.parseInt(exitRaw.trim(), 10);
  return {
    ...meta,
    status: exitCode === 0 ? "completed" : "failed",
    exit_code: Number.isFinite(exitCode) ? exitCode : null,
    completed_at: meta.completed_at || null,
    output_path: path.join(jobDir, "output.json"),
    stderr_path: path.join(jobDir, "stderr.log"),
  };
}

async function readJobResult(jobId) {
  const state = await readJobState(jobId);
  if (!state) return null;

  const outputPath = path.join(state.workdir, "output.json");
  const stderrPath = path.join(state.workdir, "stderr.log");
  const runnerStdoutPath = path.join(state.workdir, "runner.stdout.log");
  const runnerStderrPath = path.join(state.workdir, "runner.stderr.log");

  const outputRaw = await fs.readFile(outputPath, "utf8").catch(() => "");
  const stderrRaw = await fs.readFile(stderrPath, "utf8").catch(() => "");
  const runnerStdout = await fs.readFile(runnerStdoutPath, "utf8").catch(() => "");
  const runnerStderr = await fs.readFile(runnerStderrPath, "utf8").catch(() => "");

  let parsedOutput = null;
  try {
    parsedOutput = outputRaw ? JSON.parse(outputRaw) : null;
  } catch {
    parsedOutput = { raw_output: outputRaw };
  }

  return {
    id: state.id,
    status: state.status,
    exit_code: state.exit_code ?? null,
    output: parsedOutput,
    stderr: stderrRaw || null,
    runner_stdout: runnerStdout || null,
    runner_stderr: runnerStderr || null,
  };
}

async function cancelJob(jobId) {
  const state = await readJobState(jobId);
  if (!state) return { code: 404, body: { ok: false, error: "job not found" } };
  if (!state.pid || state.status !== "running") {
    return { code: 409, body: { ok: false, error: "job is not running" } };
  }

  try {
    process.kill(state.pid, "SIGTERM");
    return { code: 200, body: { ok: true, id: state.id, status: "cancelling" } };
  } catch (err) {
    return { code: 500, body: { ok: false, error: err.message || String(err) } };
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");

  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, {
      ok: true,
      compat_execute_enabled: ENABLE_EXECUTE,
      jobs_root: JOBS_ROOT,
      deep_reflect_runner: DEEP_REFLECT_RUNNER,
      deep_reflect_runner_exists: await fileExists(DEEP_REFLECT_RUNNER),
    });
  }

  if (!checkAuth(req)) {
    return json(res, 401, { ok: false, error: "unauthorized" });
  }

  if (req.method === "POST" && url.pathname === "/execute") {
    if (!ENABLE_EXECUTE) {
      return json(res, 403, { ok: false, error: "compatibility execute endpoint is disabled" });
    }

    let payload;
    try {
      payload = await readBody(req);
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message });
    }

    const result = await compatExecute(payload.command, clampWait(url.searchParams.get("wait")));
    return json(res, 200, result);
  }

  if (req.method === "POST" && url.pathname === "/jobs") {
    let payload;
    try {
      payload = await readBody(req);
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message });
    }

    if (payload.type !== "deep_reflect") {
      return json(res, 400, { ok: false, error: "runtime compute only accepts type=deep_reflect" });
    }

    try {
      const result = await startDeepReflectJob(payload);
      return json(res, result.code, result.body);
    } catch (err) {
      console.error(`[COMPUTE] Failed to start deep_reflect job: ${err.message || String(err)}`);
      return json(res, 500, { ok: false, error: err.message || String(err) });
    }
  }

  const jobStateMatch = req.method === "GET" && url.pathname.match(/^\/jobs\/([A-Za-z0-9._-]+)$/);
  if (jobStateMatch) {
    const state = await readJobState(jobStateMatch[1]);
    if (!state) return json(res, 404, { ok: false, error: "job not found" });
    return json(res, 200, { ok: true, ...state });
  }

  const jobResultMatch = req.method === "GET" && url.pathname.match(/^\/jobs\/([A-Za-z0-9._-]+)\/result$/);
  if (jobResultMatch) {
    const result = await readJobResult(jobResultMatch[1]);
    if (!result) return json(res, 404, { ok: false, error: "job not found" });
    return json(res, 200, { ok: true, ...result });
  }

  const jobCancelMatch = req.method === "POST" && url.pathname.match(/^\/jobs\/([A-Za-z0-9._-]+)\/cancel$/);
  if (jobCancelMatch) {
    const result = await cancelJob(jobCancelMatch[1]);
    return json(res, result.code, result.body);
  }

  return json(res, 404, { ok: false, error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[COMPUTE-GATEWAY] Listening on 127.0.0.1:${PORT}`);
});
