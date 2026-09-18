import { serve } from "@hono/node-server";
import { parse as parseCookie } from "hono/utils/cookie";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import type { Db } from "./db/client.js";
import { createApp } from "./http/app.js";
import { SESSION_COOKIE, userForSession } from "./repo/sessions.js";
import { PushHub } from "./ws/hub.js";

export const WS_PATH = "/api/ws";

export type RunningServer = {
  readonly port: number;
  readonly hub: PushHub;
  close(): Promise<void>;
};

export type StartOptions = {
  readonly db: Db;
  readonly port: number;
  readonly secureCookie?: boolean;
};

export async function startServer(options: StartOptions): Promise<RunningServer> {
  const hub = new PushHub();
  const app = createApp({ db: options.db, hub, secureCookie: options.secureCookie ?? false });
  const server = serve({ fetch: app.fetch, port: options.port });
  const wss = new WebSocketServer({ noServer: true });

  // WebSocket 和 HTTP 用同一份 cookie 认身份，握手时认不出人就直接拒绝升级。
  server.on("upgrade", (request, socket, head) => {
    if (new URL(request.url ?? "/", "http://localhost").pathname !== WS_PATH) {
      socket.destroy();
      return;
    }
    // http 模块在 emit upgrade 时已摘掉自己的 error 监听，认身份这段时间断连会变成未捕获异常。
    socket.on("error", () => socket.destroy());

    const token = parseCookie(request.headers.cookie ?? "")[SESSION_COOKIE] ?? null;
    const authenticated = token === null ? Promise.resolve(null) : userForSession(options.db, token);
    void authenticated
      .then((user) => {
        if (user === null) {
          socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
          return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => hub.add(user.id, ws));
      })
      .catch(() => socket.destroy());
  });

  const port = await listeningPort(server);

  return {
    port,
    hub,
    close: async () => {
      hub.closeAll();
      wss.close();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err === undefined || err === null ? resolve() : reject(err))),
      );
    },
  };
}

function listeningPort(server: { address(): AddressInfo | string | null; once(event: string, fn: () => void): unknown }): Promise<number> {
  return new Promise((resolve, reject) => {
    const settle = () => {
      const address = server.address();
      if (address === null || typeof address === "string") reject(new Error("服务器没有绑定到 TCP 端口"));
      else resolve(address.port);
    };
    const bound = server.address();
    if (bound === null) server.once("listening", settle);
    else settle();
  });
}

