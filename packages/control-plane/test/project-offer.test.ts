import {
  BotListResponse,
  CreateBotResponse,
  DecideProjectOfferResponse,
  GroupListResponse,
  GroupResponse,
  MessageListResponse,
  RoutineListResponse,
  RoutineResponse,
  type AgentToControl,
  type BotId,
  type ControlToAgent,
  type GroupId,
  type Message,
  type MessageBody,
  type RunId,
  type ServerPush,
} from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId } from "../src/ids.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { ApiClient, startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, type TestComputer } from "./helpers/fixtures.js";
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

type Prompt = Extract<ControlToAgent, { type: "prompt" }>;
type ProjectOfferEvent = Extract<AgentToControl, { type: "project_offer" }>;
type ProjectOfferBody = Extract<MessageBody, { kind: "project_offer" }>;

const OFFER = {
  name: "推广白泽",
  goal: "白泽的开源仓库年底 1000 星",
  team: [
    { name: "小内", tag: "内容", description: "写小红书笔记和 X 帖子，不回评论" },
    { name: "小社", tag: "社区", description: "回 GitHub issue 和评论，不写长文" },
  ],
  platforms: [
    { kind: "supported", platform: "github" },
    { kind: "unsupported", name: "抖音" },
  ],
  cadence: "每周小红书 2 篇、X 5 条",
  firstStep: "先把 README 改成一句话讲清楚白泽是什么",
} satisfies Omit<ProjectOfferEvent, "type" | "runId" | "botId" | "groupId">;

type Owner = {
  readonly client: ApiClient;
  readonly computer: TestComputer;
  readonly assistant: { readonly botId: BotId; readonly groupId: GroupId };
};

async function owner(): Promise<Owner> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const assistants = (await bots(client)).filter((item) => item.bot.role === "assistant");
  const [entry] = assistants;
  if (entry === undefined || assistants.length !== 1) throw new Error("每个用户恰好一个主助理");
  return { client, computer, assistant: { botId: entry.bot.id, groupId: entry.groupId } };
}

async function bots(client: ApiClient) {
  return BotListResponse.parse(await (await client.get("/api/bots")).json()).items;
}

async function projects(client: ApiClient) {
  return GroupListResponse.parse(await (await client.get("/api/groups")).json()).items;
}

async function routinesOf(client: ApiClient, botId: BotId) {
  return RoutineListResponse.parse(await (await client.get(`/api/bots/${botId}/routines`)).json()).items;
}

async function messagesOf(client: ApiClient, groupId: string) {
  return MessageListResponse.parse(await (await client.get(`/api/groups/${groupId}/messages`)).json()).messages;
}

/** 群、Bot、例行三样的数目。例行只有主助理会有，队员是这次才建的。 */
async function counts(me: Owner) {
  return {
    projects: (await projects(me.client)).length,
    bots: (await bots(me.client)).length,
    routines: (await routinesOf(me.client, me.assistant.botId)).length,
  };
}

async function nextOfType<T extends ServerPush["type"]>(push: PushClient, type: T) {
  for (let seen = 0; seen < 20; seen += 1) {
    const item = await push.next();
    if (item.type === type) return item as Extract<ServerPush, { type: T }>;
  }
  throw new Error(`等了 20 条推送都没有 ${type}`);
}

async function sendAndPrompt(client: ApiClient, agent: AgentClient, groupId: string, text: string): Promise<Prompt> {
  expect((await client.post(`/api/groups/${groupId}/messages`, { text })).status).toBe(201);
  return agent.expect("prompt");
}

/** run_done 之后控制面一定落一张花费卡，等到它就说明前面那条上行已经处理完了。 */
async function finishRun(agent: AgentClient, push: PushClient, prompt: Prompt): Promise<void> {
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

function sendOffer(agent: AgentClient, prompt: Prompt): void {
  agent.send({ type: "project_offer", runId: prompt.runId, botId: prompt.botId, groupId: prompt.groupId, ...OFFER });
}

type Session = { readonly me: Owner; readonly agent: AgentClient; readonly push: PushClient; close(): void };

async function session(): Promise<Session> {
  const me = await owner();
  const { agent } = await helloAgent(server.server.port, me.computer.computerId, me.computer.token);
  const push = await connectPush(server.server.port, me.client.cookie ?? "");
  return {
    me,
    agent,
    push,
    close: () => {
      agent.close();
      push.close();
    },
  };
}

/** 跟主助理说一句，它出一张方案卡，这次活收尾。回的是推过来的那条卡。 */
async function offerCard(s: Session): Promise<Message> {
  const prompt = await sendAndPrompt(s.me.client, s.agent, s.me.assistant.groupId, "推广白泽的开源仓库，年底 1000 星");
  expect(prompt.botId, "首页那句话归主助理").toBe(s.me.assistant.botId);
  sendOffer(s.agent, prompt);
  let card: Message | null = null;
  while (card === null) {
    const item = await nextOfType(s.push, "message");
    if (item.message.body.kind === "project_offer") card = item.message;
  }
  await finishRun(s.agent, s.push, prompt);
  return card;
}

function offerBody(message: Message): ProjectOfferBody {
  if (message.body.kind !== "project_offer") throw new Error(`本应是方案卡，实际是 ${message.body.kind}`);
  return message.body;
}

async function decide(client: ApiClient, messageId: string, body: unknown) {
  const response = await client.post(`/api/messages/${messageId}/project-offer`, body);
  expect(response.status).toBe(200);
  return DecideProjectOfferResponse.parse(await response.json());
}

describe("方案卡", () => {
  it("方案卡没点开始时不建任何东西", async () => {
    const s = await session();
    try {
      const before = await counts(s.me);
      const card = await offerCard(s);
      expect(card.groupId, "卡落在主助理的单聊里").toBe(s.me.assistant.groupId);
      expect(card.body).toEqual({
        kind: "project_offer",
        botId: s.me.assistant.botId,
        ...OFFER,
        status: "offered",
        groupId: null,
      });
      expect(await counts(s.me), "群数、Bot 数、例行数都不变").toEqual(before);
    } finally {
      s.close();
    }
  });

  it("队员发的 project_offer 被丢弃", async () => {
    const s = await session();
    try {
      const member = CreateBotResponse.parse(await (await s.me.client.post("/api/bots", { name: "小服" })).json());
      await s.agent.expect("config");
      const prompt = await sendAndPrompt(s.me.client, s.agent, member.group.id, "建个项目推广白泽");
      expect(prompt.botId).toBe(member.bot.id);
      sendOffer(s.agent, prompt);
      await finishRun(s.agent, s.push, prompt);

      for (const groupId of [member.group.id, s.me.assistant.groupId]) {
        const kinds = (await messagesOf(s.me.client, groupId)).map((message) => message.body.kind);
        expect(kinds, "哪个群里都不落方案卡").not.toContain("project_offer");
      }
    } finally {
      s.close();
    }
  });

  it("run 归属不成立的 project_offer 被丢弃", async () => {
    const s = await session();
    try {
      const prompt = await sendAndPrompt(s.me.client, s.agent, s.me.assistant.groupId, "推广白泽的开源仓库");
      sendOffer(s.agent, { ...prompt, runId: newId() as RunId });
      await finishRun(s.agent, s.push, prompt);
      const kinds = (await messagesOf(s.me.client, s.me.assistant.groupId)).map((message) => message.body.kind);
      expect(kinds, "编出来的 runId 不算主助理在干活，单聊里不落方案卡").not.toContain("project_offer");
    } finally {
      s.close();
    }
  });

  it("开始后群、卡、队员、两条例行都在，卡上的节奏是提议里的", async () => {
    const s = await session();
    try {
      const before = await counts(s.me);
      const card = await offerCard(s);
      const started = await decide(s.me.client, card.id, { decision: "start" });
      if (started.group === null) throw new Error("开始了却没回项目群");
      const projectGroupId = started.group.id;
      expect(started.message.id).toBe(card.id);
      expect(offerBody(started.message)).toMatchObject({ status: "started", groupId: projectGroupId });

      const repushed = await nextOfType(s.push, "message");
      expect(repushed.message, "卡的状态住在正文里，点完要重推那条卡").toEqual(started.message);
      const created = await nextOfType(s.push, "group_created");
      expect(created.group).toEqual(started.group);

      const config = await s.agent.expect("config");
      const members = config.bots.filter((bot) => OFFER.team.some((member) => member.name === bot.name));
      expect(
        members.map((bot) => ({ name: bot.name, role: bot.role, tag: bot.tag, description: bot.description })),
        "新队员随 config 下发，tag 和 description 取提议里的",
      ).toEqual(expect.arrayContaining(OFFER.team.map((member) => ({ ...member, role: "member" }))));
      expect(members).toHaveLength(OFFER.team.length);

      const detail = GroupResponse.parse(await (await s.me.client.get(`/api/groups/${projectGroupId}`)).json());
      expect(detail.task).toMatchObject({ title: OFFER.name, summary: OFFER.goal, cadence: OFFER.cadence });
      expect(detail.task.checklist, "第一步进任务卡的清单").toEqual([
        { text: OFFER.firstStep, done: false, ownerBotId: null },
      ]);
      expect(detail.bots.map((bot) => bot.name)).toEqual(["主助理", ...OFFER.team.map((member) => member.name)]);

      // 两条在同一个事务里建，created_at 相同，列表里谁先谁后不定，按名字的码点排再比。
      const routines = (await routinesOf(s.me.client, s.me.assistant.botId)).toSorted((x, y) =>
        x.name < y.name ? -1 : 1,
      );
      expect(
        routines.map((routine) => ({
          name: routine.name,
          groupId: routine.groupId,
          purpose: routine.purpose,
          triggers: routine.triggers,
          enabled: routine.enabled,
        })),
      ).toEqual([
        {
          name: "周一 09:00 排本周计划",
          groupId: projectGroupId,
          purpose: "plan",
          triggers: [{ kind: "cron", expr: "0 9 * * 1" }],
          enabled: true,
        },
        {
          name: "周五复盘",
          groupId: projectGroupId,
          purpose: "plan",
          triggers: [{ kind: "cron", expr: "0 17 * * 5" }],
          enabled: true,
        },
      ]);
      expect(
        routines.find((routine) => routine.name.startsWith("周一"))?.instruction,
        "周一那条让主助理排本周计划",
      ).toContain("propose_plan");

      expect(await counts(s.me), "抖音这类 unsupported 的平台什么都不建").toEqual({
        projects: before.projects + 1,
        bots: before.bots + OFFER.team.length,
        routines: before.routines + 2,
      });
    } finally {
      s.close();
    }
  });

  it("开始后每个新队员都先推一条 bot_updated，再推新群", async () => {
    const s = await session();
    try {
      const card = await offerCard(s);
      const { group } = await decide(s.me.client, card.id, { decision: "start" });
      if (group === null) throw new Error("开始了却没回项目群");

      const updated: { name: string; tag: string; description: string; role: string }[] = [];
      for (;;) {
        const item = await s.push.next();
        if (item.type === "group_created") break;
        if (item.type === "bot_updated") {
          const { name, tag, description, role } = item.bot;
          updated.push({ name, tag, description, role });
        }
      }
      expect(updated, "Web 拿到新群时已经认识每个队员，不会显示成「Bot」").toEqual(
        OFFER.team.map((member) => ({ ...member, role: "member" })),
      );
    } finally {
      s.close();
    }
  });

  it("项目群的首席是主助理，没点名的话先到它，例行也跑在项目群里", async () => {
    const s = await session();
    try {
      const card = await offerCard(s);
      const { group } = await decide(s.me.client, card.id, { decision: "start" });
      if (group === null) throw new Error("开始了却没回项目群");
      expect(group.chiefBotId).toBe(s.me.assistant.botId);
      await s.agent.expect("config");

      const prompt = await sendAndPrompt(s.me.client, s.agent, group.id, "这周先做什么");
      expect(prompt.groupId).toBe(group.id);
      expect(prompt.botId, "没点名先到首席").toBe(s.me.assistant.botId);
      await finishRun(s.agent, s.push, prompt);

      const monday = (await routinesOf(s.me.client, s.me.assistant.botId)).find((routine) =>
        routine.name.startsWith("周一"),
      );
      if (monday === undefined) throw new Error("没有周一那条例行");
      const ran = await s.me.client.post(`/api/routines/${monday.id}/run`, {});
      expect(ran.status).toBe(202);
      RoutineResponse.parse(await ran.json());
      const routinePrompt = await s.agent.expect("prompt");
      expect(routinePrompt.groupId, "项目的例行跑在项目群里，不是主助理的单聊").toBe(group.id);
      expect(routinePrompt.botId).toBe(s.me.assistant.botId);
      expect(routinePrompt.purpose).toBe("plan");
    } finally {
      s.close();
    }
  });

  it("开始时带新名字，群名是新名字", async () => {
    const s = await session();
    try {
      const card = await offerCard(s);
      const { group } = await decide(s.me.client, card.id, { decision: "start", name: "白泽千星" });
      if (group === null) throw new Error("开始了却没回项目群");
      const detail = GroupResponse.parse(await (await s.me.client.get(`/api/groups/${group.id}`)).json());
      expect(detail.task.title).toBe("白泽千星");
    } finally {
      s.close();
    }
  });

  it("点两次开始只建一个项目", async () => {
    const s = await session();
    try {
      const before = await counts(s.me);
      const card = await offerCard(s);
      const [a, b] = await Promise.all([
        decide(s.me.client, card.id, { decision: "start" }),
        decide(s.me.client, card.id, { decision: "start" }),
      ]);
      expect(offerBody(a.message).status).toBe("started");
      expect(offerBody(b.message), "两次都回同一个项目").toEqual(offerBody(a.message));
      expect(a.group?.id).toBe(b.group?.id);
      expect(await counts(s.me)).toEqual({
        projects: before.projects + 1,
        bots: before.bots + OFFER.team.length,
        routines: before.routines + 2,
      });
    } finally {
      s.close();
    }
  });

  it("dismiss 后再 start 不建", async () => {
    const s = await session();
    try {
      const before = await counts(s.me);
      const card = await offerCard(s);
      const dismissed = await decide(s.me.client, card.id, { decision: "dismiss" });
      expect(dismissed.group).toBeNull();
      expect(offerBody(dismissed.message)).toMatchObject({ status: "dismissed", groupId: null });
      const repushed = await nextOfType(s.push, "message");
      expect(repushed.message).toEqual(dismissed.message);

      const again = await decide(s.me.client, card.id, { decision: "start" });
      expect(again.group).toBeNull();
      expect(offerBody(again.message).status, "回当前那条，不改").toBe("dismissed");
      expect(await counts(s.me)).toEqual(before);
    } finally {
      s.close();
    }
  });

  it("别人的方案卡和不是方案卡的消息都是 404", async () => {
    const s = await session();
    const stranger = await owner();
    try {
      const card = await offerCard(s);
      expect((await stranger.client.post(`/api/messages/${card.id}/project-offer`, { decision: "start" })).status).toBe(
        404,
      );
      const [greeting] = await messagesOf(s.me.client, s.me.assistant.groupId);
      if (greeting === undefined) throw new Error("主助理单聊里没有第一句");
      expect((await s.me.client.post(`/api/messages/${greeting.id}/project-offer`, { decision: "start" })).status).toBe(
        404,
      );
      const still = (await messagesOf(s.me.client, s.me.assistant.groupId)).find((message) => message.id === card.id);
      expect(still?.body, "卡原样留着").toEqual(card.body);
    } finally {
      s.close();
    }
  });
});
