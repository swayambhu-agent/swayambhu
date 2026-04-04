#!/usr/bin/env node
// Autonomous dev loop orchestrator.
// Runs: observe → classify → (experiment/decide/verify driven by CC) in a loop.
//
// Usage:
//   node scripts/dev-loop/loop.mjs              # run indefinitely
//   node scripts/dev-loop/loop.mjs --once       # single cycle
//   node scripts/dev-loop/loop.mjs --cold-start # first cycle uses --reset-all-state

import { initState, loadState, saveState, listProbes, loadQueue, saveRun } from './state.mjs';
import { runObserve } from './observe.mjs';
import { runClassify } from './classify.mjs';
import { runVerify } from './verify.mjs';
import { checkSlackReplies, checkEmailReplies } from './comms.mjs';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(__dirname, '../../.swayambhu/dev-loop');
const rubric = JSON.parse(readFileSync(join(__dirname, 'rubric.json'), 'utf-8'));

const args = process.argv.slice(2);
const ONCE = args.includes('--once');
const COLD_START = args.includes('--cold-start');

// ── Approval checking ────────────────────────────────────

async function checkApprovals(state) {
  const since = state.heartbeat || new Date(Date.now() - 86400000).toISOString();
  let replies = [];
  try {
    const [slack, email] = await Promise.all([
      checkSlackReplies(since).catch(() => []),
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

// ── Single cycle ─────────────────────────────────────────

async function runCycle(state) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  state.cycle += 1;
  state.phase = 'observe';
  state.heartbeat = new Date().toISOString();
  await saveState(STATE_DIR, state);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[LOOP] Cycle ${state.cycle} — ${timestamp}`);
  console.log(`${'='.repeat(60)}`);

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

  // ── EXPERIMENT + DECIDE + VERIFY ──
  // These stages are driven by Claude Code's analysis of the classify
  // output. The loop provides the data; CC reasons about what to do.
  // When running standalone (not under CC), we output the classification
  // and probes for manual review.

  state.phase = 'report';
  await saveState(STATE_DIR, state);

  const probes = await listProbes(STATE_DIR);
  const pending = await loadQueue(STATE_DIR, 'pending');

  console.log(`[LOOP] Active probes: ${probes.length}`);
  console.log(`[LOOP] Pending approvals: ${pending.length}`);

  // ── Generate report ──
  const activeProbes = probes.filter(p =>
    !['closed', 'verified', 'quarantined'].includes(p.status));

  const report = [
    `# Dev Loop Report — Cycle ${state.cycle}`,
    `**Time:** ${timestamp}`,
    `**Budget spent today:** $${state.cash_budget_spent_today.toFixed(2)} / $${rubric.daily_cash_budget}`,
    '',
    classification
      ? `## Issues Found: ${classification.total_issues_found}`
      : '## No observation this cycle',
    '',
    ...(classification?.issues || []).map(i =>
      `- [${i.severity}] ${i.locus}: ${i.summary}`),
    '',
    `## Active Probes: ${activeProbes.length}`,
    ...activeProbes.map(p => `- [${p.status}] ${p.locus}: ${p.summary}`),
    '',
    `## Pending Approvals: ${pending.length}`,
    ...pending.map(p => `- ${p.id}: ${p.summary || p.proposal || '(no summary)'}`),
  ].join('\n');

  await saveRun(STATE_DIR, timestamp, 'report.md', report);
  console.log(`[LOOP] Report saved to runs/${timestamp}/report.md`);

  // ── Stop conditions ──
  if (classification && classification.total_issues_found === 0 &&
      activeProbes.length === 0 && pending.length === 0) {
    console.log('[LOOP] Clean — nothing to do. Stopping.');
    return { stop: true, reason: 'clean' };
  }

  if (activeProbes.length === 0 && pending.length > 0 &&
      classification?.new_issues === 0) {
    console.log('[LOOP] All work blocked on approvals. Stopping.');
    return { stop: true, reason: 'blocked_on_approvals' };
  }

  state.phase = 'idle';
  await saveState(STATE_DIR, state);
  return { stop: false };
}

// ── Main ─────────────────────────────────────────────────

async function main() {
  await initState(STATE_DIR);
  let state = await loadState(STATE_DIR);

  // --cold-start resets cycle and failure counters
  if (COLD_START) {
    state.cycle = 0;
    state.stage_failures = {};
    state.disabled_stages = [];
    await saveState(STATE_DIR, state);
  }

  console.log('[LOOP] Autonomous Dev Loop started');
  console.log(`[LOOP] Budget: $${rubric.daily_cash_budget}/day`);
  console.log(`[LOOP] Stage failure limit: ${rubric.stage_failure_limit}`);

  // Check approvals on startup
  const approvals = await checkApprovals(state);
  if (approvals.length > 0) {
    console.log(`[LOOP] Found ${approvals.length} approval replies`);
    for (const reply of approvals) {
      console.log(`  ${reply.action}: ${reply.id} ${reply.reason || ''}`);
      state.processed_reply_ids.push(reply.id);
    }
    await saveState(STATE_DIR, state);
  }

  while (true) {
    if (isBudgetExhausted(state)) {
      console.log('[LOOP] Daily budget exhausted. Stopping.');
      break;
    }

    const result = await runCycle(state);
    state = await loadState(STATE_DIR);

    if (result.stop || ONCE) {
      console.log(`[LOOP] Stopping. Reason: ${result.reason || 'single run'}`);
      break;
    }

    // Brief pause between cycles
    console.log('[LOOP] Waiting 30s before next cycle...');
    await new Promise(r => setTimeout(r, 30000));
  }

  console.log('[LOOP] Dev loop complete.');
}

main().catch(e => {
  console.error(`[LOOP] Fatal: ${e.message}`);
  process.exit(1);
});
