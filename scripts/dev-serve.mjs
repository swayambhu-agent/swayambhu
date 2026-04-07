#!/usr/bin/env node
// Zero-cache static file server for the dashboard SPA.
// Usage: node scripts/dev-serve.mjs [port]
//
// Sets Cache-Control: no-store on every response so code changes
// are picked up immediately without hard-refresh.

import { createServer } from "http";
import { createReadStream, existsSync, readFileSync, statSync } from "fs";
import { resolve, extname, dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const siteDir = resolve(__dirname, "..", "site");
const __filename = fileURLToPath(import.meta.url);
const DEFAULT_PORT = 3001;
const DEFAULT_KERNEL_PORT = 8787;
const DEFAULT_DASHBOARD_PORT = 8790;

const MIME = {
  ".html": "text/html",
  ".js":   "text/javascript",
  ".mjs":  "text/javascript",
  ".css":  "text/css",
  ".json": "application/json",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
};

export function buildRuntimeDashboardConfig(baseConfig = "", options = {}) {
  const kernelPort = options.kernelPort || DEFAULT_KERNEL_PORT;
  const kernelUrl = `http://localhost:${kernelPort}`;
  const source = String(baseConfig || "").trim() || "window.DASHBOARD_CONFIG = {};";
  return `${source}
window.DASHBOARD_CONFIG = Object.assign({}, window.DASHBOARD_CONFIG || {}, {
  apiUrl: "/api",
  kernelUrl: ${JSON.stringify(kernelUrl)},
});
`;
}

async function proxyApi(req, res, dashboardPort) {
  try {
    const requestUrl = new URL(req.url, "http://localhost");
    const upstreamPath = `${requestUrl.pathname.replace(/^\/api/, "")}${requestUrl.search}`;
    const body = req.method === "GET" || req.method === "HEAD"
      ? undefined
      : await new Response(req).arrayBuffer();
    const upstream = await fetch(`http://localhost:${dashboardPort}${upstreamPath}`, {
      method: req.method,
      headers: req.headers,
      body,
      duplex: body ? "half" : undefined,
    });
    const headers = Object.fromEntries(upstream.headers.entries());
    delete headers["content-encoding"];
    delete headers["transfer-encoding"];
    res.writeHead(upstream.status, headers);
    const bytes = new Uint8Array(await upstream.arrayBuffer());
    res.end(Buffer.from(bytes));
  } catch (error) {
    res.writeHead(502, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({ error: error.message }));
  }
}

export function createDashboardServer(options = {}) {
  const port = parseInt(String(options.port || process.argv[2] || DEFAULT_PORT), 10);
  const kernelPort = parseInt(String(options.kernelPort || process.env.SWAYAMBHU_KERNEL_PORT || DEFAULT_KERNEL_PORT), 10);
  const dashboardPort = parseInt(String(options.dashboardPort || process.env.SWAYAMBHU_DASHBOARD_PORT || DEFAULT_DASHBOARD_PORT), 10);
  const rootDir = options.siteDir || siteDir;

  return createServer((req, res) => {
    if (req.url.startsWith("/api/") || req.url === "/api") {
      void proxyApi(req, res, dashboardPort);
      return;
    }

    // Proxy /trigger to the matching branch kernel.
    if (req.url === "/trigger" && req.method === "POST") {
      import("http").then(({ default: http }) => {
        http.get(`http://localhost:${kernelPort}/__scheduled`, (r) => {
          res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          res.end(JSON.stringify({ ok: true, status: r.statusCode }));
        }).on("error", (e) => {
          res.writeHead(502, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        });
      });
      return;
    }

    let urlPath = req.url.split("?")[0];

    // Serve index.html for directory paths
    if (urlPath.endsWith("/")) urlPath += "index.html";

    let file = join(rootDir, urlPath);

    if (urlPath.endsWith("/config.js") || urlPath === "/config.js") {
      const configSource = existsSync(file) ? readFileSync(file, "utf8") : "";
      const body = buildRuntimeDashboardConfig(configSource, { dashboardPort, kernelPort });
      res.writeHead(200, {
        "Content-Type": "text/javascript",
        "Cache-Control": "no-store",
      });
      res.end(body);
      return;
    }

    // If path is a directory without trailing slash, redirect so relative paths resolve correctly
    if (existsSync(file) && statSync(file).isDirectory() && !urlPath.endsWith("/")) {
      res.writeHead(301, { Location: urlPath + "/" });
      res.end();
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) {
      file = join(file, "index.html");
    }

    if (!existsSync(file)) {
      res.writeHead(404, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      res.end("Not found");
      return;
    }

    const mime = MIME[extname(file)] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": mime,
      "Cache-Control": "no-store",
    });
    createReadStream(file).pipe(res);
  });

}

const isMain = process.argv[1] && resolve(process.argv[1]) === __filename;

if (isMain) {
  const port = parseInt(process.argv[2] || String(DEFAULT_PORT), 10);
  createDashboardServer({ port }).listen(port, () => {
    console.log(`Dashboard SPA: http://localhost:${port}/patron/`);
  });
}
