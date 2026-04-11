import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 4173);

function envText(name) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

function runtimeConfigFromEnv() {
  const config = {};
  const apiBaseUrl = envText("APP_API_BASE_URL");
  const remoteProjectUrl = envText("APP_REMOTE_URL");
  const remoteReadKey = envText("APP_REMOTE_READ_KEY");
  const remoteStateTable = envText("APP_REMOTE_STATE_TABLE");
  const remoteSyncFunction = envText("APP_REMOTE_SYNC_FUNCTION");
  const remoteSyncEndpoint = envText("APP_REMOTE_SYNC_ENDPOINT");

  if (apiBaseUrl) config.apiBaseUrl = apiBaseUrl;
  if (remoteProjectUrl) config.remoteProjectUrl = remoteProjectUrl;
  if (remoteReadKey) config.remoteReadKey = remoteReadKey;
  if (remoteStateTable) config.remoteStateTable = remoteStateTable;
  if (remoteSyncFunction) config.remoteSyncFunction = remoteSyncFunction;
  if (remoteSyncEndpoint) config.remoteSyncEndpoint = remoteSyncEndpoint;
  return config;
}

const runtimeEnvConfig = runtimeConfigFromEnv();
const hasRuntimeEnvConfig = Object.keys(runtimeEnvConfig).length > 0;

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon"
};

function safePath(urlPath) {
  const clean = decodeURIComponent(String(urlPath || "/"))
    .split("?")[0]
    .replace(/\\/g, "/");
  let rel = clean === "/" ? "/premium_pricing_clickable.html" : clean;
  if (rel.startsWith("/")) rel = rel.slice(1);
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root)) return null;
  return abs;
}

const server = http.createServer((req, res) => {
  if (!req.url) {
    res.writeHead(400);
    res.end("Bad Request");
    return;
  }

  const requestPath = decodeURIComponent(String(req.url || "").split("?")[0] || "/");
  if (requestPath === "/runtime-config.js" && hasRuntimeEnvConfig) {
    const payload = JSON.stringify(runtimeEnvConfig, null, 2);
    const body =
      `window.__FlickerRuntimeConfig = Object.assign({}, window.__FlickerRuntimeConfig || {}, ${payload});\n`;
    res.writeHead(200, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store"
    });
    res.end(body);
    return;
  }

  const abs = safePath(req.url);
  if (!abs) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.stat(abs, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    const ext = path.extname(abs).toLowerCase();
    const type = mime[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
    fs.createReadStream(abs).pipe(res);
  });
});

server.listen(port, host, () => {
  const nets = os.networkInterfaces();
  const urls = [`http://localhost:${port}/premium_pricing_clickable.html`];
  Object.values(nets).forEach((entries) => {
    (entries || []).forEach((entry) => {
      if (entry && entry.family === "IPv4" && !entry.internal) {
        urls.push(`http://${entry.address}:${port}/premium_pricing_clickable.html`);
      }
    });
  });

  console.log("");
  console.log("Flicker HTML app server is running.");
  console.log("Open one of these URLs:");
  urls.forEach((u) => console.log(`  ${u}`));
  if (hasRuntimeEnvConfig) {
    console.log("");
    console.log("Runtime config is being served from environment variables.");
  }
  console.log("");
  console.log("Tip: use the network URL on iPad/phone while on same Wi-Fi.");
});
