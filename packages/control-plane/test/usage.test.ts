import {
  CreateBotResponse,
  OvernightResponse,
  UsageResponse,
  type BotId,
  type GroupId,
  type UserId,
} from "@baize/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvals, handoffs, messages, routineRuns, routines, runs, users } from "../src/db/schema.js";
import { newId } from "../src/ids.js";
import { weekStart } from "../src/repo/usage.js";
import { startTestServer, type ApiClient, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeUser, waitFor } from "./helpers/fixtures.js";
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

async function signedIn(): Promise<{ client: ApiClient; ownerId: UserId }> {
  const user = await makeUser(database.db);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  return { client, ownerId: user.id };
}

async function bot(client: ApiClient, name: string) {
  const response = await client.post("/api/bots", { name });
  expect(response.status).toBe(201);
  return CreateBotResponse.parse(await response.json());
}

function run(ownerId: UserId, botId: string, groupId: string, startedAt: Date, amount: string) {
  return { id: newId(), ownerId, botId, groupId, startedAt, endedAt: startedAt, amount };
}

describe("本周起点", () => {
  it("上海周一 00:00 前一秒仍属上周", () => {
    expect(weekStart(new Date("2026-09-20T15:59:59.000Z")).toISOString()).toBe("2026-09-13T16:00:00.000Z");
  });

  it("上海周一 00:00 与后一秒均属新周", () => {
    expect(weekStart(new Date("2026-09-20T16:00:00.000Z")).toISOString()).toBe("2026-09-20T16:00:00.000Z");
    expect(weekStart(new Date("2026-09-20T16:00:01.000Z")).toISOString()).toBe("2026-09-20T16:00:00.000Z");
  });

  it("上海周日晚最后一秒仍属这一周", () => {
    expect(weekStart(new Date("2026-09-20T15:59:59.999Z")).toISOString()).toBe("2026-09-13T16:00:00.000Z");
  });
});

describe("GET /api/usage", () => {
  it("零花费 Bot 仍列出，上周 run 只进 recent，最近任务有标题", async () => {
    const { client, ownerId } = await signedIn();
    const [a, b, zero] = await Promise.all([bot(client, "小采"), bot(client, "小服"), bot(client, "小销")]);
    const start = weekStart(new Date());
    const current = new Date(Math.max(start.getTime(), Date.now() - 60_000));
    const previous = new Date(start.getTime() - 1);
    const userMessageId = newId();
    await database.db.insert(messages).values({
      id: userMessageId,
      groupId: a.group.id,
      createdAt: current,
      body: { kind: "user", text: "查一下供应商的交期，然后整理采购对照表" },
    });
    await database.db
      .insert(runs)
      .values([
        { ...run(ownerId, a.bot.id, a.group.id, current, "2.500000"), triggerMessageId: userMessageId },
        run(ownerId, b.bot.id, b.group.id, current, "1.250000"),
        run(ownerId, b.bot.id, b.group.id, previous, "9.000000"),
      ]);
    const other = await signedIn();
    const outsider = await bot(other.client, "别人的");
    await database.db.insert(runs).values(run(other.ownerId, outsider.bot.id, outsider.group.id, current, "99.000000"));

    const response = await client.get("/api/usage");
    expect(response.status).toBe(200);
    const usage = UsageResponse.parse(await response.json());
    expect(usage.weekStartsAt).toBe(start.toISOString());
    expect(usage.bots).toEqual([
      { botId: a.bot.id, amount: 2.5, runs: 1 },
      { botId: b.bot.id, amount: 1.25, runs: 1 },
      { botId: zero.bot.id, amount: 0, runs: 0 },
    ]);
    expect(usage.total).toBe(usage.bots.reduce((sum, row) => sum + row.amount, 0));
    expect(usage.recent).toHaveLength(3);
    expect(usage.recent.find((item) => item.title === "查一下供应商的交期，然后整理采购对照表")?.amount).toBe(2.5);
    expect(usage.recent.find((item) => item.amount === 1.25)?.title).toBe("小服");
    expect(usage.recent.find((item) => item.amount === 9)?.startedAt).toBe(previous.toISOString());
  });

  it("已删 Bot 的 run 留在 total 和 recent，不伪造 Bot 分列", async () => {
    const { client, ownerId } = await signedIn();
    const deleted = await bot(client, "短暂存在");
    await database.db.insert(runs).values(run(ownerId, deleted.bot.id, deleted.group.id, new Date(), "3.000000"));
    expect((await client.delete(`/api/bots/${deleted.bot.id}`)).status).toBe(204);

    const usage = UsageResponse.parse(await (await client.get("/api/usage")).json());
    expect(usage.total).toBe(3);
    expect(usage.bots).toEqual([]);
    expect(usage.recent).toMatchObject([{ botId: null, groupId: null, amount: 3 }]);
  });

  it("例行任务名称随当前记录显示，删除后仍识别为例行任务", async () => {
    const { client, ownerId } = await signedIn();
    const created = await bot(client, "小服");
    const routineId = newId();
    const routineRunId = newId();
    const startedAt = new Date();
    await database.db.insert(routines).values({
      id: routineId,
      botId: created.bot.id,
      name: "每日汇报",
      instruction: "汇总",
      triggers: [],
    });
    await database.db.insert(routineRuns).values({ id: routineRunId, routineId, startedAt });
    await database.db.insert(runs).values({
      ...run(ownerId, created.bot.id, created.group.id, startedAt, "0.250000"),
      routineRunId,
      isRoutine: true,
    });
    expect(UsageResponse.parse(await (await client.get("/api/usage")).json()).recent[0]?.title).toBe("例行 · 每日汇报");
    await database.db.delete(routines).where(eq(routines.id, routineId));
    expect(UsageResponse.parse(await (await client.get("/api/usage")).json()).recent[0]?.title).toBe("例行任务");
  });
});

describe("GET /api/overnight", () => {
  it("从未断开或只断开十分钟，都不返回进展", async () => {
    const { client, ownerId } = await signedIn();
    expect(OvernightResponse.parse(await (await client.get("/api/overnight")).json())).toEqual({
      since: null,
      items: [],
    });
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
    await database.db.update(users).set({ lastSeenAt: tenMinutesAgo }).where(eq(users.id, ownerId));
    expect(OvernightResponse.parse(await (await client.get("/api/overnight")).json())).toEqual({
      since: tenMinutesAgo.toISOString(),
      items: [],
    });
  });

  it("每个 Bot 只取断开后最新一句，审批优先于运行，再按时间排序", async () => {
    const { client, ownerId } = await signedIn();
    const [waiting, working, done] = await Promise.all([bot(client, "小服"), bot(client, "小销"), bot(client, "小采")]);
    const since = new Date(Date.now() - 12 * 3_600_000);
    await database.db.update(users).set({ lastSeenAt: since }).where(eq(users.id, ownerId));
    const at = (minute: number) => new Date(since.getTime() + minute * 60_000);
    const botMessage = (groupId: GroupId, botId: BotId, text: string, minute: number, streaming = false) => ({
      id: newId(),
      groupId,
      createdAt: at(minute),
      body: { kind: "bot" as const, botId, text, streaming },
    });
    await database.db
      .insert(messages)
      .values([
        botMessage(waiting.group.id, waiting.bot.id, "旧进度", 10),
        botMessage(waiting.group.id, waiting.bot.id, "请你审批采购单", 20),
        botMessage(working.group.id, working.bot.id, "正在梳理", 30),
        botMessage(done.group.id, done.bot.id, "已整理完成", 40),
        botMessage(done.group.id, done.bot.id, "尚未完结的流", 45, true),
        botMessage(done.group.id, done.bot.id, "", 50),
        botMessage(done.group.id, done.bot.id, "断开前", -1),
      ]);
    const waitingRun = run(ownerId, waiting.bot.id, waiting.group.id, at(15), "0");
    const workingRun = { ...run(ownerId, working.bot.id, working.group.id, at(25), "0"), endedAt: null };
    await database.db.insert(runs).values([{ ...waitingRun, endedAt: null }, workingRun]);
    const approvalMessageId = newId();
    await database.db.insert(messages).values({
      id: approvalMessageId,
      groupId: waiting.group.id,
      createdAt: at(21),
      body: { kind: "system", text: "审批卡" },
    });
    await database.db.insert(approvals).values({
      id: newId(),
      runId: waitingRun.id,
      botId: waiting.bot.id,
      groupId: waiting.group.id,
      callId: "approval-1",
      tool: "pay",
      action: "spend",
      target: null,
      view: { kind: "mcp", server: "采购系统", tool: "pay", params: [] },
      messageId: approvalMessageId,
    });

    const response = await client.get("/api/overnight");
    expect(response.status).toBe(200);
    const overnight = OvernightResponse.parse(await response.json());
    expect(overnight.since).toBe(since.toISOString());
    expect(overnight.items.map(({ botId, text, status }) => ({ botId, text, status }))).toEqual([
      { botId: done.bot.id, text: "已整理完成", status: "done" },
      { botId: working.bot.id, text: "正在梳理", status: "working" },
      { botId: waiting.bot.id, text: "请你审批采购单", status: "waiting" },
    ]);

    const handoffMessageId = newId();
    await database.db.insert(messages).values({
      id: handoffMessageId,
      groupId: done.group.id,
      createdAt: at(41),
      body: { kind: "system", text: "交接卡" },
    });
    await database.db.insert(handoffs).values({
      id: newId(),
      groupId: done.group.id,
      fromBotId: done.bot.id,
      toBotId: working.bot.id,
      done: "已整理",
      notDone: "待确认",
      next: "接手",
      messageId: handoffMessageId,
    });
    const withHandoff = OvernightResponse.parse(await (await client.get("/api/overnight")).json());
    expect(withHandoff.items[0]?.status, "待确认交接把该 Bot 置为等你").toBe("waiting");
    await database.db.insert(messages).values(botMessage(done.group.id, done.bot.id, "进".repeat(201), 55));
    const truncated = OvernightResponse.parse(await (await client.get("/api/overnight")).json());
    expect(truncated.items[0]?.text).toBe("进".repeat(200));
  });

  it("推送连接关闭后更新 last_seen_at", async () => {
    const { client, ownerId } = await signedIn();
    const push = await connectPush(server.server.port, client.cookie ?? "");
    push.close();
    await waitFor(async () => {
      const [row] = await database.db.select({ at: users.lastSeenAt }).from(users).where(eq(users.id, ownerId));
      return row?.at instanceof Date;
    }, "断开时间落库");
    const result = OvernightResponse.parse(await (await client.get("/api/overnight")).json());
    expect(result.since).not.toBeNull();
    expect(result.items).toEqual([]);
  });
});
