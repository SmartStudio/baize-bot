import {
  BotListResponse,
  CreateBotResponse,
  CreateGroupResponse,
  GroupListResponse,
  MessageId,
  MessageListResponse,
  ProjectResponse,
  TodayResponse,
  UsageResponse,
  type MessageBody,
  type Viewer,
} from "@baize/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { messages, runs } from "../src/db/schema.js";
import { newId } from "../src/ids.js";
import { helloAgent } from "./helpers/agent.js";
import { startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser } from "./helpers/fixtures.js";
import { connectPush } from "./helpers/ws.js";

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

async function owner() {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const a = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "A" })).json());
  const b = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "B" })).json());
  const team = CreateGroupResponse.parse(
    await (await client.post("/api/groups", { title: "可见范围", botIds: [a.bot.id, b.bot.id] })).json(),
  );
  const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);
  const insert = async (body: MessageBody, visibleTo: Viewer[] | null, groupId = team.group.id) => {
    const id = MessageId.parse(newId());
    await database.db.insert(messages).values({ id, groupId, body, visibleTo, createdAt: new Date() });
    return id;
  };
  const prompt = async (text: string, groupId = team.group.id) => {
    expect((await client.post(`/api/groups/${groupId}/messages`, { text })).status).toBe(201);
    return agent.expect("prompt");
  };
  return { user, computer, client, a, b, groupId: team.group.id, agent, insert, prompt };
}

describe("P3 消息可见范围", () => {
  it("派给 B 的 prompt 上下文里没有只给 A 看的那条", async () => {
    const o = await owner();
    try {
      const hidden = await o.insert({ kind: "system", text: "A 的底牌 AK" }, [{ kind: "bot", botId: o.a.bot.id }]);
      const publicId = await o.insert({ kind: "system", text: "公开底池 100" }, null);
      const prompt = await o.prompt("@B 出牌");
      expect(prompt.botId).toBe(o.b.bot.id);
      expect(prompt.context.map((line) => line.messageId)).toContain(publicId);
      expect(prompt.context.map((line) => line.messageId)).not.toContain(hidden);
      expect(JSON.stringify(prompt)).not.toContain("A 的底牌 AK");
    } finally {
      o.agent.close();
    }
  });

  it("派给 A 的 prompt 上下文里有只给 A 看的那条", async () => {
    const o = await owner();
    try {
      const hidden = await o.insert({ kind: "system", text: "A 的底牌 AK" }, [{ kind: "bot", botId: o.a.bot.id }]);
      const prompt = await o.prompt("@A 出牌");
      expect(prompt.botId).toBe(o.a.bot.id);
      expect(prompt.context).toContainEqual(expect.objectContaining({ messageId: hidden, text: "A 的底牌 AK" }));
    } finally {
      o.agent.close();
    }
  });

  it("只给 Bot 看的消息不在用户的历史接口里", async () => {
    const o = await owner();
    try {
      const publicId = await o.insert({ kind: "system", text: "公开" }, null);
      const userId = await o.insert({ kind: "system", text: "你的牌" }, [{ kind: "user" }]);
      const hidden = await o.insert({ kind: "system", text: "A 的底牌" }, [{ kind: "bot", botId: o.a.bot.id }]);
      const page = MessageListResponse.parse(
        await (await o.client.get(`/api/groups/${o.groupId}/messages?limit=2`)).json(),
      );
      expect(page.messages.map((message) => message.id)).toEqual([publicId, userId]);
      expect(page.hasMore).toBe(false);
      expect((await o.client.get(`/api/groups/${o.groupId}/messages?before=${hidden}`)).status).toBe(404);
      expect((await o.client.get(`/api/messages/${hidden}`)).status).toBe(404);
    } finally {
      o.agent.close();
    }
  });

  it("只给用户看的消息不在任何 Bot 的 prompt 里", async () => {
    const o = await owner();
    try {
      const hidden = await o.insert({ kind: "system", text: "你的底牌 QQ" }, [{ kind: "user" }]);
      for (const name of ["A", "B"]) {
        const prompt = await o.prompt(`@${name} 出牌`);
        expect(prompt.context.map((line) => line.messageId)).not.toContain(hidden);
        expect(JSON.stringify(prompt)).not.toContain("你的底牌 QQ");
      }
    } finally {
      o.agent.close();
    }
  });

  it("只给 Bot 看的消息不推给用户的 WebSocket", async () => {
    const o = await owner();
    try {
      const prompt = await o.prompt("@A 做事");
      const push = await connectPush(server.server.port, o.client.cookie ?? "");
      try {
        const tool = {
          type: "bot_tool_call" as const,
          runId: prompt.runId,
          botId: o.a.bot.id,
          groupId: o.groupId,
          callId: "hidden-tool",
          tool: "bash",
          view: { kind: "bash" as const, command: "/tmp/private-hand" },
          durationMs: null,
        };
        o.agent.send({ ...tool, status: "running" });
        const first = await push.next();
        if (first.type !== "message") throw new Error("缺少工具消息");
        await database.db
          .update(messages)
          .set({ visibleTo: [{ kind: "bot", botId: o.a.bot.id }] })
          .where(eq(messages.id, first.message.id));
        o.agent.send({ ...tool, status: "ok" });
        o.agent.send({
          ...tool,
          callId: "public-tool",
          view: { kind: "bash", command: "/tmp/public-pot" },
          status: "ok",
        });
        const marker = await push.next();
        expect(marker.type === "message" ? marker.message.body : null).toMatchObject({
          kind: "tool_call",
          view: { command: "/tmp/public-pot" },
        });
      } finally {
        push.close();
      }
    } finally {
      o.agent.close();
    }
  });

  it("message_delta 带 visibleTo 时同样不推", async () => {
    const o = await owner();
    try {
      const prompt = await o.prompt("@A 出牌");
      const hidden = await o.insert({ kind: "bot", botId: o.a.bot.id, text: "", streaming: true }, [
        { kind: "bot", botId: o.a.bot.id },
      ]);
      const userOnly = await o.insert({ kind: "bot", botId: o.a.bot.id, text: "", streaming: true }, [
        { kind: "user" },
      ]);
      const push = await connectPush(server.server.port, o.client.cookie ?? "");
      try {
        const text = {
          type: "bot_text" as const,
          runId: prompt.runId,
          botId: o.a.bot.id,
          groupId: o.groupId,
          done: true,
        };
        o.agent.send({ ...text, messageId: hidden, delta: "A 的秘密底牌" });
        o.agent.send({ ...text, messageId: userOnly, delta: "老白给你的建议" });
        expect(await push.next()).toMatchObject({
          type: "message_delta",
          messageId: userOnly,
          delta: "老白给你的建议",
        });
      } finally {
        push.close();
      }
    } finally {
      o.agent.close();
    }
  });

  it("上下文名单里不记 Bot 看不见的消息 id", async () => {
    const o = await owner();
    try {
      const hiddenSettled = await o.insert({ kind: "system", text: "只给 A" }, [{ kind: "bot", botId: o.a.bot.id }]);
      const hiddenUnsettled = await o.insert({ kind: "bot", botId: o.a.bot.id, text: "秘密", streaming: true }, [
        { kind: "user" },
      ]);
      const visibleUnsettled = await o.insert({ kind: "bot", botId: o.b.bot.id, text: "可见", streaming: true }, [
        { kind: "bot", botId: o.b.bot.id },
      ]);
      const visibleSettled = await o.insert({ kind: "system", text: "公开" }, null);
      const prompt = await o.prompt("@B 出牌");
      const [run] = await database.db.select().from(runs).where(eq(runs.id, prompt.runId));
      expect(run?.unsettledContext).toEqual([visibleUnsettled]);
      expect(run?.settledContext).toContain(visibleSettled);
      expect([...(run?.unsettledContext ?? []), ...(run?.settledContext ?? [])]).not.toContain(hiddenSettled);
      expect([...(run?.unsettledContext ?? []), ...(run?.settledContext ?? [])]).not.toContain(hiddenUnsettled);
    } finally {
      o.agent.close();
    }
  });

  it("群列表的最后一条消息不是看不见的那条", async () => {
    const o = await owner();
    try {
      for (const groupId of [o.groupId, o.a.group.id]) {
        const visible = await o.insert({ kind: "system", text: "用户能看到" }, [{ kind: "user" }], groupId);
        await o.insert({ kind: "system", text: "隐藏的最新一条" }, [{ kind: "bot", botId: o.a.bot.id }], groupId);
        const last =
          groupId === o.groupId
            ? GroupListResponse.parse(await (await o.client.get("/api/groups")).json()).items.find(
                (item) => item.group.id === groupId,
              )?.lastMessage
            : BotListResponse.parse(await (await o.client.get("/api/bots")).json()).items.find(
                (item) => item.groupId === groupId,
              )?.lastMessage;
        expect(last?.id).toBe(visible);
      }
    } finally {
      o.agent.close();
    }
  });

  it("今天页刚做完不取只给 Bot 的行", async () => {
    const o = await owner();
    try {
      const assistant = BotListResponse.parse(await (await o.client.get("/api/bots")).json()).items.find(
        (item) => item.bot.role === "assistant",
      );
      if (assistant === undefined) throw new Error("缺主助理");
      await o.insert(
        { kind: "bot", botId: assistant.bot.id, text: "公开完成结果", streaming: false },
        null,
        assistant.groupId,
      );
      await o.insert(
        { kind: "bot", botId: assistant.bot.id, text: "私密手牌结果", streaming: false },
        [{ kind: "bot", botId: assistant.bot.id }],
        assistant.groupId,
      );
      const today = TodayResponse.parse(await (await o.client.get("/api/today")).json());
      expect(today.assistantLatest?.text).toBe("公开完成结果");
      expect(JSON.stringify(today)).not.toContain("私密手牌结果");
    } finally {
      o.agent.close();
    }
  });

  it("用量页最近记录里隐藏触发消息不露正文", async () => {
    const o = await owner();
    try {
      const triggerMessageId = await o.insert({ kind: "user", text: "秘密底牌和隐藏触发" }, [
        { kind: "bot", botId: o.a.bot.id },
      ]);
      const runId = newId();
      await database.db.insert(runs).values({
        id: runId,
        ownerId: o.user.id,
        botId: o.a.bot.id,
        computerId: o.computer.computerId,
        groupId: o.groupId,
        triggerMessageId,
        startedAt: new Date(),
      });
      const usage = UsageResponse.parse(await (await o.client.get("/api/usage")).json());
      expect(usage.recent.find((run) => run.runId === runId)?.title).toBe("可见范围");
      expect(JSON.stringify(usage)).not.toContain("秘密底牌和隐藏触发");
      const project = ProjectResponse.parse(await (await o.client.get(`/api/projects/${o.groupId}`)).json());
      expect(project.working[0]?.title).toBe("可见范围");
      expect(project.latestTurn).toBeNull();
      expect(JSON.stringify(project)).not.toContain("秘密底牌和隐藏触发");
    } finally {
      o.agent.close();
    }
  });

  it("visible_to 为空数组的行被数据库拒绝", async () => {
    const o = await owner();
    try {
      await expect(o.insert({ kind: "system", text: "不应落库" }, [])).rejects.toMatchObject({ code: "23514" });
    } finally {
      o.agent.close();
    }
  });

  it("补送名单中的隐藏行滑出最近窗口后仍不进入 prompt", async () => {
    const o = await owner();
    try {
      const hidden = await o.insert({ kind: "bot", botId: o.a.bot.id, text: "过期名单里的秘密", streaming: true }, [
        { kind: "bot", botId: o.a.bot.id },
      ]);
      const visible = await o.insert(
        { kind: "bot", botId: o.b.bot.id, text: "补送的公开结论", streaming: false },
        null,
      );
      await database.db.insert(runs).values({
        id: newId(),
        ownerId: o.user.id,
        botId: o.b.bot.id,
        groupId: o.groupId,
        computerId: o.computer.computerId,
        startedAt: new Date(),
        endedAt: new Date(),
        contextConfirmedAt: new Date(),
        unsettledContext: [hidden, visible],
        settledContext: [],
      });
      for (let index = 0; index < 25; index += 1) await o.insert({ kind: "system", text: `公开记录 ${index}` }, null);
      const prompt = await o.prompt("@B 继续");
      expect(prompt.context.map((line) => line.messageId)).toContain(visible);
      expect(prompt.context.map((line) => line.messageId)).not.toContain(hidden);
      const [run] = await database.db.select().from(runs).where(eq(runs.id, prompt.runId));
      expect([...(run?.unsettledContext ?? []), ...(run?.settledContext ?? [])]).not.toContain(hidden);
    } finally {
      o.agent.close();
    }
  });

  it("项目页的起点、回应和旧轮数只取用户可见消息", async () => {
    const o = await owner();
    try {
      await o.insert({ kind: "user", text: "上一轮" }, null);
      await o.insert({ kind: "user", text: "隐藏的中间轮" }, [{ kind: "bot", botId: o.a.bot.id }]);
      const said = await o.insert({ kind: "user", text: "用户当前轮" }, [{ kind: "user" }]);
      const reply = await o.insert({ kind: "system", text: "用户可见回应" }, [
        { kind: "user" },
        { kind: "bot", botId: o.b.bot.id },
      ]);
      await o.insert({ kind: "user", text: "隐藏的最新轮" }, [{ kind: "bot", botId: o.a.bot.id }]);
      await o.insert({ kind: "bot", botId: o.a.bot.id, text: "隐藏的回应", streaming: false }, [
        { kind: "bot", botId: o.a.bot.id },
      ]);
      const project = ProjectResponse.parse(await (await o.client.get(`/api/projects/${o.groupId}`)).json());
      expect(project.latestTurn?.said.id).toBe(said);
      expect(project.latestTurn?.replies.map((message) => message.id)).toEqual([reply]);
      expect(project.olderTurns).toBe(1);
      expect(JSON.stringify(project)).not.toContain("隐藏的");
    } finally {
      o.agent.close();
    }
  });

  it("按 id 点隐藏的 skill 和项目方案卡都当不存在", async () => {
    const o = await owner();
    try {
      const skill = await o.insert(
        {
          kind: "skill_offer",
          botId: o.a.bot.id,
          change: { op: "add", name: "秘密", steps: ["秘密一", "秘密二"], origin: null },
          status: "offered",
          skillId: null,
        },
        [{ kind: "bot", botId: o.a.bot.id }],
      );
      const project = await o.insert(
        {
          kind: "project_offer",
          botId: o.a.bot.id,
          name: "秘密项目",
          goal: "秘密目标",
          team: [{ name: "资料员", tags: [], description: "查资料" }],
          platforms: [],
          cadence: "每周",
          firstStep: "查资料",
          status: "offered",
          groupId: null,
        },
        [{ kind: "bot", botId: o.a.bot.id }],
      );
      expect((await o.client.post(`/api/messages/${skill}/skill-offer`, { decision: "dismiss" })).status).toBe(404);
      expect((await o.client.post(`/api/messages/${project}/project-offer`, { decision: "dismiss" })).status).toBe(404);
    } finally {
      o.agent.close();
    }
  });

  it("隐藏审批不出现在聚合页，按 id 和文字批准都碰不到它", async () => {
    const o = await owner();
    try {
      const prompt = await o.prompt("@A 做事");
      const push = await connectPush(server.server.port, o.client.cookie ?? "");
      try {
        o.agent.send({
          type: "approval_request",
          runId: prompt.runId,
          botId: o.a.bot.id,
          groupId: o.groupId,
          callId: "hidden-approval",
          tool: "bash",
          action: "shell",
          target: null,
          view: { kind: "bash", command: "秘密命令" },
        });
        const approvalPush = await push.next();
        if (approvalPush.type !== "approval_updated") throw new Error("缺审批行");
        const card = await push.next();
        if (card.type !== "message") throw new Error("缺审批卡");
        await database.db
          .update(messages)
          .set({ visibleTo: [{ kind: "bot", botId: o.a.bot.id }] })
          .where(eq(messages.id, card.message.id));
        expect(JSON.stringify(await (await o.client.get("/api/today")).json())).not.toContain("秘密命令");
        expect(JSON.stringify(await (await o.client.get(`/api/projects/${o.groupId}`)).json())).not.toContain(
          "秘密命令",
        );
        expect(
          (await o.client.post(`/api/approvals/${approvalPush.approval.id}`, { decision: "approved", scope: "once" }))
            .status,
        ).toBe(404);
        expect((await o.client.post(`/api/groups/${o.groupId}/messages`, { text: "批准" })).status).toBe(201);
        expect(await o.agent.expect("approval_result")).toMatchObject({
          runId: prompt.runId,
          callId: "hidden-approval",
          outcome: "voided",
        });
        const next = await o.agent.expect("prompt");
        expect(next.runId).not.toBe(prompt.runId);
      } finally {
        push.close();
      }
    } finally {
      o.agent.close();
    }
  });
});
