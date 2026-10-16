import {
  ComputerTokenResponse,
  CreateBotResponse,
  PokerTableResponse,
  type BotId,
  type GroupId,
  type RunId,
} from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_CONFIG, startServer } from "../src/server.js";
import { ApiClient, TEST_CREDENTIALS_KEY, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, type TestComputer } from "./helpers/fixtures.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";

let database: TestDb;
let server: TestServer;

beforeAll(async () => {
  database = await createTestDb();
  const running = await startServer({
    db: database.db,
    port: 0,
    credentialsKey: TEST_CREDENTIALS_KEY,
    toolSecretKey: "a".repeat(64),
    config: DEFAULT_RUNTIME_CONFIG,
  });
  server = { server: running, client: () => new ApiClient(running.port), close: () => running.close() };
});

afterAll(async () => {
  await server.close();
  await database.close();
});

type Owner = {
  readonly client: ApiClient;
  readonly local: TestComputer;
  readonly remote: TestComputer | null;
  readonly groupId: GroupId;
  readonly botId: BotId;
};

async function owner(options: { readonly remote: boolean }): Promise<Owner> {
  const user = await makeUser(database.db);
  const local = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  let remote: TestComputer | null = null;
  if (options.remote) {
    const response = await client.post("/api/computers/remote");
    expect(response.status).toBe(200);
    const token = ComputerTokenResponse.parse(await response.json());
    remote = { computerId: token.computerId, token: token.token };
  }
  const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小运" })).json());
  return { client, local, remote, groupId: created.group.id, botId: created.bot.id };
}

function remoteOf(o: Owner): TestComputer {
  if (o.remote === null) throw new Error("这个用户没有云电脑");
  return o.remote;
}

async function online(computer: TestComputer): Promise<AgentClient> {
  const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);
  return agent;
}

async function choose(o: Owner, groupId: GroupId, botId: BotId, kind: "local" | "remote"): Promise<void> {
  const response = await o.client.request("PUT", `/api/groups/${groupId}/bots/${botId}/computer`, { kind });
  expect(response.status, "选电脑成功").toBe(204);
}

async function finish(agent: AgentClient, botId: BotId, groupId: GroupId, runId: RunId): Promise<void> {
  agent.send({ type: "run_done", runId, botId, groupId, steps: 1, inputTokens: 1, outputTokens: 1 });
  await agent.ack(runId);
}

describe("prompt 带这一轮的电脑快照", () => {
  it("两台都在线、群里选了云电脑：云电脑收到的 prompt 说另一台是主人的电脑、在线，选的是云电脑", async () => {
    const me = await owner({ remote: true });
    const local = await online(me.local);
    const remote = await online(remoteOf(me));

    try {
      await choose(me, me.groupId, me.botId, "remote");
      await me.client.post(`/api/groups/${me.groupId}/messages`, { text: "第一件事" });
      const prompt = await remote.expect("prompt");
      expect(prompt.text).toBe("第一件事");
      expect(prompt.computer).toEqual({ other: { kind: "local", dispatchable: true }, choice: "remote" });
    } finally {
      local.close();
      remote.close();
    }
  });

  it("主人的电脑从没连过：另一台照样报出来，只是不在线", async () => {
    const me = await owner({ remote: true });
    const remote = await online(remoteOf(me));

    try {
      await choose(me, me.groupId, me.botId, "remote");
      await me.client.post(`/api/groups/${me.groupId}/messages`, { text: "第一件事" });
      expect((await remote.expect("prompt")).computer).toEqual({
        other: { kind: "local", dispatchable: false },
        choice: "remote",
      });
    } finally {
      remote.close();
    }
  });

  it("两台都在线、没选过：本机优先，快照里 choice 是 null", async () => {
    const me = await owner({ remote: true });
    const local = await online(me.local);
    const remote = await online(remoteOf(me));

    try {
      await me.client.post(`/api/groups/${me.groupId}/messages`, { text: "第一件事" });
      expect((await local.expect("prompt")).computer).toEqual({
        other: { kind: "remote", dispatchable: true },
        choice: null,
      });
    } finally {
      local.close();
      remote.close();
    }
  });

  it("账号下只有一台电脑、群里也没选过：computer 是 null；选过以后 other 是 null", async () => {
    const me = await owner({ remote: false });
    const local = await online(me.local);

    try {
      await me.client.post(`/api/groups/${me.groupId}/messages`, { text: "第一件事" });
      const first = await local.expect("prompt");
      expect(first.computer, "Mac 单机用户没有这一段").toBeNull();
      await finish(local, me.botId, me.groupId, first.runId);

      await choose(me, me.groupId, me.botId, "local");
      await me.client.post(`/api/groups/${me.groupId}/messages`, { text: "第二件事" });
      expect((await local.expect("prompt")).computer).toEqual({ other: null, choice: "local" });
    } finally {
      local.close();
    }
  });

  it("牌桌的隐藏 run 恒为 null，哪怕牌友选了云电脑、两台都在线", async () => {
    const me = await owner({ remote: true });
    const created = await me.client.post("/api/poker/tables", { requestId: "computer-view" });
    expect(created.status).toBe(201);
    const table = PokerTableResponse.parse(await created.json()).table;
    const seatOne = table.seats.find((seat) => seat.seat === 1)?.botId;
    if (seatOne === undefined || seatOne === null) throw new Error("1 号位没有牌友");
    await choose(me, table.groupId, seatOne, "remote");
    const local = await online(me.local);
    const remote = await online(remoteOf(me));

    try {
      const started = await me.client.post(`/api/poker/tables/${table.groupId}/hands`);
      expect(started.status).toBe(201);
      const hand = PokerTableResponse.parse(await started.json()).table.hand;
      if (hand === null || hand === undefined) throw new Error("没开出手牌");
      // 第一手 1 号坐庄，四人桌翻牌前先说话的是 4 号，也就是用户自己；跟一手才轮到牌友。
      const acted = await me.client.post(`/api/poker/hands/${hand.id}/act`, {
        seq: hand.view.events.length,
        action: { kind: "call" },
      });
      expect(acted.status).toBe(200);
      const prompt = await remote.expect("prompt");
      expect(prompt.botId).toBe(seatOne);
      expect(prompt.table?.role).toBe("player");
      expect(prompt.computer, "牌桌的 run 不换电脑，不给快照").toBeNull();
    } finally {
      local.close();
      remote.close();
    }
  });
});
