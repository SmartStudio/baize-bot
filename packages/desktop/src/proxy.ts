import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { extname, join, sep } from "node:path";
import type { Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export type UiServer = { readonly origin: string; close(): Promise<void> };

export function startUiServer(webRoot: string, controlOrigin: string): Promise<UiServer> {
  const target = new URL(controlOrigin);
  const server = createServer((req, res) => {
    const path = req.url ?? "/";
    if (path === "/api" || path.startsWith("/api/") || path.startsWith("/api?")) {
      proxyHttp(req, res, target);
      return;
    }
    serveStatic(req, res, webRoot);
  });
  server.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (path !== "/api/ws") {
      socket.destroy();
      return;
    }
    proxyUpgrade(req, socket, head, target);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("界面服务没有绑到端口"));
        return;
      }
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done()))),
      });
    });
  });
}

function proxyHttp(req: IncomingMessage, res: ServerResponse, target: URL): void {
  const request = target.protocol === "https:" ? httpsRequest : httpRequest;
  const upstream = request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: req.url,
      headers: forwardedHeaders(req.headers, target),
    },
    (response) => {
      res.writeHead(response.statusCode ?? 502, forwardedHeaders(response.headers, target, false));
      response.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
}

function proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, target: URL): void {
  const port = target.port === "" ? (target.protocol === "https:" ? 443 : 80) : Number(target.port);
  const forwardUpgrade = (): void => {
    const lines = [`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1`, `Host: ${target.host}`];
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined || key.toLowerCase() === "host") continue;
      for (const item of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${item}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  };
  const upstream =
    target.protocol === "https:"
      ? tlsConnect({ host: target.hostname, port, servername: target.hostname }, () => forwardUpgrade())
      : netConnect(port, target.hostname, forwardUpgrade);
  const destroy = (): void => {
    socket.destroy();
    upstream.destroy();
  };
  upstream.on("error", destroy);
  upstream.on("close", destroy);
  socket.on("error", destroy);
  socket.on("close", destroy);
}

function forwardedHeaders(
  headers: IncomingMessage["headers"],
  target: URL,
  rewriteHost = true,
): Record<string, string | string[]> {
  const next: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || HOP.has(key.toLowerCase())) continue;
    if (rewriteHost && key.toLowerCase() === "host") continue;
    next[key] = value;
  }
  if (rewriteHost) next["host"] = target.host;
  return next;
}

function serveStatic(req: IncomingMessage, res: ServerResponse, webRoot: string): void {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const file = resolveInside(webRoot, url.pathname);
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    res.writeHead(405).end();
    return;
  }
  if (file !== null && existsSync(file) && statSync(file).isFile()) {
    sendFile(req, res, file);
    return;
  }
  const index = join(webRoot, "index.html");
  if (!existsSync(index)) {
    res.writeHead(404).end();
    return;
  }
  sendFile(req, res, index);
}

function sendFile(req: IncomingMessage, res: ServerResponse, file: string): void {
  res.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "cache-control": "no-cache",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  void pipeline(createReadStream(file), res).catch(() => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
}

function resolveInside(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const full = join(root, decoded.replace(/^[/\\]+/u, ""));
  const prefix = root.endsWith(sep) ? root : root + sep;
  return full === root || full.startsWith(prefix) ? full : null;
}
