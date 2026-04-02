#!/usr/bin/env node
// Dump all session data from KV for analysis.
// Usage: node scripts/analyze-sessions.mjs [--last N]
// Outputs structured JSON to stdout.

import { readFileSync } from 'fs';
import { Miniflare } from 'miniflare';

const persistPath = '.wrangler/shared-state';
const lastN = process.argv.includes('--last')
  ? parseInt(process.argv[process.argv.indexOf('--last') + 1], 10) || 5
  : 999;

const mf = new Miniflare({
  kvNamespaces: ['KV'],
  kvPersist: persistPath,
  modules: true,
  script: 'export default { fetch() { return new Response("ok"); } }',
});

const kv = await mf.getKVNamespace('KV');

async function listAll(prefix) {
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
  const results = {};
  for (const k of keys) {
    try {
      results[k.name] = await kv.get(k.name, 'json');
    } catch {
      results[k.name] = await kv.get(k.name, 'text');
    }
  }
  return results;
}

async function get(key) {
  try { return await kv.get(key, 'json'); }
  catch { return await kv.get(key, 'text'); }
}

// Gather all data
const [
  karmaKeys, desires, samskaras, experiences, actions,
  drState, defaults, lastReflect, reflections, jobs,
] = await Promise.all([
  listAll('karma:'),
  getAll('desire:'),
  getAll('samskara:'),
  getAll('experience:'),
  getAll('action:'),
  get('dr:state:1'),
  get('config:defaults'),
  get('last_reflect'),
  getAll('reflect:1:'),
  getAll('job:'),
]);

// Load karma records (last N)
const sortedKarmaKeys = karmaKeys
  .sort((a, b) => a.name.localeCompare(b.name))
  .slice(-lastN);

const karma = {};
for (const k of sortedKarmaKeys) {
  karma[k.name] = await kv.get(k.name, 'json');
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
  samskaras,
  experiences,
  actions,
  reflections,
  jobs,
  last_reflect: lastReflect,
  karma,
};

console.log(JSON.stringify(output, null, 2));
await mf.dispose();
