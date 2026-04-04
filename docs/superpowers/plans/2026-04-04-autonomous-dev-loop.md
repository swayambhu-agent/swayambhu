# Autonomous Dev Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a 5-stage pipeline (observe → classify → experiment → decide → verify) that autonomously tests and improves Swayambhu by triggering sessions, analyzing cognitive architecture health, probing self-correction capacity, and applying fixes.

**Architecture:** A coordinator script runs stages sequentially in a loop. Each stage is a standalone module in `scripts/dev-loop/`. State lives in `.swayambhu/dev-loop/` (gitignored). Code fixes go through git. Approval requests go through a lightweight Slack/email adapter. Claude Code does analysis/proposals, Codex CLI does adversarial challenge.

**Tech Stack:** Node.js (ESM), Miniflare (KV access via shared.mjs), Slack Web API, Gmail API (existing provider), Codex CLI, vitest (tests)

**Spec:** `docs/superpowers/specs/2026-04-04-autonomous-dev-loop-design.md`

---

## File Structure

```
scripts/dev-loop/
  loop.mjs              — orchestrator: runs stages in a loop, budget, stop conditions
  observe.mjs           — stage 1: trigger session, collect data
  classify.mjs          — stage 2: cognitive audit, issue taxonomy, fingerprint/dedup
  experiment.mjs        — stage 3: probe self-correction, propose fixes, challenge
  decide.mjs            — stage 4: route by evidence/blast-radius, send approvals
  verify.mjs            — stage 5: run tests, repro, rollback on regression
  comms.mjs             — Slack/email send + reply checking adapter
  state.mjs             — read/write .swayambhu/dev-loop/ state files
  rubric.json            — quality lenses + design principles (static config)

tests/
  dev-loop/
    state.test.js       — state module tests
    comms.test.js       — comms adapter tests (mocked APIs)
    classify.test.js    — issue taxonomy, fingerprinting, dedup
    observe.test.js     — session completion detection
    decide.test.js      — evidence threshold routing
```

---

### Task 1: State Module + Directory Scaffold

**Files:**
- Create: `scripts/dev-loop/state.mjs`
- Create: `tests/dev-loop/state.test.js`
- Modify: `.gitignore`

- [ ] **Step 1: Add `.swayambhu/` to .gitignore**

```
# Dev loop operational state
.swayambhu/
```

Append to the existing `.gitignore`.

- [ ] **Step 2: Write failing tests for state module**

```js
// tests/dev-loop/state.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import {
  initState, loadState, saveState, loadProbe, saveProbe,
  listProbes, loadQueue, moveQueue, saveRun, STATE_DIR,
} from '../../scripts/dev-loop/state.mjs';

const TEST_DIR = join(import.meta.dirname, '../../.swayambhu/dev-loop-test');

describe('state module', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('initState creates directory structure', () => {
    initState(TEST_DIR);
    expect(existsSync(join(TEST_DIR, 'probes'))).toBe(true);
    expect(existsSync(join(TEST_DIR, 'queue/pending'))).toBe(true);
    expect(existsSync(join(TEST_DIR, 'queue/approved'))).toBe(true);
    expect(existsSync(join(TEST_DIR, 'queue/rejected'))).toBe(true);
    expect(existsSync(join(TEST_DIR, 'runs'))).toBe(true);
    expect(existsSync(join(TEST_DIR, 'metrics'))).toBe(true);
  });

  it('loadState returns defaults on first run', () => {
    initState(TEST_DIR);
    const state = loadState(TEST_DIR);
    expect(state.cycle).toBe(0);
    expect(state.cash_budget_spent_today).toBe(0);
    expect(state.stage_failures).toEqual({});
    expect(state.processed_reply_ids).toEqual([]);
  });

  it('saveState + loadState round-trips', () => {
    initState(TEST_DIR);
    const state = { cycle: 5, cash_budget_spent_today: 0.42,
      phase: 'observe', heartbeat: new Date().toISOString(),
      stage_failures: { observe: 0 }, processed_reply_ids: [] };
    saveState(TEST_DIR, state);
    const loaded = loadState(TEST_DIR);
    expect(loaded.cycle).toBe(5);
    expect(loaded.cash_budget_spent_today).toBe(0.42);
  });

  it('probe CRUD works', () => {
    initState(TEST_DIR);
    const probe = { id: 'abc123', summary: 'test', status: 'observed' };
    saveProbe(TEST_DIR, probe);
    expect(loadProbe(TEST_DIR, 'abc123')).toEqual(probe);
    const all = listProbes(TEST_DIR);
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe('abc123');
  });

  it('queue move works', () => {
    initState(TEST_DIR);
    const item = { id: 'devloop-123', proposal: 'fix X' };
    saveProbe(TEST_DIR, item); // save something first
    // Save to pending
    const pendingPath = join(TEST_DIR, 'queue/pending/devloop-123.json');
    const { writeFileSync } = await import('fs');
    writeFileSync(pendingPath, JSON.stringify(item));
    moveQueue(TEST_DIR, 'devloop-123', 'pending', 'approved');
    expect(existsSync(pendingPath)).toBe(false);
    expect(existsSync(join(TEST_DIR, 'queue/approved/devloop-123.json'))).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/dev-loop/state.test.js`
Expected: FAIL — module not found

- [ ] **Step 4: Implement state module**

```js
// scripts/dev-loop/state.mjs
import { mkdirSync, readFileSync, writeFileSync, existsSync,
  readdirSync, renameSync } from 'fs';
import { join } from 'path';

export const STATE_DIR = join(import.meta.dirname, '../../.swayambhu/dev-loop');

const DIRS = ['probes', 'queue/pending', 'queue/approved', 'queue/rejected',
  'runs', 'metrics'];

const DEFAULT_STATE = {
  cycle: 0,
  cash_budget_spent_today: 0,
  budget_reset_date: new Date().toISOString().slice(0, 10),
  phase: 'idle',
  heartbeat: null,
  stage_failures: {},
  disabled_stages: [],
  processed_reply_ids: [],
};

export function initState(baseDir = STATE_DIR) {
  for (const dir of DIRS) {
    mkdirSync(join(baseDir, dir), { recursive: true });
  }
  if (!existsSync(join(baseDir, 'state.json'))) {
    writeFileSync(join(baseDir, 'state.json'), JSON.stringify(DEFAULT_STATE, null, 2));
  }
}

export function loadState(baseDir = STATE_DIR) {
  const path = join(baseDir, 'state.json');
  if (!existsSync(path)) return { ...DEFAULT_STATE };
  return JSON.parse(readFileSync(path, 'utf-8'));
}

export function saveState(baseDir = STATE_DIR, state) {
  writeFileSync(join(baseDir, 'state.json'), JSON.stringify(state, null, 2));
}

export function loadProbe(baseDir = STATE_DIR, id) {
  const path = join(baseDir, 'probes', `${id}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

export function saveProbe(baseDir = STATE_DIR, probe) {
  writeFileSync(
    join(baseDir, 'probes', `${probe.id}.json`),
    JSON.stringify(probe, null, 2),
  );
}

export function listProbes(baseDir = STATE_DIR) {
  const dir = join(baseDir, 'probes');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(dir, f), 'utf-8')));
}

export function loadQueue(baseDir = STATE_DIR, bucket) {
  const dir = join(baseDir, `queue/${bucket}`);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(dir, f), 'utf-8')));
}

export function moveQueue(baseDir = STATE_DIR, id, from, to) {
  const src = join(baseDir, `queue/${from}/${id}.json`);
  const dst = join(baseDir, `queue/${to}/${id}.json`);
  renameSync(src, dst);
}

export function saveRun(baseDir = STATE_DIR, timestamp, filename, data) {
  const dir = join(baseDir, 'runs', timestamp);
  mkdirSync(dir, { recursive: true });
  const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  writeFileSync(join(dir, filename), content);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/dev-loop/state.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add scripts/dev-loop/state.mjs tests/dev-loop/state.test.js .gitignore
git commit -m "feat(dev-loop): add state module with directory scaffold and tests"
```

---

### Task 2: Comms Adapter (Slack + Email)

**Files:**
- Create: `scripts/dev-loop/comms.mjs`
- Create: `tests/dev-loop/comms.test.js`

The comms adapter is standalone — it uses Slack Web API and Gmail API
directly (not the agent's tools). It reads secrets from environment
variables (same .env file).

- [ ] **Step 1: Write failing tests for comms module**

```js
// tests/dev-loop/comms.test.js
import { describe, it, expect, vi } from 'vitest';
import { formatApprovalMessage, parseReply } from '../../scripts/dev-loop/comms.mjs';

describe('comms', () => {
  describe('formatApprovalMessage', () => {
    it('formats approval request with ID', () => {
      const msg = formatApprovalMessage({
        id: 'devloop-1712234567-01',
        summary: 'Fix avoidance desire',
        blastRadius: 'module',
        evidence: 'Observed in 3 sessions',
        challengeResult: 'converged',
      });
      expect(msg).toContain('[DEVLOOP]');
      expect(msg).toContain('devloop-1712234567-01');
      expect(msg).toContain('APPROVE devloop-1712234567-01');
      expect(msg).toContain('REJECT devloop-1712234567-01');
    });
  });

  describe('parseReply', () => {
    it('parses APPROVE', () => {
      const result = parseReply('APPROVE devloop-1712234567-01');
      expect(result).toEqual({ id: 'devloop-1712234567-01', action: 'approve', reason: null });
    });

    it('parses REJECT with reason', () => {
      const result = parseReply('REJECT devloop-1712234567-01 too risky');
      expect(result).toEqual({ id: 'devloop-1712234567-01', action: 'reject', reason: 'too risky' });
    });

    it('returns null for non-devloop messages', () => {
      expect(parseReply('hey whats up')).toBeNull();
    });

    it('handles case-insensitive matching', () => {
      const result = parseReply('approve DEVLOOP-123-01');
      expect(result.action).toBe('approve');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dev-loop/comms.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement comms module**

```js
// scripts/dev-loop/comms.mjs
// Dev-loop comms adapter — Slack + Email for approval requests/replies.
// Uses Slack Web API and Gmail API directly (not agent tools).
// Secrets come from process.env (loaded from .env).

export function formatApprovalMessage({ id, summary, blastRadius, evidence, challengeResult }) {
  return `[DEVLOOP] Approval request: ${id}

Issue: ${summary}
Blast radius: ${blastRadius}
Evidence: ${evidence}
Challenge result: ${challengeResult}

Reply with:
  APPROVE ${id}
  REJECT ${id} {reason}`;
}

export function parseReply(text) {
  if (!text) return null;
  const match = text.match(/^(approve|reject)\s+(devloop-[\w-]+)(?:\s+(.+))?$/im);
  if (!match) return null;
  return {
    id: match[2],
    action: match[1].toLowerCase(),
    reason: match[3]?.trim() || null,
  };
}

export async function sendSlack(text) {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL_ID;
  if (!token || !channel) throw new Error('Missing SLACK_BOT_TOKEN or SLACK_CHANNEL_ID');

  const resp = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ channel, text }),
  });
  return resp.json();
}

export async function checkSlackReplies(since) {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL_ID;
  if (!token || !channel) return [];

  const oldest = Math.floor(new Date(since).getTime() / 1000);
  const resp = await fetch(
    `https://slack.com/api/conversations.history?channel=${channel}&oldest=${oldest}&limit=50`,
    { headers: { 'Authorization': `Bearer ${token}` } },
  );
  const data = await resp.json();
  if (!data.ok) return [];

  return (data.messages || [])
    .map(m => parseReply(m.text))
    .filter(Boolean);
}

export async function sendEmail(text, subject) {
  // Reuse Gmail provider logic but with raw fetch (no Workers runtime)
  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }).toString(),
  });
  const { access_token } = await tokenResp.json();

  const to = process.env.DEVLOOP_EMAIL_TO;
  if (!to) throw new Error('Missing DEVLOOP_EMAIL_TO');

  const lines = [
    `To: ${to}`,
    `Subject: ${subject || '[DEVLOOP] Approval Request'}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    text,
  ];
  const raw = btoa(unescape(encodeURIComponent(lines.join('\r\n'))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  });
  return resp.json();
}

export async function checkEmailReplies(since) {
  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }).toString(),
  });
  const { access_token } = await tokenResp.json();

  const after = Math.floor(new Date(since).getTime() / 1000);
  const q = encodeURIComponent(`subject:DEVLOOP after:${after}`);
  const resp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=20`,
    { headers: { 'Authorization': `Bearer ${access_token}` } },
  );
  const data = await resp.json();
  if (!data.messages) return [];

  const replies = [];
  for (const stub of data.messages) {
    const msgResp = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${stub.id}?format=full`,
      { headers: { 'Authorization': `Bearer ${access_token}` } },
    );
    const msg = await msgResp.json();
    const body = extractPlainText(msg.payload);
    const parsed = parseReply(body);
    if (parsed) replies.push(parsed);
  }
  return replies;
}

function extractPlainText(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    const padded = payload.body.data.replace(/-/g, '+').replace(/_/g, '/');
    return decodeURIComponent(escape(atob(padded)));
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractPlainText(part);
      if (text) return text;
    }
  }
  return '';
}

// CLI entry point
if (process.argv[1] === import.meta.filename) {
  const cmd = process.argv[2];
  if (cmd === 'send') {
    const id = process.argv.find((a, i) => process.argv[i-1] === '--id');
    const body = process.argv.find((a, i) => process.argv[i-1] === '--body');
    const channels = (process.argv.find((a, i) => process.argv[i-1] === '--channel') || 'slack').split(',');
    const text = formatApprovalMessage({ id, summary: body, blastRadius: 'system',
      evidence: 'see report', challengeResult: 'converged' });
    if (channels.includes('slack')) await sendSlack(text);
    if (channels.includes('email')) await sendEmail(text, `[DEVLOOP] ${id}`);
    console.log('Sent.');
  } else if (cmd === 'check') {
    const since = process.argv.find((a, i) => process.argv[i-1] === '--since') || new Date(Date.now() - 86400000).toISOString();
    const [slackReplies, emailReplies] = await Promise.all([
      checkSlackReplies(since).catch(() => []),
      checkEmailReplies(since).catch(() => []),
    ]);
    console.log(JSON.stringify([...slackReplies, ...emailReplies], null, 2));
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dev-loop/comms.test.js`
Expected: PASS (only testing pure functions, no network)

- [ ] **Step 5: Commit**

```bash
git add scripts/dev-loop/comms.mjs tests/dev-loop/comms.test.js
git commit -m "feat(dev-loop): add comms adapter for Slack/email approvals"
```

---

### Task 3: Rubric Config

**Files:**
- Create: `scripts/dev-loop/rubric.json`

- [ ] **Step 1: Create rubric file**

```json
{
  "quality_lenses": [
    {
      "name": "elegance",
      "question": "Is the solution clean and natural, or forced/hacky?"
    },
    {
      "name": "generality",
      "question": "Does it solve the class of problem, not just this instance?"
    },
    {
      "name": "robustness",
      "question": "Does it handle edge cases and degrade gracefully?"
    },
    {
      "name": "simplicity",
      "question": "Is it the simplest thing that could work?"
    },
    {
      "name": "modularity",
      "question": "Are concerns properly separated?"
    }
  ],
  "design_principles": [
    {
      "name": "kernel_userspace_boundary",
      "question": "Is cognitive policy leaking into infrastructure, or vice versa?"
    },
    {
      "name": "self_improving_agent",
      "question": "Could the agent have caught and fixed this itself? What's preventing it?"
    },
    {
      "name": "communication_boundary",
      "question": "Does act/plan stay away from comms tools? Communication flows through events."
    },
    {
      "name": "kv_tier_discipline",
      "question": "Are write permissions correct per tier?"
    },
    {
      "name": "prompt_framing_voice",
      "question": "Does it use the system's own voice — impressions, gaps, magnification?"
    },
    {
      "name": "life_process_quality",
      "question": "Do the rules allow complex behavior to emerge from simple foundations? Generative, not prescriptive?"
    }
  ],
  "evidence_thresholds": {
    "local": "moderate",
    "module": "strong",
    "system": "strong_plus_challenge"
  },
  "max_challenge_rounds": 2,
  "max_probe_sessions": 3,
  "stage_failure_limit": 3,
  "daily_cash_budget": 5.00
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/dev-loop/rubric.json
git commit -m "feat(dev-loop): add rubric config with quality lenses and thresholds"
```

---

### Task 4: OBSERVE Stage

**Files:**
- Create: `scripts/dev-loop/observe.mjs`
- Create: `tests/dev-loop/observe.test.js`

- [ ] **Step 1: Write failing tests**

```js
// tests/dev-loop/observe.test.js
import { describe, it, expect } from 'vitest';
import { detectCompletion, chooseStrategy } from '../../scripts/dev-loop/observe.mjs';

describe('observe', () => {
  describe('detectCompletion', () => {
    it('returns true when counter increments', () => {
      expect(detectCompletion(5, 6)).toBe(true);
    });

    it('returns false when counter unchanged', () => {
      expect(detectCompletion(5, 5)).toBe(false);
    });
  });

  describe('chooseStrategy', () => {
    it('defaults to accumulate', () => {
      const strategy = chooseStrategy({ probes: [], cycle: 3 });
      expect(strategy.type).toBe('accumulate');
    });

    it('chooses cold_start on cycle 0', () => {
      const strategy = chooseStrategy({ probes: [], cycle: 0 });
      expect(strategy.type).toBe('cold_start');
    });

    it('chooses cold_start when code was changed', () => {
      const strategy = chooseStrategy({ probes: [], cycle: 5, codeChanged: true });
      expect(strategy.type).toBe('cold_start');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dev-loop/observe.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement observe module**

```js
// scripts/dev-loop/observe.mjs
// Stage 1: OBSERVE — trigger session, wait for completion, collect data.

import { execSync } from 'child_process';
import { join } from 'path';
import { saveRun } from './state.mjs';

const ROOT = join(import.meta.dirname, '../..');

export function detectCompletion(beforeCount, afterCount) {
  return afterCount > beforeCount;
}

export function chooseStrategy({ probes, cycle, codeChanged }) {
  if (cycle === 0 || codeChanged) {
    return { type: 'cold_start', cmd: `bash ${ROOT}/scripts/start.sh --reset-all-state --trigger --yes` };
  }
  return { type: 'accumulate', cmd: `curl -s http://localhost:8787/__scheduled` };
}

function readKV(key) {
  try {
    const out = execSync(`node ${ROOT}/scripts/read-kv.mjs ${key}`, { encoding: 'utf-8', timeout: 10000 });
    try { return JSON.parse(out.trim()); }
    catch { return out.trim(); }
  } catch { return null; }
}

export async function runObserve({ baseDir, cycle, probes, codeChanged, timestamp }) {
  const strategy = chooseStrategy({ probes, cycle, codeChanged });

  // Capture pre-trigger session counter
  const beforeCount = readKV('session_counter') || 0;

  // Trigger
  console.log(`[OBSERVE] Strategy: ${strategy.type}`);
  try {
    execSync(strategy.cmd, { encoding: 'utf-8', timeout: 300000, stdio: 'pipe' });
  } catch (e) {
    // start.sh with --trigger may exit non-zero if services were already up
    console.log(`[OBSERVE] Trigger command output: ${e.stdout || e.message}`);
  }

  // Wait for completion (poll session_counter, timeout 5 min)
  const deadline = Date.now() + 300000;
  let afterCount = readKV('session_counter') || 0;
  while (!detectCompletion(beforeCount, afterCount) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));
    afterCount = readKV('session_counter') || 0;
  }

  if (!detectCompletion(beforeCount, afterCount)) {
    return { success: false, error: 'Session completion timeout' };
  }

  // Collect data
  const analysisRaw = execSync(
    `node ${ROOT}/scripts/analyze-sessions.mjs --last 1`,
    { encoding: 'utf-8', timeout: 30000 },
  );
  const analysis = JSON.parse(analysisRaw);

  // Get session IDs to check if an act session actually ran
  const sessionIds = readKV('cache:session_ids') || [];
  const latestSessionId = sessionIds[sessionIds.length - 1];

  const observation = {
    timestamp,
    strategy: strategy.type,
    session_counter_before: beforeCount,
    session_counter_after: afterCount,
    latest_session_id: latestSessionId,
    analysis,
  };

  saveRun(baseDir, timestamp, 'observation.json', observation);

  return { success: true, observation };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dev-loop/observe.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/dev-loop/observe.mjs tests/dev-loop/observe.test.js
git commit -m "feat(dev-loop): add observe stage — trigger sessions and collect data"
```

---

### Task 5: CLASSIFY Stage (Cognitive Audit + Issue Taxonomy)

**Files:**
- Create: `scripts/dev-loop/classify.mjs`
- Create: `tests/dev-loop/classify.test.js`

This is the most important stage — it runs the cognitive architecture
audit and creates/updates issues. The actual audit analysis is done
by Claude Code (the loop runner), so this module provides the
scaffolding: fingerprinting, dedup, issue creation, and helpers.

- [ ] **Step 1: Write failing tests**

```js
// tests/dev-loop/classify.test.js
import { describe, it, expect } from 'vitest';
import { fingerprint, createIssue, mergeEvidence,
  auditDesires, auditPatterns } from '../../scripts/dev-loop/classify.mjs';

describe('classify', () => {
  describe('fingerprint', () => {
    it('produces consistent hash for same input', () => {
      const a = fingerprint('userspace', 'Desire worded as avoidance');
      const b = fingerprint('userspace', 'Desire worded as avoidance');
      expect(a).toBe(b);
    });

    it('normalizes case and whitespace', () => {
      const a = fingerprint('userspace', 'Desire worded as avoidance');
      const b = fingerprint('userspace', 'desire  worded  as  avoidance');
      expect(a).toBe(b);
    });

    it('different locus produces different hash', () => {
      const a = fingerprint('userspace', 'test issue');
      const b = fingerprint('kernel', 'test issue');
      expect(a).not.toBe(b);
    });
  });

  describe('createIssue', () => {
    it('creates issue with all taxonomy fields', () => {
      const issue = createIssue({
        summary: 'Avoidance desire found',
        locus: 'userspace',
        severity: 'medium',
        selfRepairability: 0.7,
        blastRadius: 'local',
      });
      expect(issue.id).toBeTruthy();
      expect(issue.status).toBe('observed');
      expect(issue.evidence).toEqual([]);
      expect(issue.probe_budget.sessions_allowed).toBe(3);
      expect(issue.evidence_quality).toBe('weak');
      expect(issue.confidence).toBe(0.5);
    });
  });

  describe('mergeEvidence', () => {
    it('appends evidence to existing issue', () => {
      const issue = createIssue({ summary: 'test', locus: 'ui' });
      const updated = mergeEvidence(issue, {
        observation: 'Seen again in session 5',
        session_id: 's_005',
      });
      expect(updated.evidence).toHaveLength(1);
      expect(updated.probe_budget.sessions_used).toBe(0); // not a probe session
    });
  });

  describe('auditDesires', () => {
    it('flags avoidance desires', () => {
      const desires = {
        'desire:avoid_bugs': {
          slug: 'avoid_bugs',
          direction: 'approach',
          description: 'Avoid introducing bugs into the codebase',
        },
      };
      const issues = auditDesires(desires);
      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0].summary).toContain('avoidance');
    });

    it('passes well-formed desires', () => {
      const desires = {
        'desire:clean_code': {
          slug: 'clean_code',
          direction: 'approach',
          description: 'My code is clean, readable, and well-structured',
          source_principles: ['niyama:health'],
        },
      };
      const issues = auditDesires(desires);
      expect(issues).toHaveLength(0);
    });

    it('flags desires missing source_principles', () => {
      const desires = {
        'desire:orphan': {
          slug: 'orphan',
          direction: 'approach',
          description: 'My tools are effective',
        },
      };
      const issues = auditDesires(desires);
      expect(issues.some(i => i.summary.includes('source_principles'))).toBe(true);
    });
  });

  describe('auditPatterns', () => {
    it('flags patterns with strength stuck at 0 or 1', () => {
      const patterns = {
        'pattern:always_true': { pattern: 'Everything works', strength: 1.0 },
      };
      const issues = auditPatterns(patterns);
      expect(issues.some(i => i.summary.includes('strength'))).toBe(true);
    });

    it('passes healthy patterns', () => {
      const patterns = {
        'pattern:api_timeout': { pattern: 'APIs timeout under load', strength: 0.72 },
      };
      const issues = auditPatterns(patterns);
      expect(issues).toHaveLength(0);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dev-loop/classify.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement classify module**

```js
// scripts/dev-loop/classify.mjs
// Stage 2: CLASSIFY — cognitive audit, issue taxonomy, fingerprinting.

import { createHash } from 'crypto';
import { listProbes, saveProbe, saveRun } from './state.mjs';

// ── Fingerprinting ────────────────────────────────────────

function normalize(text) {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function fingerprint(locus, summary) {
  const input = `${locus}:${normalize(summary)}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

// ── Issue creation ────────────────────────────────────────

export function createIssue({
  summary, locus, severity = 'medium', selfRepairability = 0.5,
  blastRadius = 'local', evidenceQuality = 'weak', confidence = 0.5,
}) {
  return {
    id: fingerprint(locus, summary),
    summary,
    locus,
    severity,
    self_repairability: selfRepairability,
    blast_radius: blastRadius,
    evidence_quality: evidenceQuality,
    reproducibility: 'unknown',
    confidence,
    evidence: [],
    status: 'observed',
    probe_budget: { sessions_allowed: 3, sessions_used: 0 },
    root_cause_chain: [],
    created_at: new Date().toISOString(),
  };
}

export function mergeEvidence(issue, newEvidence) {
  return {
    ...issue,
    evidence: [...issue.evidence, { ...newEvidence, timestamp: new Date().toISOString() }],
    updated_at: new Date().toISOString(),
  };
}

// ── Cognitive entity audits ───────────────────────────────

const AVOIDANCE_WORDS = ['avoid', 'stop', 'prevent', 'don\'t', 'never', 'reduce', 'eliminate'];

export function auditDesires(desires) {
  const issues = [];
  for (const [key, desire] of Object.entries(desires)) {
    const desc = (desire.description || '').toLowerCase();

    // Check for avoidance framing
    if (AVOIDANCE_WORDS.some(w => desc.startsWith(w) || desc.includes(` ${w} `))) {
      issues.push(createIssue({
        summary: `Desire "${desire.slug}" uses avoidance framing: "${desire.description}"`,
        locus: 'userspace',
        severity: 'medium',
        selfRepairability: 0.8, // DR should fix this
        blastRadius: 'local',
      }));
    }

    // Check for missing source_principles
    if (!desire.source_principles || desire.source_principles.length === 0) {
      issues.push(createIssue({
        summary: `Desire "${desire.slug}" missing source_principles`,
        locus: 'userspace',
        severity: 'low',
        selfRepairability: 0.6,
        blastRadius: 'local',
      }));
    }

    // Check for vague descriptions
    if (desc.length < 15) {
      issues.push(createIssue({
        summary: `Desire "${desire.slug}" description too vague: "${desire.description}"`,
        locus: 'userspace',
        severity: 'low',
        selfRepairability: 0.7,
        blastRadius: 'local',
      }));
    }
  }
  return issues;
}

export function auditPatterns(patterns) {
  const issues = [];
  for (const [key, pattern] of Object.entries(patterns)) {
    // Strength stuck at extremes
    if (pattern.strength === 1.0 || pattern.strength === 0) {
      issues.push(createIssue({
        summary: `Pattern "${key}" has strength stuck at ${pattern.strength} — not learning`,
        locus: 'eval',
        severity: 'medium',
        selfRepairability: 0.3,
        blastRadius: 'local',
      }));
    }

    // Very low strength that should have been deleted
    if (pattern.strength > 0 && pattern.strength < 0.05) {
      issues.push(createIssue({
        summary: `Pattern "${key}" has strength ${pattern.strength} — should be deleted (threshold 0.05)`,
        locus: 'eval',
        severity: 'low',
        selfRepairability: 0.9,
        blastRadius: 'local',
      }));
    }
  }
  return issues;
}

export function auditExperiences(experiences) {
  const issues = [];
  const expList = Object.values(experiences);

  // Check for low-signal noise
  const lowSalience = expList.filter(e => e.salience !== undefined && e.salience < 0.1);
  if (lowSalience.length > expList.length * 0.3 && expList.length > 3) {
    issues.push(createIssue({
      summary: `${lowSalience.length}/${expList.length} experiences have very low salience — threshold may be too permissive`,
      locus: 'eval',
      severity: 'medium',
      selfRepairability: 0.2,
      blastRadius: 'module',
    }));
  }

  // Check for missing embeddings
  const noEmbed = expList.filter(e => !e.embedding);
  if (noEmbed.length > 0) {
    issues.push(createIssue({
      summary: `${noEmbed.length} experiences missing embeddings — inference service may be down`,
      locus: 'eval',
      severity: 'high',
      selfRepairability: 0.1,
      blastRadius: 'module',
    }));
  }

  // Check for vague narratives
  const vague = expList.filter(e => (e.narrative || '').length < 30);
  if (vague.length > 0) {
    issues.push(createIssue({
      summary: `${vague.length} experiences have vague/missing narratives`,
      locus: 'userspace',
      severity: 'medium',
      selfRepairability: 0.5,
      blastRadius: 'local',
    }));
  }

  return issues;
}

export function auditKarma(karma) {
  const issues = [];
  for (const [key, events] of Object.entries(karma)) {
    if (!Array.isArray(events)) continue;

    const parseErrors = events.filter(e => e.event === 'reflect_parse_error');
    if (parseErrors.length > 0) {
      issues.push(createIssue({
        summary: `Session ${key} had ${parseErrors.length} reflect parse error(s)`,
        locus: 'userspace',
        severity: 'high',
        selfRepairability: 0.2,
        blastRadius: 'module',
        evidenceQuality: 'strong',
      }));
    }

    const budgetExceeded = events.filter(e => e.event === 'budget_exceeded');
    if (budgetExceeded.length > 0) {
      issues.push(createIssue({
        summary: `Session ${key} exceeded budget in steps: ${budgetExceeded.map(e => e.step).join(', ')}`,
        locus: 'userspace',
        severity: 'medium',
        selfRepairability: 0.4,
        blastRadius: 'local',
        evidenceQuality: 'strong',
      }));
    }

    const toolFailures = events.filter(e => e.event === 'tool_complete' && e.ok === false);
    if (toolFailures.length > 2) {
      issues.push(createIssue({
        summary: `Session ${key} had ${toolFailures.length} tool failures`,
        locus: 'tools',
        severity: 'medium',
        selfRepairability: 0.3,
        blastRadius: 'local',
        evidenceQuality: 'strong',
      }));
    }
  }
  return issues;
}

// ── Dedup + merge ─────────────────────────────────────────

export function dedup(newIssues, existingProbes) {
  const existingById = Object.fromEntries(existingProbes.map(p => [p.id, p]));
  const dedupedNew = [];
  const updated = [];

  for (const issue of newIssues) {
    const existing = existingById[issue.id];
    if (existing) {
      // Merge evidence into existing probe
      updated.push(mergeEvidence(existing, {
        observation: issue.summary,
        source: 'classify',
      }));
    } else {
      dedupedNew.push(issue);
    }
  }

  return { newIssues: dedupedNew, updatedProbes: updated };
}

// ── Main classify entry point ─────────────────────────────

export async function runClassify({ baseDir, observation, timestamp }) {
  const { analysis } = observation;
  const existingProbes = listProbes(baseDir);

  // Run all audits
  const allIssues = [
    ...auditDesires(analysis.desires || {}),
    ...auditPatterns(analysis.patterns || {}),
    ...auditExperiences(analysis.experiences || {}),
    ...auditKarma(analysis.karma || {}),
  ];

  // Dedup against existing probes
  const { newIssues, updatedProbes } = dedup(allIssues, existingProbes);

  // Save new probes
  for (const issue of newIssues) {
    saveProbe(baseDir, issue);
  }
  // Save updated probes
  for (const probe of updatedProbes) {
    saveProbe(baseDir, probe);
  }

  const classification = {
    timestamp,
    total_issues_found: allIssues.length,
    new_issues: newIssues.length,
    updated_probes: updatedProbes.length,
    issues: allIssues.map(i => ({ id: i.id, summary: i.summary, locus: i.locus, severity: i.severity })),
  };

  saveRun(baseDir, timestamp, 'classification.json', classification);

  return { classification, newIssues, updatedProbes };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dev-loop/classify.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/dev-loop/classify.mjs tests/dev-loop/classify.test.js
git commit -m "feat(dev-loop): add classify stage — cognitive audit, issue taxonomy, dedup"
```

---

### Task 6: DECIDE Stage

**Files:**
- Create: `scripts/dev-loop/decide.mjs`
- Create: `tests/dev-loop/decide.test.js`

The DECIDE stage routes proposals based on evidence thresholds and
blast radius. EXPERIMENT (stage 3) and the adversarial challenge are
orchestrated by Claude Code at runtime — they're not scripts, they're
CC reasoning. DECIDE provides the routing logic.

- [ ] **Step 1: Write failing tests**

```js
// tests/dev-loop/decide.test.js
import { describe, it, expect } from 'vitest';
import { routeProposal, shouldAutoApply } from '../../scripts/dev-loop/decide.mjs';

describe('decide', () => {
  describe('routeProposal', () => {
    it('auto-applies local + moderate evidence', () => {
      const result = routeProposal({
        blast_radius: 'local',
        evidence_quality: 'moderate',
      });
      expect(result.action).toBe('auto_apply');
    });

    it('requires approval for system blast radius', () => {
      const result = routeProposal({
        blast_radius: 'system',
        evidence_quality: 'strong',
      });
      expect(result.action).toBe('escalate');
    });

    it('notes module-level changes', () => {
      const result = routeProposal({
        blast_radius: 'module',
        evidence_quality: 'strong',
      });
      expect(result.action).toBe('apply_and_note');
    });

    it('rejects weak evidence for any blast radius', () => {
      const result = routeProposal({
        blast_radius: 'local',
        evidence_quality: 'weak',
      });
      expect(result.action).toBe('defer');
    });
  });

  describe('shouldAutoApply', () => {
    it('returns true for local + moderate+', () => {
      expect(shouldAutoApply('local', 'moderate')).toBe(true);
      expect(shouldAutoApply('local', 'strong')).toBe(true);
    });

    it('returns false for system', () => {
      expect(shouldAutoApply('system', 'strong')).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dev-loop/decide.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement decide module**

```js
// scripts/dev-loop/decide.mjs
// Stage 4: DECIDE — route proposals by evidence threshold and blast radius.

const EVIDENCE_RANK = { weak: 0, moderate: 1, strong: 2 };

const THRESHOLD = {
  local: 'moderate',     // moderate+ → auto-apply
  module: 'strong',      // strong → apply + note
  system: 'strong_plus', // strong + converged challenge → escalate
};

export function shouldAutoApply(blastRadius, evidenceQuality) {
  if (blastRadius === 'system') return false;
  const required = THRESHOLD[blastRadius] || 'strong';
  return EVIDENCE_RANK[evidenceQuality] >= EVIDENCE_RANK[required];
}

export function routeProposal({ blast_radius, evidence_quality, challenge_converged }) {
  const evidenceRank = EVIDENCE_RANK[evidence_quality] ?? 0;

  if (evidenceRank === 0) {
    return { action: 'defer', reason: 'Evidence too weak to act on' };
  }

  if (blast_radius === 'system') {
    return { action: 'escalate', reason: 'System-level change requires approval' };
  }

  if (blast_radius === 'module') {
    if (evidenceRank >= EVIDENCE_RANK.strong) {
      return { action: 'apply_and_note', reason: 'Module-level change with strong evidence' };
    }
    return { action: 'defer', reason: 'Module-level change needs stronger evidence' };
  }

  // local
  if (evidenceRank >= EVIDENCE_RANK.moderate) {
    return { action: 'auto_apply', reason: 'Local change with sufficient evidence' };
  }

  return { action: 'defer', reason: 'Insufficient evidence' };
}

export function generateApprovalId(timestamp, seq) {
  return `devloop-${timestamp.replace(/[:.]/g, '')}-${String(seq).padStart(2, '0')}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dev-loop/decide.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/dev-loop/decide.mjs tests/dev-loop/decide.test.js
git commit -m "feat(dev-loop): add decide stage — evidence-based routing logic"
```

---

### Task 7: VERIFY Stage

**Files:**
- Create: `scripts/dev-loop/verify.mjs`

- [ ] **Step 1: Implement verify module**

```js
// scripts/dev-loop/verify.mjs
// Stage 5: VERIFY — run tests, targeted repro, rollback on regression.

import { execSync } from 'child_process';
import { join } from 'path';
import { saveRun } from './state.mjs';

const ROOT = join(import.meta.dirname, '../..');

export function runTests() {
  try {
    const output = execSync('npm test', {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 120000,
      stdio: 'pipe',
    });
    return { passed: true, output };
  } catch (e) {
    return { passed: false, output: e.stdout || e.message };
  }
}

export function rollbackLastCommit() {
  try {
    execSync('git revert HEAD --no-edit', {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 30000,
    });
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export async function runVerify({ baseDir, timestamp, appliedFixes }) {
  const results = [];

  // Run tests first
  const testResult = runTests();
  if (!testResult.passed) {
    // Tests failed — rollback all applied fixes
    for (const fix of (appliedFixes || []).reverse()) {
      const rollback = rollbackLastCommit();
      results.push({
        fix_id: fix.id,
        verified: false,
        action: 'rolled_back',
        rollback_success: rollback.success,
      });
    }
    saveRun(baseDir, timestamp, 'verification.json', {
      timestamp,
      tests_passed: false,
      test_output: testResult.output.slice(-2000), // truncate
      results,
    });
    return { success: false, results };
  }

  // Tests passed — mark all as verified
  for (const fix of (appliedFixes || [])) {
    results.push({ fix_id: fix.id, verified: true });
  }

  saveRun(baseDir, timestamp, 'verification.json', {
    timestamp,
    tests_passed: true,
    results,
  });

  return { success: true, results };
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/dev-loop/verify.mjs
git commit -m "feat(dev-loop): add verify stage — tests, rollback on regression"
```

---

### Task 8: Orchestrator (Main Loop)

**Files:**
- Create: `scripts/dev-loop/loop.mjs`

- [ ] **Step 1: Implement orchestrator**

```js
#!/usr/bin/env node
// scripts/dev-loop/loop.mjs
// Autonomous dev loop orchestrator.
// Runs: observe → classify → experiment → decide → verify in a loop.
//
// Usage: node scripts/dev-loop/loop.mjs [--once] [--cold-start]
//
// EXPERIMENT and PROPOSE stages are handled by the Claude Code session
// running this script — the loop surfaces data, CC reasons about it.

import { initState, loadState, saveState, listProbes, loadQueue } from './state.mjs';
import { runObserve } from './observe.mjs';
import { runClassify } from './classify.mjs';
import { runVerify } from './verify.mjs';
import { checkSlackReplies, checkEmailReplies, parseReply } from './comms.mjs';
import { readFileSync } from 'fs';
import { join } from 'path';

const STATE_DIR = join(import.meta.dirname, '../../.swayambhu/dev-loop');
const rubric = JSON.parse(readFileSync(join(import.meta.dirname, 'rubric.json'), 'utf-8'));

const args = process.argv.slice(2);
const ONCE = args.includes('--once');
const COLD_START = args.includes('--cold-start');

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

  // Dedup against processed IDs
  const processed = new Set(state.processed_reply_ids || []);
  const newReplies = replies.filter(r => !processed.has(r.id));

  return newReplies;
}

function isBudgetExhausted(state) {
  // Reset budget at midnight UTC
  const today = new Date().toISOString().slice(0, 10);
  if (state.budget_reset_date !== today) {
    state.cash_budget_spent_today = 0;
    state.budget_reset_date = today;
  }
  return state.cash_budget_spent_today >= rubric.daily_cash_budget;
}

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

async function runCycle(state) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  state.cycle += 1;
  state.phase = 'observe';
  state.heartbeat = new Date().toISOString();
  saveState(STATE_DIR, state);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[LOOP] Cycle ${state.cycle} — ${timestamp}`);
  console.log(`${'='.repeat(60)}`);

  // ── OBSERVE ──
  let observation;
  if (!isStageDisabled(state, 'observe')) {
    try {
      const result = await runObserve({
        baseDir: STATE_DIR,
        cycle: state.cycle,
        probes: listProbes(STATE_DIR),
        codeChanged: COLD_START && state.cycle === 1,
        timestamp,
      });
      if (!result.success) {
        console.log(`[OBSERVE] Failed: ${result.error}`);
        recordStageFailure(state, 'observe');
        return { stop: false };
      }
      observation = result.observation;
      clearStageFailure(state, 'observe');
    } catch (e) {
      console.error(`[OBSERVE] Error: ${e.message}`);
      recordStageFailure(state, 'observe');
      return { stop: false };
    }
  }

  // ── CLASSIFY ──
  state.phase = 'classify';
  saveState(STATE_DIR, state);

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
  // When running standalone (not under CC), we just output the
  // classification and probes for manual review.

  state.phase = 'experiment';
  saveState(STATE_DIR, state);

  console.log(`[LOOP] Active probes: ${listProbes(STATE_DIR).length}`);
  console.log(`[LOOP] Pending approvals: ${loadQueue(STATE_DIR, 'pending').length}`);

  // ── Generate report ──
  const report = [
    `# Dev Loop Report — Cycle ${state.cycle}`,
    `**Time:** ${timestamp}`,
    `**Budget spent today:** $${state.cash_budget_spent_today.toFixed(2)} / $${rubric.daily_cash_budget}`,
    '',
    classification ? `## Issues Found: ${classification.total_issues_found}` : '## No observation this cycle',
    '',
    ...(classification?.issues || []).map(i =>
      `- [${i.severity}] ${i.locus}: ${i.summary}`
    ),
    '',
    `## Active Probes: ${listProbes(STATE_DIR).length}`,
    `## Pending Approvals: ${loadQueue(STATE_DIR, 'pending').length}`,
  ].join('\n');

  const { saveRun } = await import('./state.mjs');
  saveRun(STATE_DIR, timestamp, 'report.md', report);

  // ── Stop conditions ──
  const probes = listProbes(STATE_DIR);
  const pending = loadQueue(STATE_DIR, 'pending');
  const activeProbes = probes.filter(p => !['closed', 'verified', 'quarantined'].includes(p.status));

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
  saveState(STATE_DIR, state);
  return { stop: false };
}

// ── Main ──────────────────────────────────────────────────

async function main() {
  initState(STATE_DIR);
  let state = loadState(STATE_DIR);

  console.log('[LOOP] Autonomous Dev Loop started');
  console.log(`[LOOP] Budget: $${rubric.daily_cash_budget}/day`);

  // Check approvals on startup
  const approvals = await checkApprovals(state);
  if (approvals.length > 0) {
    console.log(`[LOOP] Found ${approvals.length} approval replies`);
    for (const reply of approvals) {
      console.log(`  ${reply.action}: ${reply.id} ${reply.reason || ''}`);
      state.processed_reply_ids.push(reply.id);
    }
    saveState(STATE_DIR, state);
  }

  while (true) {
    if (isBudgetExhausted(state)) {
      console.log('[LOOP] Daily budget exhausted. Stopping.');
      break;
    }

    const result = await runCycle(state);
    state = loadState(STATE_DIR); // reload in case stages updated it

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
```

- [ ] **Step 2: Commit**

```bash
git add scripts/dev-loop/loop.mjs
git commit -m "feat(dev-loop): add orchestrator — main loop with budget, stages, stop conditions"
```

---

### Task 9: Integration Test

**Files:**
- Create: `tests/dev-loop/integration.test.js`

A dry-run integration test that exercises the full pipeline with
mock data (no real sessions or network calls).

- [ ] **Step 1: Write integration test**

```js
// tests/dev-loop/integration.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { initState, loadState, saveState, listProbes, saveRun } from '../../scripts/dev-loop/state.mjs';
import { runClassify } from '../../scripts/dev-loop/classify.mjs';
import { routeProposal, generateApprovalId } from '../../scripts/dev-loop/decide.mjs';
import { runTests } from '../../scripts/dev-loop/verify.mjs';

const TEST_DIR = join(import.meta.dirname, '../../.swayambhu/dev-loop-integration-test');

describe('dev-loop integration', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    initState(TEST_DIR);
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('classify → decide pipeline with mock observation', async () => {
    const timestamp = '2026-04-04T12-00-00Z';
    const observation = {
      timestamp,
      strategy: 'accumulate',
      session_counter_before: 5,
      session_counter_after: 6,
      latest_session_id: 's_test_001',
      analysis: {
        desires: {
          'desire:avoid_errors': {
            slug: 'avoid_errors',
            direction: 'approach',
            description: 'Avoid making errors in my code',
          },
        },
        patterns: {
          'pattern:always_works': {
            pattern: 'Everything always works perfectly',
            strength: 1.0,
          },
        },
        experiences: {},
        karma: {},
      },
    };

    // CLASSIFY
    const { classification, newIssues } = await runClassify({
      baseDir: TEST_DIR,
      observation,
      timestamp,
    });

    expect(classification.total_issues_found).toBeGreaterThan(0);
    expect(newIssues.some(i => i.summary.includes('avoidance'))).toBe(true);
    expect(newIssues.some(i => i.summary.includes('strength'))).toBe(true);

    // Probes should be saved
    const probes = listProbes(TEST_DIR);
    expect(probes.length).toBe(newIssues.length);

    // DECIDE — route each issue
    for (const issue of newIssues) {
      const route = routeProposal({
        blast_radius: issue.blast_radius,
        evidence_quality: issue.evidence_quality,
      });
      // All new issues start with 'weak' evidence → defer
      expect(route.action).toBe('defer');
    }

    // Classification file should exist
    const classFile = join(TEST_DIR, 'runs', timestamp, 'classification.json');
    expect(existsSync(classFile)).toBe(true);
  });

  it('dedup prevents duplicate issues', async () => {
    const timestamp1 = '2026-04-04T12-00-00Z';
    const timestamp2 = '2026-04-04T13-00-00Z';
    const obs = {
      timestamp: timestamp1,
      strategy: 'accumulate',
      analysis: {
        desires: {
          'desire:avoid_errors': {
            slug: 'avoid_errors',
            direction: 'approach',
            description: 'Avoid making errors',
          },
        },
        patterns: {}, experiences: {}, karma: {},
      },
    };

    // First classify
    await runClassify({ baseDir: TEST_DIR, observation: obs, timestamp: timestamp1 });
    const probes1 = listProbes(TEST_DIR);

    // Second classify with same data
    obs.timestamp = timestamp2;
    await runClassify({ baseDir: TEST_DIR, observation: obs, timestamp: timestamp2 });
    const probes2 = listProbes(TEST_DIR);

    // Should not create duplicate probes
    expect(probes2.length).toBe(probes1.length);
    // But evidence should be appended
    const probe = probes2.find(p => p.summary.includes('avoidance'));
    expect(probe.evidence.length).toBeGreaterThan(0);
  });

  it('approval ID generation is deterministic', () => {
    const id = generateApprovalId('2026-04-04T120000Z', 1);
    expect(id).toBe('devloop-2026-04-04T120000Z-01');
  });

  it('unit tests pass (verify stage sanity check)', () => {
    const result = runTests();
    expect(result.passed).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run tests/dev-loop/integration.test.js`
Expected: PASS

- [ ] **Step 3: Run full test suite to verify no regressions**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add tests/dev-loop/integration.test.js
git commit -m "test(dev-loop): add integration test for classify → decide pipeline"
```

---

### Task 10: Manual Smoke Test

- [ ] **Step 1: Source env and run a single cycle**

```bash
source .env
node scripts/dev-loop/loop.mjs --once
```

Expected: the loop initializes `.swayambhu/dev-loop/`, triggers a session,
runs classify, outputs issues found, writes a report to `runs/`.

- [ ] **Step 2: Inspect output**

```bash
ls .swayambhu/dev-loop/
ls .swayambhu/dev-loop/runs/
cat .swayambhu/dev-loop/runs/*/report.md
ls .swayambhu/dev-loop/probes/
```

Verify: directory structure created, report generated, probes created
for any issues found.

- [ ] **Step 3: Commit any adjustments from smoke test**

```bash
git add -A scripts/dev-loop/ tests/dev-loop/
git commit -m "fix(dev-loop): adjustments from smoke test"
```

---

## Summary

| Task | Module | What it does |
|------|--------|-------------|
| 1 | state.mjs | File-based state: probes, queue, runs, metrics |
| 2 | comms.mjs | Slack/email approval send + reply checking |
| 3 | rubric.json | Quality lenses, thresholds, config |
| 4 | observe.mjs | Trigger sessions, detect completion, collect data |
| 5 | classify.mjs | Cognitive audit, issue taxonomy, fingerprinting |
| 6 | decide.mjs | Evidence-based routing (auto/note/escalate/defer) |
| 7 | verify.mjs | Run tests, rollback on regression |
| 8 | loop.mjs | Orchestrator: budget, stage failures, stop conditions |
| 9 | integration test | End-to-end with mock data |
| 10 | smoke test | Real session, real KV, manual verification |

**After this plan:** The EXPERIMENT stage (probing self-correction,
adversarial challenge with Codex) is orchestrated by the Claude Code
session running the loop — it reads classify output, reasons about
probes, invokes Codex for challenge, and calls decide/verify. That
reasoning happens in CC, not in a script. The scripts provide the
scaffolding; CC provides the intelligence.
