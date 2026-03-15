// Swayambhu Dashboard API — stateless KV reader for operator dashboard

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
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

async function kvListAll(kv, opts = {}) {
  const keys = [];
  let cursor;
  let pages = 0;
  do {
    const result = await kv.list({ ...opts, cursor });
    keys.push(...result.keys);
    cursor = result.list_complete ? undefined : result.cursor;
    if (++pages > 100) { console.error("[DASHBOARD] kvListAll: hit 100-page safety limit"); break; }
  } while (cursor);
  return keys;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight — no auth
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // GET /reflections — public, no auth required
    if (path === "/reflections") {
      const allKeys = await kvListAll(env.KV, { prefix: "reflect:1:" });
      const keys = allKeys
        .filter(k => !k.name.startsWith("reflect:1:schedule"))
        .sort((a, b) => b.name.localeCompare(a.name));
      const reflections = await Promise.all(
        keys.slice(0, 20).map(async (k) => {
          const data = await env.KV.get(k.name, "json");
          if (!data) return null;
          return {
            session_id: data.session_id,
            timestamp: data.timestamp,
            reflection: data.reflection,
            note_to_future_self: data.note_to_future_self,
          };
        })
      );
      return json({ reflections: reflections.filter(Boolean) });
    }

    // All other routes require auth
    if (!auth(request, env)) {
      return json({ error: "unauthorized" }, 401);
    }

    // GET /health — system status snapshot
    if (path === "/health") {
      const [sessionCounter, wakeConfig, lastReflect, activeSession, session] =
        await Promise.all([
          env.KV.get("session_counter", "json"),
          env.KV.get("wake_config", "json"),
          env.KV.get("last_reflect", "json"),
          env.KV.get("kernel:active_session", "text"),
          env.KV.get("session", "text"),
        ]);
      return json({ sessionCounter, wakeConfig, lastReflect, session: activeSession || session });
    }

    // GET /sessions — discover all sessions (orient + deep reflect)
    if (path === "/sessions") {
      const [karmaKeys, reflectKeys, cached] = await Promise.all([
        kvListAll(env.KV, { prefix: "karma:" }),
        kvListAll(env.KV, { prefix: "reflect:1:" }),
        env.KV.get("cache:session_ids", "json"),
      ]);

      // Build set of deep reflect session IDs from reflect:1:* keys
      const deepReflectIds = new Set(
        reflectKeys.map(k => k.name.replace("reflect:1:", ""))
      );

      // Build session list from karma keys (ground truth)
      const sessions = karmaKeys.map(k => {
        const id = k.name.replace("karma:", "");
        return {
          id,
          type: deepReflectIds.has(id) ? "deep_reflect" : "orient",
          ts: k.metadata?.updated_at || null,
        };
      });

      // Sort by session ID (contains timestamp) — newest last
      sessions.sort((a, b) => a.id.localeCompare(b.id));

      return json({ sessions });
    }

    // GET /kv — key listing, optional ?prefix= filter
    //   Always uses live KV.list() — no cache dependency.
    if (path === "/kv") {
      const prefix = url.searchParams.get("prefix") || undefined;
      const allKeys = await kvListAll(env.KV, { prefix });
      const keys = allKeys.map(k => ({ key: k.name, metadata: k.metadata }));
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
          const { value, metadata } = await env.KV.getWithMetadata(key, "text");
          if (value === null) { results[key] = null; return; }
          const format = metadata?.format || "json";
          if (format === "json") {
            try { results[key] = JSON.parse(value); return; } catch {}
          }
          results[key] = value;
        })
      );
      return json(results);
    }

    // GET /quarantine — list quarantined inbound messages (sealed:* keys, patron-only)
    if (path === "/quarantine") {
      const allKeys = await kvListAll(env.KV, { prefix: "sealed:quarantine:" });
      const items = await Promise.all(
        allKeys.map(async (k) => {
          const value = await env.KV.get(k.name, "json");
          return value ? { key: k.name, ...value } : null;
        })
      );
      return json({ items: items.filter(Boolean).sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || "")) });
    }

    // POST /contacts — create a new contact record
    if (path === "/contacts" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (!body?.slug || !body?.name || !body?.platforms) {
        return json({ error: "missing required fields: slug, name, platforms" }, 400);
      }
      if (typeof body.platforms !== "object" || Array.isArray(body.platforms)) {
        return json({ error: "platforms must be an object (e.g. { email: 'user@example.com' })" }, 400);
      }
      const invalidPlatforms = Object.entries(body.platforms).filter(([k, v]) => !k || !v || typeof v !== "string");
      if (invalidPlatforms.length) {
        return json({ error: `invalid platform entries: ${invalidPlatforms.map(([k]) => k || "(empty)").join(", ")}` }, 400);
      }
      const contactKey = `contact:${body.slug}`;
      const existing = await env.KV.get(contactKey, "json");
      if (existing) return json({ error: `contact "${body.slug}" already exists` }, 409);

      const contact = {
        name: body.name,
        platforms: body.platforms,
        relationship: body.relationship || "",
        notes: body.notes || "",
        created_at: new Date().toISOString(),
        created_by: "patron",
      };
      await env.KV.put(contactKey, JSON.stringify(contact), {
        metadata: { type: "contact", format: "json", updated_at: new Date().toISOString() },
      });

      // Write contact index entries for each platform
      for (const [platform, userId] of Object.entries(body.platforms)) {
        const indexKey = `contact_index:${platform}:${userId}`;
        await env.KV.put(indexKey, JSON.stringify(body.slug), {
          metadata: { type: "contact_index", format: "json", updated_at: new Date().toISOString() },
        });
      }

      return json({ ok: true, slug: body.slug, contact });
    }

    // DELETE /quarantine/:key — remove a quarantine entry after patron review
    const quarantineMatch = path.match(/^\/quarantine\/(.+)$/);
    if (quarantineMatch && request.method === "DELETE") {
      const key = decodeURIComponent(quarantineMatch[1]);
      if (!key.startsWith("sealed:quarantine:")) {
        return json({ error: "can only delete quarantine entries" }, 400);
      }
      await env.KV.delete(key);
      return json({ ok: true });
    }

    // GET /kv/:key — single key read
    const kvMatch = path.match(/^\/kv\/(.+)$/);
    if (kvMatch && path !== "/kv/multi") {
      const key = decodeURIComponent(kvMatch[1]);
      const { value, metadata } = await env.KV.getWithMetadata(key, "text");
      if (value === null) return json({ error: "not found" }, 404);
      const format = metadata?.format || "json";
      if (format === "json") {
        try { return json({ key, value: JSON.parse(value), type: "json" }); } catch {}
      }
      return json({ key, value, type: "text" });
    }

    return json({ error: "not found" }, 404);
  },
};
