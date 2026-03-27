// Gnanetra — Sadhguru transcript knowledge base tool
// Hosted on Google Vertex AI, accessed via LiteLLM on ashram LAN.
// API shape TBD — validate when back at ashram with LAN access.
// No `export default`.

export const meta = {
  secrets: ["GNANETRA_API_URL", "GNANETRA_API_KEY"],
  kv_access: "none",
  timeout_ms: 30000,
};

export async function execute({ query, limit, secrets, fetch }) {
  const baseUrl = secrets.GNANETRA_API_URL;
  if (!baseUrl) return { error: "GNANETRA_API_URL not configured" };

  const headers = {
    "Content-Type": "application/json",
  };
  if (secrets.GNANETRA_API_KEY) {
    headers["Authorization"] = `Bearer ${secrets.GNANETRA_API_KEY}`;
  }

  // LiteLLM-compatible request — adjust after validating actual API shape
  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "gnanetra",
      messages: [{ role: "user", content: query }],
      max_tokens: limit || 2000,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    return { error: `Gnanetra API error (${resp.status}): ${text}` };
  }

  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content;

  return {
    success: true,
    content,
    query,
    model: data.model || "gnanetra",
    usage: data.usage || null,
  };
}
