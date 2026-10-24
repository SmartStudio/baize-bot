import { serve } from "@hono/node-server";
import { AGENT_FRAME_MAX_BYTES } from "@baize/shared";
import { parse as parseCookie } from "hono/utils/cookie";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { errorKind } from "./agent/events.js";
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
import { DEFAULT_GATEWAY_LIMITS } from "./http/gateway-limits.js";
import { acceptLiveViewer, LIVE_PATH } from "./live/accept.js";
import { LiveRelay, type LiveRelayDeps } from "./live/relay.js";
import { MetricPoller, type MetricPollerOptions } from "./metrics/poller.js";
import { Notifications, type NotificationOptions } from "./notifications.js";
import { PublishLoop, type PublishLoopOptions } from "./publish/loop.js";
import { remindStaleApprovals } from "./repo/approvals.js";
import { resumePendingContinuations, settleApprovalTimeouts } from "./agent/dispatch.js";
import { remindStaleHandoffs } from "./repo/handoffs.js";
import { markOnlineComputersSleeping } from "./repo/computers.js";
import { SESSION_COOKIE, deleteExpiredSessions, userForSession } from "./repo/sessions.js";
import { RoutineScheduler, type SchedulerOptions } from "./routines/scheduler.js";
import { PushHub } from "./ws/hub.js";
import { PokerSweeper, type PokerSweeperOptions } from "./poker/sweeper.js";

export const WS_PATH = "/api/ws";

/** 网页在 /api/ws 上不发数据帧，来了超过 1 KiB 的就不是我们的网页。 */
const PUSH_MAX_PAYLOAD = 1024;

/** 扫一遍放了一天还没有结论的审批和还没人确认的交接。提醒本身只发一次，扫得勤一点只是让它准时一点。 */
const REMIND_INTERVAL_MS = 60 * 60 * 1000;

/**
 * 欠着的接续多久补扫一次。推进接续的触发点都在内存里，丢了一次就要等这一轮补扫才接着做，
 * 和例行调度同一个节奏：例行本来就按分钟跑，接续晚半分钟起不算误事；每轮只走一次部分索引，查不到行就结束。
 */
const CONTINUATION_SWEEP_INTERVAL_MS = 30_000;

/** 过期会话读时已经认不出来，清理只是不让表一直涨，一小时一轮足够。 */
const SESSION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

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
  /** 同 routines，测试里手动扫一轮欠着的接续，回起了几条。 */
  sweepContinuations(): Promise<number>;
  /** 同 routines，测试里手动清一轮过期会话，回删了几行。 */
  sweepExpiredSessions(now: Date): Promise<number>;
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
  /** 不给就是 0：只认 socket 地址，不读 X-Forwarded-For。 */
  readonly trustedProxyHops?: number;
  readonly config?: RuntimeConfig;
  readonly scheduler?: Pick<SchedulerOptions, "now" | "intervalMs">;
  readonly notificationScheduler?: NotificationOptions;
  readonly disconnectGraceMs?: number;
  /** 电脑多久不发任何帧就判掉线，测试调短用。 */
  readonly silenceTimeoutMs?: number;
  readonly mcpDiscoveryTimeoutMs?: number;
  readonly leaseRenewalIntervalMs?: number;
  readonly toolSecretKey?: string;
  /** 不给就读 CREDENTIALS_KEY，缺了或不对启动失败。 */
  readonly credentialsKey?: string;
  readonly publisher?: Pick<PublishLoopOptions, "now" | "intervalMs">;
  readonly metrics?: Pick<MetricPollerOptions, "now" | "intervalMs">;
  readonly approvalTimeoutIntervalMs?: number;
  /** 画面面的输入限额和它的时钟，测试数限额用。 */
  readonly live?: Pick<LiveRelayDeps, "inputPerSecond" | "now" | "terminalGraceMs">;
};

/** 测试和 main.ts 都从这里取默认值，src 里只有 env.ts 读 process.env。 */
export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  publicBaseUrl: null,
  gatewayModels: { plan: DEFAULT_GATEWAY_MODEL, fast: DEFAULT_GATEWAY_MODEL },
  upstreamBaseUrl: DEFAULT_UPSTREAM_BASE_URL,
  upstreamApiKey: "",
  gatewayLimits: DEFAULT_GATEWAY_LIMITS,
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
  const live = new LiveRelay({ push: hub, ...options.live });

  // 只剩 OAuth 回调在没配 WEB_BASE_URL 时回退到它。监听端口在 serve() 之后才知道，回调要等授权时才拼，现取就够了。
  let publicBaseUrl = config.publicBaseUrl;
  const endpoints = { ...config.oauth, githubApiBaseUrl: config.githubApiBaseUrl, xApiBaseUrl: config.xApiBaseUrl };
  const agents = new AgentHub({
    db: options.db,
    push: hub,
    priceInputPerM: config.priceInputPerM,
    priceOutputPerM: config.priceOutputPerM,
    groupTurns,
    disconnectGraceMs: options.disconnectGraceMs,
    silenceTimeoutMs: options.silenceTimeoutMs,
    mcpDiscoveryTimeoutMs: options.mcpDiscoveryTimeoutMs,
    leaseRenewalIntervalMs: options.leaseRenewalIntervalMs,
    toolCrypto,
    notifications,
    live,
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
    live,
    toolCrypto,
    groupTurns,
    notifications,
    secureCookie: options.secureCookie ?? false,
    trustedProxyHops: options.trustedProxyHops ?? 0,
    ...(options.poker?.seed === undefined ? {} : { pokerSeed: options.poker.seed }),
    gateway: {
      models: config.gatewayModels,
      upstreamBaseUrl: config.upstreamBaseUrl,
      upstreamApiKey: config.upstreamApiKey,
      limits: config.gatewayLimits,
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
  const clients = new WebSocketServer({ noServer: true, maxPayload: PUSH_MAX_PAYLOAD });
  const agentSockets = new WebSocketServer({ noServer: true, maxPayload: AGENT_FRAME_MAX_BYTES });
  // 网页往上只发输入、结束和看密码，最大的是 2000 字的整段上屏，64KB 绰绰有余。
  const viewers = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on("upgrade", (request, socket, head) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    // http 模块在 emit upgrade 时已摘掉自己的 error 监听，认身份这段时间断连会变成未捕获异常。
    socket.on("error", () => socket.destroy());

    // 电脑代理不带 cookie，身份由它自己报的 hello 定，所以升级这一步不认人。
    if (path === AGENT_PATH) {
      agentSockets.handleUpgrade(request, socket, head, (ws) => agents.accept(ws));
      return;
    }
    if (LIVE_PATH.test(path)) {
      acceptLiveViewer({ db: options.db, viewers, relay: live }, request, socket, head);
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
  // 上一次进程在结账提交后、接续起来前没了的，启动时先补一轮，之后定期补。一轮没扫完，下一轮等它扫完再开始。
  let sweeping: Promise<unknown> | null = null;
  const sweepContinuations = (): Promise<number> => {
    const previous = sweeping;
    const sweep = (async () => {
      await previous;
      return resumePendingContinuations({ db: options.db, push: hub, agents, groupTurns, notifications });
    })();
    const tracked: Promise<unknown> = sweep
      .catch(() => 0)
      .finally(() => {
        if (sweeping === tracked) sweeping = null;
      });
    sweeping = tracked;
    return sweep;
  };
  await sweepContinuations();
  const continuationSweep = setInterval(() => {
    if (sweeping !== null) return;
    void sweepContinuations().catch((error: unknown) => console.error(`补扫欠着的接续出错：${errorKind(error)}`));
  }, CONTINUATION_SWEEP_INTERVAL_MS);
  continuationSweep.unref();

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
    settleApprovalTimeouts({ db: options.db, push: hub, agents, notifications }, now);
  const approvalTimeouts = setInterval(() => {
    void scanApprovalTimeouts(new Date()).catch((error: unknown) => console.error("扫到期审批出错", error));
  }, options.approvalTimeoutIntervalMs ?? 15_000);
  approvalTimeouts.unref();

  const sweepExpiredSessions = (now: Date): Promise<number> => deleteExpiredSessions(options.db, now);
  const sessionSweep = setInterval(() => {
    void sweepExpiredSessions(new Date()).catch((error: unknown) => console.error("清理过期会话出错", error));
  }, SESSION_SWEEP_INTERVAL_MS);
  sessionSweep.unref();

  return {
    port,
    hub,
    routines,
    notifications,
    publisher,
    metrics,
    scanApprovalTimeouts,
    sweepContinuations,
    sweepExpiredSessions,
    close: async () => {
      const pokerStopped = poker.stop();
      routines.stop();
      publisher.stop();
      metrics.stop();
      clearInterval(reminders);
      clearInterval(approvalTimeouts);
      clearInterval(continuationSweep);
      clearInterval(sessionSweep);
      live.closeAll();
      // agents.closeAll 在它第一个 await 之前同步立起停机标记，所以要先于 close 里的任何等待调用；
      // 先等网页的关闭握手或补扫再调它，链外认证中的 hello 在这段等待里回来就看不到停机，照常上线。
      await Promise.all([agents.closeAll(), hub.closeAll()]);
      await sweeping;
      await pokerStopped;
      // 断线收尾可能还在推 stuck，等它们排完再关。
      await notifications.close();
      clients.close();
      agentSockets.close();
      viewers.close();
      try {
        await new Promise<void>((resolve, reject) =>
          server.close((err) => (err === undefined || err === null ? resolve() : reject(err))),
        );
      } finally {
        await app.closeMcpClients();
      }
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
        // ws 遇到超过 maxPayload 之类的协议错误会自己关连接并 emit error，没人监听的 error 会变成未捕获异常。
        ws.on("error", () => ws.close());
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
