export const meta = {
  secrets: ["BRAVE_SEARCH_API_KEY"],
  kv_access: "none",
  timeout_ms: 15000,
};

const FRESHNESS_MAP = { day: "pd", week: "pw", month: "pm", year: "py" };
const MAX_RESPONSE_CHARS = 8000;

export async function execute({ query, count, freshness, deep, secrets, fetch }) {
  if (!query) return { success: false, error: "query is required" };

  const apiKey = secrets?.BRAVE_SEARCH_API_KEY;
  if (!apiKey) return { success: false, error: "BRAVE_SEARCH_API_KEY not configured" };

  const resultCount = Math.min(Math.max(count || 5, 1), 20);
  const mappedFreshness = freshness ? FRESHNESS_MAP[freshness] : null;
  if (freshness && !mappedFreshness) {
    return { success: false, error: `invalid freshness value: ${freshness}. Use: day, week, month, year` };
  }

  const endpoint = deep
    ? "https://api.search.brave.com/res/v1/llm/context"
    : "https://api.search.brave.com/res/v1/web/search";

  const params = new URLSearchParams({
    q: query,
    count: String(resultCount),
    text_decorations: "false",
  });
  if (mappedFreshness) params.set("freshness", mappedFreshness);
  if (deep) params.set("maximum_number_of_tokens", "4096");

  const url = `${endpoint}?${params}`;

  let resp;
  try {
    resp = await fetch(url, {
      headers: { "Accept": "application/json", "X-Subscription-Token": apiKey },
    });
  } catch (err) {
    return { success: false, error: `fetch failed: ${err.message || String(err)}` };
  }

  if (!resp.ok) {
    const status = resp.status;
    if (status === 401) return { success: false, error: "invalid API key (401)" };
    if (status === 429) {
      const retryAfter = resp.headers?.get?.("retry-after") || null;
      return { success: false, error: "rate limited (429)", retry_after: retryAfter };
    }
    return { success: false, error: `Brave API error (${status})` };
  }

  let data;
  try {
    data = await resp.json();
  } catch {
    return { success: false, error: "failed to parse Brave API response" };
  }

  // Extract web results
  const webResults = (data.web?.results || []).map(r => ({
    title: r.title || "",
    url: r.url || "",
    snippet: r.description || "",
    age: r.age || null,
    hostname: r.meta_url?.hostname || new URL(r.url).hostname,
  }));

  // Extract infobox
  const rawInfobox = data.infobox?.results?.[0];
  const infobox = rawInfobox ? {
    title: rawInfobox.title || "",
    description: rawInfobox.description || rawInfobox.long_desc || "",
    url: rawInfobox.url || null,
    attributes: rawInfobox.attributes || [],
  } : null;

  // Extract deep context (LLM Context endpoint only)
  let context = null;
  if (deep && data.summarizer?.results?.length) {
    context = data.summarizer.results.map(r => r.text).join("\n\n");
  }

  const output = {
    success: true,
    results: webResults,
    infobox,
    context,
    query,
    result_count: webResults.length,
  };

  // Truncate if response is too large
  let serialized = JSON.stringify(output);
  if (serialized.length > MAX_RESPONSE_CHARS) {
    // First: trim snippets
    for (const r of output.results) {
      if (r.snippet.length > 200) r.snippet = r.snippet.slice(0, 200) + "...";
    }
    // Trim context
    if (output.context && output.context.length > 3000) {
      output.context = output.context.slice(0, 3000) + "...[truncated]";
    }
    serialized = JSON.stringify(output);
    // Last resort: drop results from the end
    while (serialized.length > MAX_RESPONSE_CHARS && output.results.length > 1) {
      output.results.pop();
      output.result_count = output.results.length;
      serialized = JSON.stringify(output);
    }
  }

  return output;
}
