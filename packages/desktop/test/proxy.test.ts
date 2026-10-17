import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo, Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startUiServer } from "../src/proxy.js";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("测试服务器没有端口"));
        return;
      }
      resolve(address.port);
    });
  });
}

describe("本机反代", () => {
  it("http 控制面绑定 ::1 时 /api 请求正常返回", async () => {
    const directory = mkdtempSync(join(tmpdir(), "baize-desktop-proxy-ipv6-"));
    const upstream = createHttpServer((request, response) => {
      if (request.url === "/api/ping") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "::1", () => resolve());
    });
    const address = upstream.address() as AddressInfo;
    const ui = await startUiServer(directory, `http://[::1]:${address.port}`);
    try {
      const response = await fetch(`${ui.origin}/api/ping`, { signal: AbortSignal.timeout(3_000) });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
    } finally {
      await ui.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000);

  it("https 控制面同时支持 /api 请求和 /api/ws 升级", async () => {
    const directory = mkdtempSync(join(tmpdir(), "baize-desktop-proxy-"));
    const keyPath = join(directory, "key.pem");
    const certPath = join(directory, "cert.pem");
    execFileSync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-subj",
      "/CN=localhost",
      "-days",
      "1",
    ]);
    const upstream = createHttpsServer(
      { key: readFileSync(keyPath), cert: readFileSync(certPath) },
      (request, response) => {
        if (request.url === "/api/ping") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: true }));
          return;
        }
        response.writeHead(404).end();
      },
    );
    upstream.on("upgrade", (request, socket) => {
      const key = request.headers["sec-websocket-key"];
      const accept = createHash("sha1")
        .update(`${String(key)}${WEBSOCKET_GUID}`)
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
    });
    const port = await listen(upstream);
    const previousTlsSetting = process.env["NODE_TLS_REJECT_UNAUTHORIZED"];
    process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
    const ui = await startUiServer(directory, `https://localhost:${port}`);
    let socket: WebSocket | null = null;
    try {
      const response = await fetch(`${ui.origin}/api/ping`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });

      socket = new WebSocket(`${ui.origin}/api/ws`);
      await new Promise<void>((resolve, reject) => {
        socket?.once("open", () => resolve());
        socket?.once("error", reject);
      });
      expect(socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      socket?.terminate();
      await ui.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      if (previousTlsSetting === undefined) delete process.env["NODE_TLS_REJECT_UNAUTHORIZED"];
      else process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = previousTlsSetting;
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("画面的 /api/live/<liveId> 升级转给控制面，本页发起的 Origin 换成控制面的，外站的原样转", async () => {
    const directory = mkdtempSync(join(tmpdir(), "baize-desktop-proxy-live-"));
    const upstream = createHttpServer((_request, response) => response.writeHead(404).end());
    const upgraded: string[] = [];
    upstream.on("upgrade", (request, socket) => {
      upgraded.push(`${String(request.url)} ${String(request.headers.origin)}`);
      socket.on("end", () => socket.end());
      const accept = createHash("sha1")
        .update(`${String(request.headers["sec-websocket-key"])}${WEBSOCKET_GUID}`)
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
    });
    const port = await listen(upstream);
    const ui = await startUiServer(directory, `http://127.0.0.1:${port}`);
    const sockets: WebSocket[] = [];
    try {
      for (const origin of [ui.origin, "https://evil.example"]) {
        const socket = new WebSocket(`${ui.origin.replace("http:", "ws:")}/api/live/live-1`, { origin });
        sockets.push(socket);
        await new Promise<void>((resolve, reject) => {
          socket.once("open", () => resolve());
          socket.once("error", reject);
        });
      }
      expect(upgraded).toEqual([`/api/live/live-1 http://127.0.0.1:${port}`, "/api/live/live-1 https://evil.example"]);
    } finally {
      for (const socket of sockets) socket.terminate();
      await ui.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000);
});
