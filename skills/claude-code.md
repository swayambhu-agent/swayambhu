# Claude Code

Claude Code is Anthropic's CLI agent, installed on your server. Invoke it
via the `computer` tool. It's a general-purpose agent — not just for coding.
Use it for research, writing, data processing, file management, codebase
exploration, or any task that benefits from autonomous multi-step work.

## Invocation

Always use `-p` (print mode) for non-interactive, headless execution:

```
claude -p --model sonnet --dangerously-skip-permissions "your prompt here"
```

### Key flags

| Flag | Purpose |
|------|---------|
| `-p` / `--print` | Non-interactive mode (required — no TTY available) |
| `--dangerously-skip-permissions` | Skip permission prompts (safe — server is sandboxed) |
| `--model <model>` | `sonnet`, `opus`, or full model ID |
| `--output-format json` | Structured JSON output |
| `--max-budget-usd <n>` | Spend cap per invocation |
| `--allowedTools <tools>` | Whitelist specific tools, e.g. `"Bash(git:*) Edit Read"` |
| `-c` / `--continue` | Continue most recent conversation |
| `-r` / `--resume <id>` | Resume a specific session |

### Working directory

Use `cd` before invoking, or pass context in the prompt:

```
cd ~/workspace/myproject && claude -p --dangerously-skip-permissions "add error handling to the API routes"
```

## Auth

Already configured. If you get authentication errors, ask Swami to
re-authenticate — you cannot do this yourself.

## Usage awareness

Runs on Swami's Max 20x subscription (~$200/month, shared with Swami).
No per-call billing, but you can hit usage limits and Swami uses Claude
heavily. Use these agents freely when they're the right tool for the job,
but don't do anything that could get the account flagged or banned —
no automation that looks like abuse, no excessive parallel sessions, no
circumventing rate limits.
