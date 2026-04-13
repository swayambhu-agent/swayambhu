#!/usr/bin/env node
// Deep-reflect comparison harness for the dev loop.
// Captures a single live DR snapshot, runs Claude and Codex against it in
// parallel, then scores their outputs heuristically without touching live KV.

import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { cp, mkdir, readFile, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { STATE_DIR } from './state.mjs';
import { getDefaultServiceUrls } from './services.mjs';
import { parseJobOutput } from '../../../lib/parse-job-output.js';
import {
  DR_CONTEXT_KEYS,
  rewriteReasoningPathRefs,
  buildComparePrompt,
  buildCompactSnapshotSummary,
  scoreDrPayload,
  compareScoredOutputs,
} from '../../../lib/dev-loop/dr-compare.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../../..');

const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

const DEFAULT_URLS = getDefaultServiceUrls();
const DASHBOARD_URL = process.env.SWAYAMBHU_DASHBOARD_URL || DEFAULT_URLS.dashboardUrl;
const DASHBOARD_KEY = process.env.SWAYAMBHU_PATRON_KEY || process.env.PATRON_KEY || 'test';
const DEFAULT_REASONING_DIR = process.env.SWAYAMBHU_DR_COMPARE_REASONING_DIR || join(STATE_DIR, 'reasoning');
const DEFAULT_CLAUDE_MODEL = process.env.SWAYAMBHU_DR_COMPARE_CLAUDE_MODEL || 'opus';
const DEFAULT_CODEX_MODEL = process.env.SWAYAMBHU_DR_COMPARE_CODEX_MODEL || null;
const DEFAULT_CODEX_PROFILE = process.env.SWAYAMBHU_DR_COMPARE_CODEX_PROFILE || 'high';
const DEFAULT_TIMEOUT_MS = Number(process.env.SWAYAMBHU_DR_COMPARE_TIMEOUT_MS || 180000);

export {
  DR_CONTEXT_KEYS,
  rewriteReasoningPathRefs,
  buildComparePrompt,
  buildCompactSnapshotSummary,
  scoreDrPayload,
  compareScoredOutputs,
};

function chunk(items, size) {
  const batches = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || 30_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        'X-Patron-Key': DASHBOARD_KEY,
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status} from ${url}: ${body || response.statusText}`);
    }
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function expandContextKeys(patterns) {
  const keys = new Set();
  for (const pattern of patterns) {
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1);
      const data = await fetchJson(`${DASHBOARD_URL}/kv?prefix=${encodeURIComponent(prefix)}`);
      for (const entry of data.keys || []) keys.add(entry.key);
    } else {
      keys.add(pattern);
    }
  }
  return [...keys].sort();
}

async function readKeys(keys) {
  const values = {};
  for (const batch of chunk(keys, 50)) {
    const query = batch.map((key) => encodeURIComponent(key)).join(',');
    const data = await fetchJson(`${DASHBOARD_URL}/kv/multi?keys=${query}`);
    Object.assign(values, data);
  }
  return values;
}

function keyToRelativePath(key) {
  return `${key.replace(/:/g, '/')}.json`;
}

async function writeSnapshot(snapshotDir, values) {
  for (const [key, value] of Object.entries(values)) {
    if (value == null) continue;
    const filePath = join(snapshotDir, keyToRelativePath(key));
    await mkdir(dirname(filePath), { recursive: true });
    const content = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    await writeFile(filePath, content, 'utf8');
  }
}

async function writeCompactSummary(snapshotDir, values) {
  const summaryDir = join(snapshotDir, 'summary');
  const compact = buildCompactSnapshotSummary(values);
  await mkdir(summaryDir, { recursive: true });
  await Promise.all([
    writeFile(join(summaryDir, 'state.compact.json'), JSON.stringify(compact.state, null, 2), 'utf8'),
    writeFile(join(summaryDir, 'experiences.compact.json'), JSON.stringify(compact.experiences, null, 2), 'utf8'),
    writeFile(join(summaryDir, 'actions.compact.json'), JSON.stringify(compact.actions, null, 2), 'utf8'),
  ]);
}

async function copyReasoningSnapshot(destination, source) {
  await mkdir(destination, { recursive: true });
  if (existsSync(source)) {
    await cp(source, destination, { recursive: true });
    return;
  }
  await writeFile(join(destination, 'INDEX.md'), '# Reasoning Artifacts\n\nNo local reasoning snapshot was available.\n', 'utf8');
}

function nowTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function buildRunPaths(timestamp) {
  const runDir = join(STATE_DIR, 'runs', timestamp);
  const compareDir = join(runDir, 'dr-compare');
  const snapshotDir = join(compareDir, 'snapshot');
  return { runDir, compareDir, snapshotDir };
}

function runCommand(command, args, { cwd, stdinText = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: { ...process.env } });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, timeoutMs);

    if (stdinText != null) child.stdin.end(stdinText);
    else child.stdin.end();

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timed_out: timedOut });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, error: error.message, timed_out: timedOut });
    });
  });
}

async function runClaudeCompare({ prompt, snapshotDir, compareDir, model, timeoutMs }) {
  const rawPath = join(compareDir, 'claude.raw.json');
  const stderrPath = join(compareDir, 'claude.stderr.log');
  const promptPath = join(compareDir, 'prompt.compare.md');
  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '--dangerously-skip-permissions',
    '--no-session-persistence',
  ];
  if (model) args.push('--model', model);

  const startedAt = Date.now();
  const result = await runCommand('claude', args, { cwd: snapshotDir, timeoutMs });
  const durationMs = Date.now() - startedAt;
  await writeFile(rawPath, result.stdout || '', 'utf8');
  await writeFile(stderrPath, result.stderr || '', 'utf8');

  const parsed = parseJobOutput(result.stdout || '');
  return {
    runner: 'claude',
    command: `claude -p @${promptPath} --output-format json --dangerously-skip-permissions --no-session-persistence${model ? ` --model ${model}` : ''}`,
    prompt_path: promptPath,
    exit_code: result.code,
    duration_ms: durationMs,
    raw_path: rawPath,
    stderr_path: stderrPath,
    timed_out: !!result.timed_out,
    parse_ok: !!parsed.payload,
    payload: parsed.payload,
    meta: parsed.meta,
    error: result.error || null,
  };
}

async function runCodexCompare({ prompt, snapshotDir, compareDir, model, timeoutMs, profile }) {
  const lastMessagePath = join(compareDir, 'codex.last-message.json');
  const stdoutPath = join(compareDir, 'codex.stdout.log');
  const stderrPath = join(compareDir, 'codex.stderr.log');
  const promptPath = join(compareDir, 'prompt.compare.md');
  const args = [
    'exec',
    '-',
    '-C', snapshotDir,
    '--profile', profile || DEFAULT_CODEX_PROFILE,
    '--skip-git-repo-check',
    '--ephemeral',
    '--dangerously-bypass-approvals-and-sandbox',
    '--output-last-message', lastMessagePath,
    '--color', 'never',
  ];
  if (model) args.push('--model', model);

  const startedAt = Date.now();
  const result = await runCommand('codex', args, { cwd: ROOT, stdinText: prompt, timeoutMs });
  const durationMs = Date.now() - startedAt;
  await writeFile(stdoutPath, result.stdout || '', 'utf8');
  await writeFile(stderrPath, result.stderr || '', 'utf8');

  let rawLastMessage = '';
  try {
    rawLastMessage = await readFile(lastMessagePath, 'utf8');
  } catch {
    // leave empty
  }
  const parsed = parseJobOutput(rawLastMessage || '');
  return {
    runner: 'codex',
    command: `codex exec - < ${promptPath} -C ${snapshotDir} --profile ${profile || DEFAULT_CODEX_PROFILE} --skip-git-repo-check --ephemeral --dangerously-bypass-approvals-and-sandbox --output-last-message ${lastMessagePath} --color never${model ? ` --model ${model}` : ''}`,
    prompt_path: promptPath,
    exit_code: result.code,
    duration_ms: durationMs,
    raw_path: lastMessagePath,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    timed_out: !!result.timed_out,
    parse_ok: !!parsed.payload,
    payload: parsed.payload,
    meta: parsed.meta,
    error: result.error || null,
  };
}

function renderMarkdownReport({ timestamp, snapshotKeys, claude, codex, comparison }) {
  const lines = [
    `# DR Compare Report`,
    '',
    `- Timestamp: ${timestamp}`,
    `- Snapshot keys: ${snapshotKeys.length}`,
    `- Winner: ${comparison.winner || 'no clear winner'}`,
    comparison.margin ? `- Margin: ${comparison.margin}` : '- Margin: 0',
    '',
  ];

  for (const result of [claude, codex]) {
    const score = result.score || { total: 0, breakdown: {}, issues: ['runner failed'] };
    lines.push(`## ${result.runner}`);
    lines.push(`- Exit code: ${result.exit_code}`);
    lines.push(`- Timed out: ${result.timed_out ? 'yes' : 'no'}`);
    lines.push(`- Parse ok: ${result.parse_ok}`);
    lines.push(`- Total score: ${score.total}/100`);
    lines.push(`- Raw score: ${score.raw_total}/${score.max_total}`);
    lines.push(`- Duration: ${result.duration_ms}ms`);
    if (result.meta?.total_cost_usd != null) lines.push(`- Cost: $${result.meta.total_cost_usd}`);
    lines.push('- Breakdown:');
    lines.push(`  - schema: ${score.breakdown.schema}`);
    lines.push(`  - operations: ${score.breakdown.operations}`);
    lines.push(`  - desires: ${score.breakdown.desires}`);
    lines.push(`  - patterns: ${score.breakdown.patterns}`);
    lines.push(`  - carry_forward: ${score.breakdown.carry_forward}`);
    lines.push(`  - restraint: ${score.breakdown.restraint}`);
    lines.push(`  - reasoning_artifacts: ${score.breakdown.reasoning_artifacts}`);
    lines.push(`  - bootstrap_calibration: ${score.breakdown.bootstrap_calibration}`);
    if (score.issues.length) {
      lines.push('- Issues:');
      for (const issue of score.issues.slice(0, 12)) lines.push(`  - ${issue}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function parseArgs(argv) {
  const args = {
    timestamp: nowTimestamp(),
    reasoningDir: DEFAULT_REASONING_DIR,
    claudeModel: DEFAULT_CLAUDE_MODEL,
    codexModel: DEFAULT_CODEX_MODEL,
    codexProfile: DEFAULT_CODEX_PROFILE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === '--timestamp') args.timestamp = argv[++i];
    else if (value === '--reasoning-dir') args.reasoningDir = argv[++i];
    else if (value === '--claude-model') args.claudeModel = argv[++i];
    else if (value === '--codex-model') args.codexModel = argv[++i];
    else if (value === '--codex-profile') args.codexProfile = argv[++i];
    else if (value === '--timeout-ms') args.timeoutMs = Number(argv[++i]) || DEFAULT_TIMEOUT_MS;
    else if (value === '--help' || value === '-h') {
      args.help = true;
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/operator/dev-loop/dr-compare.mjs [--timestamp ID] [--reasoning-dir PATH] [--claude-model MODEL] [--codex-model MODEL] [--codex-profile PROFILE] [--timeout-ms N]');
    process.exit(0);
  }

  const { compareDir, snapshotDir } = buildRunPaths(args.timestamp);
  await mkdir(compareDir, { recursive: true });

  const snapshotKeys = await expandContextKeys(DR_CONTEXT_KEYS);
  const snapshotValues = await readKeys(snapshotKeys);
  await writeSnapshot(snapshotDir, snapshotValues);
  await writeCompactSummary(snapshotDir, snapshotValues);
  await copyReasoningSnapshot(join(snapshotDir, 'reasoning'), args.reasoningDir);

  const basePrompt = typeof snapshotValues['prompt:deep_reflect'] === 'string' && snapshotValues['prompt:deep_reflect'].trim()
    ? snapshotValues['prompt:deep_reflect']
    : await readFile(join(ROOT, 'prompts/deep_reflect.md'), 'utf8');
  const wrappedPrompt = buildComparePrompt(basePrompt);
  await writeFile(join(compareDir, 'prompt.base.md'), basePrompt, 'utf8');
  await writeFile(join(compareDir, 'prompt.compare.md'), wrappedPrompt, 'utf8');
  await writeFile(join(compareDir, 'snapshot-keys.json'), JSON.stringify(snapshotKeys, null, 2), 'utf8');

  const [claude, codex] = await Promise.all([
    runClaudeCompare({
      prompt: wrappedPrompt,
      snapshotDir,
      compareDir,
      model: args.claudeModel,
      timeoutMs: args.timeoutMs,
    }),
    runCodexCompare({
      prompt: wrappedPrompt,
      snapshotDir,
      compareDir,
      model: args.codexModel,
      timeoutMs: args.timeoutMs,
      profile: args.codexProfile,
    }),
  ]);

  claude.score = scoreDrPayload(claude.payload, snapshotValues);
  codex.score = scoreDrPayload(codex.payload, snapshotValues);

  const comparison = compareScoredOutputs([claude, codex]);
  const report = {
    timestamp: args.timestamp,
    dashboard_url: DASHBOARD_URL,
    reasoning_dir: args.reasoningDir,
    snapshot_key_count: snapshotKeys.length,
    claude,
    codex,
    comparison,
  };

  await writeFile(join(compareDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  await writeFile(join(compareDir, 'report.md'), renderMarkdownReport({
    timestamp: args.timestamp,
    snapshotKeys,
    claude,
    codex,
    comparison,
  }), 'utf8');

  console.log(JSON.stringify({
    ok: true,
    compare_dir: compareDir,
    winner: comparison.winner,
    claude_score: claude.score.total,
    codex_score: codex.score.total,
    margin: comparison.margin,
  }, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[DR-COMPARE] Fatal: ${error.message}`);
    process.exit(1);
  });
}
