#!/usr/bin/env node
// Dump all session data from KV for analysis.
// Usage: node scripts/analyze-sessions.mjs [--last N]
// Outputs structured JSON to stdout.

import { getKV, dispose } from './shared.mjs';
const lastN = process.argv.includes('--last')
  ? parseInt(process.argv[process.argv.indexOf('--last') + 1], 10) || 5
  : 999;
const source = process.argv.includes('--source')
  ? process.argv[process.argv.indexOf('--source') + 1]
  : 'kv';
const dashboardUrl = process.env.SWAYAMBHU_DASHBOARD_URL || 'http://localhost:8790';
const dashboardKey = process.env.SWAYAMBHU_PATRON_KEY || process.env.PATRON_KEY || 'test';

let kv = null;

function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || 30_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        'X-Patron-Key': dashboardKey,
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} from ${url}: ${body || res.statusText}`);
    }
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function listAll(prefix) {
  if (source === 'dashboard') {
    const data = await fetchJson(
      `${dashboardUrl}/kv?prefix=${encodeURIComponent(prefix)}`,
    );
    return (data.keys || []).map((entry) => ({
      name: entry.key,
      metadata: entry.metadata,
    }));
  }

  const keys = [];
  let cursor;
  do {
    const result = await kv.list({ prefix, cursor });
    keys.push(...result.keys);
    cursor = result.list_complete ? null : result.cursor;
  } while (cursor);
  return keys;
}

async function getAll(prefix) {
  const keys = await listAll(prefix);
  return getMany(keys.map((entry) => entry.name));
}

async function getMany(keys) {
  const results = {};
  if (keys.length === 0) return results;

  if (source === 'dashboard') {
    for (const batch of chunk(keys, 50)) {
      const data = await fetchJson(
        `${dashboardUrl}/kv/multi?keys=${batch.map(encodeURIComponent).join(',')}`,
      );
      Object.assign(results, data);
    }
    return results;
  }

  for (const k of keys) {
    try {
      results[k] = await kv.get(k, 'json');
    } catch {
      results[k] = await kv.get(k, 'text');
    }
  }
  return results;
}

async function getReflections() {
  const keys = (await listAll('reflect:'))
    .map((entry) => entry.name)
    .filter((name) => /^reflect:\d+:/.test(name));
  return getMany(keys);
}

async function get(key) {
  if (source === 'dashboard') {
    const data = await fetchJson(
      `${dashboardUrl}/kv/multi?keys=${encodeURIComponent(key)}`,
    );
    return data[key];
  }

  try { return await kv.get(key, 'json'); }
  catch { return await kv.get(key, 'text'); }
}

if (source !== 'dashboard') {
  kv = await getKV();
}

// Gather all data
const [
  karmaKeys, desires, patterns, experiences, actions,
  drState, defaults, lastReflect, reflections, jobs,
  tactics, identifications, promptAct, promptReflect, promptPlan, promptDeepReflect, reviewNotes,
] = await Promise.all([
  listAll('karma:'),
  getAll('desire:'),
  getAll('pattern:'),
  getAll('experience:'),
  getAll('action:'),
  get('dr:state:1'),
  get('config:defaults'),
  get('last_reflect'),
  getReflections(),
  getAll('job:'),
  getAll('tactic:'),
  getAll('identification:'),
  get('prompt:act'),
  get('prompt:reflect'),
  get('prompt:plan'),
  get('prompt:deep_reflect'),
  getAll('review_note:'),
]);

// Load karma records (last N)
const sortedKarmaKeys = karmaKeys
  .sort((a, b) => a.name.localeCompare(b.name))
  .slice(-lastN);

const karma = {};
for (const k of sortedKarmaKeys) {
  karma[k.name] = await get(k.name);
}

// Session schedule
const schedule = await get('session_schedule');
const sessionCounter = await get('session_counter');

const output = {
  _meta: {
    generated_at: new Date().toISOString(),
    karma_count: Object.keys(karma).length,
    total_karma_keys: karmaKeys.length,
  },
  session_counter: sessionCounter,
  session_schedule: schedule,
  dr_state: drState,
  defaults: {
    act_model: defaults?.act?.model,
    reflect_model: defaults?.reflect?.model,
    deep_reflect_model: defaults?.deep_reflect?.model,
    session_budget: defaults?.session_budget,
    schedule_interval: defaults?.schedule?.interval_seconds,
    deep_reflect_interval: {
      sessions: defaults?.deep_reflect?.default_interval_sessions,
      days: defaults?.deep_reflect?.default_interval_days,
    },
  },
  desires,
  patterns,
  tactics,
  identifications,
  experiences,
  actions,
  reflections,
  review_notes: reviewNotes,
  jobs,
  last_reflect: lastReflect,
  prompts: {
    act: promptAct,
    reflect: promptReflect,
    plan: promptPlan,
    deep_reflect: promptDeepReflect,
  },
  karma,
};

console.log(JSON.stringify(output, null, 2));
if (kv) {
  await dispose();
}
