import { randomUUID } from "node:crypto";
import {
  CreateBotResponse,
  CreateGroupResponse,
  MessageListResponse,
  RunId,
  SendMessageResponse,
  type BotId,
  type GroupId,
  type UserId,
} from "@baize/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CONTEXT_MESSAGES, dispatchUserMessage } from "../src/agent/dispatch.js";
import { AgentHub } from "../src/agent/hub.js";
import { agentOutbox } from "../src/db/schema.js";
import { GroupTurns } from "../src/agent/group-turn.js";
import { ToolCrypto } from "../src/crypto.js";
import { LiveRelay } from "../src/live/relay.js";
import { appendMessage } from "../src/repo/messages.js";
import { ApiClient, startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, waitFor, type TestComputer } from "./helpers/fixtures.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { connectPush, type PushClient } from "./helpers/ws.js";

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

type Owner = {
  readonly ownerId: UserId;
  readonly client: ApiClient;
  readonly computer: TestComputer;
  readonly groupId: GroupId;
  readonly botId: BotId;
};

async function ownerWithBot(): Promise<Owner> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小服" })).json());
  return { ownerId: user.id, client, computer, groupId: created.group.id, botId: created.bot.id };
}

function dispatchDeps(Hub: typeof AgentHub = AgentHub) {
  return {
    db: database.db,
    push: server.server.hub,
    notifications: server.server.notifications,
    groupTurns: new GroupTurns(database.db, server.server.hub),
    agents: new Hub({
      db: database.db,
      push: server.server.hub,
      priceInputPerM: 0,
      priceOutputPerM: 0,
      groupTurns: new GroupTurns(database.db, server.server.hub),
      toolCrypto: new ToolCrypto("a".repeat(64)),
      notifications: server.server.notifications,
      live: new LiveRelay({ push: server.server.hub }),
    }),
  };
}

async function online(owner: Owner): Promise<AgentClient> {
  const { agent } = await helloAgent(server.server.port, owner.computer.computerId, owner.computer.token);
  return agent;
}

async function statusOf(owner: Owner): Promise<string> {
  const rows = await database.sql<{ status: string }[]>`
    SELECT status FROM computers WHERE id = ${owner.computer.computerId}
  `;
  return rows[0]?.status ?? "";
}

async function runCount(groupId: GroupId): Promise<number> {
  const rows = await database.sql<{ n: string }[]>`SELECT count(*) AS n FROM runs WHERE group_id = ${groupId}`;
  return Number(rows[0]?.n ?? "0");
}

async function nextOfType(push: PushClient, type: string) {
  for (let seen = 0; seen < 10; seen += 1) {
    const item = await push.next();
    if (item.type === type) return item;
  }
  throw new Error(`等了 10 条推送都没有 ${type}`);
}

/** 把眼下已经到的推送都收下来，收到等不到为止。 */
async function drain(push: PushClient) {
  const items = [];
  for (;;) {
    try {
      items.push(await push.next(300));
    } catch {
      return items;
    }
  }
}

describe("派活", () => {
  it("电脑离线时单 Bot 群和无人经手的多 Bot 群都返回派不出去和原因", async () => {
    const owner = await ownerWithBot();
    const offline = await appendMessage(database.db, owner.groupId, { kind: "user", text: "先存着" });
    expect(await dispatchUserMessage(dispatchDeps(), owner.ownerId, owner.groupId, offline)).toEqual({
      kind: "unplaced",
      reason: "no_computer_online",
    });

    const second = CreateBotResponse.parse(await (await owner.client.post("/api/bots", { name: "小销" })).json());
    const group = CreateGroupResponse.parse(
      await (await owner.client.post("/api/groups", { title: "两人群", botIds: [owner.botId, second.bot.id] })).json(),
    );
    const unaddressed = await appendMessage(database.db, group.group.id, { kind: "user", text: "谁来处理" });
    expect(await dispatchUserMessage(dispatchDeps(), owner.ownerId, group.group.id, unaddressed)).toEqual({
      kind: "unplaced",
      reason: "no_computer_online",
    });
  });

  it("选中电脑之后连接断开，run 和 prompt 仍入箱等重连", async () => {
    const owner = await ownerWithBot();
    const agent = await online(owner);
    const original = AgentHub.prototype.isOnline;
    let selected = false;
    const selecting = vi.spyOn(AgentHub.prototype, "isOnline").mockImplementation(function (this: AgentHub, id) {
      const available = original.call(this, id);
      if (id === owner.computer.computerId && available && !selected) {
        selected = true;
        agent.socket.terminate();
      }
      return available;
    });
    let back: AgentClient | undefined;
    try {
      expect((await owner.client.post(`/api/groups/${owner.groupId}/messages`, { text: "排一下本周" })).status).toBe(
        201,
      );
      selecting.mockRestore();
      await agent.closed();
      const runs = await database.sql<{ id: string; computer_id: string; ended_at: string | null }[]>`
        SELECT id, computer_id, ended_at FROM runs WHERE group_id = ${owner.groupId}
      `;
      expect(runs, "HTTP 派活结束后 run 已入箱，断线收尾能找到它").toEqual([
        { id: expect.any(String), computer_id: owner.computer.computerId, ended_at: null },
      ]);
      const run = runs[0];
      if (run === undefined) throw new Error("断线后 run 不存在");
      const queued = await database.db
        .select({ body: agentOutbox.body })
        .from(agentOutbox)
        .where(eq(agentOutbox.runId, RunId.parse(run.id)));
      expect(queued.map(({ body }) => body.type)).toEqual(["prompt"]);
      back = await online(owner);
      expect(await back.expect("prompt")).toMatchObject({ runId: run.id, text: "排一下本周" });
    } finally {
      selecting.mockRestore();
      agent.close();
      back?.close();
    }
  });

  it("电脑在线时收到 prompt，runs 多一行", async () => {
    const owner = await ownerWithBot();
    const agent = await online(owner);

    try {
      const sent = SendMessageResponse.parse(
        await (await owner.client.post(`/api/groups/${owner.groupId}/messages`, { text: "看看有哪些文件" })).json(),
      );

      const prompt = await agent.expect("prompt");
      expect(prompt.text).toBe("看看有哪些文件");
      expect(prompt.botId).toBe(owner.botId);
      expect(prompt.groupId).toBe(owner.groupId);
      expect(prompt.context, "群里在这条之前没有别的消息").toEqual([]);
      expect(prompt.messageId, "prompt 指回触发它的那条用户消息").toBe(sent.message.id);

      const rows = await database.sql<
        { id: string; computer_id: string | null; trigger_message_id: string; ended_at: Date | null }[]
      >`
        SELECT id, computer_id, trigger_message_id, ended_at FROM runs WHERE group_id = ${owner.groupId}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(prompt.runId);
      expect(rows[0]?.computer_id, "run 要记住真正派到的电脑").toBe(owner.computer.computerId);
      expect(rows[0]?.trigger_message_id, "run 要指回触发它的那条消息").toBe(sent.message.id);
      expect(rows[0]?.ended_at, "刚派出去的活还没结束").toBeNull();
    } finally {
      agent.close();
    }
  });

  it("多 Bot 群里 @ 谁谁就成为当前经手，并立刻推一条 task_updated", async () => {
    const owner = await ownerWithBot();
    const second = CreateBotResponse.parse(await (await owner.client.post("/api/bots", { name: "小销" })).json());
    const group = CreateGroupResponse.parse(
      await (await owner.client.post("/api/groups", { title: "两人群", botIds: [owner.botId, second.bot.id] })).json(),
    );
    expect(group.task.currentBotId, "刚建的群还没人经手").toBeNull();
    const agent = await online(owner);
    const push = await connectPush(server.server.port, owner.client.cookie ?? "");

    try {
      expect(
        (await owner.client.post(`/api/groups/${group.group.id}/messages`, { text: "@小服 先查库存" })).status,
      ).toBe(201);
      const updated = await nextOfType(push, "task_updated");
      expect(updated.type === "task_updated" ? updated.task.currentBotId : null).toBe(owner.botId);

      // 再 @ 同一个人经手没变，不该再推任务卡；能等到的下一条是这条消息本身。
      await agent.expect("prompt");
      expect(
        (await owner.client.post(`/api/groups/${group.group.id}/messages`, { text: "@小服 再看看排产" })).status,
      ).toBe(201);
      await agent.expect("prompt");
      const pushes = await drain(push);
      expect(
        pushes.filter((item) => item.type === "task_updated"),
        "经手没变不重推",
      ).toEqual([]);
    } finally {
      push.close();
      agent.close();
    }
  });

  it("context 是这条之前最近 20 条", async () => {
    const owner = await ownerWithBot();
    for (let i = 1; i <= 24; i += 1) {
      await appendMessage(database.db, owner.groupId, { kind: "user", text: `第 ${i} 条` });
    }
    const agent = await online(owner);

    try {
      await owner.client.post(`/api/groups/${owner.groupId}/messages`, { text: "轮到你了" });
      const prompt = await agent.expect("prompt");

      expect(prompt.context).toHaveLength(CONTEXT_MESSAGES);
      expect(prompt.context[0], "第 1 到第 4 条应当被挤出去").toMatchObject({ from: "你", text: "第 5 条" });
      expect(prompt.context.at(-1)).toMatchObject({ from: "你", text: "第 24 条" });
      expect(
        prompt.context.map((line) => line.text),
        "触发消息本身不进上下文",
      ).not.toContain("轮到你了");
    } finally {
      agent.close();
    }
  });

  it("context 里 Bot 的话署 Bot 名，系统消息署系统", async () => {
    const owner = await ownerWithBot();
    await appendMessage(database.db, owner.groupId, { kind: "user", text: "你好" });
    await appendMessage(database.db, owner.groupId, {
      kind: "bot",
      botId: owner.botId,
      text: "在的",
      streaming: false,
    });
    await appendMessage(database.db, owner.groupId, { kind: "system", text: "电脑睡了" });
    await appendMessage(database.db, owner.groupId, {
      kind: "tool_call",
      runId: RunId.parse(randomUUID()),
      botId: owner.botId,
      tool: "erp.query",
      view: { kind: "mcp", server: "ERP", tool: "query", params: [{ key: "查询", value: "库存" }] },
      status: "ok",
      durationMs: 12,
    });
    await appendMessage(database.db, owner.groupId, {
      kind: "cost",
      runId: RunId.parse(randomUUID()),
      botId: owner.botId,
      steps: 7,
      amount: 2.5,
    });
    const agent = await online(owner);

    try {
      await owner.client.post(`/api/groups/${owner.groupId}/messages`, { text: "继续" });
      const prompt = await agent.expect("prompt");

      expect(prompt.context).toMatchObject([
        { from: "你", text: "你好" },
        { from: "小服", text: "在的" },
        { from: "系统", text: "电脑睡了" },
        { from: "小服", text: "要用ERP的 query，参数：查询=库存，跑完了" },
      ]);
    } finally {
      agent.close();
    }
  });
});

describe("电脑不在线", () => {
  it("群里留一句话，不建 run", async () => {
    const owner = await ownerWithBot();

    const response = await owner.client.post(`/api/groups/${owner.groupId}/messages`, { text: "先存着" });
    expect(response.status).toBe(201);

    const page = MessageListResponse.parse(
      await (await owner.client.get(`/api/groups/${owner.groupId}/messages`)).json(),
    );
    expect(page.messages.map((m) => m.body)).toEqual([
      { kind: "user", text: "先存着" },
      { kind: "system", text: "电脑不在线，这条没派出去，电脑回来后再说一次", tone: "error" },
    ]);
    expect(await runCount(owner.groupId), "没派出去的活不该在用量表里留行").toBe(0);
  });

  it("电脑断开后宽限期内派活入箱，重连前不留失败提示", async () => {
    const owner = await ownerWithBot();
    const agent = await online(owner);
    await owner.client.post(`/api/groups/${owner.groupId}/messages`, { text: "第一件事" });
    await agent.expect("prompt");
    agent.close();
    // 等控制面那边真的把这台标成休眠，否则「不在线」这一步会赶在关连接之前。
    await waitFor(async () => (await statusOf(owner)) === "sleeping", "电脑变休眠");

    await owner.client.post(`/api/groups/${owner.groupId}/messages`, { text: "第二件事" });

    const page = MessageListResponse.parse(
      await (await owner.client.get(`/api/groups/${owner.groupId}/messages`)).json(),
    );
    expect(page.messages.map((m) => m.body)).toEqual([
      { kind: "user", text: "第一件事" },
      { kind: "user", text: "第二件事" },
    ]);
    expect(await runCount(owner.groupId), "宽限期内的派活仍有 run").toBe(2);
  });
});

describe("归属", () => {
  it("不把别人群里的消息派到我的电脑", async () => {
    const mine = await ownerWithBot();
    const other = await ownerWithBot();
    const agent = await online(mine);

    try {
      await other.client.post(`/api/groups/${other.groupId}/messages`, { text: "他的活" });
      await mine.client.post(`/api/groups/${mine.groupId}/messages`, { text: "我的活" });

      // 后发的「我的活」先到，说明别人那条根本没进这条连接，不靠超时。
      const prompt = await agent.expect("prompt");
      expect(prompt.text).toBe("我的活");
    } finally {
      agent.close();
    }
  });
});
