// Dispatch a long-running background job on a compute target.
// Packs context from KV into a tarball, transfers to target, starts nohup process.
// Returns immediately with a job ID. drCycle polls for completion.

import { packAndEncode } from '../lib/tarball.js';

export const meta = {
  secrets: ["CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "COMPUTER_API_KEY"],
  kv_access: "read_all",
  kv_write_prefixes: ["job:"],
  timeout_ms: 60000,
  provider: "compute",
};

export async function execute({ type, prompt, context_keys, include_code, command, provider, secrets, fetch, kv, config }) {
  if (!type) return { ok: false, error: "type is required (cc_analysis | custom)" };
  if (!prompt && type !== "custom") return { ok: false, error: "prompt is required" };
  if (type === "custom" && !command) return { ok: false, error: "command is required for custom type" };

  const jobs = config?.jobs || {};
  const baseUrl = jobs.base_url || "https://akash.swayambhu.dev";
  const baseDir = jobs.base_dir || "/home/swayambhu/jobs";
  const maxConcurrent = jobs.max_concurrent_jobs || 2;
  const ttlMinutes = jobs.default_ttl_minutes || 120;

  // Check concurrency
  const jobKeys = await kv.list({ prefix: "job:" });
  const runningCount = (await Promise.all(
    jobKeys.keys.map(async k => {
      const j = await kv.get(k.name);
      return j?.status === "running" ? 1 : 0;
    })
  )).reduce((a, b) => a + b, 0);

  if (runningCount >= maxConcurrent) {
    return { ok: false, error: `Concurrency limit reached (${runningCount}/${maxConcurrent} jobs running)` };
  }

  // Generate IDs
  const jobId = `j_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  // Pack context from KV
  const files = [];
  if (context_keys?.length) {
    for (const pattern of context_keys) {
      if (pattern.endsWith('*')) {
        const prefix = pattern.slice(0, -1);
        const listed = await kv.list({ prefix });
        for (const k of listed.keys) {
          const val = await kv.get(k.name);
          if (val != null) {
            files.push({
              name: k.name.replace(/:/g, '/') + '.json',
              content: typeof val === 'string' ? val : JSON.stringify(val, null, 2),
            });
          }
        }
      } else {
        const val = await kv.get(pattern);
        if (val != null) {
          files.push({
            name: pattern.replace(/:/g, '/') + '.json',
            content: typeof val === 'string' ? val : JSON.stringify(val, null, 2),
          });
        }
      }
    }
  }

  // Add prompt file
  if (prompt) {
    files.push({ name: 'prompt.txt', content: prompt });
  }

  // Build tarball
  let base64Tar;
  try {
    base64Tar = await packAndEncode(files);
  } catch (e) {
    return { ok: false, error: `tarball failed: ${e.message}` };
  }

  const tarBytes = Uint8Array.from(Buffer.from(base64Tar, 'base64'));

  // Shell single-quote escaping: a'b → a'\''b
  const esc = s => s.replace(/'/g, "'\\''");

  // Validate path_dirs
  const rawDirs = jobs.path_dirs;
  const pathDirs = Array.isArray(rawDirs)
    ? rawDirs.filter(d => typeof d === 'string' && /^\/[a-zA-Z0-9._\/-]+$/.test(d))
    : [];

  // Resolve command for job type
  let jobCommand;
  if (type === "cc_analysis") {
    const model = jobs.cc_model || "";
    const modelFlag = model ? ` --model '${esc(model)}'` : "";
    jobCommand = `claude -p "$(cat prompt.txt)" --output-format text${modelFlag}`;
  } else {
    jobCommand = command;
  }

  // Build the workdir path
  const workdir = `${baseDir}/${jobId}`;

  const uploadFilename = `${jobId}.tar.gz`;
  const uploadResult = await provider.upload({
    filename: uploadFilename,
    directory: baseDir,
    bytes: tarBytes,
    baseUrl,
    secrets,
    fetch,
  });

  if (!uploadResult.ok) {
    return {
      ok: false,
      error: `Failed to upload job tarball: ${uploadResult.error}`,
      detail: uploadResult.detail,
    };
  }

  // Build inner script (plain shell text — will be base64-encoded)
  const innerLines = [
    pathDirs.length ? `export PATH=${pathDirs.join(':')}` + '${PATH:+:$PATH}' : null,
    `cd '${esc(workdir)}' || { echo 1 > '${esc(workdir)}/exit_code'; exit 1; }`,
    `umask 000`,
    `rm -f output.json stderr.log exit_code`,
    type === "custom"
      ? `(${jobCommand}) > output.json 2>stderr.log; echo $? > '${esc(workdir)}/exit_code'`
      : `${jobCommand} > output.json 2>stderr.log; echo $? > exit_code`,
  ].filter(Boolean);

  const innerScript = innerLines.join('\n');
  const innerB64 = Buffer.from(innerScript, 'utf8').toString('base64');

  // Build outer script (setup + nohup with base64-encoded inner script)
  const shellScript = [
    `mkdir -p '${esc(workdir)}'`,
    `tar xz -f '${esc(uploadResult.path)}' -C '${esc(workdir)}'`,
    `chmod 0777 '${esc(workdir)}'`,
    `nohup sh -c "printf '%s' '${innerB64}' | base64 -d | sh" > /dev/null 2>&1 & echo $!`,
  ].join(' && \\\n');

  // Execute on compute target
  const result = await provider.call({
    command: shellScript,
    baseUrl,
    timeout: 30,
    secrets,
    fetch,
  });

  if (!result.ok) {
    return { ok: false, error: `Failed to start job: ${result.error}`, detail: result.detail };
  }

  // Parse PID from output
  const outputText = Array.isArray(result.output)
    ? result.output.map(o => o.data || '').join('').trim()
    : String(result.output || '').trim();
  const pid = parseInt(outputText.split('\n').pop(), 10) || null;

  // Write job record
  const jobRecord = {
    id: jobId,
    type,
    status: "running",
    created_at: new Date().toISOString(),
    workdir,
    pid,
    config: {
      prompt_summary: (prompt || command || '').slice(0, 200),
      context_keys: context_keys || [],
      ttl_minutes: ttlMinutes,
    },
  };

  await kv.put(`job:${jobId}`, JSON.stringify(jobRecord));

  return {
    ok: true,
    job_id: jobId,
    workdir,
    pid,
    context_files: files.length,
    tarball_size_kb: Math.round(base64Tar.length * 0.75 / 1024),
  };
}
