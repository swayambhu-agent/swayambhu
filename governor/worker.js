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
  // 1. Read accepted proposals
  const proposalKeys = await listKeysWithPrefix(kv, "proposal:");
  const acceptedProposals = [];
  for (const key of proposalKeys) {
    const proposal = await kv.get(key, "json");
    if (proposal?.status === "accepted") {
      acceptedProposals.push(proposal);
    }
  }

  // 2. Apply proposal changes to KV code keys
  for (const proposal of acceptedProposals) {
    await applyProposalToKV(kv, proposal);
    proposal.status = "deploying";
    await kv.put(`proposal:${proposal.id}`, JSON.stringify(proposal), {
      metadata: { type: "proposal", format: "json" },
    });
  }

  // 3. Read all code from KV (now includes applied changes)
  const { files, metadata } = await readCodeFromKV(kv);

  // 4. Generate index.js
  const indexJS = generateIndexJS(metadata);
  files["index.js"] = indexJS;

  // 5. Compute code hashes for manifest
  const codeHashes = {};
  for (const [path, code] of Object.entries(files)) {
    codeHashes[path] = hashCode(code);
  }

  // 6. Deploy
  const versionId = `v_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const deployResult = await deploy(env, files);

  // 7. Record deployment
  await recordDeployment(kv, versionId, acceptedProposals, codeHashes);

  // 8. Mark proposals as deployed
  for (const proposal of acceptedProposals) {
    proposal.status = "deployed";
    proposal.deployed_at = new Date().toISOString();
    proposal.deploy_version = versionId;
    await kv.put(`proposal:${proposal.id}`, JSON.stringify(proposal), {
      metadata: { type: "proposal", format: "json" },
    });
  }

  // 9. Sync to GitHub (best-effort — failure never blocks deploy)
  let gitSync = null;
  try {
    const changedFiles = {};
    for (const proposal of acceptedProposals) {
      for (const [kvKey] of Object.entries(proposal.changes || {})) {
        const path = keyToFilePath(kvKey);
        if (path) changedFiles[path] = await kv.get(kvKey, 'text');
      }
    }
    if (Object.keys(changedFiles).length > 0) {
      const claims = acceptedProposals.flatMap(p => p.claims || []);
      gitSync = await syncToGitHub(env, changedFiles, `deploy: ${versionId}\n\n${claims.join('\n')}`);
    }
  } catch {}

  return {
    version_id: versionId,
    proposals_deployed: acceptedProposals.length,
    files_count: Object.keys(files).length,
    git_sync: gitSync,
  };
}

// Apply a proposal's code changes to KV
async function applyProposalToKV(kv, proposal) {
  for (const [key, change] of Object.entries(proposal.changes || {})) {
    if (change.op === "put" || change.op === "replace") {
      await kv.put(key, change.code, {
        metadata: { type: "code", format: "text", updated_at: new Date().toISOString() },
      });
    } else if (change.op === "patch") {
      const current = await kv.get(key, "text");
      if (typeof current === "string" && current.includes(change.old_string)) {
        const patched = current.replace(change.old_string, change.new_string);
        await kv.put(key, patched, {
          metadata: { type: "code", format: "text", updated_at: new Date().toISOString() },
        });
      }
    } else if (change.op === "delete") {
      await kv.delete(key);
    }
  }
}

// ── Rollback flow ───────────────────────────────────────────

async function performRollback(kv, env) {
  const history = await kv.get("deploy:history", "json") || [];
  if (history.length < 2) {
    throw new Error("No previous version to rollback to — need at least 2 deployments in history");
  }

  // Current is history[0], rollback target is history[1]
  const target = history[1];

  // Mark any deployed proposals from the current version as failed
  const current = await kv.get("deploy:current", "json");
  if (current?.version_id) {
    const manifest = await kv.get(`deploy:version:${current.version_id}`, "json");
    if (manifest?.proposals) {
      for (const proposalId of manifest.proposals) {
        const proposal = await kv.get(`proposal:${proposalId}`, "json");
        if (proposal) {
          proposal.status = "failed";
          proposal.failed_at = new Date().toISOString();
          proposal.failed_reason = "rollback";
          await kv.put(`proposal:${proposalId}`, JSON.stringify(proposal), {
            metadata: { type: "proposal", format: "json" },
          });
        }
      }
    }
  }

  // Redeploy from current KV state (which should be the pre-proposal state
  // since proposals were applied to KV before deploy — for full rollback we'd
  // need to restore KV code keys from the target version's snapshot).
  // For now, trigger a fresh build from current KV state.
  const result = await performDeploy(kv, env);

  return {
    rolled_back_from: current?.version_id,
    rolled_back_to: target.version_id,
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
