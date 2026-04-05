#!/usr/bin/env node
// Autonomous dev loop orchestrator.
// Runs: observe → classify → CC analysis → report, in a loop.
// CC analysis spawns a fresh `claude -p` process per cycle for stages 3-6.
//
// Usage:
//   node scripts/dev-loop/loop.mjs              # run indefinitely
//   node scripts/dev-loop/loop.mjs --once       # single cycle
//   node scripts/dev-loop/loop.mjs --cold-start # first cycle uses --reset-all-state

import { initState, loadState, saveState, listProbes, loadQueue, moveQueue, saveRun } from './state.mjs';
import { runObserve } from './observe.mjs';
import { runClassify } from './classify.mjs';
import { buildContextFromAnalysis } from './context.mjs';
import { runVerify } from './verify.mjs';
import { sendSlack, sendEmail, formatApprovalMessage, checkSlackReplies, checkEmailReplies } from './comms.mjs';
import { generateApprovalId, routeProposal } from './decide.mjs';
import { readFileSync, writeFileSync, existsSync, unlinkSync, openSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { createHash } from 'crypto';
import { spawn, execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { collectReasoningArtifacts, writeReasoningArtifacts } from "../../lib/reasoning.js";

// Load .env so comms (Slack/email) work without manual `source .env`
const __root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const envPath = join(__root, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = '/home/swami/swayambhu/dev-loop';
const rubric = JSON.parse(readFileSync(join(__dirname, 'rubric.json'), 'utf-8'));
const CC_PROMPT_PATH = join(__dirname, 'cc-analyze.md');
const CC_APPLY_SYSTEM_PROMPT = [
  'You are a fresh Claude Code process spawned by the dev loop orchestrator.',
  'Your only job is to apply one already-decided proposal, run npm test, and write the result JSON requested in the user message.',
  'Do not perform extra analysis, routing, or documentation updates.',
].join('\n');
const CC_TIMEOUT_MS = 3_600_000; // 1 hour

const args = process.argv.slice(2);
const ONCE = args.includes('--once');
const COLD_START = args.includes('--cold-start');

// ── CC analysis (fresh process per cycle) ───────────────

async function runCC(timestamp, state) {
  const runDir = join(STATE_DIR, 'runs', timestamp);
  const systemPrompt = readFileSync(CC_PROMPT_PATH, 'utf-8');

  const userMessage = [
    `Analyze dev loop cycle ${state.cycle}.`,
    `Run directory: ${runDir}`,
    `Read ${runDir}/context.json and perform the full cognitive architecture audit.`,
    `Write all outputs to ${runDir}/`,
  ].join('\n');

  const ccArgs = [
    '-p', userMessage,
    '--dangerously-skip-permissions',
    '--output-format', 'text',
    '--append-system-prompt', systemPrompt,
    '--no-session-persistence',
    '--model', 'opus',
  ];

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    const child = spawn('claude', ccArgs, {
      cwd: __root,
      env: { ...process.env },
    });

    // Track CC PID so orphans can be cleaned up on next startup
    const ccPidFile = join(STATE_DIR, 'cc.pid');
    try { writeFileSync(ccPidFile, String(child.pid), 'utf-8'); } catch {}

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    const timer = setTimeout(() => {
      console.log('[CC] Timeout — killing process');
      child.kill('SIGTERM');
    }, CC_TIMEOUT_MS);

    child.on('close', async (code) => {
      clearTimeout(timer);
      try { unlinkSync(ccPidFile); } catch {}

      if (code !== 0) {
        console.error(`[CC] Exited with code ${code}`);
        if (stderr) console.error(`[CC] stderr: ${stderr.slice(0, 500)}`);
        resolve({ success: false, analysis: null, decisions: null, error: `exit code ${code}` });
        return;
      }

      // Read back outputs
      let analysis = null;
      let decisions = null;

      try {
        analysis = JSON.parse(await readFile(join(runDir, 'analysis.json'), 'utf8'));
      } catch {
        console.log('[CC] No valid analysis.json produced');
      }

      try {
        decisions = JSON.parse(await readFile(join(runDir, 'decisions.json'), 'utf8'));
      } catch {
        // Optional — only written when there are proposals
      }

      // analysis.json is required — without it the CC run failed to produce useful output
      if (!analysis) {
        resolve({ success: false, analysis: null, decisions: null, error: 'no analysis.json produced' });
        return;
      }

      resolve({ success: true, analysis, decisions, error: null });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ success: false, analysis: null, decisions: null, error: err.message });
    });
  });
}

async function runAutoApplyDecision(timestamp, decision) {
  const runDir = join(STATE_DIR, 'runs', timestamp);
  const proposalPath = join(runDir, `proposal-${decision.seq}.md`);
  const resultPath = join(runDir, `applied-${decision.seq}.json`);

  const userMessage = [
    `Apply proposal ${decision.seq}.`,
    `Run directory: ${runDir}`,
    `Proposal file: ${proposalPath}`,
    `Repository root: ${__root}`,
    'Read the proposal file, apply only that fix, then run npm test from the repository root.',
    'If npm test fails, revert your changes with git checkout -- .',
    `Write ${resultPath} with JSON exactly in this shape:`,
    '{"applied":true,"tests_passed":true,"files_changed":["relative/path.js"],"revert_reason":null}',
    'If you cannot apply the change, write {"applied":false,"tests_passed":false,"files_changed":[],"revert_reason":"why"}.',
    'If tests fail after applying, revert and write {"applied":true,"tests_passed":false,"files_changed":[],"revert_reason":"npm test failed"}.',
  ].join('\n');

  const ccArgs = [
    '-p', userMessage,
    '--dangerously-skip-permissions',
    '--output-format', 'text',
    '--append-system-prompt', CC_APPLY_SYSTEM_PROMPT,
    '--no-session-persistence',
    '--model', 'opus',
  ];

  return new Promise((resolve) => {
    let stderr = '';

    const child = spawn('claude', ccArgs, {
      cwd: __root,
      env: { ...process.env },
    });

    const timer = setTimeout(() => {
      console.log(`[AUTO_APPLY] Timeout for proposal ${decision.seq} - killing process`);
      child.kill('SIGTERM');
    }, CC_TIMEOUT_MS);

    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('close', async (code) => {
      clearTimeout(timer);

      if (code !== 0) {
        resolve({
          applied: false,
          tests_passed: false,
          files_changed: [],
          revert_reason: `claude exited with code ${code}${stderr ? `: ${stderr.slice(0, 200)}` : ''}`,
        });
        return;
      }

      try {
        const result = JSON.parse(await readFile(resultPath, 'utf8'));
        resolve({
          applied: Boolean(result.applied),
          tests_passed: Boolean(result.tests_passed),
          files_changed: Array.isArray(result.files_changed) ? result.files_changed : [],
          revert_reason: result.revert_reason || null,
        });
      } catch (error) {
        resolve({
          applied: false,
          tests_passed: false,
          files_changed: [],
          revert_reason: `missing or invalid ${resultPath}: ${error.message}`,
        });
      }
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        applied: false,
        tests_passed: false,
        files_changed: [],
        revert_reason: `failed to spawn claude: ${error.message}`,
      });
    });
  });
}

// ── Approval checking ────────────────────────────────────

async function checkApprovals(state) {
  const since = state.heartbeat || new Date(Date.now() - 86400000).toISOString();
  let replies = [];
  try {
    const [slack, email] = await Promise.all([
      checkSlackReplies(since, { channel: rubric.notifications?.slack_dm }).catch(() => []),
      checkEmailReplies(since).catch(() => []),
    ]);
    replies = [...slack, ...email];
  } catch { /* comms down, continue */ }

  const processed = new Set(state.processed_reply_ids || []);
  return replies.filter(r => r && !processed.has(r.id));
}

// ── Budget ───────────────────────────────────────────────

function isBudgetExhausted(state) {
  const today = new Date().toISOString().slice(0, 10);
  if (state.budget_reset_date !== today) {
    state.cash_budget_spent_today = 0;
    state.budget_reset_date = today;
  }
  return state.cash_budget_spent_today >= rubric.daily_cash_budget;
}

// ── Stage failure tracking ───────────────────────────────

function isStageDisabled(state, stage) {
  return (state.disabled_stages || []).includes(stage);
}

function recordStageFailure(state, stage) {
  if (!state.stage_failures) state.stage_failures = {};
  state.stage_failures[stage] = (state.stage_failures[stage] || 0) + 1;
  if (state.stage_failures[stage] >= rubric.stage_failure_limit) {
    if (!state.disabled_stages) state.disabled_stages = [];
    if (!state.disabled_stages.includes(stage)) {
      state.disabled_stages.push(stage);
      console.log(`[LOOP] Stage "${stage}" disabled after ${rubric.stage_failure_limit} consecutive failures`);
    }
  }
}

function clearStageFailure(state, stage) {
  if (state.stage_failures) state.stage_failures[stage] = 0;
}

// ── Worker restart after code changes ────────────────────

async function restartWorkersIfNeeded(decisions, label) {
  if (!decisions?.length) return false;
  const codeChanged = decisions.some(d =>
    d.verified && d.files_changed?.length > 0
  );
  if (!codeChanged) return false;

  console.log(`[LOOP] Code changed by ${label} — restarting workers...`);
  try { execSync('pkill -9 -f workerd', { stdio: 'ignore', timeout: 5000 }); } catch {}
  try { execSync('pkill -9 -f "wrangler dev"', { stdio: 'ignore', timeout: 5000 }); } catch {}
  await new Promise(r => setTimeout(r, 3000));
  await ensureServices();
  return true;
}

const DEVLOOP_REASONING_DIR = '/home/swami/swayambhu/dev-loop/reasoning';

export async function maybeCompileReasoningArtifacts(runDir, decisionsJson) {
  const decisions = decisionsJson?.decisions || [];
  const artifacts = await collectReasoningArtifacts(runDir, decisions);
  if (!artifacts.length) return [];
  await writeReasoningArtifacts(artifacts, { dir: DEVLOOP_REASONING_DIR });
  return artifacts;
}

// ── Approval processing ──────────────────────────────────

async function processApprovals(state) {
  const replies = await checkApprovals(state);
  if (!replies.length) return;

  const pending = await loadQueue(STATE_DIR, 'pending');
  const pendingById = Object.fromEntries(pending.map(p => [p.id, p]));

  for (const reply of replies) {
    const item = pendingById[reply.id];
    if (!item) {
      console.log(`[APPROVAL] Reply for unknown ID: ${reply.id}`);
      state.processed_reply_ids.push(reply.id); // still mark to avoid re-logging
      continue;
    }

    if (reply.action === 'REJECT') {
      console.log(`[APPROVAL] Rejected: ${item.id} — ${reply.reason || 'no reason'}`);
      await moveQueue(STATE_DIR, item.id, 'pending', 'rejected');
      state.processed_reply_ids.push(reply.id);
      continue;
    }

    if (reply.action === 'APPROVE') {
      console.log(`[APPROVAL] Approved: ${item.id} — ${item.summary}`);

      // Spawn CC to apply the approved change
      const runDir = join(STATE_DIR, 'runs', item.run_timestamp);
      const proposalPath = join(runDir, item.proposal_file);
      const details = item.escalation_details
        ? JSON.stringify(item.escalation_details)
        : 'See proposal file';

      const userMsg = [
        `Apply approved change ${item.id}.`,
        `Proposal: ${proposalPath}`,
        `Details: ${details}`,
        `After applying, run npm test. If tests fail, revert with git checkout -- .`,
        `Write result to ${runDir}/applied-${item.id}.json with { "applied": true/false, "tests_passed": true/false }`,
      ].join('\n');

      const systemPrompt = readFileSync(CC_PROMPT_PATH, 'utf-8');
      const ccArgs = [
        '-p', userMsg,
        '--dangerously-skip-permissions',
        '--output-format', 'text',
        '--append-system-prompt', systemPrompt,
        '--no-session-persistence',
        '--model', 'opus',
      ];

      console.log(`[APPROVAL] Spawning CC to apply ${item.id}...`);
      try {
        execSync(`claude ${ccArgs.map(a => JSON.stringify(a)).join(' ')}`, {
          cwd: __root,
          stdio: 'inherit',
          timeout: CC_TIMEOUT_MS,
        });

        // Check result
        let applied = false;
        try {
          const result = JSON.parse(readFileSync(join(runDir, `applied-${item.id}.json`), 'utf-8'));
          applied = result.applied && result.tests_passed;
        } catch {}

        if (applied) {
          console.log(`[APPROVAL] Applied and verified: ${item.id}`);
          await moveQueue(STATE_DIR, item.id, 'pending', 'approved');
          // Restart workers if code was changed
          await restartWorkersIfNeeded(
            [{ verified: true, files_changed: ['approved-change'] }],
            `approval ${item.id}`,
          );
          const slackDm = rubric.notifications?.slack_dm;
          try {
            await sendSlack(`Applied ${item.id}: ${item.summary}`, slackDm ? { channel: slackDm } : undefined);
          } catch {}
        } else {
          console.log(`[APPROVAL] Apply failed or tests failed: ${item.id}`);
          await moveQueue(STATE_DIR, item.id, 'pending', 'rejected');
        }
        state.processed_reply_ids.push(reply.id);
      } catch (e) {
        console.error(`[APPROVAL] CC failed for ${item.id}: ${e.message}`);
        // Don't mark processed — retry next cycle
      }
    }
  }

  await saveState(STATE_DIR, state);
}

// ── Service management ───────────────────────────────────

const KERNEL_PORT = process.env.SWAYAMBHU_KERNEL_PORT || 8787;
const DASHBOARD_PORT = process.env.SWAYAMBHU_DASHBOARD_PORT || 8790;

async function isServiceUp(port) {
  try {
    const resp = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(3000) });
    return true; // any response means the service is up
  } catch { return false; }
}

async function ensureServices() {
  const kernelUp = await isServiceUp(KERNEL_PORT);
  const dashboardUp = await isServiceUp(DASHBOARD_PORT);

  if (kernelUp && dashboardUp) {
    console.log('[LOOP] Services already running');
    return;
  }

  console.log('[LOOP] Starting services...');

  // Kill ALL wrangler/workerd processes to free ports
  try { execSync('pkill -9 -f workerd', { stdio: 'ignore', timeout: 5000 }); } catch {}
  try { execSync('pkill -9 -f "wrangler dev"', { stdio: 'ignore', timeout: 5000 }); } catch {}

  // Wait for both workerd and wrangler dev to fully exit
  const killDeadline = Date.now() + 10_000;
  while (Date.now() < killDeadline) {
    let alive = false;
    try { execSync('pgrep -f workerd', { stdio: 'ignore' }); alive = true; } catch {}
    try { execSync('pgrep -f "wrangler dev"', { stdio: 'ignore' }); alive = true; } catch {}
    if (!alive) break;
    await new Promise(r => setTimeout(r, 500));
  }
  // Extra wait for ports to free
  await new Promise(r => setTimeout(r, 2000));

  // Spawn with log files so failures are debuggable
  const logDir = STATE_DIR;
  const kernelLog = openSync(join(logDir, 'kernel.log'), 'w');
  const dashboardLog = openSync(join(logDir, 'dashboard.log'), 'w');

  const kernel = spawn('npx', [
    'wrangler', 'dev', '-c', 'wrangler.dev.toml',
    '--test-scheduled', '--persist-to', '.wrangler/shared-state',
  ], { cwd: __root, detached: true, stdio: ['ignore', kernelLog, kernelLog] });
  kernel.unref();
  console.log(`[LOOP] Kernel spawned (pid ${kernel.pid})`);

  const dashboard = spawn('npx', [
    'wrangler', 'dev', '--port', String(DASHBOARD_PORT),
    '--inspector-port', '9230', '--persist-to', '../.wrangler/shared-state',
  ], { cwd: join(__root, 'dashboard-api'), detached: true, stdio: ['ignore', dashboardLog, dashboardLog] });
  dashboard.unref();
  console.log(`[LOOP] Dashboard API spawned (pid ${dashboard.pid})`);

  // Wait for services (60s — wrangler can be slow on first start)
  const startTime = Date.now();
  const deadline = startTime + 60_000;
  while (Date.now() < deadline) {
    const k = await isServiceUp(KERNEL_PORT);
    const d = await isServiceUp(DASHBOARD_PORT);
    if (k && d) {
      console.log('[LOOP] Services ready');
      return;
    }
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    if (elapsed % 10 === 0 && elapsed > 0) {
      console.log(`[LOOP] Waiting... ${elapsed}s (kernel: ${k ? 'up' : 'down'}, dashboard: ${d ? 'up' : 'down'})`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  console.error('[LOOP] Check logs: .swayambhu/dev-loop/kernel.log and dashboard.log');
  throw new Error('Services failed to start within 60s');
}

// ── Cold-start detection ─────────────────────────────────

const SEED_PATH = join(__root, 'scripts/seed-local-kv.mjs');
const STAGNATION_THRESHOLD = 5;

function hashFile(path) {
  try {
    return createHash('md5').update(readFileSync(path)).digest('hex');
  } catch { return null; }
}

async function detectColdStart(state) {
  const reasons = [];

  // 1. Seed file changed (KV schema may be different)
  const seedHash = hashFile(SEED_PATH);
  if (state.last_seed_hash && seedHash && seedHash !== state.last_seed_hash) {
    reasons.push('seed file changed');
  }
  state.last_seed_hash = seedHash;

  // 2. Consecutive crashes
  try {
    const keys = encodeURIComponent('kernel:last_executions');
    const DASHBOARD_URL = process.env.SWAYAMBHU_DASHBOARD_URL || 'http://localhost:8790';
    const DASHBOARD_KEY = process.env.SWAYAMBHU_PATRON_KEY || process.env.PATRON_KEY || 'test';
    const resp = await fetch(`${DASHBOARD_URL}/kv/multi?keys=${keys}`, {
      headers: { 'X-Patron-Key': DASHBOARD_KEY },
    });
    const data = await resp.json();
    const executions = data['kernel:last_executions'] || [];
    if (executions.length >= 3 && executions.slice(0, 3).every(e =>
      e.outcome === 'crash' || e.outcome === 'killed'
    )) {
      reasons.push('3 consecutive crashes');
    }
  } catch { /* dashboard unreachable, skip */ }

  // 3. Stagnation — N cycles with no state evolution
  if ((state.stagnation_counter || 0) >= STAGNATION_THRESHOLD) {
    reasons.push(`${state.stagnation_counter} cycles with no state evolution`);
    state.stagnation_counter = 0; // reset after triggering
  }

  // 4. CC recommended cold start in previous cycle
  if (state.cold_start_next) {
    reasons.push('CC recommended cold start');
    state.cold_start_next = false;
  }

  // 5. Observe disabled — can't do anything useful, reset to recover
  if ((state.disabled_stages || []).includes('observe')) {
    reasons.push('observe stage disabled — resetting to recover');
    state.stage_failures = {};
    state.disabled_stages = [];
  }

  return reasons;
}

// ── Single cycle ─────────────────────────────────────────

function toIST(date = new Date()) {
  return date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
}

async function runCycle(state) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const displayTime = toIST();
  state.cycle += 1;
  state.phase = 'observe';
  state.heartbeat = new Date().toISOString();
  await saveState(STATE_DIR, state);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[LOOP] Cycle ${state.cycle} — ${displayTime} IST`);
  console.log(`${'='.repeat(60)}`);

  // ── COLD-START CHECK ──
  const coldStartReasons = await detectColdStart(state);
  const forceColdStart = coldStartReasons.length > 0;
  if (forceColdStart) {
    console.log(`[LOOP] Cold-starting: ${coldStartReasons.join(', ')}`);
  }

  // ── OBSERVE ──
  let observation;
  if (!isStageDisabled(state, 'observe')) {
    try {
      const probes = await listProbes(STATE_DIR);
      const result = await runObserve({
        baseDir: STATE_DIR,
        cycle: state.cycle,
        probes,
        codeChanged: COLD_START && state.cycle <= 1,
        coldStart: forceColdStart,
        timestamp,
      });
      if (!result.success) {
        console.log(`[OBSERVE] Failed: ${result.error}`);
        recordStageFailure(state, 'observe');
        await saveState(STATE_DIR, state);
        return { stop: false };
      }
      observation = result.observation;
      clearStageFailure(state, 'observe');
    } catch (e) {
      console.error(`[OBSERVE] Error: ${e.message}`);
      recordStageFailure(state, 'observe');
      await saveState(STATE_DIR, state);
      return { stop: false };
    }
  }

  // ── CLASSIFY ──
  state.phase = 'classify';
  await saveState(STATE_DIR, state);

  let classification;
  if (observation && !isStageDisabled(state, 'classify')) {
    try {
      const result = await runClassify({
        baseDir: STATE_DIR,
        observation,
        timestamp,
      });
      classification = result.classification;
      clearStageFailure(state, 'classify');
      console.log(`[CLASSIFY] Found ${classification.total_issues_found} issues ` +
        `(${classification.new_issues} new, ${classification.updated_probes} updated)`);
    } catch (e) {
      console.error(`[CLASSIFY] Error: ${e.message}`);
      recordStageFailure(state, 'classify');
    }
  }

  // ── BUILD CONTEXT ──
  if (observation && classification) {
    const context = await buildContextFromAnalysis({
      analysis: observation.analysis,
      sessionId: observation.latest_session_id,
      cycle: state.cycle,
      strategy: observation.strategy,
      mechanicalIssues: classification.issues || [],
    });
    await saveRun(STATE_DIR, timestamp, 'context.json', context);
    console.log(`[LOOP] Context written to runs/${timestamp}/context.json`);
  }

  // ── CC ANALYSIS (fresh process) ──
  let ccResult = null;
  if (observation && classification && !isStageDisabled(state, 'analyze')) {
    state.phase = 'analyze';
    await saveState(STATE_DIR, state);

    console.log(`[LOOP] Spawning CC analysis for cycle ${state.cycle}...`);
    try {
      ccResult = await runCC(timestamp, state);
      if (ccResult.success) {
        clearStageFailure(state, 'analyze');
        const findingCount = ccResult.analysis?.findings?.length || 0;
        const decisionCount = ccResult.decisions?.decisions?.length || 0;
        console.log(`[CC] Complete: ${findingCount} findings, ${decisionCount} decisions`);
      } else {
        console.error(`[CC] Failed: ${ccResult.error}`);
        recordStageFailure(state, 'analyze');
      }
    } catch (e) {
      console.error(`[CC] Error: ${e.message}`);
      recordStageFailure(state, 'analyze');
    }
  }

  // ── PROCESS DECISIONS ──
  if (ccResult?.decisions?.decisions) {
    const existingPending = (await loadQueue(STATE_DIR, 'pending')).map(p => p.id);
    const runDir = join(STATE_DIR, 'runs', timestamp);

    for (const decision of ccResult.decisions.decisions) {
      const routed = routeProposal(decision);
      decision.classification_reason = decision.reason;
      decision.action = routed.action;
      decision.route_reason = routed.reason;

      if (decision.action === 'cold_start') {
        state.cold_start_next = true;
        console.log(`[LOOP] CC recommends cold start: ${decision.summary}`);
        continue;
      }

      if (decision.action === 'auto_apply') {
        console.log(`[LOOP] Auto-applying proposal ${decision.seq}: ${decision.summary}`);
        const result = await runAutoApplyDecision(timestamp, decision);
        decision.verified = result.applied && result.tests_passed;
        decision.files_changed = result.files_changed;
        if (!decision.verified && result.revert_reason) {
          decision.revert_reason = result.revert_reason;
        }

        if (decision.verified) {
          console.log(`[LOOP] Auto-apply verified for proposal ${decision.seq}`);
        } else {
          console.log(`[LOOP] Auto-apply failed for proposal ${decision.seq}: ${decision.revert_reason || 'unknown error'}`);
        }
        continue;
      }

      if (decision.action === 'escalate') {
        const approvalId = generateApprovalId(timestamp, decision.seq || 0, existingPending);
        decision.approval_id = approvalId;

        try {
          const pendingItem = {
            id: approvalId,
            summary: decision.summary,
            blast_radius: decision.blast_radius,
            evidence_quality: decision.evidence_quality,
            challenge_converged: decision.challenge_converged,
            run_timestamp: timestamp,
            proposal_file: `proposal-${decision.seq}.md`,
            escalation_details: decision.escalation_details || null,
            created_at: new Date().toISOString(),
          };
          const pendingPath = join(STATE_DIR, 'queue', 'pending', `${approvalId}.json`);
          writeFileSync(pendingPath, JSON.stringify(pendingItem, null, 2));

          let why = null;
          let whatChanges = decision.escalation_details || null;
          try {
            const proposalPath = join(runDir, `proposal-${decision.seq}.md`);
            const proposal = readFileSync(proposalPath, 'utf-8');
            const issueMatch = proposal.match(/## (?:Issue|Problem)\s*\n([\s\S]*?)(?=\n## |\n#[^#]|$)/i);
            if (issueMatch) {
              why = issueMatch[1].trim().split('\n\n')[0].replace(/\n/g, ' ').slice(0, 300);
            }
            if (!whatChanges) {
              const fixMatch = proposal.match(/## (?:Fix|Proposed Fix|Solution)\s*\n([\s\S]*?)(?=\n## |\n#[^#]|$)/i);
              if (fixMatch) {
                whatChanges = fixMatch[1].trim().split('\n\n')[0].replace(/\n/g, ' ').slice(0, 300);
              }
            }
          } catch {}

          const msg = formatApprovalMessage({
            id: approvalId,
            summary: decision.summary,
            blastRadius: decision.blast_radius,
            evidence: decision.evidence_quality,
            challengeResult: decision.challenge_converged ? 'converged' : 'not converged',
            why,
            whatChanges,
            details: decision.escalation_details || undefined,
          });
          const slackDm = rubric.notifications?.slack_dm;
          await sendSlack(msg, slackDm ? { channel: slackDm } : undefined);
          console.log(`[LOOP] Escalated ${approvalId} via Slack`);
        } catch (e) {
          console.log(`[LOOP] Failed to escalate ${approvalId}: ${e.message}`);
        }
        continue;
      }

      console.log(`[LOOP] Deferred proposal ${decision.seq}: ${decision.route_reason}`);
    }

    await writeFile(join(runDir, 'decisions.json'), JSON.stringify(ccResult.decisions, null, 2));

    await restartWorkersIfNeeded(ccResult.decisions.decisions, 'CC analysis');

    try {
      const compiled = await maybeCompileReasoningArtifacts(runDir, ccResult.decisions);
      if (compiled.length) console.log(`[LOOP] Compiled ${compiled.length} reasoning artifact(s)`);
    } catch (e) {
      console.log(`[LOOP] Reasoning compilation failed (non-fatal): ${e.message}`);
    }
  }

  // ── REPORT ──
  state.phase = 'report';
  await saveState(STATE_DIR, state);

  const probes = await listProbes(STATE_DIR);
  const pending = await loadQueue(STATE_DIR, 'pending');
  const activeProbes = probes.filter(p =>
    !['closed', 'verified', 'quarantined'].includes(p.status));

  console.log(`[LOOP] Active probes: ${probes.length}`);
  console.log(`[LOOP] Pending approvals: ${pending.length}`);

  // Build report
  const ccFindings = ccResult?.analysis?.findings || [];
  const ccHealthy = ccResult?.analysis?.healthy_signals || [];
  const ccDecisions = ccResult?.decisions?.decisions || [];

  const report = [
    `# Dev Loop Report — Cycle ${state.cycle}`,
    `**Time:** ${displayTime} IST`,
    `**Budget spent today:** $${state.cash_budget_spent_today.toFixed(2)} / $${rubric.daily_cash_budget}`,
    '',
    classification
      ? `## Mechanical Issues: ${classification.total_issues_found}`
      : '## No observation this cycle',
    ...(classification?.issues || []).map(i =>
      `- [${i.severity}] ${i.locus}: ${i.summary}`),
    '',
    ccFindings.length > 0
      ? `## CC Analysis: ${ccFindings.length} findings`
      : '## CC Analysis: clean',
    ...ccFindings.map(f =>
      `- [${f.severity}] ${f.type} — ${f.locus}: ${f.summary}`),
    '',
    ccDecisions.length > 0 ? `## Decisions` : null,
    ...ccDecisions.map(d =>
      `- ${d.action}: ${d.summary} (verified: ${d.verified ?? 'n/a'})`),
    '',
    ccHealthy.length > 0 ? `## Healthy Signals` : null,
    ...ccHealthy.map(s => `- ${s}`),
    '',
    `## Active Probes: ${activeProbes.length}`,
    ...activeProbes.map(p => `- [${p.status}] ${p.locus}: ${p.summary}`),
    `## Pending Approvals: ${pending.length}`,
    ...pending.map(p => `- ${p.id}: ${p.summary || p.proposal || '(no summary)'}`),
  ].filter(x => x !== null).join('\n');

  await saveRun(STATE_DIR, timestamp, 'report.md', report);
  console.log(`[LOOP] Report saved to runs/${timestamp}/report.md`);

  // ── NOTIFICATIONS ──
  const sessionId = observation?.latest_session_id || '?';
  const duration = observation?.analysis?.execution_health?.elapsed_ms
    ? Math.round(observation.analysis.execution_health.elapsed_ms / 1000)
    : '?';
  const cost = observation?.analysis?.execution_health?.cost?.toFixed(2) || '?';
  const mechanicalCount = classification?.total_issues_found || 0;
  const ccSummary = ccResult?.analysis?.summary || null;

  // Build per-finding action lines for Slack
  const actionFindings = ccFindings.filter(f => f.type !== 'healthy_operation');
  const healthyFindings = ccFindings.filter(f => f.type === 'healthy_operation');
  const findingLines = actionFindings.map((f, i) => {
    const dec = ccDecisions.find(d => d.seq === (i + 1));
    let action = '';
    if (dec?.action === 'auto_apply' && dec.verified) action = `→ APPLIED: ${dec.summary?.slice(0, 80) || 'fix applied'}`;
    else if (dec?.action === 'escalate') action = `→ ESCALATED: approve ${dec.approval_id || '?'}`;
    else if (dec?.action === 'defer') action = `→ DEFERRED: ${dec.reason?.slice(0, 60) || 'low priority'}`;
    else if (dec?.action === 'auto_apply' && !dec.verified) action = `→ APPLY FAILED: ${dec.revert_reason?.slice(0, 60) || 'tests failed'}`;
    return `• [${f.severity}] ${f.summary?.slice(0, 100)} ${action}`;
  });

  const slackMsg = [
    `Dev Loop Cycle ${state.cycle} — ${displayTime} IST`,
    forceColdStart ? `Cold start: ${coldStartReasons.join(', ')}` : null,
    `Session: ${sessionId} | ${duration}s | $${cost}`,
    '',
    ccSummary ? `${ccSummary.slice(0, 200)}` : null,
    '',
    findingLines.length ? 'Findings:' : null,
    ...findingLines,
    healthyFindings.length ? `\nHealthy: ${healthyFindings.map(f => f.summary?.slice(0, 50)).join(', ')}` : null,
    !findingLines.length && !healthyFindings.length ? 'Clean — no findings' : null,
  ].filter(x => x !== null).join('\n');

  try {
    const slackDm = rubric.notifications?.slack_dm;
    await sendSlack(slackMsg, slackDm ? { channel: slackDm } : undefined);
    console.log('[LOOP] Slack summary sent');
  } catch (e) {
    console.log(`[LOOP] Slack send failed: ${e.message}`);
  }

  // Email: full detailed report
  try {
    const emailFindings = ccFindings.map((f, i) => {
      const dec = ccDecisions.find(d => d.seq === (i + 1));
      const lines = [
        `### ${i + 1}. [${f.severity}] ${f.type} — ${f.locus}`,
        f.summary,
        '',
        `**Evidence:** ${f.evidence?.slice(0, 300) || 'see analysis.json'}`,
      ];
      if (f.proposed_fix) lines.push('', `**Proposed fix:** ${f.proposed_fix.slice(0, 200)}`);
      if (dec) {
        lines.push('', `**Decision:** ${dec.action}${dec.verified ? ' (verified)' : ''}`);
        if (dec.reason) lines.push(`**Reason:** ${dec.reason}`);
        if (dec.action === 'auto_apply' && dec.files_changed?.length) {
          lines.push(`**Files changed:** ${dec.files_changed.join(', ')}`);
        }
      }
      return lines.join('\n');
    });

    const capObs = ccResult?.analysis?.capability_observations || {};
    const emailBody = [
      `# Dev Loop Cycle ${state.cycle} — ${displayTime} IST`,
      '',
      `**Session:** ${sessionId}`,
      `**Duration:** ${duration}s | **Cost:** $${cost}`,
      forceColdStart ? `**Cold start:** ${coldStartReasons.join(', ')}` : null,
      mechanicalCount > 0 ? `**Mechanical issues:** ${mechanicalCount}` : null,
      '',
      '## Analysis',
      ccSummary || 'No CC analysis this cycle.',
      '',
      '## Findings',
      ...emailFindings,
      '',
      '## Healthy Signals',
      ...(ccResult?.analysis?.healthy_signals || []).map(s => `- ${s}`),
      '',
      '## Capability Observations',
      ...Object.entries(capObs).map(([k, v]) => `- **${k}:** ${v}`),
    ].filter(x => x !== null).join('\n');

    await sendEmail(emailBody, `[SWAYAMBHU-DEV] Cycle ${state.cycle} — ${actionFindings.length} findings, ${ccDecisions.filter(d => d.verified).length} applied`);
    console.log('[LOOP] Email report sent');
  } catch (e) {
    console.log(`[LOOP] Email send failed: ${e.message}`);
  }

  // Append overnight log entry (if CC wrote one)
  try {
    const entry = await readFile(join(STATE_DIR, 'runs', timestamp, 'overnight-log-entry.md'), 'utf8');
    const logPath = join(STATE_DIR, 'overnight-log.md');
    const existing = await readFile(logPath, 'utf8').catch(() => '# Dev Loop Overnight Log\n');
    await writeFile(logPath, existing + '\n' + entry);
    console.log('[LOOP] Overnight log updated');
  } catch {
    // CC didn't write an entry — fine for clean cycles
  }

  // Classify result
  const isClean = !ccFindings.length && !mechanicalCount &&
      !activeProbes.length && !pending.length;
  const blockedOnApprovals = !activeProbes.length && pending.length > 0 &&
      classification?.new_issues === 0;

  // Track stagnation — only count cycles where the session actively ran
  // but produced no findings or evolution. Clean idle and blocked-on-approvals
  // are not stagnation — they're correct behavior.
  const sessionRan = observation?.analysis?.execution_health?.llm_calls > 0;
  if (sessionRan && !ccFindings.length && !ccDecisions.length && !isClean && !blockedOnApprovals && !forceColdStart) {
    state.stagnation_counter = (state.stagnation_counter || 0) + 1;
  } else {
    state.stagnation_counter = 0;
  }

  state.phase = 'idle';
  await saveState(STATE_DIR, state);

  if (isClean) return { stop: false, reason: 'clean' };
  if (blockedOnApprovals) return { stop: false, reason: 'blocked_on_approvals' };
  return { stop: false, reason: 'has_work' };
}

// ── Main ─────────────────────────────────────────────────

async function main() {
  await initState(STATE_DIR);
  let state = await loadState(STATE_DIR);

  if (COLD_START) {
    state.cycle = 0;
    state.stage_failures = {};
    state.disabled_stages = [];
    await saveState(STATE_DIR, state);
  }

  console.log('[LOOP] Autonomous Dev Loop started');
  console.log(`[LOOP] Budget: $${rubric.daily_cash_budget}/day`);
  console.log(`[LOOP] Stage failure limit: ${rubric.stage_failure_limit}`);

  // Kill orphaned CC analysis process from a previous loop run (if tracked)
  const ccPidPath = join(STATE_DIR, 'cc.pid');
  if (existsSync(ccPidPath)) {
    const ccPid = Number(readFileSync(ccPidPath, 'utf-8').trim());
    try {
      process.kill(ccPid, 0); // check alive
      console.log(`[LOOP] Killing orphaned CC process (pid ${ccPid})`);
      process.kill(ccPid, 'SIGTERM');
    } catch {} // already dead
    try { unlinkSync(ccPidPath); } catch {}
  }

  // Write PID file so we can detect stale loops
  const pidPath = join(STATE_DIR, 'loop.pid');
  const existingPid = existsSync(pidPath) ? readFileSync(pidPath, 'utf-8').trim() : null;
  if (existingPid) {
    try {
      process.kill(Number(existingPid), 0); // check if alive
      console.error(`[LOOP] Another loop is running (pid ${existingPid}). Exiting.`);
      process.exit(1);
    } catch {
      // Process dead — stale PID file, continue
    }
  }
  await writeFile(pidPath, String(process.pid));
  const cleanupPid = () => {
    try {
      // Only remove if we still own it
      const current = readFileSync(pidPath, 'utf-8').trim();
      if (current === String(process.pid)) unlinkSync(pidPath);
    } catch {}
  };
  process.on('exit', cleanupPid);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGHUP', () => process.exit(0));

  try { await ensureServices(); } catch (e) {
    console.error(`[LOOP] Service startup failed: ${e.message} — continuing, observe may fail`);
  }

  // Process any pending approvals
  try { await processApprovals(state); } catch (e) {
    console.error(`[LOOP] Approval processing failed: ${e.message}`);
  }

  let consecutiveClean = 0;

  while (true) {
    if (isBudgetExhausted(state)) {
      console.log('[LOOP] Daily budget exhausted. Stopping.');
      break;
    }

    try { await processApprovals(state); } catch (e) {
      console.error(`[LOOP] Approval processing failed: ${e.message}`);
    }

    const result = await runCycle(state);
    state = await loadState(STATE_DIR);

    if (ONCE) {
      console.log(`[LOOP] Stopping. Reason: single run (${result.reason})`);
      break;
    }

    if (result.reason === 'clean') {
      consecutiveClean++;
    } else {
      consecutiveClean = 0;
    }

    let waitSec;
    if (result.reason === 'blocked_on_approvals') {
      waitSec = 300;
      console.log(`[LOOP] Blocked on approvals. Checking again in ${waitSec}s...`);
    } else if (consecutiveClean >= 3) {
      waitSec = 600;
      console.log(`[LOOP] ${consecutiveClean} consecutive clean. Slowing to ${waitSec}s...`);
    } else {
      waitSec = 30;
      console.log(`[LOOP] Next cycle in ${waitSec}s...`);
    }

    await new Promise(r => setTimeout(r, waitSec * 1000));
  }

  console.log('[LOOP] Dev loop complete.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => {
    console.error(`[LOOP] Fatal: ${e.message}`);
    process.exit(1);
  });
}
