import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { WebSocket } from "ws";
import { AgentToControl, Computer, ControlToAgent, ServerPush } from "@baize/shared";
import { createRunner, type PromptMessage } from "@baize/bot-runner";
import { startAgent } from "@baize/computer-agent";
import { connect, type Db, type Sql } from "@baize/control-plane/src/db/client.js";
import { runMigrations } from "@baize/control-plane/src/db/migrate.js";
import { databaseUrl, runtimeConfig } from "@baize/control-plane/src/env.js";
import { DEV_EMAIL, DEV_PASSWORD, seed } from "@baize/control-plane/src/seed.js";
import { startServer, WS_PATH } from "@baize/control-plane/src/server.js";

const AGENT_VERSION = "0.1.0-e2e";

export type StackOptions = {
  /** 控制面转发模型请求的去处。假上游的 baseUrl。 */
  readonly upstreamBaseUrl: string;
  readonly priceInputPerM: number;
  readonly priceOutputPerM: number;
  readonly startComputer?: boolean;
};

export type Stack = {
  readonly db: Db;
  readonly sql: Sql;
  /** 电脑代理的 Bot 数据目录，临时目录，跑完删掉。 */
  readonly dataDir: string;
  /** 电脑代理的日志。断言失败时贴出来才看得见它那一侧发生了什么。 */
  agentLog(): string;
  /** 回的是原始 JSON，调用方自己用 shared 的 schema parse。 */
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
  /** 按到达顺序取下一条推送，等不到就抛。 */
  nextPush(timeoutMs?: number): Promise<ServerPush>;
  startComputer(): Promise<void>;
  stopComputer(): Promise<void>;
  prompts(): readonly PromptMessage[];
  connectComputer(): Promise<ComputerProbe>;
  close(): Promise<void>;
};

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
    process.env["PRICE_INPUT_PER_M"] = String(options.priceInputPerM);
    process.env["PRICE_OUTPUT_PER_M"] = String(options.priceOutputPerM);
    delete process.env["PUBLIC_BASE_URL"];

    // 端口交给系统分配，同一台机器上别的进程占着 3001 也不影响。
    const server = await startServer({ db, port: 0, config: runtimeConfig() });
    closers.push(() => server.close());
    const baseUrl = `http://127.0.0.1:${server.port}`;

    const seeded = await seed(db);
    if (seeded.computerToken === null) throw new Error("seed 没给出电脑 token");

    const cookie = await login(baseUrl);
    const api = makeApi(baseUrl, cookie);

    const push = await connectPush(server.port, cookie);
    closers.push(push.close);

    const dataDir = mkdtempSync(join(tmpdir(), "e2e-m3-bots-"));
    closers.push(async () => rmSync(dataDir, { recursive: true, force: true }));

    let log = "";
    const agentOptions = {
      url: `ws://127.0.0.1:${server.port}/agent`,
      computerId: seeded.computerId,
      token: seeded.computerToken,
      version: AGENT_VERSION,
      dataDir,
      log: (line: string) => {
        log += `${line}\n`;
      },
    };
    const prompts: PromptMessage[] = [];
    let agent: ReturnType<typeof startAgent> | undefined;
    const stopComputer = async (): Promise<void> => {
      const current = agent;
      agent = undefined;
      await current?.stop();
    };
    closers.push(stopComputer);
    const startComputer = async (): Promise<void> => {
      if (agent !== undefined) throw new Error("电脑代理已经启动");
      agent = startAgent({
        ...agentOptions,
        makeRunner: (config) => {
          const runner = createRunner(config);
          return {
            ...runner,
            prompt: (message) => {
              prompts.push(message);
              return runner.prompt(message);
            },
          };
        },
      });
      await waitFor(async () => Computer.parse(await api.get("/api/computer")).status === "online", "电脑上线");
    };

    // 电脑上线之后控制面才会派活，不等的话 dispatch 会走「电脑不在线」那一支。
    if (options.startComputer !== false) await startComputer();

    return {
      db,
      sql,
      dataDir,
      agentLog: () => log,
      get: api.get,
      post: api.post,
      nextPush: push.next,
      startComputer,
      stopComputer,
      prompts: () => prompts,
      connectComputer: async () => {
        const probe = await connectComputer(agentOptions);
        closers.push(probe.close);
        return probe;
      },
      close: closeAll,
    };
  } catch (error) {
    await closeAll();
    throw error;
  }
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
  const closing = new Promise<void>((resolve) => {
    socket.once("close", (code, reason) => {
      closed = { code, reason: reason.toString() };
      resolve();
    });
  });
  socket.on("message", (data) => frames.push(ControlToAgent.parse(JSON.parse(data.toString()))));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(JSON.stringify(AgentToControl.parse({ type: "hello", ...options })));
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
    return await response.json();
  };
  return {
    get: (path: string): Promise<unknown> => send("GET", path),
    post: (path: string, body: unknown): Promise<unknown> => send("POST", path, body),
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
