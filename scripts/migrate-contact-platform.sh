#!/usr/bin/env bash
# Migrate production KV from old contact schema to contact_platform: schema.
#
# What this does:
# 1. Creates contact_platform:slack:U084ASKBXB7 → { slug: "swami_kevala", approved: true }
# 2. Updates contact:swami_kevala to remove approved/platforms fields
# 3. Deletes contact_index:slack:U084ASKBXB7 (replaced by contact_platform:)
# 4. Deletes patron:identity_snapshot (forces fresh snapshot on next boot)
#
# Usage: bash scripts/migrate-contact-platform.sh [--dry-run]

set -euo pipefail

KV_NS="05720444f9654ed4985fb67af4aea24d"
DRY_RUN="${1:-}"

run() {
  echo "  → $*"
  if [ "$DRY_RUN" != "--dry-run" ]; then
    "$@"
  fi
}

echo "=== Contact Platform Migration ==="
echo ""

# 1. Write contact_platform:slack:U084ASKBXB7
echo "1. Creating contact_platform:slack:U084ASKBXB7"
run wrangler kv:key put \
  --namespace-id="$KV_NS" \
  "contact_platform:slack:U084ASKBXB7" \
  '{"slug":"swami_kevala","approved":true}' \
  --metadata='{"type":"contact_platform","format":"json","updated_at":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}'

# 2. Update contact:swami_kevala — remove approved/platforms
echo "2. Updating contact:swami_kevala (removing approved/platforms)"
run wrangler kv:key put \
  --namespace-id="$KV_NS" \
  "contact:swami_kevala" \
  '{"name":"Swami Kevala","relationship":"patron","about":"Bramhachari at Isha.","timezone":"Asia/Kolkata","location":"Isha Yoga Center, Coimbatore","chat":{"model":"sonnet","effort":"high","max_cost_per_conversation":1,"max_output_tokens":2000},"communication":"Feel free to discuss absolutely anything. Nothing is off limits."}' \
  --metadata='{"type":"contact","format":"json","updated_at":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}'

# 3. Delete old contact_index
echo "3. Deleting contact_index:slack:U084ASKBXB7"
run wrangler kv:key delete \
  --namespace-id="$KV_NS" \
  "contact_index:slack:U084ASKBXB7" \
  --force

# 4. Delete patron:identity_snapshot to force fresh snapshot
echo "4. Deleting patron:identity_snapshot (will regenerate on next boot)"
run wrangler kv:key delete \
  --namespace-id="$KV_NS" \
  "patron:identity_snapshot" \
  --force

echo ""
echo "=== Migration complete ==="
echo "Next cron invocation should create a fresh patron identity snapshot and run normally."
