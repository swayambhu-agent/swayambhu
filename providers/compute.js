// Compute target adapter — HTTP call, auth, error handling for remote command execution.
// Used by computer, start_job, and collect_jobs tools via provider injection.
// No `export default` — required for wrapAsModule compatibility.

export const meta = {
  secrets: ["CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "COMPUTER_API_KEY"],
  timeout_ms: 300000,
};

export async function call({ command, baseUrl, timeout, secrets, fetch }) {
  if (!command) return { ok: false, error: "command is required" };

  const headers = {
    "Content-Type": "application/json",
    "CF-Access-Client-Id": secrets.CF_ACCESS_CLIENT_ID,
    "CF-Access-Client-Secret": secrets.CF_ACCESS_CLIENT_SECRET,
    "Authorization": `Bearer ${secrets.COMPUTER_API_KEY}`,
  };

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
