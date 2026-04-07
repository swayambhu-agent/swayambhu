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
import { parseJobOutput } from '../../lib/parse-job-output.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');

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

// Must match userspace.js dispatchDr context_keys.
export const DR_CONTEXT_KEYS = [
  'pattern:*', 'experience:*', 'desire:*', 'tactic:*',
  'action:*', 'principle:*',
  'config:defaults', 'config:models', 'config:model_capabilities',
  'config:tool_registry', 'config:event_handlers',
  'prompt:plan', 'prompt:act', 'prompt:reflect', 'prompt:communication',
  'kernel:source_map',
  'reflect:1:*', 'last_reflect',
];

export function rewriteReasoningPathRefs(basePrompt, reasoningDir = './reasoning') {
  return String(basePrompt || '')
    .replaceAll('/home/swayambhu/reasoning/', `${reasoningDir}/`)
    .replaceAll('/home/swayambhu/reasoning', reasoningDir);
}

export function buildComparePrompt(basePrompt, { reasoningDir = './reasoning' } = {}) {
  const rewrittenBasePrompt = rewriteReasoningPathRefs(basePrompt, reasoningDir);
  return [
    'You are running inside the Swayambhu dev-loop deep-reflect comparison harness.',
    'The current working directory is a frozen deep-reflect snapshot.',
    `For this comparison run, treat references to /home/swayambhu/reasoning/ as ${reasoningDir}/.`,
    `Start with ${reasoningDir}/INDEX.md if it exists, then read summary/state.compact.json, summary/experiences.compact.json, and summary/actions.compact.json before falling back to raw files.`,
    `Start with ${reasoningDir}/INDEX.md if it exists, then open any relevant artifact files from that snapshot.`,
    'The summary/*.compact.json files are derived from the same snapshot and intentionally omit embeddings and bulky tool-output blobs.',
    'Do not browse the web for this task.',
    'Read only from the snapshot. Do not modify files. Respond with only the JSON object requested by the prompt.',
    'If a referenced file is missing, continue with the available context instead of inventing hidden state.',
    '',
    rewrittenBasePrompt,
  ].join('\n\n');
}

function compactExperience(key, value = {}) {
  return {
    key,
    timestamp: value.timestamp || null,
    action_ref: value.action_ref || null,
    session_id: value.session_id || null,
    cycle: value.cycle ?? null,
    observation: value.observation || null,
    desire_alignment: value.desire_alignment || null,
    pattern_delta: value.pattern_delta || null,
    salience: value.salience ?? null,
    narrative: value.text_rendering?.narrative || value.narrative || null,
  };
}

function compactAction(key, value = {}) {
  return {
    key,
    kind: value.kind || null,
    timestamp: value.timestamp || null,
    execution_id: value.execution_id || null,
    session_number: value.session_number ?? null,
    cycle: value.cycle ?? null,
    plan: value.plan || null,
    tool_names: (value.tool_calls || []).map((toolCall) => toolCall.tool),
    tool_ok: (value.tool_calls || []).map((toolCall) => ({
      tool: toolCall.tool,
      ok: toolCall.ok,
      error: toolCall.error || null,
    })),
    final_text: value.final_text || null,
    eval: {
      sigma: value.eval?.sigma ?? null,
      desire_axis: value.eval?.desire_axis ?? null,
      patterns_relied_on: value.eval?.patterns_relied_on || [],
      tool_outcomes: value.eval?.tool_outcomes || [],
      plan_success_criteria: value.eval?.plan_success_criteria || null,
    },
    review: value.review || null,
  };
}

export function buildCompactSnapshotSummary(snapshotValues = {}) {
  const principles = [];
  const desires = [];
  const patterns = [];
  const tactics = [];
  const experiences = [];
  const actions = [];
  const reflectRecords = [];

  for (const [key, value] of Object.entries(snapshotValues)) {
    if (key.startsWith('principle:')) {
      principles.push({ key, text: typeof value === 'string' ? value : (value?.text || JSON.stringify(value)) });
      continue;
    }
    if (key.startsWith('desire:')) {
      desires.push({ key, ...value });
      continue;
    }
    if (key.startsWith('pattern:')) {
      patterns.push({ key, ...value });
      continue;
    }
    if (key.startsWith('tactic:')) {
      tactics.push({ key, ...value });
      continue;
    }
    if (key.startsWith('experience:')) {
      experiences.push(compactExperience(key, value));
      continue;
    }
    if (key.startsWith('action:')) {
      actions.push(compactAction(key, value));
      continue;
    }
    if (key.startsWith('reflect:1:')) {
      reflectRecords.push({ key, ...value });
    }
  }

  return {
    state: {
      desires,
      patterns,
      tactics,
      principles,
      last_reflect: snapshotValues.last_reflect || null,
      prior_deep_reflect: reflectRecords.sort((a, b) => a.key.localeCompare(b.key)),
      defaults: snapshotValues['config:defaults'] || null,
      models: snapshotValues['config:models'] || null,
      source_map: snapshotValues['kernel:source_map'] || null,
    },
    experiences: experiences.sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || ''))),
    actions: actions.sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || ''))),
  };
}

function chunk(items, size) {
  const batches = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isFirstPerson(description) {
  return /(^|\s)(i|my)\b/i.test(String(description || ''));
}

function looksActionable(description) {
  const text = normalizeText(description);
  if (!text) return false;
  const blocked = [
    'someone gives me',
    'someone tells me',
    'the patron gives me',
    'they give me',
    'others give me',
    'receive approval',
    'be chosen by',
  ];
  if (blocked.some((phrase) => text.includes(phrase))) return false;
  return /(i|my)\b/.test(text) && /(know|understand|learn|build|choose|maintain|improve|develop|gain|create|organize|keep|make|clarify)/.test(text);
}

function looksObservational(pattern) {
  const text = normalizeText(pattern);
  if (!text) return false;
  const advisory = ['should ', 'must ', 'need to', 'try to', 'always ', 'never ', 'do '];
  return !advisory.some((needle) => text.includes(needle));
}

function looksTemporal(pattern) {
  const text = normalizeText(pattern);
  return text.startsWith('this session ') || text.startsWith('current ') || text.startsWith('today ');
}

function countWords(text) {
  return normalizeText(text).split(' ').filter(Boolean).length;
}

function mentionsBootstrap(text) {
  const normalized = normalizeText(text);
  const needles = [
    'bootstrap',
    'cold start',
    'empty desire',
    'empty desires',
    'no desires',
    'no desire',
    'cold start loop',
    'bootstrap stall',
  ];
  return needles.some((needle) => normalized.includes(needle));
}

function isIsoDate(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  const parsed = new Date(text);
  return !Number.isNaN(parsed.getTime())
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(text);
}

function describeOp(op) {
  return `${op.op || 'put'} ${op.key || '(missing key)'}`;
}

function buildSnapshotIndex(snapshotValues = {}) {
  const existingDesireKeys = new Set();
  const existingDesireDescriptions = new Set();
  const currentCarryForward = Array.isArray(snapshotValues['last_reflect']?.carry_forward)
    ? snapshotValues['last_reflect'].carry_forward
    : [];
  const actions = [];
  const experiences = [];

  for (const [key, value] of Object.entries(snapshotValues)) {
    if (key.startsWith('desire:')) {
      existingDesireKeys.add(key);
      existingDesireDescriptions.add(normalizeText(value?.description));
      continue;
    }
    if (key.startsWith('action:')) {
      actions.push(value);
      continue;
    }
    if (key.startsWith('experience:')) {
      experiences.push(value);
    }
  }

  const nonNoActionActions = actions.filter((action) =>
    action?.kind !== 'no_action' && action?.plan?.no_action !== true,
  );
  const bootstrapLike = existingDesireKeys.size === 0
    && experiences.length > 0
    && experiences.length <= 2
    && actions.length > 0
    && nonNoActionActions.length === 0;

  return {
    existingDesireKeys,
    existingDesireDescriptions,
    currentCarryForward,
    actionCount: actions.length,
    experienceCount: experiences.length,
    bootstrapLike,
  };
}

export function scoreDrPayload(payload, snapshotValues = {}) {
  const issues = [];
  const breakdown = {
    schema: 0,
    operations: 0,
    desires: 0,
    patterns: 0,
    carry_forward: 0,
    restraint: 0,
    reasoning_artifacts: 0,
    bootstrap_calibration: 0,
  };
  const defaultMaxTotal = 100;

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    issues.push('payload is not a JSON object');
    return { total: 0, raw_total: 0, max_total: defaultMaxTotal, breakdown, issues };
  }

  const snapshot = buildSnapshotIndex(snapshotValues);
  const kvOperations = Array.isArray(payload.kv_operations) ? payload.kv_operations : null;
  const carryForward = Array.isArray(payload.carry_forward) ? payload.carry_forward : null;
  const reasoningArtifacts = Array.isArray(payload.reasoning_artifacts) ? payload.reasoning_artifacts : null;
  const codeStageRequests = Array.isArray(payload.code_stage_requests) ? payload.code_stage_requests : [];

  if (typeof payload.reflection === 'string' && payload.reflection.trim()) breakdown.schema += 6;
  else issues.push('missing reflection');

  if (typeof payload.note_to_future_self === 'string' && payload.note_to_future_self.trim()) breakdown.schema += 4;
  else issues.push('missing note_to_future_self');

  if (kvOperations) breakdown.schema += 4;
  else issues.push('missing kv_operations array');

  if (carryForward) breakdown.schema += 2;
  else issues.push('missing carry_forward array');

  if (
    payload.next_reflect
    && Number.isFinite(payload.next_reflect.after_sessions)
    && Number.isFinite(payload.next_reflect.after_days)
  ) {
    breakdown.schema += 4;
  } else {
    issues.push('missing or invalid next_reflect');
  }

  if (typeof payload.deploy === 'boolean') breakdown.schema += 0;
  else issues.push('deploy should be boolean');

  if (kvOperations) {
    const seenKeys = new Set();
    breakdown.operations = 25;
    for (const op of kvOperations) {
      const opType = op?.op || 'put';
      if (!op?.key || typeof op.key !== 'string') {
        breakdown.operations -= 5;
        issues.push(`invalid operation missing key: ${JSON.stringify(op)}`);
        continue;
      }

      const allowedPrefix = ['pattern:', 'desire:', 'tactic:', 'principle:', 'config:', 'prompt:']
        .some((prefix) => op.key.startsWith(prefix));
      if (!allowedPrefix) {
        breakdown.operations -= 6;
        issues.push(`invalid write target: ${describeOp(op)}`);
      }

      if (!['put', 'delete', 'patch'].includes(opType)) {
        breakdown.operations -= 4;
        issues.push(`invalid op type: ${describeOp(op)}`);
      }

      if (seenKeys.has(`${opType}:${op.key}`)) {
        breakdown.operations -= 2;
        issues.push(`duplicate operation for ${describeOp(op)}`);
      }
      seenKeys.add(`${opType}:${op.key}`);

      if (opType === 'put' && op.value === undefined) {
        breakdown.operations -= 4;
        issues.push(`put missing value: ${describeOp(op)}`);
      }

      if (
        (op.key.startsWith('principle:') || op.key.startsWith('prompt:'))
        && opType !== 'delete'
        && String(op.deliberation || '').trim().length < 200
      ) {
        breakdown.operations -= 4;
        issues.push(`missing deliberation for ${describeOp(op)}`);
      }

      if (
        op.key.startsWith('pattern:')
        && opType !== 'delete'
        && !(typeof op.value?.strength === 'number' && op.value.strength >= 0 && op.value.strength <= 1)
      ) {
        breakdown.operations -= 3;
        issues.push(`pattern strength out of range for ${describeOp(op)}`);
      }

      if (
        op.key.startsWith('desire:')
        && opType !== 'delete'
        && op.value?.direction !== 'approach'
      ) {
        breakdown.operations -= 4;
        issues.push(`desire direction must be approach for ${describeOp(op)}`);
      }
    }
    breakdown.operations = Math.max(0, breakdown.operations);
  }

  const desireWrites = (kvOperations || []).filter((op) => op?.key?.startsWith('desire:') && (op.op || 'put') !== 'delete');
  const tacticWrites = (kvOperations || []).filter((op) => op?.key?.startsWith('tactic:') && (op.op || 'put') !== 'delete');
  if (!desireWrites.length) {
    breakdown.desires = 10;
  } else {
    const seenDescriptions = new Set(snapshot.existingDesireDescriptions);
    const perDesire = desireWrites.map((op) => {
      const description = op.value?.description;
      const slug = op.value?.slug;
      let score = 0;
      if (typeof description === 'string' && description.trim()) score += 1;
      else issues.push(`desire missing description: ${describeOp(op)}`);

      if (isFirstPerson(description)) score += 1;
      else issues.push(`desire not first-person: ${describeOp(op)}`);

      if (looksActionable(description)) score += 1;
      else issues.push(`desire may not be actionable: ${describeOp(op)}`);

      if (Array.isArray(op.value?.source_principles) && op.value.source_principles.length > 0) score += 1;
      else issues.push(`desire missing source_principles: ${describeOp(op)}`);

      const normalizedDescription = normalizeText(description);
      const keyExists = snapshot.existingDesireKeys.has(op.key);
      const descriptionExists = normalizedDescription && seenDescriptions.has(normalizedDescription);
      if (!keyExists && !descriptionExists && slug) {
        score += 1;
      } else {
        issues.push(`desire duplicates existing substrate state: ${describeOp(op)}`);
      }
      seenDescriptions.add(normalizedDescription);
      return score / 5;
    });
    breakdown.desires = Math.round((perDesire.reduce((sum, score) => sum + score, 0) / perDesire.length) * 20);
  }

  const patternWrites = (kvOperations || []).filter((op) => op?.key?.startsWith('pattern:') && (op.op || 'put') !== 'delete');
  if (!patternWrites.length) {
    breakdown.patterns = snapshot.bootstrapLike ? 8 : 5;
  } else {
    const perPattern = patternWrites.map((op) => {
      const pattern = op.value?.pattern;
      let score = 0;
      if (typeof pattern === 'string' && pattern.trim()) score += 1;
      else issues.push(`pattern missing text: ${describeOp(op)}`);
      if (looksObservational(pattern)) score += 1;
      else issues.push(`pattern looks advisory instead of observational: ${describeOp(op)}`);
      if (!looksTemporal(pattern)) score += 1;
      else issues.push(`pattern looks temporally narrow: ${describeOp(op)}`);
      if (typeof op.value?.strength === 'number' && op.value.strength >= 0 && op.value.strength <= 1) score += 1;
      else issues.push(`pattern strength invalid: ${describeOp(op)}`);
      return score / 4;
    });
    breakdown.patterns = Math.round((perPattern.reduce((sum, score) => sum + score, 0) / perPattern.length) * 10);
    if (snapshot.bootstrapLike) {
      breakdown.patterns = Math.max(0, Math.min(4, breakdown.patterns - 4));
      issues.push('bootstrap output creates pattern memory from too little evidence');
    }
  }

  if (carryForward) {
    breakdown.carry_forward = 4;
    const active = carryForward.filter((item) => item?.status === 'active');
    if (active.length <= 5) breakdown.carry_forward += 2;
    else issues.push(`carry_forward has too many active items (${active.length})`);

    if (!carryForward.length) {
      breakdown.carry_forward += 2;
    } else {
      const newDesireKeys = new Set(desireWrites.map((op) => op.key));
      const itemScores = carryForward.map((item, index) => {
        let score = 0;
        if (typeof item?.id === 'string' && item.id.trim()) score += 1;
        else issues.push(`carry_forward[${index}] missing id`);
        if (typeof item?.item === 'string' && item.item.trim()) score += 1;
        else issues.push(`carry_forward[${index}] missing item`);
        if (typeof item?.why === 'string' && item.why.trim()) score += 1;
        else issues.push(`carry_forward[${index}] missing why`);
        if (['high', 'medium', 'low'].includes(item?.priority)) score += 1;
        else issues.push(`carry_forward[${index}] invalid priority`);
        if (['active', 'done', 'dropped', 'expired'].includes(item?.status)) score += 1;
        else issues.push(`carry_forward[${index}] invalid status`);
        if (item?.status === 'active' && isIsoDate(item?.expires_at) && new Date(item.expires_at) >= new Date('2024-01-01T00:00:00.000Z')) score += 1;
        else if (item?.status === 'active') issues.push(`carry_forward[${index}] active item missing valid expires_at`);
        if (!item?.desire_key || snapshot.existingDesireKeys.has(item.desire_key) || newDesireKeys.has(item.desire_key)) score += 1;
        else issues.push(`carry_forward[${index}] references missing desire_key`);
        return score / 7;
      });
      breakdown.carry_forward += Math.round((itemScores.reduce((sum, score) => sum + score, 0) / itemScores.length) * 4);
    }
  }

  breakdown.restraint = 10;
  const structuralWrites = (kvOperations || []).filter((op) =>
    op?.key?.startsWith('config:') || op?.key?.startsWith('prompt:') || op?.key?.startsWith('principle:'));
  if (structuralWrites.length > 2) {
    breakdown.restraint -= Math.min(6, (structuralWrites.length - 2) * 2);
    issues.push(`structural writes are broad (${structuralWrites.length})`);
  }
  if ((kvOperations || []).length + codeStageRequests.length > 8) {
    breakdown.restraint -= Math.min(4, ((kvOperations || []).length + codeStageRequests.length) - 8);
    issues.push(`output is wide-ranging (${(kvOperations || []).length + codeStageRequests.length} changes)`);
  }
  breakdown.restraint = Math.max(0, breakdown.restraint);

  if (reasoningArtifacts) {
    if (!reasoningArtifacts.length) {
      breakdown.reasoning_artifacts = 2;
    } else {
      const artifactScores = reasoningArtifacts.map((artifact, index) => {
        let score = 0;
        if (typeof artifact?.slug === 'string' && artifact.slug.trim()) score += 1;
        else issues.push(`reasoning_artifacts[${index}] missing slug`);
        if (typeof artifact?.summary === 'string' && artifact.summary.trim()) score += 1;
        else issues.push(`reasoning_artifacts[${index}] missing summary`);
        if (typeof artifact?.decision === 'string' && artifact.decision.trim()) score += 1;
        else issues.push(`reasoning_artifacts[${index}] missing decision`);
        if (Array.isArray(artifact?.conditions_to_revisit)) score += 1;
        else issues.push(`reasoning_artifacts[${index}] missing conditions_to_revisit`);
        if (typeof artifact?.body === 'string' && artifact.body.trim()) score += 1;
        else issues.push(`reasoning_artifacts[${index}] missing body`);
        return score / 5;
      });
      breakdown.reasoning_artifacts = Math.round((artifactScores.reduce((sum, score) => sum + score, 0) / artifactScores.length) * 5);
    }
  } else {
    issues.push('missing reasoning_artifacts array');
  }

  if (snapshot.bootstrapLike) {
    const reflectionBundle = `${payload.reflection || ''}\n${payload.note_to_future_self || ''}`;
    const activeCarryForward = (carryForward || []).filter((item) => item?.status === 'active');

    if (mentionsBootstrap(reflectionBundle)) {
      breakdown.bootstrap_calibration += 2;
    } else {
      issues.push('bootstrap output does not explicitly recognize bootstrap/empty-desire state');
    }

    if (!patternWrites.length && !tacticWrites.length && !structuralWrites.length && !codeStageRequests.length) {
      breakdown.bootstrap_calibration += 3;
    } else {
      if (patternWrites.length) issues.push('bootstrap output should avoid creating patterns from a single bootstrap trace');
      if (tacticWrites.length) issues.push('bootstrap output should avoid creating tactics before recurring evidence exists');
      if (structuralWrites.length || codeStageRequests.length) issues.push('bootstrap output should avoid config/prompt/code interventions before post-bootstrap evidence exists');
    }

    if (desireWrites.length === 1) breakdown.bootstrap_calibration += 2;
    else if (desireWrites.length === 2) breakdown.bootstrap_calibration += 1;
    else if (desireWrites.length === 0) issues.push('bootstrap output leaves the substrate without a seed desire');
    else issues.push(`bootstrap output creates too many desires at once (${desireWrites.length})`);

    if (activeCarryForward.length >= 1 && activeCarryForward.length <= 3) {
      breakdown.bootstrap_calibration += 1;
    } else {
      issues.push(`bootstrap carry_forward should stay minimal (got ${activeCarryForward.length} active items)`);
    }

    if (
      payload.next_reflect
      && (
        (Number.isFinite(payload.next_reflect.after_sessions) && payload.next_reflect.after_sessions <= 3)
        || (Number.isFinite(payload.next_reflect.after_days) && payload.next_reflect.after_days <= 3)
      )
    ) {
      breakdown.bootstrap_calibration += 1;
    } else {
      issues.push('bootstrap output should request an earlier re-check after the first seeded act sessions');
    }

    if (countWords(payload.reflection) >= 20 && countWords(payload.reflection) <= 120) {
      breakdown.bootstrap_calibration += 1;
    } else {
      issues.push('bootstrap reflection is not well calibrated for a minimal bootstrap intervention');
    }
  }

  const maxTotal = snapshot.bootstrapLike ? 110 : 100;
  const rawTotal = Object.values(breakdown).reduce((sum, value) => sum + value, 0);
  const total = Math.round((rawTotal / maxTotal) * 100);
  return { total, raw_total: rawTotal, max_total: maxTotal, breakdown, issues };
}

export function compareScoredOutputs(outputs = []) {
  const ranked = [...outputs].sort((a, b) => b.score.total - a.score.total);
  const [first, second] = ranked;
  if (!first) return { winner: null, margin: 0, ranked };
  if (!second) return { winner: first.runner, margin: first.score.total, ranked };
  const margin = first.score.total - second.score.total;
  return {
    winner: margin >= 3 ? first.runner : null,
    margin,
    ranked,
  };
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
    console.log('Usage: node scripts/dev-loop/dr-compare.mjs [--timestamp ID] [--reasoning-dir PATH] [--claude-model MODEL] [--codex-model MODEL] [--codex-profile PROFILE] [--timeout-ms N]');
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
