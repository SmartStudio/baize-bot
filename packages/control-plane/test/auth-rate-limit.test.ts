import { ApiError } from "@baize/shared";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  LOGIN_FAILURES_PER_EMAIL,
  LOGIN_FAILURES_PER_IP,
  LOGIN_WINDOW_MS,
  REGISTER_WINDOW_MS,
  REGISTRATIONS_PER_IP,
} from "../src/http/auth-limits.js";
import { startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeUser } from "./helpers/fixtures.js";

let database: TestDb;
// 计数在进程内存里，按 IP 的那一维会被前一条用例吃满，所以每条用例一台新控制面。
let server: TestServer | null = null;

beforeAll(async () => {
  database = await createTestDb();
});

afterEach(async () => {
  await server?.close();
  server = null;
});

afterAll(async () => {
  await database.close();
});

async function start(trustedProxyHops?: number): Promise<TestServer> {
  server = await startTestServer(
    database.db,
    {},
    undefined,
    undefined,
    undefined,
    trustedProxyHops === undefined ? {} : { trustedProxyHops },
  );
  return server;
}

function login(running: TestServer, email: string, password: string, forwardedFor?: string): Promise<Response> {
  return fetch(`http://localhost:${running.server.port}/api/auth/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(forwardedFor === undefined ? {} : { "x-forwarded-for": forwardedFor }),
    },
    body: JSON.stringify({ email, password }),
  });
}

function register(running: TestServer): Promise<Response> {
  return fetch(`http://localhost:${running.server.port}/api/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `${randomUUID()}@baize.dev`, password: PASSWORD, name: "林静" }),
  });
}

async function failTimes(running: TestServer, email: string, times: number, forwardedFor?: string): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    const response = await login(running, email, "错的密码", forwardedFor);
    expect(response.status, `第 ${i + 1} 次密码错应当还是 401`).toBe(401);
  }
}

async function expectTooMany(response: Response, windowMs: number): Promise<void> {
  expect(response.status).toBe(429);
  const retryAfter = Number(response.headers.get("retry-after"));
  expect(Number.isInteger(retryAfter), "Retry-After 是整数秒").toBe(true);
  expect(retryAfter).toBeGreaterThan(0);
  expect(retryAfter).toBeLessThanOrEqual(windowMs / 1000);
  expect(ApiError.parse(await response.json()).error, "文案告诉人多久后再试").toMatch(/\d+ 分钟后再试/);
  expect(response.headers.getSetCookie(), "被挡下的请求不建会话").toEqual([]);
}

describe("登录失败计数", () => {
  it("同一邮箱连续失败到阈值后回 429 带 Retry-After，锁定期内密码对了也是 429", async () => {
    const running = await start();
    const { email } = await makeUser(database.db);

    await failTimes(running, email, LOGIN_FAILURES_PER_EMAIL);

    await expectTooMany(await login(running, email, "错的密码"), LOGIN_WINDOW_MS);
    await expectTooMany(await login(running, email, PASSWORD), LOGIN_WINDOW_MS);
  });

  it("一个邮箱被锁不影响同 IP 上别的邮箱登录", async () => {
    const running = await start();
    const locked = await makeUser(database.db);
    const other = await makeUser(database.db);

    await failTimes(running, locked.email, LOGIN_FAILURES_PER_EMAIL);

    expect((await login(running, locked.email, PASSWORD)).status).toBe(429);
    expect((await login(running, other.email, PASSWORD)).status, "别的邮箱照常登录").toBe(200);
  });

  it("同一 IP 换着邮箱失败到 IP 阈值后，任何邮箱都回 429", async () => {
    const running = await start();
    const { email } = await makeUser(database.db);

    for (let i = 0; i < LOGIN_FAILURES_PER_IP; i += 1) {
      const response = await login(running, `nobody-${i}-${randomUUID()}@baize.dev`, "错的密码");
      expect(response.status, `第 ${i + 1} 次失败还没到 IP 阈值`).toBe(401);
    }

    await expectTooMany(await login(running, email, PASSWORD), LOGIN_WINDOW_MS);
  });

  it("成功登录清掉该邮箱的失败计数", async () => {
    const running = await start();
    const { email } = await makeUser(database.db);

    await failTimes(running, email, LOGIN_FAILURES_PER_EMAIL - 1);
    expect((await login(running, email, PASSWORD)).status).toBe(200);

    await failTimes(running, email, LOGIN_FAILURES_PER_EMAIL - 1);
    expect((await login(running, email, PASSWORD)).status, "清零后又失败了不到阈值，照常登录").toBe(200);
  });

  it("并发撞同一个邮箱，密码错的回包不超过阈值", async () => {
    const running = await start();
    const { email } = await makeUser(database.db);

    const statuses = await Promise.all(
      Array.from(
        { length: LOGIN_FAILURES_PER_EMAIL * 4 },
        async () => (await login(running, email, "错的密码")).status,
      ),
    );

    expect(statuses.filter((status) => status === 401)).toHaveLength(LOGIN_FAILURES_PER_EMAIL);
    expect(statuses.filter((status) => status === 429)).toHaveLength(LOGIN_FAILURES_PER_EMAIL * 3);
  });

  it("默认不信 X-Forwarded-For，换着填它也绕不过 IP 阈值", async () => {
    const running = await start();
    const { email } = await makeUser(database.db);

    for (let i = 0; i < LOGIN_FAILURES_PER_IP; i += 1) {
      const response = await login(running, `nobody-${i}-${randomUUID()}@baize.dev`, "错的密码", `203.0.113.${i}`);
      expect(response.status).toBe(401);
    }

    expect((await login(running, email, PASSWORD, "198.51.100.7")).status).toBe(429);
  });

  it("配了信任一层代理，就按 X-Forwarded-For 最右一项分 IP 计数", async () => {
    const running = await start(1);
    const { email } = await makeUser(database.db);

    for (let i = 0; i < LOGIN_FAILURES_PER_IP; i += 1) {
      const response = await login(running, `nobody-${i}-${randomUUID()}@baize.dev`, "错的密码", "203.0.113.9");
      expect(response.status).toBe(401);
    }

    expect((await login(running, email, PASSWORD, "203.0.113.9")).status, "撞满的那个来源被挡").toBe(429);
    expect(
      (await login(running, email, PASSWORD, "203.0.113.9, 198.51.100.7")).status,
      "左边是客户端自己填的，最右一项才是代理看到的来源",
    ).toBe(200);
  });
});

describe("注册限频", () => {
  it("同一 IP 注册到阈值后回 429 带 Retry-After", async () => {
    const running = await start();

    for (let i = 0; i < REGISTRATIONS_PER_IP; i += 1) {
      expect((await register(running)).status, `第 ${i + 1} 次注册还没到阈值`).toBe(201);
    }

    await expectTooMany(await register(running), REGISTER_WINDOW_MS);
  });
});
