import * as start_job from './start_job.js';

export const meta = {
  secrets: ["CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "COMPUTER_API_KEY"],
  kv_access: "read_all",
  kv_write_prefixes: ["job:"],
  timeout_ms: 30000,
  provider: "compute",
};

function buildPrompt({ cwd, objective, context }) {
  const contextBlock = context ? `\nAdditional context:\n${context}\n` : "\n";
  return [
    `You are a bounded subagent task runner working inside this directory: ${cwd}`,
    "",
    `Objective: ${objective}`,
    contextBlock.trimEnd(),
    "",
    "Work directly in the target directory.",
    "Prefer one meaningful concrete improvement over broad wandering.",
    "Run tests or validation if they are cheap and relevant.",
    "If you are blocked, explain the exact blocker instead of improvising.",
    "",
    "Return only JSON with this shape:",
    "{",
    '  "status": "completed | blocked | needs_follow_up",',
    '  "summary": "short plain-language summary",',
    '  "findings": ["..."],',
    '  "files_changed": ["relative/path"],',
    '  "validation": [{"command": "...", "ok": true, "summary": "..."}],',
    '  "next_steps": ["..."]',
    "}",
  ].join("\n");
}

export async function execute(args) {
  const {
    objective,
    cwd,
    subagent = "codex",
    context,
    provider,
    secrets,
    fetch,
    kv,
    config,
  } = args;

  if (!objective) return { ok: false, error: "objective is required" };
  if (!cwd) return { ok: false, error: "cwd is required" };

  const prompt = buildPrompt({ cwd, objective, context });
  const launch = await start_job.execute({
    type: "subagent_task",
    prompt,
    cwd,
    subagent,
    context_keys: [],
    provider,
    secrets,
    fetch,
    kv,
    config,
  });

  if (!launch?.ok) return launch;

  return {
    ...launch,
    delegated: true,
    result: null,
    note: "Task launched asynchronously. Await job_complete or use collect_jobs in a later session if needed.",
  };
}
