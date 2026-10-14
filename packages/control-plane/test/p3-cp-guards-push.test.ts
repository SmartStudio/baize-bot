import { CreateBotResponse, ServerPush } from "@baize/shared";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { Sql } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { startTestServer, type ApiClient, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeUser } from "./helpers/fixtures.js";
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
let server: TestServer;

beforeAll(async () => {
  database = await createTestDb();
  commits = holdingMessageCommit(database.sql);
  server = await startTestServer(drizzle(commits.sql, { schema }));
});

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
