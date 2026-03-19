export const meta = { secrets: ["OPENROUTER_API_KEY"], timeout_ms: 60000 };

const families = {
  anthropic: (body) => {
    body.cache_control = { type: 'ephemeral' };
  },
};

export async function call({ model, messages, max_tokens, effort, family, tools, secrets, fetch }) {
  const body = { model, max_tokens, messages };
  const adapt = family ? families[family] : null;
  if (adapt) adapt(body);
  if (effort) body.reasoning = { effort };
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
    content: (msg?.content || "").trim(),
    usage: data.usage || {},
    toolCalls: msg?.tool_calls || null,
  };
}
