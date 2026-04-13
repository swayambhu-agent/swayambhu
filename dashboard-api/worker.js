// Swayambhu Dashboard API — stateless KV reader for patron dashboard

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = new Set([
    "https://swayambhu.dev",
    "https://staging.swayambhu.dev",
    "http://localhost:3001",
    "http://127.0.0.1:3001",
  ]);

  return {
    ...(allowed.has(origin) ? { "Access-Control-Allow-Origin": origin } : {}),
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Credentials": "true",
    "Vary": "Origin",
  };
}

function json(data, status = 200, request = null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...(request ? corsHeaders(request) : {}),
    },
  });
}

function auth(request) {
  const url = new URL(request.url);
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1") return true;

  return Boolean(
    request.headers.get("Cf-Access-Authenticated-User-Email")
      || request.headers.get("CF-Access-Authenticated-User-Email")
      || request.headers.get("Cf-Access-Jwt-Assertion")
      || request.headers.get("CF-Access-Jwt-Assertion")
  );
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

function classifyExecutionType(id, { deepReflectIds, actSessionIds, karma }) {
  if (deepReflectIds.has(id)) return "deep_reflect";
  if (actSessionIds.has(id)) return "act";
  if (!Array.isArray(karma)) return "event_only";
  if (karma.some((entry) => entry?.event === "act_start")) return "act";
  if (karma.some((entry) => entry?.event === "privileged_write")) return "deep_reflect";
  return "event_only";
}

function buildOperatorOutputsFromKvOps(kvOperations = []) {
  const sOutput = [];
  const dOutput = [];

  for (const op of kvOperations) {
    if (op.key?.startsWith("pattern:")) {
      sOutput.push({
        action: op.op === "delete" ? "deleted" : "written",
        key: op.key,
        pattern: op.value?.pattern,
        strength: op.value?.strength,
      });
    }
    if (op.key?.startsWith("desire:")) {
      dOutput.push({
        action: op.op === "delete" ? "retired" : "written",
        key: op.key,
        description: op.value?.description,
        direction: op.value?.direction,
        source_principles: op.value?.source_principles,
      });
    }
  }

  return { sOutput, dOutput };
}

function buildOperatorOutputsFromKarma(drKarma = []) {
  const sOutput = [];
  const dOutput = [];

  for (const entry of drKarma) {
    if (entry?.event !== "privileged_write" || !entry.key) continue;
    const action = entry.op === "delete"
      ? (entry.key.startsWith("desire:") ? "retired" : "deleted")
      : "written";

    if (entry.key.startsWith("pattern:")) {
      sOutput.push({
        action,
        key: entry.key,
        pattern: entry.new_value?.pattern || null,
        strength: entry.new_value?.strength ?? null,
      });
    }
    if (entry.key.startsWith("desire:")) {
      dOutput.push({
        action,
        key: entry.key,
        description: entry.new_value?.description || null,
        direction: entry.new_value?.direction || null,
        source_principles: entry.new_value?.source_principles || null,
      });
    }
  }

  return { sOutput, dOutput };
}

function requestStatusRank(status) {
  return ({ pending: 0, fulfilled: 1, rejected: 2 }[status] ?? 9);
}

async function resolveRequesterName(env, request) {
  const directName = request?.requester?.name || request?.contact_name;
  if (directName) return directName;
  const contactId = request?.requester?.type === "contact" ? request?.requester?.id : request?.contact;
  if (!contactId) return null;
  try {
    const contact = await env.KV.get(`contact:${contactId}`, "json");
    if (contact?.name) return contact.name;
  } catch {}
  return contactId;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const reply = (data, status = 200) => json(data, status, request);

    // CORS preflight — no auth
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    // GET /pulse — lightweight change indicator, no auth (no sensitive data)
    if (path === "/pulse") {
      const pulse = await env.KV.get("kernel:pulse", "json");
      return reply(pulse || { v: 1, n: 0, changed: [] });
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
      return reply({ reflections: reflections.filter(Boolean) });
    }

    // All other routes require auth
    if (!auth(request)) {
      return reply({ error: "unauthorized" }, 401);
    }

    // GET /health — system status snapshot
    if (path === "/health") {
      const [sessionCounter, schedule, lastReflect, activeSession, session] =
        await Promise.all([
          env.KV.get("session_counter", "json"),
          env.KV.get("session_schedule", "json"),
          env.KV.get("last_reflect", "json"),
          env.KV.get("kernel:active_session", "text"),
          env.KV.get("session", "text"),
        ]);
      return reply({ sessionCounter, schedule, lastReflect, session: activeSession || session });
    }

    // GET /mind — cognitive state snapshot (patterns, desires, experiences, operator health)
    if (path === "/mind") {
      const [
        patternKeys, desireKeys, experienceKeys, principleKeys, tacticKeys,
        reflectSchedule, drState, sessionCounter,
      ] = await Promise.all([
        kvListAll(env.KV, { prefix: "pattern:" }),
        kvListAll(env.KV, { prefix: "desire:" }),
        kvListAll(env.KV, { prefix: "experience:" }),
        kvListAll(env.KV, { prefix: "principle:" }),
        kvListAll(env.KV, { prefix: "tactic:" }),
        env.KV.get("reflect:schedule:1", "json"),
        env.KV.get("dr:state:1", "json"),
        env.KV.get("session_counter", "json"),
      ]);

      // Batch read all values
      const allKeys = [
        ...patternKeys.map(k => k.name),
        ...desireKeys.map(k => k.name),
        ...experienceKeys.map(k => k.name).slice(-20),
        ...principleKeys.map(k => k.name),
        ...tacticKeys.map(k => k.name),
      ];

      const values = {};
      await Promise.all(allKeys.map(async (key) => {
        // principle:* values may be plain strings, not JSON
        if (key.startsWith("principle:")) {
          const val = await env.KV.get(key);
          if (val) values[key] = val;
        } else {
          const val = await env.KV.get(key, "json");
          if (val) values[key] = val;
        }
      }));

      const patterns = patternKeys
        .map(k => ({ key: k.name, ...values[k.name] }))
        .filter(s => s.pattern);

      const desires = desireKeys
        .map(k => ({ key: k.name, ...values[k.name] }))
        .filter(d => d.description || d.slug);

      const experiences = experienceKeys
        .slice(-20)
        .map(k => ({ key: k.name, ...values[k.name] }))
        .filter(e => e.observation || e.text_rendering?.narrative || e.action_ref)
        .reverse();

      const principles = principleKeys
        .map(k => {
          const val = values[k.name];
          return { key: k.name, text: typeof val === 'string' ? val : (val?.text || JSON.stringify(val)) };
        })
        .filter(p => p.text);

      const tactics = tacticKeys
        .map(k => ({ key: k.name, ...values[k.name] }))
        .filter(t => t.slug || t.description);

      // Find latest deep-reflect output
      const reflectKeys = await kvListAll(env.KV, { prefix: "reflect:1:" });
      const latestReflectKey = reflectKeys
        .filter(k => !k.name.includes("schedule"))
        .sort((a, b) => b.name.localeCompare(a.name))[0];
      const latestReflect = latestReflectKey
        ? await env.KV.get(latestReflectKey.name, "json")
        : null;

      const lastDrSession = drState?.last_applied_session ?? reflectSchedule?.last_reflect_session ?? 0;
      const currentSession = sessionCounter || 0;
      const sessionsSinceDr = currentSession - lastDrSession;
      const nextDrDue = drState?.next_due_session ?? (reflectSchedule?.after_sessions
        ? lastDrSession + reflectSchedule.after_sessions
        : null);

      const operatorHealth = {
        bootstrap_complete: patterns.length > 0 || desires.length > 0,
        last_deep_reflect_session: lastDrSession,
        sessions_since_dr: sessionsSinceDr,
        next_dr_due: nextDrDue,
        deep_reflect_status: drState?.status || null,
        deep_reflect_generation: drState?.generation ?? null,
        last_reflect_output: latestReflect ? {
          session_id: latestReflect.session_id,
          reflection: latestReflect.reflection?.slice(0, 200),
          has_kv_operations: !!(latestReflect.kv_operations?.length),
        } : null,
      };

      return reply({ principles, tactics, patterns, desires, experiences, operator_health: operatorHealth });
    }

    // GET /deep-reflect/:sessionId — structured DR execution data
    const drMatch = path.match(/^\/deep-reflect\/(.+)$/);
    if (drMatch) {
      const drSessionId = decodeURIComponent(drMatch[1]);

      // Load DR output
      const drOutput = await env.KV.get(`reflect:1:${drSessionId}`, "json");
      if (!drOutput) return reply({ error: "DR session not found" }, 404);

      // Load DR karma
      const drKarma = await env.KV.get(`karma:${drSessionId}`, "json");

      // Find the previous DR to determine accumulation period
      const allReflectKeys = await kvListAll(env.KV, { prefix: "reflect:1:" });
      const drSessionIds = allReflectKeys
        .filter(k => !k.name.includes("schedule"))
        .map(k => k.name.replace("reflect:1:", ""))
        .sort();
      const drIndex = drSessionIds.indexOf(drSessionId);
      const prevDrSessionId = drIndex > 0 ? drSessionIds[drIndex - 1] : null;

      // Load all session IDs from karma keys
      const [allKarmaKeys, cachedActSessions] = await Promise.all([
        kvListAll(env.KV, { prefix: "karma:" }),
        env.KV.get("cache:session_ids", "json"),
      ]);
      const allSessionIds = allKarmaKeys.map(k => k.name.replace("karma:", "")).sort();
      const actSessionIds = Array.isArray(cachedActSessions) ? [...cachedActSessions].sort() : [];

      // Find act sessions in the accumulation period
      const actSessions = actSessionIds.filter(id => {
        if (prevDrSessionId && id <= prevDrSessionId) return false;
        if (id > drSessionId) return false;
        return true;
      });

      // Load experiences from the accumulation period
      const experienceKeys = await kvListAll(env.KV, { prefix: "experience:" });
      const periodExperiences = [];
      for (const ek of experienceKeys) {
        const exp = await env.KV.get(ek.name, "json");
        if (!exp) continue;
        periodExperiences.push({ key: ek.name, ...exp });
      }
      periodExperiences.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));

      // Compute accumulation stats from act session karma (sample last 20)
      let evalCount = 0, tier3Count = 0;
      for (const sid of actSessions.slice(-20)) {
        const karma = await env.KV.get(`karma:${sid}`, "json");
        if (!karma) continue;
        for (const entry of karma) {
          if (entry.event === 'llm_call' && entry.step?.includes('eval_tier3')) tier3Count++;
          if (entry.event === 'llm_call' && entry.step?.includes('eval')) evalCount++;
        }
      }

      const { sOutput, dOutput } = Array.isArray(drOutput.kv_operations) && drOutput.kv_operations.length > 0
        ? buildOperatorOutputsFromKvOps(drOutput.kv_operations)
        : buildOperatorOutputsFromKarma(drKarma);

      // DR execution cost and model from karma, duration from dr:state
      let cost = 0, durationMs = 0, model = null;
      const drState = await env.KV.get("dr:state:1", "json");
      if (drState?.dispatched_at && drState?.completed_at) {
        durationMs = new Date(drState.completed_at) - new Date(drState.dispatched_at);
      }
      if (drKarma) {
        for (const entry of drKarma) {
          if (entry.cost) cost += entry.cost;
          if (entry.event === 'llm_call' && entry.model) model = entry.model;
        }
      }

      return reply({
        session_id: drSessionId,
        accumulation: {
          act_sessions: actSessions.length,
          experiences_total: periodExperiences.length,
          eval_count: evalCount,
          tier3_fallbacks: tier3Count,
          period: {
            from_session: actSessions[0] || null,
            to_session: actSessions[actSessions.length - 1] || null,
          },
        },
        experiences: periodExperiences.slice(0, 20).map(e => ({
          key: e.key,
          surprise_score: e.pattern_delta?.sigma ?? e.surprise_score,
          salience: e.salience,
          observation: e.observation,
          desire_alignment: e.desire_alignment,
          narrative: e.text_rendering?.narrative,
          action_ref: e.action_ref,
          timestamp: e.timestamp,
        })),
        execution: {
          reflection: drOutput.reflection,
          note_to_future_self: drOutput.note_to_future_self,
          s_output: sOutput,
          d_output: dOutput,
          cost: Math.round(cost * 10000) / 10000,
          duration_ms: durationMs,
          model,
          karma_count: drKarma?.length || 0,
        },
      });
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

      const actSessionIds = new Set(Array.isArray(cached) ? cached : []);

      // Build execution list from karma keys, distinguishing act, deep-reflect, and event-only runs.
      const sessions = await Promise.all(karmaKeys.map(async (k) => {
        const id = k.name.replace("karma:", "");
        const karma = !deepReflectIds.has(id) && !actSessionIds.has(id)
          ? await env.KV.get(k.name, "json")
          : null;
        return {
          id,
          type: classifyExecutionType(id, { deepReflectIds, actSessionIds, karma }),
          ts: k.metadata?.updated_at || null,
        };
      }));

      // Sort by session ID (contains timestamp) — newest last
      sessions.sort((a, b) => a.id.localeCompare(b.id));

      return reply({ sessions });
    }

    // GET /requests — durable work request list + status summary
    if (path === "/requests") {
      const requestKeys = await kvListAll(env.KV, { prefix: "session_request:" });
      const requests = await Promise.all(
        requestKeys.map(async (k) => {
          const value = await env.KV.get(k.name, "json");
          if (!value) return null;
          return {
            key: k.name,
            id: value.id || k.name.replace("session_request:", ""),
            source: value.source || null,
            status: value.status || "pending",
            summary: value.summary || "",
            note: value.note || null,
            result: value.result || null,
            error: value.error || null,
            ref: value.ref || null,
            next_session: value.next_session || null,
            requester: value.requester || null,
            requester_name: await resolveRequesterName(env, value),
            created_at: value.created_at || null,
            updated_at: value.updated_at || value.created_at || null,
          };
        }),
      );

      const filtered = requests
        .filter(Boolean)
        .sort((a, b) => {
          const rankDiff = requestStatusRank(a.status) - requestStatusRank(b.status);
          if (rankDiff !== 0) return rankDiff;
          return String(b.updated_at || "").localeCompare(String(a.updated_at || ""));
        });

      const summary = {
        total: filtered.length,
        pending: filtered.filter((item) => item.status === "pending").length,
        fulfilled: filtered.filter((item) => item.status === "fulfilled").length,
        rejected: filtered.filter((item) => item.status === "rejected").length,
      };

      return reply({ summary, requests: filtered });
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
          const binding = await env.KV.get(`contact_platform:slack:${uid}`, "json");
          const slug = binding?.slug || null;
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
      return reply({ chats: chats.filter(Boolean).sort((a, b) =>
        (b.last_activity || "").localeCompare(a.last_activity || "")
      ) });
    }

    // GET /chat/:platform/:channelId — full chat object + resolved participants
    const chatMatch = path.match(/^\/chat\/(\w+)\/(.+)$/);
    if (chatMatch) {
      const chatKey = `chat:${chatMatch[1]}:${chatMatch[2]}`;
      const data = await env.KV.get(chatKey, "json");
      if (!data) return reply({ error: "not found" }, 404);
      const participants = await resolveParticipants(env, data.messages);
      return reply({ key: chatKey, chat: data, participants });
    }

    // GET /kv — key listing, optional ?prefix= filter
    //   Always uses live KV.list() — no cache dependency.
    if (path === "/kv") {
      const prefix = url.searchParams.get("prefix") || undefined;
      const allKeys = await kvListAll(env.KV, { prefix });
      const keys = allKeys.map(k => ({ key: k.name, metadata: k.metadata }));
      return reply({ keys });
    }

    // GET /kv/multi — batch read: ?keys=key1,key2,key3
    if (path === "/kv/multi") {
      const raw = url.searchParams.get("keys");
      if (!raw) return reply({ error: "missing ?keys param" }, 400);
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
      return reply(results);
    }

    // GET /direct — check pending patron direct messages in inbox
    if (path === "/direct" && request.method === "GET") {
      const allKeys = await kvListAll(env.KV, { prefix: "inbox:" });
      const patronItems = [];
      for (const k of allKeys) {
        if (k.name.includes(":patron:direct")) {
          const val = await env.KV.get(k.name, "json");
          if (val) patronItems.push(val);
        }
      }
      return reply({ pending: patronItems.length > 0, messages: patronItems });
    }

    // POST /direct — send a direct message to the agent via inbox (consumed on next session)
    if (path === "/direct" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (!body?.message || typeof body.message !== "string" || !body.message.trim()) {
        return reply({ error: "message required" }, 400);
      }
      const ts = Date.now().toString().padStart(15, '0');
      await env.KV.put(`inbox:${ts}:patron:direct`, JSON.stringify({
        type: "patron_direct",
        source: { channel: "console" },
        message: body.message.trim(),
        summary: body.message.trim().slice(0, 300),
        timestamp: new Date().toISOString(),
      }), { expirationTtl: 86400 });
      return reply({ ok: true });
    }

    // DELETE /direct — clear pending patron direct messages from inbox
    if (path === "/direct" && request.method === "DELETE") {
      const allKeys = await kvListAll(env.KV, { prefix: "inbox:" });
      for (const k of allKeys) {
        if (k.name.includes(":patron:direct")) {
          await env.KV.delete(k.name);
        }
      }
      return reply({ ok: true });
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
      return reply({ items: items.filter(Boolean).sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || "")) });
    }

    // POST /contacts — create a new contact record
    if (path === "/contacts" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (!body?.slug || !body?.name) {
        return reply({ error: "missing required fields: slug, name" }, 400);
      }
      if (body.platforms && (typeof body.platforms !== "object" || Array.isArray(body.platforms))) {
        return reply({ error: "platforms must be an object (e.g. { email: 'user@example.com' })" }, 400);
      }
      const platforms = body.platforms || {};
      const invalidPlatforms = Object.entries(platforms).filter(([k, v]) => !k || !v || typeof v !== "string");
      if (invalidPlatforms.length) {
        return reply({ error: `invalid platform entries: ${invalidPlatforms.map(([k]) => k || "(empty)").join(", ")}` }, 400);
      }
      const contactKey = `contact:${body.slug}`;
      const existing = await env.KV.get(contactKey, "json");
      if (existing) return reply({ error: `contact "${body.slug}" already exists` }, 409);

      const contact = {
        name: body.name,
        relationship: body.relationship || "",
        notes: body.notes || "",
        created_at: new Date().toISOString(),
        created_by: "patron",
      };
      await env.KV.put(contactKey, JSON.stringify(contact), {
        metadata: { type: "contact", format: "json", updated_at: new Date().toISOString() },
      });

      // Write contact_platform entries for each platform binding
      const approved = body.approved !== false;
      for (const [platform, userId] of Object.entries(platforms)) {
        const platformKey = `contact_platform:${platform}:${userId}`;
        await env.KV.put(platformKey, JSON.stringify({ slug: body.slug, approved }), {
          metadata: { type: "contact_platform", format: "json", updated_at: new Date().toISOString() },
        });
      }

      return reply({ ok: true, slug: body.slug, contact });
    }

    // DELETE /quarantine/:key — remove a quarantine entry after patron review
    const quarantineMatch = path.match(/^\/quarantine\/(.+)$/);
    if (quarantineMatch && request.method === "DELETE") {
      const key = decodeURIComponent(quarantineMatch[1]);
      if (!key.startsWith("sealed:quarantine:")) {
        return reply({ error: "can only delete quarantine entries" }, 400);
      }
      await env.KV.delete(key);
      return reply({ ok: true });
    }

    // PATCH /contact-platform/:platform/:id/approve — set approval on a platform binding
    const platformApproveMatch = path.match(/^\/contact-platform\/([^/]+)\/([^/]+)\/approve$/);
    if (platformApproveMatch && request.method === "PATCH") {
      const platform = decodeURIComponent(platformApproveMatch[1]);
      const platformId = decodeURIComponent(platformApproveMatch[2]);
      const platformKey = `contact_platform:${platform}:${platformId}`;
      const existing = await env.KV.get(platformKey, "json");
      if (!existing) return reply({ error: `platform binding "${platform}:${platformId}" not found` }, 404);

      const body = await request.json().catch(() => null);
      if (body?.approved === undefined || typeof body.approved !== "boolean") {
        return reply({ error: "body must include { approved: true|false }" }, 400);
      }

      existing.approved = body.approved;
      existing.approved_at = new Date().toISOString();
      existing.approved_by = "patron";
      await env.KV.put(platformKey, JSON.stringify(existing), {
        metadata: { type: "contact_platform", format: "json", updated_at: new Date().toISOString() },
      });

      return reply({ ok: true, platform, platformId, slug: existing.slug, approved: body.approved });
    }

    // GET /kv/:key — single key read
    const kvMatch = path.match(/^\/kv\/(.+)$/);
    if (kvMatch && path !== "/kv/multi") {
      const key = decodeURIComponent(kvMatch[1]);
      const { value, metadata } = await env.KV.getWithMetadata(key, "text");
      if (value === null) return reply({ error: "not found" }, 404);
      const format = metadata?.format || "json";
      if (format === "json") {
        try { return reply({ key, value: JSON.parse(value), type: "json" }); } catch {}
      }
      return reply({ key, value, type: "text" });
    }

    return reply({ error: "not found" }, 404);
  },
};
