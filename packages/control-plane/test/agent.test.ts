import { Computer, ComputerId, CreateBotResponse, type UserId } from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_GATEWAY_MODEL } from "../src/env.js";
import { findComputerByOwner } from "../src/repo/computers.js";
import { ApiClient, startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, waitFor, type TestComputer } from "./helpers/fixtures.js";
import { helloAgent, openAgent } from "./helpers/agent.js";

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

type Owner = { readonly client: ApiClient; readonly computer: TestComputer; readonly userId: UserId };

async function ownerWithComputer(): Promise<Owner> {
  const user = await makeUser(database.db);
  // token 明文只在建电脑那一刻拿得到，所以要抢在第一次登录之前建。
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  return { client, computer, userId: user.id };
}

function statusOf(userId: UserId): () => Promise<string> {
  return async () => {
    const rows = await database.sql<{ status: string }[]>`SELECT status FROM computers WHERE owner_id = ${userId}`;
    return rows[0]?.status ?? "";
  };
}

describe("握手", () => {
  it("token 不对就关连接，不发 welcome", async () => {
    const { computer } = await ownerWithComputer();
    const agent = await openAgent(server.server.port);
    agent.send({
      type: "hello",
      computerId: computer.computerId,
      token: "b".repeat(64),
      version: "test",
      activeRuns: [],
    });

    expect(await agent.closed()).toBe(4001);
  });

  it("电脑号不存在也关连接", async () => {
    const agent = await openAgent(server.server.port);
    agent.send({
      type: "hello",
      computerId: ComputerId.parse("没有这台电脑"),
      token: "b".repeat(64),
      version: "test",
      activeRuns: [],
    });

    expect(await agent.closed()).toBe(4001);
  });

  it("token 对得上就依次收到 welcome 和 config", async () => {
    const { computer, userId } = await ownerWithComputer();
    const { agent, welcome, config } = await helloAgent(server.server.port, computer.computerId, computer.token);

    try {
      expect(welcome.ownerId).toBe(userId);
      expect(Date.parse(welcome.serverTime)).not.toBeNaN();
      expect(config.bots, "这个账号还没有 Bot").toEqual([]);
      expect(config.tools, "工具连接是 M6 的事").toEqual([]);
      expect(config.modelGateway.baseUrl).toBe(`http://localhost:${server.server.port}/gateway/v1`);
      expect(config.modelGateway.apiKey, "网关 key 是 32 字节随机数的十六进制").toMatch(/^[0-9a-f]{64}$/);
      expect(config.modelGateway.model).toBe(DEFAULT_GATEWAY_MODEL);
    } finally {
      agent.close();
    }
  });

  it("握上手就算在线，断开变休眠", async () => {
    const { computer, userId } = await ownerWithComputer();
    const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);

    await waitFor(async () => (await statusOf(userId)()) === "online", "电脑变在线");
    const online = await findComputerByOwner(database.db, userId);
    expect(online?.lastSeenAt, "在线时要留下最后一次见面时间").not.toBeNull();
    expect(online?.idleSince).toBeNull();

    agent.close();
    await waitFor(async () => (await statusOf(userId)()) === "sleeping", "电脑变休眠");
    expect((await findComputerByOwner(database.db, userId))?.idleSince).not.toBeNull();
  });

  it("hello 还在查库时就断开，电脑不会挂在在线上", async () => {
    const { computer, userId } = await ownerWithComputer();
    const agent = await openAgent(server.server.port);
    agent.send({
      type: "hello",
      computerId: computer.computerId,
      token: computer.token,
      version: "test",
      activeRuns: [],
    });
    // 不等 welcome 就关。认身份那一段是异步的，关闭要排在它后面才看得见这条连接。
    agent.close();

    await waitFor(async () => (await statusOf(userId)()) === "sleeping", "电脑变休眠");
  });

  it("每次 hello 换一把新的网关 key", async () => {
    const { computer } = await ownerWithComputer();
    const first = await helloAgent(server.server.port, computer.computerId, computer.token);
    first.agent.close();
    await first.agent.closed();
    const second = await helloAgent(server.server.port, computer.computerId, computer.token);

    try {
      expect(second.config.modelGateway.apiKey).not.toBe(first.config.modelGateway.apiKey);
    } finally {
      second.agent.close();
    }
  });

  it("新连接顶掉旧连接，电脑仍然在线", async () => {
    const { computer, userId } = await ownerWithComputer();
    const first = await helloAgent(server.server.port, computer.computerId, computer.token);
    const second = await helloAgent(server.server.port, computer.computerId, computer.token);

    try {
      expect(await first.agent.closed()).toBe(4000);
      // 旧连接关掉时表里挂的已经是新连接，不能把这台写成休眠。
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await statusOf(userId)()).toBe("online");
    } finally {
      second.agent.close();
    }
  });
});

describe("心跳", () => {
  it("刷新最后一次见面时间", async () => {
    const { computer, userId } = await ownerWithComputer();
    const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);

    try {
      const before = (await findComputerByOwner(database.db, userId))?.lastSeenAt ?? "";
      await new Promise((resolve) => setTimeout(resolve, 20));
      agent.send({ type: "heartbeat", at: new Date().toISOString() });

      await waitFor(
        async () => ((await findComputerByOwner(database.db, userId))?.lastSeenAt ?? "") > before,
        "心跳刷新见面时间",
      );
    } finally {
      agent.close();
    }
  });
});

describe("Bot 变动重发 config", () => {
  it("新建、改名、删除各重发一次", async () => {
    const { client, computer } = await ownerWithComputer();
    const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);

    try {
      const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小服" })).json());
      const afterCreate = await agent.expect("config");
      expect(afterCreate.bots).toEqual([{ id: created.bot.id, name: "小服", description: created.bot.description }]);

      expect((await client.patch(`/api/bots/${created.bot.id}`, { name: "小采", description: "买东西" })).status).toBe(
        200,
      );
      const afterRename = await agent.expect("config");
      expect(afterRename.bots).toEqual([{ id: created.bot.id, name: "小采", description: "买东西" }]);

      expect((await client.delete(`/api/bots/${created.bot.id}`)).status).toBe(204);
      const afterDelete = await agent.expect("config");
      expect(afterDelete.bots).toEqual([]);
    } finally {
      agent.close();
    }
  });

  it("不发给别人的电脑", async () => {
    const mine = await ownerWithComputer();
    const other = await ownerWithComputer();
    const listener = await helloAgent(server.server.port, other.computer.computerId, other.computer.token);

    try {
      await mine.client.post("/api/bots", { name: "我的" });
      await other.client.post("/api/bots", { name: "他的" });

      // 后建的「他的」先到，说明「我的」那次根本没进这条连接，不靠超时。
      const config = await listener.agent.expect("config");
      expect(config.bots.map((b) => b.name)).toEqual(["他的"]);
    } finally {
      listener.agent.close();
    }
  });
});

describe("状态", () => {
  it("GET /api/computer 跟着握手一起变", async () => {
    const { client, computer } = await ownerWithComputer();
    expect(Computer.parse(await (await client.get("/api/computer")).json()).status).toBe("creating");

    const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);
    try {
      await waitFor(
        async () => Computer.parse(await (await client.get("/api/computer")).json()).status === "online",
        "接口上看到在线",
      );
    } finally {
      agent.close();
    }
  });
});
