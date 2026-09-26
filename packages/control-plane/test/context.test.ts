import { randomUUID } from "node:crypto";
import {
  ApprovalId,
  ContentPlanId,
  CreateBotResponse,
  CreateGroupResponse,
  type BotId,
  type ControlToAgent,
  type GroupId,
  type ToolView,
} from "@baize/shared";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
        [readsOf("drafts"), readsOf("content_plans")],
        "草稿表两条（草稿卡一条，计划数篇数一条），计划表一条，都不按卡逐条查",
      ).toEqual([2, 1]);
    } finally {
      job.close();
    }
  });
});
