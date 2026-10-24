import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterEach, expect, it, vi } from "vitest";
import { computers } from "../src/db/schema.js";
import { databaseUrl } from "../src/env.js";
import { helloAgent } from "./helpers/agent.js";
import { ApiClient, TEST_CREDENTIALS_KEY } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { makeComputer, makeUser, PASSWORD } from "./helpers/fixtures.js";
import { connectPush, type PushClient } from "./helpers/ws.js";

vi.setConfig({ testTimeout: 60_000 });

const SERVICE_RESTART = 1012;
const LISTENING = /控制面在 http:\/\/localhost:(\d+)/;

type ControlPlane = {
  readonly process: ChildProcessByStdio<null, Readable, Readable>;
  output(): string;
  listening(): Promise<number>;
  exited(timeoutMs?: number): Promise<number | NodeJS.Signals>;
};

const started: ControlPlane[] = [];
const databases: TestDb[] = [];

afterEach(async () => {
  for (const child of started.splice(0)) {
    if (child.process.exitCode === null && child.process.signalCode === null) child.process.kill("SIGKILL");
    await child.exited().catch(() => undefined);
  }
  for (const database of databases.splice(0)) await database.close();
});

async function testDatabase(): Promise<{ database: TestDb; url: string }> {
  const database = await createTestDb();
  databases.push(database);
  const url = new URL(databaseUrl());
  url.pathname = `/${database.databaseName}`;
  return { database, url: url.toString() };
}

function startControlPlane(url: string): ControlPlane {
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    env: {
      PATH: process.env["PATH"] ?? "",
      DATABASE_URL: url,
      PORT: "0",
      TOOL_SECRET_KEY: "a".repeat(64),
      CREDENTIALS_KEY: TEST_CREDENTIALS_KEY,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const listeners: (() => void)[] = [];
  const collect = (chunk: Buffer): void => {
    output += chunk.toString();
    for (const notify of listeners) notify();
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const exit = new Promise<number | NodeJS.Signals>((resolve) =>
    child.once("exit", (code, signal) => resolve(code ?? signal ?? -1)),
  );
  const controlPlane: ControlPlane = {
    process: child,
    output: () => output,
    listening: () =>
      Promise.race([
        new Promise<number>((resolve) => {
          const check = (): void => {
            const match = LISTENING.exec(output);
            if (match?.[1] !== undefined) resolve(Number(match[1]));
          };
          listeners.push(check);
          check();
        }),
        exit.then((code) => {
          throw new Error(`控制面没起来就退出了（${String(code)}）：${output}`);
        }),
      ]),
    exited: (timeoutMs = 20_000) =>
      Promise.race([
        exit,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`等了 ${timeoutMs}ms 控制面还没退出：${output}`)), timeoutMs).unref(),
        ),
      ]),
  };
  started.push(controlPlane);
  return controlPlane;
}

it("SIGTERM：在线电脑收到停机关闭码，库里转休眠，进程按时以 0 退出", async () => {
  const { database, url } = await testDatabase();
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const controlPlane = startControlPlane(url);
  const port = await controlPlane.listening();
  const { agent } = await helloAgent(port, computer.computerId, computer.token);

  controlPlane.process.kill("SIGTERM");

  expect(await agent.closed(), "在线电脑收到的是停机的 1012，不是断链").toBe(SERVICE_RESTART);
  expect(await controlPlane.exited(10_000), "停机走完以 0 退出").toBe(0);
  const [row] = await database.db
    .select({ status: computers.status })
    .from(computers)
    .where(eq(computers.id, computer.computerId));
  expect(row?.status, "停机把在线电脑写成休眠").toBe("sleeping");
});

async function pushNeverAnsweringClose(port: number, database: TestDb): Promise<PushClient> {
  const user = await makeUser(database.db);
  const client = new ApiClient(port);
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const push = await connectPush(port, client.cookie ?? "");
  push.socket.pause();
  return push;
}

it("停机卡住时再来一次信号：不再等，当场以 1 退出", async () => {
  const { database, url } = await testDatabase();
  const controlPlane = startControlPlane(url);
  const port = await controlPlane.listening();
  const push = await pushNeverAnsweringClose(port, database);
  try {
    controlPlane.process.kill("SIGTERM");
    await expect.poll(() => controlPlane.output(), { timeout: 10_000 }).toContain("开始停机");
    controlPlane.process.kill("SIGTERM");
    expect(await controlPlane.exited(5_000), "第二次信号强退").toBe(1);
    expect(controlPlane.output()).toContain("停机中又收到 SIGTERM，强制退出");
  } finally {
    push.close();
  }
});

it("停机一直走不完：到时限自己以 1 退出，不等编排器 SIGKILL", async () => {
  const { database, url } = await testDatabase();
  const controlPlane = startControlPlane(url);
  const port = await controlPlane.listening();
  const push = await pushNeverAnsweringClose(port, database);
  try {
    controlPlane.process.kill("SIGTERM");
    expect(await controlPlane.exited(15_000), "超时强退").toBe(1);
    expect(controlPlane.output()).toContain("秒还没走完");
  } finally {
    push.close();
  }
});

it("同一个库起第二个控制面：第二个报单实例后退出，第一个照常服务", async () => {
  const { database, url } = await testDatabase();
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const first = startControlPlane(url);
  const port = await first.listening();
  const { agent } = await helloAgent(port, computer.computerId, computer.token);

  const second = startControlPlane(url);
  expect(await second.exited(), "第二个实例拿不到锁就退出").toBe(1);
  expect(second.output()).toContain(
    "同一个库上已经有一个控制面在跑。控制面只能单实例运行：先停掉那一个，或者在 .env 里把 DATABASE_URL 指到别的库（工作树里跑 pnpm db:own 建一个自己的）",
  );
  expect(second.output(), "第二个没有开始监听").not.toMatch(LISTENING);

  const health = await fetch(`http://127.0.0.1:${port}/api/health`);
  expect(health.status, "第一个不受影响").toBe(200);
  const [row] = await database.db
    .select({ status: computers.status })
    .from(computers)
    .where(eq(computers.id, computer.computerId));
  expect(row?.status, "第二个没把第一个的在线电脑写成休眠").toBe("online");
  agent.close();
});

it("第一个停机退出后，同一个库能再起一个", async () => {
  const { url } = await testDatabase();
  const first = startControlPlane(url);
  await first.listening();
  first.process.kill("SIGINT");
  expect(await first.exited(10_000)).toBe(0);

  const second = startControlPlane(url);
  const port = await second.listening();
  expect((await fetch(`http://127.0.0.1:${port}/api/health`)).status).toBe(200);
});

it("持锁的那条库连接被掐断：控制面按停机流程退出，不带着失效的锁接着跑", async () => {
  const { database, url } = await testDatabase();
  const controlPlane = startControlPlane(url);
  await controlPlane.listening();
  const admin = postgres(databaseUrl(), { max: 1 });
  try {
    await admin`
      SELECT pg_terminate_backend(locks.pid)
      FROM pg_locks locks JOIN pg_database db ON db.oid = locks.database
      WHERE locks.locktype = 'advisory' AND db.datname = ${database.databaseName}`;
  } finally {
    await admin.end();
  }
  expect(await controlPlane.exited(10_000), "丢了锁以非 0 退出，交给编排器重启").toBe(1);
  expect(controlPlane.output()).toContain("单实例锁");
});

it("库地址里带 idle_timeout：持锁连接空闲过了那个时长也不被关，控制面照常服务", async () => {
  const { database, url } = await testDatabase();
  const idle = new URL(url);
  idle.searchParams.set("idle_timeout", "1");
  const controlPlane = startControlPlane(idle.toString());
  const port = await controlPlane.listening();
  const admin = postgres(databaseUrl(), { max: 1 });
  try {
    const lockHolder = async (): Promise<"fresh" | "idle_past_timeout" | "gone"> => {
      const [row] = await admin<{ idlePastTimeout: boolean }[]>`
        SELECT now() - activity.state_change > interval '1.5 seconds' AS "idlePastTimeout"
        FROM pg_locks locks
        JOIN pg_database db ON db.oid = locks.database
        JOIN pg_stat_activity activity ON activity.pid = locks.pid
        WHERE locks.locktype = 'advisory' AND locks.granted AND db.datname = ${database.databaseName}`;
      if (row === undefined) return "gone";
      return row.idlePastTimeout ? "idle_past_timeout" : "fresh";
    };
    await expect.poll(lockHolder, { timeout: 10_000 }).not.toBe("fresh");
    expect(await lockHolder(), "空闲超过 1 秒锁还在原来那条连接上").toBe("idle_past_timeout");
    expect(controlPlane.process.exitCode, "没有因为丢锁退出").toBeNull();
    expect((await fetch(`http://127.0.0.1:${port}/api/health`)).status).toBe(200);
  } finally {
    await admin.end();
  }
});
