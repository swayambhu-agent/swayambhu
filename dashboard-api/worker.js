// Swayambhu Dashboard API — stateless KV reader for operator dashboard

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
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

    // GET /sessions — discover all sessions (act + deep reflect)
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
          type: deepReflectIds.has(id) ? "deep_reflect" : "act",
          ts: k.metadata?.updated_at || null,
        };
      });

      // Sort by session ID (contains timestamp) — newest last
      sessions.sort((a, b) => a.id.localeCompare(b.id));

      return json({ sessions });
    }

    // ── Chat helpers ──────────────────────────────────────────
    // Resolve unique user IDs from chat messages to contact names
    async function resolveParticipants(env, messages) {
      const userIds = [...new Set(
        (messages || []).filter(m => m.userId).map(m => m.userId)
      )];
      const participants = {};
      await Promise.all(userIds.map(async (uid) => {
        try {
          const raw = await env.KV.get(`contact_index:slack:${uid}`, "text");
          const slug = raw ? raw.replace(/^"|"$/g, '') : null;
          if (slug) {
            const contact = await env.KV.get(`contact:${slug}`, "json");
            if (contact?.name) { participants[uid] = contact.name; return; }
          }
        } catch {}
        participants[uid] = uid; // fallback to raw ID
      }));
      return participants;
    }

    // GET /chats — list all chat conversations
    if (path === "/chats") {
      const chatKeys = await kvListAll(env.KV, { prefix: "chat:" });
      const chats = await Promise.all(
        chatKeys.map(async (k) => {
          const data = await env.KV.get(k.name, "json");
          if (!data) return null;
          const participants = await resolveParticipants(env, data.messages);
          return {
            key: k.name,
            channel_id: k.name.split(":").slice(2).join(":"),
            platform: k.name.split(":")[1] || "unknown",
            turn_count: data.turn_count || 0,
            total_cost: data.total_cost || 0,
            created_at: data.created_at || null,
            last_activity: data.last_activity || null,
            message_count: data.messages?.length || 0,
            source_session: data.source_session || null,
            participants,
          };
        })
      );
      return json({ chats: chats.filter(Boolean).sort((a, b) =>
        (b.last_activity || "").localeCompare(a.last_activity || "")
      ) });
    }

    // GET /chat/:platform/:channelId — full chat object + resolved participants
    const chatMatch = path.match(/^\/chat\/(\w+)\/(.+)$/);
    if (chatMatch) {
      const chatKey = `chat:${chatMatch[1]}:${chatMatch[2]}`;
      const data = await env.KV.get(chatKey, "json");
      if (!data) return json({ error: "not found" }, 404);
      const participants = await resolveParticipants(env, data.messages);
      return json({ key: chatKey, chat: data, participants });
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

    // GET /direct — check pending operator direct message
    if (path === "/direct" && request.method === "GET") {
      const val = await env.KV.get("operator:direct", "json");
      return json({ pending: !!val, message: val });
    }

    // POST /direct — send a direct message to the agent (consumed on next wake)
    if (path === "/direct" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (!body?.message || typeof body.message !== "string" || !body.message.trim()) {
        return json({ error: "message required" }, 400);
      }
      await env.KV.put("operator:direct", JSON.stringify({
        message: body.message.trim(),
        sent_at: new Date().toISOString(),
      }));
      return json({ ok: true });
    }

    // DELETE /direct — clear pending direct message
    if (path === "/direct" && request.method === "DELETE") {
      await env.KV.delete("operator:direct");
      return json({ ok: true });
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
        approved: body.approved !== false,
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

    // PATCH /contacts/:slug/approve — set approval status on a contact
    const approveMatch = path.match(/^\/contacts\/([^/]+)\/approve$/);
    if (approveMatch && request.method === "PATCH") {
      const slug = decodeURIComponent(approveMatch[1]);
      const contactKey = `contact:${slug}`;
      const existing = await env.KV.get(contactKey, "json");
      if (!existing) return json({ error: `contact "${slug}" not found` }, 404);

      const body = await request.json().catch(() => null);
      if (body?.approved === undefined || typeof body.approved !== "boolean") {
        return json({ error: "body must include { approved: true|false }" }, 400);
      }

      existing.approved = body.approved;
      existing.approved_at = new Date().toISOString();
      existing.approved_by = "patron";
      await env.KV.put(contactKey, JSON.stringify(existing), {
        metadata: { type: "contact", format: "json", updated_at: new Date().toISOString() },
      });

      // Rebuild contact_index entries for current platforms
      if (existing.platforms && typeof existing.platforms === "object") {
        for (const [platform, userId] of Object.entries(existing.platforms)) {
          const indexKey = `contact_index:${platform}:${userId}`;
          await env.KV.put(indexKey, JSON.stringify(slug), {
            metadata: { type: "contact_index", format: "json", updated_at: new Date().toISOString() },
          });
        }
      }

      return json({ ok: true, slug, approved: body.approved });
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
