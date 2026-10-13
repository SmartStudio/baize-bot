import { serve } from "@hono/node-server";
import { parse as parseCookie } from "hono/utils/cookie";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { AGENT_PATH, AgentHub } from "./agent/hub.js";
import { GroupTurns } from "./agent/group-turn.js";
import { ToolCrypto } from "./crypto.js";
import type { Db } from "./db/client.js";
import { AccountTokens, CredentialCrypto } from "./credentials.js";
import {
  DEFAULT_GATEWAY_MODEL,
  DEFAULT_GITHUB_API_BASE_URL,
  DEFAULT_GITHUB_OAUTH_BASE_URL,
  DEFAULT_UPSTREAM_BASE_URL,
  DEFAULT_X_API_BASE_URL,
  DEFAULT_X_OAUTH_BASE_URL,
  credentialsKey,
  toolSecretKey,
  type RuntimeConfig,
} from "./env.js";
import { createApp } from "./http/app.js";
import { MetricPoller, type MetricPollerOptions } from "./metrics/poller.js";
import { Notifications, type NotificationOptions } from "./notifications.js";
import { PublishLoop, type PublishLoopOptions } from "./publish/loop.js";
import { remindStaleApprovals } from "./repo/approvals.js";
import { settleApprovalTimeouts } from "./agent/dispatch.js";
import { remindStaleHandoffs } from "./repo/handoffs.js";
import { markOnlineComputersSleeping } from "./repo/computers.js";
import { SESSION_COOKIE, userForSession } from "./repo/sessions.js";
import { RoutineScheduler, type SchedulerOptions } from "./routines/scheduler.js";
import { PushHub } from "./ws/hub.js";
import { PokerSweeper, type PokerSweeperOptions } from "./poker/sweeper.js";

export const WS_PATH = "/api/ws";

/** 扫一遍放了一天还没有结论的审批和还没人确认的交接。提醒本身只发一次，扫得勤一点只是让它准时一点。 */
const REMIND_INTERVAL_MS = 60 * 60 * 1000;

export type RunningServer = {
  readonly port: number;
  readonly hub: PushHub;
  /** 露出来是为了在测试里自己说什么时候到点，正常跑的时候没人碰它。 */
  readonly routines: RoutineScheduler;
  readonly notifications: Notifications;
  /** 同 routines，测试里手动 tick。 */
  readonly publisher: PublishLoop;
  /** 同 routines，测试里手动 tick。 */
  readonly metrics: MetricPoller;
  scanApprovalTimeouts(now: Date): Promise<number>;
  close(): Promise<void>;
};

export type StartOptions = {
  /** seed 是每手牌的发牌种子，真栈验收靠它发出确定的牌。不给就是 32 字节随机数，main.ts 不传。 */
  readonly poker?: PokerSweeperOptions & { readonly seed?: () => string };
  readonly db: Db;
  readonly port: number;
  /** 不给就监听通配地址。测试给 127.0.0.1：macOS 分临时端口时不避开别的进程占在 127.0.0.1 上的同号端口，客户端连 127.0.0.1 会连到别人那里。 */
  readonly hostname?: string;
  readonly secureCookie?: boolean;
  readonly config?: RuntimeConfig;
  readonly scheduler?: Pick<SchedulerOptions, "now" | "intervalMs">;
  readonly notificationScheduler?: NotificationOptions;
  readonly disconnectGraceMs?: number;
  /** 电脑多久不发任何帧就判掉线，测试调短用。 */
  readonly silenceTimeoutMs?: number;
  readonly toolSecretKey?: string;
  /** 不给就读 CREDENTIALS_KEY，缺了或不对启动失败。 */
  readonly credentialsKey?: string;
  readonly publisher?: Pick<PublishLoopOptions, "now" | "intervalMs">;
  readonly metrics?: Pick<MetricPollerOptions, "now" | "intervalMs">;
  readonly approvalTimeoutIntervalMs?: number;
};

/** 测试和 main.ts 都从这里取默认值，src 里只有 env.ts 读 process.env。 */
export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  publicBaseUrl: null,
  gatewayModels: { plan: DEFAULT_GATEWAY_MODEL, fast: DEFAULT_GATEWAY_MODEL },
  upstreamBaseUrl: DEFAULT_UPSTREAM_BASE_URL,
  upstreamApiKey: "",
  priceInputPerM: 0,
  priceOutputPerM: 0,
  githubApiBaseUrl: DEFAULT_GITHUB_API_BASE_URL,
  xApiBaseUrl: DEFAULT_X_API_BASE_URL,
  webBaseUrl: null,
  oauth: {
    github: null,
    x: null,
    githubOauthBaseUrl: DEFAULT_GITHUB_OAUTH_BASE_URL,
    xOauthBaseUrl: DEFAULT_X_OAUTH_BASE_URL,
  },
};

export async function startServer(options: StartOptions): Promise<RunningServer> {
  const config = options.config ?? DEFAULT_RUNTIME_CONFIG;
  const toolCrypto = new ToolCrypto(options.toolSecretKey ?? toolSecretKey());
  const credentialCrypto = new CredentialCrypto(options.credentialsKey ?? credentialsKey());
  const hub = new PushHub();
  const notifications = new Notifications(options.db, hub, options.notificationScheduler);
  const groupTurns = new GroupTurns(options.db, hub);

  // 监听的端口在 serve() 之后才知道，而 config 报文要到电脑连上来才发，现取就够了。
  let publicBaseUrl = config.publicBaseUrl;
  const endpoints = { ...config.oauth, githubApiBaseUrl: config.githubApiBaseUrl, xApiBaseUrl: config.xApiBaseUrl };
  const agents = new AgentHub({
    db: options.db,
    push: hub,
    priceInputPerM: config.priceInputPerM,
    priceOutputPerM: config.priceOutputPerM,
    groupTurns,
    gatewayBaseUrl: () => publicBaseUrl ?? "",
    disconnectGraceMs: options.disconnectGraceMs,
    silenceTimeoutMs: options.silenceTimeoutMs,
    toolCrypto,
    notifications,
  });
  // 刷新成功把过期账号带回 valid 和授权回调走同一套推送：账号页和 config.accounts 都要知道它又能用了。
  const tokens = new AccountTokens(options.db, credentialCrypto, endpoints, async (account) => {
    hub.push(account.ownerId, { type: "account_updated", account });
    // 新令牌已经落库，这一趟请求用它照常走；重发 config 出错只影响电脑那边晚点知道，不能把请求变成 502。
    await agents.sendConfig(account.ownerId).catch((error: unknown) => {
      console.error(`账号 ${account.id} 刷新后重发 config 出错`, error);
    });
  });

  const app = createApp({
    db: options.db,
    hub,
    agents,
    toolCrypto,
    groupTurns,
    notifications,
    secureCookie: options.secureCookie ?? false,
    ...(options.poker?.seed === undefined ? {} : { pokerSeed: options.poker.seed }),
    gateway: {
      models: config.gatewayModels,
      upstreamBaseUrl: config.upstreamBaseUrl,
      upstreamApiKey: config.upstreamApiKey,
    },
    platformAccounts: {
      crypto: credentialCrypto,
      tokens,
      endpoints,
      webBaseUrl: () => config.webBaseUrl ?? publicBaseUrl ?? "",
    },
  });
  // 还没开始监听就不可能有电脑连上来，库里剩下的在线必然是上一个进程没关干净留下的。
  await markOnlineComputersSleeping(options.db);

  const server = serve({
    fetch: app.fetch,
    port: options.port,
    ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
  });
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
    acceptClient(options.db, clients, hub, groupTurns, notifications, request, socket, head);
  });

  const port = await listeningPort(server);
  publicBaseUrl = publicBaseUrl ?? `http://localhost:${port}`;

  const routines = new RoutineScheduler({
    db: options.db,
    push: hub,
    agents,
    groupTurns,
    notifications,
    ...options.scheduler,
  });
  await routines.start();
  notifications.start();

  const publisher = new PublishLoop({
    db: options.db,
    push: hub,
    notifications,
    tokens,
    bases: { githubApiBaseUrl: config.githubApiBaseUrl, xApiBaseUrl: config.xApiBaseUrl },
    computers: agents,
    ...options.publisher,
  });
  await publisher.start();

  const metrics = new MetricPoller({
    db: options.db,
    push: hub,
    notifications,
    agents,
    tokens,
    githubApiBaseUrl: config.githubApiBaseUrl,
    ...options.metrics,
  });
  metrics.start();

  const poker = new PokerSweeper({ db: options.db, push: hub, agents }, options.poker);
  poker.start();

  const reminders = setInterval(() => {
    const now = new Date();
    void remindStaleApprovals(options.db, hub, now).catch((error: unknown) => console.error("扫超时审批出错", error));
    void remindStaleHandoffs(options.db, hub, now).catch((error: unknown) => console.error("扫超时交接出错", error));
  }, REMIND_INTERVAL_MS);
  reminders.unref();

  const scanApprovalTimeouts = (now: Date): Promise<number> =>
    settleApprovalTimeouts({ db: options.db, push: hub, agents }, now);
  const approvalTimeouts = setInterval(() => {
    void scanApprovalTimeouts(new Date()).catch((error: unknown) => console.error("扫到期审批出错", error));
  }, options.approvalTimeoutIntervalMs ?? 15_000);
  approvalTimeouts.unref();

  return {
    port,
    hub,
    routines,
    notifications,
    publisher,
    metrics,
    scanApprovalTimeouts,
    close: async () => {
      const pokerStopped = poker.stop();
      routines.stop();
      publisher.stop();
      metrics.stop();
      clearInterval(reminders);
      clearInterval(approvalTimeouts);
      await hub.closeAll();
      await agents.closeAll();
      await pokerStopped;
      // 断线收尾可能还在推 stuck，等它们排完再关。
      await notifications.close();
      clients.close();
      agentSockets.close();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err === undefined || err === null ? resolve() : reject(err))),
      );
      await app.closeMcpClients();
    },
  };
}

// WebSocket 和 HTTP 用同一份 cookie 认身份，握手时认不出人就直接拒绝升级。
function acceptClient(
  db: Db,
  clients: WebSocketServer,
  hub: PushHub,
  groupTurns: GroupTurns,
  notifications: Notifications,
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
      clients.handleUpgrade(request, socket, head, (ws) => {
        hub.add(user.id, ws);
        for (const snapshot of groupTurns.snapshots(user.id)) ws.send(JSON.stringify(snapshot));
        void notifications.connected(user.id).catch((error: unknown) => console.error("补发免打扰汇总出错", error));
      });
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
