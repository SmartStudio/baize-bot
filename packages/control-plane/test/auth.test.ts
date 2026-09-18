import { ApiError, LoginResponse, MeResponse } from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../src/repo/sessions.js";
import { startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeUser } from "./helpers/fixtures.js";
import { expectUpgradeRejected } from "./helpers/ws.js";

let database: TestDb;
let server: TestServer;
let email: string;

beforeAll(async () => {
  database = await createTestDb();
  server = await startTestServer(database.db);
  email = (await makeUser(database.db)).email;
});

afterAll(async () => {
  await server.close();
  await database.close();
});

describe("登录", () => {
  it("密码对时返回 user 并下发 httpOnly 的会话 cookie", async () => {
    const client = server.client();
    const response = await client.login(email, PASSWORD);

    expect(response.status, "登录成功应当是 200").toBe(200);
    const parsed = LoginResponse.parse(await response.json());
    expect(parsed.user.email).toBe(email);

    const cookies = response.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    expect(session, `Set-Cookie 里应当有 ${SESSION_COOKIE}`).toBeDefined();
    expect(session, "会话 cookie 必须是 httpOnly").toMatch(/HttpOnly/i);
  });

  it("密码错时返回 401 且不下发 cookie", async () => {
    const client = server.client();
    const response = await client.login(email, "错的密码");

    expect(response.status).toBe(401);
    ApiError.parse(await response.json());
    expect(response.headers.getSetCookie(), "失败的登录不应当建会话").toEqual([]);
  });

  it("邮箱不存在时返回 401，措辞不区分邮箱错还是密码错", async () => {
    const wrongEmail = await server.client().login("nobody@baize.dev", PASSWORD);
    const wrongPassword = await server.client().login(email, "错的密码");

    expect(wrongEmail.status).toBe(401);
    expect(ApiError.parse(await wrongEmail.json()).error).toBe(ApiError.parse(await wrongPassword.json()).error);
  });

  it("请求体不合法时返回 400", async () => {
    const response = await server.client().post("/api/auth/login", { email: "不是邮箱", password: "" });
    expect(response.status).toBe(400);
    ApiError.parse(await response.json());
  });
});

describe("登录态", () => {
  it("未登录访问 /api/me、/api/bots、/api/settings 都是 401 { error }", async () => {
    const client = server.client();
    for (const path of ["/api/me", "/api/bots", "/api/settings"]) {
      const response = await client.get(path);
      expect(response.status, `${path} 未登录应当 401`).toBe(401);
      ApiError.parse(await response.json());
    }
  });

  it("没有 cookie、伪造 cookie、退出后的 cookie 都握不上 WebSocket", async () => {
    await expect(expectUpgradeRejected(server.server.port, null)).resolves.toBe(401);
    await expect(expectUpgradeRejected(server.server.port, `${SESSION_COOKIE}=forged-token`)).resolves.toBe(401);

    const client = server.client();
    await client.login(email, PASSWORD);
    const sessionCookie = client.cookie ?? "";
    await client.post("/api/auth/logout");
    await expect(expectUpgradeRejected(server.server.port, sessionCookie)).resolves.toBe(401);
  });

  it("登录后 /api/me 返回同一个 user", async () => {
    const client = server.client();
    const login = LoginResponse.parse(await (await client.login(email, PASSWORD)).json());
    const response = await client.get("/api/me");

    expect(response.status).toBe(200);
    expect(MeResponse.parse(await response.json()).user).toEqual(login.user);
  });

  it("退出后原 cookie 失效", async () => {
    const client = server.client();
    await client.login(email, PASSWORD);
    const sessionCookie = client.cookie;
    expect(sessionCookie).not.toBeNull();
    expect((await client.get("/api/me")).status, "退出前这个 cookie 是好用的").toBe(200);

    const logout = await client.post("/api/auth/logout");
    expect(logout.status).toBe(204);

    const response = await fetch(`${client.origin}/api/me`, {
      headers: { cookie: sessionCookie ?? "" },
    });
    expect(response.status, "退出后原来那个 cookie 不应当还能用").toBe(401);
  });
});
