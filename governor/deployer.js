// Governor — Deployer
// Uploads the runtime worker to Cloudflare via the Workers API.
// Uses multipart module upload format.

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

function resolveDeployMode(env) {
  return env.GOVERNOR_DEPLOY_MODE === "local" ? "local" : "cloudflare";
}

// Build multipart form body for CF Workers script upload (ES modules format).
// files: { "kernel.js": "...", "tools/kv_query.js": "...", ... }
// mainModule: the entry point file name (e.g. "index.js")
function buildMultipartBody(files, mainModule) {
  const boundary = `----CFWorkerUpload${Date.now()}`;
  const parts = [];

  // Metadata part — must be first
  const metadata = {
    main_module: mainModule,
    compatibility_date: "2025-06-01",
    compatibility_flags: ["nodejs_compat"],
  };
  parts.push(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="metadata"\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    JSON.stringify(metadata)
  );

  // Module parts
  for (const [filename, code] of Object.entries(files)) {
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${filename}"; filename="${filename}"\r\n` +
      `Content-Type: application/javascript+module\r\n\r\n` +
      code
    );
  }

  parts.push(`--${boundary}--`);
  return {
    body: parts.join("\r\n"),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

// Deploy the runtime worker via CF Workers API
export async function deploy(env, files, mainModule = "index.js") {
  const deployMode = resolveDeployMode(env);
  if (deployMode === "local") {
    return {
      id: null,
      etag: null,
      mode: "local",
      deployed_at: new Date().toISOString(),
      files_count: Object.keys(files).length,
      main_module: mainModule,
    };
  }

  const accountId = env.CF_ACCOUNT_ID;
  const apiToken = env.CF_API_TOKEN;
  const scriptName = env.CF_SCRIPT_NAME || "swayambhu-cns";

  if (!accountId || !apiToken) {
    throw new Error("Missing CF_ACCOUNT_ID or CF_API_TOKEN");
  }

  const { body, contentType } = buildMultipartBody(files, mainModule);

  const url = `${CF_API_BASE}/accounts/${accountId}/workers/scripts/${scriptName}`;
  const resp = await fetch(url, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${apiToken}`,
      "Content-Type": contentType,
    },
    body,
  });

  const result = await resp.json();
  if (!resp.ok || !result.success) {
    const errors = result.errors?.map(e => e.message).join("; ") || JSON.stringify(result);
    throw new Error(`Deploy failed (${resp.status}): ${errors}`);
  }

  return {
    id: result.result?.id,
    etag: result.result?.etag,
    mode: deployMode,
    deployed_at: new Date().toISOString(),
  };
}

// Record deployment version in KV
export async function recordDeployment(kv, versionId, changedKeys, codeHashes, options = {}) {
  const manifest = {
    version_id: versionId,
    deployed_at: new Date().toISOString(),
    predecessor_version_id: options.predecessor_version_id || null,
    execution_id: options.execution_id || null,
    changed_keys: changedKeys,
    code_hashes: codeHashes,
    deploy_mode: options.deploy_mode || "cloudflare",
    source: options.source || null,
    rollback_of_version_id: options.rollback_of_version_id || null,
    restored_predecessor_version_id: options.restored_predecessor_version_id || null,
    rollback_reason: options.rollback_reason || null,
    rollback_requested_by: options.rollback_requested_by || null,
  };

  await kv.put(`deploy:version:${versionId}`, JSON.stringify(manifest), {
    metadata: { type: "deployment", format: "json" },
  });

  // Update current pointer
  await kv.put("deploy:current", JSON.stringify({
    version_id: versionId,
    deployed_at: manifest.deployed_at,
    deploy_mode: manifest.deploy_mode,
  }), {
    metadata: { type: "deployment", format: "json" },
  });

  // Append to history (keep last 10)
  let history = [];
  try {
    const raw = await kv.get("deploy:history", "json");
    if (Array.isArray(raw)) history = raw;
  } catch {}
  history.unshift({
    version_id: versionId,
    deployed_at: manifest.deployed_at,
    predecessor_version_id: manifest.predecessor_version_id,
    changed_count: changedKeys.length,
    deploy_mode: manifest.deploy_mode,
    source_kind: manifest.source?.kind || null,
    rollback_of_version_id: manifest.rollback_of_version_id,
  });
  while (history.length > 10) history.pop();
  await kv.put("deploy:history", JSON.stringify(history), {
    metadata: { type: "deployment", format: "json" },
  });

  return manifest;
}


// Compute a simple hash of code content for the version manifest
export function hashCode(code) {
  let hash = 0;
  for (let i = 0; i < code.length; i++) {
    const chr = code.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return hash.toString(36);
}
