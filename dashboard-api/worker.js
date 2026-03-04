// Swayambhu Dashboard API — stateless KV reader for operator dashboard

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Operator-Key",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function auth(request, env) {
  const key = request.headers.get("X-Operator-Key");
  return key && key === env.OPERATOR_KEY;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight — no auth
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // All other routes require auth
    if (!auth(request, env)) {
      return json({ error: "unauthorized" }, 401);
    }

    // GET /health — system status snapshot
    if (path === "/health") {
      const [sessionCounter, wakeConfig, lastReflect, session] =
        await Promise.all([
          env.KV.get("session_counter", "json"),
          env.KV.get("wake_config", "json"),
          env.KV.get("last_reflect", "json"),
          env.KV.get("session", "json"),
        ]);
      return json({ sessionCounter, wakeConfig, lastReflect, session });
    }

    // GET /kv — cached key index, optional ?prefix= filter
    if (path === "/kv") {
      const index = await env.KV.get("cache:kv_index", "json");
      if (!index) return json({ keys: [] });
      const prefix = url.searchParams.get("prefix");
      const keys = prefix
        ? index.filter((e) => e.key.startsWith(prefix))
        : index;
      return json({ keys });
    }

    // GET /kv/multi — batch read: ?keys=key1,key2,key3
    if (path === "/kv/multi") {
      const raw = url.searchParams.get("keys");
      if (!raw) return json({ error: "missing ?keys param" }, 400);
      const keyList = raw.split(",").map((k) => decodeURIComponent(k.trim()));
      const results = {};
      await Promise.all(
        keyList.map(async (key) => {
          const value = await env.KV.get(key, "json");
          results[key] = value;
        })
      );
      return json(results);
    }

    // GET /kv/:key — single key read
    const kvMatch = path.match(/^\/kv\/(.+)$/);
    if (kvMatch && path !== "/kv/multi") {
      const key = decodeURIComponent(kvMatch[1]);
      const value = await env.KV.get(key, "json");
      if (value === null) {
        // Try as text fallback
        const text = await env.KV.get(key, "text");
        if (text === null) return json({ error: "not found" }, 404);
        return json({ key, value: text, type: "text" });
      }
      return json({ key, value, type: "json" });
    }

    return json({ error: "not found" }, 404);
  },
};
