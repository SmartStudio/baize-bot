import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { connect as connectTcp, createServer as createTcpServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { WebSocket } from "ws";
import {
  AgentToControl,
  AGENT_PROTOCOL,
  ComputerListResponse,
  ComputerTokenResponse,
  ControlToAgent,
  controlOriginFromAgentUrl,
  DownlinkFrame,
  MeResponse,
  RegisterResponse,
  ServerPush,
  type Account,
  type ComputerId,
  type Platform,
  type WorkAppend,
} from "@baize/shared";
import { createRunner, CURRENT_SESSION_VERSION, type PromptMessage } from "@baize/bot-runner";
import { type AgentOptions, startAgent } from "@baize/computer-agent";
import { chromeProfileDir, reapProfileChromes } from "@baize/computer-agent/chrome-process";
import {
  connect,
  databaseUrl,
  DEV_EMAIL,
  DEV_PASSWORD,
  runMigrations,
  runtimeConfig,
  seed,
  startServer,
  type Db,
  type Sql,
  WS_PATH,
} from "@baize/control-plane";
import { addAccountWithToken, CredentialCrypto } from "@baize/control-plane/testing";

const AGENT_VERSION = "0.1.0-e2e";

export type StackOptions = {
  /** 控制面转发模型请求的去处。假上游的 baseUrl。 */
  readonly upstreamBaseUrl: string;
  readonly priceInputPerM: number;
  readonly priceOutputPerM: number;
  /**
   * 默认沿用 seed；注册路径通过 HTTP 创建账号、本机 token 和一个可对话 Bot。
   * 给函数就由调用方自己注册（比如在浏览器里点注册页），交回登录 cookie；之后照 App 的做法拿这个 cookie 注册本机。
   */
  readonly bootstrap?: "seed" | "register" | SignUp;
  readonly startComputer?: boolean;
  readonly disconnectGraceMs?: number;
  readonly silenceTimeoutMs?: number;
  readonly leaseRenewalIntervalMs?: number;
  /** 电脑代理用子进程跑真入口 main.ts。进程内 import 走不到 main.ts 里对环境变量的处理。 */
  readonly agentProcess?: boolean;
  /** 进程内电脑代理经一个 TCP 转发连 /agent，用例可以掐断再接上这一段，模型网关仍直连控制面。 */
  readonly cuttableAgentLink?: boolean;
  /** 可靠上行落盘后、实际发送前的确定注入点。 */
  readonly beforeReliableSend?: AgentOptions["beforeReliableSend"];
  /** 发布走的平台接口根地址，指到假平台。不给就是一个连不上的地址，绝不打到真 GitHub 和 X。 */
  readonly githubApiBaseUrl?: string;
  readonly xApiBaseUrl?: string;
  /** 只控制指标取样的时间，不改产品的扫描间隔和六小时格子。 */
  readonly metricsNow?: () => Date;
  /** 只控制例行调度器的时钟；配合 routinesTick 走真实到点触发。 */
  readonly routinesNow?: () => Date;
  /** 用已有的开手注入点固定验收发牌，不改变产品默认随机种子。 */
  readonly pokerSeed?: () => string;
  /** 换掉进程内电脑代理的助理 Chrome。不给就是真 Chrome，只在 Bot 要用浏览器时才起。 */
  readonly makeChrome?: AgentOptions["makeChrome"];
};

/** 拿到控制面端口后由调用方完成注册，回 `name=value` 形式的登录 cookie。 */
export type SignUp = (port: number) => Promise<string>;

export type Stack = {
  readonly port: number;
  readonly db: Db;
  readonly sql: Sql;
  /** 电脑代理的 Bot 数据目录，临时目录，跑完删掉。 */
  readonly dataDir: string;
  /** 电脑代理的日志。断言失败时贴出来才看得见它那一侧发生了什么。 */
  agentLog(): string;
  /** 回的是原始 JSON，调用方自己用 shared 的 schema parse。 */
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
  patch(path: string, body: unknown): Promise<unknown>;
  put(path: string, body: unknown): Promise<unknown>;
  /** 按到达顺序取下一条推送，等不到就抛。 */
  nextPush(timeoutMs?: number): Promise<ServerPush>;
  startComputer(): Promise<void>;
  stopComputer(): Promise<void>;
  /** 模拟电脑突然没了：SIGKILL 电脑代理进程，运行器来不及发任何收尾报文。只在 agentProcess 下可用。 */
  killComputer(): Promise<void>;
  /** 掐断电脑代理到 /agent 的连接，接上之前它每次重连都被当场断开。只在 cuttableAgentLink 下可用。 */
  cutAgentLink(): void;
  restoreAgentLink(): void;
  prompts(): readonly PromptMessage[];
  /** P3-11 的差分上传尚未合入；用例把真实 Pi 行经电脑代理现有可靠通道送出。 */
  appendWork(frame: WorkAppend): ReturnType<NonNullable<Parameters<typeof createRunner>[0]["workAppend"]>>;
  /**
   * 进程内的电脑代理累计收下并应用了几份 config。控制面只对「hello 的 config 已经发出」的连接派活，
   * 此前派的活落成一句「电脑不在线」而不建 run。重连之后等这个数涨过重连前的值，再发消息。
   */
  configsApplied(): number;
  connectComputer(): Promise<ComputerProbe>;
  /** 手动跑一轮发布循环，跑完时这一轮抢到的草稿都有了结论（走电脑的除外）。 */
  publishTick(): Promise<void>;
  /** 手动跑服务器已有的指标扫描，返回时取样和推送都已完成。 */
  metricsTick(): Promise<void>;
  routinesTick(): Promise<void>;
  /** 照 account-add 脚本的做法，给当前用户挂一个走接口发布的账号，令牌加密入库。 */
  addAccount(input: { platform: Platform; handle: string; token: string }): Promise<Account>;
  close(): Promise<void>;
};

const UNREACHABLE = "http://127.0.0.1:9";
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 起真控制面、真电脑代理、真运行器，模型那一端换成假上游。
 * 每次一个新库、一个新临时数据目录，跑完都拆掉，所以同一台机器上重复跑和并行跑都不打架。
 */
export async function startStack(options: StackOptions): Promise<Stack> {
  const closers: (() => Promise<void>)[] = [];
  const closeAll = async (): Promise<void> => {
    for (const close of closers.toReversed()) await close().catch(() => undefined);
  };

  try {
    const databaseName = `baize_e2e_${randomBytes(6).toString("hex")}`;
    await withAdmin((admin) => admin`CREATE DATABASE ${admin(databaseName)}`);
    closers.push(() => withAdmin((admin) => admin`DROP DATABASE ${admin(databaseName)} WITH (FORCE)`));

    const url = new URL(databaseUrl());
    url.pathname = `/${databaseName}`;
    const { db, sql } = connect(url.toString(), { max: 4 });
    closers.push(() => sql.end());
    await runMigrations(sql);

    // 控制面照它自己的规矩从环境变量读配置，这里只负责把假上游填进去。
    process.env["UPSTREAM_BASE_URL"] = options.upstreamBaseUrl;
    // 假上游不验这把钥匙，但它要进 HTTP 头，非 ASCII 会被 fetch 直接拒掉。
    process.env["UPSTREAM_API_KEY"] = "e2e-upstream-key";
    process.env["GATEWAY_MODELS"] = "plan=e2e-plan-model,fast=e2e-fast-model";
    delete process.env["GATEWAY_MODEL"];
    process.env["PRICE_INPUT_PER_M"] = String(options.priceInputPerM);
    process.env["PRICE_OUTPUT_PER_M"] = String(options.priceOutputPerM);
    delete process.env["PUBLIC_BASE_URL"];
    process.env["GITHUB_API_BASE_URL"] = options.githubApiBaseUrl ?? `${UNREACHABLE}/github`;
    process.env["X_API_BASE_URL"] = options.xApiBaseUrl ?? `${UNREACHABLE}/x`;
    const credentialsKey = randomBytes(32).toString("base64");
    process.env["CREDENTIALS_KEY"] = credentialsKey;

    // 端口交给系统分配，同一台机器上别的进程占着 3001 也不影响。
    const server = await startServer({
      db,
      port: 0,
      hostname: "127.0.0.1",
      config: runtimeConfig(),
      // 发布只在用例调 publishTick 时跑，到点的草稿什么时候发由用例说了算。
      publisher: { intervalMs: DAY_MS },
      ...(options.metricsNow === undefined ? {} : { metrics: { now: options.metricsNow } }),
      ...(options.routinesNow === undefined ? {} : { scheduler: { now: options.routinesNow, intervalMs: DAY_MS } }),
      ...(options.pokerSeed === undefined ? {} : { poker: { seed: options.pokerSeed } }),
      ...(options.disconnectGraceMs === undefined ? {} : { disconnectGraceMs: options.disconnectGraceMs }),
      ...(options.silenceTimeoutMs === undefined ? {} : { silenceTimeoutMs: options.silenceTimeoutMs }),
      ...(options.leaseRenewalIntervalMs === undefined
        ? {}
        : { leaseRenewalIntervalMs: options.leaseRenewalIntervalMs }),
    });
    closers.push(() => server.close());
    const baseUrl = `http://127.0.0.1:${server.port}`;

    const bootstrap = options.bootstrap ?? "seed";
    let computerId: ComputerId;
    let computerToken: string;
    let cookie: string;
    if (typeof bootstrap === "function") {
      cookie = await bootstrap(server.port);
      const local = await registerLocal(baseUrl, cookie);
      computerId = local.computerId;
      computerToken = local.token;
    } else if (bootstrap === "register") {
      const registered = await register(baseUrl);
      cookie = registered.cookie;
      computerId = registered.computerId;
      computerToken = registered.computerToken;
    } else {
      const seeded = await seed(db);
      if (seeded.computerToken === null) throw new Error("seed 没给出电脑 token");
      cookie = await login(baseUrl);
      computerId = seeded.computerId;
      computerToken = seeded.computerToken;
    }
    const api = makeApi(baseUrl, cookie);
    if (bootstrap === "register") {
      await api.post("/api/bots", { name: "注册助手", tags: ["助手"], description: "注册路径的 E2E 助手" });
    }

    const push = await connectPush(server.port, cookie);
    closers.push(push.close);

    const dataDir = mkdtempSync(join(tmpdir(), "e2e-m3-bots-"));
    closers.push(async () => rmSync(dataDir, { recursive: true, force: true }));

    const link = options.cuttableAgentLink ? await startLinkProxy(server.port) : null;
    if (link !== null) closers.push(link.close);
    const requireLink = () => {
      if (link === null) throw new Error("掐断连接要求 cuttableAgentLink");
      return link;
    };

    let log = "";
    const agentOptions = {
      url: `ws://127.0.0.1:${link?.port ?? server.port}/agent`,
      // 掐断期间重连一次次被当场断开，默认退避会越拉越长。
      ...(link === null ? {} : { backoff: { initialMs: 100, maxMs: 200, factor: 1 } }),
      computerId,
      token: computerToken,
      version: AGENT_VERSION,
      dataDir,
      ...(options.beforeReliableSend === undefined ? {} : { beforeReliableSend: options.beforeReliableSend }),
      log: (line: string) => {
        log += `${line}\n`;
      },
    };
    const prompts: PromptMessage[] = [];
    let configsApplied = 0;
    let appendWork: Parameters<typeof createRunner>[0]["workAppend"];
    let agent: ReturnType<typeof startAgent> | undefined;
    let agentChild: ChildProcess | undefined;
    const stopComputer = async (): Promise<void> => {
      if (agentChild !== undefined) {
        const child = agentChild;
        agentChild = undefined;
        const exited = new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once("exit", () => resolve());
        });
        child.kill("SIGTERM");
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
        }, 5_000);
        await exited;
        clearTimeout(timer);
        return;
      }
      const current = agent;
      agent = undefined;
      await current?.stop();
    };
    closers.push(stopComputer);
    const killComputer = async (): Promise<void> => {
      const child = agentChild;
      if (child === undefined) throw new Error("killComputer 要求 agentProcess");
      agentChild = undefined;
      const exited = new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once("exit", () => resolve());
      });
      child.kill("SIGKILL");
      await exited;
    };
    const startComputer = async (): Promise<void> => {
      if (agent !== undefined || agentChild !== undefined) throw new Error("电脑代理已经启动");
      let earlyExitError: Error | undefined;
      const appliedBefore = configsApplied;
      if (options.agentProcess) {
        const agentDir = fileURLToPath(new URL("../../computer-agent", import.meta.url));
        const mainPath = join(agentDir, "src", "main.ts");
        const agentEnv: NodeJS.ProcessEnv = { ...process.env };
        delete agentEnv["COMPUTER_ID"];
        delete agentEnv["AGENT_TOKEN"];
        delete agentEnv["CONTROL_PLANE_AGENT_URL"];
        delete agentEnv["BAIZE_DATA_DIR"];
        delete agentEnv["UPSTREAM_API_KEY"];
        delete agentEnv["DATABASE_URL"];

        // 不经 tsx 包装进程：SIGKILL 转发不到它的子进程，killComputer 会杀不掉真正的代理。
        const child = spawn(process.execPath, ["--import", "tsx", mainPath], {
          cwd: agentDir,
          env: agentEnv,
          stdio: ["pipe", "pipe", "pipe"],
        });
        child.stdin.write(
          `${JSON.stringify({
            url: `ws://127.0.0.1:${server.port}/agent`,
            computerId,
            token: computerToken,
            dataDir,
          })}\n`,
        );
        child.stdout?.on("data", (chunk: Buffer) => {
          log += chunk.toString();
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          log += chunk.toString();
        });
        child.on("exit", (code, signal) => {
          if (agentChild === child) {
            agentChild = undefined;
            earlyExitError = new Error(`电脑代理子进程异常退出 (code: ${code}, signal: ${signal})\n${log}`);
          }
        });
        agentChild = child;
      } else {
        agent = startAgent({
          ...agentOptions,
          ...(options.makeChrome === undefined ? {} : { makeChrome: options.makeChrome }),
          makeRunner: (config) => {
            appendWork = config.workAppend;
            const runner = createRunner(config);
            configsApplied += 1;
            return {
              ...runner,
              applyConfig: async (next) => {
                appendWork = next.workAppend;
                await runner.applyConfig(next);
                configsApplied += 1;
              },
              prompt: (message) => {
                prompts.push(message);
                return runner.prompt(message);
              },
            };
          },
        });
      }
      await waitFor(
        async () => {
          if (earlyExitError !== undefined) throw earlyExitError;
          const online = ComputerListResponse.parse(await api.get("/api/computers")).computers[0]?.status === "online";
          // 子进程的 config 数不到，只能等 online。
          return online && (options.agentProcess === true || configsApplied > appliedBefore);
        },
        options.agentProcess === true ? "电脑上线" : "电脑上线并收下 config",
      );
    };

    // 只看库里 online 会落进「电脑不在线」那一支，控制面要 config 发出后才认这台电脑能派活，所以还要等进程内代理收下 hello 的 config。
    if (options.startComputer !== false) await startComputer();

    return {
      port: server.port,
      db,
      sql,
      dataDir,
      agentLog: () => log,
      get: api.get,
      post: api.post,
      patch: api.patch,
      put: api.put,
      nextPush: push.next,
      startComputer,
      stopComputer,
      killComputer,
      cutAgentLink: () => requireLink().cut(),
      restoreAgentLink: () => requireLink().restore(),
      prompts: () => prompts,
      appendWork: (frame) => {
        if (appendWork === undefined) throw new Error("电脑代理尚未连上工作记录通道");
        return appendWork(frame);
      },
      configsApplied: () => configsApplied,
      connectComputer: async () => {
        const probe = await connectComputer({ ...agentOptions, url: `ws://127.0.0.1:${server.port}/agent` });
        closers.push(probe.close);
        return probe;
      },
      publishTick: () => server.publisher.tick(),
      metricsTick: () => server.metrics.tick(),
      routinesTick: () => server.routines.tick(),
      addAccount: async ({ platform, handle, token }) => {
        const { user } = MeResponse.parse(await api.get("/api/me"));
        return addAccountWithToken(
          db,
          new CredentialCrypto(credentialsKey),
          // 带令牌挂的号是接口授权的；小红书库约束只许走电脑，这里只是借它的行测附件和信封，不发出去。
          { ownerId: user.id, computerId, platform, via: platform === "xiaohongshu" ? "computer" : "api", handle },
          token,
        );
      },
      close: async () => {
        await closeAll();
        const leftover = await reapProfileChromes(chromeProfileDir(dataDir));
        if (leftover.length > 0) throw new Error(`电脑代理收尾后留下了助理 Chrome，PID ${leftover.join(", ")}`);
      },
    };
  } catch (error) {
    await closeAll();
    throw error;
  }
}

/**
 * 代理和控制面之间一条能掐断的 TCP 链路。代理把这个端口报成 controlOrigin，数据面的 HTTP 也从这里过，
 * 所以先看请求行：升级到 /agent 的才算可掐的那条链路，别的原样转发、掐断期间照常放行。
 * 用例要的是报文丢在半路，不是模型请求失败，这和改动前数据面直连控制面端口时一样。
 */
async function startLinkProxy(targetPort: number) {
  const links = new Set<Socket>();
  const passthrough = new Set<Socket>();
  let cut = false;
  const server = createTcpServer((client) => {
    let head = Buffer.alloc(0);
    const onHead = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const lineEnd = head.indexOf("\r\n");
      if (lineEnd === -1) return;
      client.off("data", onHead);
      client.pause();
      const isLink = head.subarray(0, lineEnd).toString("latin1").startsWith("GET /agent ");
      if (isLink && cut) {
        client.destroy();
        return;
      }
      const tracked = isLink ? links : passthrough;
      const upstream = connectTcp(targetPort, "127.0.0.1");
      const drop = () => {
        for (const socket of [client, upstream]) {
          socket.destroy();
          tracked.delete(socket);
        }
      };
      for (const socket of [client, upstream]) {
        tracked.add(socket);
        socket.on("error", drop);
        socket.on("close", drop);
      }
      upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    };
    client.on("data", onHead);
    client.on("error", () => client.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    cut: () => {
      cut = true;
      destroySockets(links);
    },
    restore: () => {
      cut = false;
    },
    close: async () => {
      destroySockets(links);
      destroySockets(passthrough);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function destroySockets(sockets: Set<Socket>): void {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
}

export type ComputerProbe = {
  frames(): readonly ControlToAgent[];
  closed(): { readonly code: number; readonly reason: string } | null;
  close(): Promise<void>;
};

async function connectComputer(options: {
  readonly url: string;
  readonly computerId: string;
  readonly token: string;
  readonly version: string;
}): Promise<ComputerProbe> {
  const socket = new WebSocket(options.url);
  const frames: ControlToAgent[] = [];
  let closed: ReturnType<ComputerProbe["closed"]> = null;
  let conn: number | undefined;
  const closing = new Promise<void>((resolve) => {
    socket.once("close", (code, reason) => {
      closed = { code, reason: reason.toString() };
      resolve();
    });
  });
  socket.on("message", (data) => {
    const raw: unknown = JSON.parse(data.toString());
    const downlink = DownlinkFrame.safeParse(raw);
    if (downlink.success) {
      frames.push(ControlToAgent.parse(downlink.data.body));
      if (conn !== undefined)
        socket.send(JSON.stringify({ conn, body: { type: "downlink_ack", upTo: downlink.data.seq } }));
      return;
    }
    const frame = ControlToAgent.parse(raw);
    frames.push(frame);
    if (frame.type === "welcome") conn = frame.conn;
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify(
      AgentToControl.parse({
        type: "hello",
        ...options,
        protocol: AGENT_PROTOCOL,
        controlOrigin: controlOriginFromAgentUrl(options.url),
        installId: randomUUID(),
        piSessionVersion: CURRENT_SESSION_VERSION,
        uplinkStream: `probe-${randomBytes(8).toString("hex")}`,
        downApplied: 0,
        activeRuns: [],
      }),
    ),
  );
  return {
    frames: () => frames,
    closed: () => closed,
    close: async () => {
      socket.close();
      await closing;
    },
  };
}

async function withAdmin(run: (admin: Sql) => Promise<unknown>): Promise<void> {
  const admin = postgres(databaseUrl(), { max: 1 });
  try {
    await run(admin);
  } finally {
    await admin.end();
  }
}

async function register(baseUrl: string): Promise<{
  readonly cookie: string;
  readonly computerId: ComputerId;
  readonly computerToken: string;
}> {
  const response = await fetch(`${baseUrl}/api/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: `e2e-${randomBytes(8).toString("hex")}@example.com`,
      password: "e2e-password",
      name: "E2E 用户",
    }),
  });
  if (!response.ok) throw new Error(`注册失败 ${response.status}：${await response.text()}`);
  RegisterResponse.parse(await response.json());
  const setCookie = response.headers.getSetCookie()[0];
  if (setCookie === undefined) throw new Error("注册成功但没发 cookie");
  const cookie = setCookie.split(";")[0] ?? "";
  const local = await registerLocal(baseUrl, cookie);
  return { cookie, computerId: local.computerId, computerToken: local.token };
}

async function registerLocal(baseUrl: string, cookie: string): Promise<{ computerId: ComputerId; token: string }> {
  const response = await fetch(`${baseUrl}/api/computers/local`, { method: "POST", headers: { cookie } });
  if (!response.ok) throw new Error(`注册本机失败 ${response.status}：${await response.text()}`);
  return ComputerTokenResponse.parse(await response.json());
}

async function login(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: DEV_EMAIL, password: DEV_PASSWORD }),
  });
  if (!response.ok) throw new Error(`登录失败 ${response.status}：${await response.text()}`);
  const cookie = response.headers.getSetCookie()[0];
  if (cookie === undefined) throw new Error("登录成功但没发 cookie");
  return cookie.split(";")[0] ?? "";
}

function makeApi(baseUrl: string, cookie: string) {
  const send = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body === undefined ? { cookie } : { cookie, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`${method} ${path} 回了 ${response.status}：${await response.text()}`);
    if (response.status === 204) return undefined;
    return await response.json();
  };
  return {
    get: (path: string): Promise<unknown> => send("GET", path),
    post: (path: string, body: unknown): Promise<unknown> => send("POST", path, body),
    patch: (path: string, body: unknown): Promise<unknown> => send("PATCH", path, body),
    put: (path: string, body: unknown): Promise<unknown> => send("PUT", path, body),
  };
}

type PushInbox = {
  next(timeoutMs?: number): Promise<ServerPush>;
  close(): Promise<void>;
};

async function connectPush(port: number, cookie: string): Promise<PushInbox> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, { headers: { cookie } });
  const queue: ServerPush[] = [];
  const waiting: ((push: ServerPush) => void)[] = [];

  socket.on("message", (data) => {
    const push = ServerPush.parse(JSON.parse(data.toString()));
    const first = waiting.shift();
    if (first === undefined) queue.push(push);
    else first(push);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  return {
    next: (timeoutMs = 30_000) =>
      new Promise<ServerPush>((resolve, reject) => {
        const ready = queue.shift();
        if (ready !== undefined) {
          resolve(ready);
          return;
        }
        let timer: NodeJS.Timeout;
        const deliver = (push: ServerPush): void => {
          clearTimeout(timer);
          resolve(push);
        };
        timer = setTimeout(() => {
          const index = waiting.indexOf(deliver);
          if (index >= 0) waiting.splice(index, 1);
          reject(new Error(`等了 ${timeoutMs}ms 也没等到下一条推送`));
        }, timeoutMs);
        waiting.push(deliver);
      }),
    close: async () => {
      socket.close();
    },
  };
}

async function waitFor(check: () => Promise<boolean>, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`等了 ${timeoutMs}ms 也没等到${what}`);
}
