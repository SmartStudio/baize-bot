import { randomUUID } from "node:crypto";
import {
  ApprovalId,
  BotListResponse,
  ContentPlanId,
  CreateBotResponse,
  CreateGroupResponse,
  MessageId,
  MessageListResponse,
  SkillResponse,
  ControlToAgent,
  type BotId,
  type GroupId,
  type RunId,
  type TeamOfferMember,
  type ToolCallStatus,
  type ToolView,
} from "@baize/shared";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentHub } from "../src/agent/hub.js";
import * as schema from "../src/db/schema.js";
import { databaseUrl } from "../src/env.js";
import { acceptHandoff, createHandoff } from "../src/repo/handoffs.js";
import { appendMessage } from "../src/repo/messages.js";
import * as taskRepo from "../src/repo/tasks.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { ApiClient, startTestServer, type TestServer } from "./helpers/client.js";
import { contentJob, createDraft, issuePost, setTier, specOf, tweet } from "./helpers/content.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, waitFor } from "./helpers/fixtures.js";
import { connectPush, type PushClient } from "./helpers/ws.js";

let database: TestDb;
let server: TestServer;
let serverConnection: postgres.Sql;
/** 控制面经它自己那条连接发出的每条 SQL。用例建数据走 database.db，不算进来。 */
const serverQueries: string[] = [];

beforeAll(async () => {
  database = await createTestDb();
  const url = new URL(databaseUrl());
  url.pathname = `/${database.databaseName}`;
  serverConnection = postgres(url.toString(), { max: 4, debug: (_connection, query) => serverQueries.push(query) });
  server = await startTestServer(drizzle(serverConnection, { schema }));
});

afterAll(async () => {
  await server.close();
  await serverConnection.end();
  await database.close();
});

type Prompt = Extract<ControlToAgent, { type: "prompt" }>;

type Owner = {
  readonly client: ApiClient;
  readonly agent: AgentClient;
  readonly push: PushClient;
  readonly groupId: GroupId;
  readonly botId: BotId;
  close(): void;
};

async function onlineOwner(): Promise<Owner> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小服" })).json());
  const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);
  const push = await connectPush(server.server.port, client.cookie ?? "");
  return {
    client,
    agent,
    push,
    groupId: created.group.id,
    botId: created.bot.id,
    close: () => {
      agent.close();
      push.close();
    },
  };
}

/** 小服和阿文的二人群。 */
async function withTeammate(owner: Owner): Promise<{ groupId: GroupId; wenId: BotId }> {
  const wen = CreateBotResponse.parse(await (await owner.client.post("/api/bots", { name: "阿文" })).json());
  const group = CreateGroupResponse.parse(
    await (await owner.client.post("/api/groups", { title: "大促", botIds: [owner.botId, wen.bot.id] })).json(),
  );
  return { groupId: group.group.id, wenId: wen.bot.id };
}

/** 小服挂着审批时由阿文查看上下文，观察消息不会作废小服的卡。 */
async function approvalObserver(): Promise<Owner> {
  const owner = await onlineOwner();
  const { groupId } = await withTeammate(owner);
  return { ...owner, groupId };
}

async function say(client: ApiClient, groupId: GroupId, text: string): Promise<void> {
  expect((await client.post(`/api/groups/${groupId}/messages`, { text })).status).toBe(201);
}

/** 决定审批、改档都会给电脑发别的报文，这里只要下一条 prompt。 */
async function nextPrompt(agent: AgentClient): Promise<Prompt> {
  for (let seen = 0; seen < 20; seen += 1) {
    const message = await agent.next();
    if (message.type === "prompt") return message;
  }
  throw new Error("等了 20 条报文都没有 prompt");
}

const lines = (prompt: Prompt) => prompt.context.map(({ from, text }) => ({ from, text }));

const settledOnly = (prompt: Prompt) => prompt.context.map(({ settled }) => settled);

const payCard = (prompt: Prompt) => prompt.context.find((line) => line.text.includes("pay 100"));

const bash = (command: string): ToolView => ({ kind: "bash", command });

/** 控制面读了几次这张表。 */
const readsOf = (table: string) =>
  serverQueries.filter((query) => new RegExp(`^select\\b[\\s\\S]*\\bfrom "${table}"`, "i").test(query)).length;

describe("上下文里的卡写结论", () => {
  it("审批卡按审批行现在的状态写结论，四张审批卡只做一次摘要查询", async () => {
    const owner = await onlineOwner();
    try {
      await say(owner.client, owner.groupId, "把四笔款付了");
      const first = await owner.agent.expect("prompt");
      const approvals: ApprovalId[] = [];
      for (const [index, command] of ["pay 100", "pay 200", "pay 300", "pay 400"].entries()) {
        owner.agent.send({
          type: "approval_request",
          runId: first.runId,
          botId: owner.botId,
          groupId: owner.groupId,
          callId: `call-${index}`,
          tool: "bash",
          action: "spend",
          target: null,
          view: bash(command),
        });
        for (;;) {
          const pushed = await owner.push.next();
          if (pushed.type === "approval_updated") {
            approvals.push(pushed.approval.id);
            break;
          }
        }
      }
      const [paid, refused] = approvals;
      expect((await owner.client.post(`/api/approvals/${paid}`, { decision: "approved" })).status).toBe(200);
      expect((await owner.client.post(`/api/approvals/${refused}`, { decision: "rejected" })).status).toBe(200);
      owner.agent.send({ type: "approval_abandoned", runId: first.runId, callId: "call-3", reason: "disconnected" });
      for (;;) {
        const pushed = await owner.push.next();
        if (pushed.type === "approval_updated" && pushed.approval.status === "expired") break;
      }

      serverQueries.length = 0;
      await say(owner.client, owner.groupId, "付完说一声");
      const prompt = await nextPrompt(owner.agent);

      expect(lines(prompt), "审批卡按审批行现在的状态写成结论").toEqual([
        { from: "你", text: "把四笔款付了" },
        { from: "系统", text: "小服要执行 `pay 100`，你批准了" },
        { from: "系统", text: "小服要执行 `pay 200`，你拒绝了" },
        { from: "系统", text: "小服要执行 `pay 300`，你发了新消息，这一步作废了" },
        { from: "系统", text: "小服要执行 `pay 400`，没批下来，过期了" },
      ]);
      expect(settledOnly(prompt), "新消息已作废剩下的待批卡，四张卡都有终态").toEqual([true, true, true, true, true]);
      const summaryReads = serverQueries.filter((query) => /^select\b[\s\S]*from "approvals" where /i.test(query));
      expect(summaryReads, "四张审批卡仍用一条摘要查询查完，不按卡逐条查").toHaveLength(1);
      expect(readsOf("approvals"), "摘要查询和作废投递范围各一条，不随卡数增长").toBe(2);
    } finally {
      owner.close();
    }
  });

  it("交接已被接时写明谁接了，没接的写还在等，两张交接卡只查一次交接表", async () => {
    const owner = await onlineOwner();
    try {
      const { groupId, wenId } = await withTeammate(owner);
      const handoff = (next: string) =>
        createHandoff(database.db, {
          groupId,
          fromBotId: owner.botId,
          toBotId: wenId,
          done: "报价单拟好了",
          notDone: "还没发",
          next,
          checklistIndex: null,
        });
      const accepted = await handoff("把报价单发给客户");
      await handoff("跟进回款");
      expect(
        await acceptHandoff(database.db, { handoffId: accepted.handoff.id, groupId, toBotId: wenId, at: new Date() }),
      ).not.toBeNull();

      serverQueries.length = 0;
      await say(owner.client, groupId, "@小服 进度怎样");
      const prompt = await nextPrompt(owner.agent);

      expect(lines(prompt), "已接的写谁接了，没接的写还在等谁").toEqual([
        { from: "系统", text: "小服把活交给阿文，下一步是「把报价单发给客户」，阿文接了" },
        { from: "系统", text: "小服把活交给阿文，下一步是「跟进回款」，交接还在等阿文接" },
      ]);
      expect(settledOnly(prompt), "接了的不会再变，没接的标没定稿").toEqual([true, false]);
      expect(readsOf("handoffs"), "两张交接卡一条查询查完，不按卡逐条查").toBe(1);
    } finally {
      owner.close();
    }
  });

  it("草稿卡、方案卡、skill 卡按卡上现在的状态各写一句，四张草稿卡加两张计划卡查询次数不随卡数变", async () => {
    const job = await contentJob(server, database.db, [
      { platform: "x", handle: "baize_x", token: "x-unit" },
      { platform: "github", handle: "baize-dev", token: "gh-unit" },
    ]);
    try {
      const [x, github] = job.accounts;
      if (x === undefined || github === undefined) throw new Error("没挂上账号");
      await setTier(job, github, "draft");
      const approved = await createDraft(job, specOf(x, tweet("周三上新")));
      const returned = await createDraft(job, specOf(x, tweet("周四预告")));
      await createDraft(job, specOf(x, tweet("周五复盘")));
      const kept = await createDraft(job, specOf(github, issuePost("本月做了什么", "月度复盘")));
      for (const draft of [approved, kept]) {
        expect((await job.client.post(`/api/drafts/${draft.id}`, { decision: "approve" })).status).toBe(200);
      }
      expect((await job.client.post(`/api/drafts/${returned.id}`, { decision: "return" })).status).toBe(200);

      const propose = async (title: string, texts: readonly string[]) => {
        const planId = ContentPlanId.parse(randomUUID());
        job.agent.send({
          type: "plan_propose",
          runId: job.runId,
          botId: job.botId,
          groupId: job.groupId,
          planId,
          title,
          drafts: texts.map((text) => specOf(x, tweet(text))),
        });
        await waitFor(
          async () => (await database.sql`SELECT 1 FROM content_plans WHERE id = ${planId}`).length === 1,
          "计划落库",
        );
        return planId;
      };
      const planId = await propose("下周计划", ["周一", "周二"]);
      expect((await job.client.post(`/api/plans/${planId}/approve`, { edits: [] })).status).toBe(200);
      await propose("下下周计划", ["周三"]);

      await appendMessage(database.db, job.groupId, {
        kind: "skill_offer",
        botId: job.botId,
        name: "周报",
        steps: ["拉数据", "写周报"],
        status: "dismissed",
        skillId: null,
      });
      await appendMessage(database.db, job.groupId, {
        kind: "project_offer",
        botId: job.botId,
        name: "小红书起号",
        goal: "三个月一千粉",
        team: [{ name: "小图", tags: [], description: "做图" }],
        platforms: [],
        cadence: "",
        firstStep: "定人设",
        status: "offered",
        groupId: null,
      });

      serverQueries.length = 0;
      await say(job.client, job.groupId, "这周的都理一下");
      const prompt = await nextPrompt(job.agent);

      expect(
        lines(prompt).slice(1),
        "草稿、计划、skill、方案卡各按现在的状态写一句（第一条是 contentJob 的开场）",
      ).toEqual([
        { from: "系统", text: "小内起草的草稿「周三上新」（X），你批准了，等着发" },
        { from: "系统", text: "小内起草的草稿「周四预告」（X），你退回了" },
        { from: "系统", text: "小内起草的草稿「周五复盘」（X），还在等你看" },
        { from: "系统", text: "小内起草的草稿「月度复盘」（GitHub），你批准了，留着没发" },
        { from: "系统", text: "小内排的内容计划「下周计划」共 2 篇，你批准了" },
        { from: "系统", text: "小内排的内容计划「下下周计划」共 1 篇，还在等你看" },
        { from: "系统", text: "问过要不要存成 skill「周报」，你没存" },
        { from: "系统", text: "小内出的方案卡「小红书起号」，还在等你点开始" },
      ]);
      expect(
        settledOnly(prompt).slice(1),
        "草稿没发出去之前都还会变（批了的会发，退回的能改了再交），定了的计划和 skill 卡不再变，没点的方案卡还会变",
      ).toEqual([false, false, false, false, true, false, true, false]);
      expect(
        [readsOf("drafts"), readsOf("content_plans")],
        "草稿表两条（草稿卡一条，计划数篇数一条），计划表一条，都不按卡逐条查",
      ).toEqual([2, 1]);
    } finally {
      job.close();
    }
  });
});

type Assistant = { readonly botId: BotId; readonly groupId: GroupId };
type AssistantRun = { readonly runId: RunId; readonly botId: BotId; readonly groupId: GroupId };

async function assistantOf(client: ApiClient): Promise<Assistant> {
  const listed = BotListResponse.parse(await (await client.get("/api/bots")).json()).items;
  const found = listed.find((item) => item.bot.role === "assistant");
  if (found === undefined) throw new Error("登录后应当有主助理");
  return { botId: found.bot.id, groupId: found.groupId };
}

/**
 * 在主助理单聊里说一句，用那条 run 上报一张卡再收尾，回库里那张卡的消息 id。
 * run_done 的确认回来，同一条连接上排在它前面的卡就已经落库。
 */
async function offerThroughAssistant(
  owner: Owner,
  assistant: Assistant,
  report: (run: AssistantRun) => void,
): Promise<MessageId> {
  await say(owner.client, assistant.groupId, "帮我安排一下");
  const prompt = await nextPrompt(owner.agent);
  const run = { runId: prompt.runId, botId: assistant.botId, groupId: assistant.groupId };
  report(run);
  owner.agent.send({ type: "run_done", ...run, steps: 1, inputTokens: 0, outputTokens: 0 });
  await owner.agent.ack(prompt.runId);
  const page = MessageListResponse.parse(
    await (await owner.client.get(`/api/groups/${assistant.groupId}/messages`)).json(),
  );
  const card = page.messages.findLast(({ body }) => body.kind === "team_offer" || body.kind === "routine_offer");
  if (card === undefined) throw new Error("上报之后单聊里应当有一张卡");
  return card.id;
}

const existingMember = (botId: BotId): TeamOfferMember => ({ kind: "existing", botId, note: "", suggested: false });

const newMember = (name: string): TeamOfferMember => ({
  kind: "new",
  name,
  tags: [],
  description: "",
  note: "",
  suggested: false,
});

/** 单聊里只有卡和用户的话，卡都是「系统」说的。 */
const cardLines = (prompt: Prompt) =>
  prompt.context.filter(({ from }) => from === "系统").map(({ text, settled }) => ({ text, settled }));

describe("上下文里的组队卡和例行提议卡", () => {
  it("组队卡写谁提的、拉哪几位和结论，四种状态各一句，点完状态跟着变，删掉的 Bot 不留名", async () => {
    const owner = await onlineOwner();
    try {
      const assistant = await assistantOf(owner.client);
      const { groupId: projectGroupId } = await withTeammate(owner);
      const [helper, photographer] = await Promise.all(
        ["小图", "小摄"].map(async (name) =>
          CreateBotResponse.parse(await (await owner.client.post("/api/bots", { name })).json()),
        ),
      );
      if (helper === undefined || photographer === undefined) throw new Error("两个既有 Bot 都应当建出来");
      const offer = (members: readonly TeamOfferMember[]) =>
        offerThroughAssistant(owner, assistant, (run) =>
          owner.agent.send({ type: "team_offer", ...run, projectGroupId, members: [...members] }),
        );
      const decide = (messageId: MessageId, body: unknown) =>
        owner.client.post(`/api/messages/${messageId}/team-offer`, body);

      await offer([existingMember(helper.bot.id), existingMember(photographer.bot.id), newMember("小研")]);
      const deferred = await offer([newMember("小设")]);
      const confirmed = await offer([existingMember(helper.bot.id), newMember("小文")]);
      expect((await decide(deferred, { decision: "defer" })).status).toBe(200);
      expect((await decide(confirmed, { decision: "confirm", picked: [1] })).status).toBe(200);
      await appendMessage(database.db, assistant.groupId, {
        kind: "team_offer",
        botId: assistant.botId,
        members: [newMember("小录")],
        status: "dismissed",
        groupId: projectGroupId,
      });

      serverQueries.length = 0;
      await say(owner.client, assistant.groupId, "刚才的组队怎样了");
      const prompt = await nextPrompt(owner.agent);

      expect(cardLines(prompt), "每张卡一句：谁提的、拉哪几位、结论；确认的卡只剩勾进来的人").toEqual([
        { text: "主助理提议拉小图、小摄、小研进项目群，还在等你定", settled: false },
        { text: "主助理提议拉小设进项目群，你说先放着，还没定", settled: false },
        { text: "主助理提议拉小文进项目群，你确认了，人都拉进群了", settled: true },
        { text: "主助理提议拉小录进项目群，你没要", settled: true },
      ]);
      expect(readsOf("bots"), "两张卡上三个既有 Bot（两个不同的）一条查询查名字，不按人逐条查").toBe(1);

      expect((await owner.client.delete(`/api/bots/${helper.bot.id}`)).status).toBe(204);
      await say(owner.client, assistant.groupId, "再看一眼");
      const after = await nextPrompt(owner.agent);
      expect(cardLines(after)[0], "删掉的 Bot 查不到名字，不冒用别人的名字").toEqual({
        text: "主助理提议拉已删除的 Bot、小摄、小研进项目群，还在等你定",
        settled: false,
      });
    } finally {
      owner.close();
    }
  });

  it("例行提议卡写谁提的、例行名、cron 原文和结论，三种状态各一句", async () => {
    const owner = await onlineOwner();
    try {
      const assistant = await assistantOf(owner.client);
      const offer = (name: string, cron: string) =>
        offerThroughAssistant(owner, assistant, (run) =>
          owner.agent.send({
            type: "routine_offer",
            ...run,
            name,
            instruction: "读一下仓库星数，报回来",
            cron,
            executorBotId: owner.botId,
            boundary: "read_only",
            purpose: "plan",
            onToday: true,
            projectGroupId: null,
          }),
        );
      const decide = (messageId: MessageId, decision: "add" | "dismiss") =>
        owner.client.post(`/api/messages/${messageId}/routine-offer`, { decision });

      await offer("周一读星数", "0 9 * * 1");
      const added = await offer("每天晨报", "30 8 * * *");
      const dismissed = await offer("周五复盘", "0 17 * * 5");
      expect((await decide(added, "add")).status).toBe(200);
      expect((await decide(dismissed, "dismiss")).status).toBe(200);

      await say(owner.client, assistant.groupId, "刚才的例行怎样了");
      const prompt = await nextPrompt(owner.agent);

      expect(cardLines(prompt), "每张卡一句：谁提的、例行名、cron 原文、结论").toEqual([
        { text: "主助理提议的例行「周一读星数」（cron 0 9 * * 1），还在等你点加上", settled: false },
        { text: "主助理提议的例行「每天晨报」（cron 30 8 * * *），你点了加上，例行建好了", settled: true },
        { text: "主助理提议的例行「周五复盘」（cron 0 17 * * 5），你没要", settled: true },
      ]);
    } finally {
      owner.close();
    }
  });
});

const settledFlags = (prompt: Prompt) => prompt.context.map((line) => ({ text: line.text, settled: line.settled }));

describe("上下文行带是否定稿", () => {
  it("还在流的 Bot 消息标没定稿，流完标定稿，别的行一律定稿", async () => {
    const owner = await onlineOwner();
    try {
      const { groupId, wenId } = await withTeammate(owner);
      await say(owner.client, groupId, "@阿文 查下库存");
      const wen = await nextPrompt(owner.agent);
      const said = MessageId.parse(randomUUID());
      const half = MessageId.parse(randomUUID());
      const stream = (messageId: MessageId, delta: string, done: boolean) =>
        owner.agent.send({ type: "bot_text", runId: wen.runId, botId: wenId, groupId, messageId, delta, done });
      stream(said, "我先查一下库存。", true);
      stream(half, "库存还剩三十", false);
      for (;;) {
        const pushed = await owner.push.next();
        if (pushed.type === "message_delta" && pushed.messageId === half) break;
      }

      await say(owner.client, groupId, "@小服 看下排产");
      const during = await nextPrompt(owner.agent);
      stream(half, "件。", true);
      owner.agent.send({
        type: "run_done",
        runId: wen.runId,
        botId: wenId,
        groupId,
        steps: 1,
        inputTokens: 0,
        outputTokens: 0,
      });
      await waitFor(
        async () =>
          (await database.sql`SELECT 1 FROM runs WHERE id = ${wen.runId} AND ended_at IS NOT NULL`).length === 1,
        "阿文的 run 收尾",
      );
      await say(owner.client, groupId, "@小服 再对一下");
      const after = await nextPrompt(owner.agent);

      expect(settledFlags(during), "阿文那句还在流，标没定稿").toEqual([
        { text: "@阿文 查下库存", settled: true },
        { text: "我先查一下库存。", settled: true },
        { text: "库存还剩三十", settled: false },
      ]);
      expect(
        settledFlags(after).find((line) => line.text.startsWith("库存还剩")),
        "流完就标定稿",
      ).toEqual({ text: "库存还剩三十件。", settled: true });
    } finally {
      owner.close();
    }
  });

  it("审批还在等时标没定稿，批了之后同一行换成结论并标定稿", async () => {
    const owner = await approvalObserver();
    try {
      await say(owner.client, owner.groupId, "@小服 把这笔款付了");
      const first = await nextPrompt(owner.agent);
      owner.agent.send({
        type: "approval_request",
        runId: first.runId,
        botId: owner.botId,
        groupId: owner.groupId,
        callId: "call-pay",
        tool: "bash",
        action: "spend",
        target: null,
        view: bash("pay 100"),
      });
      let approvalId: ApprovalId | null = null;
      while (approvalId === null) {
        const pushed = await owner.push.next();
        if (pushed.type === "approval_updated") approvalId = pushed.approval.id;
      }

      await say(owner.client, owner.groupId, "@阿文 付了没");
      const pending = await nextPrompt(owner.agent);
      expect((await owner.client.post(`/api/approvals/${approvalId}`, { decision: "approved" })).status).toBe(200);
      await say(owner.client, owner.groupId, "现在呢");
      const decided = await nextPrompt(owner.agent);

      const before = payCard(pending);
      expect(before, "还在等批，标没定稿").toEqual({
        messageId: expect.any(String),
        from: "系统",
        text: "小服要执行 `pay 100`，还在等你点头",
        settled: false,
      });
      expect(payCard(decided), "还是同一行，字换成结论，不再会变").toEqual({
        messageId: before?.messageId,
        from: "系统",
        text: "小服要执行 `pay 100`，你批准了",
        settled: true,
      });
    } finally {
      owner.close();
    }
  });
});

/** 等某条 Bot 消息的这一段 delta 落库。推送在落库之后发。 */
async function deltaLanded(push: PushClient, messageId: MessageId, done: boolean): Promise<void> {
  for (;;) {
    const pushed = await push.next();
    if (pushed.type === "message_delta" && pushed.messageId === messageId && pushed.done === done) return;
  }
}

/** 群里不派活的闲聊。直接落库，不经 HTTP，免得每条都派一次活。 */
async function chatter(groupId: GroupId, count: number): Promise<void> {
  for (let n = 1; n <= count; n += 1) await appendMessage(database.db, groupId, { kind: "user", text: `闲聊 ${n}` });
}

const chatterLines = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => ({ from: "你", text: `闲聊 ${from + index}`, settled: true }));

const fullLines = (prompt: Prompt) => prompt.context.map(({ from, text, settled }) => ({ from, text, settled }));

/** 小服在这个 run 里要付 100 块，等审批卡落库。 */
async function requestPay(owner: Owner, runId: Prompt["runId"], groupId: GroupId): Promise<ApprovalId> {
  owner.agent.send({
    type: "approval_request",
    runId,
    botId: owner.botId,
    groupId,
    callId: `call-${randomUUID()}`,
    tool: "bash",
    action: "spend",
    target: null,
    view: bash("pay 100"),
  });
  for (;;) {
    const pushed = await owner.push.next();
    if (pushed.type === "approval_updated") return pushed.approval.id;
  }
}

/** run_done 里运行器怎么说这次触发：进了会话、没进，或者是不带这个字段的旧运行器。 */
type RunDoneSaid = "entered" | "dropped" | "unsaid";

/**
 * 电脑报这次 run 跑完，默认说触发进了会话，它记下的名单从此作数。花费卡在确认之后才推，等到它就是确认落了库。
 * 花费卡也占 20 条窗口的一格，要在闲聊之前收尾，窗口里才正好是最近 20 条闲聊。
 */
async function runDone(
  owner: Pick<Owner, "agent" | "push">,
  prompt: Prompt,
  said: RunDoneSaid = "entered",
): Promise<void> {
  owner.agent.send({
    type: "run_done",
    runId: prompt.runId,
    botId: prompt.botId,
    groupId: prompt.groupId,
    ...(said === "unsaid" ? {} : { prompt: said }),
    steps: 1,
    inputTokens: 0,
    outputTokens: 0,
  });
  for (;;) {
    const pushed = await owner.push.next();
    if (
      pushed.type === "message" &&
      pushed.message.body.kind === "cost" &&
      pushed.message.body.runId === prompt.runId
    ) {
      await owner.agent.ack(prompt.runId);
      return;
    }
  }
}

describe("滑出窗口时没定稿的行接着送", () => {
  it("半截那条滑出 20 条窗口以后才说完，下一次派活在窗口前面补上整句", async () => {
    const owner = await onlineOwner();
    try {
      const { groupId, wenId } = await withTeammate(owner);
      await say(owner.client, groupId, "@阿文 查下库存");
      const wen = await nextPrompt(owner.agent);
      const half = MessageId.parse(randomUUID());
      const stream = (delta: string, done: boolean) =>
        owner.agent.send({ type: "bot_text", runId: wen.runId, botId: wenId, groupId, messageId: half, delta, done });
      stream("库存还剩三十", false);
      await deltaLanded(owner.push, half, false);

      await say(owner.client, groupId, "@小服 看下排产");
      const during = await nextPrompt(owner.agent);
      await runDone(owner, during);
      await chatter(groupId, 25);
      stream("件。", true);
      await deltaLanded(owner.push, half, true);
      await say(owner.client, groupId, "@小服 再对一下");
      const after = await nextPrompt(owner.agent);

      expect(fullLines(during).at(-1), "上一次看到的是半截").toEqual({
        from: "阿文",
        text: "库存还剩三十",
        settled: false,
      });
      expect(fullLines(after), "窗口只剩最近 20 条闲聊，阿文说完的整句补在前面").toEqual([
        { from: "阿文", text: "库存还剩三十件。", settled: true },
        ...chatterLines(6, 25),
      ]);
    } finally {
      owner.close();
    }
  });

  it("卡滑出窗口时还在等批，照样接着送；隔了一轮再批，那一轮看到结论，之后不再送", async () => {
    const owner = await approvalObserver();
    try {
      await say(owner.client, owner.groupId, "@小服 把这笔款付了");
      const first = await nextPrompt(owner.agent);
      const approvalId = await requestPay(owner, first.runId, owner.groupId);
      await say(owner.client, owner.groupId, "@阿文 付了没");
      const asked = await nextPrompt(owner.agent);
      const seen = payCard(asked);
      await runDone(owner, asked);
      await chatter(owner.groupId, 25);
      await say(owner.client, owner.groupId, "还没付吗");
      const outside = await nextPrompt(owner.agent);
      await runDone(owner, outside);
      expect((await owner.client.post(`/api/approvals/${approvalId}`, { decision: "approved" })).status).toBe(200);
      await say(owner.client, owner.groupId, "现在呢");
      const decided = await nextPrompt(owner.agent);
      await runDone(owner, decided);
      await say(owner.client, owner.groupId, "还有别的吗");
      const later = await nextPrompt(owner.agent);

      expect(seen?.settled, "头一次看到时还在等批").toBe(false);
      expect(fullLines(outside), "卡已经滑出窗口，还没定稿，接在窗口前面").toEqual([
        { from: "系统", text: "小服要执行 `pay 100`，还在等你点头", settled: false },
        ...chatterLines(6, 25),
      ]);
      expect(decided.context[0], "隔了一轮才批，同一行换成结论").toEqual({
        messageId: seen?.messageId,
        from: "系统",
        text: "小服要执行 `pay 100`，你批准了",
        settled: true,
      });
      expect(payCard(later), "定稿那一轮送过了，之后不再送").toBeUndefined();
    } finally {
      owner.close();
    }
  });

  it("草稿滑出窗口以后批了，下一次派活看到「你批准了，留着没发」，还没发出去仍标没定稿", async () => {
    const job = await contentJob(server, database.db, [{ platform: "github", handle: "baize-dev", token: "gh-unit" }]);
    try {
      const [github] = job.accounts;
      if (github === undefined) throw new Error("没挂上账号");
      await setTier(job, github, "draft");
      const draft = await createDraft(job, specOf(github, issuePost("本月做了什么", "月度复盘")));
      await say(job.client, job.groupId, "看看草稿");
      const looked = await nextPrompt(job.agent);
      const before = looked.context.find((line) => line.text.includes("月度复盘"));
      await runDone(job, looked);
      await chatter(job.groupId, 25);
      expect((await job.client.post(`/api/drafts/${draft.id}`, { decision: "approve" })).status).toBe(200);
      await say(job.client, job.groupId, "草稿怎样了");
      const after = await nextPrompt(job.agent);

      expect(before, "批之前还在等看").toEqual({
        messageId: expect.any(String),
        from: "系统",
        text: "小内起草的草稿「月度复盘」（GitHub），还在等你看",
        settled: false,
      });
      expect(after.context[0], "滑出窗口以后批的，同一行接在窗口前面，换成新状态").toEqual({
        messageId: before?.messageId,
        from: "系统",
        text: "小内起草的草稿「月度复盘」（GitHub），你批准了，留着没发",
        settled: false,
      });
    } finally {
      job.close();
    }
  });

  it("接着送最多 10 条，留最新的", async () => {
    const owner = await onlineOwner();
    try {
      const { groupId, wenId } = await withTeammate(owner);
      await say(owner.client, groupId, "@阿文 报一下各仓");
      const wen = await nextPrompt(owner.agent);
      for (let n = 1; n <= 12; n += 1) {
        const messageId = MessageId.parse(randomUUID());
        owner.agent.send({
          type: "bot_text",
          runId: wen.runId,
          botId: wenId,
          groupId,
          messageId,
          delta: `${n} 号仓还在点货`,
          done: false,
        });
        await deltaLanded(owner.push, messageId, false);
      }

      await say(owner.client, groupId, "@小服 汇总一下");
      await runDone(owner, await nextPrompt(owner.agent));
      await chatter(groupId, 25);
      await say(owner.client, groupId, "@小服 再汇总");
      const after = await nextPrompt(owner.agent);

      expect(fullLines(after), "上一次 12 条都还在流，滑出窗口以后只接最新的 10 条").toEqual([
        ...Array.from({ length: 10 }, (_, index) => ({
          from: "阿文",
          text: `${index + 3} 号仓还在点货`,
          settled: false,
        })),
        ...chatterLines(6, 25),
      ]);
    } finally {
      owner.close();
    }
  });

  it("接着送的只看这个 Bot 自己上一次派活记下的，别的 Bot 后来派的活不算", async () => {
    const owner = await onlineOwner();
    try {
      const { wenId } = await withTeammate(owner);
      const observer = CreateBotResponse.parse(await (await owner.client.post("/api/bots", { name: "阿策" })).json());
      const { group } = CreateGroupResponse.parse(
        await (
          await owner.client.post("/api/groups", {
            title: "审批上下文观察",
            botIds: [owner.botId, wenId, observer.bot.id],
          })
        ).json(),
      );
      const groupId = group.id;
      await say(owner.client, groupId, "@小服 把这笔款付了");
      const first = await nextPrompt(owner.agent);
      const approvalId = await requestPay(owner, first.runId, groupId);
      await say(owner.client, groupId, "@阿策 付了没");
      const asked = await nextPrompt(owner.agent);
      const seen = payCard(asked);
      await runDone(owner, asked);
      await chatter(groupId, 25);
      await say(owner.client, groupId, "@阿文 你看看");
      const wen = await nextPrompt(owner.agent);
      await runDone(owner, wen);
      expect((await owner.client.post(`/api/approvals/${approvalId}`, { decision: "approved" })).status).toBe(200);
      await say(owner.client, groupId, "@阿策 现在呢");
      const decided = await nextPrompt(owner.agent);

      expect(fullLines(wen), "阿文头一次被派活，没看过那张卡，不接").toEqual(chatterLines(6, 25));
      expect(decided.context[0], "阿策接的是自己上一次记下的，阿文后来那次不算").toEqual({
        messageId: seen?.messageId,
        from: "系统",
        text: "小服要执行 `pay 100`，你批准了",
        settled: true,
      });
    } finally {
      owner.close();
    }
  });
});

/** 阿文看过一次小服还在等批的付款卡，那一轮正常收尾，卡随后滑出窗口，这时才批下来。 */
async function cardSettledOutsideWindow(owner: Owner): Promise<NonNullable<ReturnType<typeof payCard>>> {
  await say(owner.client, owner.groupId, "@小服 付这笔款");
  const first = await nextPrompt(owner.agent);
  const approvalId = await requestPay(owner, first.runId, owner.groupId);
  await say(owner.client, owner.groupId, "@阿文 查下审批");
  const asked = await nextPrompt(owner.agent);
  const card = payCard(asked);
  if (card === undefined) throw new Error("没看到付款卡");
  expect(card.settled, "头一次看到时还在等批").toBe(false);
  await runDone(owner, asked);
  await chatter(owner.groupId, 25);
  expect((await owner.client.post(`/api/approvals/${approvalId}`, { decision: "approved" })).status).toBe(200);
  return card;
}

/** 阿文在这个 run 里报一次工具调用的状态，等那条消息落库。同一个 callId 再报一次就是同一行换状态。 */
async function toolCall(
  owner: Pick<Owner, "agent" | "push">,
  run: Prompt,
  callId: string,
  command: string,
  status: ToolCallStatus,
): Promise<void> {
  owner.agent.send({
    type: "bot_tool_call",
    runId: run.runId,
    botId: run.botId,
    groupId: run.groupId,
    callId,
    tool: "bash",
    view: bash(command),
    status,
    durationMs: status === "running" ? null : 12,
  });
  for (;;) {
    const pushed = await owner.push.next();
    const body = pushed.type === "message" ? pushed.message.body : null;
    if (
      body?.kind === "tool_call" &&
      body.status === status &&
      body.view.kind === "bash" &&
      body.view.command === command
    )
      return;
  }
}

describe("上下文里的工具调用行", () => {
  it("四种状态各写一句，只有还在跑的标没定稿", async () => {
    const owner = await onlineOwner();
    try {
      const { groupId } = await withTeammate(owner);
      await say(owner.client, groupId, "@阿文 查下库存");
      const wen = await nextPrompt(owner.agent);
      await toolCall(owner, wen, "call-ls", "ls", "running");
      await toolCall(owner, wen, "call-cat", "cat a", "ok");
      await toolCall(owner, wen, "call-rm", "rm b", "failed");
      await toolCall(owner, wen, "call-curl", "curl c", "blocked");

      await say(owner.client, groupId, "@小服 看下排产");
      const prompt = await nextPrompt(owner.agent);

      expect(fullLines(prompt)).toEqual([
        { from: "你", text: "@阿文 查下库存", settled: true },
        { from: "阿文", text: "要执行 `ls`，还没跑完", settled: false },
        { from: "阿文", text: "要执行 `cat a`，跑完了", settled: true },
        { from: "阿文", text: "要执行 `rm b`，没跑成", settled: true },
        { from: "阿文", text: "要执行 `curl c`，被拦下了，没执行", settled: true },
      ]);
    } finally {
      owner.close();
    }
  });

  it("工具还在跑时滑出窗口，照样接着送；跑完以后同一行换成结论，那一轮之后不再送", async () => {
    const owner = await onlineOwner();
    try {
      const { groupId } = await withTeammate(owner);
      await say(owner.client, groupId, "@阿文 查下库存");
      const wen = await nextPrompt(owner.agent);
      await toolCall(owner, wen, "call-ls", "ls", "running");
      await say(owner.client, groupId, "@小服 看下排产");
      const during = await nextPrompt(owner.agent);
      await runDone(owner, during);
      await chatter(groupId, 25);
      await say(owner.client, groupId, "@小服 还没好吗");
      const outside = await nextPrompt(owner.agent);
      await runDone(owner, outside);
      await toolCall(owner, wen, "call-ls", "ls", "ok");
      await say(owner.client, groupId, "@小服 现在呢");
      const finished = await nextPrompt(owner.agent);
      await runDone(owner, finished);
      await say(owner.client, groupId, "@小服 还有别的吗");
      const later = await nextPrompt(owner.agent);

      const running = during.context.find((line) => line.text.startsWith("要执行 `ls`"));
      expect(running, "头一次看到时还在跑").toMatchObject({ text: "要执行 `ls`，还没跑完", settled: false });
      expect(fullLines(outside), "工具行已经滑出窗口，还没定稿，接在窗口前面").toEqual([
        { from: "阿文", text: "要执行 `ls`，还没跑完", settled: false },
        ...chatterLines(6, 25),
      ]);
      expect(finished.context[0], "同一行换成结论，不再会变").toEqual({
        messageId: running?.messageId,
        from: "阿文",
        text: "要执行 `ls`，跑完了",
        settled: true,
      });
      expect(
        later.context.some((line) => line.text.startsWith("要执行 `ls`")),
        "定稿那一轮送过了，之后不再送",
      ).toBe(false);
    } finally {
      owner.close();
    }
  });
});

const approvedCard = (card: NonNullable<ReturnType<typeof payCard>>) => ({
  messageId: card.messageId,
  from: "系统",
  text: "小服要执行 `pay 100`，你批准了",
  settled: true,
});

const listOf = async (runId: Prompt["runId"]) =>
  (await database.sql`SELECT unsettled_context, context_confirmed_at FROM runs WHERE id = ${runId}`)[0];

describe("名单等送达确认以后才生效", () => {
  it("带着新结论的 prompt 没发出去，下一次派活照样补送这条结论", async () => {
    const owner = await approvalObserver();
    try {
      const card = await cardSettledOutsideWindow(owner);
      const spy = vi.spyOn(AgentHub.prototype, "flushOutbox").mockImplementation(async () => undefined);
      try {
        await say(owner.client, owner.groupId, "刚批准了，看看");
      } finally {
        spy.mockRestore();
      }
      const rows = await database.sql<{ body: unknown; run_id: string }[]>`
        SELECT body, run_id FROM agent_outbox WHERE body->>'type' = 'prompt' ORDER BY seq DESC LIMIT 1
      `;
      const row = rows[0];
      if (row === undefined) throw new Error("这一次 prompt 已入箱");
      const attempt = ControlToAgent.parse(row.body);
      if (attempt.type !== "prompt") throw new Error("outbox 末条不是 prompt");
      expect(payCard(attempt), "发不出去的那次带着结论").toEqual(approvedCard(card));
      expect(await listOf(attempt.runId), "名单照记，但没确认").toEqual({
        unsettled_context: [],
        context_confirmed_at: null,
      });

      await say(owner.client, owner.groupId, "发送恢复，重新查");
      const retry = await nextPrompt(owner.agent);
      await runDone(owner, retry);
      const later = await nextPrompt(owner.agent);
      await runDone(owner, later);
      await say(owner.client, owner.groupId, "再查一次");
      const after = await nextPrompt(owner.agent);

      expect(payCard(retry), "结论没送到过，恢复后补送").toEqual(approvedCard(card));
      expect(payCard(later), "恢复时已经排入箱的下一条 prompt 仍带这份结论").toEqual(approvedCard(card));
      expect(payCard(after), "确认后的新派活不再重复送结论").toBeUndefined();
    } finally {
      owner.close();
    }
  });

  it("带着新结论的 run 在执行前被电脑拒掉收了尾，下一次派活照样补送这条结论", async () => {
    const owner = await approvalObserver();
    try {
      const card = await cardSettledOutsideWindow(owner);
      await say(owner.client, owner.groupId, "刚批准了，看看");
      const attempt = await nextPrompt(owner.agent);
      expect(payCard(attempt), "被拒的那次带着结论").toEqual(approvedCard(card));
      owner.agent.send({
        type: "agent_error",
        code: "prompt_before_config",
        detail: "还没收到 config",
        groupId: owner.groupId,
        runId: attempt.runId,
      });
      for (;;) {
        const pushed = await owner.push.next();
        if (
          pushed.type === "message" &&
          pushed.message.body.kind === "system" &&
          pushed.message.body.text.includes("还没收到 config")
        )
          break;
      }
      expect(await listOf(attempt.runId), "run 收了尾，名单照记，但没确认").toEqual({
        unsettled_context: [],
        context_confirmed_at: null,
      });

      await say(owner.client, owner.groupId, "执行恢复，重新查");
      const retry = await nextPrompt(owner.agent);
      await runDone(owner, retry);
      await say(owner.client, owner.groupId, "再查一次");
      const later = await nextPrompt(owner.agent);

      expect(payCard(retry), "结论没进过模型，恢复后补送").toEqual(approvedCard(card));
      expect(payCard(later), "送到过一次，之后不再送").toBeUndefined();
    } finally {
      owner.close();
    }
  });

  it("运行器还没把 prompt 交给会话就失败，报带 runId 的错再补零用量 run_done，下一次派活照样补送这条结论", async () => {
    const owner = await approvalObserver();
    /** 等这条 agent_error 的系统消息推到。同一台电脑的报文按到达顺序处理，它前面的报文都已处理完。 */
    const failed = async (detail: string, runId?: Prompt["runId"]) => {
      owner.agent.send({
        type: "agent_error",
        code: "runner_failed",
        detail,
        groupId: owner.groupId,
        ...(runId === undefined ? {} : { runId }),
      });
      for (;;) {
        const pushed = await owner.push.next();
        if (
          pushed.type === "message" &&
          pushed.message.body.kind === "system" &&
          pushed.message.body.text.includes(detail)
        )
          return pushed.message.body.text;
      }
    };
    try {
      const card = await cardSettledOutsideWindow(owner);
      await say(owner.client, owner.groupId, "刚批准了，看看");
      const attempt = await nextPrompt(owner.agent);
      expect(payCard(attempt), "没跑起来的那次带着结论").toEqual(approvedCard(card));
      const notice = await failed("建会话失败", attempt.runId);
      owner.agent.send({
        type: "run_done",
        runId: attempt.runId,
        botId: attempt.botId,
        groupId: attempt.groupId,
        steps: 0,
        inputTokens: 0,
        outputTokens: 0,
      });
      await failed("跟在 run_done 后面的探针");
      expect(notice, "群里看到的是跑活进程出错").toBe("电脑那边没干成这件事，跑活的进程出错了。原话是：建会话失败");
      expect(await listOf(attempt.runId), "带 runId 的错先收了尾，补来的 run_done 落空，名单不作数").toEqual({
        unsettled_context: [],
        context_confirmed_at: null,
      });

      await say(owner.client, owner.groupId, "恢复了，重新查");
      const retry = await nextPrompt(owner.agent);
      await runDone(owner, retry);
      await say(owner.client, owner.groupId, "再查一次");
      const later = await nextPrompt(owner.agent);

      expect(payCard(retry), "结论没进过会话，恢复后补送").toEqual(approvedCard(card));
      expect(payCard(later), "送到过一次，之后不再送").toBeUndefined();
    } finally {
      owner.close();
    }
  });

  it("上一次 run 还没 run_done 时又派一次活，用的是更早那条已确认的名单", async () => {
    const owner = await approvalObserver();
    try {
      const card = await cardSettledOutsideWindow(owner);
      await say(owner.client, owner.groupId, "刚批准了，看看");
      const running = await nextPrompt(owner.agent);
      await say(owner.client, owner.groupId, "顺便再看一眼");
      const overlapping = await nextPrompt(owner.agent);
      await runDone(owner, overlapping);
      await say(owner.client, owner.groupId, "再查一次");
      const later = await nextPrompt(owner.agent);

      expect(payCard(running), "还在跑的那次带着结论").toEqual(approvedCard(card));
      expect(await listOf(running.runId), "还没跑完，名单不作数").toEqual({
        unsettled_context: [],
        context_confirmed_at: null,
      });
      expect(payCard(overlapping), "接着用更早那份确认过的名单，结论再送一次").toEqual(approvedCard(card));
      expect(payCard(later), "这一次确认了，之后不再送").toBeUndefined();
    } finally {
      owner.close();
    }
  });
});

/** 阿文看过的卡批了、滑出了窗口，这一次派活带着结论，运行器照 said 回 run_done，再派一次看接不接。 */
async function conclusionDelivered(owner: Owner, said: RunDoneSaid) {
  const card = await cardSettledOutsideWindow(owner);
  await say(owner.client, owner.groupId, "刚批准了，看看");
  const attempt = await nextPrompt(owner.agent);
  expect(payCard(attempt), "这一次带着结论").toEqual(approvedCard(card));
  await runDone(owner, attempt, said);
  await say(owner.client, owner.groupId, "再查一次");
  return { card, attempt, later: await nextPrompt(owner.agent) };
}

describe("名单确认与否由运行器说这次触发进没进会话", () => {
  it("运行器报进了会话，名单确认，结论之后不再送", async () => {
    const owner = await approvalObserver();
    try {
      const { attempt, later } = await conclusionDelivered(owner, "entered");
      expect(await listOf(attempt.runId), "进了会话就确认").toMatchObject({ context_confirmed_at: expect.any(String) });
      expect(payCard(later), "送到过一次，之后不再送").toBeUndefined();
    } finally {
      owner.close();
    }
  });

  it("运行器报没进会话，run 照样收尾但名单不确认，下一次派活照样补送这条结论", async () => {
    const owner = await approvalObserver();
    try {
      const { card, attempt, later } = await conclusionDelivered(owner, "dropped");
      expect(await listOf(attempt.runId), "run 收了尾，名单照记，但没确认").toEqual({
        unsettled_context: [],
        context_confirmed_at: null,
      });
      expect(
        (await database.sql`SELECT 1 FROM runs WHERE id = ${attempt.runId} AND ended_at IS NOT NULL`).length,
        "dropped 的 run_done 一样收尾",
      ).toBe(1);
      expect(payCard(later), "结论没进过会话，再送一次").toEqual(approvedCard(card));

      await runDone(owner, later);
      await say(owner.client, owner.groupId, "还有别的吗");
      expect(payCard(await nextPrompt(owner.agent)), "这一次进了会话，之后不再送").toBeUndefined();
    } finally {
      owner.close();
    }
  });

  it("旧运行器的 run_done 不带这个字段，按进了会话算：名单确认，之后不再送", async () => {
    const owner = await approvalObserver();
    try {
      const { attempt, later } = await conclusionDelivered(owner, "unsaid");
      expect(await listOf(attempt.runId), "不带字段照旧确认").toMatchObject({
        context_confirmed_at: expect.any(String),
      });
      expect(payCard(later), "之后不再送").toBeUndefined();
    } finally {
      owner.close();
    }
  });
});

/** 等群里这条用户消息推到。消息路由先落库推送，再加 skill 用量，最后才派活。 */
async function userMessagePushed(push: PushClient, text: string): Promise<void> {
  for (;;) {
    const pushed = await push.next();
    if (pushed.type === "message" && pushed.message.body.kind === "user" && pushed.message.body.text === text) return;
  }
}

describe("相邻两次派活交错时，建得更晚的名单盖不掉触发更靠后那份", () => {
  it("后建的 run 基于更早的消息，下一次派活接的仍是触发消息更靠后那份名单", async () => {
    const owner = await approvalObserver();
    try {
      const { skill } = SkillResponse.parse(
        await (await owner.client.post(`/api/bots/${owner.botId}/skills`, { name: "对账", steps: ["翻账本"] })).json(),
      );
      await say(owner.client, owner.groupId, "@小服 付这笔款");
      const first = await nextPrompt(owner.agent);

      // 锁住 skill 行：带 `/对账` 的那条消息落库、推送以后卡在加用量上，等它派活时后一条消息已经派完了。
      let unlock!: () => void;
      const unlocked = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      let locked!: () => void;
      const lockHeld = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holding = database.sql.begin(async (tx) => {
        await tx`SELECT 1 FROM skills WHERE id = ${skill.id} FOR UPDATE`;
        locked();
        await unlocked;
      });
      await lockHeld;
      const stuck = owner.client.post(`/api/groups/${owner.groupId}/messages`, { text: "/对账 @阿文 这笔付了没" });
      await userMessagePushed(owner.push, "/对账 @阿文 这笔付了没");
      const approvalId = await requestPay(owner, first.runId, owner.groupId);
      await say(owner.client, owner.groupId, "@阿文 付了没");
      const newer = await nextPrompt(owner.agent);
      unlock();
      await holding;
      expect((await stuck).status).toBe(201);
      const older = await nextPrompt(owner.agent);
      const card = payCard(newer);

      await runDone(owner, newer);
      await runDone(owner, older);
      await chatter(owner.groupId, 25);
      expect((await owner.client.post(`/api/approvals/${approvalId}`, { decision: "approved" })).status).toBe(200);
      await say(owner.client, owner.groupId, "现在呢");
      const later = await nextPrompt(owner.agent);

      expect(card, "基于后一条消息的那次看到了还在等批的卡").toMatchObject({ settled: false });
      expect(payCard(older), "后建的 run 基于前一条消息，窗口里还没有这张卡").toBeUndefined();
      expect(
        (
          await database.sql`SELECT id FROM runs WHERE id IN ${database.sql([newer.runId, older.runId])} ORDER BY started_at DESC`
        ).map((row) => row.id),
        "基于前一条消息的 run 建得更晚",
      ).toEqual([older.runId, newer.runId]);
      if (card === undefined) throw new Error("没看到付款卡");
      expect(payCard(later), "建得更晚那份名单里没有卡，也盖不掉触发更靠后那份里的卡").toEqual(approvedCard(card));
    } finally {
      owner.close();
    }
  });
});

/** 等群里的交接卡推到，拿它的消息 id。 */
async function handoffMessagePushed(push: PushClient): Promise<MessageId> {
  for (;;) {
    const pushed = await push.next();
    if (pushed.type === "message" && pushed.message.body.kind === "handoff") return pushed.message.id;
  }
}

describe("交接排到后面才派时，被 @ 那份更晚的名单盖不掉交接那份", () => {
  it("交接触发的消息更早、窗口却更新，下一次派活接的是交接那份名单，付款结论照样补送", async () => {
    const owner = await onlineOwner();
    try {
      const { groupId, wenId } = await withTeammate(owner);
      await say(owner.client, groupId, "@小服 请交给阿文");
      const from = await nextPrompt(owner.agent);
      owner.agent.send({
        type: "handoff",
        runId: from.runId,
        botId: owner.botId,
        groupId,
        toBotId: wenId,
        done: "查过了",
        notDone: "付款待核",
        next: "核付款",
        checklistIndex: null,
      });
      const handoffMessageId = await handoffMessagePushed(owner.push);
      // 阿文被 @ 的这条先派，交接的 prompt 排在它后面；等交接派出去时付款卡已经落库，它读的最近 20 条里有卡。
      await say(owner.client, groupId, "@阿文 先看这条新消息");
      const newerTrigger = await nextPrompt(owner.agent);
      expect(newerTrigger.botId).toBe(wenId);
      expect(payCard(newerTrigger), "被 @ 的那次派活时卡还没落库").toBeUndefined();
      const approvalId = await requestPay(owner, from.runId, groupId);
      await runDone(owner, newerTrigger);
      const laterWindow = await nextPrompt(owner.agent);
      expect(laterWindow.botId).toBe(wenId);
      expect(laterWindow.messageId, "交接那次的触发是更早的交接卡").toBe(handoffMessageId);
      const card = payCard(laterWindow);
      expect(card, "交接那次读到了还在等批的卡").toMatchObject({ settled: false });
      await runDone(owner, laterWindow);
      await chatter(groupId, 25);
      expect((await owner.client.post(`/api/approvals/${approvalId}`, { decision: "approved" })).status).toBe(200);
      await say(owner.client, groupId, "@阿文 再核付款");
      const retry = await nextPrompt(owner.agent);

      if (card === undefined) throw new Error("没看到付款卡");
      expect(payCard(retry), "被 @ 那份名单触发更晚却没有卡，盖不掉交接那份里的卡，定稿后照样补送结论").toEqual(
        approvedCard(card),
      );
    } finally {
      owner.close();
    }
  });
});

describe("几次派活读到的消息集合互不包含时，哪份名单都盖不掉别的", () => {
  it("触发最早的 run 接回了卡、触发最晚的 run 窗口里没卡、中间那次直接读到卡，三份名单并起来，卡批了以后结论补送一次", async () => {
    const owner = await approvalObserver();
    try {
      const { skill } = SkillResponse.parse(
        await (await owner.client.post(`/api/bots/${owner.botId}/skills`, { name: "对账", steps: ["翻账本"] })).json(),
      );
      await say(owner.client, owner.groupId, "@小服 付这笔款");
      const first = await nextPrompt(owner.agent);

      let unlock!: () => void;
      const unlocked = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      let locked!: () => void;
      const lockHeld = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holding = database.sql.begin(async (tx) => {
        await tx`SELECT 1 FROM skills WHERE id = ${skill.id} FOR UPDATE`;
        locked();
        await unlocked;
      });
      await lockHeld;
      // 卡在加用量上的这条触发最早，等它派出去时卡已经确认在别的名单里，它靠接着送读到卡。
      const stuck = owner.client.post(`/api/groups/${owner.groupId}/messages`, { text: "/对账 @阿文 这笔付了没" });
      await userMessagePushed(owner.push, "/对账 @阿文 这笔付了没");
      const approvalId = await requestPay(owner, first.runId, owner.groupId);
      await say(owner.client, owner.groupId, "@阿文 付了没");
      const direct = await nextPrompt(owner.agent);
      const card = payCard(direct);
      expect(card, "中间那次在窗口里直接读到了还在等批的卡").toMatchObject({ settled: false });
      await chatter(owner.groupId, 25);
      // 触发最晚的这条，窗口里全是闲聊，又没有确认过的名单可接，什么卡都没读到。
      await say(owner.client, owner.groupId, "现在呢");
      const latest = await nextPrompt(owner.agent);
      expect(payCard(latest), "触发最晚那次窗口里没有卡，也还没有名单可接").toBeUndefined();
      await runDone(owner, direct);
      unlock();
      await holding;
      expect((await stuck).status).toBe(201);
      const earliest = await nextPrompt(owner.agent);
      expect(payCard(earliest), "触发最早那次从中间那次的名单接回了还在等批的卡").toMatchObject({ settled: false });
      await runDone(owner, latest);
      await runDone(owner, earliest);
      expect((await owner.client.post(`/api/approvals/${approvalId}`, { decision: "approved" })).status).toBe(200);

      await say(owner.client, owner.groupId, "再看看");
      const retry = await nextPrompt(owner.agent);
      if (card === undefined) throw new Error("没看到付款卡");
      expect(payCard(retry), "三份名单里无论按触发还是按读到的消息挑哪一份，都不能把卡丢掉").toEqual(
        approvedCard(card),
      );
      await runDone(owner, retry);
      await say(owner.client, owner.groupId, "还有吗");
      const after = await nextPrompt(owner.agent);
      expect(payCard(after), "结论送过一次、那次进了会话，之后不再送").toBeUndefined();
    } finally {
      owner.close();
    }
  });
});

describe("名单的寿命从确认算起，不从建 run 算起", () => {
  it("建得最早、送得最晚的 run 刚确认，它那份名单撑得过后面 20 次确认，卡批了以后结论照样补送一次", async () => {
    const owner = await onlineOwner();
    const bots = BotListResponse.parse(await (await owner.client.get("/api/bots")).json());
    const assistant = bots.items.find((item) => item.bot.role === "assistant");
    if (assistant === undefined) throw new Error("没有主助理");
    const team = CreateGroupResponse.parse(
      await (
        await owner.client.post("/api/groups", { title: "延后派活", botIds: [owner.botId, assistant.bot.id] })
      ).json(),
    );
    const groupId = team.group.id;
    const mention = `@${assistant.bot.name} `;
    // 观察者是主助理：它的 prompt 送出去之前控制面还要读项目清单，只把这一次读扣住，建 run、记名单、送、确认都是真的。
    let reached!: () => void;
    const blocked = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = taskRepo.listProjects;
    let held = false;
    const spy = vi.spyOn(taskRepo, "listProjects").mockImplementation(async (...args) => {
      if (!held) {
        held = true;
        reached();
        await released;
      }
      return original(...args);
    });
    let stuck: Promise<Response> | undefined;
    try {
      await say(owner.client, groupId, "@小服 付这笔款");
      const source = await nextPrompt(owner.agent);
      expect(source.botId).toBe(owner.botId);
      const approvalId = await requestPay(owner, source.runId, groupId);
      stuck = owner.client.post(`/api/groups/${groupId}/messages`, { text: `${mention}这笔付了没` });
      await blocked;
      const [early] = await database.sql`
        SELECT id, unsettled_context FROM runs WHERE group_id = ${groupId} AND bot_id = ${assistant.bot.id}`;
      expect(early?.unsettled_context ?? null, "上下文仍在读取期间，run、名单和 prompt 还未提交").toBeNull();
      await chatter(groupId, 25);
      for (let n = 1; n <= 20; n += 1) {
        await say(owner.client, groupId, `${mention}晚一步 ${n}`);
        const later = await nextPrompt(owner.agent);
        expect(payCard(later), "早那份名单还没确认，卡不在窗口里，也没有名单可接").toBeUndefined();
        await runDone(owner, later);
      }
      release();
      expect((await stuck).status).toBe(201);
      const delayed = await nextPrompt(owner.agent);
      const card = payCard(delayed);
      expect(card, "它在窗口里直接读到了还在等批的卡").toMatchObject({ settled: false });
      if (card === undefined) throw new Error("延迟的 prompt 没有付款卡");
      expect(await listOf(delayed.runId), "gate 放行后，run 和完整未结名单随 prompt 一起提交").toMatchObject({
        unsettled_context: [card.messageId],
        context_confirmed_at: null,
      });
      await runDone(owner, delayed);
      const [latest] = await database.sql`
        SELECT id FROM runs WHERE group_id = ${groupId} AND bot_id = ${assistant.bot.id} ORDER BY started_at DESC LIMIT 1`;
      expect(latest?.id, "事务 gate 放行后才建立这条 run").toBe(delayed.runId);
      expect((await owner.client.post(`/api/approvals/${approvalId}`, { decision: "approved" })).status).toBe(200);
      await say(owner.client, groupId, `${mention}批完了吗`);
      const retry = await nextPrompt(owner.agent);
      if (card === undefined) throw new Error("没看到付款卡");
      expect(payCard(retry), "只记过这一张卡，刚确认的名单还在最近 20 份里，批了以后结论补送").toEqual(
        approvedCard(card),
      );
      await runDone(owner, retry);
      await say(owner.client, groupId, `${mention}还有吗`);
      const after = await nextPrompt(owner.agent);
      expect(payCard(after), "结论送过一次、那次进了会话，之后不再送").toBeUndefined();
    } finally {
      release();
      spy.mockRestore();
      if (stuck !== undefined) await stuck.catch(() => undefined);
      owner.close();
    }
  });
});
