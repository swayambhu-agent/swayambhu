# Job Shell Script Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two bugs causing deep-reflect job failures: broken `&&` join contaminating `sh -c` payload, and missing PATH on compute target.

**Architecture:** Separate inner script (job payload) from outer script (setup commands). Base64-encode inner script so it never passes through outer shell's parser. Add `path_dirs` config for compute target PATH.

**Tech Stack:** Node.js, POSIX shell, vitest

**Spec:** `docs/superpowers/specs/2026-04-02-job-shell-fix-design.md`

---

### Task 1: Add `path_dirs` to config/defaults.json

**Files:**
- Modify: `config/defaults.json:72-79`

- [ ] **Step 1: Add path_dirs field**

In `config/defaults.json`, add `"path_dirs"` to the `jobs` object:

```json
  "jobs": {
    "base_url": "https://akash.swayambhu.dev",
    "base_dir": "/home/swayambhu/jobs",
    "cc_model": "opus",
    "path_dirs": ["/home/swayambhu/.local/bin"],
    "default_ttl_minutes": 120,
    "max_concurrent_jobs": 2,
    "callback_advance_seconds": 30
  },
```

- [ ] **Step 2: Commit**

```bash
git add config/defaults.json
git commit -m "config: add path_dirs to jobs for compute target PATH"
```

---

### Task 2: Write failing tests for start_job shell generation

**Files:**
- Modify: `tests/tools.test.js:1531-1597`

- [ ] **Step 1: Add test — cc_analysis inner script has no `&&` contamination**

Add after the existing `start_job` tests (after line 1597):

```js
  it("generates valid inner script for cc_analysis (no && contamination)", async () => {
    const provider = {
      call: vi.fn(async ({ command }) => {
        // The nohup wrapper should use base64-encoded inner script
        // Inner script must NOT contain && from the join
        expect(command).toContain("base64 -d | sh");
        // Should not have 'sh -c' with && contamination
        expect(command).not.toMatch(/sh -c '[^']*&&/);
        return { ok: true, output: [{ data: "12345\r\n" }] };
      }),
    };
    const kv = mockKV();

    const result = await start_job.execute({
      type: "cc_analysis",
      prompt: "test prompt",
      context_keys: [],
      provider, secrets, fetch: vi.fn(), kv,
      config: { jobs: { ...config.jobs, cc_model: "opus", path_dirs: ["/home/swayambhu/.local/bin"] } },
    });

    expect(result.ok).toBe(true);
  });
```

- [ ] **Step 2: Add test — path_dirs appears in inner script**

```js
  it("injects path_dirs into inner script", async () => {
    let capturedCommand;
    const provider = {
      call: vi.fn(async ({ command }) => {
        capturedCommand = command;
        return { ok: true, output: [{ data: "12345\r\n" }] };
      }),
    };
    const kv = mockKV();

    await start_job.execute({
      type: "cc_analysis",
      prompt: "test",
      context_keys: [],
      provider, secrets, fetch: vi.fn(), kv,
      config: { jobs: { ...config.jobs, path_dirs: ["/opt/bin", "/usr/local/custom"] } },
    });

    // Decode the base64 inner script from the captured command
    const b64Match = capturedCommand.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d \| sh/);
    expect(b64Match).toBeTruthy();
    const innerScript = Buffer.from(b64Match[1], 'base64').toString('utf8');
    expect(innerScript).toContain("export PATH=/opt/bin:/usr/local/custom${PATH:+:$PATH}");
  });
```

- [ ] **Step 3: Add test — cc_model with quotes is escaped**

```js
  it("escapes cc_model with quotes in inner script", async () => {
    let capturedCommand;
    const provider = {
      call: vi.fn(async ({ command }) => {
        capturedCommand = command;
        return { ok: true, output: [{ data: "12345\r\n" }] };
      }),
    };
    const kv = mockKV();

    await start_job.execute({
      type: "cc_analysis",
      prompt: "test",
      context_keys: [],
      provider, secrets, fetch: vi.fn(), kv,
      config: { jobs: { ...config.jobs, cc_model: "model'injection" } },
    });

    const b64Match = capturedCommand.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d \| sh/);
    const innerScript = Buffer.from(b64Match[1], 'base64').toString('utf8');
    // Model name should be escaped, not executable
    expect(innerScript).toContain("--model 'model'\\''injection'");
    expect(innerScript).not.toContain("--model model'injection");
  });
```

- [ ] **Step 4: Add test — path_dirs validates entries**

```js
  it("filters invalid path_dirs entries", async () => {
    let capturedCommand;
    const provider = {
      call: vi.fn(async ({ command }) => {
        capturedCommand = command;
        return { ok: true, output: [{ data: "12345\r\n" }] };
      }),
    };
    const kv = mockKV();

    await start_job.execute({
      type: "cc_analysis",
      prompt: "test",
      context_keys: [],
      provider, secrets, fetch: vi.fn(), kv,
      config: { jobs: { ...config.jobs, path_dirs: ["/valid/path", "not-absolute", "/inject;rm -rf /", 42, "/ok"] } },
    });

    const b64Match = capturedCommand.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d \| sh/);
    const innerScript = Buffer.from(b64Match[1], 'base64').toString('utf8');
    expect(innerScript).toContain("export PATH=/valid/path:/ok${PATH:+:$PATH}");
    // Dangerous entries must not appear
    expect(innerScript).not.toContain("not-absolute");
    expect(innerScript).not.toContain("inject");
  });
```

- [ ] **Step 5: Add test — custom job wraps command in subshell**

```js
  it("wraps custom command in subshell with absolute exit_code path", async () => {
    let capturedCommand;
    const provider = {
      call: vi.fn(async ({ command }) => {
        capturedCommand = command;
        return { ok: true, output: [{ data: "12345\r\n" }] };
      }),
    };
    const kv = mockKV();

    await start_job.execute({
      type: "custom",
      command: "python3 analyze.py",
      context_keys: [],
      provider, secrets, fetch: vi.fn(), kv, config,
    });

    const b64Match = capturedCommand.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d \| sh/);
    const innerScript = Buffer.from(b64Match[1], 'base64').toString('utf8');
    // Custom command should be in a subshell
    expect(innerScript).toContain("(python3 analyze.py)");
    // exit_code path should be absolute
    expect(innerScript).toMatch(/echo \$\? > '\/tmp\/jobs\/[^']+\/exit_code'/);
  });
```

- [ ] **Step 6: Add test — non-array path_dirs is handled gracefully**

```js
  it("handles non-array path_dirs gracefully", async () => {
    let capturedCommand;
    const provider = {
      call: vi.fn(async ({ command }) => {
        capturedCommand = command;
        return { ok: true, output: [{ data: "12345\r\n" }] };
      }),
    };
    const kv = mockKV();

    await start_job.execute({
      type: "cc_analysis",
      prompt: "test",
      context_keys: [],
      provider, secrets, fetch: vi.fn(), kv,
      config: { jobs: { ...config.jobs, path_dirs: "/not/an/array" } },
    });

    const b64Match = capturedCommand.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d \| sh/);
    const innerScript = Buffer.from(b64Match[1], 'base64').toString('utf8');
    expect(innerScript).not.toContain("export PATH");
  });
```

- [ ] **Step 7: Run tests to verify they fail**

```bash
npm test -- tests/tools.test.js -t "start_job"
```

Expected: all 6 new tests FAIL (current code doesn't use base64 encoding).

- [ ] **Step 8: Commit failing tests**

```bash
git add tests/tools.test.js
git commit -m "test: add failing tests for start_job shell generation fix"
```

---

### Task 3: Rewrite start_job.js shell generation

**Files:**
- Modify: `tools/start_job.js:83-105`

- [ ] **Step 1: Replace shell generation code**

Replace lines 83-105 of `tools/start_job.js` with:

```js
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
    jobCommand = `claude -p "$(cat prompt.txt)" --output-format json${modelFlag}`;
  } else {
    jobCommand = command;
  }

  // Build the workdir path
  const workdir = `${baseDir}/${jobId}`;

  // Build inner script (plain shell text — will be base64-encoded)
  const innerLines = [
    pathDirs.length ? `export PATH=${pathDirs.join(':')}` + '${PATH:+:$PATH}' : null,
    `cd '${esc(workdir)}' || { echo 1 > '${esc(workdir)}/exit_code'; exit 1; }`,
    type === "custom"
      ? `(${jobCommand}) > output.json 2>stderr.log; echo $? > '${esc(workdir)}/exit_code'`
      : `${jobCommand} > output.json 2>stderr.log; echo $? > exit_code`,
  ].filter(Boolean);

  const innerScript = innerLines.join('\n');
  const innerB64 = Buffer.from(innerScript, 'utf8').toString('base64');

  // Build outer script (setup + nohup with base64-encoded inner script)
  const shellScript = [
    `mkdir -p '${esc(workdir)}'`,
    `printf '%s' '${base64Tar}' | base64 -d | tar xz -C '${esc(workdir)}'`,
    `nohup sh -c "printf '%s' '${innerB64}' | base64 -d | sh" > /dev/null 2>&1 & echo $!`,
  ].join(' && \\\n');
```

- [ ] **Step 2: Run start_job tests**

```bash
npm test -- tests/tools.test.js -t "start_job"
```

Expected: all tests PASS (both old and new).

- [ ] **Step 3: Commit**

```bash
git add tools/start_job.js
git commit -m "fix: rewrite start_job shell generation with base64-encoded inner script"
```

---

### Task 4: Write failing tests for collect_jobs quoting

**Files:**
- Modify: `tests/tools.test.js:1599-1670`

- [ ] **Step 1: Add test — collect_jobs quotes workdir in commands**

Add after the existing `collect_jobs` tests (after line 1670):

```js
  it("quotes workdir in polling commands", async () => {
    const kv = mockKV({
      "job:j1": JSON.stringify({
        id: "j1", type: "custom", status: "running",
        created_at: new Date().toISOString(),
        workdir: "/tmp/jobs/o'reilly", config: { ttl_minutes: 120 },
      }),
    });
    const commands = [];
    const provider = {
      call: vi.fn(async ({ command }) => {
        commands.push(command);
        if (command.includes("exit_code")) return { ok: true, output: [{ data: "0\r\n" }] };
        if (command.includes("output.json")) return { ok: true, output: [{ data: '{"result":"ok"}\r\n' }] };
        return { ok: true, output: [] };
      }),
    };

    await collect_jobs.execute({ provider, secrets, fetch: vi.fn(), kv, config });

    // Workdir should be quoted in both commands
    const exitCmd = commands.find(c => c.includes("exit_code"));
    const outputCmd = commands.find(c => c.includes("output.json"));
    expect(exitCmd).toContain("'/tmp/jobs/o'\\''reilly/exit_code'");
    expect(outputCmd).toContain("'/tmp/jobs/o'\\''reilly/output.json'");
  });
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/tools.test.js -t "collect_jobs"
```

Expected: new test FAILS (current code uses unquoted workdir).

- [ ] **Step 3: Commit**

```bash
git add tests/tools.test.js
git commit -m "test: add failing test for collect_jobs workdir quoting"
```

---

### Task 5: Fix collect_jobs.js workdir quoting

**Files:**
- Modify: `tools/collect_jobs.js:56-91`

- [ ] **Step 1: Add esc helper and fix polling commands**

Add the `esc` helper at the top of the `execute` function (after `const baseUrl` on line 15):

```js
  // Shell single-quote escaping: a'b → a'\''b
  const esc = s => s.replace(/'/g, "'\\''");
```

Then replace the exit_code check command on line 59:

```js
      command: `test -f '${esc(job.workdir)}/exit_code' && cat '${esc(job.workdir)}/exit_code' || echo RUNNING`,
```

And replace the output.json read command on line 86:

```js
      command: `cat '${esc(job.workdir)}/output.json' 2>/dev/null || echo '{}'`,
```

- [ ] **Step 2: Run collect_jobs tests**

```bash
npm test -- tests/tools.test.js -t "collect_jobs"
```

Expected: all tests PASS.

- [ ] **Step 3: Commit**

```bash
git add tools/collect_jobs.js
git commit -m "fix: quote workdir in collect_jobs polling commands"
```

---

### Task 6: Fix userspace.js pollJobResult quoting

**Files:**
- Modify: `userspace.js:609-658`

- [ ] **Step 1: Add esc helper and fix polling commands**

Add the `esc` helper near the top of `pollJobResult` (line 610, after `const jobs`):

```js
  const esc = s => s.replace(/'/g, "'\\''");
```

Replace the exit_code check command on line 615:

```js
      command: `test -f '${esc(state.workdir)}/exit_code' && cat '${esc(state.workdir)}/exit_code' || echo RUNNING`,
```

Replace the output.json read command on line 636:

```js
      command: `cat '${esc(state.workdir)}/output.json' 2>/dev/null || echo '{}'`,
```

- [ ] **Step 2: Run userspace tests**

```bash
npm test -- tests/userspace.test.js
```

Expected: all existing tests still PASS.

- [ ] **Step 3: Commit**

```bash
git add userspace.js
git commit -m "fix: quote workdir in userspace pollJobResult commands"
```

---

### Task 7: Run full test suite and verify

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

```bash
npm test
```

Expected: all tests PASS.

- [ ] **Step 2: Integration test — verify generated script on compute API**

Run this to verify the generated script is syntactically valid on the actual compute target:

```bash
node << 'ENDNODE'
const { readFileSync } = require('fs');
const envContent = readFileSync('.env', 'utf8');
for (const line of envContent.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
}
const baseUrl = 'https://akash.swayambhu.dev';
const headers = {
  'Content-Type': 'application/json',
  'CF-Access-Client-Id': process.env.CF_ACCESS_CLIENT_ID,
  'CF-Access-Client-Secret': process.env.CF_ACCESS_CLIENT_SECRET,
  'Authorization': 'Bearer ' + process.env.COMPUTER_API_KEY,
};
async function run(cmd) {
  const resp = await fetch(baseUrl + '/execute?wait=10', {
    method: 'POST', headers,
    body: JSON.stringify({ command: cmd }),
  });
  return resp.json();
}
// Test: decode a base64 inner script and syntax-check it
const inner = 'export PATH=/home/swayambhu/.local/bin${PATH:+:$PATH}\ncd /tmp && echo ok > output.json 2>stderr.log; echo $? > exit_code';
const b64 = Buffer.from(inner, 'utf8').toString('base64');
run(`printf '%s' '${b64}' | base64 -d | sh -n && echo SYNTAX_OK || echo SYNTAX_FAIL`).then(r => {
  const out = r.output?.map(o => o.data || '').join('').trim();
  console.log('Syntax check result:', out);
  console.log('Exit code:', r.exit_code);
});
ENDNODE
```

Expected output: `Syntax check result: SYNTAX_OK`

- [ ] **Step 3: Final commit with all changes**

```bash
git add -A
git status
```

Verify only expected files are staged. If all good, no additional commit needed (each task already committed).
