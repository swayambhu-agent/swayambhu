// Swayambhu Governor — builds and deploys the runtime worker
//
// Entry points:
//   scheduled() — cron: crash watchdog + check for pending deploys
//   fetch()     — POST /deploy (manual trigger), POST /rollback, GET /status
//
// Both workers communicate solely through the shared KV namespace.
// The governor reads code from KV, generates index.js, and deploys via CF API.

import { readCodeFromKV, generateIndexJS, keyToFilePath } from './builder.js';
import { deploy, recordDeployment, hashCode } from './deployer.js';
import { syncToGitHub } from './git-sync.js';

export default {
  async scheduled(event, env, ctx) {
    const kv = env.KV;

    // 1. Crash watchdog — check for rollback request from runtime
    const rollbackReq = await kv.get("deploy:rollback_requested", "json");
    if (rollbackReq) {
      await kv.delete("deploy:rollback_requested");
      await performRollback(kv, env);
      return;
    }

    // 2. Check for pending deploys
    const pending = await kv.get("deploy:pending", "json");
    if (pending) {
      await kv.delete("deploy:pending");
      await performDeploy(kv, env);
    }
  },

  async fetch(request, env) {
    const kv = env.KV;
    const url = new URL(request.url);

    if (url.pathname === "/deploy" && request.method === "POST") {
      try {
        const result = await performDeploy(kv, env);
        return Response.json({ ok: true, ...result });
      } catch (err) {
        return Response.json({ ok: false, error: err.message }, { status: 500 });
      }
    }

    if (url.pathname === "/rollback" && request.method === "POST") {
      try {
        const result = await performRollback(kv, env);
        return Response.json({ ok: true, ...result });
      } catch (err) {
        return Response.json({ ok: false, error: err.message }, { status: 500 });
      }
    }

    if (url.pathname === "/status") {
      const current = await kv.get("deploy:current", "json");
      const history = await kv.get("deploy:history", "json");
      const pending = await kv.get("deploy:pending", "json");
      const rollbackReq = await kv.get("deploy:rollback_requested", "json");
      return Response.json({ current, history, pending, rollback_requested: rollbackReq });
    }

    return new Response("Not found", { status: 404 });
  },
};

// ── Deploy flow ─────────────────────────────────────────────

async function performDeploy(kv, env) {
  // 1. Read deploy:pending to get execution_id for batch scoping
  const pending = await kv.get("deploy:pending", "json");
  const executionId = pending?.execution_id || null;

  // 2. Determine which keys will change (for snapshotting before apply)
  const versionId = `v_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const stagingKeys = await listKeysWithPrefix(kv, "code_staging:");
  const targetKeys = [];
  for (const sk of stagingKeys) {
    const record = await kv.get(sk, "json");
    if (!record) continue;
    if (executionId && record.execution_id !== executionId) continue;
    targetKeys.push(sk.slice("code_staging:".length));
  }

  // 3. Snapshot canonical code before applying changes (for rollback)
  if (targetKeys.length > 0) {
    await snapshotCanonicalCode(kv, targetKeys, versionId);
  }

  // 4. Apply staged code (scoped to execution_id if present)
  const changedKeys = await applyStagedCode(kv, executionId);

  // 5. Read all code from KV (now includes applied changes)
  const { files, metadata } = await readCodeFromKV(kv);

  // 6. Generate index.js
  const indexJS = generateIndexJS(metadata);
  files["index.js"] = indexJS;

  // 7. Compute code hashes for manifest
  const codeHashes = {};
  for (const [path, code] of Object.entries(files)) {
    codeHashes[path] = hashCode(code);
  }

  const deployResult = await deploy(env, files);

  // 8. Record deployment
  await recordDeployment(kv, versionId, changedKeys, codeHashes);

  // 9. Sync to GitHub (best-effort — failure never blocks deploy)
  let gitSync = null;
  try {
    const changedFiles = {};
    for (const kvKey of changedKeys) {
      const path = keyToFilePath(kvKey);
      if (path) changedFiles[path] = await kv.get(kvKey, 'text');
    }
    if (Object.keys(changedFiles).length > 0) {
      gitSync = await syncToGitHub(env, changedFiles, `deploy: ${versionId}\n\nChanged: ${changedKeys.join(', ')}`);
    }
  } catch {}

  return {
    version_id: versionId,
    changed_keys: changedKeys,
    files_count: Object.keys(files).length,
    git_sync: gitSync,
  };
}

// Apply staged code to canonical keys, scoped by execution_id.
// Returns array of target keys that were applied.
export async function applyStagedCode(kv, executionId) {
  const stagingKeys = await listKeysWithPrefix(kv, "code_staging:");
  const changedKeys = [];

  for (const stagingKey of stagingKeys) {
    const record = await kv.get(stagingKey, "json");
    if (!record) continue;

    // Batch scoping: if executionId given, only apply matching records
    if (executionId && record.execution_id !== executionId) continue;

    // Target key is everything after "code_staging:"
    const targetKey = stagingKey.slice("code_staging:".length);

    // Apply to canonical key
    await kv.put(targetKey, record.code, {
      metadata: { type: "code", format: "text", updated_at: new Date().toISOString() },
    });

    // Delete consumed staging key
    await kv.delete(stagingKey);
    changedKeys.push(targetKey);
  }

  return changedKeys;
}

// Snapshot current canonical code for rollback.
// Stores a map of { targetKey: code } at deploy:snapshot:{versionId}.
export async function snapshotCanonicalCode(kv, targetKeys, versionId) {
  const snapshot = {};
  for (const key of targetKeys) {
    const code = await kv.get(key, "text");
    // null means the key didn't exist before (new file) — record that
    snapshot[key] = code;
  }
  await kv.put(`deploy:snapshot:${versionId}`, JSON.stringify(snapshot), {
    metadata: { type: "deployment", format: "json" },
  });
}

// ── Rollback flow ───────────────────────────────────────────

async function performRollback(kv, env) {
  const current = await kv.get("deploy:current", "json");
  if (!current?.version_id) {
    throw new Error("No current deployment to rollback from");
  }

  // Restore canonical code from the snapshot taken before this deploy
  const snapshot = await kv.get(`deploy:snapshot:${current.version_id}`, "json");
  if (snapshot) {
    for (const [key, code] of Object.entries(snapshot)) {
      if (code === null) {
        // Key didn't exist before this deploy — remove it
        await kv.delete(key);
      } else {
        await kv.put(key, code, {
          metadata: { type: "code", format: "text", updated_at: new Date().toISOString() },
        });
      }
    }
  }

  // Trigger a fresh deploy from restored state (no staged code to apply)
  const result = await performDeploy(kv, env);

  return {
    rolled_back_from: current.version_id,
    restored_keys: snapshot ? Object.keys(snapshot) : [],
    ...result,
  };
}

// ── Helpers ─────────────────────────────────────────────────

async function listKeysWithPrefix(kv, prefix) {
  const keys = [];
  let cursor;
  do {
    const result = await kv.list({ prefix, cursor });
    keys.push(...result.keys.map(k => k.name));
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);
  return keys;
}
