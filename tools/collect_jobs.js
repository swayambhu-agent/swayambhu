// Poll background jobs for completion. Fallback for when the callback didn't arrive.
// Primary notification path is the /job-complete callback → inbox; this tool is for
// explicit mid-session checks.

import { parseJobOutput } from '../lib/parse-job-output.js';

export const meta = {
  secrets: ["CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "COMPUTER_API_KEY"],
  kv_access: "read_all",
  kv_write_prefixes: ["job:", "job_result:"],
  timeout_ms: 60000,
  provider: "compute",
};

export async function execute({ job_id, wait_seconds, provider, secrets, fetch, kv, config }) {
  const jobs = config?.jobs || {};
  const baseUrl = jobs.base_url || "https://akash.swayambhu.dev";
  const esc = s => s.replace(/'/g, "'\\''");

  // Gather job records
  let jobRecords = [];
  if (job_id) {
    const record = await kv.get(`job:${job_id}`);
    if (!record) return { ok: false, error: `No job record for ${job_id}` };
    jobRecords.push(record);
  } else {
    const keys = await kv.list({ prefix: "job:" });
    for (const k of keys.keys) {
      // Skip job_result: keys
      if (k.name.startsWith("job_result:")) continue;
      const record = await kv.get(k.name);
      if (record) jobRecords.push(record);
    }
  }

  const completed = [];
  const still_running = [];
  const failed = [];
  const expired = [];

  for (const job of jobRecords) {
    if (job.status !== "running") {
      if (job.status === "completed") completed.push({ job_id: job.id, type: job.type, result_key: `job_result:${job.id}` });
      else if (job.status === "failed") failed.push({ job_id: job.id, type: job.type, error: job.error });
      else if (job.status === "expired") expired.push({ job_id: job.id, type: job.type });
      continue;
    }

    // Check TTL
    const ttl = job.config?.ttl_minutes || jobs.default_ttl_minutes || 120;
    const age = (Date.now() - new Date(job.created_at).getTime()) / 60000;
    if (age > ttl) {
      job.status = "expired";
      job.expired_at = new Date().toISOString();
      await kv.put(`job:${job.id}`, JSON.stringify(job));
      expired.push({ job_id: job.id, type: job.type, age_minutes: Math.round(age) });
      continue;
    }

    // Check exit_code file on compute target
    const checkResult = await provider.call({
      command: `test -f '${esc(job.workdir)}/exit_code' && cat '${esc(job.workdir)}/exit_code' || echo RUNNING`,
      baseUrl,
      timeout: 5,
      secrets,
      fetch,
    });

    if (!checkResult.ok) {
      still_running.push({ job_id: job.id, type: job.type, age_minutes: Math.round(age), check_error: checkResult.error });
      continue;
    }

    const outputText = Array.isArray(checkResult.output)
      ? checkResult.output.map(o => o.data || '').join('').trim()
      : String(checkResult.output || '').trim();

    if (outputText === "RUNNING") {
      still_running.push({ job_id: job.id, type: job.type, age_minutes: Math.round(age) });
      continue;
    }

    // Job completed — read exit code and output
    const exitCode = parseInt(outputText, 10);

    // Read output.json
    let resultData = null;
    let resultMeta = null;
    const outputResult = await provider.call({
      command: `cat '${esc(job.workdir)}/output.json' 2>/dev/null || echo '{}'`,
      baseUrl,
      timeout: 10,
      secrets,
      fetch,
    });

    if (outputResult.ok) {
      const raw = Array.isArray(outputResult.output)
        ? outputResult.output.map(o => o.data || '').join('')
        : String(outputResult.output || '');
      const { payload, meta } = parseJobOutput(raw);
      resultData = payload || { raw_output: raw.slice(0, 5000) };
      resultMeta = meta;
    }

    // Write job_result
    const resultKey = `job_result:${job.id}`;
    await kv.put(resultKey, JSON.stringify({
      job_id: job.id,
      type: job.type,
      result: resultData,
      ...(resultMeta ? { meta: resultMeta } : {}),
    }));

    // Update job record
    job.status = exitCode === 0 ? "completed" : "failed";
    job.completed_at = new Date().toISOString();
    job.exit_code = exitCode;
    job.result_key = resultKey;
    await kv.put(`job:${job.id}`, JSON.stringify(job));

    if (exitCode === 0) {
      completed.push({ job_id: job.id, type: job.type, result_key: resultKey });
    } else {
      failed.push({ job_id: job.id, type: job.type, exit_code: exitCode });
    }
  }

  // Wait support — if requested and a specific job is still running, poll once more
  if (wait_seconds && job_id && still_running.length > 0) {
    const waitMs = Math.min((wait_seconds || 10), 30) * 1000;
    await new Promise(r => setTimeout(r, waitMs));
    // Re-check just the one job (recursive but bounded — no wait_seconds on retry)
    const retry = await execute({ job_id, provider, secrets, fetch, kv, config });
    return retry;
  }

  return { ok: true, completed, still_running, failed, expired };
}
