#!/usr/bin/env node
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createSwitchboardApi } from "./api.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const clientDir = resolve(root, "dist", "client");
const indexPath = resolve(clientDir, "index.html");
const args = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
  return value;
}

const host = option("host", "127.0.0.1");
const port = Number(option("port", "4173"));
const explicitPort = args.includes("--port");
if (!["127.0.0.1", "localhost", "::1"].includes(host)) throw new Error("DSH Switchboard GUI only binds to a loopback host");
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be between 0 and 65535");
if (!existsSync(indexPath)) throw new Error("GUI build is missing. Run `npm run build` before starting the local server.");

const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};
const api = createSwitchboardApi();

function staticPath(pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  const candidate = resolve(clientDir, `.${decoded}`);
  const rel = relative(clientDir, candidate);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) return null;
  try {
    if (statSync(candidate).isFile()) return candidate;
  } catch {}
  return null;
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://dsh-switchboard.local");
  if (url.pathname.startsWith("/api/")) {
    api.handler(request, response);
    return;
  }
  if (!["GET", "HEAD"].includes(request.method ?? "")) {
    response.writeHead(405).end();
    return;
  }
  const file = staticPath(url.pathname) ?? indexPath;
  const type = types[extname(file)] ?? "application/octet-stream";
  response.writeHead(200, {
    "content-type": type,
    "content-security-policy": "default-src 'self'; img-src 'self' data:; font-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "cache-control": file === indexPath ? "no-store" : "public, max-age=31536000, immutable",
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(file).pipe(response);
});

function listening() {
  const address = server.address();
  const activePort = typeof address === "object" && address ? address.port : port;
  process.stdout.write(`DSH Switchboard GUI: http://${host}:${activePort}\n`);
}

let fallbackAttempted = false;
server.on("error", error => {
  if (error.code === "EADDRINUSE" && !explicitPort && port === 4173 && !fallbackAttempted) {
    fallbackAttempted = true;
    process.stderr.write("DSH Switchboard GUI: port 4173 is busy; selecting an available local port.\n");
    server.listen(0, host);
    return;
  }
  const detail = error.code === "EADDRINUSE"
    ? `port ${port} is already in use; choose another with --port <number>`
    : error.message;
  process.stderr.write(`DSH Switchboard GUI: ${detail}\n`);
  api.close();
  process.exitCode = 1;
});

server.on("listening", listening);
server.listen(port, host);

function close() {
  api.close();
  server.close();
}
process.once("SIGINT", close);
process.once("SIGTERM", close);
