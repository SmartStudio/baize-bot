import { CreateBotResponse, ServerPush } from "@baize/shared";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { Sql } from "../src/db/client.js";
import { WS_PATH } from "../src/server.js";
import { helloAgent } from "./helpers/agent.js";
import { startTestServer, type ApiClient, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser } from "./helpers/fixtures.js";
import { gatedDb } from "./helpers/gated-db.js";
import { connectPush, type PushClient } from "./helpers/ws.js";

/** 删号之后浏览器的推送连接要关掉，删号前已经提交、还没来得及推送的消息不能晚到旧页面。 */

const MESSAGE_INSERT = /^insert into "messages"/;
const ACCOUNT_DELETED = 1008;

type CommitHold = { readonly reached: Promise<void>; release(): void };

/**
 * 在 postgres.js 这一层，armed 之后第一个写过 messages 的事务：数据库已经提交，结果停在交回调用方之前。
 * gatedDb 的屏障只能停在某条查询上，事务提交本身不是一条查询，所以这里单独包一层 begin。
 */
function holdingMessageCommit(sql: Sql): { readonly sql: Sql; arm(): CommitHold } {
  let armed: { hit(): void; open: Promise<void> } | null = null;
  const spy = (tx: Sql, sawInsert: () => void): Sql =>
    new Proxy(tx, {
      get(target, prop) {
        if (prop === "unsafe") {
          return (query: string, ...rest: unknown[]) => {
            if (MESSAGE_INSERT.test(query)) sawInsert();
            return (target.unsafe as (q: string, ...r: unknown[]) => unknown)(query, ...rest);
          };
        }
        const value: unknown = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const wrapped = new Proxy(sql, {
    get(target, prop) {
      if (prop === "begin") {
        return (...args: unknown[]) => {
          const body = args.at(-1) as (tx: Sql) => unknown;
          let inserted = false;
          const open = Reflect.get(target, "begin") as (...a: unknown[]) => Promise<unknown>;
          return open
            .call(target, ...args.slice(0, -1), (tx: Sql) =>
              body(
                spy(tx, () => {
                  inserted = true;
                }),
              ),
            )
            .then(async (value) => {
              const gate = armed;
              if (inserted && gate !== null) {
                armed = null;
                gate.hit();
                await gate.open;
              }
              return value;
            });
        };
      }
      const value: unknown = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    sql: wrapped,
    arm: () => {
      let hit!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => (hit = resolve));
      const open = new Promise<void>((resolve) => (release = resolve));
      armed = { hit, open };
      return { reached, release };
    },
  };
}

let database: TestDb;
let commits: ReturnType<typeof holdingMessageCommit>;
let queries: ReturnType<typeof gatedDb>;
let server: TestServer;

beforeAll(async () => {
  database = await createTestDb();
  commits = holdingMessageCommit(database.sql);
  queries = gatedDb(commits.sql);
  server = await startTestServer(queries.db);
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await server.close();
  await database.close();
});

async function signedIn(): Promise<{ client: ApiClient; userId: string; email: string; groupId: string }> {
  const user = await makeUser(database.db);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "推送" })).json());
  return { client, userId: user.id, email: user.email, groupId: created.group.id };
}

function watch(push: PushClient): { readonly closed: Promise<number>; readonly received: ServerPush[] } {
  const received: ServerPush[] = [];
  push.socket.on("message", (raw) => received.push(ServerPush.parse(JSON.parse(raw.toString()))));
  const closed = new Promise<number>((resolve) => push.socket.once("close", (code) => resolve(code)));
  return { closed, received };
}

type SocketEvent =
  | { readonly kind: "message"; readonly push: ServerPush }
  | { readonly kind: "close"; readonly code: number; readonly reason: string };

function observeSocket(socket: WebSocket): {
  readonly first: Promise<SocketEvent>;
  readonly closed: Promise<SocketEvent>;
  readonly received: ServerPush[];
} {
  const received: ServerPush[] = [];
  let first!: (event: SocketEvent) => void;
  const firstEvent = new Promise<SocketEvent>((resolve) => (first = resolve));
  socket.on("message", (raw) => {
    const push = ServerPush.parse(JSON.parse(raw.toString()));
    received.push(push);
    first({ kind: "message", push });
  });
  const closed = new Promise<SocketEvent>((resolve) => {
    socket.once("close", (code, reason) => {
      const event = { kind: "close" as const, code, reason: reason.toString() };
      first(event);
      resolve(event);
    });
  });
  return { first: firstEvent, closed, received };
}

it("浏览器握手已认身份、入推送中心前删号：先收到 1008 账号已删除，快照和之后的推送都收不到", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const active = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "握手快照" })).json());
  const late = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "晚推送" })).json());
  const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);
  expect((await client.post(`/api/groups/${active.group.id}/messages`, { text: "保持这一轮进行中" })).status).toBe(201);
  const prompt = await agent.expect("prompt");
  expect(prompt.groupId).toBe(active.group.id);
  const ready = await connectPush(server.server.port, client.cookie ?? "");
  expect(await ready.nextRaw(), "同一用户在正常握手之后确实有快照可发").toMatchObject({
    type: "group_turn",
    groupId: active.group.id,
    current: active.bot.id,
  });

  const bystander = await signedIn();
  const bystanderTab = await connectPush(server.server.port, bystander.client.cookie ?? "");
  // 另一群的事务不会取消上面那一轮；提交后的晚推送也必须落在同一个已删用户身上。
  const committed = commits.arm();
  const posting = client.post(`/api/groups/${late.group.id}/messages`, { text: "握手删号之后才推" });
  await committed.reached;
  const authenticated = queries.arm(/from "sessions" inner join "users"/, "after");
  const socket = new WebSocket(`ws://localhost:${server.server.port}${WS_PATH}`, {
    headers: { cookie: client.cookie ?? "" },
  });
  const watched = observeSocket(socket);
  try {
    await authenticated.reached;
    expect((await client.request("DELETE", "/api/me", { email: user.email })).status).toBe(204);
    authenticated.release();
    expect(await watched.first, "握手后先到的必须是关闭，不能先到群回合快照消息").toEqual({
      kind: "close",
      code: ACCOUNT_DELETED,
      reason: "账号已删除",
    });
    committed.release();
    await posting;
    expect(
      (await bystander.client.post(`/api/groups/${bystander.groupId}/messages`, { text: "推送屏障" })).status,
    ).toBe(201);
    expect(await bystanderTab.next()).toMatchObject({
      type: "message",
      message: { body: { kind: "user", text: "推送屏障" } },
    });
    expect(watched.received, "关闭后的旧连接收不到快照，也收不到已经提交但延后发送的消息").toEqual([]);
  } finally {
    authenticated.release();
    committed.release();
    await posting;
    socket.terminate();
    ready.close();
    bystanderTab.close();
    agent.close();
    await agent.closed();
  }
});

it("删号事务被外键阻止而回滚：DELETE 500、账号仍在，原浏览器连接不关闭且继续收到推送", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const me = await signedIn();
  await database.sql`CREATE TABLE deletion_guard (user_id text REFERENCES users(id))`;
  await database.sql`INSERT INTO deletion_guard (user_id) VALUES (${me.userId})`;
  const tab = await connectPush(server.server.port, me.client.cookie ?? "");
  const watched = observeSocket(tab.socket);
  try {
    expect((await me.client.request("DELETE", "/api/me", { email: me.email })).status).toBe(500);
    expect((await me.client.get("/api/me")).status, "回滚保留账号和会话").toBe(200);
    expect((await me.client.post(`/api/groups/${me.groupId}/messages`, { text: "回滚后仍然推送" })).status).toBe(201);
    expect(await watched.first, "回滚后原连接收到的是新消息，不能先收到账号已删除的关闭").toMatchObject({
      kind: "message",
      push: { type: "message", message: { body: { kind: "user", text: "回滚后仍然推送" } } },
    });
    expect(tab.socket.readyState, "消息送达时原浏览器连接仍然打开").toBe(WebSocket.OPEN);
  } finally {
    tab.close();
    await watched.closed;
  }
});

it("删号返回 204 时，这个人在推送中心登记的每条浏览器连接都被关掉", async () => {
  const me = await signedIn();
  const tabs = await Promise.all([1, 2].map(() => connectPush(server.server.port, me.client.cookie ?? "")));
  const watched = tabs.map(watch);
  expect((await me.client.request("DELETE", "/api/me", { email: me.email })).status).toBe(204);
  expect(server.server.hub.isConnected(me.userId), "删号返回时推送中心里已经没有这个人的连接").toBe(false);
  expect(await Promise.all(watched.map((tab) => tab.closed)), "两个标签页都收到关闭，原因是账号已删除").toEqual([
    ACCOUNT_DELETED,
    ACCOUNT_DELETED,
  ]);
});

it("消息事务已提交、推送之前删号完成：旧页面的连接已关，这条消息不会晚到", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const me = await signedIn();
  const bystander = await signedIn();
  const bystanderTab = await connectPush(server.server.port, bystander.client.cookie ?? "");
  const old = await connectPush(server.server.port, me.client.cookie ?? "");
  const watched = watch(old);

  const committed = commits.arm();
  const posting = me.client.post(`/api/groups/${me.groupId}/messages`, { text: "提交后删号窗口" });
  try {
    await committed.reached;
    expect((await me.client.request("DELETE", "/api/me", { email: me.email })).status).toBe(204);
    expect(server.server.hub.isConnected(me.userId), "删号返回时推送中心里已经没有这个人的连接").toBe(false);
    expect(await watched.closed, "删号时旧页面的连接就被关掉").toBe(ACCOUNT_DELETED);
  } finally {
    committed.release();
    await posting;
  }

  // 同一进程里另一个人的推送照常发：确认「收不到」不是因为推送整体坏了。
  const sent = bystander.client.post(`/api/groups/${bystander.groupId}/messages`, { text: "旁人的消息" });
  expect((await sent).status).toBe(201);
  for (;;) {
    const push = await bystanderTab.next();
    if (push.type === "message" && push.message.body.kind === "user") break;
  }
  expect(
    watched.received.flatMap((push) => (push.type === "message" ? [push.message.body] : [])),
    "提交在删号之前、推送在删号之后的那条消息不发给旧连接",
  ).toEqual([]);
});
