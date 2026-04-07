// Swayambhu — Entry Point
// Imports all modules and wires them to the kernel via dependency injection.
// In production, the governor auto-generates this file from KV source-of-truth.
// In local dev, this is a static hand-written file importing from disk.

import { Kernel } from './kernel.js';
import { runTurn, ingestInbound, ingestInternal, handleCommand, createOutboxItem, checkOutbox, trySuppressTrivialAcknowledgement } from './hook-communication.js';

// Hook modules (mutable policy — agent can propose changes)
import * as session from './userspace.js';
import { classify as pulseClassify } from './userspace.js';

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
import * as request_message from './tools/request_message.js';
import * as trigger_session from './tools/trigger_session.js';
import * as update_request from './tools/update_request.js';

// Provider adapter modules
import * as llm from './providers/llm.js';
import * as llm_balance from './providers/llm_balance.js';
import * as wallet_balance from './providers/wallet_balance.js';
import * as gmail from './providers/gmail.js';
import * as emailRelay from './providers/email-relay.js';
import * as compute from './providers/compute.js';

// ── Wire modules ──────────────────────────────────────────────

const TOOLS = {
  send_slack, web_fetch, kv_manifest, kv_query,
  computer, check_email, send_email, test_model, web_search,
  start_job, collect_jobs, send_whatsapp, google_docs, gnanetra,
  request_message, trigger_session, update_request,
};

const PROVIDERS = {
  'provider:llm': llm,
  'provider:llm_balance': llm_balance,
  'provider:wallet_balance': wallet_balance,
  'provider:gmail': gmail,
  'provider:email-relay': emailRelay,
  'provider:compute': compute,
  // Communication adapters — exposed for K.executeAdapter() calls from hooks
  slack: send_slack,
  email: send_email,
  whatsapp: send_whatsapp,
};

const CHANNELS = { slack: slackAdapter, whatsapp: whatsappAdapter };

const HOOKS = {
  tick: session,
  deferred: {
    comms: {
      async run(K, events) {
        // Group by conversation
        const byConv = {};
        for (const ev of events) {
          let turn;
          if (ev.type === "inbound_message") {
            turn = ev; // Already a CommTurn shape from fetch
            // Ensure idempotency_key is set — fallback to ev.key if missing
            // (prevents re-drain if the event was created without one)
            if (!turn.idempotency_key) turn.idempotency_key = ev.key;
          } else {
            turn = await ingestInternal(K, ev);
          }
          if (!turn) {
            // Can't route to a conversation — delete to prevent re-drain
            if (ev.key) await K.deleteEvent(ev.key);
            await K.karmaRecord({ event: "comms_unroutable", event_type: ev.type, event_key: ev.key });
            continue;
          }
          const cid = turn.conversation_id;
          if (!byConv[cid]) byConv[cid] = [];
          byConv[cid].push(turn);
        }

        // Run each conversation
        for (const [convId, turns] of Object.entries(byConv)) {
          const inboundTurns = turns.filter((turn) => turn.source === "inbound");
          const internalTurns = turns.filter((turn) => turn.source === "internal");
          const batches = inboundTurns.length > 0
            ? [inboundTurns]
            : [internalTurns];

          try {
            for (const batch of batches) {
              // Claim only the selected events for this batch. If a live inbound
              // message is present, leave internal updates unclaimed so they can
              // be reconsidered on a later tick instead of distorting inbound triage.
              const claimed = [];
              for (const t of batch) {
                if (t.idempotency_key) {
                  const ok = await K.claimEvent(t.idempotency_key, await K.getExecutionId());
                  if (ok) claimed.push(t);
                } else {
                  claimed.push(t);
                }
              }
              if (claimed.length === 0) continue;

              const result = await runTurn(K, convId, claimed);

              // Event lifecycle based on outcome
              for (const t of claimed) {
                if (!t.idempotency_key) continue;
                if (result.action === "sent" || result.action === "discarded") {
                  await K.deleteEvent(t.idempotency_key);
                } else if (result.action === "held") {
                  await createOutboxItem(K, convId, t.content, result.reason, result.release_after, [t.idempotency_key]);
                  await K.deleteEvent(t.idempotency_key);
                } else {
                  // error — release claim for retry
                  await K.releaseEvent(t.idempotency_key);
                }
              }
            }
          } catch (err) {
            await K.karmaRecord({ event: "comms_error", conversation: convId, error: err.message });
            // Release claims on error
            for (const t of [...inboundTurns, ...internalTurns]) {
              if (t.idempotency_key) {
                try { await K.releaseEvent(t.idempotency_key); } catch {}
              }
            }
          }
        }

        // Check outbox for due items
        const dueItems = await checkOutbox(K);
        for (const item of dueItems) {
          try {
            const turn = {
              conversation_id: item.conversation_id,
              reply_target: null,
              source: "internal",
              content: item.content,
              intent: "share",
              idempotency_key: item.key || null,
              metadata: { outbox_id: item.id },
            };

            // Load reply_target from conversation state
            const conv = await K.kvGet(item.conversation_id);
            if (conv?.reply_target) {
              turn.reply_target = conv.reply_target;
            } else {
              const parts = item.conversation_id.replace("chat:", "").split(":");
              turn.reply_target = { platform: parts[0], channel: parts.slice(1).join(":"), thread_ts: null };
            }

            const result = await runTurn(K, item.conversation_id, [turn]);
            if (result.action === "sent" || result.action === "discarded") {
              await K.kvDeleteSafe(item.key);
            } else {
              // Still held or error — increment attempts
              item.attempts = (item.attempts || 0) + 1;
              if (item.attempts >= 3) {
                await K.kvDeleteSafe(item.key);
                await K.karmaRecord({ event: "outbox_dead_lettered", id: item.id });
              } else {
                await K.kvWriteSafe(item.key, item);
              }
            }
          } catch (err) {
            await K.karmaRecord({ event: "outbox_error", id: item.id, error: err.message });
          }
        }
      },
    },
  },
  pulse: { classify: pulseClassify },
};

const EVENT_HANDLERS = {
  sessionTrigger: async (K, event) => {
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

async function advanceSessionSchedule(env, defaults, advanceSeconds) {
  const schedule = await env.KV.get("session_schedule", "json");
  const nextSessionAfter = new Date(Date.now() + advanceSeconds * 1000).toISOString();

  if (!schedule) {
    await env.KV.put("session_schedule", JSON.stringify({
      next_session_after: nextSessionAfter,
      interval_seconds: defaults?.schedule?.interval_seconds || 21600,
      no_action_streak: 0,
    }));
    return;
  }

  if (!schedule.next_session_after || new Date(schedule.next_session_after).getTime() > Date.now() + advanceSeconds * 1000) {
    await env.KV.put("session_schedule", JSON.stringify({
      ...schedule,
      next_session_after: nextSessionAfter,
    }));
  }
}

async function tryInboundFastPath(env, ctx, commTurn) {
  const active = await env.KV.get("kernel:active_execution", "json");
  if (!active?.started_at) return { used: false };

  try {
    const kernel = new Kernel(env, { ctx, TOOLS, HOOKS, PROVIDERS, CHANNELS, mode: "chat" });
    await kernel.loadEagerConfig();
    const K = kernel.buildKernelInterface();
    const result = await trySuppressTrivialAcknowledgement(K, commTurn.conversation_id, [commTurn]);
    if (result.used) {
      return { used: true };
    }
  } catch {
    // Fall through to the durable event path on any fast-path failure.
  }

  return { used: false };
}

// ── Entry points ──────────────────────────────────────────────

export default {
  async scheduled(event, env, ctx) {
    const kernel = new Kernel(env, { ctx, TOOLS, HOOKS, PROVIDERS, CHANNELS, EVENT_HANDLERS });
    await kernel.runScheduled();
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const jobMatch = url.pathname.match(/^\/job-complete\/([^/]+)$/);
    if (jobMatch && request.method === "POST") {
      const jobId = decodeURIComponent(jobMatch[1]);
      const rawBody = await request.text();
      const job = await env.KV.get(`job:${jobId}`, "json");
      if (!job) return new Response("Job not found", { status: 404 });

      const providedSecret = request.headers.get("X-Job-Callback-Secret") || "";
      if (!job.callback_secret || providedSecret !== job.callback_secret) {
        return new Response("Invalid callback secret", { status: 401 });
      }

      let payload;
      try {
        payload = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }

      const exitCode = Number.isFinite(Number(payload?.exit_code)) ? Number(payload.exit_code) : null;
      if (!Number.isInteger(exitCode)) {
        return new Response("exit_code is required", { status: 400 });
      }

      const now = new Date().toISOString();
      job.status = exitCode === 0 ? "completed" : "failed";
      job.completed_at = now;
      job.callback_received_at = now;
      job.exit_code = exitCode;
      await env.KV.put(`job:${jobId}`, JSON.stringify(job));

      const kernel = new Kernel(env, { ctx, TOOLS, HOOKS, PROVIDERS, CHANNELS, EVENT_HANDLERS });
      const K = kernel.buildKernelInterface();
      await K.emitEvent("job_complete", {
        job_id: jobId,
        source: { job_id: jobId, via: "callback" },
        summary: `Job ${jobId} (${job.type}) ${job.status}`,
        ref: `job:${jobId}`,
        result_key: `job_result:${jobId}`,
        exit_code: exitCode,
      });

      const defaults = await env.KV.get("config:defaults", "json");
      const advanceSeconds = defaults?.jobs?.callback_advance_seconds || 30;
      await advanceSessionSchedule(env, defaults, advanceSeconds);

      if (ctx?.waitUntil) {
        ctx.waitUntil((async () => {
          const wakeKernel = new Kernel(env, { ctx, TOOLS, HOOKS, PROVIDERS, CHANNELS, EVENT_HANDLERS });
          await wakeKernel.runScheduled();
        })());
      }

      return new Response("OK", { status: 202 });
    }

    // Admin: set schedule to past so next /__scheduled runs immediately
    // Deprecated for normal dev-loop use. Prefer POST /__wake so the resulting
    // session carries explicit provenance instead of looking like a scheduler
    // failure.
    if (url.pathname === "/__clear-schedule" && request.method === "POST") {
      await env.KV.put("session_schedule", JSON.stringify({
        next_session_after: new Date(Date.now() - 1000).toISOString(),
        interval_seconds: 21600,
      }));
      return new Response("session_schedule set to past", { status: 200 });
    }

    if (url.pathname === "/__wake" && request.method === "POST") {
      let payload = {};
      try {
        payload = await request.json();
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }

      const actor = typeof payload?.actor === "string" && payload.actor.trim()
        ? payload.actor.trim()
        : "external";
      const contextPayload = payload?.context && typeof payload.context === "object"
        ? payload.context
        : {};

      const kernel = new Kernel(env, { ctx, TOOLS, HOOKS, PROVIDERS, CHANNELS, EVENT_HANDLERS });
      const K = kernel.buildKernelInterface();
      await K.emitEvent("wake", {
        origin: "external",
        trigger: {
          actor,
          context: contextPayload,
        },
      });

      const runWake = async () => {
        const wakeKernel = new Kernel(env, { ctx, TOOLS, HOOKS, PROVIDERS, CHANNELS, EVENT_HANDLERS });
        await wakeKernel.runScheduled();
      };

      if (ctx?.waitUntil) ctx.waitUntil(runWake());
      else await runWake();

      return new Response("wake queued", { status: 202 });
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

    // Filter out dev-loop approval replies — these are infrastructure, not agent inbound.
    // Only filter short messages (under 50 chars) that look like bare approval commands.
    // Longer messages are likely real conversations that happen to start with these words.
    if (inbound.text && inbound.text.trim().length < 50 &&
        /^\s*(approve|reject)\s+[a-z2-9]{5}\b/i.test(inbound.text)) {
      return new Response("OK", { status: 200 });
    }

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

    // Handle commands immediately (no scheduler needed)
    if (inbound.command) {
      const K = kernel.buildKernelInterface();
      await kernel.loadEagerConfig();
      const result = await handleCommand(K, channel, inbound);
      if (result) return new Response("OK", { status: 200 });
    }

    // Write inbound event to KV — scheduler will process it
    const nonce = Math.random().toString(36).slice(2, 6);
    const ts = Date.now().toString().padStart(15, '0');
    const eventKey = `event:${ts}:inbound_message:${nonce}`;
    const commTurn = ingestInbound(channel, inbound);

    const fastPath = await tryInboundFastPath(env, ctx, commTurn);
    if (fastPath.used) {
      return new Response("OK", { status: 200 });
    }

    await env.KV.put(eventKey, JSON.stringify({
      type: "inbound_message",
      ...commTurn,
      idempotency_key: eventKey,  // enables claim/delete in deferred comms processor
      timestamp: new Date().toISOString(),
    }), { expirationTtl: 86400 });

    // Wake scheduler
    const schedule = await env.KV.get("session_schedule", "json");
    if (schedule?.next_session_after) {
      const now = new Date().toISOString();
      if (schedule.next_session_after > now) {
        await env.KV.put("session_schedule", JSON.stringify({
          ...schedule,
          next_session_after: now,
        }));
      }
    }

    return new Response("OK", { status: 200 });
  },
};
