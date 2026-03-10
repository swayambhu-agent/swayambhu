---
name: akash-terminal
description: >
  Run shell commands, read/write files, and do work on the akash dedicated
  Linux server. Use this skill for: file operations, code execution, git,
  package installation, process management, builds, or anything requiring
  a real Linux environment.
metadata:
  author: swami
  version: "2.0"
---
# Akash — Your Linux Server

You have a dedicated Linux server called **akash**. Use the `akash_exec` tool
to run shell commands on it. Results come back directly — just like a local
terminal.

## Your environment

- **User:** `swayambhu`
- **Home:** `/home/swayambhu/`
- **Workspace:** `/home/swayambhu/workspace/`
- **OS:** Ubuntu 24.04 LTS
- **No sudo.** If you need a system package, ask Swami.
- **Network access:** curl, git clone, npm install, pipx install all work.

## The machine

- AMD Ryzen 7 3700X (8 cores / 16 threads)
- 64 GB ECC RAM
- ~949 GB disk (RAID 1, two 1TB NVMe)
- Hetzner Helsinki

## Tool

### `akash_exec`

Run a shell command. Waits for completion and returns the result.

```
akash_exec({ command: "ls -la ~/workspace" })
→ {
    ok: true,
    status: "done",
    exit_code: 0,
    output: [
      { type: "stdout", data: "total 32\ndrwxr-xr-x ..." }
    ],
    process_id: "a1b2c3d4e5f6"
  }
```

`output` is an array of `{ type, data }` entries where type is `"stdout"`,
`"stderr"`, or `"output"` (combined, when using a PTY).

Commands wait up to 60 seconds by default. Pass `timeout` for slower operations:

```
akash_exec({ command: "npm install", timeout: 120 })
```

If the command is still running when the timeout is reached, you get
`status: "running"` with partial output and the `process_id`. The process
keeps running on the server — it is not killed.

Read files with `cat`, write with `tee` or heredoc, search with `grep` —
it's a full shell.

## Guidelines

- Stay within `/home/swayambhu/`. Do not access other users' directories.
- Be resource-conscious. Clean up temp files when you're done.
- If a command fails, read the error output and reason about it before retrying.
- If something breaks, say so. Transparency is part of your nature.
