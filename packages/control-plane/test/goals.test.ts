import {
  BotListResponse,
  CreateBotResponse,
  CreateGroupResponse,
  DecideProjectOfferResponse,
  GroupResponse,
  TodayResponse,
  UpdateTaskResponse,
  type AgentToControl,
  type BotId,
  type ControlToAgent,
  type GroupId,
  type Message,
  type ServerPush,
  type TopicTask,
} from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { accounts, contentPlans, drafts, metricSamples } from "../src/db/schema.js";
import { newId } from "../src/ids.js";
import { weekStart } from "../src/repo/usage.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { ApiClient, startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser } from "./helpers/fixtures.js";
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
type OfferFields = Omit<ProjectOfferEvent, "type" | "runId" | "botId" | "groupId">;

const OFFER = {
  name: "推广白泽",
  goal: "白泽的开源仓库年底 1000 星",
  team: [{ name: "小内", tags: ["内容"], description: "写小红书笔记和 X 帖子" }],
  platforms: [{ kind: "supported", platform: "github" }],
  cadence: "每周小红书 2 篇",
  firstStep: "先把 README 改成一句话讲清楚白泽是什么",
} satisfies OfferFields;

type Session = {
  readonly client: ApiClient;
  readonly agent: AgentClient;
  readonly push: PushClient;
  readonly assistant: { readonly botId: BotId; readonly groupId: GroupId };
  readonly userId: string;
  readonly computerId: string;
  close(): void;
};

async function session(): Promise<Session> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const list = BotListResponse.parse(await (await client.get("/api/bots")).json()).items;
  const entry = list.find((item) => item.bot.role === "assistant");
  if (entry === undefined) throw new Error("注册后应当已有主助理");
  const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);
  const push = await connectPush(server.server.port, client.cookie ?? "");
  return {
    client,
    agent,
    push,
    assistant: { botId: entry.bot.id, groupId: entry.groupId },
    userId: user.id,
    computerId: computer.computerId,
    close: () => {
      agent.close();
      push.close();
    },
  };
}

async function nextOfType<T extends ServerPush["type"]>(push: PushClient, type: T) {
  for (let seen = 0; seen < 30; seen += 1) {
    const item = await push.next();
    if (item.type === type) return item as Extract<ServerPush, { type: T }>;
  }
  throw new Error(`等了 30 条推送都没有 ${type}`);
}

/** 跟主助理说一句，它出一张方案卡，这次活收尾。回的是推过来的那条卡。 */
async function offerCard(s: Session, fields: OfferFields): Promise<Message> {
  expect((await s.client.post(`/api/groups/${s.assistant.groupId}/messages`, { text: "推广白泽" })).status).toBe(201);
  // 前一个项目建出来的 Bot 会先换来一条 config，跳过去等这句话派出的 prompt。
  let next: ControlToAgent = await s.agent.next();
  while (next.type !== "prompt") next = await s.agent.next();
  const prompt: Prompt = next;
  s.agent.send({ type: "project_offer", runId: prompt.runId, botId: prompt.botId, groupId: prompt.groupId, ...fields });
  let card: Message | null = null;
  while (card === null) {
    const item = await nextOfType(s.push, "message");
    // 前一张卡开始后会重推一次，那张已经不是待定的了。
    if (item.message.body.kind === "project_offer" && item.message.body.status === "offered") card = item.message;
  }
  s.agent.send({
    type: "run_done",
    runId: prompt.runId,
    botId: prompt.botId,
    groupId: prompt.groupId,
    steps: 1,
    inputTokens: 0,
    outputTokens: 0,
  });
  for (;;) {
    const item = await nextOfType(s.push, "message");
    if (item.message.body.kind === "cost" && item.message.body.runId === prompt.runId) return card;
  }
}

async function startProject(s: Session, fields: OfferFields) {
  const card = await offerCard(s, fields);
  const response = await s.client.post(`/api/messages/${card.id}/project-offer`, { decision: "start" });
  expect(response.status).toBe(200);
  const started = DecideProjectOfferResponse.parse(await response.json());
  if (started.group === null || started.task === null) throw new Error("开始了却没回项目群和任务卡");
  return { card: started.message, group: started.group, task: started.task };
}

async function taskOf(client: ApiClient, groupId: string): Promise<TopicTask> {
  return GroupResponse.parse(await (await client.get(`/api/groups/${groupId}`)).json()).task;
}

async function reportMetric(client: ApiClient, groupId: string, value: number): Promise<TopicTask> {
  const response = await client.post(`/api/projects/${groupId}/metric`, { value });
  expect(response.status).toBe(200);
  return UpdateTaskResponse.parse(await response.json()).task;
}

describe("项目目标", () => {
  it("方案卡带目标开始后任务卡有 goal", async () => {
    const s = await session();
    try {
      const { card, group, task } = await startProject(s, { ...OFFER, goalTarget: 1000, goalUnit: "星" });
      expect(card.body, "卡正文留着目标两项").toMatchObject({ goalTarget: 1000, goalUnit: "星", status: "started" });
      const goal = { target: 1000, unit: "星", dueAt: null };
      expect(task.goal, "开始时回的任务卡就带目标").toEqual(goal);
      expect(task.metric, "还没有样本").toBeNull();
      expect((await taskOf(s.client, group.id)).goal, "重新读群也是这个目标").toEqual(goal);
    } finally {
      s.close();
    }
  });

  it("方案卡不带目标开始后 goal 是 null，进度退回清单", async () => {
    const s = await session();
    try {
      const { card, group, task } = await startProject(s, OFFER);
      expect(card.body, "没给目标的卡正文里没有目标两项").not.toHaveProperty("goalTarget");
      expect(task.goal).toBeNull();
      expect(task.metric).toBeNull();
      expect(
        task.checklist.map((item) => ({ text: item.text, done: item.done })),
        "进度只能按清单算，清单里是方案卡的第一步",
      ).toEqual([{ text: OFFER.firstStep, done: false }]);
      expect((await taskOf(s.client, group.id)).goal).toBeNull();
    } finally {
      s.close();
    }
  });

  it("只给目标数不给单位的方案卡不算有目标", async () => {
    const s = await session();
    try {
      const { card, task } = await startProject(s, { ...OFFER, goalTarget: 1000 });
      expect(card.body, "半个目标不落进卡正文").not.toHaveProperty("goalTarget");
      expect(task.goal).toBeNull();
    } finally {
      s.close();
    }
  });

  it("PATCH 任务卡能设目标、改截止、去掉目标，每次都推 task_updated", async () => {
    const s = await session();
    try {
      const { group, task } = await startProject(s, OFFER);
      const goal = { target: 500, unit: "篇", dueAt: "2030-12-31T16:00:00.000Z" };
      const set = await s.client.patch(`/api/tasks/${task.id}`, { goal });
      expect(set.status).toBe(200);
      expect(UpdateTaskResponse.parse(await set.json()).task.goal).toEqual(goal);
      expect((await nextOfType(s.push, "task_updated")).task.goal).toEqual(goal);
      expect((await taskOf(s.client, group.id)).goal).toEqual(goal);

      const cleared = await s.client.patch(`/api/tasks/${task.id}`, { goal: null });
      expect(UpdateTaskResponse.parse(await cleared.json()).task.goal).toBeNull();
      expect((await nextOfType(s.push, "task_updated")).task.goal).toBeNull();
      expect((await taskOf(s.client, group.id)).goal).toBeNull();
      const [columns] = await database.sql`select goal_target, goal_unit, goal_due_at from tasks where id = ${task.id}`;
      expect(columns, "三列一起清空，不留半个目标").toEqual({ goal_target: null, goal_unit: null, goal_due_at: null });

      const metricSource = { kind: "reported", platform: "xiaohongshu", label: "粉丝数" } as const;
      const sourced = await s.client.patch(`/api/tasks/${task.id}`, { metricSource });
      expect(UpdateTaskResponse.parse(await sourced.json()).task.metricSource).toEqual(metricSource);
      expect((await taskOf(s.client, group.id)).metricSource).toEqual(metricSource);
      await s.client.patch(`/api/tasks/${task.id}`, { metricSource: null });
      expect((await taskOf(s.client, group.id)).metricSource, "给 null 就是去掉").toBeNull();

      const bad = await s.client.patch(`/api/tasks/${task.id}`, { goal: { target: 0, unit: "星", dueAt: null } });
      expect(bad.status, "目标数要是正整数").toBe(400);
    } finally {
      s.close();
    }
  });
});

describe("手动记数", () => {
  it("手动记一个数后 task_updated 带 current", async () => {
    const s = await session();
    try {
      const { group } = await startProject(s, { ...OFFER, goalTarget: 1000, goalUnit: "星" });
      const task = await reportMetric(s.client, group.id, 412);
      expect(task.metric?.current).toBe(412);
      const pushed = await nextOfType(s.push, "task_updated");
      expect(pushed.task.groupId).toBe(group.id);
      expect(pushed.task.metric?.current, "推出去的任务卡带最新的数").toBe(412);
      expect(pushed.task.goal, "记数不动目标").toEqual({ target: 1000, unit: "星", dueAt: null });
      expect((await taskOf(s.client, group.id)).metric?.current, "重新读群也是最新的数").toBe(412);

      const again = await reportMetric(s.client, group.id, 420);
      expect(again.metric?.current, "再记一个数取最新那个").toBe(420);
    } finally {
      s.close();
    }
  });

  it("别人的项目、单聊、不合法的数都记不进去", async () => {
    const s = await session();
    const other = await session();
    try {
      const { group } = await startProject(s, OFFER);
      expect((await other.client.post(`/api/projects/${group.id}/metric`, { value: 1 })).status).toBe(404);
      expect((await s.client.post(`/api/projects/${s.assistant.groupId}/metric`, { value: 1 })).status).toBe(404);
      expect((await s.client.post(`/api/projects/${group.id}/metric`, { value: "多" })).status).toBe(400);
      expect((await taskOf(s.client, group.id)).metric, "一个样本都没落").toBeNull();
    } finally {
      s.close();
      other.close();
    }
  });
});

describe("本周变化", () => {
  it("本周变化只算周一 00:00 之后的样本", async () => {
    const s = await session();
    try {
      const { group } = await startProject(s, { ...OFFER, goalTarget: 1000, goalUnit: "星" });
      const start = weekStart(new Date());
      const sample = (value: string, sampledAt: Date) => ({
        id: newId(),
        groupId: group.id,
        value,
        source: "manual",
        sampledAt,
      });
      await database.db
        .insert(metricSamples)
        .values([
          sample("300", new Date(start.getTime() - 3 * 86_400_000)),
          sample("375", new Date(start.getTime() - 1)),
          sample("390", start),
        ]);

      const task = await reportMetric(s.client, group.id, 412);
      expect(task.metric, "412 减上周最后一个 375，周一 00:00 那个 390 算本周的").toMatchObject({
        current: 412,
        weekDelta: 37,
      });
      expect((await taskOf(s.client, group.id)).metric?.weekDelta).toBe(37);
    } finally {
      s.close();
    }
  });

  it("本周还没有样本时本周变化是 0，当前值是上周最后一个", async () => {
    const s = await session();
    try {
      const { group } = await startProject(s, OFFER);
      const start = weekStart(new Date());
      await database.db.insert(metricSamples).values([
        {
          id: newId(),
          groupId: group.id,
          value: "200",
          source: "manual",
          sampledAt: new Date(start.getTime() - 86_400_000),
        },
        { id: newId(), groupId: group.id, value: "260", source: "manual", sampledAt: new Date(start.getTime() - 1000) },
      ]);
      expect((await taskOf(s.client, group.id)).metric).toMatchObject({ current: 260, weekDelta: 0 });
    } finally {
      s.close();
    }
  });

  it("本周之前没有样本时从本周第一个样本算起", async () => {
    const s = await session();
    try {
      const { group } = await startProject(s, OFFER);
      await reportMetric(s.client, group.id, 400);
      const task = await reportMetric(s.client, group.id, 412.5);
      expect(task.metric).toMatchObject({ current: 412.5, weekDelta: 12.5 });
    } finally {
      s.close();
    }
  });

  it("同一毫秒里先记 100 再记 200，后记的是当前值", async () => {
    const s = await session();
    try {
      const { group } = await startProject(s, OFFER);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date());
      await reportMetric(s.client, group.id, 100);
      // 先记的那条换成字典序最大的 id：先后要是还落到 id 上，最新的就会是 100。
      await database.sql`update metric_samples set id = 'ffffffff-ffff-4fff-bfff-ffffffffffff' where group_id = ${group.id}`;
      const task = await reportMetric(s.client, group.id, 200);
      expect(task.metric, "后记的 200 是当前值，本周从 100 涨了 100").toMatchObject({ current: 200, weekDelta: 100 });
      const [times] =
        await database.sql`select count(distinct sampled_at)::int as n from metric_samples where group_id = ${group.id}`;
      expect(times?.n, "两次记数的采样时间由库来取，分得出先后").toBe(2);
    } finally {
      vi.useRealTimers();
      s.close();
    }
  });

  it("读指标读到一半有人记数，回的也是同一时刻的当前值和本周变化", async () => {
    const s = await session();
    try {
      const { group } = await startProject(s, OFFER);
      type Prepared = { execute(...args: unknown[]): Promise<unknown> };
      type Runtime = { prepareQuery(...args: unknown[]): Prepared };
      const runtime = (database.db as unknown as { session: Runtime }).session;
      const original = runtime.prepareQuery.bind(runtime);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let held!: () => void;
      const holding = new Promise<void>((resolve) => {
        held = resolve;
      });
      const others: Promise<unknown>[] = [];
      let first = true;
      // 拦住这次读群里第一条读样本的语句；同一次读里要是还有别的读样本语句，放它们先跑完。
      const spy = vi.spyOn(runtime, "prepareQuery").mockImplementation((...args) => {
        const prepared = original(...args);
        const text = (args[0] as { sql: string }).sql;
        if (!/^\s*(with|select)\b/i.test(text) || !text.includes('"metric_samples"')) return prepared;
        const execute = prepared.execute.bind(prepared);
        if (first) {
          first = false;
          prepared.execute = async (...params) => {
            held();
            await gate;
            return execute(...params);
          };
        } else {
          prepared.execute = (...params) => {
            const result = execute(...params);
            others.push(result);
            return result;
          };
        }
        return prepared;
      });
      let pending: Promise<Response> | undefined;
      try {
        pending = s.client.get(`/api/groups/${group.id}`);
        await holding;
        // 同一批 Promise.all 里的兄弟语句在当前宏任务里就发出去了，过一个 setImmediate 它们都已登记。
        await new Promise<void>((resolve) => setImmediate(resolve));
        await Promise.all(others);
        spy.mockRestore();
        await reportMetric(s.client, group.id, 100);
        await reportMetric(s.client, group.id, 200);
      } finally {
        spy.mockRestore();
        release();
      }
      const raced = GroupResponse.parse(await (await pending).json()).task.metric;
      const fresh = (await taskOf(s.client, group.id)).metric;
      expect(fresh).toMatchObject({ current: 200, weekDelta: 100 });
      expect(raced, "被拦住的那次读要么都看不见两次记数，要么都看得见，拼不出 200/+0").toEqual(fresh);
    } finally {
      s.close();
    }
  });
});

describe("已有样本的项目", () => {
  it("群列表、PATCH、清单、节奏、换经手、交接、方案卡重读都带着指标", async () => {
    const s = await session();
    const nextPrompt = async (): Promise<Prompt> => {
      for (;;) {
        const frame = await s.agent.next();
        if (frame.type === "prompt") return frame;
      }
    };
    const done = (p: Prompt) =>
      s.agent.send({
        type: "run_done",
        runId: p.runId,
        botId: p.botId,
        groupId: p.groupId,
        steps: 1,
        inputTokens: 0,
        outputTokens: 0,
      });
    const pushed = async (path: string, accept: (task: TopicTask) => boolean) => {
      for (;;) {
        const item = await nextOfType(s.push, "task_updated");
        if (accept(item.task)) {
          expect(item.task.metric?.current, `${path}推出去的任务卡`).toBe(412);
          return;
        }
      }
    };
    try {
      const { card, group, task } = await startProject(s, { ...OFFER, goalTarget: 1000, goalUnit: "星" });
      await reportMetric(s.client, group.id, 412);

      const list = (await (await s.client.get("/api/groups")).json()) as {
        items: { group: { id: string }; task: TopicTask }[];
      };
      expect(list.items.find((item) => item.group.id === group.id)?.task.metric?.current, "群列表").toBe(412);

      for (const [path, patch] of [
        ["空 PATCH", {}],
        ["普通 PATCH", { title: "推广白泽（改名）" }],
      ] as const) {
        const result = UpdateTaskResponse.parse(await (await s.client.patch(`/api/tasks/${task.id}`, patch)).json());
        expect(result.task.metric?.current, `${path}回的任务卡`).toBe(412);
        await pushed(path, () => true);
      }

      const replay = await s.client.post(`/api/messages/${card.id}/project-offer`, { decision: "start" });
      expect(DecideProjectOfferResponse.parse(await replay.json()).task?.metric?.current, "方案卡重读").toBe(412);

      const detail = GroupResponse.parse(await (await s.client.get(`/api/groups/${group.id}`)).json());
      const lead = detail.bots.find((bot) => bot.id === s.assistant.botId);
      const member = detail.bots.find((bot) => bot.id !== s.assistant.botId);
      if (lead === undefined || member === undefined) throw new Error("项目群里应当有主助理和一个队员");

      expect((await s.client.post(`/api/groups/${group.id}/messages`, { text: `@${lead.name} 看看进度` })).status).toBe(
        201,
      );
      const prompt = await nextPrompt();
      expect(prompt.task?.metric?.current, "派活带的任务卡").toBe(412);
      await pushed("换经手", (t) => t.currentBotId === lead.id);

      const at = { runId: prompt.runId, botId: prompt.botId, groupId: prompt.groupId };
      s.agent.send({ type: "task_checklist", ...at, checklist: [{ text: "改 README", done: true, ownerBotId: null }] });
      await pushed("清单更新", (t) => t.checklist[0]?.text === "改 README");
      s.agent.send({ type: "set_cadence", ...at, projectGroupId: group.id, cadence: "每周小红书 3 篇" });
      await pushed("改节奏", (t) => t.cadence === "每周小红书 3 篇");
      s.agent.send({
        type: "handoff",
        ...at,
        toBotId: member.id,
        done: "README 改完",
        notDone: "笔记没写",
        next: "写第一篇",
        checklistIndex: null,
      });
      done(prompt);
      const handed = await nextPrompt();
      if (handed.handoffId === undefined) throw new Error("接手的 prompt 应当带交接 id");
      s.agent.send({
        type: "handoff_accept",
        runId: handed.runId,
        botId: handed.botId,
        groupId: handed.groupId,
        handoffId: handed.handoffId,
      });
      await pushed("交接接受", (t) => t.currentBotId === member.id);
      done(handed);
      await s.agent.ack(handed.runId);
    } finally {
      s.close();
    }
  });
});

/** 给项目群直接落一份已批计划，里面一篇稿子还没发。计划挂在主助理名下，删项目成员时它不跟着走。 */
async function approvedPlanWithUnsent(s: Session, groupId: string): Promise<void> {
  const accountId = newId();
  const planId = newId();
  await database.db.insert(accounts).values({
    id: accountId,
    ownerId: s.userId,
    computerId: s.computerId,
    platform: "x",
    handle: `@${accountId}`,
    login: "valid",
  });
  await database.db.insert(contentPlans).values({
    id: planId,
    ownerId: s.userId,
    groupId,
    botId: s.assistant.botId,
    title: "还没发完的计划",
    status: "approved",
    decidedAt: new Date(),
  });
  await database.db.insert(drafts).values({
    id: newId(),
    ownerId: s.userId,
    groupId,
    botId: s.assistant.botId,
    planId,
    accountId,
    platform: "x",
    content: { kind: "post", title: "未发稿", text: "正文", images: [], github: null },
    contentHash: planId,
    status: "approved",
  });
}

async function runningGroups(client: ApiClient): Promise<Set<string>> {
  const today = TodayResponse.parse(await (await client.get("/api/today")).json());
  return new Set(today.running.map((item) => item.groupId));
}

describe("首页在进行", () => {
  it("首页在进行一行按目标画进度", async () => {
    const s = await session();
    try {
      const stars = await startProject(s, { ...OFFER, goalTarget: 1000, goalUnit: "星" });
      await reportMetric(s.client, stars.group.id, 412);
      const fresh = await startProject(s, { ...OFFER, name: "抖音起号", goalTarget: 1000, goalUnit: "粉丝" });
      const plain = await startProject(s, { ...OFFER, name: "没定目标" });
      const finished = await startProject(s, { ...OFFER, name: "做完了", goalTarget: 10, goalUnit: "篇" });
      expect((await s.client.patch(`/api/tasks/${finished.task.id}`, { status: "done" })).status).toBe(200);

      const today = TodayResponse.parse(await (await s.client.get("/api/today")).json());
      const byGroup = new Map(today.running.map((item) => [item.groupId, item]));
      expect(byGroup.get(stars.group.id), "有目标有样本：按 412 / 1000 星画，没有计划稿子数是 0").toEqual({
        groupId: stars.group.id,
        title: stars.task.title,
        published: 0,
        planned: 0,
        goal: { target: 1000, unit: "星", dueAt: null },
        metric: expect.objectContaining({ current: 412 }),
      });
      expect(byGroup.get(fresh.group.id), "有目标还没样本也出一行，metric 是 null").toMatchObject({
        goal: { target: 1000, unit: "粉丝", dueAt: null },
        metric: null,
      });
      expect(byGroup.has(plain.group.id), "没目标也没计划的项目不出行").toBe(false);
      expect(byGroup.has(finished.group.id), "任务卡做完了的项目不出行").toBe(false);
      expect(today.running, "只有两个有目标的进行中项目").toHaveLength(2);
    } finally {
      s.close();
    }
  });

  it("done 项目有未发完计划也不出在进行", async () => {
    const s = await session();
    try {
      const withGoal = await startProject(s, { ...OFFER, goalTarget: 1000, goalUnit: "星" });
      await reportMetric(s.client, withGoal.group.id, 412);
      await approvedPlanWithUnsent(s, withGoal.group.id);
      const noGoal = await startProject(s, { ...OFFER, name: "没定目标" });
      await approvedPlanWithUnsent(s, noGoal.group.id);
      const before = await runningGroups(s.client);
      expect(before.has(withGoal.group.id), "做完之前有目标的项目在进行").toBe(true);
      expect(before.has(noGoal.group.id), "做完之前没目标但计划没发完的项目在进行").toBe(true);

      for (const project of [withGoal, noGoal])
        expect((await s.client.patch(`/api/tasks/${project.task.id}`, { status: "done" })).status).toBe(200);
      const after = await runningGroups(s.client);
      expect(after.has(withGoal.group.id), "有目标的项目做完后不从计划那一路回来").toBe(false);
      expect(after.has(noGoal.group.id), "没目标的项目做完后计划没发完也不出行").toBe(false);
    } finally {
      s.close();
    }
  });

  it("成员删空的项目不出在进行", async () => {
    const s = await session();
    try {
      const team = async (title: string) => {
        const botIds: BotId[] = [];
        for (const name of [`${title}甲`, `${title}乙`]) {
          const response = await s.client.post("/api/bots", { name });
          expect(response.status).toBe(201);
          botIds.push(CreateBotResponse.parse(await response.json()).bot.id);
        }
        const response = await s.client.post("/api/groups", { title, botIds });
        expect(response.status).toBe(201);
        return { ...CreateGroupResponse.parse(await response.json()), botIds };
      };
      const withGoal = await team("有目标");
      const goal = { target: 1000, unit: "星", dueAt: null };
      expect((await s.client.patch(`/api/tasks/${withGoal.task.id}`, { goal })).status).toBe(200);
      await approvedPlanWithUnsent(s, withGoal.group.id);
      const noGoal = await team("没目标");
      await approvedPlanWithUnsent(s, noGoal.group.id);
      const before = await runningGroups(s.client);
      expect(before.has(withGoal.group.id), "删成员之前有目标的项目在进行").toBe(true);
      expect(before.has(noGoal.group.id), "删成员之前计划没发完的项目在进行").toBe(true);

      for (const botId of [...withGoal.botIds, ...noGoal.botIds])
        expect((await s.client.delete(`/api/bots/${botId}`)).status).toBe(204);
      const after = await runningGroups(s.client);
      expect(after.has(withGoal.group.id), "成员删空后有目标的项目不出行").toBe(false);
      expect(after.has(noGoal.group.id), "成员删空后计划没发完也不出行").toBe(false);
    } finally {
      s.close();
    }
  });
});
