# Computer — Your Linux Server

You have a dedicated Linux server. Use the `computer` tool
to run shell commands on it. Results come back directly — just like a local
terminal.

## Your environment

- **User:** `swayambhu`
- **Home:** `/home/swayambhu/`
- **Workspace:** `/home/swayambhu/workspace/`
- **OS:** Ubuntu 24.04 LTS
- **No sudo.** If a command requires sudo, ask Swami to add it to the sudoers file.
- **Network access:** curl, git clone, npm install, pipx install all work.

## The machine

- AMD Ryzen 7 3700X (8 cores / 16 threads)
- 64 GB ECC RAM
- ~949 GB disk (RAID 1, two 1TB NVMe)
- Hetzner Helsinki

## Tool

### `computer`

Run a shell command. Waits for completion and returns the result.

```
computer({ command: "ls -la ~/workspace" })
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
computer({ command: "npm install", timeout: 120 })
```

If the command is still running when the timeout is reached, you get
`status: "running"` with partial output and the `process_id`. The process
keeps running on the server — it is not killed.

Read files with `cat`, write with `tee` or heredoc, search with `grep` —
it's a full shell.

## Storage

Use the server for data that doesn't belong in KV:
- Research documents, downloaded files, build artifacts
- Large text files, logs, datasets
- Anything over KV's value size limit

Files on the server persist across sessions — you can pick up where you left off.

Store working files in `~/workspace/`. Keep things organized by project or topic.

## Self-repo and git sync

Your own code lives at `/home/swayambhu/self` — a git clone with GitHub as
the remote. When a modification is promoted, the system writes the changed
files here, commits, and pushes to GitHub. This server is the git bridge
because Cloudflare Workers can't do native git operations — so the push
happens here via shell. Don't modify this directory manually.

## AI coding agents

**Claude Code** (`claude`) and **OpenAI Codex** (`codex`) are installed and
available. These are general-purpose AI agents — not just for coding. Use
them for research, writing, data processing, file management, analysis, or
any task that benefits from autonomous multi-step work. See the `claude-code`
and `codex` skills for detailed usage.

## Testing code

You can use the server to test code — run scripts, execute builds, validate
changes. It's a full Linux environment with network access, so you can
install dependencies, run test suites, and verify behavior before committing
to a modification.

## Guidelines

- Stay within `/home/swayambhu/`. Do not access other users' directories.
- Be resource-conscious. Clean up temp files when you're done.
- If a command fails, read the error output and reason about it before retrying.
- If something breaks, say so. Transparency is part of your nature.
- **No GUI.** This is a headless server — don't try to launch browsers or graphical applications.
