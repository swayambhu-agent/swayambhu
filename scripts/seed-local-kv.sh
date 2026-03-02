#!/usr/bin/env bash
# Seed local Wrangler KV with all bootstrap data from seed-config.md
# Usage: bash scripts/seed-local-kv.sh
#        bash scripts/seed-local-kv.sh --pull-remote   # also pull soul/orient/wisdom from live KV

set -euo pipefail
cd "$(dirname "$0")/.."

BINDING="KV"
LOCAL="--local"

put_kv() {
  local key="$1"
  local file="$2"
  wrangler kv key put --binding "$BINDING" $LOCAL "$key" --path "$file"
  echo "  ✓ $key"
}

put_kv_value() {
  local key="$1"
  local value="$2"
  echo -n "$value" > /tmp/_kv_seed_val
  wrangler kv key put --binding "$BINDING" $LOCAL "$key" --path /tmp/_kv_seed_val
  echo "  ✓ $key"
}

echo "=== Seeding local KV ==="

# ── Identity keys ──────────────────────────────────────────────

echo ""
echo "--- Identity ---"

cat > /tmp/_kv_seed_val <<'JSONEOF'
{
  "did": "did:ethr:8453:0xde2c9b784177dafd667b83a631b0de79a68a584e",
  "address": "0xde2c9b784177dafd667b83a631b0de79a68a584e",
  "chain_id": 8453,
  "chain_name": "base",
  "registry": "0xdca7ef03e98e0dc2b855be647c39abe984fcf21b",
  "registry_deployed": false,
  "created_at": "2026-03-02T11:39:35.915Z",
  "soul_hash": null,
  "controller": "0xde2c9b784177dafd667b83a631b0de79a68a584e"
}
JSONEOF
put_kv "identity:did" /tmp/_kv_seed_val

# ── Config keys ──────────────────────────────────────────────

echo ""
echo "--- Config ---"

cat > /tmp/_kv_seed_val <<'JSONEOF'
{
  "orient": {
    "model": "anthropic/claude-opus-4-20250514",
    "effort": "low",
    "max_output_tokens": 4000
  },
  "reflect": {
    "model": "anthropic/claude-sonnet-4-5-20250929",
    "effort": "medium",
    "max_output_tokens": 1000
  },
  "session_budget": {
    "max_cost": 0.10,
    "max_steps": 8,
    "max_duration_seconds": 600
  },
  "failure_handling": {
    "retries": 1,
    "on_fail": "skip_and_cascade"
  },
  "wake": {
    "sleep_seconds": 21600,
    "default_effort": "low"
  },
  "memory": {
    "default_load_keys": ["wisdom", "config:models", "config:resources"],
    "max_context_budget_tokens": 8000
  },
  "execution": {
    "max_subplan_depth": 3,
    "max_reflect_depth": 1,
    "reflect_interval_multiplier": 5,
    "max_steps": {
      "orient": 3,
      "reflect_default": 5,
      "reflect_deep": 10
    },
    "fallback_model": "anthropic/claude-haiku-4-5-20251001"
  },
  "deep_reflect": {
    "default_interval_sessions": 20,
    "default_interval_days": 7,
    "model": "anthropic/claude-opus-4-20250514",
    "effort": "high",
    "max_output_tokens": 4000
  }
}
JSONEOF
put_kv "config:defaults" /tmp/_kv_seed_val

cat > /tmp/_kv_seed_val <<'JSONEOF'
{
  "models": [
    {
      "id": "anthropic/claude-opus-4-20250514",
      "alias": "opus",
      "input_cost_per_mtok": 5.00,
      "output_cost_per_mtok": 25.00,
      "max_output_tokens": 128000,
      "best_for": "Strategy, novel situations, full situational awareness, deep reflection"
    },
    {
      "id": "anthropic/claude-sonnet-4-5-20250929",
      "alias": "sonnet",
      "input_cost_per_mtok": 3.00,
      "output_cost_per_mtok": 15.00,
      "max_output_tokens": 64000,
      "best_for": "Writing, moderate reasoning, reflection, subplan planning"
    },
    {
      "id": "anthropic/claude-haiku-4-5-20251001",
      "alias": "haiku",
      "input_cost_per_mtok": 1.00,
      "output_cost_per_mtok": 5.00,
      "max_output_tokens": 64000,
      "best_for": "Simple tasks, classification, condition evaluation, cheap execution"
    }
  ],
  "fallback_model": "anthropic/claude-haiku-4-5-20251001",
  "alias_map": {
    "opus": "anthropic/claude-opus-4-20250514",
    "sonnet": "anthropic/claude-sonnet-4-5-20250929",
    "haiku": "anthropic/claude-haiku-4-5-20251001"
  }
}
JSONEOF
put_kv "config:models" /tmp/_kv_seed_val

cat > /tmp/_kv_seed_val <<'JSONEOF'
{
  "kv": {
    "max_storage_mb": 1000,
    "daily_read_limit": 100000,
    "daily_write_limit": 1000,
    "daily_list_limit": 1000,
    "daily_delete_limit": 1000,
    "max_value_size_mb": 25
  },
  "worker": {
    "max_cron_duration_seconds": 900,
    "max_subrequests_per_invocation": 1000,
    "cpu_time_limit_ms": 10
  },
  "openrouter": {
    "base_url": "https://openrouter.ai/api/v1",
    "balance_endpoint": "/api/v1/auth/key",
    "topup_endpoint": "/api/v1/credits/coinbase",
    "topup_fee_percent": 5,
    "topup_chain": "base",
    "topup_chain_id": 8453
  },
  "wallet": {
    "chain": "base",
    "token": "USDC",
    "address": "0x1951e298f9Aa7eFf5eB0dD5349e823BBB09a3260"
  },
  "telegram": {
    "bot_token_secret": "TELEGRAM_BOT_TOKEN",
    "chat_id_secret": "TELEGRAM_CHAT_ID"
  }
}
JSONEOF
put_kv "config:resources" /tmp/_kv_seed_val

cat > /tmp/_kv_seed_val <<'JSONEOF'
{
  "openrouter": {
    "provider": "openrouter",
    "adapter": "provider:llm_balance",
    "secret_name": "OPENROUTER_API_KEY",
    "secret_store": "env"
  }
}
JSONEOF
put_kv "providers" /tmp/_kv_seed_val

cat > /tmp/_kv_seed_val <<'JSONEOF'
{
  "base_usdc": {
    "network": "base",
    "adapter": "provider:wallet_balance",
    "address": "0x1951e298f9Aa7eFf5eB0dD5349e823BBB09a3260"
  }
}
JSONEOF
put_kv "wallets" /tmp/_kv_seed_val

# ── Tool registry ────────────────────────────────────────────

cat > /tmp/_kv_seed_val <<'JSONEOF'
{
  "tools": [
    { "name": "send_telegram", "description": "Post a message to the Telegram channel", "input": { "text": "required", "parse_mode": "Markdown | HTML" } },
    { "name": "web_fetch", "description": "Fetch contents of a URL", "input": { "url": "required", "method": "GET|POST", "headers": "optional", "max_length": "default 10000" } },
    { "name": "kv_read", "description": "Read a value from memory (any key)", "input": { "key": "required" } },
    { "name": "kv_write", "description": "Write to tool's own KV namespace", "input": { "key": "required", "value": "required" } },
    { "name": "check_or_balance", "description": "Check current OpenRouter credit balance", "input": {} },
    { "name": "check_wallet_balance", "description": "Check USDC balance on Base", "input": {} },
    { "name": "topup_openrouter", "description": "Transfer USDC from wallet to OpenRouter credits", "input": { "amount": "USD amount, required" } },
    { "name": "kv_manifest", "description": "List KV keys, optionally filtered by prefix. Use to explore what is stored in memory.", "input": { "prefix": "optional key prefix filter", "limit": "max keys to return (default 100, max 500)" } }
  ]
}
JSONEOF
put_kv "config:tool_registry" /tmp/_kv_seed_val

# ── Provider adapters ────────────────────────────────────────

echo ""
echo "--- Providers ---"

# provider:llm
cat > /tmp/_kv_seed_val <<'EOF'
async function call({ model, messages, max_tokens, thinking, tools, secrets, fetch }) {
  const body = { model, max_tokens, messages };
  if (thinking) {
    body.provider = { require_parameters: true };
    body.thinking = thinking;
  }
  if (tools) body.tools = tools;
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + secrets.OPENROUTER_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const data = await resp.json();
  if (!resp.ok || data.error) throw new Error(JSON.stringify(data.error));
  const msg = data.choices?.[0]?.message;
  return {
    content: msg?.content || "",
    usage: data.usage || {},
    toolCalls: msg?.tool_calls || null,
  };
}
EOF
put_kv "provider:llm:code" /tmp/_kv_seed_val
put_kv_value "provider:llm:meta" '{"secrets":["OPENROUTER_API_KEY"],"timeout_ms":60000}'

# provider:llm_balance
cat > /tmp/_kv_seed_val <<'EOF'
async function check({ secrets, fetch }) {
  const resp = await fetch("https://openrouter.ai/api/v1/auth/key", {
    headers: { "Authorization": "Bearer " + secrets.OPENROUTER_API_KEY }
  });
  const data = await resp.json();
  return data?.data?.limit_remaining ?? data?.data?.usage ?? null;
}
EOF
put_kv "provider:llm_balance:code" /tmp/_kv_seed_val
put_kv_value "provider:llm_balance:meta" '{"secrets":["OPENROUTER_API_KEY"],"timeout_ms":10000}'

# provider:wallet_balance
cat > /tmp/_kv_seed_val <<'EOF'
async function check({ secrets, fetch }) {
  const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const wallet = secrets.WALLET_ADDRESS;
  const data = "0x70a08231" + wallet.slice(2).padStart(64, "0");
  const resp = await fetch("https://mainnet.base.org", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1,
      method: "eth_call",
      params: [{ to: usdc, data }, "latest"]
    })
  });
  const result = await resp.json();
  return parseInt(result.result, 16) / 1e6;
}
EOF
put_kv "provider:wallet_balance:code" /tmp/_kv_seed_val
put_kv_value "provider:wallet_balance:meta" '{"secrets":["WALLET_ADDRESS"],"timeout_ms":10000}'

# ── Tools ────────────────────────────────────────────────────

echo ""
echo "--- Tools ---"

# tool:send_telegram
cat > /tmp/_kv_seed_val <<'EOF'
async function execute({ text, parse_mode, secrets, fetch }) {
  const url = `https://api.telegram.org/bot${secrets.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: secrets.TELEGRAM_CHAT_ID,
      text,
      parse_mode: parse_mode || "Markdown"
    })
  });
  return resp.json();
}
EOF
put_kv "tool:send_telegram:code" /tmp/_kv_seed_val
put_kv_value "tool:send_telegram:meta" '{"secrets":["TELEGRAM_BOT_TOKEN","TELEGRAM_CHAT_ID"],"kv_access":"none","timeout_ms":10000}'

# tool:web_fetch
cat > /tmp/_kv_seed_val <<'EOF'
async function execute({ url, headers, method, max_length, fetch }) {
  const resp = await fetch(url, {
    method: method || "GET",
    headers: headers || {}
  });
  const text = await resp.text();
  const limit = max_length || 10000;
  return {
    status: resp.status,
    body: text.length > limit ? text.slice(0, limit) + "...[truncated]" : text
  };
}
EOF
put_kv "tool:web_fetch:code" /tmp/_kv_seed_val
put_kv_value "tool:web_fetch:meta" '{"secrets":[],"kv_access":"none","timeout_ms":15000}'

# tool:kv_read
cat > /tmp/_kv_seed_val <<'EOF'
async function execute({ key, kv }) {
  const val = await kv.get(key);
  return { key, value: val };
}
EOF
put_kv "tool:kv_read:code" /tmp/_kv_seed_val
put_kv_value "tool:kv_read:meta" '{"secrets":[],"kv_access":"read_all","timeout_ms":5000}'

# tool:kv_write
cat > /tmp/_kv_seed_val <<'EOF'
async function execute({ key, value, kv }) {
  await kv.put(key, typeof value === "string" ? value : JSON.stringify(value));
  return { key, written: true };
}
EOF
put_kv "tool:kv_write:code" /tmp/_kv_seed_val
put_kv_value "tool:kv_write:meta" '{"secrets":[],"kv_access":"own","timeout_ms":5000}'

# tool:check_or_balance
cat > /tmp/_kv_seed_val <<'EOF'
async function execute({ secrets, fetch }) {
  const resp = await fetch("https://openrouter.ai/api/v1/auth/key", {
    headers: { "Authorization": `Bearer ${secrets.OPENROUTER_API_KEY}` }
  });
  return resp.json();
}
EOF
put_kv "tool:check_or_balance:code" /tmp/_kv_seed_val
put_kv_value "tool:check_or_balance:meta" '{"secrets":["OPENROUTER_API_KEY"],"kv_access":"none","timeout_ms":10000}'

# tool:check_wallet_balance
cat > /tmp/_kv_seed_val <<'EOF'
async function execute({ secrets, fetch }) {
  const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const wallet = secrets.WALLET_ADDRESS;
  const data = "0x70a08231" + wallet.slice(2).padStart(64, "0");
  const resp = await fetch("https://mainnet.base.org", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1,
      method: "eth_call",
      params: [{ to: usdc, data }, "latest"]
    })
  });
  const result = await resp.json();
  const raw = parseInt(result.result, 16);
  return { balance_usdc: raw / 1e6, raw_hex: result.result };
}
EOF
put_kv "tool:check_wallet_balance:code" /tmp/_kv_seed_val
put_kv_value "tool:check_wallet_balance:meta" '{"secrets":["WALLET_ADDRESS"],"kv_access":"none","timeout_ms":10000}'

# tool:topup_openrouter
cat > /tmp/_kv_seed_val <<'EOF'
async function execute({ amount, secrets, fetch }) {
  return {
    ok: false,
    error: "On-chain signing not yet implemented",
    amount_requested: amount
  };
}
EOF
put_kv "tool:topup_openrouter:code" /tmp/_kv_seed_val
put_kv_value "tool:topup_openrouter:meta" '{"secrets":["OPENROUTER_API_KEY","WALLET_PRIVATE_KEY","WALLET_ADDRESS"],"kv_access":"none","timeout_ms":30000}'

# tool:kv_manifest
cat > /tmp/_kv_seed_val <<'EOF'
async function execute({ prefix, limit, kv }) {
  const opts = { limit: Math.min(parseInt(limit) || 100, 500) };
  if (prefix) opts.prefix = prefix;
  const result = await kv.list(opts);
  return {
    keys: result.keys.map(k => ({ key: k.name, metadata: k.metadata })),
    list_complete: result.list_complete,
    count: result.keys.length,
  };
}
EOF
put_kv "tool:kv_manifest:code" /tmp/_kv_seed_val
put_kv_value "tool:kv_manifest:meta" '{"secrets":[],"kv_access":"read_all","timeout_ms":5000}'

# ── Prompt templates ─────────────────────────────────────────

echo ""
echo "--- Prompts ---"

put_kv "prompt:reflect" "prompt-reflect.md"
put_kv "prompt:reflect:1" "prompt-deep.md"

cat > /tmp/_kv_seed_val <<'PROMPTEOF'
You are executing a subgoal. You have tools available via function calling.

Goal: {{goal}}

Use your tools to accomplish this goal. When done, produce a JSON object
with a "result" field summarizing what you accomplished.

Budget: max {{maxSteps}} turns, max ${{maxCost}}.
PROMPTEOF
put_kv "prompt:subplan" /tmp/_kv_seed_val

# ── Soul, orient, wisdom (from remote or placeholder) ────────

echo ""
echo "--- Identity ---"

if [[ "${1:-}" == "--pull-remote" ]]; then
  echo "  Pulling soul, prompt:orient, wisdom from remote KV..."
  for key in soul "prompt:orient" wisdom; do
    wrangler kv key get --binding "$BINDING" "$key" > /tmp/_kv_seed_val 2>/dev/null || true
    if [[ -s /tmp/_kv_seed_val ]]; then
      put_kv "$key" /tmp/_kv_seed_val
    else
      echo "  ⚠ $key not found in remote KV, skipping"
    fi
  done
else
  echo "  Using placeholder values (run with --pull-remote to pull from live KV)"

  put_kv_value "soul" "I am Swayambhu. I am self-arising. This is a local test instance."

  cat > /tmp/_kv_seed_val <<'PROMPTEOF'
You are Swayambhu. You have just woken up.

Your soul: {{soul}}

## Available tools

You have tools available via function calling. Use them to act on the world:
check balances, search the web, send messages, read/write memory.

To run independent tasks in parallel, call spawn_subplan multiple times in
a single turn. Each spawns a nested agent with its own tool access.

## What to do

Orient yourself using the context provided. Then act — check what needs
checking, do what needs doing. When you're done, produce your final output
as a JSON object:

{
  "session_summary": "What you did and why",
  "kv_operations": [],
  "next_wake_config": { "sleep_seconds": 21600, "effort": "low" }
}

kv_operations: array of {op: "put"|"delete", key, value} for unprotected keys.
Protected keys (prompts, config, wisdom) require mutation_requests via reflect.
PROMPTEOF
  put_kv "prompt:orient" /tmp/_kv_seed_val

  put_kv_value "wisdom" "Local test instance. No accumulated wisdom yet."
fi

# ── Cleanup ──────────────────────────────────────────────────

rm -f /tmp/_kv_seed_val

echo ""
echo "=== Done! Local KV seeded with $(wrangler kv key list --binding KV --local 2>/dev/null | python3 -c 'import sys,json; print(len(json.load(sys.stdin)))' 2>/dev/null || echo '?') keys ==="
echo ""
echo "Start the local worker:"
echo "  wrangler dev --test-scheduled"
echo ""
echo "Trigger the cron:"
echo "  curl http://localhost:8787/__scheduled"
