// Swayambhu — Entry Point
// Imports all modules and wires them to the kernel via dependency injection.
// In production, the governor auto-generates this file from KV source-of-truth.
// In local dev, this is a static hand-written file importing from disk.

import { Kernel } from './kernel.js';
import { handleChat, handleDelivery } from './hook-communication.js';

// Hook modules (mutable policy — agent can propose changes)
import * as act from './act.js';
import * as reflect from './reflect.js';

// Channel adapters
import * as slackAdapter from './channels/slack.js';
import * as whatsappAdapter from './channels/whatsapp.js';

// Tool modules
import * as send_slack from './tools/send_slack.js';
import * as web_fetch from './tools/web_fetch.js';
import * as kv_manifest from './tools/kv_manifest.js';
import * as kv_query from './tools/kv_query.js';
import * as computer from './tools/computer.js';
import * as check_email from './tools/check_email.js';
import * as send_email from './tools/send_email.js';
import * as test_model from './tools/test_model.js';
import * as web_search from './tools/web_search.js';
import * as start_job from './tools/start_job.js';
import * as collect_jobs from './tools/collect_jobs.js';
import * as send_whatsapp from './tools/send_whatsapp.js';
import * as google_docs from './tools/google_docs.js';
import * as gnanetra from './tools/gnanetra.js';

// Provider adapter modules
import * as llm from './providers/llm.js';
import * as llm_balance from './providers/llm_balance.js';
import * as wallet_balance from './providers/wallet_balance.js';
import * as gmail from './providers/gmail.js';
import * as compute from './providers/compute.js';

// ── Wire modules ──────────────────────────────────────────────

const TOOLS = {
  send_slack, web_fetch, kv_manifest, kv_query,
  computer, check_email, send_email, test_model, web_search,
  start_job, collect_jobs, send_whatsapp, google_docs, gnanetra,
};

const PROVIDERS = {
  'provider:llm': llm,
  'provider:llm_balance': llm_balance,
  'provider:wallet_balance': wallet_balance,
  'provider:gmail': gmail,
  'provider:compute': compute,
  // Communication adapters — exposed for K.executeAdapter() calls from hooks
  slack: send_slack,
  email: send_email,
  whatsapp: send_whatsapp,
};

const CHANNELS = { slack: slackAdapter, whatsapp: whatsappAdapter };

const HOOKS = { act, reflect };

const EVENT_HANDLERS = {
  communicationDelivery: async (K, event) => {
    if (!EVENT_HANDLERS._pendingDelivery) EVENT_HANDLERS._pendingDelivery = [];
    EVENT_HANDLERS._pendingDelivery.push(event);
  },
  sessionWake: async (K, event) => {
    try {
      const schedule = await K.kvGet("session_schedule");
      if (schedule?.next_session_after) {
        const advanceTo = Date.now() + 30 * 1000;
        if (new Date(schedule.next_session_after).getTime() > advanceTo) {
          await K.kvWriteSafe("session_schedule", {
            ...schedule,
            next_session_after: new Date(advanceTo).toISOString(),
          });
        }
      }
    } catch (err) {
      await K.karmaRecord({ event: "session_wake_error", error: err.message });
    }
  },
};

// ── Entry points ──────────────────────────────────────────────

export default {
  async scheduled(event, env, ctx) {
    const kernel = new Kernel(env, { ctx, TOOLS, HOOKS, PROVIDERS, CHANNELS, EVENT_HANDLERS });
    await kernel.runScheduled();
    // Flush pending communication deliveries in background
    if (EVENT_HANDLERS._pendingDelivery?.length) {
      const pending = EVENT_HANDLERS._pendingDelivery.splice(0);
      const K = kernel.buildKernelInterface();
      ctx.waitUntil(handleDelivery(K, pending));
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Admin: set schedule to past so next /__scheduled runs immediately
    if (url.pathname === "/__clear-schedule" && request.method === "POST") {
      await env.KV.put("session_schedule", JSON.stringify({
        next_session_after: new Date(Date.now() - 1000).toISOString(),
        interval_seconds: 21600,
      }));
      return new Response("session_schedule set to past", { status: 200 });
    }

    // Job completion callback — compute target calls back when a job finishes
    const jobMatch = url.pathname.match(/^\/job-complete\/(.+)$/);
    if (jobMatch && request.method === "POST") {
      const jobId = jobMatch[1];
      const jsonHeaders = { "Content-Type": "application/json" };
      try {
        const body = await request.json();
        const job = await env.KV.get(`job:${jobId}`, "json");
        if (!job) return new Response(JSON.stringify({ error: "unknown job" }), { status: 404, headers: jsonHeaders });
        if (job.status !== "running") return new Response(JSON.stringify({ error: "job not running" }), { status: 409, headers: jsonHeaders });

        const auth = request.headers.get("Authorization")?.replace("Bearer ", "");
        if (auth !== job.callback_secret) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: jsonHeaders });

        job.status = body.exit_code === 0 ? "completed" : "failed";
        job.completed_at = new Date().toISOString();
        job.exit_code = body.exit_code;
        if (body.artifacts) job.artifacts = body.artifacts;
        await env.KV.put(`job:${jobId}`, JSON.stringify(job));

        // Emit event into the event bus
        const jobKernel = new Kernel(env, { ctx, TOOLS, HOOKS, PROVIDERS, CHANNELS, EVENT_HANDLERS });
        const K = jobKernel.buildKernelInterface();
        await K.emitEvent("job_complete", {
          source: { job_id: jobId },
          summary: `Job ${jobId} (${job.type}) ${job.status}`,
          ref: `job:${jobId}`,
          result_key: `job_result:${jobId}`,
        });

        // Advance session schedule (same pattern as chat handler)
        try {
          const schedule = await env.KV.get("session_schedule", "json");
          if (schedule?.next_session_after) {
            const advanceTo = Date.now() + 30 * 1000;
            if (new Date(schedule.next_session_after).getTime() > advanceTo) {
              await env.KV.put("session_schedule", JSON.stringify({
                ...schedule,
                next_session_after: new Date(advanceTo).toISOString(),
              }));
            }
          }
        } catch {}

        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: jsonHeaders });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: jsonHeaders });
      }
    }

    const match = url.pathname.match(/^\/channel\/(\w+)$/);
    if (!match) {
      return new Response("Not found", { status: 404 });
    }

    const channel = match[1];
    const adapterMod = CHANNELS[channel];
    if (!adapterMod) return new Response(`Unknown channel: ${channel}`, { status: 404 });

    // GET: webhook verification (e.g. WhatsApp hub.challenge)
    if (request.method === "GET") {
      if (!adapterMod.verifyWebhook) return new Response("Not found", { status: 404 });
      const challenge = adapterMod.verifyWebhook(url, env);
      if (challenge) return new Response(challenge, { status: 200 });
      return new Response("Forbidden", { status: 403 });
    }

    if (request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    // Read raw body for signature verification, then parse
    const rawBody = await request.text();

    // Verify webhook signature if adapter supports it
    if (adapterMod.verify) {
      const valid = await adapterMod.verify(request.headers, rawBody, env);
      if (!valid) return new Response("Invalid signature", { status: 401 });
    }

    const body = JSON.parse(rawBody);
    const kernel = new Kernel(env, { ctx, TOOLS, HOOKS, PROVIDERS, CHANNELS, mode: 'chat' });

    // Parse inbound message via adapter
    const inbound = adapterMod.parseInbound(body);
    if (!inbound) return new Response("OK", { status: 200 });

    // Resolve canonical chat key (adapter-specific, e.g. Slack DMs → userId)
    if (adapterMod.resolveChatKey) {
      inbound.resolvedChatKey = adapterMod.resolveChatKey(inbound);
    }

    // Channel-agnostic challenge response (e.g. Slack URL verification)
    if (inbound._challenge) {
      return new Response(JSON.stringify({ challenge: inbound._challenge }),
        { headers: { "Content-Type": "application/json" } });
    }

    // Deduplication: ignore Slack retries
    if (inbound.msgId) {
      const dedupKey = `dedup:${inbound.msgId}`;
      const seen = await kernel.kv.get(dedupKey);
      if (seen) return new Response("OK", { status: 200 });
      await kernel.kv.put(dedupKey, "1", { expirationTtl: 60 });
    }

    // Process in background, return 200 immediately
    const work = (async () => {
      try {
        await kernel.loadEagerConfig();

        const adapter = {
          sendReply: async (chatId, text) => {
            const secrets = {};
            for (const s of (adapterMod.config?.secrets || [])) {
              if (env[s] !== undefined) secrets[s] = env[s];
            }
            await adapterMod.sendReply(chatId, text, secrets, fetch);
          },
        };

        const K = kernel.buildKernelInterface();
        await handleChat(K, channel, inbound);
      } catch (err) {
        console.error(`[CHAT] error: ${err.message}`, err.stack);
        try {
          const logRef = await kernel.writeLog("chat", {
            error: err.message,
            stack: err.stack,
            channel,
            inbound: { chatId: inbound.chatId, userId: inbound.userId, text: inbound.text?.slice(0, 500) },
          });
          await kernel.karmaRecord({ event: "chat_error", channel, log_ref: logRef });
        } catch {}
      }
    })();
    if (ctx?.waitUntil) ctx.waitUntil(work);
    return new Response("OK", { status: 200 });
  },
};
