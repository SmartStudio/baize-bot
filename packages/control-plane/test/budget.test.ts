import { randomUUID } from "node:crypto";
import {
  CreateBotResponse,
  RoutineResponse,
  Settings,
  UsageResponse,
  type BotId,
  type CreateRoutineRequest,
  type GroupId,
  type Routine,
  type ServerPush,
  type UserId,
} from "@baize/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newId } from "../src/ids.js";
import { runs } from "../src/db/schema.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { startTestServer, type ApiClient, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, type TestComputer } from "./helpers/fixtures.js";
import { connectPush, type PushClient } from "./helpers/ws.js";

let database: TestDb;
let server: TestServer;
/** 调度器和通知共用的时钟。取真实时间：run_done 记下的 run 按真实时间落在本月。 */
let clock = new Date();

beforeAll(async () => {
  database = await createTestDb();
  server = await startTestServer(
    database.db,
    // 一次 1000 个输入 token 收 ¥0.80，预算 ¥1 时一次正好用到 80%。
    { priceInputPerM: 800, priceOutputPerM: 0 },
    { now: () => clock, intervalMs: 60 * 60 * 1000 },
    { now: () => clock, intervalMs: 60 * 60 * 1000 },
  );
});

beforeEach(() => {
  clock = new Date();
});

afterAll(async () => {
  await server.close();
  await database.close();
});

const OVER_BUDGET_NOTE = "本月超预算，没跑";

type Owner = {
  readonly userId: UserId;
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
  return { userId: user.id, client, computer, groupId: created.group.id, botId: created.bot.id };
}

async function online(owner: Owner): Promise<AgentClient> {
  const { agent } = await helloAgent(server.server.port, owner.computer.computerId, owner.computer.token);
  return agent;
}

async function setBudget(owner: Owner, budget: number | null): Promise<void> {
  const response = await owner.client.patch("/api/settings", { budget });
  expect(response.status).toBe(200);
  expect(Settings.parse(await response.json()).budget).toBe(budget);
}

/** 本月已经花掉的钱，直接落一条已结束的 run。 */
async function spent(owner: Owner, amount: string): Promise<void> {
  await database.db.insert(runs).values({
    id: newId(),
    ownerId: owner.userId,
    botId: owner.botId,
    groupId: owner.groupId,
    startedAt: clock,
    endedAt: clock,
    amount,
  });
}

async function makeRoutine(owner: Owner, input: Partial<CreateRoutineRequest> = {}): Promise<Routine> {
  const response = await owner.client.post(`/api/bots/${owner.botId}/routines`, {
    name: "每日工单早报",
    instruction: "把今天的工单汇总一下",
    triggers: [{ kind: "cron", expr: "* * * * *" }],
    onFailure: "stop_and_tell",
    ...input,
  });
  expect(response.status).toBe(201);
  return RoutineResponse.parse(await response.json()).routine;
}

type RunRow = { status: string; note: string };

async function routineRunsOf(routineId: string): Promise<RunRow[]> {
  return database.sql<RunRow[]>`
    SELECT status, note FROM routine_runs WHERE routine_id = ${routineId} ORDER BY started_at ASC, id ASC
  `;
}

async function runCount(owner: Owner): Promise<number> {
  const rows = await database.sql<
    { n: number }[]
  >`SELECT count(*)::int AS n FROM runs WHERE owner_id = ${owner.userId}`;
  return rows[0]?.n ?? 0;
}

async function stateOf(routineId: string): Promise<string | undefined> {
  const rows = await database.sql<{ state: string }[]>`SELECT state FROM routines WHERE id = ${routineId}`;
  return rows[0]?.state;
}

async function usageOf(owner: Owner): Promise<UsageResponse> {
  return UsageResponse.parse(await (await owner.client.get("/api/usage")).json());
}

/** 电脑不在线，试跑当场记 failed：一次就是一条已结束、没人看过的真跑。超预算不挡试跑。 */
async function failedTrial(owner: Owner, routineId: string): Promise<void> {
  expect((await owner.client.post(`/api/routines/${routineId}/run`)).status).toBe(202);
}

/** 新建的例行第一遍扫只对齐游标，再推一分钟扫一遍才到点。 */
async function fireOnce(): Promise<void> {
  await server.server.routines.tick();
  clock = new Date(clock.getTime() + 61_000);
  await server.server.routines.tick();
}

describe("超预算停例行", () => {
  it("超预算后例行到点记 stopped 不派活", async () => {
    const owner = await ownerWithBot();
    const agent = await online(owner);
    try {
      await setBudget(owner, 1);
      await spent(owner, "1.000000");
      const routine = await makeRoutine(owner);

      await fireOnce();

      expect(await routineRunsOf(routine.id), "到点了，但花费刚好等于预算就算超").toEqual([
        { status: "stopped", note: OVER_BUDGET_NOTE },
      ]);
      expect(await runCount(owner), "没派活，只有事先花掉的那一条 run").toBe(1);
      expect(await stateOf(routine.id), "不改例行状态").toBe("on");
      const usage = await usageOf(owner);
      expect(usage.budget).toBe(1);
      expect(usage.total, "没跑的那次不记账").toBe(1);

      await setBudget(owner, 5);
      clock = new Date(clock.getTime() + 61_000);
      await server.server.routines.tick();
      expect((await agent.expect("prompt")).text, "调高预算后下一分钟照常派活").toBe("把今天的工单汇总一下");
      expect((await routineRunsOf(routine.id)).map((run) => run.status)).toEqual(["stopped", "running"]);
    } finally {
      agent.close();
    }
  });

  it("超预算时 webhook 也不派活，同样记 stopped", async () => {
    const owner = await ownerWithBot();
    await setBudget(owner, 1);
    await spent(owner, "3.000000");
    const routine = await makeRoutine(owner, { triggers: [{ kind: "webhook" }] });
    const trigger = routine.triggers.find((one) => one.kind === "webhook");
    if (trigger?.kind !== "webhook") throw new Error("这条例行任务没有 webhook 触发器");

    expect((await server.client().post(`/api/hooks/${trigger.token}`)).status).toBe(202);
    expect(await routineRunsOf(routine.id)).toEqual([{ status: "stopped", note: OVER_BUDGET_NOTE }]);
    expect(await runCount(owner)).toBe(1);
  });

  it("超预算跳过的记录不算进三次没人看", async () => {
    const between = await ownerWithBot();
    await setBudget(between, 1);
    await spent(between, "1.000000");
    const kept = await makeRoutine(between);
    await failedTrial(between, kept.id);
    await fireOnce();
    clock = new Date(clock.getTime() + 61_000);
    await server.server.routines.tick();
    await failedTrial(between, kept.id);
    expect((await routineRunsOf(kept.id)).map((run) => run.status).toSorted()).toEqual([
      "failed",
      "failed",
      "stopped",
      "stopped",
    ]);
    expect(await stateOf(kept.id), "只有两次真跑没人看，中间夹着的超预算跳过不凑数").toBe("on");

    const three = await ownerWithBot();
    await setBudget(three, 1);
    await spent(three, "1.000000");
    const paused = await makeRoutine(three);
    await failedTrial(three, paused.id);
    await failedTrial(three, paused.id);
    await fireOnce();
    clock = new Date(clock.getTime() + 61_000);
    await server.server.routines.tick();
    expect(await stateOf(paused.id), "超预算跳过本身不改例行状态").toBe("on");
    await failedTrial(three, paused.id);
    expect(await stateOf(paused.id), "三次真跑都没人看，跳过的记录不打断连续计数").toBe("auto_paused");
  });

  it("超预算时试跑照常", async () => {
    const owner = await ownerWithBot();
    const agent = await online(owner);
    try {
      await setBudget(owner, 1);
      await spent(owner, "2.000000");
      const routine = await makeRoutine(owner, { triggers: [] });

      expect((await owner.client.post(`/api/routines/${routine.id}/run`)).status).toBe(202);
      expect((await agent.expect("prompt")).text).toBe("把今天的工单汇总一下");
      expect((await routineRunsOf(routine.id)).map((run) => run.status)).toEqual(["running"]);
    } finally {
      agent.close();
    }
  });

  it("没设预算时 budget 是 null 且从不停", async () => {
    const owner = await ownerWithBot();
    const agent = await online(owner);
    try {
      await spent(owner, "99999.000000");
      const routine = await makeRoutine(owner);
      expect(Settings.parse(await (await owner.client.get("/api/settings")).json()).budget).toBeNull();
      expect((await usageOf(owner)).budget).toBeNull();

      await fireOnce();

      expect((await agent.expect("prompt")).text).toBe("把今天的工单汇总一下");
      expect((await routineRunsOf(routine.id)).map((run) => run.status)).toEqual(["running"]);
    } finally {
      agent.close();
    }
  });
});

type Notice = Extract<ServerPush, { type: "notify" }>["notice"];

/** 用户在单聊里说一句，跑完报 1000 个输入 token，收 ¥0.80。 */
async function chargedRun(owner: Owner, agent: AgentClient): Promise<void> {
  expect((await owner.client.post(`/api/groups/${owner.groupId}/messages`, { text: "干活" })).status).toBe(201);
  const prompt = await agent.expect("prompt");
  agent.send({
    type: "run_done",
    runId: prompt.runId,
    botId: owner.botId,
    groupId: owner.groupId,
    steps: 1,
    inputTokens: 1000,
    outputTokens: 0,
  });
}

/**
 * 同一条电脑连接再报一条不带 runId 的错当标记：报文按到达顺序处理，前面 run_done 该推的 notify 都排在它前面。
 */
async function noticesBeforeMarker(owner: Owner, agent: AgentClient, push: PushClient): Promise<Notice[]> {
  const marker = `顺序标记 ${randomUUID()}`;
  agent.send({ type: "agent_error", code: "runner_failed", detail: marker, groupId: owner.groupId });
  const notices: Notice[] = [];
  for (;;) {
    const item = await push.next();
    if (item.type === "notify") notices.push(item.notice);
    if (item.type === "message" && item.message.body.kind === "system" && item.message.body.text.endsWith(marker)) {
      return notices;
    }
  }
}

describe("80% 提醒", () => {
  it("80% 提醒一个月只发一次", async () => {
    const owner = await ownerWithBot();
    const agent = await online(owner);
    const push = await connectPush(server.server.port, owner.client.cookie ?? "");
    try {
      await setBudget(owner, 1);

      await chargedRun(owner, agent);
      const first = await noticesBeforeMarker(owner, agent, push);
      expect(first, "¥0.80 正好是 ¥1 的 80%").toEqual([
        {
          kind: "stuck",
          text: "本月已花 ¥0.80，到了预算 ¥1 的 80%，超了预算例行任务就不自动跑了",
          groupId: null,
          at: expect.any(String),
        },
      ]);

      await chargedRun(owner, agent);
      expect(await noticesBeforeMarker(owner, agent, push), "这个月已经提醒过，再花也不发").toEqual([]);

      const [row] = await database.sql<{ month: string | null }[]>`
        SELECT budget_alerted_month AS month FROM settings WHERE user_id = ${owner.userId}
      `;
      expect(row?.month, "记的是上海时区的本月").toMatch(/^\d{4}-\d{2}$/);
    } finally {
      push.close();
      agent.close();
    }
  });

  it("关着提醒时不发，也不占掉这个月", async () => {
    const owner = await ownerWithBot();
    const agent = await online(owner);
    const push = await connectPush(server.server.port, owner.client.cookie ?? "");
    try {
      await setBudget(owner, 1);
      expect((await owner.client.patch("/api/settings", { notify: false })).status).toBe(200);
      await chargedRun(owner, agent);
      expect(await noticesBeforeMarker(owner, agent, push)).toEqual([]);

      expect((await owner.client.patch("/api/settings", { notify: true })).status).toBe(200);
      await chargedRun(owner, agent);
      expect(
        (await noticesBeforeMarker(owner, agent, push)).map((notice) => notice.text),
        "打开提醒后下一次结账补上这个月的那一条，已经超了就直说超了",
      ).toEqual(["本月已花 ¥1.60，超过了预算 ¥1，例行任务先不自动跑了"]);
    } finally {
      push.close();
      agent.close();
    }
  });
});
