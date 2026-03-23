#!/bin/bash
# Block Claude Code from reading .env files (Read tool or Bash cat/head/tail)
# No jq dependency — uses grep/sed on the JSON input.

INPUT=$(cat)

# Extract tool_name from JSON
TOOL_NAME=$(echo "$INPUT" | grep -o '"tool_name"\s*:\s*"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/')

case "$TOOL_NAME" in
  Read)
    FILE_PATH=$(echo "$INPUT" | grep -o '"file_path"\s*:\s*"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/')
    BASENAME=$(basename "$FILE_PATH")
    if [[ "$BASENAME" == .env* || "$BASENAME" == .dev.vars ]]; then
      echo "BLOCKED: Reading secret files (.env, .dev.vars) is not allowed. Inspect code that references env vars instead." >&2
      exit 2
    fi
    ;;
  Bash)
    CMD=$(echo "$INPUT" | grep -o '"command"\s*:\s*"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/')
    if echo "$CMD" | grep -qE '(cat|head|tail|less|more|sed|awk|source|\.)\s+.*(\.env|\.dev\.vars)'; then
      echo "BLOCKED: Reading secret files (.env, .dev.vars) via Bash is not allowed. Inspect code that references env vars instead." >&2
      exit 2
    fi
    ;;
esac

exit 0
