#!/usr/bin/env node
// Autonomous dev loop orchestrator.
// Runs: observe → classify → CC analysis → report, in a loop.
// CC analysis spawns a fresh `claude -p` process per cycle for stages 3-6.
//
// Usage:
//   node scripts/operator/dev-loop/loop.mjs              # run indefinitely
//   node scripts/operator/dev-loop/loop.mjs --once       # single cycle
//   node scripts/operator/dev-loop/loop.mjs --cold-start # first cycle uses --reset-all-state

import {
  STATE_DIR,
  initState,
  loadState,
  saveState,
  listProbes,
  loadQueue,
  moveQueue,
  saveRun,
} from './state.mjs';
import { runObserve } from './observe.mjs';
import { runClassify } from './classify.mjs';
import { buildContextFromAnalysis } from '../../../lib/dev-loop/context.js';
import { runVerify } from './verify.mjs';
import { sendSlack, sendEmail, formatApprovalMessage, checkSlackReplies, checkEmailReplies } from './comms.mjs';
import { generateApprovalId, routeProposal } from '../../../lib/dev-loop/decide.js';
import { ensureServices, restartServices } from './services.mjs';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { createHash } from 'crypto';
import { spawn, execSync, execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { collectReasoningArtifacts, writeReasoningArtifacts } from "../../../lib/reasoning.js";
import { getDefaultServiceUrls } from './services.mjs';

// Load .env so comms (Slack/email) work without manual `source .env`
const __root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
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
const ANALYSIS_EVERY = readNumericArg(args, '--analysis-every', 1);
const HEARTBEAT_EVERY = readNumericArg(args, '--heartbeat-every', 10);
const MAX_CYCLES = readNumericArg(args, '--max-cycles', null);
const NOTIFY_MODE = readStringArg(args, '--notify', 'all');
const DEFAULT_URLS = getDefaultServiceUrls();
const DASHBOARD_URL = process.env.SWAYAMBHU_DASHBOARD_URL || DEFAULT_URLS.dashboardUrl;
const DASHBOARD_KEY = process.env.SWAYAMBHU_PATRON_KEY || process.env.PATRON_KEY || 'test';

function readNumericArg(argv, flag, defaultValue) {
  const index = argv.indexOf(flag);
  if (index === -1) return defaultValue;
  const raw = argv[index + 1];
  if (raw === undefined) throw new Error(`${flag} requires a number`);
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${flag} must be a positive number`);
  return value;
}

function readStringArg(argv, flag, defaultValue) {
  const index = argv.indexOf(flag);
  if (index === -1) return defaultValue;
  const value = argv[index + 1];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

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

async function runClaudeArchitectureReview(timestamp, decision) {
  const runDir = join(STATE_DIR, 'runs', timestamp);
  const proposalPath = join(runDir, `proposal-${decision.seq}.md`);
  const outputPath = join(runDir, `claude-review-${decision.seq}.json`);
  const systemPrompt = [
    'You are a fresh Claude Code reviewer performing an adversarial architecture review.',
    'Your job is to find concrete design flaws, boundary violations, overfitting, or rollback risks.',
    'Do not apply changes. Only read the proposal and write the requested JSON file.',
  ].join('\n');
  const userMessage = [
    `Review proposal ${decision.seq} adversarially.`,
    `Proposal file: ${proposalPath}`,
    `Focus on: kernel/userspace boundary, generality, robustness, simplicity, modularity, and rollback risk.`,
    `Write ${outputPath} as JSON exactly in this shape:`,
    '{"passed":true,"blocking_objections":[],"notes":["short note"]}',
    'If you find any blocking concern, set passed to false and list each objection in blocking_objections.',
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
    let stderr = '';
    const child = spawn('claude', ccArgs, {
      cwd: __root,
      env: { ...process.env },
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), CC_TIMEOUT_MS);
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', async (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({
          passed: false,
          blocking_objections: [`claude review exited with code ${code}${stderr ? `: ${stderr.slice(0, 200)}` : ''}`],
          notes: [],
        });
        return;
      }
      try {
        const parsed = JSON.parse(await readFile(outputPath, 'utf8'));
        resolve({
          passed: Boolean(parsed.passed),
          blocking_objections: Array.isArray(parsed.blocking_objections) ? parsed.blocking_objections : [],
          notes: Array.isArray(parsed.notes) ? parsed.notes : [],
        });
      } catch (error) {
        resolve({
          passed: false,
          blocking_objections: [`invalid claude review output: ${error.message}`],
          notes: [],
        });
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        passed: false,
        blocking_objections: [`failed to spawn claude review: ${error.message}`],
        notes: [],
      });
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

  console.log(`[LOOP] Code changed by ${label} — restarting managed services...`);
  await restartServices();
  return true;
}

const DEVLOOP_REASONING_DIR = join(STATE_DIR, 'reasoning');

export async function maybeCompileReasoningArtifacts(runDir, decisionsJson) {
  const decisions = decisionsJson?.decisions || [];
  const artifacts = await collectReasoningArtifacts(runDir, decisions);
  if (!artifacts.length) return [];
  await writeReasoningArtifacts(artifacts, { dir: DEVLOOP_REASONING_DIR });
  return artifacts;
}

async function fetchDashboardJson(path) {
  const response = await fetch(`${DASHBOARD_URL}${path}`, {
    headers: { 'X-Patron-Key': DASHBOARD_KEY },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status} for ${path}: ${body || response.statusText}`);
  }
  return response.json();
}

function computeStructuralDiff(state, counts = {}, drState = {}) {
  const previous = {
    desires: state.last_desire_count,
    patterns: state.last_pattern_count,
    tactics: state.last_tactic_count,
    experiences: state.last_experience_count,
    dr_generation: state.last_dr_generation,
    dr_status: state.last_dr_status,
  };
  const current = {
    desires: counts.desires ?? 0,
    patterns: counts.patterns ?? 0,
    tactics: counts.tactics ?? 0,
    experiences: counts.experiences ?? 0,
    dr_generation: drState.generation ?? null,
    dr_status: drState.status ?? null,
  };

  return {
    counts_changed:
      previous.desires !== undefined &&
      (
        previous.desires !== current.desires ||
        previous.patterns !== current.patterns ||
        previous.tactics !== current.tactics
      ),
    experiences_changed:
      previous.experiences !== undefined &&
      previous.experiences !== current.experiences,
    dr_generation_changed:
      previous.dr_generation !== undefined &&
      previous.dr_generation !== current.dr_generation,
    dr_status_changed:
      previous.dr_status !== undefined &&
      previous.dr_status !== current.dr_status,
    previous,
    current,
  };
}

function shouldRunDeepAnalysis(state, classification, observation, structuralDiff, drState = {}) {
  if (ANALYSIS_EVERY <= 1) return true;
  const hasMaterialMechanicalIssue = (classification?.issues || []).some((issue) =>
    ['medium', 'high', 'critical'].includes(issue.severity),
  );
  if (hasMaterialMechanicalIssue) return true;
  if (structuralDiff.counts_changed || structuralDiff.dr_generation_changed) return true;
  if (['failed', 'completed'].includes(drState.status)) return true;

  const outcome = observation?.analysis?.execution_health?.outcome;
  if (outcome && !['clean', 'ok', 'success'].includes(String(outcome))) return true;

  return state.cycle % ANALYSIS_EVERY === 0;
}

function shouldSendNotification({ significant, isHeartbeat }) {
  if (NOTIFY_MODE === 'none') return false;
  if (NOTIFY_MODE === 'all') return true;
  return significant || isHeartbeat;
}

async function appendOvernightLog({
  timestamp,
  observation,
  classification,
  ccResult,
  decisions = [],
  significant,
  structuralDiff,
}) {
  const logPath = join(STATE_DIR, 'overnight-log.md');
  const existing = await readFile(logPath, 'utf8').catch(() => '# Dev Loop Overnight Log\n');
  const sessionId = observation?.latest_session_id || '?';
  const duration = observation?.analysis?.execution_health?.elapsed_ms
    ? Math.round(observation.analysis.execution_health.elapsed_ms / 1000)
    : '?';
  const cost = observation?.analysis?.execution_health?.cost?.toFixed(2) || '?';
  const ccFindings = ccResult?.analysis?.findings || [];
  const healthySignals = ccResult?.analysis?.healthy_signals || [];
  const classificationIssues = classification?.issues || [];
  const applied = decisions.filter((decision) => decision.verified);
  const escalated = decisions.filter((decision) => decision.action === 'escalate');
  const deferred = decisions.filter((decision) => decision.action === 'defer');
  const sections = [
    `## Cycle ${observation?.analysis?.session_counter || 'n/a'} — ${timestamp}`,
    `**Session:** ${sessionId} | **Duration:** ${duration}s | **Cost:** $${cost} | **Significant:** ${significant ? 'yes' : 'no'}`,
    '',
    '### Findings',
    ...(classificationIssues.length
      ? classificationIssues.map((issue) => `- [${issue.severity}] ${issue.locus}: ${issue.summary}`)
      : ['- No mechanical findings']),
    ...ccFindings.map((finding) => `- [${finding.severity}] ${finding.locus}: ${finding.summary}`),
    '',
    '### Actions Taken',
    ...(applied.length ? applied.map((decision) => `- Applied: ${decision.summary}`) : []),
    ...(escalated.length ? escalated.map((decision) => `- Escalated: ${decision.summary}`) : []),
    ...(deferred.length ? deferred.map((decision) => `- Deferred: ${decision.summary}`) : []),
    ...(applied.length || escalated.length || deferred.length ? [] : ['- Observed only']),
    '',
    '### Healthy Signals',
    ...(healthySignals.length ? healthySignals.map((signal) => `- ${signal}`) : ['- None recorded']),
  ];
  if (structuralDiff?.counts_changed || structuralDiff?.dr_generation_changed || structuralDiff?.dr_status_changed) {
    sections.push('', '### Structural Changes');
    sections.push(`- State: ${JSON.stringify(structuralDiff.previous)} -> ${JSON.stringify(structuralDiff.current)}`);
  }
  sections.push('', '---');
  await writeFile(logPath, `${existing}\n${sections.join('\n')}\n`);
}

// ── Approval processing ──────────────────────────────────

async function processDebugMessages(state) {
  const replies = await checkApprovals(state);
  const debugMsgs = replies.filter(r => r.action === 'DEBUG');
  if (!debugMsgs.length) return replies.filter(r => r.action !== 'DEBUG');

  for (const msg of debugMsgs) {
    console.log(`[DEBUG] Received: ${msg.message.slice(0, 100)}`);
    state.processed_reply_ids.push(msg.id);

    try {
      // Spawn a quick CC process to answer the debug question
      const debugPrompt = [
        `The patron sent a debug message via Slack: "${msg.message}"`,
        '',
        `Answer concisely (under 200 words). You have access to:`,
        `- KV state via dashboard API at http://localhost:8790 (header: X-Patron-Key: test)`,
        `- Dev loop state at ${STATE_DIR}`,
        `- Agent source code in the current directory`,
        '',
        `After answering, write ONLY your response text to stdout. No JSON wrapping.`,
      ].join('\n');

      const child = spawn('claude', [
        '-p', debugPrompt,
        '--dangerously-skip-permissions',
        '--output-format', 'text',
        '--no-session-persistence',
        '--model', 'sonnet',
      ], { cwd: __root, env: { ...process.env } });

      let stdout = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      await new Promise(resolve => {
        const timer = setTimeout(() => { child.kill('SIGTERM'); resolve(); }, 120_000);
        child.on('close', () => { clearTimeout(timer); resolve(); });
        child.on('error', () => { clearTimeout(timer); resolve(); });
      });

      const response = stdout.trim().slice(0, 2000) || '(no response generated)';
      const slackDm = rubric.notifications?.slack_dm;
      await sendSlack(`[DEBUG] ${response}`, slackDm ? { channel: slackDm } : undefined);
      console.log(`[DEBUG] Response sent`);
    } catch (e) {
      console.log(`[DEBUG] Failed: ${e.message}`);
    }
  }

  await saveState(STATE_DIR, state);
  return replies.filter(r => r.action !== 'DEBUG');
}

async function processApprovals(state) {
  // Process debug messages first, return remaining non-debug replies
  let replies;
  try {
    replies = await processDebugMessages(state) || [];
  } catch {
    replies = await checkApprovals(state);
  }
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

// ── Cold-start detection ─────────────────────────────────

const SEED_PATH = join(__root, 'scripts/seed-local-kv.mjs');
const STAGNATION_THRESHOLD = 5;

function hashFile(path) {
  try {
    return createHash('md5').update(readFileSync(path)).digest('hex');
  } catch { return null; }
}

function hashText(value) {
  return createHash('md5').update(String(value || '')).digest('hex');
}

function boundedHistory(items, max = 400) {
  return items.slice(-max);
}

function buildEmailDeltas(state, classification, ccResult, ccDecisions) {
  const mechanicalIssues = classification?.issues || [];
  const findings = (ccResult?.analysis?.findings || []).filter((f) => f.type !== 'healthy_operation');
  const healthySignals = ccResult?.analysis?.healthy_signals || [];
  const capabilityObservations = ccResult?.analysis?.capability_observations || {};
  const summary = ccResult?.analysis?.summary || '';

  const seenIssues = new Set(state.emailed_issue_hashes || []);
  const seenDecisions = new Set(state.emailed_decision_hashes || []);
  const seenHealthy = new Set(state.emailed_healthy_hashes || []);

  const newMechanical = mechanicalIssues.filter((issue) => {
    const key = hashText(`mechanical:${issue.severity}:${issue.locus}:${issue.summary}`);
    issue._email_hash = key;
    return !seenIssues.has(key);
  });
  const newFindings = findings.filter((finding) => {
    const key = hashText(`finding:${finding.severity}:${finding.type}:${finding.locus}:${finding.summary}`);
    finding._email_hash = key;
    return !seenIssues.has(key);
  });
  const newDecisions = ccDecisions.filter((decision) => {
    const key = hashText(`decision:${decision.seq}:${decision.action}:${decision.summary}:${decision.verified}:${decision.route_reason || ''}`);
    decision._email_hash = key;
    return !seenDecisions.has(key);
  });
  const newHealthy = healthySignals.filter((signal) => {
    const key = hashText(`healthy:${signal}`);
    signal._email_hash = key;
    return !seenHealthy.has(key);
  });

  const capabilityHash = Object.keys(capabilityObservations).length
    ? hashText(JSON.stringify(capabilityObservations))
    : null;
  const summaryHash = summary ? hashText(summary) : null;

  return {
    newMechanical,
    newFindings,
    newDecisions,
    newHealthy,
    capabilityChanged: Boolean(capabilityHash && capabilityHash !== state.emailed_capability_hash),
    summaryChanged: Boolean(summaryHash && summaryHash !== state.emailed_summary_hash),
    capabilityHash,
    summaryHash,
    hasDelta: Boolean(
      newMechanical.length ||
      newFindings.length ||
      newDecisions.length ||
      newHealthy.length ||
      (capabilityHash && capabilityHash !== state.emailed_capability_hash) ||
      (summaryHash && summaryHash !== state.emailed_summary_hash)
    ),
  };
}

function markEmailDeltasSent(state, deltas) {
  state.emailed_issue_hashes = boundedHistory([
    ...(state.emailed_issue_hashes || []),
    ...deltas.newMechanical.map((issue) => issue._email_hash),
    ...deltas.newFindings.map((finding) => finding._email_hash),
  ]);
  state.emailed_decision_hashes = boundedHistory([
    ...(state.emailed_decision_hashes || []),
    ...deltas.newDecisions.map((decision) => decision._email_hash),
  ]);
  state.emailed_healthy_hashes = boundedHistory([
    ...(state.emailed_healthy_hashes || []),
    ...deltas.newHealthy.map((signal) => signal._email_hash),
  ]);
  if (deltas.capabilityHash) state.emailed_capability_hash = deltas.capabilityHash;
  if (deltas.summaryHash) state.emailed_summary_hash = deltas.summaryHash;
}

function sanitizeCommitMessage(summary) {
  return String(summary || 'auto-applied fix')
    .replace(/\s+/g, ' ')
    .replace(/[^ -~]/g, '')
    .trim()
    .slice(0, 160);
}

async function commitAndPushAutoApply(decision) {
  const files = [...new Set((decision.files_changed || []).filter((file) =>
    typeof file === 'string' &&
    file &&
    !file.startsWith('/') &&
    !file.includes('\0'),
  ))];
  if (!decision.verified || files.length === 0) {
    return { committed: false, pushed: false, reason: 'no verified file changes' };
  }

  try {
    execFileSync('git', ['add', '--', ...files], {
      cwd: __root,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    const staged = execFileSync('git', ['diff', '--cached', '--name-only', '--', ...files], {
      cwd: __root,
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();
    if (!staged) {
      return { committed: false, pushed: false, reason: 'no staged diff' };
    }

    const message = `DEV-LOOP: ${sanitizeCommitMessage(decision.summary)}`;
    execFileSync('git', ['commit', '-m', message], {
      cwd: __root,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    execFileSync('git', ['push', 'origin', 'HEAD'], {
      cwd: __root,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    return { committed: true, pushed: true, message };
  } catch (error) {
    return {
      committed: false,
      pushed: false,
      reason: error.message,
    };
  }
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

  // ── LIVE STATE SNAPSHOT ──
  let drStatusLine = null;
  let drState = {};
  let mindState = {};
  let structuralDiff = computeStructuralDiff(state, {}, {});
  try {
    const [drData, liveMind] = await Promise.all([
      fetchDashboardJson(`/kv/multi?keys=${encodeURIComponent('dr:state:1')},${encodeURIComponent('session_counter')}`),
      fetchDashboardJson('/mind'),
    ]);
    drState = drData['dr:state:1'] || {};
    const sessionCounter = drData['session_counter'] || 0;
    mindState = liveMind || {};
    structuralDiff = computeStructuralDiff(state, {
      desires: liveMind?.desires?.length || 0,
      patterns: liveMind?.patterns?.length || 0,
      tactics: liveMind?.tactics?.length || 0,
      experiences: liveMind?.experiences?.length || 0,
    }, drState);

    if (drState.status === 'dispatched') {
      const age = drState.dispatched_at ? Math.round((Date.now() - new Date(drState.dispatched_at).getTime()) / 60000) : '?';
      drStatusLine = `DR: dispatched (gen ${drState.generation}, ${age}min ago)`;
    } else if (drState.status === 'completed') {
      drStatusLine = `DR: completed (gen ${drState.generation}, awaiting apply)`;
    } else if (drState.status === 'idle') {
      const sessionsUntil = (drState.next_due_session || 0) - sessionCounter;
      drStatusLine = `DR: idle (gen ${drState.generation}, ${sessionsUntil > 0 ? `next in ${sessionsUntil} sessions` : 'due now'})`;
    } else if (drState.status === 'failed') {
      drStatusLine = `DR: FAILED (gen ${drState.generation}, ${drState.failure_reason || 'unknown'})`;
    }
    if (drStatusLine) console.log(`[LOOP] ${drStatusLine}`);
    if (structuralDiff.counts_changed || structuralDiff.dr_generation_changed) {
      console.log(`[LOOP] Structural change: ${JSON.stringify(structuralDiff.previous)} -> ${JSON.stringify(structuralDiff.current)}`);
    }
  } catch (error) {
    console.log(`[LOOP] Live state snapshot failed: ${error.message}`);
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
  const runDeepAnalysis = observation && classification && !isStageDisabled(state, 'analyze')
    && shouldRunDeepAnalysis(state, classification, observation, structuralDiff, drState);
  if (runDeepAnalysis) {
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
  } else if (observation && classification) {
    console.log(`[LOOP] Skipping CC analysis this cycle (analysis_every=${ANALYSIS_EVERY})`);
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
        if (decision.blast_radius === 'module' || decision.blast_radius === 'system') {
          console.log(`[LOOP] Running Claude architecture review for proposal ${decision.seq}...`);
          const review = await runClaudeArchitectureReview(timestamp, decision);
          decision.architecture_review = review;
          if (!review.passed) {
            decision.action = 'defer';
            decision.route_reason = `claude architecture review blocked auto-apply: ${(review.blocking_objections || []).join('; ').slice(0, 240)}`;
            console.log(`[LOOP] Claude review blocked proposal ${decision.seq}: ${decision.route_reason}`);
            continue;
          }
        }

        console.log(`[LOOP] Auto-applying proposal ${decision.seq}: ${decision.summary}`);
        const result = await runAutoApplyDecision(timestamp, decision);
        decision.verified = result.applied && result.tests_passed;
        decision.files_changed = result.files_changed;
        if (!decision.verified && result.revert_reason) {
          decision.revert_reason = result.revert_reason;
        }

        if (decision.verified) {
          const gitResult = await commitAndPushAutoApply(decision);
          decision.git_commit = gitResult;
          console.log(`[LOOP] Auto-apply verified for proposal ${decision.seq}`);
          if (gitResult.committed) {
            console.log(`[LOOP] Auto-apply committed and pushed: ${gitResult.message}`);
          } else {
            console.log(`[LOOP] Auto-apply commit/push skipped: ${gitResult.reason}`);
          }
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
  const hasMaterialMechanicalIssue = (classification?.issues || []).some((issue) =>
    ['medium', 'high', 'critical'].includes(issue.severity),
  );

  // Build per-finding action lines for Slack
  const actionFindings = ccFindings.filter(f => f.type !== 'healthy_operation');
  const healthyFindings = ccFindings.filter(f => f.type === 'healthy_operation');
  const significant = Boolean(
    forceColdStart ||
    structuralDiff.counts_changed ||
    structuralDiff.dr_generation_changed ||
    structuralDiff.dr_status_changed ||
    hasMaterialMechanicalIssue ||
    actionFindings.length > 0 ||
    ccDecisions.length > 0 ||
    drState.status === 'failed',
  );
  const isHeartbeat = HEARTBEAT_EVERY > 0 && state.cycle % HEARTBEAT_EVERY === 0;
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
    drStatusLine,
    (structuralDiff.counts_changed || structuralDiff.dr_generation_changed || structuralDiff.dr_status_changed)
      ? `State: ${JSON.stringify(structuralDiff.previous)} -> ${JSON.stringify(structuralDiff.current)}`
      : null,
    '',
    ccSummary ? `${ccSummary.slice(0, 200)}` : null,
    '',
    findingLines.length ? 'Findings:' : null,
    ...findingLines,
    healthyFindings.length ? `\nHealthy: ${healthyFindings.map(f => f.summary?.slice(0, 50)).join(', ')}` : null,
    !findingLines.length && !healthyFindings.length ? (isHeartbeat ? 'Heartbeat — no findings' : 'Clean — no findings') : null,
  ].filter(x => x !== null).join('\n');

  if (shouldSendNotification({ significant, isHeartbeat })) {
    try {
      const slackDm = rubric.notifications?.slack_dm;
      await sendSlack(slackMsg, slackDm ? { channel: slackDm } : undefined);
      console.log('[LOOP] Slack summary sent');
    } catch (e) {
      console.log(`[LOOP] Slack send failed: ${e.message}`);
    }
  }

  // Email: full detailed report
  if (NOTIFY_MODE === 'all' || significant) {
    try {
    const deltas = buildEmailDeltas(state, classification, ccResult, ccDecisions);
    if (deltas.hasDelta) {
      const emailDecisionMap = new Map(deltas.newDecisions.map((decision) => [decision.seq, decision]));
      const emailFindings = [
        ...deltas.newMechanical.map((issue, i) => {
          return [
            `### M${i + 1}. [${issue.severity}] mechanical — ${issue.locus}`,
            issue.summary,
          ].join('\n');
        }),
        ...deltas.newFindings.map((f, i) => {
          const dec = emailDecisionMap.get(f.seq) || ccDecisions.find((d) => d.seq === f.seq);
          const lines = [
            `### F${i + 1}. [${f.severity}] ${f.type} — ${f.locus}`,
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
            if (dec.git_commit?.committed) {
              lines.push(`**Git:** ${dec.git_commit.message} (pushed)`);
            }
          }
          return lines.join('\n');
        }),
      ];

      const capObs = ccResult?.analysis?.capability_observations || {};
      const emailBody = [
        `# Dev Loop Cycle ${state.cycle} — ${displayTime} IST`,
        '',
        `**Session:** ${sessionId}`,
        `**Duration:** ${duration}s | **Cost:** $${cost}`,
        forceColdStart ? `**Cold start:** ${coldStartReasons.join(', ')}` : null,
        structuralDiff.counts_changed || structuralDiff.dr_generation_changed || structuralDiff.dr_status_changed
          ? `**State change:** ${JSON.stringify(structuralDiff.previous)} -> ${JSON.stringify(structuralDiff.current)}`
          : null,
        '',
        deltas.summaryChanged ? '## New Analysis' : null,
        deltas.summaryChanged ? ccSummary : null,
        '',
        emailFindings.length ? '## New Findings' : null,
        ...emailFindings,
        '',
        deltas.newDecisions.length ? '## New Decisions' : null,
        ...deltas.newDecisions.map((decision) =>
          `- ${decision.action}: ${decision.summary}${decision.verified ? ' (verified)' : ''}${decision.git_commit?.committed ? ` | ${decision.git_commit.message}` : ''}`
        ),
        '',
        deltas.newHealthy.length ? '## Newly Observed Healthy Signals' : null,
        ...deltas.newHealthy.map((signal) => `- ${signal}`),
        '',
        deltas.capabilityChanged ? '## Capability Observation Changes' : null,
        ...(deltas.capabilityChanged
          ? Object.entries(capObs).map(([k, v]) => `- **${k}:** ${v}`)
          : []),
      ].filter(x => x !== null && x !== '').join('\n');

      await sendEmail(emailBody, `[SWAYAMBHU-DEV] Cycle ${state.cycle} — ${deltas.newFindings.length + deltas.newMechanical.length} new items`);
      markEmailDeltasSent(state, deltas);
      console.log('[LOOP] Delta email report sent');
    } else {
      console.log('[LOOP] Email skipped — no new deltas');
    }
    } catch (e) {
      console.log(`[LOOP] Email send failed: ${e.message}`);
    }
  }

  try {
    await appendOvernightLog({
      timestamp,
      observation,
      classification,
      ccResult,
      decisions: ccDecisions,
      significant,
      structuralDiff,
    });
    console.log('[LOOP] Overnight log updated');
  } catch (e) {
    console.log(`[LOOP] Overnight log update failed: ${e.message}`);
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

  state.last_desire_count = mindState?.desires?.length || 0;
  state.last_pattern_count = mindState?.patterns?.length || 0;
  state.last_tactic_count = mindState?.tactics?.length || 0;
  state.last_experience_count = mindState?.experiences?.length || 0;
  state.last_dr_generation = drState?.generation ?? null;
  state.last_dr_status = drState?.status ?? null;

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
  if (!['all', 'significant', 'none'].includes(NOTIFY_MODE)) {
    throw new Error(`Invalid --notify mode "${NOTIFY_MODE}" (use all, significant, or none)`);
  }

  if (COLD_START) {
    state.cycle = 0;
    state.stage_failures = {};
    state.disabled_stages = [];
    await saveState(STATE_DIR, state);
  }

  console.log('[LOOP] Autonomous Dev Loop started');
  console.log(`[LOOP] Budget: $${rubric.daily_cash_budget}/day`);
  console.log(`[LOOP] Stage failure limit: ${rubric.stage_failure_limit}`);
  console.log(`[LOOP] Analysis cadence: every ${ANALYSIS_EVERY} cycle(s)`);
  console.log(`[LOOP] Notifications: ${NOTIFY_MODE}`);
  if (MAX_CYCLES) console.log(`[LOOP] Max cycles this run: ${MAX_CYCLES}`);

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
  process.on('SIGHUP', () => {});

  try { await ensureServices(); } catch (e) {
    console.error(`[LOOP] Service startup failed: ${e.message} — continuing, observe may fail`);
  }

  // Process any pending approvals
  try { await processApprovals(state); } catch (e) {
    console.error(`[LOOP] Approval processing failed: ${e.message}`);
  }

  let consecutiveClean = 0;
  const stopAtCycle = MAX_CYCLES ? state.cycle + MAX_CYCLES : null;

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

    if (stopAtCycle && state.cycle >= stopAtCycle) {
      console.log(`[LOOP] Reached target cycle ${stopAtCycle}. Stopping.`);
      break;
    }

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
