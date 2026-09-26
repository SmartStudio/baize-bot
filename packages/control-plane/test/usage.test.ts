import { BotListResponse, CreateBotResponse, UsageResponse, type BotId, type UserId } from "@baize/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { messages, routineRuns, routines, runs } from "../src/db/schema.js";
import { newId } from "../src/ids.js";
import { weekStart } from "../src/repo/usage.js";
import { startTestServer, type ApiClient, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeUser } from "./helpers/fixtures.js";

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

async function assistantOf(client: ApiClient): Promise<BotId> {
  const list = BotListResponse.parse(await (await client.get("/api/bots")).json());
  const assistant = list.items.find((item) => item.bot.role === "assistant");
  if (assistant === undefined) throw new Error("注册后应当已有主助理");
  return assistant.bot.id;
}

type BotUsage = { readonly botId: string };
const byBotId = (left: BotUsage, right: BotUsage): number => left.botId.localeCompare(right.botId);

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
    expect(usage.bots.slice(0, 2), "花了钱的按金额从高到低").toEqual([
      { botId: a.bot.id, amount: 2.5, runs: 1 },
      { botId: b.bot.id, amount: 1.25, runs: 1 },
    ]);
    expect(usage.bots.slice(2).toSorted(byBotId), "零花费的也列出，主助理没跑过也在").toEqual(
      [
        { botId: zero.bot.id, amount: 0, runs: 0 },
        { botId: await assistantOf(client), amount: 0, runs: 0 },
      ].toSorted(byBotId),
    );
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
    expect(usage.bots, "分列里只剩主助理，没有已删的那个").toEqual([
      { botId: await assistantOf(client), amount: 0, runs: 0 },
    ]);
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
