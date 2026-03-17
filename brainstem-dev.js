// Swayambhu Dev Brainstem — subclass, not fork
// Imports the real Brainstem + hook-main.js, overrides only the platform-specific
// methods. All business logic (karma, budgets, error handling) lives in the base class.
//
// Run with: npx wrangler dev -c wrangler.dev.toml --test-scheduled --persist-to .wrangler/shared-state

import { Brainstem } from './brainstem.js';
import { wake } from './hook-main.js';
import { handleChat } from './hook-chat.js';

// ── Channel adapters (single source of truth: channels/*.js) ──
import * as slackAdapter from './channels/slack.js';

const CHANNEL_ADAPTERS = { slack: slackAdapter };

// ── Tool modules (single source of truth: tools/*.js) ──────────

import * as send_slack from './tools/send_slack.js';
import * as web_fetch from './tools/web_fetch.js';
import * as kv_write from './tools/kv_write.js';
import * as kv_manifest from './tools/kv_manifest.js';
import * as kv_query from './tools/kv_query.js';
import * as akash_exec from './tools/akash_exec.js';
import * as check_email from './tools/check_email.js';
import * as send_email from './tools/send_email.js';

const TOOL_MODULES = {
  send_slack, web_fetch, kv_write,
  kv_manifest, kv_query, akash_exec,
  check_email, send_email,
};

// ── Provider adapter modules (single source of truth: providers/*.js) ──

import * as llm_balance from './providers/llm_balance.js';
import * as wallet_balance from './providers/wallet_balance.js';
import * as gmail from './providers/gmail.js';

const PROVIDER_MODULES = {
  'provider:llm_balance': llm_balance,
  'provider:wallet_balance': wallet_balance,
  'provider:gmail': gmail,
};

// ── Entry point ─────────────────────────────────────────────────

export default {
  async scheduled(event, env, ctx) {
    const brain = new DevBrainstem(env, { ctx });
    await brain.runScheduled();
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/channel\/(\w+)$/);
    if (!match || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    const channel = match[1];
    const brain = new DevBrainstem(env, { ctx });

    // Dev mode: load adapter from direct imports
    const adapterMod = CHANNEL_ADAPTERS[channel];
    if (!adapterMod) return new Response(`Unknown channel: ${channel}`, { status: 404 });

    const body = await request.json();

    // Skip verification in dev mode
    const inbound = adapterMod.parseInbound(body);
    if (!inbound) return new Response("OK", { status: 200 });
    // Channel-agnostic challenge response (e.g. Slack URL verification)
    if (inbound._challenge) {
      return new Response(JSON.stringify({ challenge: inbound._challenge }),
        { headers: { "Content-Type": "application/json" } });
    }

    // Deduplication: ignore Slack retries
    if (inbound.msgId) {
      const dedupKey = `dedup:${inbound.msgId}`;
      const seen = await brain.kv.get(dedupKey);
      if (seen) return new Response("OK", { status: 200 });
      await brain.kv.put(dedupKey, "1", { expirationTtl: 30 });
    }

    // Process in background, return 200 immediately
    const work = (async () => {
      try {
        await brain.loadEagerConfig();
        // Dev mode: populate tool grants from static imports for chat
        if (!brain.toolGrants || Object.keys(brain.toolGrants).length === 0) {
          brain.toolGrants = DevBrainstem._buildToolGrants();
        }

        const adapter = {
          sendReply: async (chatId, text) => {
            await adapterMod.sendReply(chatId, text, {
              SLACK_BOT_TOKEN: env.SLACK_BOT_TOKEN,
            }, fetch);
          },
        };

        await handleChat(brain, channel, inbound, adapter);
      } catch (err) {
        console.error("[CHAT]", err.message);
      }
    })();
    if (ctx?.waitUntil) ctx.waitUntil(work);
    return new Response("OK", { status: 200 });
  },
};

// ── DevBrainstem ────────────────────────────────────────────────

class DevBrainstem extends Brainstem {

  // ── KernelRPC getter bridge ─────────────────────────────────
  // hook-main.js calls K.getSessionId(), K.getDharma(), etc.
  // In prod these live on KernelRPC (the RPC bridge). In dev, K = this.

  async getSessionId()    { return this.sessionId; }
  async getSessionCost()  { return this.sessionCost; }
  async getKarma()        { return this.karma; }
  async getDefaults()     { return this.defaults; }
  async getModelsConfig() { return this.modelsConfig; }
  async getModelCapabilities() { return this.modelCapabilities; }
  async getDharma()       { return this.dharma; }
  async getToolRegistry() { return this.toolRegistry; }
  async getYamas()        { return this.yamas; }
  async getNiyamas()      { return this.niyamas; }
  async kvList(opts)      { return this.kv.list(opts); }
  async isSystemKey(key)  { return Brainstem.isSystemKey(key); }

  // ── Chat support — bridge to base class ───────────────────
  async executeToolCall(tc) { return super.executeToolCall(tc); }

  // ── Platform override: _invokeHookModules ─────────────────
  // Calls wake() directly instead of Worker Loader isolate.

  async _invokeHookModules(modules, mainModule) {
    await this.loadEagerConfig();
    // Dev mode: build tool grants from static imports (same source of truth as prod seed)
    if (!this.toolGrants || Object.keys(this.toolGrants).length === 0) {
      this.toolGrants = DevBrainstem._buildToolGrants();
    }

    console.log(`[HOOK] Calling wake() for session ${this.sessionId}`);
    const result = await wake(this, { sessionId: this.sessionId });
    console.log(`[HOOK] wake() returned:`, JSON.stringify(result).slice(0, 500));
  }

  // Build kernel:tool_grants equivalent from static imports
  static _buildToolGrants() {
    const GRANT_FIELDS = ["secrets", "communication", "inbound", "provider"];
    const grants = {};
    for (const [name, mod] of Object.entries(TOOL_MODULES)) {
      const grant = {};
      for (const field of GRANT_FIELDS) {
        if (mod.meta?.[field] !== undefined) grant[field] = mod.meta[field];
      }
      if (Object.keys(grant).length) grants[name] = grant;
    }
    return grants;
  }

  // ── Platform override: _loadTool ──────────────────────────
  // Returns inline module with security fields stripped from meta.
  // Security grants live in this.toolGrants (kernel-controlled).

  async _loadTool(toolName) {
    const mod = TOOL_MODULES[toolName];
    if (!mod) throw new Error(`Unknown tool: ${toolName}`);
    // Strip grant fields — kernel reads these from toolGrants, not meta
    const { secrets, communication, inbound, provider, ...operationalMeta } = mod.meta || {};
    return { meta: operationalMeta, moduleCode: null };
  }

  // ── Platform override: executeAdapter ────────────────────
  // Calls imported provider module directly instead of CF isolate.

  async executeAdapter(adapterKey, input, secretOverrides) {
    const mod = PROVIDER_MODULES[adapterKey];
    if (!mod) throw new Error(`Unknown adapter: ${adapterKey}`);
    const ctx = await this.buildToolContext(adapterKey, mod.meta || {}, input);
    if (secretOverrides) Object.assign(ctx.secrets, secretOverrides);
    ctx.fetch = (...args) => fetch(...args);
    const fn = mod.execute || mod.call || mod.check;
    if (!fn) throw new Error(`Adapter ${adapterKey} has no callable function`);
    return fn(ctx);
  }

  // ── Platform override: _executeTool ───────────────────────
  // Calls imported tool module directly instead of CF isolate.

  async _executeTool(toolName, moduleCode, meta, ctx) {
    ctx.fetch = (...args) => fetch(...args);

    if (meta.kv_access && meta.kv_access !== "none") {
      ctx.kv = this._buildScopedKV(toolName, meta.kv_access);
    }
    // Provider binding comes from grants (kernel-controlled), not meta
    const grant = this.toolGrants?.[toolName];
    if (grant?.provider) {
      ctx.provider = PROVIDER_MODULES[`provider:${grant.provider}`];
    }

    return TOOL_MODULES[toolName].execute(ctx);
  }

  // ── ScopedKV emulation ──────────────────────────────────────

  _buildScopedKV(toolName, kvAccess) {
    const kv = this.kv;
    const scope = `tooldata:${toolName}:`;
    return {
      async get(key) {
        const resolved = kvAccess === "own" ? `${scope}${key}` : key;
        if (resolved.startsWith('sealed:')) return null;
        try { return await kv.get(resolved, "json"); }
        catch { try { return await kv.get(resolved, "text"); } catch { return null; } }
      },
      async put(key, value) {
        const resolved = `${scope}${key}`;  // writes always scoped
        const fmt = typeof value === "string" ? "text" : "json";
        await kv.put(resolved, typeof value === "string" ? value : JSON.stringify(value), {
          metadata: { type: "tooldata", format: fmt, updated_at: new Date().toISOString() },
        });
      },
      async list(opts = {}) {
        if (kvAccess === "own") {
          const result = await kv.list({ ...opts, prefix: scope + (opts.prefix || "") });
          return {
            keys: result.keys.map(k => ({ ...k, name: k.name.slice(scope.length) })),
            list_complete: result.list_complete,
          };
        }
        const result = await kv.list(opts);
        return {
          keys: result.keys.filter(k => !k.name.startsWith('sealed:')),
          list_complete: result.list_complete,
        };
      },
    };
  }

  // ── Platform override: callWithCascade ─────────────────────
  // Direct OpenRouter fetch instead of adapter cascade.

  async callWithCascade(request, step) {
    const body = {
      model: request.model,
      max_tokens: request.max_tokens,
      messages: request.messages,
    };
    const families = {
      anthropic: (b, { effort }) => {
        b.cache_control = { type: 'ephemeral' };
        if (effort) {
          b.thinking = { type: 'adaptive', effort };
          b.provider = { require_parameters: true };
        }
      },
      deepseek: (b, { effort }) => {
        if (effort) b.reasoning_effort = effort;
      },
    };
    const adapt = request.family ? families[request.family] : null;
    if (adapt) adapt(body, { effort: request.effort });
    if (request.tools?.length) body.tools = request.tools;

    console.log(`[LLM] >>> ${step} | model=${request.model} | msgs=${request.messages.length}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    let resp, data;
    try {
      resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Authorization": `Bearer ${this.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      data = await resp.json();
    } finally {
      clearTimeout(timeout);
    }

    if (!resp.ok || data.error) {
      const errMsg = JSON.stringify(data.error || data);
      console.error(`[LLM] <<< ERROR | ${errMsg}`);
      return { ok: false, error: errMsg, tier: "direct" };
    }

    const msg = data.choices?.[0]?.message;
    const usage = data.usage || {};
    const content = msg?.content || "";
    const toolCalls = msg?.tool_calls || null;

    console.log(`[LLM] <<< in=${usage.prompt_tokens} out=${usage.completion_tokens} tools=${toolCalls?.length || 0}`);

    return { ok: true, content, usage, toolCalls, tier: "direct" };
  }

  // ── Platform override: callHook ────────────────────────────
  // No hooks in dev.

  async callHook(hookName, ctx) { return null; }

  // ── Override: karmaRecord ──────────────────────────────────
  // Adds console.log for dev visibility.

  async karmaRecord(entry) {
    console.log(`[KARMA] ${entry.event}`, JSON.stringify(entry).slice(0, 500));
    return super.karmaRecord(entry);
  }
}
