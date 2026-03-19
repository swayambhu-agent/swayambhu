# Codex

OpenAI Codex CLI is installed on your server. Invoke it via the `computer`
tool. It's a general-purpose agent — not just for coding. Use it for
research, writing, data processing, file management, codebase exploration,
or any task that benefits from autonomous multi-step work.

## Invocation

Use the `exec` subcommand for non-interactive, headless execution:

```
codex exec --full-auto -m gpt-5.4 "your prompt here"
```

### Key flags

| Flag | Purpose |
|------|---------|
| `exec` | Non-interactive subcommand (required — no TTY available) |
| `--full-auto` | Auto-approve edits, sandbox to workspace writes |
| `-m` / `--model <model>` | Default: `gpt-5.4`. Use `--thinking low` for routine tasks, `--thinking high` for complex work |
| `-C` / `--cd <dir>` | Set working directory |
| `--json` | Output events as JSONL |
| `-o` / `--output-last-message <file>` | Write final answer to a file |
| `--ephemeral` | Don't persist session to disk |
| `--skip-git-repo-check` | Allow running outside a git repo |

### Working directory

```
codex exec --full-auto -m gpt-5.4 -C ~/workspace/myproject "add error handling to the API routes"
```

## Auth

Already configured. If you get authentication errors, ask Swami to
re-authenticate — you cannot do this yourself.

## Usage awareness

Runs on Swami's ChatGPT Pro plan (~$200/month, shared with Swami). No
per-call billing, but you can hit usage limits. Use Codex freely when
it's the right tool for the job, but don't do anything that could get
the account flagged or banned — no automation that looks like abuse,
no excessive parallel sessions, no circumventing rate limits.
