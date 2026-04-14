export const meta = {
  secrets: ["ISHA_PUBLICATIONS_PASSWORD"],
  kv_access: "none",
  timeout_ms: 30000,
};

const ORIGIN_HOST = "publications.isha.in";
const ORIGIN_IP = "74.225.238.109";
const LOGIN = "swayambhu";
const MAX_RESULTS = 10;
const MAX_FETCH_CHUNKS = 8;
const MAX_FETCH_CHARS = 40000;

function stripHighlightMarkup(text) {
  return String(text || "").replaceAll("<mark>", "").replaceAll("</mark>", "");
}

function buildHeaders() {
  return {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "Host": ORIGIN_HOST,
    "User-Agent": "swayambhu-publications-kb/1.0",
  };
}

async function postJson(fetchFn, path, payload) {
  let response;
  try {
    response = await fetchFn(`https://${ORIGIN_HOST}${path}`, {
      method: "POST",
      headers: buildHeaders(),
      cf: {
        resolveOverride: ORIGIN_IP,
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    return { success: false, error: `fetch failed: ${error.message || String(error)}` };
  }

  let text = "";
  try {
    text = await response.text();
  } catch {}

  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  if (!response.ok) {
    return {
      success: false,
      status: response.status,
      error: json?.error || `Publications API error (${response.status})`,
      body: text ? text.slice(0, 400) : "",
    };
  }

  return { success: true, data: json };
}

function authPayload(password, extra = {}) {
  return {
    login: LOGIN,
    password,
    ...extra,
  };
}

function normalizeSearchResult(item) {
  return {
    contentid: item?.contentid || null,
    title: (item?.title || "").replace(/\s+/g, " ").trim(),
    published: item?.published || null,
    type: item?.type || null,
    language: item?.language || null,
    info: item?.info || null,
    length: item?.length ?? null,
    weight: item?.weight ?? null,
  };
}

async function search(fetchFn, password, {
  query,
  page = 1,
  type = "all",
  language = "all",
  limit = 5,
}) {
  if (!query) return { success: false, error: "query is required" };

  const result = await postJson(fetchFn, "/api/search", authPayload(password, {
    query,
    page: Math.max(1, Number(page) || 1),
    type,
    language,
  }));
  if (!result.success) return result;

  const capped = Math.min(Math.max(Number(limit) || 5, 1), MAX_RESULTS);
  const data = result.data || {};
  return {
    success: true,
    action: "search",
    query: data.query || query,
    sanitized_query: data.sanitized_query || null,
    page: data.page ?? 1,
    per_page: data.per_page ?? null,
    total: data.total ?? null,
    results: (data.results || []).slice(0, capped).map(normalizeSearchResult),
  };
}

async function details(fetchFn, password, {
  contentid,
  query,
  offset = 0,
  max_chars = 6000,
}) {
  if (!contentid) return { success: false, error: "contentid is required" };
  if (!query) return { success: false, error: "query is required" };

  const result = await postJson(fetchFn, "/api/details", authPayload(password, {
    contentid,
    query,
    offset: Math.max(0, Number(offset) || 0),
    max_chars: Math.max(1000, Math.min(Number(max_chars) || 6000, 12000)),
  }));
  if (!result.success) return result;

  const data = result.data || {};
  return {
    success: true,
    action: "details",
    contentid,
    title: data.title || null,
    metadata: data.metadata || null,
    content: stripHighlightMarkup(data.content || ""),
    offset: data.offset ?? 0,
    next_offset: data.next_offset ?? null,
    has_more: Boolean(data.has_more),
  };
}

async function fetchTranscript(fetchFn, password, {
  contentid,
  query,
  chunk_size = 8000,
  max_chunks = MAX_FETCH_CHUNKS,
}) {
  if (!contentid) return { success: false, error: "contentid is required" };
  if (!query) return { success: false, error: "query is required" };

  const limitChunks = Math.max(1, Math.min(Number(max_chunks) || MAX_FETCH_CHUNKS, MAX_FETCH_CHUNKS));
  const maxChars = Math.max(1000, Math.min(Number(chunk_size) || 8000, 12000));

  let offset = 0;
  let title = null;
  let metadata = null;
  const chunks = [];
  let hasMore = false;

  for (let i = 0; i < limitChunks; i++) {
    const part = await details(fetchFn, password, {
      contentid,
      query,
      offset,
      max_chars: maxChars,
    });
    if (!part.success) return part;

    title = title || part.title;
    metadata = metadata || part.metadata;
    chunks.push(part.content || "");
    hasMore = part.has_more;

    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (!part.has_more || totalLength >= MAX_FETCH_CHARS) break;
    offset = Number(part.next_offset || 0);
  }

  const content = chunks.join("");
  return {
    success: true,
    action: "fetch",
    contentid,
    title,
    metadata,
    content,
    chunks_fetched: chunks.length,
    truncated: hasMore || content.length >= MAX_FETCH_CHARS,
  };
}

export async function execute({ action = "search", query, contentid, page, type, language, limit, offset, max_chars, chunk_size, max_chunks, secrets, fetch }) {
  const password = secrets?.ISHA_PUBLICATIONS_PASSWORD;
  if (!password) {
    return { success: false, error: "ISHA_PUBLICATIONS_PASSWORD not configured" };
  }

  if (action === "search") {
    return search(fetch, password, { query, page, type, language, limit });
  }
  if (action === "details") {
    return details(fetch, password, { contentid, query, offset, max_chars });
  }
  if (action === "fetch") {
    return fetchTranscript(fetch, password, { contentid, query, chunk_size, max_chunks });
  }

  return { success: false, error: `invalid action: ${action}. Use search, details, or fetch` };
}
