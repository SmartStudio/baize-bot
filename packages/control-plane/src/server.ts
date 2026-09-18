import { serve } from "@hono/node-server";
import { parse as parseCookie } from "hono/utils/cookie";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { AGENT_PATH, AgentHub } from "./agent/hub.js";
import { MentionLoopGuard } from "./agent/mention-loop.js";
import type { Db } from "./db/client.js";
import { DEFAULT_GATEWAY_MODEL, DEFAULT_UPSTREAM_BASE_URL, type RuntimeConfig } from "./env.js";
import { createApp } from "./http/app.js";
import { remindStaleApprovals } from "./repo/approvals.js";
import { markOnlineComputersSleeping } from "./repo/computers.js";
import { SESSION_COOKIE, userForSession } from "./repo/sessions.js";
import { PushHub } from "./ws/hub.js";

export const WS_PATH = "/api/ws";

/** 扫一遍放了一天还没有结论的审批。提醒本身只发一次，扫得勤一点只是让它准时一点。 */
const REMIND_INTERVAL_MS = 60 * 60 * 1000;

export type RunningServer = {
  readonly port: number;
  readonly hub: PushHub;
  close(): Promise<void>;
};

export type StartOptions = {
  readonly db: Db;
  readonly port: number;
  readonly secureCookie?: boolean;
  readonly config?: RuntimeConfig;
};

/** 测试和 main.ts 都从这里取默认值，src 里只有 env.ts 读 process.env。 */
export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  publicBaseUrl: null,
  gatewayModel: DEFAULT_GATEWAY_MODEL,
  upstreamBaseUrl: DEFAULT_UPSTREAM_BASE_URL,
  upstreamApiKey: "",
  priceInputPerM: 0,
  priceOutputPerM: 0,
};

export async function startServer(options: StartOptions): Promise<RunningServer> {
  const config = options.config ?? DEFAULT_RUNTIME_CONFIG;
  const hub = new PushHub();
  // 一个实例，两处用：用户消息在 createApp 那边归零，上行 mention 在 AgentHub 那边计数。
  const mentionLoop = new MentionLoopGuard();

  // 监听的端口在 serve() 之后才知道，而 config 报文要到电脑连上来才发，现取就够了。
  let publicBaseUrl = config.publicBaseUrl;
  const agents = new AgentHub({
    db: options.db,
    push: hub,
    gatewayModel: config.gatewayModel,
    priceInputPerM: config.priceInputPerM,
    priceOutputPerM: config.priceOutputPerM,
    mentionLoop,
    gatewayBaseUrl: () => publicBaseUrl ?? "",
  });

  const app = createApp({
    db: options.db,
    hub,
    agents,
    mentionLoop,
    secureCookie: options.secureCookie ?? false,
    gateway: {
      model: config.gatewayModel,
      upstreamBaseUrl: config.upstreamBaseUrl,
      upstreamApiKey: config.upstreamApiKey,
    },
  });
  // 还没开始监听就不可能有电脑连上来，库里剩下的在线必然是上一个进程没关干净留下的。
  await markOnlineComputersSleeping(options.db);

  const server = serve({ fetch: app.fetch, port: options.port });
  const clients = new WebSocketServer({ noServer: true });
  const agentSockets = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    // http 模块在 emit upgrade 时已摘掉自己的 error 监听，认身份这段时间断连会变成未捕获异常。
    socket.on("error", () => socket.destroy());

    // 电脑代理不带 cookie，身份由它自己报的 hello 定，所以升级这一步不认人。
    if (path === AGENT_PATH) {
      agentSockets.handleUpgrade(request, socket, head, (ws) => agents.accept(ws));
      return;
    }
    if (path !== WS_PATH) {
      socket.destroy();
      return;
    }
    acceptClient(options.db, clients, hub, request, socket, head);
  });

  const port = await listeningPort(server);
  publicBaseUrl = publicBaseUrl ?? `http://localhost:${port}`;

  const reminders = setInterval(() => {
    void remindStaleApprovals(options.db, hub, new Date()).catch((error: unknown) =>
      console.error("扫超时审批出错", error),
    );
  }, REMIND_INTERVAL_MS);
  reminders.unref();

  return {
    port,
    hub,
    close: async () => {
      clearInterval(reminders);
      hub.closeAll();
      await agents.closeAll();
      clients.close();
      agentSockets.close();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err === undefined || err === null ? resolve() : reject(err))),
      );
    },
  };
}

// WebSocket 和 HTTP 用同一份 cookie 认身份，握手时认不出人就直接拒绝升级。
function acceptClient(
  db: Db,
  clients: WebSocketServer,
  hub: PushHub,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  const token = parseCookie(request.headers.cookie ?? "")[SESSION_COOKIE] ?? null;
  const authenticated = token === null ? Promise.resolve(null) : userForSession(db, token);
  void authenticated
    .then((user) => {
      if (user === null) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      clients.handleUpgrade(request, socket, head, (ws) => hub.add(user.id, ws));
    })
    .catch(() => socket.destroy());
}

function listeningPort(server: {
  address(): AddressInfo | string | null;
  once(event: string, fn: () => void): unknown;
}): Promise<number> {
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
