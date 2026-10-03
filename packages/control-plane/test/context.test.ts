import { randomUUID } from "node:crypto";
import {
  ApprovalId,
  ContentPlanId,
  CreateBotResponse,
  CreateGroupResponse,
  MessageId,
  type BotId,
  type ControlToAgent,
  type GroupId,
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
  it("审批卡按审批行现在的状态写结论，四张审批卡只查一次审批表", async () => {
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
        { from: "系统", text: "小服要执行 `pay 300`，还在等你点头" },
        { from: "系统", text: "小服要执行 `pay 400`，没批下来，过期了" },
      ]);
      expect(settledOnly(prompt), "只有还在等批的那张会变，标没定稿").toEqual([true, true, true, false, true]);
      expect(readsOf("approvals"), "四张审批卡一条查询查完，不按卡逐条查").toBe(1);
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
        team: [{ name: "小图", tag: "", description: "做图" }],
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
    const owner = await onlineOwner();
    try {
      await say(owner.client, owner.groupId, "把这笔款付了");
      const first = await owner.agent.expect("prompt");
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

      await say(owner.client, owner.groupId, "付了没");
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

/**
 * 电脑报这次 run 正常跑完，它记下的名单从此作数。花费卡在确认之后才推，等到它就是确认落了库。
 * 花费卡也占 20 条窗口的一格，要在闲聊之前收尾，窗口里才正好是最近 20 条闲聊。
 */
async function runDone(owner: Pick<Owner, "agent" | "push">, prompt: Prompt): Promise<void> {
  owner.agent.send({
    type: "run_done",
    runId: prompt.runId,
    botId: prompt.botId,
    groupId: prompt.groupId,
    steps: 1,
    inputTokens: 0,
    outputTokens: 0,
  });
  for (;;) {
    const pushed = await owner.push.next();
    if (pushed.type === "message" && pushed.message.body.kind === "cost" && pushed.message.body.runId === prompt.runId)
      return;
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
    const owner = await onlineOwner();
    try {
      await say(owner.client, owner.groupId, "把这笔款付了");
      const first = await nextPrompt(owner.agent);
      const approvalId = await requestPay(owner, first.runId, owner.groupId);
      await say(owner.client, owner.groupId, "付了没");
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
      const { groupId } = await withTeammate(owner);
      await say(owner.client, groupId, "@小服 把这笔款付了");
      const first = await nextPrompt(owner.agent);
      const approvalId = await requestPay(owner, first.runId, groupId);
      await say(owner.client, groupId, "@小服 付了没");
      const asked = await nextPrompt(owner.agent);
      const seen = payCard(asked);
      await runDone(owner, asked);
      await chatter(groupId, 25);
      await say(owner.client, groupId, "@阿文 你看看");
      const wen = await nextPrompt(owner.agent);
      await runDone(owner, wen);
      expect((await owner.client.post(`/api/approvals/${approvalId}`, { decision: "approved" })).status).toBe(200);
      await say(owner.client, groupId, "@小服 现在呢");
      const decided = await nextPrompt(owner.agent);

      expect(fullLines(wen), "阿文头一次被派活，没看过那张卡，不接").toEqual(chatterLines(6, 25));
      expect(decided.context[0], "小服接的是自己上一次记下的，阿文后来那次不算").toEqual({
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

/** 小服看过一次还在等批的付款卡，那一轮正常收尾，卡随后滑出窗口，这时才批下来。 */
async function cardSettledOutsideWindow(owner: Owner): Promise<NonNullable<ReturnType<typeof payCard>>> {
  await say(owner.client, owner.groupId, "付这笔款");
  const first = await nextPrompt(owner.agent);
  const approvalId = await requestPay(owner, first.runId, owner.groupId);
  await say(owner.client, owner.groupId, "查下审批");
  const asked = await nextPrompt(owner.agent);
  const card = payCard(asked);
  if (card === undefined) throw new Error("没看到付款卡");
  expect(card.settled, "头一次看到时还在等批").toBe(false);
  await runDone(owner, asked);
  await chatter(owner.groupId, 25);
  expect((await owner.client.post(`/api/approvals/${approvalId}`, { decision: "approved" })).status).toBe(200);
  return card;
}

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
    const owner = await onlineOwner();
    try {
      const card = await cardSettledOutsideWindow(owner);
      const attempts: Prompt[] = [];
      const originalSend = AgentHub.prototype.send;
      const spy = vi.spyOn(AgentHub.prototype, "send").mockImplementation(function (
        this: AgentHub,
        computerId,
        message,
      ) {
        if (message.type !== "prompt" || message.groupId !== owner.groupId)
          return originalSend.call(this, computerId, message);
        attempts.push(message);
        return false;
      });
      try {
        await say(owner.client, owner.groupId, "刚批准了，看看");
      } finally {
        spy.mockRestore();
      }
      const [attempt] = attempts;
      if (attempt === undefined) throw new Error("这一次没派出去");
      expect(payCard(attempt), "发不出去的那次带着结论").toEqual(approvedCard(card));
      expect(await listOf(attempt.runId), "名单照记，但没确认").toEqual({
        unsettled_context: [],
        context_confirmed_at: null,
      });

      await say(owner.client, owner.groupId, "发送恢复，重新查");
      const retry = await nextPrompt(owner.agent);
      await runDone(owner, retry);
      await say(owner.client, owner.groupId, "再查一次");
      const later = await nextPrompt(owner.agent);

      expect(payCard(retry), "结论没送到过，恢复后补送").toEqual(approvedCard(card));
      expect(payCard(later), "送到过一次，之后不再送").toBeUndefined();
    } finally {
      owner.close();
    }
  });

  it("带着新结论的 run 在执行前被电脑拒掉收了尾，下一次派活照样补送这条结论", async () => {
    const owner = await onlineOwner();
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
    const owner = await onlineOwner();
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
    const owner = await onlineOwner();
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
