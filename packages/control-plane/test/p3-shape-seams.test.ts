import { BotListResponse, MessageListResponse, RunId, SendMessageResponse } from "@baize/shared";
import { afterAll, beforeAll, expect, it } from "vitest";
import { helloAgent } from "./helpers/agent.js";
import { ApiClient, startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { makeComputer, makeUser, PASSWORD } from "./helpers/fixtures.js";

let database: TestDb;
let server: TestServer;

beforeAll(async () => {
  database = await createTestDb();
  server = await startTestServer(database.db);
});

afterAll(async () => {
  await server.close();
  await database.close();
});

const POKER_SEAMS: readonly [string, string][] = [
  ["POST", "/api/poker/tables/g-any/hands"],
  ["POST", "/api/poker/hands/h-any/act"],
  ["POST", "/api/poker/hands/h-any/hint"],
  ["POST", "/api/poker/tables/g-any/leave"],
];

it("四条牌局接口没登录先 401，已接的开手、出牌与问老白对未知对象回 404，散场的桩回 501", async () => {
  const anonymous = new ApiClient(server.server.port);
  for (const [method, path] of POKER_SEAMS) {
    expect(
      (await anonymous.request(method, path, method === "GET" ? undefined : {})).status,
      `${method} ${path} 没登录`,
    ).toBe(401);
  }
  const user = await makeUser(database.db);
  const client = new ApiClient(server.server.port);
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  for (const [method, path] of POKER_SEAMS) {
    const response = await client.request(method, path, path.endsWith("/hint") ? { seq: 0 } : {});
    if (path.endsWith("/hands") || path.endsWith("/act") || path.endsWith("/hint")) {
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(await response.json()).toEqual({ error: path.endsWith("/hands") ? "没有这张牌桌" : "没有这手牌" });
    } else {
      expect(response.status, `${method} ${path}`).toBe(501);
      expect(await response.json()).toEqual({ error: "未实现" });
    }
  }
});

it("config 里每个 Bot 都带 preset，没预置的是 null，运行器靠它认牌友", async () => {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const { agent, config } = await helloAgent(server.server.port, computer.computerId, computer.token);
  try {
    expect(config.bots.length).toBeGreaterThan(0);
    for (const bot of config.bots) expect(bot.preset, `${bot.name} 的 preset`).toBeNull();
  } finally {
    agent.close();
  }
});

it("普通群发消息不受牌桌守卫影响，新消息和历史里的 visibleTo 都是 null，派下去的 prompt 带 table: null", async () => {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);
  const client = new ApiClient(server.server.port);
  try {
    expect((await client.login(user.email, PASSWORD)).status).toBe(200);
    const bots = BotListResponse.parse(await (await client.get("/api/bots")).json()).items;
    const groupId = bots[0]?.groupId;
    if (groupId === undefined) throw new Error("新用户应有主助理和它的单聊");

    // 先发一条 poker_act。未知手牌会静默丢弃，不断连接，后面的派活得照常到达。
    agent.send({
      type: "poker_act",
      runId: RunId.parse("run-nobody"),
      callId: "call-1",
      handId: "h-nobody" as never,
      seq: 0,
      action: { kind: "fold" },
    });

    const sent = await client.request("POST", `/api/groups/${groupId}/messages`, { text: "你好" });
    expect(sent.status).toBe(201);
    expect(SendMessageResponse.parse(await sent.json()).message.visibleTo).toBeNull();

    const prompt = await agent.expect("prompt");
    expect(prompt.table).toBeNull();
    expect(prompt.origin).toEqual({ kind: "user" });

    const history = MessageListResponse.parse(await (await client.get(`/api/groups/${groupId}/messages`)).json());
    expect(history.messages.map((message) => message.visibleTo)).toEqual(history.messages.map(() => null));
  } finally {
    agent.close();
  }
});
