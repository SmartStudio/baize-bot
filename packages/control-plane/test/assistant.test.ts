import {
  ApprovalId,
  BotListResponse,
  CreateBotResponse,
  DecideApprovalResponse,
  CreateGroupResponse,
  GroupResponse,
  MessageListResponse,
  TodayResponse,
  type BotId,
  type ControlToAgent,
  type GroupId,
  type RunId,
  type ServerPush,
  type User,
} from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { settings, userCounters, users } from "../src/db/schema.js";
import { newId } from "../src/ids.js";
import { hashPassword } from "../src/password.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { ApiClient, startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, type TestComputer } from "./helpers/fixtures.js";
import { connectPush, type PushClient } from "./helpers/ws.js";

const GREETING = "想让我帮你做成什么事？说一句就行";

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

let emails = 0;
function freshEmail(): string {
  emails += 1;
  return `assistant${emails}-${Date.now()}@baize.dev`;
}

async function register(client: ApiClient, email: string): Promise<Response> {
  return client.post("/api/register", { email, password: PASSWORD, name: "陈默" });
}

async function botList(client: ApiClient) {
  const response = await client.get("/api/bots");
  expect(response.status).toBe(200);
  return BotListResponse.parse(await response.json()).items;
}

async function assistantsOf(client: ApiClient) {
  return (await botList(client)).filter((item) => item.bot.role === "assistant");
}

async function onlyAssistant(client: ApiClient): Promise<{ botId: BotId; groupId: GroupId }> {
  const found = await assistantsOf(client);
  expect(found, "每个用户恰好一个主助理").toHaveLength(1);
  const [entry] = found;
  if (entry === undefined) throw new Error("没有主助理");
  return { botId: entry.bot.id, groupId: entry.groupId };
}

async function messagesOf(client: ApiClient, groupId: string) {
  const response = await client.get(`/api/groups/${groupId}/messages`);
  expect(response.status).toBe(200);
  return MessageListResponse.parse(await response.json()).messages;
}

async function taskOf(client: ApiClient, groupId: string) {
  const response = await client.get(`/api/groups/${groupId}`);
  expect(response.status).toBe(200);
  return GroupResponse.parse(await response.json()).task;
}

/** 迁移前就在的账号：只有用户、发号器、设置三行，没有主助理。 */
async function makeLegacyUser(): Promise<User> {
  const id = newId();
  const email = freshEmail();
  await database.db.insert(users).values({ id, name: "老用户", email, passwordHash: await hashPassword(PASSWORD) });
  await database.db.insert(userCounters).values({ userId: id });
  await database.db.insert(settings).values({ userId: id });
  return { id, name: "老用户", email } as User;
}

type Owner = {
  readonly user: User;
  readonly client: ApiClient;
  readonly computer: TestComputer;
  readonly assistant: { botId: BotId; groupId: GroupId };
};

async function owner(): Promise<Owner> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  return { user, client, computer, assistant: await onlyAssistant(client) };
}

async function createBot(client: ApiClient, name: string) {
  return CreateBotResponse.parse(await (await client.post("/api/bots", { name })).json());
}

/** 两个队员拉一个多 Bot 群当项目，节奏写好。 */
async function projectOf(client: ApiClient, title: string, cadence: string) {
  const first = await createBot(client, "小内");
  const second = await createBot(client, "小社");
  const created = CreateGroupResponse.parse(
    await (await client.post("/api/groups", { title, botIds: [first.bot.id, second.bot.id] })).json(),
  );
  expect((await client.patch(`/api/tasks/${created.task.id}`, { cadence })).status).toBe(200);
  return { groupId: created.group.id, taskId: created.task.id, memberGroupId: first.group.id, memberId: first.bot.id };
}

async function sendAndPrompt(
  client: ApiClient,
  agent: AgentClient,
  groupId: string,
  text: string,
): Promise<Extract<ControlToAgent, { type: "prompt" }>> {
  expect((await client.post(`/api/groups/${groupId}/messages`, { text })).status).toBe(201);
  return agent.expect("prompt");
}

async function nextOfType<T extends ServerPush["type"]>(push: PushClient, type: T) {
  for (let seen = 0; seen < 20; seen += 1) {
    const item = await push.next();
    if (item.type === type) return item as Extract<ServerPush, { type: T }>;
  }
  throw new Error(`等了 20 条推送都没有 ${type}`);
}

/** run_done 之后控制面一定落一张花费卡，等到它就说明前面那条上行已经处理完了。 */
async function finishRun(agent: AgentClient, push: PushClient, prompt: Extract<ControlToAgent, { type: "prompt" }>) {
  agent.send({
    type: "run_done",
    runId: prompt.runId,
    botId: prompt.botId,
    groupId: prompt.groupId,
    steps: 1,
    inputTokens: 0,
    outputTokens: 0,
  });
  for (;;) {
    const item = await nextOfType(push, "message");
    if (item.message.body.kind === "cost" && item.message.body.runId === prompt.runId) return;
  }
}

describe("主助理", () => {
  it("注册后恰好一个主助理和它的单聊，单聊里第一条是它说的第一句", async () => {
    const client = server.client();
    expect((await register(client, freshEmail())).status).toBe(201);

    const assistant = await onlyAssistant(client);
    const messages = await messagesOf(client, assistant.groupId);
    expect(messages.map((message) => message.body)).toEqual([
      { kind: "bot", botId: assistant.botId, text: GREETING, streaming: false },
    ]);
    const task = await taskOf(client, assistant.groupId);
    expect(task.number, "单聊也有主题任务卡").toMatch(/^T-\d{4}$/);
  });

  it("并发注册同一邮箱不会多出主助理", async () => {
    const email = freshEmail();
    const [a, b] = [server.client(), server.client()];
    const statuses = (await Promise.all([register(a, email), register(b, email)])).map((r) => r.status);
    expect(statuses.toSorted((x, y) => x - y)).toEqual([201, 409]);

    const client = server.client();
    expect((await client.login(email, PASSWORD)).status).toBe(200);
    await onlyAssistant(client);
    const rows = await database.sql<{ n: string }[]>`
      SELECT count(*) AS n FROM bots JOIN users ON users.id = bots.owner_id
      WHERE users.email = ${email} AND bots.role = 'assistant'
    `;
    expect(rows[0]?.n).toBe("1");
  });

  it("老用户登录后补建主助理，再登录不多建", async () => {
    const legacy = await makeLegacyUser();
    const [a, b] = [server.client(), server.client()];
    const statuses = await Promise.all([a.login(legacy.email, PASSWORD), b.login(legacy.email, PASSWORD)]);
    expect(
      statuses.map((r) => r.status),
      "两个并发登录都补建，撞在部分唯一索引上的那个不报错",
    ).toEqual([200, 200]);

    const again = server.client();
    expect((await again.login(legacy.email, PASSWORD)).status).toBe(200);
    const assistant = await onlyAssistant(again);
    const messages = await messagesOf(again, assistant.groupId);
    expect(
      messages.map((message) => message.body),
      "第一句只在真建出来的那次写",
    ).toEqual([{ kind: "bot", botId: assistant.botId, text: GREETING, streaming: false }]);
  });

  it("删除主助理被拒绝", async () => {
    const { client, assistant } = await owner();
    const response = await client.delete(`/api/bots/${assistant.botId}`);
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("主助理");
    await onlyAssistant(client);

    const member = await createBot(client, "小服");
    expect((await client.delete(`/api/bots/${member.bot.id}`)).status, "队员照常能删").toBe(204);
  });

  it("today 的 assistantGroupId 是主助理的单聊", async () => {
    const { client, assistant } = await owner();
    const today = TodayResponse.parse(await (await client.get("/api/today")).json());
    expect(today.assistantGroupId).toBe(assistant.groupId);
  });

  it("主助理的 prompt 带 projects，队员的不带", async () => {
    const me = await owner();
    const project = await projectOf(me.client, "推广白泽", "每周小红书 2 篇");
    const { agent } = await helloAgent(server.server.port, me.computer.computerId, me.computer.token);
    const push = await connectPush(server.server.port, me.client.cookie ?? "");
    try {
      const toAssistant = await sendAndPrompt(me.client, agent, me.assistant.groupId, "下周多发点小红书");
      expect(toAssistant.botId).toBe(me.assistant.botId);
      expect(toAssistant.projects).toEqual([
        { groupId: project.groupId, title: "推广白泽", cadence: "每周小红书 2 篇" },
      ]);
      await finishRun(agent, push, toAssistant);

      const toMember = await sendAndPrompt(me.client, agent, project.memberGroupId, "看看今天的评论");
      expect(toMember.botId).toBe(project.memberId);
      expect(toMember.projects, "队员的 prompt 不带项目清单").toBeUndefined();
      await finishRun(agent, push, toMember);
    } finally {
      agent.close();
      push.close();
    }
  });

  it("没有项目时主助理的 prompt 带空清单", async () => {
    const me = await owner();
    const { agent } = await helloAgent(server.server.port, me.computer.computerId, me.computer.token);
    try {
      const prompt = await sendAndPrompt(me.client, agent, me.assistant.groupId, "你好");
      expect(prompt.projects).toEqual([]);
    } finally {
      agent.close();
    }
  });

  it("set_cadence 改了节奏且不产生审批", async () => {
    const me = await owner();
    const project = await projectOf(me.client, "推广白泽", "每周小红书 2 篇");
    const { agent } = await helloAgent(server.server.port, me.computer.computerId, me.computer.token);
    const push = await connectPush(server.server.port, me.client.cookie ?? "");
    try {
      const prompt = await sendAndPrompt(me.client, agent, me.assistant.groupId, "下周多发点小红书");
      agent.send({
        type: "set_cadence",
        runId: prompt.runId,
        botId: prompt.botId,
        groupId: prompt.groupId,
        projectGroupId: project.groupId,
        cadence: "每周小红书 3 篇",
      });
      const updated = await nextOfType(push, "task_updated");
      expect(updated.task).toMatchObject({ id: project.taskId, cadence: "每周小红书 3 篇" });
      await finishRun(agent, push, prompt);

      expect((await taskOf(me.client, project.groupId)).cadence).toBe("每周小红书 3 篇");
      expect(await messagesOf(me.client, project.groupId), "项目群里不落卡").toEqual([]);
      const kinds = (await messagesOf(me.client, me.assistant.groupId)).map((message) => message.body.kind);
      expect(kinds, "主助理单聊里只有第一句、用户那句和花费").toEqual(["bot", "user", "cost"]);
      const today = TodayResponse.parse(await (await me.client.get("/api/today")).json());
      expect(today.pending, "不产生等你确认的事").toEqual([]);
      const pending = await database.sql<{ n: string }[]>`
        SELECT count(*) AS n FROM approvals WHERE group_id IN (${me.assistant.groupId}, ${project.groupId})
      `;
      expect(pending[0]?.n).toBe("0");
    } finally {
      agent.close();
      push.close();
    }
  });

  it("别人的项目群 set_cadence 被丢弃", async () => {
    const me = await owner();
    const other = await owner();
    const theirs = await projectOf(other.client, "别人的项目", "每周 1 篇");
    const { agent } = await helloAgent(server.server.port, me.computer.computerId, me.computer.token);
    const push = await connectPush(server.server.port, me.client.cookie ?? "");
    try {
      const prompt = await sendAndPrompt(me.client, agent, me.assistant.groupId, "把那个项目改成每天发");
      agent.send({
        type: "set_cadence",
        runId: prompt.runId,
        botId: prompt.botId,
        groupId: prompt.groupId,
        projectGroupId: theirs.groupId,
        cadence: "每天 5 篇",
      });
      await finishRun(agent, push, prompt);
      expect((await taskOf(other.client, theirs.groupId)).cadence).toBe("每周 1 篇");
    } finally {
      agent.close();
      push.close();
    }
  });

  it("队员发的 set_cadence 被丢弃", async () => {
    const me = await owner();
    const project = await projectOf(me.client, "推广白泽", "每周小红书 2 篇");
    const { agent } = await helloAgent(server.server.port, me.computer.computerId, me.computer.token);
    const push = await connectPush(server.server.port, me.client.cookie ?? "");
    try {
      const prompt = await sendAndPrompt(me.client, agent, project.memberGroupId, "把节奏改了");
      agent.send({
        type: "set_cadence",
        runId: prompt.runId,
        botId: prompt.botId,
        groupId: prompt.groupId,
        projectGroupId: project.groupId,
        cadence: "每天 5 篇",
      });
      await finishRun(agent, push, prompt);
      expect((await taskOf(me.client, project.groupId)).cadence).toBe("每周小红书 2 篇");
    } finally {
      agent.close();
      push.close();
    }
  });
  it("对单聊群 set_cadence 被丢弃", async () => {
    const me = await owner();
    const member = await createBot(me.client, "小内");
    const { agent } = await helloAgent(server.server.port, me.computer.computerId, me.computer.token);
    const push = await connectPush(server.server.port, me.client.cookie ?? "");
    try {
      const prompt = await sendAndPrompt(me.client, agent, me.assistant.groupId, "小内那边改成每天发");
      for (const soloGroupId of [member.group.id, me.assistant.groupId]) {
        agent.send({
          type: "set_cadence",
          runId: prompt.runId,
          botId: prompt.botId,
          groupId: prompt.groupId,
          projectGroupId: soloGroupId,
          cadence: "每天 5 篇",
        });
      }
      await finishRun(agent, push, prompt);
      expect((await taskOf(me.client, member.group.id)).cadence, "队员的单聊不是项目").toBe("");
      expect((await taskOf(me.client, me.assistant.groupId)).cadence, "主助理的单聊不是项目").toBe("");
    } finally {
      agent.close();
      push.close();
    }
  });

  it("run 归属不成立的 set_cadence 被丢弃", async () => {
    const me = await owner();
    const project = await projectOf(me.client, "推广白泽", "每周小红书 2 篇");
    const { agent } = await helloAgent(server.server.port, me.computer.computerId, me.computer.token);
    const push = await connectPush(server.server.port, me.client.cookie ?? "");
    try {
      const prompt = await sendAndPrompt(me.client, agent, me.assistant.groupId, "下周多发点");
      agent.send({
        type: "set_cadence",
        runId: newId() as RunId,
        botId: prompt.botId,
        groupId: prompt.groupId,
        projectGroupId: project.groupId,
        cadence: "每天 5 篇",
      });
      await finishRun(agent, push, prompt);
      expect((await taskOf(me.client, project.groupId)).cadence, "编出来的 runId 不算主助理在干活").toBe(
        "每周小红书 2 篇",
      );
    } finally {
      agent.close();
      push.close();
    }
  });

  it("老用户登录补建主助理后，在线的电脑收到带主助理的新 config", async () => {
    const me = await owner();
    const { agent } = await helloAgent(server.server.port, me.computer.computerId, me.computer.token);
    try {
      // 删掉主助理行，这个账号就回到了 P1-13 之前的样子，电脑还连着。
      await database.sql`DELETE FROM bots WHERE owner_id = ${me.user.id} AND role = 'assistant'`;
      expect((await server.client().login(me.user.email, PASSWORD)).status).toBe(200);
      const config = await agent.expect("config");
      const assistants = config.bots.filter((bot) => bot.role === "assistant");
      expect(
        assistants.map((bot) => bot.name),
        "补建出来的主助理要进 config 才跑得起来",
      ).toEqual(["主助理"]);
      expect(assistants[0]?.id).toBe((await onlyAssistant(me.client)).botId);
    } finally {
      agent.close();
    }
  });

  it("会话还有效的老用户，电脑重连后 config 里有主助理", async () => {
    const me = await owner();
    // 删掉主助理行造出老用户。cookie 还有效，他不会再走一次登录。
    await database.sql`DELETE FROM bots WHERE owner_id = ${me.user.id} AND role = 'assistant'`;
    expect(await assistantsOf(me.client)).toEqual([]);

    const { agent, config } = await helloAgent(server.server.port, me.computer.computerId, me.computer.token);
    try {
      expect(
        config.bots.filter((bot) => bot.role === "assistant").map((bot) => bot.name),
        "hello 时补建，config 里就有主助理",
      ).toEqual(["主助理"]);
      const assistant = await onlyAssistant(me.client);
      const today = TodayResponse.parse(await (await me.client.get("/api/today")).json());
      expect(today.assistantGroupId, "首页输入框不再禁用").toBe(assistant.groupId);
      expect(
        (await messagesOf(me.client, assistant.groupId)).map((message) => message.body),
        "补建的主助理照样说第一句",
      ).toEqual([{ kind: "bot", botId: assistant.botId, text: GREETING, streaming: false }]);
    } finally {
      agent.close();
    }

    const again = await helloAgent(server.server.port, me.computer.computerId, me.computer.token);
    again.agent.close();
    expect(
      again.config.bots.filter((bot) => bot.role === "assistant"),
      "再连一次不多建",
    ).toHaveLength(1);
  });

  it("删主助理被拒时，它挂着的审批不作废", async () => {
    const me = await owner();
    const { agent } = await helloAgent(server.server.port, me.computer.computerId, me.computer.token);
    const push = await connectPush(server.server.port, me.client.cookie ?? "");
    try {
      const prompt = await sendAndPrompt(me.client, agent, me.assistant.groupId, "给这单退款");
      agent.send({
        type: "approval_request",
        runId: prompt.runId,
        botId: prompt.botId,
        groupId: prompt.groupId,
        callId: "call-1",
        tool: "shop.refund",
        action: "spend",
        target: null,
        view: { kind: "mcp", server: "", tool: "shop.refund", params: [], raw: "给这单退 120 块" },
      });
      const raised = await nextOfType(push, "approval_updated");
      expect(raised.approval.status).toBe("pending");

      expect((await me.client.delete(`/api/bots/${me.assistant.botId}`)).status).toBe(409);
      const decided = await me.client.post(`/api/approvals/${ApprovalId.parse(raised.approval.id)}`, {
        decision: "approved",
      });
      expect(decided.status, "删不掉的主助理，它的审批还等着点头").toBe(200);
      expect(DecideApprovalResponse.parse(await decided.json()).approval.status).toBe("approved");
    } finally {
      agent.close();
      push.close();
    }
  });
});
