# Job Shell Script Fix — Design Spec

**Date:** 2026-04-02
**Branch:** tick-based-kernel
**Status:** Approved (6 rounds of adversarial Codex review)

## Problem

Deep-reflect jobs dispatched to akash fail silently. Two compounding bugs:

1. **Broken shell assembly** — `start_job.js` joins all script lines with
   `.join(' && \\\n')`, including lines inside the `nohup sh -c '...'`
   payload. This produces invalid syntax (`sh -c ' && \n  cd ...`). The
   inner shell fails immediately, writing no `output.json`, `stderr.log`,
   or `exit_code`. The job appears started (PID returned from `nohup`) but
   never executes.

2. **Missing PATH** — The compute API runs as user `swayambhu` with PATH
   `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/snap/bin`. Claude
   CLI is installed at `/home/swayambhu/.local/bin/claude`, not in PATH.
   Even if bug 1 were fixed, `claude` would not be found.

## Design

### Core idea: base64-encoded inner script

The inner script (the job payload) is constructed as a plain shell script
string, base64-encoded, and piped to `sh` through the outer script. This
eliminates the entire class of nested-quoting bugs because the inner
script never passes through the outer shell's parser as shell syntax.

```
OUTER SHELL (compute API)          INNER SHELL (decoded from base64)
─────────────────────────          ─────────────────────────────────
mkdir -p '/workdir'                export PATH=/dir:${PATH:+:$PATH}
printf '%s' 'TARBALL' | ...       cd '/workdir' || { ... exit 1; }
nohup sh -c "                     claude -p ... > output.json 2>stderr.log
  printf '%s' 'INNER_B64'         echo $? > exit_code
  | base64 -d | sh
" &
```

### Shell-escaping helper

```js
const esc = s => s.replace(/'/g, "'\\''");
```

Standard POSIX single-quote escaping. Verified safe with `dash` against
adversarial inputs including `foo' && touch /tmp/pwned; echo 'bar`.

Used for `workdir` and `cc_model` in both inner and outer contexts. NOT
used for `custom` type commands (caller's responsibility — inherently
user-provided shell).

### path_dirs config

New field in `config:defaults` under `jobs`:

```json
"path_dirs": ["/home/swayambhu/.local/bin"]
```

Validation:
- Must be an array (`Array.isArray` guard; non-array silently becomes `[]`)
- Each entry must be a string matching `/^\/[a-zA-Z0-9._\/-]+$/`
- Invalid entries are dropped (no shell metacharacters possible in valid entries)

Injected into the inner script as:
```sh
export PATH=/dir1:/dir2${PATH:+:$PATH}
```

The `${PATH:+:$PATH}` POSIX parameter expansion avoids a trailing colon
when inherited PATH is empty (trailing colon adds CWD to lookup).

### Inner script structure

```sh
export PATH=/home/swayambhu/.local/bin${PATH:+:$PATH}      # if path_dirs
cd '/workdir' || { echo 1 > '/workdir/exit_code'; exit 1; } # absolute exit_code path
<jobCommand> > output.json 2>stderr.log; echo $? > exit_code
```

- No `set -e` — would abort before writing exit_code on command failure
- `cd` failure writes exit_code to absolute path and exits
- Job command exit code captured via `echo $? > exit_code`
- Base64-encoded via `Buffer.from(innerScript, 'utf8').toString('base64')`
  (not `btoa` — handles UTF-8 correctly)

### Outer script structure

```sh
mkdir -p '${esc(workdir)}' && \
printf '%s' '${base64Tar}' | base64 -d | tar xz -C '${esc(workdir)}' && \
nohup sh -c "printf '%s' '${innerB64}' | base64 -d | sh" > /dev/null 2>&1 & echo $!
```

- `&&` joining only for outer commands (never contaminates inner script)
- `printf '%s'` instead of `echo` (portability)
- Inner script is opaque base64 data inside single quotes
- `nohup` wrapper uses double quotes (no single-quote nesting)

### Custom job type

Custom commands are wrapped in a subshell with absolute exit_code path:

```sh
cd '${esc(workdir)}' || { echo 1 > '${esc(workdir)}/exit_code'; exit 1; }
(${command}) > output.json 2>stderr.log; echo $? > '${esc(workdir)}/exit_code'
```

The subshell `(...)` prevents custom commands that `cd` or `exec` from
misplacing the exit_code file. The final `echo $?` uses an absolute path
so it's always written to the expected location regardless of CWD.

### Polling fixes (collect_jobs.js + userspace.js)

Apply `esc()` quoting to `workdir` in all polling commands:

```js
// collect_jobs.js exit_code check
command: `test -f '${esc(job.workdir)}/exit_code' && cat '${esc(job.workdir)}/exit_code' || echo RUNNING`

// collect_jobs.js output.json read
command: `cat '${esc(job.workdir)}/output.json' 2>/dev/null || echo '{}'`

// userspace.js pollJobResult — same pattern
```

## Files changed

| File | Change |
|------|--------|
| `tools/start_job.js` | Add `esc()`, `path_dirs` validation, base64 inner script, separate inner/outer construction, custom job subshell wrapping |
| `tools/collect_jobs.js` | Apply `esc()` to workdir in polling commands |
| `userspace.js` | Apply `esc()` to workdir in `pollJobResult` commands |
| `config/defaults.json` | Add `path_dirs` to `jobs` section |
| `scripts/seed-local-kv.mjs` | Seed `path_dirs` in defaults |
| `tests/tools.test.js` | Add tests for shell generation, quoting, adversarial inputs |

## Security properties (Codex-verified across 6 rounds)

1. Inner script is base64-encoded data — never parsed by outer shell
2. `esc()` is standard POSIX single-quote escaping (verified with `dash`)
3. `path_dirs` entries regex-validated — no shell metacharacters possible
4. `Buffer.from(..., 'utf8').toString('base64')` handles UTF-8
5. `${PATH:+:$PATH}` avoids trailing colon (CWD in lookup)
6. `cd` failure writes to absolute path — collector always finds exit_code
7. Custom commands wrapped in subshell — can't escape exit_code tracking
8. `custom` type command is intentionally unescaped (caller's responsibility)

## Known limitations

- `base64 -d` is not POSIX (BSD/macOS uses `-D`). Target is Linux only.
- If `base64 -d` itself fails (corrupted transport), `sh` exits 0 on empty
  input and no exit_code is written. Job sits as RUNNING until TTL. This
  is acceptable — decode failure means fundamentally broken transport.
- Pre-existing: `cc_model` raw interpolation in the old code was an injection
  vector. This fix addresses it for `cc_analysis` type but doesn't add
  validation to the config itself.

## Out of scope

- Changing the compute API's execution model (accepting argv instead of
  shell strings)
- Generic env injection (rejected — too broad, quoting paradox, dangerous
  vars)
- `echo` → `printf` for other echo uses elsewhere in the codebase
