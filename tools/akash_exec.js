export const meta = { secrets: ["AKASH_CF_CLIENT_ID", "AKASH_API_KEY"], kv_access: "none", timeout_ms: 300000 };

const BASE = "https://akash.swayambhu.dev";

export async function execute({ command, timeout, secrets, fetch }) {
  if (!command) return { ok: false, error: "command is required" };

  const headers = {
    "Content-Type": "application/json",
    "cf-access-client-id": secrets.AKASH_CF_CLIENT_ID,
    "Authorization": `Bearer ${secrets.AKASH_API_KEY}`,
  };

  const wait = timeout || 60;

  let resp;
  try {
    resp = await fetch(`${BASE}/execute?wait=${wait}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ command }),
    });
  } catch (e) {
    return { ok: false, error: `fetch failed: ${e.message || String(e)}` };
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    return { ok: false, error: `${resp.status} ${resp.statusText}`, detail: body };
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
