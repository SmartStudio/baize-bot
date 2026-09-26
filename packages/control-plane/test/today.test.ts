import {
  ApprovalId,
  BotListResponse,
  CreateBotResponse,
  TodayResponse,
  type BotId,
  type GroupId,
  type UserId,
} from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accounts,
  approvals,
  contentPlans,
  drafts,
  messages,
  publications,
  routineRuns,
  routines,
  runs,
} from "../src/db/schema.js";
import { newId } from "../src/ids.js";
import { ApiClient, startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, type TestComputer } from "./helpers/fixtures.js";

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
  readonly userId: UserId;
  readonly client: ApiClient;
  readonly computer: TestComputer;
  readonly groupId: GroupId;
  readonly botId: BotId;
};

/** 注册时自带的主助理的单聊群，首页的输入框发到这里。 */
async function assistantGroupOf(client: ApiClient): Promise<GroupId> {
  const list = BotListResponse.parse(await (await client.get("/api/bots")).json());
  const assistant = list.items.find((item) => item.bot.role === "assistant");
  if (assistant === undefined) throw new Error("注册后应当已有主助理");
  return assistant.groupId;
}

async function ownerWithBot(name = "小服"): Promise<Owner> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name })).json());
  return { userId: user.id, client, computer, groupId: created.group.id, botId: created.bot.id };
}

const post = (title: string, text: string) => ({ kind: "post" as const, title, text, images: [], github: null });

async function createAccount(owner: Owner, login: "none" | "valid" | "expired" = "valid"): Promise<string> {
  const accountId = newId();
  await database.db.insert(accounts).values({
    id: accountId,
    ownerId: owner.userId,
    computerId: owner.computer.computerId,
    platform: "x",
    handle: `@${accountId}`,
    login,
    tier: "confirm_publish",
  });
  return accountId;
}

async function seedFourColumns(owner: Owner): Promise<{ readonly nestedDraftId: string }> {
  const now = Date.now();
  const accountId = newId();
  await database.db.insert(accounts).values({
    id: accountId,
    ownerId: owner.userId,
    computerId: owner.computer.computerId,
    platform: "x",
    handle: "@today",
    login: "expired",
    tier: "confirm_publish",
    createdAt: new Date(now - 60_000),
    loginChangedAt: new Date(now - 8_000),
  });

  const pendingPlanId = newId();
  await database.db.insert(contentPlans).values({
    id: pendingPlanId,
    ownerId: owner.userId,
    groupId: owner.groupId,
    botId: owner.botId,
    title: "等确认的内容计划",
    status: "pending",
    createdAt: new Date(now - 7_000),
  });
  const nestedDraftId = newId();
  await database.db.insert(drafts).values({
    id: nestedDraftId,
    ownerId: owner.userId,
    groupId: owner.groupId,
    botId: owner.botId,
    planId: pendingPlanId,
    accountId,
    platform: "x",
    content: post("计划内稿子", "只随计划出现"),
    contentHash: "nested",
    status: "pending",
    createdAt: new Date(now - 6_500),
  });
  const standaloneDraftId = newId();
  await database.db.insert(drafts).values({
    id: standaloneDraftId,
    ownerId: owner.userId,
    groupId: owner.groupId,
    botId: owner.botId,
    planId: null,
    accountId,
    platform: "x",
    content: post("单独待确认的稿子", "这一条自己出现"),
    contentHash: "standalone",
    status: "pending",
    createdAt: new Date(now - 6_000),
  });

  const approvedPlanId = newId();
  await database.db.insert(contentPlans).values({
    id: approvedPlanId,
    ownerId: owner.userId,
    groupId: owner.groupId,
    botId: owner.botId,
    title: "客户周报",
    status: "approved",
    createdAt: new Date(now - 5_000),
    decidedAt: new Date(now - 3_000),
  });
  const publishedDraftId = newId();
  const scheduledDraftId = newId();
  await database.db.insert(drafts).values([
    {
      id: publishedDraftId,
      ownerId: owner.userId,
      groupId: owner.groupId,
      botId: owner.botId,
      planId: approvedPlanId,
      accountId,
      platform: "x",
      content: post("已经发布的客户周报", "发布正文"),
      contentHash: "published",
      status: "published",
      createdAt: new Date(now - 4_500),
      decidedAt: new Date(now - 4_000),
    },
    {
      id: scheduledDraftId,
      ownerId: owner.userId,
      groupId: owner.groupId,
      botId: owner.botId,
      planId: approvedPlanId,
      accountId,
      platform: "x",
      content: post("两小时后发布", "排期正文"),
      contentHash: "scheduled",
      status: "approved",
      scheduledAt: new Date(now + 2 * 60 * 60_000),
      createdAt: new Date(now - 4_000),
      decidedAt: new Date(now - 3_500),
    },
  ]);
  await database.db.insert(publications).values({
    id: newId(),
    ownerId: owner.userId,
    draftId: publishedDraftId,
    groupId: owner.groupId,
    accountId,
    platform: "x",
    url: "https://example.com/customer-weekly",
    externalId: "pub-today",
    publishedAt: new Date(now - 4_000),
  });

  const routineId = newId();
  await database.db.insert(routines).values({
    id: routineId,
    botId: owner.botId,
    groupId: owner.groupId,
    name: "每分钟检查新工单",
    instruction: "检查新工单",
    triggers: [{ kind: "cron", expr: "* * * * *", lastFiredAt: new Date(now - 60_000).toISOString() }],
    onFailure: "stop_and_tell",
    purpose: "fast",
    enabled: true,
    createdAt: new Date(now - 3_000),
  });
  await database.db.insert(routineRuns).values({
    id: newId(),
    routineId,
    startedAt: new Date(now - 2_000),
    status: "ok",
    note: "处理了 3 条工单",
  });

  const triggerMessageId = newId();
  const runId = newId();
  const approvalId = ApprovalId.parse(newId());
  const approvalMessageId = newId();
  await database.db.insert(messages).values([
    {
      id: triggerMessageId,
      groupId: owner.groupId,
      body: { kind: "user" as const, text: "退款" },
      createdAt: new Date(now - 1_500),
    },
    {
      id: approvalMessageId,
      groupId: owner.groupId,
      body: { kind: "approval" as const, approvalId },
      createdAt: new Date(now - 1_000),
    },
  ]);
  await database.db.insert(runs).values({
    id: runId,
    ownerId: owner.userId,
    computerId: owner.computer.computerId,
    botId: owner.botId,
    groupId: owner.groupId,
    triggerMessageId,
    startedAt: new Date(now - 1_500),
  });
  await database.db.insert(approvals).values({
    id: approvalId,
    runId,
    botId: owner.botId,
    groupId: owner.groupId,
    callId: "refund-1",
    tool: "shop.refund",
    action: "spend",
    target: null,
    view: { kind: "mcp", server: "shop", tool: "refund", params: [], raw: "退款" },
    messageId: approvalMessageId,
    createdAt: new Date(now - 1_000),
  });
  return { nestedDraftId };
}

describe("GET /api/today", () => {
  it("四栏各有数据，按服务端顺序返回，计划内稿子不单独出现", async () => {
    const owner = await ownerWithBot();
    const seeded = await seedFourColumns(owner);

    const response = await owner.client.get("/api/today");
    expect(response.status).toBe(200);
    const today = TodayResponse.parse(await response.json());

    expect(today.assistantGroupId).toBe(await assistantGroupOf(owner.client));
    expect(today.pending.map((item) => item.kind)).toEqual(["account", "plan", "draft", "approval"]);
    const plan = today.pending.find((item) => item.kind === "plan");
    expect(plan?.kind === "plan" ? plan.drafts.map((draft) => draft.id) : []).toEqual([seeded.nestedDraftId]);
    expect(
      today.pending.some((item) => item.kind === "draft" && item.draft.id === seeded.nestedDraftId),
      "挂在待批计划下的稿子不能再单独占一项",
    ).toBe(false);
    expect(today.done.map((item) => item.kind)).toEqual(["routine", "plan_approved", "publication"]);
    expect(today.done.find((item) => item.kind === "publication")).toMatchObject({
      title: "已经发布的客户周报",
      url: "https://example.com/customer-weekly",
    });
    expect(today.running).toEqual([{ groupId: owner.groupId, title: "客户周报", published: 1, planned: 2 }]);
    expect(today.next.map((item) => item.kind)).toEqual(["routine", "draft"]);
  });

  it("四栏都没有数据", async () => {
    const user = await makeUser(database.db);
    const client = server.client();
    expect((await client.login(user.email, PASSWORD)).status).toBe(200);

    expect(TodayResponse.parse(await (await client.get("/api/today")).json())).toEqual({
      assistantGroupId: await assistantGroupOf(client),
      pending: [],
      done: [],
      running: [],
      next: [],
    });
  });

  it("不返回别人的数据", async () => {
    const mine = await ownerWithBot("我的 Bot");
    const other = await ownerWithBot("别人的 Bot");
    await seedFourColumns(other);

    expect(TodayResponse.parse(await (await mine.client.get("/api/today")).json())).toEqual({
      assistantGroupId: await assistantGroupOf(mine.client),
      pending: [],
      done: [],
      running: [],
      next: [],
    });
  });

  it("同一个群的 approved 计划只显示 decidedAt 最新的一份", async () => {
    const owner = await ownerWithBot();
    const accountId = await createAccount(owner);
    const olderPlanId = newId();
    const newerPlanId = newId();
    await database.db.insert(contentPlans).values([
      {
        id: olderPlanId,
        ownerId: owner.userId,
        groupId: owner.groupId,
        botId: owner.botId,
        title: "旧计划",
        status: "approved",
        createdAt: new Date(1_000),
        decidedAt: new Date(2_000),
      },
      {
        id: newerPlanId,
        ownerId: owner.userId,
        groupId: owner.groupId,
        botId: owner.botId,
        title: "新计划",
        status: "approved",
        createdAt: new Date(3_000),
        decidedAt: new Date(4_000),
      },
    ]);
    await database.db.insert(drafts).values([
      {
        id: newId(),
        ownerId: owner.userId,
        groupId: owner.groupId,
        botId: owner.botId,
        planId: olderPlanId,
        accountId,
        platform: "x",
        content: post("旧计划稿子", "旧计划正文"),
        contentHash: "older-running",
        status: "approved",
        createdAt: new Date(1_500),
      },
      {
        id: newId(),
        ownerId: owner.userId,
        groupId: owner.groupId,
        botId: owner.botId,
        planId: newerPlanId,
        accountId,
        platform: "x",
        content: post("新计划稿子", "新计划正文"),
        contentHash: "newer-running",
        status: "approved",
        createdAt: new Date(3_500),
      },
    ]);

    const today = TodayResponse.parse(await (await owner.client.get("/api/today")).json());
    expect(today.running).toEqual([{ groupId: owner.groupId, title: "新计划", published: 0, planned: 1 }]);
  });

  it("approved 计划的稿子全部发布后不再显示在进行中", async () => {
    const owner = await ownerWithBot();
    const accountId = await createAccount(owner);
    const planId = newId();
    await database.db.insert(contentPlans).values({
      id: planId,
      ownerId: owner.userId,
      groupId: owner.groupId,
      botId: owner.botId,
      title: "已完成计划",
      status: "approved",
      createdAt: new Date(1_000),
      decidedAt: new Date(2_000),
    });
    await database.db.insert(drafts).values({
      id: newId(),
      ownerId: owner.userId,
      groupId: owner.groupId,
      botId: owner.botId,
      planId,
      accountId,
      platform: "x",
      content: post("已发布稿子", "已发布正文"),
      contentHash: "all-published",
      status: "published",
      createdAt: new Date(1_500),
    });

    const today = TodayResponse.parse(await (await owner.client.get("/api/today")).json());
    expect(today.running).toEqual([]);
  });

  it("pending 超过 50 条时保留最新 50 条且仍按 since 升序", async () => {
    const owner = await ownerWithBot();
    const accountId = await createAccount(owner);
    const draftIds: string[] = [];
    for (let index = 0; index < 51; index += 1) {
      const draftId = newId();
      draftIds.push(draftId);
      await database.db.insert(drafts).values({
        id: draftId,
        ownerId: owner.userId,
        groupId: owner.groupId,
        botId: owner.botId,
        planId: null,
        accountId,
        platform: "x",
        content: post(`待确认稿子 ${index}`, `待确认正文 ${index}`),
        contentHash: `pending-${index}`,
        status: "pending",
        createdAt: new Date(10_000 + index * 1_000),
      });
    }

    const today = TodayResponse.parse(await (await owner.client.get("/api/today")).json());
    expect(today.pending).toHaveLength(50);
    expect(today.pending.every((item) => item.kind === "draft")).toBe(true);
    expect(today.pending.map((item) => (item.kind === "draft" ? item.draft.id : null))).toEqual(draftIds.slice(1));
    expect(today.pending.map((item) => item.since)).toEqual(today.pending.map((item) => item.since).toSorted());
  });

  it("已退回计划及其历史稿子不污染 today，独立 approved 稿子仍会出现", async () => {
    const owner = await ownerWithBot();
    const accountId = await createAccount(owner);
    const returnedPlanId = newId();
    await database.db.insert(contentPlans).values({
      id: returnedPlanId,
      ownerId: owner.userId,
      groupId: owner.groupId,
      botId: owner.botId,
      title: "历史计划",
      status: "returned",
      createdAt: new Date(1_000),
      decidedAt: new Date(2_000),
    });
    await database.db.insert(drafts).values([
      {
        id: newId(),
        ownerId: owner.userId,
        groupId: owner.groupId,
        botId: owner.botId,
        planId: returnedPlanId,
        accountId,
        platform: "x",
        content: post("历史稿子", "历史正文"),
        contentHash: "returned-plan-draft",
        status: "approved",
        scheduledAt: new Date(10_000),
        createdAt: new Date(1_500),
      },
      {
        id: newId(),
        ownerId: owner.userId,
        groupId: owner.groupId,
        botId: owner.botId,
        planId: null,
        accountId,
        platform: "x",
        content: post("独立稿子", "独立正文"),
        contentHash: "standalone-approved",
        status: "approved",
        scheduledAt: new Date(20_000),
        createdAt: new Date(3_000),
      },
    ]);

    const today = TodayResponse.parse(await (await owner.client.get("/api/today")).json());
    expect(today.running).toEqual([]);
    expect(today.done.filter((item) => item.kind === "plan_approved")).toEqual([]);
    expect(today.next).toHaveLength(1);
    expect(today.next[0]?.kind === "draft" ? today.next[0].draft.planId : null).toBeNull();
  });

  it("没发过的草稿 failure 是 null", async () => {
    const owner = await ownerWithBot();
    const accountId = await createAccount(owner);
    const draftId = newId();
    await database.db.insert(drafts).values({
      id: draftId,
      ownerId: owner.userId,
      groupId: owner.groupId,
      botId: owner.botId,
      accountId,
      platform: "x",
      content: post("刚起的稿子", "还没发过"),
      contentHash: "fresh",
    });

    const retryId = newId();
    await database.db.insert(drafts).values({
      id: retryId,
      ownerId: owner.userId,
      groupId: owner.groupId,
      botId: owner.botId,
      accountId,
      platform: "x",
      content: post("上次没发出去", "排了下一次"),
      contentHash: "retry",
      status: "approved",
      scheduledAt: new Date(Date.now() + 60 * 60_000),
      failure: "login_expired",
    });

    const today = TodayResponse.parse(await (await owner.client.get("/api/today")).json());
    const pending = today.pending.find((item) => item.kind === "draft" && item.draft.id === draftId);
    expect(pending?.kind === "draft" ? pending.draft.failure : undefined, "只有发布失败才写原因").toBeNull();
    const next = today.next.find((item) => item.kind === "draft" && item.draft.id === retryId);
    expect(next?.kind === "draft" ? next.draft.failure : undefined, "上次失败的原因原样读回").toBe("login_expired");
  });

  it("无标题的推文正文开头带 emoji，做成的一栏照样出来，标题按码元截到 80 且不劈开 emoji", async () => {
    const owner = await ownerWithBot();
    const accountId = await createAccount(owner);
    const text = "🎉" + "白泽今天开源了".repeat(12);
    const draftId = newId();
    await database.db.insert(drafts).values({
      id: draftId,
      ownerId: owner.userId,
      groupId: owner.groupId,
      botId: owner.botId,
      accountId,
      platform: "x",
      content: { kind: "post", title: null, text, images: [], github: null },
      contentHash: draftId,
      status: "published",
    });
    await database.db.insert(publications).values({
      id: newId(),
      ownerId: owner.userId,
      draftId,
      groupId: owner.groupId,
      accountId,
      platform: "x",
      url: "https://x.com/baize/status/85",
      publishedAt: new Date(),
    });

    const response = await owner.client.get("/api/today");
    expect(response.status, "85 个码点、86 个码元的正文不能让首页 500").toBe(200);
    const today = TodayResponse.parse(await response.json());
    const done = today.done.find((item) => item.kind === "publication");
    expect(done?.title, "emoji 占两个码元，截到 80 个码元").toBe(text.slice(0, 80));
    expect(done?.title.length).toBe(80);
  });

  it("旧的 overnight 接口已经删除", async () => {
    const owner = await ownerWithBot();
    expect((await owner.client.get("/api/overnight")).status).toBe(404);
  });
});
