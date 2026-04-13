#!/usr/bin/env node
// Stable front-door proxy for state-lab branches.
// Reads the currently active branch target from state-lab metadata and proxies
// either browser traffic or kernel traffic to the active branch.

import { createServer } from "http";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATE_LAB_DIR = process.env.SWAYAMBHU_STATE_LAB_DIR || "/home/swami/swayambhu/state-lab";
const ACTIVE_UI_PATH = join(DEFAULT_STATE_LAB_DIR, "active-ui.json");
const PROXY_KIND = process.env.SWAYAMBHU_ACTIVE_PROXY_KIND === "kernel" ? "kernel" : "ui";
const TARGET_PORT_KEY = PROXY_KIND === "kernel" ? "kernel_port" : "spa_port";
const DEFAULT_GATEWAY_PORT = PROXY_KIND === "kernel"
  ? (process.env.SWAYAMBHU_ACTIVE_KERNEL_PORT || "8787")
  : (process.env.SWAYAMBHU_ACTIVE_UI_PORT || "9071");
const GATEWAY_PORT = parseInt(process.env.SWAYAMBHU_ACTIVE_PROXY_PORT || DEFAULT_GATEWAY_PORT, 10);

function loadActiveTarget() {
  if (!existsSync(ACTIVE_UI_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(ACTIVE_UI_PATH, "utf8"));
    if (!Number.isInteger(parsed?.[TARGET_PORT_KEY])) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function proxyRequest(req, res, target) {
  try {
    const requestUrl = new URL(req.url, "http://localhost");
    const upstreamUrl = `http://localhost:${target[TARGET_PORT_KEY]}${requestUrl.pathname}${requestUrl.search}`;
    const body = req.method === "GET" || req.method === "HEAD"
      ? undefined
      : await new Response(req).arrayBuffer();
    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers: req.headers,
      body,
      duplex: body ? "half" : undefined,
    });
    const headers = Object.fromEntries(upstream.headers.entries());
    delete headers["content-encoding"];
    delete headers["transfer-encoding"];
    headers["cache-control"] = "no-store";
    res.writeHead(upstream.status, headers);
    const bytes = new Uint8Array(await upstream.arrayBuffer());
    res.end(Buffer.from(bytes));
  } catch (error) {
    res.writeHead(502, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({ error: error.message, active_branch: target?.branch || null }));
  }
}

const server = createServer((req, res) => {
  const target = loadActiveTarget();
  if (!target) {
    res.writeHead(503, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({
      error: "No active state-lab branch configured",
      active_ui_path: ACTIVE_UI_PATH,
    }));
    return;
  }

  if (req.url === "/__active") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({
      state_lab_gateway: true,
      proxy_kind: PROXY_KIND,
      gateway_port: GATEWAY_PORT,
      target_port_key: TARGET_PORT_KEY,
      target_port: target[TARGET_PORT_KEY],
      ...target,
    }, null, 2));
    return;
  }

  void proxyRequest(req, res, target);
});

server.listen(GATEWAY_PORT, () => {
  const label = PROXY_KIND === "kernel"
    ? `http://localhost:${GATEWAY_PORT}/`
    : `http://localhost:${GATEWAY_PORT}/patron/`;
  console.log(`State-lab ${PROXY_KIND} gateway: ${label}`);
});
