export const meta = {
  secrets: ["OPENROUTER_API_KEY"],
  kv_access: "none",
  timeout_ms: 30000,
  provider: "llm",
};

export async function execute({ model_id, prompt, max_tokens, secrets, fetch, provider }) {
  if (!model_id) return { success: false, error: "model_id is required" };
  if (!prompt) return { success: false, error: "prompt is required" };
  if (prompt.length > 1000) return { success: false, error: "prompt exceeds 1000 char limit" };
  const cappedTokens = Math.min(max_tokens || 100, 500);

  const start = Date.now();
  try {
    const result = await provider.call({
      model: model_id,
      messages: [{ role: "user", content: prompt }],
      max_tokens: cappedTokens,
      secrets,
      fetch,
    });
    return {
      success: true,
      response_text: result.content,
      usage: result.usage,
      latency_ms: Date.now() - start,
      error: null,
    };
  } catch (err) {
    return {
      success: false,
      response_text: null,
      usage: null,
      latency_ms: Date.now() - start,
      error: err.message || String(err),
    };
  }
}
