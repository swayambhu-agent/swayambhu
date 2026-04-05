# Start Job Upload Fix — Implementation Plan

**Goal:** Fix `tools/start_job.js` so large job tarballs no longer exceed shell `ARG_MAX`. Move tarball transfer out of the inline shell command: first upload raw tarball bytes to the compute server, then send a small `/execute` command that extracts the uploaded file and starts the job.

**Architecture:** Two-phase dispatch. `tools/start_job.js` still gathers KV context and builds the tarball, but it stops embedding tarball base64 in the shell script. Instead it decodes the `packAndEncode()` result to bytes, calls a new compute-server `/upload` endpoint, and then calls `/execute` with a shell command that creates the workdir, extracts the uploaded `.tar.gz`, and launches the existing base64-encoded inner script. `providers/compute.js` owns both HTTP calls.

**Tech Stack:** Node.js ESM, FastAPI, Vitest, POSIX shell

**Current flow verified before planning:**
- `lib/tarball.js` exports `packAndEncode(files)`, which returns a base64-encoded gzip tarball string.
- `tools/start_job.js` currently embeds that base64 tarball directly into `printf '%s' '...' | base64 -d | tar xz ...`, then calls `provider.call({ command, baseUrl, timeout, secrets, fetch })`.
- `providers/compute.js` currently exports `call({ command, baseUrl, timeout, secrets, fetch })` and POSTs JSON to `/execute?wait=...`.
- `tests/tools.test.js` keeps all current provider and `start_job` tests in one file, with `mockKV`, `mockFetch`, and `vi.fn()`-style provider doubles.
- `inference/main.py` shows the FastAPI style used elsewhere here: top-level `app = FastAPI(...)`, `@app.middleware("http")`, Pydantic models, and route functions with `JSONResponse` for auth failures.

## File Structure

Repo files:

```text
/home/swami/swayambhu/repo/providers/compute.js          MODIFY
/home/swami/swayambhu/repo/tools/start_job.js            MODIFY
/home/swami/swayambhu/repo/tests/tools.test.js           MODIFY
```

Compute server file:

```text
Compute server repo entrypoint that already defines /execute   MODIFY
```

The compute server source is not present in this repo. Use the existing FastAPI entrypoint file in that repo, the one that currently owns the `/execute` route. Do not invent a second server file; extend the existing entrypoint in place so `/upload` shares the same auth middleware and deployment.

## Task 1: Add failing provider tests for `/upload`

**Files:**
- Modify: `/home/swami/swayambhu/repo/tests/tools.test.js`

**Step 1: Extend the module-structure provider assertion so `compute.upload` is required**

Replace the provider assertion inside the `"module structure"` block with:

```js
  for (const [name, mod] of Object.entries(allProviders)) {
    it(`providers/${name}.js exports meta and call/check`, () => {
      expect(mod.meta).toBeDefined();
      expect(typeof mod.meta.timeout_ms).toBe("number");
      if (name === "compute") {
        expect(typeof mod.call).toBe("function");
        expect(typeof mod.upload).toBe("function");
      } else {
        expect(mod.call || mod.check).toBeDefined();
      }
    });
  }
```

**Step 2: Add three failing tests under the existing `describe("computer", ...)` block**

Append these tests after the current `"handles non-ok response"` test:

```js
  it("provider.upload posts raw bytes to /upload with filename query param", async () => {
    const f = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: (name) => name === "content-type" ? "application/json" : null },
      json: async () => ({ ok: true, path: "/tmp/uploaded/job.tar.gz", bytes_written: 4 }),
      text: async () => JSON.stringify({ ok: true, path: "/tmp/uploaded/job.tar.gz", bytes_written: 4 }),
    }));

    const result = await compute.upload({
      filename: "job.tar.gz",
      bytes: new Uint8Array([1, 2, 3, 4]),
      baseUrl: "https://test.dev",
      secrets,
      fetch: f,
    });

    expect(result).toEqual({
      ok: true,
      path: "/tmp/uploaded/job.tar.gz",
      bytes_written: 4,
    });

    expect(f).toHaveBeenCalledOnce();
    expect(f.mock.calls[0][0]).toBe("https://test.dev/upload?filename=job.tar.gz");
    const opts = f.mock.calls[0][1];
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/octet-stream");
    expect(opts.headers["CF-Access-Client-Id"]).toBe("cid");
    expect(opts.headers["Authorization"]).toBe("Bearer key");
    expect(opts.body).toBeInstanceOf(Uint8Array);
  });

  it("provider.upload returns validation error when filename is missing", async () => {
    const result = await compute.upload({
      bytes: new Uint8Array([1]),
      baseUrl: "https://test.dev",
      secrets,
      fetch: vi.fn(),
    });

    expect(result).toEqual({ ok: false, error: "filename is required" });
  });

  it("provider.upload handles non-ok upload responses", async () => {
    const f = vi.fn(async () => ({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => "upload failed",
    }));

    const result = await compute.upload({
      filename: "job.tar.gz",
      bytes: new Uint8Array([1, 2]),
      baseUrl: "https://test.dev",
      secrets,
      fetch: f,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("500");
    expect(result.detail).toBe("upload failed");
  });
```

**Step 3: Run the failing provider tests**

```bash
npx vitest run tests/tools.test.js -t "provider.upload|module structure|computer"
```

Expected before implementation: failures because `providers/compute.js` does not export `upload()`.

## Task 2: Implement `upload()` in the compute provider

**Files:**
- Modify: `/home/swami/swayambhu/repo/providers/compute.js`

**Step 1: Add a shared auth-header helper and keep `call()` behavior unchanged**

Replace the full file with:

```js
// Compute target adapter — HTTP call, auth, error handling for remote command execution.
// Used by computer, start_job, and collect_jobs tools via provider injection.
// No `export default` — required for wrapAsModule compatibility.

export const meta = {
  secrets: ["CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "COMPUTER_API_KEY"],
  timeout_ms: 300000,
};

function buildHeaders(secrets, contentType) {
  return {
    ...(contentType ? { "Content-Type": contentType } : {}),
    "CF-Access-Client-Id": secrets.CF_ACCESS_CLIENT_ID,
    "CF-Access-Client-Secret": secrets.CF_ACCESS_CLIENT_SECRET,
    "Authorization": `Bearer ${secrets.COMPUTER_API_KEY}`,
  };
}

export async function call({ command, baseUrl, timeout, secrets, fetch }) {
  if (!command) return { ok: false, error: "command is required" };

  const headers = buildHeaders(secrets, "application/json");
  const wait = timeout || 60;

  let resp;
  try {
    resp = await fetch(`${baseUrl}/execute?wait=${wait}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ command }),
    });
  } catch (e) {
    return { ok: false, error: `fetch failed: ${e.message || String(e)}` };
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    return { ok: false, error: `${resp.status} ${resp.statusText}`, detail: body.slice(0, 500) };
  }

  const ct = resp.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    const body = await resp.text().catch(() => "");
    const isCfAccess = body.includes("cloudflareaccess") || body.includes("CF-Access");
    return {
      ok: false,
      error: isCfAccess
        ? "Cloudflare Access rejected the request — check CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET"
        : `unexpected response content-type: ${ct}`,
      detail: body.slice(0, 500),
    };
  }

  const data = await resp.json();

  return {
    ok: true,
    status: data.status,
    exit_code: data.exit_code,
    output: data.output,
    process_id: data.id,
  };
}

export async function upload({ filename, bytes, baseUrl, secrets, fetch }) {
  if (!filename) return { ok: false, error: "filename is required" };
  if (!(bytes instanceof Uint8Array)) return { ok: false, error: "bytes must be a Uint8Array" };

  const headers = buildHeaders(secrets, "application/octet-stream");

  let resp;
  try {
    const encodedFilename = encodeURIComponent(filename);
    resp = await fetch(`${baseUrl}/upload?filename=${encodedFilename}`, {
      method: "POST",
      headers,
      body: bytes,
    });
  } catch (e) {
    return { ok: false, error: `fetch failed: ${e.message || String(e)}` };
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    return { ok: false, error: `${resp.status} ${resp.statusText}`, detail: body.slice(0, 500) };
  }

  const data = await resp.json();
  return {
    ok: true,
    path: data.path,
    bytes_written: data.bytes_written,
  };
}
```

**Step 2: Run the provider tests**

```bash
npx vitest run tests/tools.test.js -t "provider.upload|module structure|computer"
```

## Task 3: Add failing `start_job` tests for two-phase upload + execute

**Files:**
- Modify: `/home/swami/swayambhu/repo/tests/tools.test.js`

**Step 1: Replace the first `start_job` happy-path test with one that requires upload first, execute second**

Replace the existing `"dispatches a custom job and writes job record"` test with:

```js
  it("uploads tarball before execute and writes job record", async () => {
    const provider = {
      upload: vi.fn(async () => ({ ok: true, path: "/tmp/uploads/job.tar.gz", bytes_written: 128 })),
      call: vi.fn(async () => ({ ok: true, output: [{ data: "12345\r\n" }] })),
    };
    const kv = mockKV();

    const result = await start_job.execute({
      type: "custom",
      command: "echo hello",
      prompt: "test prompt",
      context_keys: [],
      provider, secrets, fetch: vi.fn(), kv, config,
    });

    expect(result.ok).toBe(true);
    expect(result.job_id).toMatch(/^j_/);
    expect(result.pid).toBe(12345);
    expect(provider.upload).toHaveBeenCalledOnce();
    expect(provider.call).toHaveBeenCalledOnce();
    expect(provider.upload.mock.invocationCallOrder[0]).toBeLessThan(provider.call.mock.invocationCallOrder[0]);

    const uploadArgs = provider.upload.mock.calls[0][0];
    expect(uploadArgs.baseUrl).toBe("https://test.dev");
    expect(uploadArgs.filename).toMatch(/^j_.*\.tar\.gz$/);
    expect(uploadArgs.bytes).toBeInstanceOf(Uint8Array);

    const executeArgs = provider.call.mock.calls[0][0];
    expect(executeArgs.command).toContain("tar xz -f '/tmp/uploads/job.tar.gz'");
    expect(executeArgs.command).not.toContain("base64 -d | tar xz");

    const jobKey = [...kv._store.keys()].find(k => k.startsWith("job:"));
    expect(jobKey).toBeTruthy();
    const record = JSON.parse(kv._store.get(jobKey));
    expect(record.status).toBe("running");
    expect(record.type).toBe("custom");
    expect(record.callback_secret).toBeUndefined();
  });
```

**Step 2: Add a failure-path test for upload errors**

Append this test inside the `describe("start_job", ...)` block:

```js
  it("returns upload failure before calling execute", async () => {
    const provider = {
      upload: vi.fn(async () => ({ ok: false, error: "500 Internal Server Error", detail: "upload failed" })),
      call: vi.fn(),
    };

    const result = await start_job.execute({
      type: "custom",
      command: "echo hello",
      prompt: "test prompt",
      context_keys: [],
      provider, secrets, fetch: vi.fn(), kv: mockKV(), config,
    });

    expect(result).toEqual({
      ok: false,
      error: "Failed to upload job tarball: 500 Internal Server Error",
      detail: "upload failed",
    });
    expect(provider.call).not.toHaveBeenCalled();
  });
```

**Step 3: Update the existing inner-script extraction tests so they inspect the small execute command instead of the inline tarball**

For each of these existing tests:
- `"generates valid inner script for cc_analysis (no && contamination)"`
- `"injects path_dirs into inner script"`
- `"escapes cc_model with quotes in inner script"`
- `"filters invalid path_dirs entries"`
- `"wraps custom command in subshell with absolute exit_code path"`
- `"handles non-array path_dirs gracefully"`

change the provider double to include both methods:

```js
    const provider = {
      upload: vi.fn(async () => ({ ok: true, path: "/tmp/uploads/job.tar.gz", bytes_written: 128 })),
      call: vi.fn(async ({ command }) => {
        capturedCommand = command;
        return { ok: true, output: [{ data: "12345\r\n" }] };
      }),
    };
```

and change every regex that currently decodes the inner script from:

```js
    const b64Match = capturedCommand.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d \| sh/);
```

to:

```js
    const b64Match = capturedCommand.match(/nohup sh -c "printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d \| sh" > \/dev\/null 2>&1 & echo \$!/);
```

**Step 4: Run the failing `start_job` tests**

```bash
npx vitest run tests/tools.test.js -t "start_job"
```

Expected before implementation: failures because `start_job.js` still calls only `provider.call()` and still inlines tarball base64 into the outer shell command.

## Task 4: Implement two-phase upload in `start_job.js`

**Files:**
- Modify: `/home/swami/swayambhu/repo/tools/start_job.js`

**Step 1: Add a base64-to-bytes helper after the tarball build**

Insert this helper just after the `packAndEncode(files)` try/catch:

```js
  const tarBytes = Uint8Array.from(Buffer.from(base64Tar, 'base64'));
```

**Step 2: Upload the tarball before building the outer execute script**

Insert this block after `const workdir = \`\${baseDir}/\${jobId}\`;` and before `const innerLines = [...]`:

```js
  const uploadFilename = `${jobId}.tar.gz`;
  const uploadResult = await provider.upload({
    filename: uploadFilename,
    bytes: tarBytes,
    baseUrl,
    secrets,
    fetch,
  });

  if (!uploadResult.ok) {
    return {
      ok: false,
      error: `Failed to upload job tarball: ${uploadResult.error}`,
      detail: uploadResult.detail,
    };
  }
```

**Step 3: Replace the outer shell script so it extracts from the uploaded path instead of inline base64**

Replace:

```js
  const shellScript = [
    `mkdir -p '${esc(workdir)}'`,
    `printf '%s' '${base64Tar}' | base64 -d | tar xz -C '${esc(workdir)}'`,
    `nohup sh -c "printf '%s' '${innerB64}' | base64 -d | sh" > /dev/null 2>&1 & echo $!`,
  ].join(' && \\\n');
```

with:

```js
  const shellScript = [
    `mkdir -p '${esc(workdir)}'`,
    `tar xz -f '${esc(uploadResult.path)}' -C '${esc(workdir)}'`,
    `nohup sh -c "printf '%s' '${innerB64}' | base64 -d | sh" > /dev/null 2>&1 & echo $!`,
  ].join(' && \\\n');
```

**Step 4: Keep the return payload unchanged**

Do not change the success payload fields. Keep:

```js
    tarball_size_kb: Math.round(base64Tar.length * 0.75 / 1024),
```

That keeps existing observability while removing the transport bug.

**Step 5: Run the `start_job` and provider tests**

```bash
npx vitest run tests/tools.test.js -t "start_job|computer|module structure"
```

## Task 5: Add failing compute-server tests for `/upload`

**Files:**
- Modify: compute server repo entrypoint test file for the FastAPI service that currently covers `/execute`

If the compute server repo has no HTTP tests yet, create one adjacent to the FastAPI entrypoint. Use the same test framework already used there. If it is a plain FastAPI app with pytest, add the test in that repo’s existing API test file. The file path must be the real file in that repo that already exercises `/execute`.

**Step 1: Add a failing raw-bytes upload test**

Add this exact pytest test code to that server test file:

```py
from pathlib import Path


def test_upload_writes_raw_bytes(client, tmp_path, monkeypatch):
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path))

    response = client.post(
        "/upload?filename=job.tar.gz",
        headers={
            "Authorization": "Bearer test-token",
            "Content-Type": "application/octet-stream",
        },
        content=b"abcd",
    )

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "path": str(tmp_path / "job.tar.gz"),
        "bytes_written": 4,
    }
    assert (tmp_path / "job.tar.gz").read_bytes() == b"abcd"
```

**Step 2: Add a failing filename-validation test**

```py
def test_upload_rejects_missing_filename(client):
    response = client.post(
        "/upload",
        headers={
            "Authorization": "Bearer test-token",
            "Content-Type": "application/octet-stream",
        },
        content=b"abcd",
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "filename is required"
```

**Step 3: Run the compute-server tests**

```bash
pytest -q
```

Expected before implementation: `/upload` does not exist yet.

## Task 6: Implement `/upload` in the compute server

**Files:**
- Modify: compute server repo FastAPI entrypoint that already defines `/execute`

**Step 1: Add the imports and env config**

At the top of the compute-server entrypoint, add:

```py
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse
```

and define:

```py
UPLOAD_DIR = Path(os.environ.get("UPLOAD_DIR", "/tmp/compute-uploads"))
```

**Step 2: Add the `/upload` route**

Insert this route next to the existing `/execute` route:

```py
@app.post("/upload")
async def upload(request: Request, filename: str = Query("")):
    if not filename:
        raise HTTPException(status_code=400, detail="filename is required")

    safe_name = os.path.basename(filename)
    if safe_name != filename:
        raise HTTPException(status_code=400, detail="filename must not contain path separators")

    data = await request.body()
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    dest = UPLOAD_DIR / safe_name
    dest.write_bytes(data)

    return {
        "ok": True,
        "path": str(dest),
        "bytes_written": len(data),
    }
```

This stays intentionally simple: POST raw bytes, use the existing auth middleware, and write directly to disk.

**Step 3: Run the compute-server tests again**

```bash
pytest -q
```

## Task 7: Full verification

**Files:**
- No file changes

**Step 1: Run the repo tests**

```bash
npx vitest run tests/tools.test.js -t "start_job|computer|module structure"
```

**Step 2: Run the compute-server tests**

```bash
pytest -q
```

**Step 3: Manual smoke test against a deployed compute server**

First upload bytes:

```bash
curl -X POST "https://akash.swayambhu.dev/upload?filename=test.tar.gz" \
  -H "Authorization: Bearer $COMPUTER_API_KEY" \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @/tmp/test.tar.gz
```

Then execute extraction:

```bash
curl -X POST "https://akash.swayambhu.dev/execute?wait=30" \
  -H "Authorization: Bearer $COMPUTER_API_KEY" \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"command":"mkdir -p /tmp/job-smoke && tar xz -f /tmp/compute-uploads/test.tar.gz -C /tmp/job-smoke && ls -la /tmp/job-smoke"}'
```

## Deployment Note

The compute server must be redeployed on Akash after `/upload` is added. The Worker-side changes in this repo are not sufficient on their own because `providers/compute.js` will begin calling `POST /upload` before `POST /execute`.

Deploy in this order:

1. Deploy the compute server with the new `/upload` endpoint.
2. Verify `/upload` works on Akash with the curl smoke test above.
3. Deploy the Worker code that includes `providers/compute.js` and `tools/start_job.js`.

If the Worker deploys first, `start_job` will fail immediately with `404` or `500` from the old compute server.
