import {
  BotListResponse,
  CreateBotResponse,
  CreateGroupResponse,
  MAX_ROUTINE_RUNS,
  MessageId,
  MessageListResponse,
  RoutineListResponse,
  RoutineResponse,
  UserId,
  type BotId,
  type ControlToAgent,
  type CreateRoutineRequest,
  type GroupId,
  type Routine,
  type ServerPush,
} from "@baize/shared";
import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../src/db/schema.js";
import type { StoredTrigger } from "../src/db/schema.js";
import { EXECUTOR_DELETED_NOTE, advanceCronTrigger } from "../src/repo/routines.js";
import { lockOwner, shareBotRunsLock } from "../src/repo/runs.js";
import { connect, type Db, type Sql } from "../src/db/client.js";
import { databaseUrl } from "../src/env.js";
import { DISPATCH_FAILED_NOTE, WAITING_APPROVAL_NOTE } from "../src/routines/run.js";
import { ApiClient, startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, type TestComputer } from "./helpers/fixtures.js";
import { gatedDb, type QueryGate } from "./helpers/gated-db.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { connectPush, type PushClient } from "./helpers/ws.js";

let database: TestDb;
let server: TestServer;

/**
 * 调度器的时钟由测试说了算，扫描间隔顶到一小时，所以只有测试自己调 `tick()` 时才会到点。
 * 基准时间挑在将来：用真实时间的话，算出来的 cron 时刻和这台机器此刻的分钟撞上就说不清是谁触发的。
 */
const BASE = new Date("2030-01-01T09:00:00");
let clock = new Date(BASE);

beforeAll(async () => {
  database = await createTestDb();
  clock = new Date(BASE);
  server = await startTestServer(
    database.db,
    // 一次运行收 ¥0.80，运行记录 note 里的花费才看得出来是不是缀上去的。
    { priceInputPerM: 800, priceOutputPerM: 0 },
    { now: () => clock, intervalMs: 60 * 60 * 1000 },
  );
});

afterAll(async () => {
  await server.close();
  await database.close();
});

type Owner = {
  readonly client: ApiClient;
  readonly computer: TestComputer;
  readonly email: string;
  readonly groupId: GroupId;
  readonly botId: BotId;
};

async function ownerWithBot(): Promise<Owner> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小服" })).json());
  return { client, computer, email: user.email, groupId: created.group.id, botId: created.bot.id };
}

async function online(owner: Owner): Promise<AgentClient> {
  const { agent } = await helloAgent(server.server.port, owner.computer.computerId, owner.computer.token);
  return agent;
}

async function makeRoutine(owner: Owner, input: Partial<CreateRoutineRequest> = {}): Promise<Routine> {
  const body = {
    name: "每日工单早报",
    instruction: "把今天的工单汇总一下",
    triggers: [{ kind: "cron", expr: "* * * * *" }],
    onFailure: "stop_and_tell",
    ...input,
  };
  const response = await owner.client.post(`/api/bots/${owner.botId}/routines`, body);
  expect(response.status).toBe(201);
  return RoutineResponse.parse(await response.json()).routine;
}

type RunRow = { id: string; status: string; note: string; started_at: Date };

async function runsOf(routineId: string): Promise<RunRow[]> {
  return database.sql<RunRow[]>`
    SELECT id, status, note, started_at FROM routine_runs
    WHERE routine_id = ${routineId} ORDER BY started_at ASC, id ASC
  `;
}

async function storedTriggers(routineId: string): Promise<StoredTrigger[]> {
  const rows = await database.sql<{ triggers: StoredTrigger[] }[]>`
    SELECT triggers FROM routines WHERE id = ${routineId}
  `;
  return rows[0]?.triggers ?? [];
}

function webhookToken(routine: Routine): string {
  const trigger = routine.triggers.find((one) => one.kind === "webhook");
  if (trigger === undefined || trigger.kind !== "webhook") throw new Error("这条例行任务没有 webhook 触发器");
  return trigger.token;
}

/** 把测试时钟推到下一分钟之后。`* * * * *` 在这一步和上一次触发之间恰好多出一个时刻。 */
function advanceOneMinute(): void {
  clock = new Date(clock.getTime() + 61_000);
}

describe("消息用途", () => {
  it("单 Bot 群里的普通消息走 plan", async () => {
    const owner = await ownerWithBot();
    const agent = await online(owner);

    try {
      const response = await owner.client.post(`/api/groups/${owner.groupId}/messages`, { text: "请安排今天的工作" });
      expect(response.status).toBe(201);

      const prompt = await agent.expect("prompt");
      expect(prompt.purpose).toBe("plan");
    } finally {
      agent.close();
    }
  });
});

describe("例行任务到点触发", () => {
  it("到点跑一次：群里多两条消息，活派了下去", async () => {
    const owner = await ownerWithBot();
    const agent = await online(owner);

    try {
      const routine = await makeRoutine(owner, { purpose: "fast" });
      // 第一遍只把从没触发过的游标对齐到现在。新建的例行任务不该立刻跑一次。
      await server.server.routines.tick();
      expect(await runsOf(routine.id), "刚建好还没到过点").toHaveLength(0);

      advanceOneMinute();
      await server.server.routines.tick();

      const prompt = await agent.expect("prompt");
      expect(prompt.text, "派下去的正文就是 instruction 本身").toBe("把今天的工单汇总一下");
      expect(prompt.botId).toBe(owner.botId);
      expect(prompt.groupId).toBe(owner.groupId);
      expect(prompt.origin, "例行任务那条没有人在等回复，运行器得知道").toEqual({ kind: "routine" });
      expect(prompt.purpose, "例行任务按自己保存的用途选模型").toBe("fast");

      const page = MessageListResponse.parse(
        await (await owner.client.get(`/api/groups/${owner.groupId}/messages`)).json(),
      );
      const bodies = page.messages.map((message) => message.body);
      expect(bodies, "群里只落一条用户消息，正文和手打的一样，另带上是哪个例行任务").toEqual([
        expect.objectContaining({ kind: "user", text: "把今天的工单汇总一下", routine: { name: "每日工单早报" } }),
      ]);
      expect(prompt.messageId, "例行的 prompt 指回它写进群里的那条用户消息").toBe(page.messages[0]?.id);

      const rows = await runsOf(routine.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status, "派出去就算在跑，收尾等电脑那边的报文").toBe("running");

      const runs = await database.sql<{ routine_run_id: string | null }[]>`
        SELECT routine_run_id FROM runs WHERE id = ${prompt.runId}
      `;
      expect(runs[0]?.routine_run_id, "run 行一生下来就带着回指运行记录的那条边").toBe(rows[0]?.id);
    } finally {
      agent.close();
    }
  });

  it("同一时刻扫两遍只触发一次", async () => {
    const owner = await ownerWithBot();
    const agent = await online(owner);

    try {
      const routine = await makeRoutine(owner);
      await server.server.routines.tick();
      advanceOneMinute();

      await server.server.routines.tick();
      await server.server.routines.tick();

      expect(await runsOf(routine.id), "第二遍扫到的游标已经是新值，推不动就不触发").toHaveLength(1);
    } finally {
      agent.close();
    }
  });

  it("两个实例同时扫到同一刻也只发一次", async () => {
    const owner = await ownerWithBot();
    const agent = await online(owner);
    const second = await startTestServer(database.db, {}, { now: () => clock, intervalMs: 60 * 60 * 1000 });

    try {
      const routine = await makeRoutine(owner);
      await server.server.routines.tick();
      advanceOneMinute();

      // 两边都读到同一个旧游标，能推动它的只有一个。
      await Promise.all([server.server.routines.tick(), second.server.routines.tick()]);

      expect(await runsOf(routine.id)).toHaveLength(1);
    } finally {
      await second.close();
      agent.close();
    }
  });

  it("重启：换一个调度器实例对着同一个库扫，不重复触发", async () => {
    const owner = await ownerWithBot();
    const agent = await online(owner);

    try {
      const routine = await makeRoutine(owner);
      await server.server.routines.tick();
      advanceOneMinute();
      await server.server.routines.tick();
      expect(await runsOf(routine.id)).toHaveLength(1);

      const restarted = await startTestServer(database.db, {}, { now: () => clock, intervalMs: 60 * 60 * 1000 });
      try {
        await restarted.server.routines.tick();
        expect(await runsOf(routine.id), "游标在库里，新实例看到的就是上一个进程推到的那一刻").toHaveLength(1);
      } finally {
        await restarted.close();
      }
    } finally {
      agent.close();
    }
  });

  it("派活途中触发器被重排，游标不落到别的触发器头上", async () => {
    const owner = await ownerWithBot();
    const everyMinute = { kind: "cron", expr: "* * * * *" } as const;
    const everyFive = { kind: "cron", expr: "*/5 * * * *" } as const;
    const routine = await makeRoutine(owner, { triggers: [everyMinute, everyFive] });
    await server.server.routines.tick();

    const aligned = await storedTriggers(routine.id);
    const lastFiredAt = aligned[0]?.kind === "cron" ? aligned[0].lastFiredAt : null;
    expect(lastFiredAt, "一遍扫下来两个触发器对齐到同一刻").not.toBeNull();
    expect(aligned).toEqual([
      { ...everyMinute, lastFiredAt },
      { ...everyFive, lastFiredAt },
    ]);

    // 扫到这一条和推游标之间隔着一次派活，其间用户把两个触发器换了个位置。
    expect(
      (await owner.client.patch(`/api/routines/${routine.id}`, { triggers: [everyFive, everyMinute] })).status,
    ).toBe(200);

    const claimed = await advanceCronTrigger(
      database.db,
      routine.id,
      0,
      { expr: everyMinute.expr, lastFiredAt },
      new Date(clock.getTime() + 61_000),
    );
    expect(claimed, "下标认的是位置不是身份，游标只认领当初读到的那个触发器").toBe(false);
    expect(await storedTriggers(routine.id), "谁的游标都没动").toEqual([
      { ...everyFive, lastFiredAt },
      { ...everyMinute, lastFiredAt },
    ]);
  });

  it("停机期间错过的几个时刻只补跑一次", async () => {
    const owner = await ownerWithBot();
    const agent = await online(owner);

    try {
      const routine = await makeRoutine(owner);
      await server.server.routines.tick();

      // 停机三小时。每分钟跑的例行任务错过了 180 个时刻。
      clock = new Date(clock.getTime() + 3 * 60 * 60 * 1000);
      // 扫三遍都停在同一个时刻上：补跑的是空窗里最晚那一刻，不是错过的挨个排队跑。
      await server.server.routines.tick();
      await server.server.routines.tick();
      await server.server.routines.tick();

      expect(await runsOf(routine.id)).toHaveLength(1);
    } finally {
      agent.close();
    }
  });

  it("停用的不触发，重新启用也不补跑攒下的那一刻", async () => {
    const owner = await ownerWithBot();
    const agent = await online(owner);

    try {
      const routine = await makeRoutine(owner, { state: "paused" });
      await server.server.routines.tick();
      advanceOneMinute();
      await server.server.routines.tick();
      expect(await runsOf(routine.id)).toHaveLength(0);

      expect((await owner.client.patch(`/api/routines/${routine.id}`, { state: "on" })).status).toBe(200);
      await server.server.routines.tick();
      expect(await runsOf(routine.id), "停用期间游标照推，启用后要等下一个时刻").toHaveLength(0);

      advanceOneMinute();
      await server.server.routines.tick();
      expect(await runsOf(routine.id)).toHaveLength(1);
    } finally {
      agent.close();
    }
  });
});

describe("webhook 触发", () => {
  it("打 token 就跑一次，不用登录", async () => {
    const owner = await ownerWithBot();
    const agent = await online(owner);

    try {
      const routine = await makeRoutine(owner, { triggers: [{ kind: "webhook" }] });
      const token = webhookToken(routine);
      expect(token, "token 由控制面发，16 字节十六进制").toMatch(/^[0-9a-f]{32}$/);

      // 全新的客户端，没有会话 cookie。
      const stranger = server.client();
      const response = await stranger.post(`/api/hooks/${token}`, { 随便什么: "请求体会被忽略" });
      expect(response.status).toBe(202);
      expect(await response.text()).toBe("");

      const prompt = await agent.expect("prompt");
      expect(prompt.text).toBe("把今天的工单汇总一下");
      expect(await runsOf(routine.id)).toHaveLength(1);
    } finally {
      agent.close();
    }
  });

  it("token 对不上 404，停用的 409", async () => {
    const owner = await ownerWithBot();
    const routine = await makeRoutine(owner, { triggers: [{ kind: "webhook" }] });
    const token = webhookToken(routine);
    const stranger = server.client();

    expect((await stranger.post(`/api/hooks/${"0".repeat(32)}`)).status).toBe(404);
    expect(
      (await stranger.post(`/api/hooks/${token}/bots`)).status,
      "不登录只豁免 /api/hooks/:token 这一条，多一段路径就要认人",
    ).toBe(401);

    expect((await owner.client.patch(`/api/routines/${routine.id}`, { state: "paused" })).status).toBe(200);
    expect((await stranger.post(`/api/hooks/${token}`)).status).toBe(409);
    expect(await runsOf(routine.id), "409 就是没跑，运行记录里不该多一条").toHaveLength(0);
  });

  it("改名重发整份触发器时 token 保留", async () => {
    const owner = await ownerWithBot();
    const routine = await makeRoutine(owner, { triggers: [{ kind: "webhook" }] });
    const token = webhookToken(routine);

    const response = await owner.client.patch(`/api/routines/${routine.id}`, {
      name: "换个名字",
      triggers: [{ kind: "webhook", token }],
    });
    expect(response.status).toBe(200);
    expect(webhookToken(RoutineResponse.parse(await response.json()).routine), "地址已经发出去了，不能换").toBe(token);
  });
});

describe("试跑", () => {
  it("PATCH 改成 fast 后试跑沿用，省略 purpose 时保留原值", async () => {
    const owner = await ownerWithBot();
    const agent = await online(owner);

    try {
      const routine = await makeRoutine(owner, { purpose: "plan", triggers: [], state: "paused" });
      const changed = await owner.client.patch(`/api/routines/${routine.id}`, { purpose: "fast" });
      expect(changed.status).toBe(200);
      expect(RoutineResponse.parse(await changed.json()).routine.purpose).toBe("fast");

      const unchanged = await owner.client.patch(`/api/routines/${routine.id}`, { name: "换个名字" });
      expect(unchanged.status).toBe(200);
      expect(RoutineResponse.parse(await unchanged.json()).routine.purpose).toBe("fast");

      const run = await owner.client.post(`/api/routines/${routine.id}/run`);
      expect(run.status).toBe(202);
      const prompt = await agent.expect("prompt");
      expect(prompt.purpose).toBe("fast");
    } finally {
      agent.close();
    }
  });

  it("和到点触发走同一条路，回 202 且最前面多一条 running", async () => {
    const owner = await ownerWithBot();
    const agent = await online(owner);

    try {
      const routine = await makeRoutine(owner, { state: "paused" });
      const response = await owner.client.post(`/api/routines/${routine.id}/run`);
      expect(response.status, "停用只挡自动触发，试跑照跑").toBe(202);

      const body = RoutineResponse.parse(await response.json());
      expect(body.routine.runs[0]?.status).toBe("running");

      const prompt = await agent.expect("prompt");
      expect(prompt.text).toBe("把今天的工单汇总一下");

      const page = MessageListResponse.parse(
        await (await owner.client.get(`/api/groups/${owner.groupId}/messages`)).json(),
      );
      expect(page.messages[0]?.body).toMatchObject({ kind: "user", routine: { name: "每日工单早报" } });
    } finally {
      agent.close();
    }
  });

  it("第 21 条运行记录挤掉最早那条", async () => {
    const owner = await ownerWithBot();
    // 电脑不在线，每次试跑当场记 failed：裁的只能是已经收尾的记录。
    const routine = await makeRoutine(owner, { triggers: [] });
    await failedTrial(owner, routine.id);
    const [oldest] = await runsOf(routine.id);
    expect(oldest).toBeDefined();

    for (let i = 1; i <= MAX_ROUTINE_RUNS; i += 1) await failedTrial(owner, routine.id);

    const rows = await runsOf(routine.id);
    expect(rows).toHaveLength(MAX_ROUTINE_RUNS);
    expect(
      rows.map((row) => row.id),
      "只留最近 20 条，最早那条跟着第 21 次运行一起没了",
    ).not.toContain(oldest?.id);
  });
});

describe("运行记录收尾", () => {
  it("run_done 记 ok，note 里带花费", async () => {
    const owner = await ownerWithBot();
    const agent = await online(owner);

    try {
      const routine = await makeRoutine(owner, { triggers: [] });
      expect((await owner.client.post(`/api/routines/${routine.id}/run`)).status).toBe(202);
      const prompt = await agent.expect("prompt");

      agent.send({
        type: "run_done",
        runId: prompt.runId,
        botId: owner.botId,
        groupId: owner.groupId,
        steps: 3,
        inputTokens: 1000,
        outputTokens: 0,
      });

      await settled(routine.id);
      const [row] = await runsOf(routine.id);
      expect(row?.status).toBe("ok");
      expect(row?.note).toBe("¥0.80");
    } finally {
      agent.close();
    }
  });

  it("agent_error 记 failed", async () => {
    const owner = await ownerWithBot();
    const agent = await online(owner);

    try {
      const routine = await makeRoutine(owner, { triggers: [] });
      expect((await owner.client.post(`/api/routines/${routine.id}/run`)).status).toBe(202);
      await agent.expect("prompt");

      agent.send({ type: "agent_error", code: "runner_failed", detail: "进程退了", groupId: owner.groupId });

      await settled(routine.id);
      const [row] = await runsOf(routine.id);
      expect(row?.status).toBe("failed");
      expect(row?.note).toBe("跑活的进程出错了");
    } finally {
      agent.close();
    }
  });

  it("stop_and_tell 遇到审批记 stopped，随后的花费缀在后面", async () => {
    const owner = await ownerWithBot();
    const agent = await online(owner);

    try {
      const routine = await makeRoutine(owner, { triggers: [], onFailure: "stop_and_tell" });
      expect((await owner.client.post(`/api/routines/${routine.id}/run`)).status).toBe(202);
      const prompt = await agent.expect("prompt");

      agent.send({
        type: "approval_request",
        runId: prompt.runId,
        botId: owner.botId,
        groupId: owner.groupId,
        callId: "call-1",
        tool: "send_email",
        action: "message_person",
        target: null,
        view: { kind: "mcp", server: "", tool: "send_email", params: [], raw: "给客户发一封邮件" },
      });

      await settled(routine.id);
      expect((await runsOf(routine.id))[0]).toMatchObject({ status: "stopped", note: WAITING_APPROVAL_NOTE });

      agent.send({
        type: "run_done",
        runId: prompt.runId,
        botId: owner.botId,
        groupId: owner.groupId,
        steps: 2,
        inputTokens: 1000,
        outputTokens: 0,
      });

      await waitForNote(routine.id, `${WAITING_APPROVAL_NOTE} · ¥0.80`);
      expect((await runsOf(routine.id))[0]?.status, "停下等点头的活跑完了也还是停下的").toBe("stopped");
    } finally {
      agent.close();
    }
  });

  it("例行 run 的审批失效后，这次例行记失败，原因是审批已失效", async () => {
    const owner = await ownerWithBot();
    const agent = await online(owner);

    try {
      const routine = await makeRoutine(owner, { triggers: [], onFailure: "stop_and_tell" });
      expect((await owner.client.post(`/api/routines/${routine.id}/run`)).status).toBe(202);
      const prompt = await agent.expect("prompt");

      agent.send({
        type: "approval_request",
        runId: prompt.runId,
        botId: owner.botId,
        groupId: owner.groupId,
        callId: "call-expired",
        tool: "send_email",
        action: "message_person",
        target: null,
        view: { kind: "mcp", server: "", tool: "send_email", params: [], raw: "给客户发一封邮件" },
      });
      await settled(routine.id);
      expect((await runsOf(routine.id))[0]?.status).toBe("stopped");

      agent.send({
        type: "approval_abandoned",
        runId: prompt.runId,
        callId: "call-expired",
        reason: "stopped",
      });

      await waitForNote(routine.id, "审批已失效");
      expect((await runsOf(routine.id))[0]).toMatchObject({ status: "failed", note: "审批已失效" });
    } finally {
      agent.close();
    }
  });

  it("retry_next_time 遇到审批只补一句话，活还算在跑", async () => {
    const owner = await ownerWithBot();
    const agent = await online(owner);

    try {
      const routine = await makeRoutine(owner, { triggers: [], onFailure: "retry_next_time" });
      expect((await owner.client.post(`/api/routines/${routine.id}/run`)).status).toBe(202);
      const prompt = await agent.expect("prompt");

      agent.send({
        type: "approval_request",
        runId: prompt.runId,
        botId: owner.botId,
        groupId: owner.groupId,
        callId: "call-1",
        tool: "send_email",
        action: "message_person",
        target: null,
        view: { kind: "mcp", server: "", tool: "send_email", params: [], raw: "给客户发一封邮件" },
      });

      await waitForNote(routine.id, "等你点头，下次照常跑");
      expect((await runsOf(routine.id))[0]?.status).toBe("running");
    } finally {
      agent.close();
    }
  });

  it("电脑不在线时记 failed", async () => {
    const owner = await ownerWithBot();
    const routine = await makeRoutine(owner, { triggers: [] });
    expect((await owner.client.post(`/api/routines/${routine.id}/run`)).status).toBe(202);

    const [row] = await runsOf(routine.id);
    expect(row?.status, "一条活都没派出去，不该停在运行中").toBe("failed");
    expect(row?.note).toBe("电脑不在线，没跑起来");
  });

  it("群里没有能派的 Bot 时记 failed，写的是没有 Bot 而不是电脑不在线", async () => {
    const owner = await ownerWithBot();
    const agent = await online(owner);
    try {
      const routine = await makeRoutine(owner, { triggers: [] });
      // 接口上走不到一个没有成员的群：Bot 删了例行跟着删，项目群里主助理删不掉。这里直接拆掉成员关系。
      await database.sql`DELETE FROM group_members WHERE group_id = ${owner.groupId}`;
      expect((await owner.client.post(`/api/routines/${routine.id}/run`)).status).toBe(202);

      const [row] = await runsOf(routine.id);
      expect(row?.status, "一条活都没派出去，不该停在运行中").toBe("failed");
      expect(row?.note, "电脑明明在线，原因是群里没有 Bot").toBe("群里没有能派的 Bot，没跑起来");
    } finally {
      agent.close();
    }
  });
});

/** 等收尾落库。上行报文是异步处理的，回应答的那一刻状态还可能没改。 */
async function settled(routineId: string): Promise<void> {
  await waitUntil(async () => (await runsOf(routineId))[0]?.status !== "running", "运行记录收尾");
}

async function waitForNote(routineId: string, note: string): Promise<void> {
  await waitUntil(async () => (await runsOf(routineId))[0]?.note === note, `运行记录的 note 变成「${note}」`);
}

async function waitUntil(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`等${what}超时`);
}

async function allRoutines(client: ApiClient): Promise<Routine[]> {
  const response = await client.get("/api/routines");
  expect(response.status).toBe(200);
  return RoutineListResponse.parse(await response.json()).items;
}

async function secondBot(owner: Owner): Promise<BotId> {
  return CreateBotResponse.parse(await (await owner.client.post("/api/bots", { name: "小内" })).json()).bot.id;
}

async function projectGroup(owner: Owner, botIds: readonly BotId[]): Promise<GroupId> {
  const response = await owner.client.post("/api/groups", { title: "推广白泽", botIds });
  expect(response.status).toBe(201);
  return CreateGroupResponse.parse(await response.json()).group.id;
}

describe("例行聚合与项目群里的例行", () => {
  it("GET /api/routines 列出自己全部 Bot 的例行，每条带 botId、groupId 和运行记录，别人的不在", async () => {
    const owner = await ownerWithBot();
    const other = await secondBot(owner);
    const stranger = await ownerWithBot();
    await makeRoutine(stranger, { name: "别人的" });

    const first = await makeRoutine(owner, { name: "早报" });
    const ran = await owner.client.post(`/api/routines/${first.id}/run`, {});
    expect(ran.status).toBe(202);
    const afterRun = RoutineResponse.parse(await ran.json()).routine;
    const second = RoutineResponse.parse(
      await (
        await owner.client.post(`/api/bots/${other}/routines`, {
          name: "晚报",
          instruction: "汇总今天的工单",
          triggers: [],
          onFailure: "stop_and_tell",
        })
      ).json(),
    ).routine;

    const items = await allRoutines(owner.client);
    expect(items, "按建的先后排，和单个 Bot 的接口同一个形状").toEqual([afterRun, second]);
    expect(items.map((routine) => routine.botId)).toEqual([owner.botId, other]);
    expect(
      items[0]?.runs.map((run) => run.status),
      "带着运行记录",
    ).toEqual(["failed"]);
    expect((await server.client().get("/api/routines")).status, "没登录拿不到").toBe(401);
  });

  it("建例行时带的 groupId 落库，列表里带着，试跑发进那个群", async () => {
    const owner = await ownerWithBot();
    const groupId = await projectGroup(owner, [owner.botId, await secondBot(owner)]);
    const routine = await makeRoutine(owner, { name: "项目周报", groupId });
    expect(routine.groupId).toBe(groupId);

    const [listed] = await allRoutines(owner.client);
    expect(listed?.groupId, "落了库，重新读出来还是那个群").toBe(groupId);
    const stored = await database.sql<{ group_id: string | null }[]>`
      SELECT group_id FROM routines WHERE id = ${routine.id}
    `;
    expect(stored[0]?.group_id).toBe(groupId);

    expect((await owner.client.post(`/api/routines/${routine.id}/run`, {})).status).toBe(202);
    const inProject = MessageListResponse.parse(
      await (await owner.client.get(`/api/groups/${groupId}/messages`)).json(),
    ).messages.map((message) => message.body);
    expect(inProject, "例行发进项目群，不是 Bot 的单聊").toContainEqual(
      expect.objectContaining({ kind: "user", routine: { name: "项目周报" } }),
    );
    const inSolo = MessageListResponse.parse(
      await (await owner.client.get(`/api/groups/${owner.groupId}/messages`)).json(),
    ).messages;
    expect(inSolo).toEqual([]);
  });

  it("项目群换了首席，例行仍只派给它所属的 Bot，不跟着首席走", async () => {
    const owner = await ownerWithBot();
    const member = await secondBot(owner);
    const groupId = await projectGroup(owner, [owner.botId, member]);
    const routine = await makeRoutine(owner, { name: "周一排本周计划", groupId, triggers: [] });
    const agent = await online(owner);
    const push = await connectPush(server.server.port, owner.client.cookie ?? "");
    try {
      expect((await owner.client.post(`/api/groups/${groupId}/messages`, { text: "@小服 让小内当首席" })).status).toBe(
        201,
      );
      const setup = await agent.expect("prompt");
      agent.send({ type: "set_chief", runId: setup.runId, botId: owner.botId, groupId, targetBotId: member });
      agent.send({
        type: "run_done",
        runId: setup.runId,
        botId: owner.botId,
        groupId,
        steps: 1,
        inputTokens: 0,
        outputTokens: 0,
      });
      for (;;) {
        const event = await push.nextRaw();
        if (event.type === "group_turn" && event.groupId === groupId && event.current === null) break;
      }

      expect((await owner.client.post(`/api/routines/${routine.id}/run`, {})).status).toBe(202);
      let prompt = await agent.next();
      while (prompt.type !== "prompt") prompt = await agent.next();
      expect(prompt.members.find((one) => one.id === member)?.seat, "首席已经换成小内").toBe("chief");
      expect(prompt.botId, "例行属于小服，换了首席也还是小服接，不派给新首席").toBe(owner.botId);
      expect(prompt.origin).toEqual({ kind: "routine" });
    } finally {
      agent.close();
      push.close();
    }
  });

  it("groupId 是别人的群 404，Bot 不在那个群里 400，都不建", async () => {
    const owner = await ownerWithBot();
    const stranger = await ownerWithBot();
    const strangerGroup = await projectGroup(stranger, [stranger.botId, await secondBot(stranger)]);
    const withoutMe = await projectGroup(owner, [await secondBot(owner), await secondBot(owner)]);
    const body = { name: "项目周报", instruction: "写周报", triggers: [], onFailure: "stop_and_tell" };

    const foreign = await owner.client.post(`/api/bots/${owner.botId}/routines`, { ...body, groupId: strangerGroup });
    expect(foreign.status, "别人的群和不存在一样").toBe(404);
    const notMember = await owner.client.post(`/api/bots/${owner.botId}/routines`, { ...body, groupId: withoutMe });
    expect(notMember.status).toBe(400);
    expect(((await notMember.json()) as { error: string }).error).toContain("不在");
    expect(await allRoutines(owner.client)).toEqual([]);
  });
});

async function untilPush<T extends ServerPush>(
  push: PushClient,
  match: (one: ServerPush) => one is T,
  what: string,
): Promise<T> {
  for (;;) {
    const one = await push.next().catch(() => {
      throw new Error(`等推送「${what}」超时`);
    });
    if (match(one)) return one;
  }
}

function routinePushed(routineId: string, state: Routine["state"]) {
  return (one: ServerPush): one is Extract<ServerPush, { type: "routine_updated" }> =>
    one.type === "routine_updated" && one.routine.id === routineId && one.routine.state === state;
}

async function stateOf(routineId: string): Promise<string | undefined> {
  const rows = await database.sql<{ state: string }[]>`SELECT state FROM routines WHERE id = ${routineId}`;
  return rows[0]?.state;
}

/** 电脑不在线时试跑当场记 failed，一次就是一条已结束的运行。 */
async function failedTrial(owner: Owner, routineId: string): Promise<void> {
  expect((await owner.client.post(`/api/routines/${routineId}/run`)).status).toBe(202);
}

async function assistantOf(owner: Owner): Promise<BotId> {
  const list = BotListResponse.parse(await (await owner.client.get("/api/bots")).json()).items;
  const entry = list.find((item) => item.bot.role === "assistant");
  if (entry === undefined) throw new Error("登录后应当有主助理");
  return entry.bot.id;
}

/** 用测试库的一个连接开事务跑一条锁语句，锁着不放，直到 release。 */
async function holdLock(
  lock: (tx: TransactionSql) => Promise<unknown>,
  client: Sql = database.sql,
): Promise<{ release: () => Promise<void> }> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const holding = new Promise<void>((resolve) => (locked = resolve));
  const done = client.begin(async (tx) => {
    await lock(tx);
    locked();
    await released;
  });
  await holding;
  return {
    release: async () => {
      release();
      await done;
    },
  };
}

/** 锁着这条例行行不放。NO KEY UPDATE 不挡建运行记录时的外键检查。 */
function holdRoutine(routineId: string): Promise<{ release: () => Promise<void> }> {
  return holdLock((tx) => tx`SELECT id FROM routines WHERE id = ${routineId} FOR NO KEY UPDATE`);
}

/** 锁着这条 run 行不放，结账和删除都要在它上面排队。 */
function holdRun(runId: string): Promise<{ release: () => Promise<void> }> {
  return holdLock((tx) => tx`SELECT id FROM runs WHERE id = ${runId} FOR UPDATE`);
}

/** 在例行行锁上排队的 seen（按群号锁）和自停（按 id 锁）各有几条。 */
async function routineLockWaiters(): Promise<{ seen: number; autoPause: number }> {
  const rows = await database.sql<{ query: string }[]>`
    SELECT query FROM pg_stat_activity
    WHERE datname = ${database.databaseName} AND wait_event_type = 'Lock' AND query LIKE '%from "routines"%for update'`;
  const seen = rows.filter((row) => row.query.includes('"group_id"')).length;
  return { seen, autoPause: rows.length - seen };
}

async function seenRuns(routineId: string): Promise<number> {
  const rows = await database.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM routine_runs WHERE routine_id = ${routineId} AND seen_at IS NOT NULL`;
  return rows[0]?.n ?? 0;
}

describe("例行三态", () => {
  it("连续三次没人看后例行变 auto_paused 并推 routine_updated", async () => {
    const owner = await ownerWithBot();
    const agent = await online(owner);
    const push = await connectPush(server.server.port, owner.client.cookie ?? "");

    try {
      const routine = await makeRoutine(owner, { triggers: [] });
      for (const round of [1, 2, 3]) {
        expect((await owner.client.post(`/api/routines/${routine.id}/run`)).status).toBe(202);
        const prompt = await agent.expect("prompt");
        agent.send({
          type: "run_done",
          runId: prompt.runId,
          botId: owner.botId,
          groupId: owner.groupId,
          steps: 1,
          inputTokens: 10,
          outputTokens: 0,
        });
        await settled(routine.id);
        if (round < 3) expect(await stateOf(routine.id), `第 ${round} 次之后还不够三次`).toBe("on");
      }

      const paused = await untilPush(push, routinePushed(routine.id, "auto_paused"), "例行变 auto_paused");
      expect(paused.routine.runs.map((run) => run.seenAt)).toEqual([null, null, null]);
      expect(await stateOf(routine.id)).toBe("auto_paused");
    } finally {
      push.close();
      agent.close();
    }
  });

  it("中间看过一次就重新数", async () => {
    const owner = await ownerWithBot();
    const routine = await makeRoutine(owner, { triggers: [] });

    await failedTrial(owner, routine.id);
    await failedTrial(owner, routine.id);
    expect((await owner.client.post(`/api/groups/${owner.groupId}/seen`)).status).toBe(204);
    const stamped = await database.sql<{ seen_at: Date | null }[]>`
      SELECT seen_at FROM routine_runs WHERE routine_id = ${routine.id}
    `;
    expect(
      stamped.map((row) => row.seen_at !== null),
      "打开群就把已结束的都记成看过",
    ).toEqual([true, true]);

    await failedTrial(owner, routine.id);
    await failedTrial(owner, routine.id);
    expect(await stateOf(routine.id), "看过之后才两次没人看，最近三条里还有一条看过的").toBe("on");

    await failedTrial(owner, routine.id);
    expect(await stateOf(routine.id), "看过之后连着三次没人看").toBe("auto_paused");

    const stranger = await ownerWithBot();
    expect((await stranger.client.post(`/api/groups/${owner.groupId}/seen`)).status, "别人的群 404").toBe(404);
    expect((await server.client().post(`/api/groups/${owner.groupId}/seen`)).status, "没登录 401").toBe(401);
  });

  it("auto_paused 的例行到点不跑，试跑照常", async () => {
    const owner = await ownerWithBot();
    const routine = await makeRoutine(owner);
    await server.server.routines.tick();
    for (let i = 0; i < 3; i += 1) await failedTrial(owner, routine.id);
    expect(await stateOf(routine.id)).toBe("auto_paused");

    advanceOneMinute();
    await server.server.routines.tick();
    expect(await runsOf(routine.id), "到点不跑").toHaveLength(3);

    await failedTrial(owner, routine.id);
    expect(await runsOf(routine.id), "试跑照常").toHaveLength(4);
    expect(await stateOf(routine.id)).toBe("auto_paused");

    expect((await owner.client.patch(`/api/routines/${routine.id}`, { state: "paused" })).status).toBe(200);
    await failedTrial(owner, routine.id);
    expect(await stateOf(routine.id), "手动停的试跑后仍是手动停，不被改成自己停").toBe("paused");
  });

  it("webhook 打 paused 的例行回 409", async () => {
    const owner = await ownerWithBot();
    const routine = await makeRoutine(owner, { triggers: [{ kind: "webhook" }] });
    const token = webhookToken(routine);
    const stranger = server.client();

    for (let i = 0; i < 3; i += 1) await failedTrial(owner, routine.id);
    expect(await stateOf(routine.id)).toBe("auto_paused");
    expect((await stranger.post(`/api/hooks/${token}`)).status, "自己停的也挡").toBe(409);

    expect((await owner.client.patch(`/api/routines/${routine.id}`, { state: "paused" })).status).toBe(200);
    expect((await stranger.post(`/api/hooks/${token}`)).status).toBe(409);
    expect(await runsOf(routine.id), "409 就是没跑").toHaveLength(3);

    const resumed = await owner.client.patch(`/api/routines/${routine.id}`, { state: "on" });
    expect(RoutineResponse.parse(await resumed.json()).routine.state, "恢复回到 on").toBe("on");
    expect((await stranger.post(`/api/hooks/${token}`)).status).toBe(202);
  });

  it("项目归档后它的例行变 paused", async () => {
    const owner = await ownerWithBot();
    const created = CreateGroupResponse.parse(
      await (
        await owner.client.post("/api/groups", { title: "推广白泽", botIds: [owner.botId, await secondBot(owner)] })
      ).json(),
    );
    const inProject = await makeRoutine(owner, { name: "项目周报", groupId: created.group.id, triggers: [] });
    const stopped = await makeRoutine(owner, { name: "项目日报", groupId: created.group.id, triggers: [] });
    for (let i = 0; i < 3; i += 1) await failedTrial(owner, stopped.id);
    expect(await stateOf(stopped.id)).toBe("auto_paused");
    const daily = await makeRoutine(owner, { name: "日常早报", triggers: [] });
    const push = await connectPush(server.server.port, owner.client.cookie ?? "");

    try {
      expect((await owner.client.patch(`/api/tasks/${created.task.id}`, { status: "done" })).status).toBe(200);
      await untilPush(push, routinePushed(inProject.id, "paused"), "项目里的例行变 paused");
      expect(await stateOf(inProject.id)).toBe("paused");
      expect(await stateOf(stopped.id), "自己停的也一起记成手动暂停").toBe("paused");
      expect(await stateOf(daily.id), "不在这个项目里的不动").toBe("on");
    } finally {
      push.close();
    }
  });

  it("seen 先拿到例行锁，第三次收尾就不暂停", async () => {
    const owner = await ownerWithBot();
    const routine = await makeRoutine(owner, { triggers: [] });
    await failedTrial(owner, routine.id);
    await failedTrial(owner, routine.id);

    const hold = await holdRoutine(routine.id);
    const seen = owner.client.post(`/api/groups/${owner.groupId}/seen`);
    await waitUntil(async () => (await routineLockWaiters()).seen === 1, "seen 排在例行锁上");
    const third = owner.client.post(`/api/routines/${routine.id}/run`);
    await waitUntil(async () => (await routineLockWaiters()).autoPause === 1, "第三次收尾的自停排在 seen 后面");
    await hold.release();

    expect((await seen).status).toBe(204);
    expect((await third).status).toBe(202);
    expect(await seenRuns(routine.id), "seen 先锁到，三条已结束的都盖上").toBe(3);
    expect(await stateOf(routine.id), "自停锁到之后重新读，看见已读就不停").toBe("on");
  });

  it("自停先拿到例行锁就暂停，随后的 seen 只盖章", async () => {
    const owner = await ownerWithBot();
    const routine = await makeRoutine(owner, { triggers: [] });
    await failedTrial(owner, routine.id);
    await failedTrial(owner, routine.id);

    const hold = await holdRoutine(routine.id);
    const third = owner.client.post(`/api/routines/${routine.id}/run`);
    await waitUntil(async () => (await routineLockWaiters()).autoPause === 1, "第三次收尾的自停排在例行锁上");
    const seen = owner.client.post(`/api/groups/${owner.groupId}/seen`);
    await waitUntil(async () => (await routineLockWaiters()).seen === 1, "seen 排在自停后面");
    await hold.release();

    expect((await third).status).toBe(202);
    expect((await seen).status).toBe(204);
    expect(await stateOf(routine.id), "自停先锁到，三条都没人看，停下").toBe("auto_paused");
    expect(await seenRuns(routine.id), "seen 不恢复，只盖章").toBe(3);
  });

  it("删执行者后例行转给主助理", async () => {
    const owner = await ownerWithBot();
    const assistant = await assistantOf(owner);
    const daily = await makeRoutine(owner, { name: "日常早报", triggers: [] });
    const pinned = await makeRoutine(owner, { name: "单聊周报", groupId: owner.groupId, triggers: [] });
    const push = await connectPush(server.server.port, owner.client.cookie ?? "");

    try {
      expect((await owner.client.delete(`/api/bots/${owner.botId}`)).status).toBe(204);
      const moved = await untilPush(
        push,
        (one): one is Extract<ServerPush, { type: "routine_updated" }> =>
          one.type === "routine_updated" && one.routine.id === daily.id,
        "转走的例行",
      );
      expect(moved.routine.botId).toBe(assistant);

      const listed = await allRoutines(owner.client);
      expect(listed.map((one) => [one.id, one.botId, one.groupId])).toEqual([
        [daily.id, assistant, null],
        [pinned.id, assistant, null],
      ]);

      await failedTrial(owner, daily.id);
      const solo = BotListResponse.parse(await (await owner.client.get("/api/bots")).json()).items.find(
        (item) => item.bot.id === assistant,
      );
      const messages = MessageListResponse.parse(
        await (await owner.client.get(`/api/groups/${solo?.groupId}/messages`)).json(),
      ).messages.map((message) => message.body);
      expect(messages, "试跑落进主助理的单聊").toContainEqual(
        expect.objectContaining({ kind: "user", routine: { name: "日常早报" } }),
      );
    } finally {
      push.close();
    }
  });

  for (const [title, assistantAlreadyIn] of [
    ["删执行者后，主助理原来不在项目里：补进群，例行照旧发进原群", false],
    ["删执行者后，主助理已在项目里：不重复加人，例行照旧发进原群", true],
  ] as const) {
    it(title, async () => {
      const owner = await ownerWithBot();
      const assistant = await assistantOf(owner);
      const teammate = await secondBot(owner);
      const groupId = await projectGroup(
        owner,
        assistantAlreadyIn ? [owner.botId, teammate, assistant] : [owner.botId, teammate],
      );
      const weekly = await makeRoutine(owner, {
        name: "项目周报",
        groupId,
        triggers: [{ kind: "cron", expr: "* * * * *" }, { kind: "webhook" }],
      });
      await makeRoutine(owner, { name: "项目日报", groupId, triggers: [] });
      await server.server.routines.tick();

      expect((await owner.client.delete(`/api/bots/${owner.botId}`)).status).toBe(204);
      const members = await database.sql<{ bot_id: string }[]>`
        SELECT bot_id FROM group_members WHERE group_id = ${groupId} ORDER BY position`;
      expect(
        members.map((row) => row.bot_id),
        "两条例行都挂在这个群上，主助理也只在群里一次，排在原有成员后面",
      ).toEqual([teammate, assistant]);

      const agent = await online(owner);
      try {
        expect((await server.client().post(`/api/hooks/${webhookToken(weekly)}`)).status).toBe(202);
        const hooked = await agent.expect("prompt");
        expect([hooked.botId, hooked.groupId, hooked.routine], "webhook 派给主助理，发进原群").toEqual([
          assistant,
          groupId,
          { routineId: weekly.id, boundary: "draft" },
        ]);
        expect(hooked.members.map((one) => one.id)).toContain(assistant);
        agent.send({
          type: "run_done",
          runId: hooked.runId,
          botId: assistant,
          groupId,
          steps: 1,
          inputTokens: 0,
          outputTokens: 0,
        });
        await settled(weekly.id);

        advanceOneMinute();
        await server.server.routines.tick();
        const scheduled = await agent.expect("prompt");
        expect([scheduled.botId, scheduled.groupId, scheduled.routine], "到点也派给主助理，发进原群").toEqual([
          assistant,
          groupId,
          { routineId: weekly.id, boundary: "draft" },
        ]);
      } finally {
        agent.close();
      }
    });
  }

  it("例行派出的 prompt 带 boundary", async () => {
    const owner = await ownerWithBot();
    const agent = await online(owner);

    try {
      const routine = await makeRoutine(owner, { boundary: "read_only" });
      await server.server.routines.tick();
      advanceOneMinute();
      await server.server.routines.tick();
      const scheduled = await agent.expect("prompt");
      expect(scheduled.routine).toEqual({ routineId: routine.id, boundary: "read_only" });

      expect((await owner.client.post(`/api/groups/${owner.groupId}/messages`, { text: "顺手问一句" })).status).toBe(
        201,
      );
      const plain = await agent.expect("prompt");
      expect(plain.routine, "不是例行触发的不带").toBeNull();
    } finally {
      agent.close();
    }
  });
});

type Prompt = Extract<ControlToAgent, { type: "prompt" }>;
type RoutineUpdated = Extract<ServerPush, { type: "routine_updated" }>;
type GroupUpdated = Extract<ServerPush, { type: "group_updated" }>;

/** 第二个控制面实例，库连接包了一层屏障。同一个账号登进去，打到它上面的请求才会在屏障处停住。 */
async function gatedServer(owner: Owner): Promise<{
  readonly live: TestServer;
  readonly client: ApiClient;
  readonly arm: ReturnType<typeof gatedDb>["arm"];
}> {
  const gated = gatedDb(database.sql);
  const live = await startTestServer(gated.db, {}, { intervalMs: 60 * 60 * 1000 });
  const client = new ApiClient(live.server.port);
  expect((await client.login(owner.email, PASSWORD)).status).toBe(200);
  return { live, client, arm: gated.arm };
}

/** 这个库里正在等锁（行锁或 advisory）的连接数。 */
async function lockWaiters(): Promise<number> {
  const rows = await database.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname = ${database.databaseName} AND wait_event_type = 'Lock'`;
  return rows[0]?.n ?? 0;
}

/** 等这个请求要么已经回了，要么排在某把锁上。修前它不等锁直接回，修后它排队，两种世界都停在同一个地方再放行屏障。 */
async function blockedOrDone(request: Promise<Response>): Promise<void> {
  let done = false;
  request.then(
    () => (done = true),
    () => (done = true),
  );
  await waitUntil(async () => done || (await lockWaiters()) > 0, "请求回掉或排到锁上");
}

function runDone(agent: AgentClient, prompt: Prompt): void {
  agent.send({
    type: "run_done",
    runId: prompt.runId,
    botId: prompt.botId,
    groupId: prompt.groupId,
    steps: 1,
    inputTokens: 0,
    outputTokens: 0,
  });
}

/** 删 Bot 之后代理连接上还会来 config 之类的下行，跳过它们只等下一条 prompt。 */
async function nextPrompt(agent: AgentClient): Promise<Prompt> {
  for (;;) {
    const message = await agent.next();
    if (message.type === "prompt") return message;
  }
}

async function soloGroupOf(owner: Owner, botId: BotId): Promise<GroupId> {
  const entry = BotListResponse.parse(await (await owner.client.get("/api/bots")).json()).items.find(
    (item) => item.bot.id === botId,
  );
  if (entry === undefined) throw new Error("这个 Bot 不在列表里");
  return entry.groupId;
}

/** 查询库里 `pg_stat_activity` 看多行 UPDATE 是否已经改到屏障那一行并停在 advisory 上。 */
async function updateAtBarrier(prefix: string): Promise<boolean> {
  const rows = await database.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname = ${database.databaseName} AND wait_event = 'advisory' AND query LIKE ${`${prefix}%`}`;
  return (rows[0]?.n ?? 0) > 0;
}

const BARRIER_KEY = 174012389;

/**
 * 进度屏障：BEFORE UPDATE 触发器在 `condition` 成立的那一行上等一把 advisory 锁，多行 UPDATE 改到那一行就停住，
 * 交错因此钉在这一步。触发器不改锁模式也不改产品状态，用例结束删掉。
 */
async function withUpdateBarrier(
  condition: string,
  body: (release: () => Promise<void>) => Promise<void>,
): Promise<void> {
  await database.sql.unsafe(
    `CREATE FUNCTION fix2_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN IF ${condition} THEN PERFORM pg_advisory_xact_lock(${BARRIER_KEY}); END IF; RETURN NEW; END $$`,
  );
  await database.sql.unsafe(
    "CREATE TRIGGER fix2_barrier BEFORE UPDATE ON routines FOR EACH ROW EXECUTE FUNCTION fix2_barrier()",
  );
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  let locked!: () => void;
  const holding = new Promise<void>((resolve) => (locked = resolve));
  const holder = database.sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${BARRIER_KEY})`;
    locked();
    await opened;
  });
  await holding;
  const release = async () => {
    open();
    await holder;
  };
  try {
    await body(release);
  } finally {
    await release();
    await database.sql.unsafe("DROP TRIGGER fix2_barrier ON routines");
    await database.sql.unsafe("DROP FUNCTION fix2_barrier()");
  }
}

/** 两条例行固定成物理顺序高 id 在前、低 id 在后，多行 UPDATE 按扫描顺序先碰高 id，和 seen 的 id 升序相反。 */
async function twoRoutinesHighThenLow(owner: Owner, groupId: GroupId, suffix: string): Promise<[string, string]> {
  const first = await makeRoutine(owner, { name: "高 id", groupId, triggers: [] });
  const second = await makeRoutine(owner, { name: "低 id", groupId, triggers: [] });
  const high = `ffffffff-ffff-4fff-8fff-fffffffffff${suffix}`;
  const low = `00000000-0000-4000-8000-00000000000${suffix}`;
  await database.sql`UPDATE routines SET id = ${high} WHERE id = ${first.id}`;
  await database.sql`UPDATE routines SET id = ${low} WHERE id = ${second.id}`;
  return [high, low];
}

const fresh = { name: "并发新建", instruction: "汇总", triggers: [], onFailure: "stop_and_tell" } as const;

describe("修复二轮：删执行者和建例行、触发、归档、看过的边界", () => {
  it("建例行先拿到执行者的锁：删除等它提交，新例行一起转给主助理", async () => {
    const owner = await ownerWithBot();
    const assistant = await assistantOf(owner);
    const gated = await gatedServer(owner);
    const gate = gated.arm(/insert into "routines"/i, "after");
    let creating: Promise<Response> | undefined;
    let deleting: Promise<Response> | undefined;
    try {
      creating = gated.client.post(`/api/bots/${owner.botId}/routines`, fresh);
      await gate.reached;
      deleting = owner.client.delete(`/api/bots/${owner.botId}`);
      await blockedOrDone(deleting);
      gate.release();
      const created = await creating;
      expect(created.status).toBe(201);
      const routine = RoutineResponse.parse(await created.json()).routine;
      expect((await deleting).status).toBe(204);
      expect(
        (await allRoutines(owner.client)).map((one) => [one.id, one.botId]),
        "回了 201 的例行不能丢，转交扫描看得见它",
      ).toEqual([[routine.id, assistant]]);
    } finally {
      gate.release();
      await Promise.allSettled([creating, deleting].filter((one) => one !== undefined));
      await gated.live.close();
    }
  });

  it("删除先转交再提交，期间来的建例行等它提交后得到 404，不会凭空多出一条又被级联删掉", async () => {
    const owner = await ownerWithBot();
    const assistant = await assistantOf(owner);
    const old = await makeRoutine(owner, { triggers: [] });
    const gated = await gatedServer(owner);
    const gate = gated.arm(/update "routines" set "bot_id"/i, "after");
    let deleting: Promise<Response> | undefined;
    let creating: Promise<Response> | undefined;
    try {
      deleting = gated.client.delete(`/api/bots/${owner.botId}`);
      await gate.reached;
      creating = owner.client.post(`/api/bots/${owner.botId}/routines`, fresh);
      await blockedOrDone(creating);
      gate.release();
      expect((await deleting).status).toBe(204);
      expect((await creating).status, "删除已经赢了，建例行要被明确拒绝").toBe(404);
      expect((await allRoutines(owner.client)).map((one) => [one.id, one.botId])).toEqual([[old.id, assistant]]);
    } finally {
      gate.release();
      await Promise.allSettled([deleting, creating].filter((one) => one !== undefined));
      await gated.live.close();
    }
  });

  it("建例行的归属预检过了之后 Bot 被删完：回 404 而不是外键 500", async () => {
    const owner = await ownerWithBot();
    const gated = await gatedServer(owner);
    const gate = gated.arm(/select .*from "bots" where/i, "after");
    let creating: Promise<Response> | undefined;
    try {
      creating = gated.client.post(`/api/bots/${owner.botId}/routines`, fresh);
      await gate.reached;
      expect((await owner.client.delete(`/api/bots/${owner.botId}`)).status).toBe(204);
      gate.release();
      expect((await creating).status).toBe(404);
      expect(await allRoutines(owner.client)).toEqual([]);
    } finally {
      gate.release();
      await Promise.allSettled([creating].filter((one) => one !== undefined));
      await gated.live.close();
    }
  });

  it("执行途中删执行者：运行记录当场收成失败并推 routine_updated，迟到的 run_done 不改它", async () => {
    const owner = await ownerWithBot();
    const assistant = await assistantOf(owner);
    const routine = await makeRoutine(owner, { triggers: [] });
    const agent = await online(owner);
    const push = await connectPush(server.server.port, owner.client.cookie ?? "");
    try {
      expect((await owner.client.post(`/api/routines/${routine.id}/run`)).status).toBe(202);
      const prompt = await agent.expect("prompt");
      expect((await owner.client.delete(`/api/bots/${owner.botId}`)).status).toBe(204);
      const failed = await untilPush(
        push,
        (one): one is RoutineUpdated =>
          one.type === "routine_updated" && one.routine.id === routine.id && one.routine.runs[0]?.status === "failed",
        "收成失败的例行",
      );
      expect(failed.routine.runs[0]?.note).toBe(EXECUTOR_DELETED_NOTE);
      expect(failed.routine.botId).toBe(assistant);

      runDone(agent, prompt);
      // 主助理单聊里走一条完整的 prompt、run_done、ack 当处理屏障：迟到的 run_done 在它前面，已经被丢掉了。
      const solo = await soloGroupOf(owner, assistant);
      expect((await owner.client.post(`/api/groups/${solo}/messages`, { text: "屏障" })).status).toBe(201);
      const barrier = await nextPrompt(agent);
      runDone(agent, barrier);
      await agent.ack(barrier.runId);
      expect(
        agent.uplinkAcks().flatMap((ack) => ack.rejected),
        "迟到的可靠 run_done 被拒收",
      ).toContainEqual({
        seq: 1,
        code: "invalid",
        runId: prompt.runId,
      });
      expect((await runsOf(routine.id)).map((row) => [row.status, row.note])).toEqual([
        ["failed", "执行者已删除，这次没跑完"],
      ]);
    } finally {
      push.close();
      agent.close();
    }
  });

  it("webhook 读到旧执行者的单聊之后删除先提交：按转交后的执行者和群派发，不留没有 run 的 running", async () => {
    const owner = await ownerWithBot();
    const assistant = await assistantOf(owner);
    const routine = await makeRoutine(owner, { groupId: owner.groupId, triggers: [{ kind: "webhook" }] });
    const gated = await gatedServer(owner);
    // 第一条是按 token 找例行，第二条才是触发事务里拿锁之前那次读；停在第二条，删除就赶在它拿锁之前提交。
    const byToken = gated.arm(/select .*from "routines" inner join "bots"/i, "after");
    let gate = byToken;
    let hooking: Promise<Response> | undefined;
    try {
      hooking = gated.client.post(`/api/hooks/${webhookToken(routine)}`);
      await byToken.reached;
      gate = gated.arm(/select .*from "routines" inner join "bots"/i, "after");
      byToken.release();
      await gate.reached;
      expect((await owner.client.delete(`/api/bots/${owner.botId}`)).status).toBe(204);
      gate.release();
      expect((await hooking).status).toBe(202);
      expect(
        (await runsOf(routine.id)).map((row) => row.status),
        "电脑不在线，派不出去当场记失败",
      ).toEqual(["failed"]);
      const solo = await soloGroupOf(owner, assistant);
      const bodies = MessageListResponse.parse(
        await (await owner.client.get(`/api/groups/${solo}/messages`)).json(),
      ).messages.map((message) => message.body);
      expect(bodies, "那次运行落进主助理的单聊").toContainEqual(
        expect.objectContaining({ kind: "user", routine: { name: "每日工单早报" } }),
      );
    } finally {
      gate.release();
      await Promise.allSettled([hooking].filter((one) => one !== undefined));
      await gated.live.close();
    }
  });

  it("触发先建了运行记录再删执行者：删除等触发提交，记录由删除收成失败", async () => {
    const owner = await ownerWithBot();
    const routine = await makeRoutine(owner, { triggers: [{ kind: "webhook" }] });
    const gated = await gatedServer(owner);
    const { agent } = await helloAgent(gated.live.server.port, owner.computer.computerId, owner.computer.token);
    const gate = gated.arm(/insert into "routine_runs"/i, "after");
    let hooking: Promise<Response> | undefined;
    let deleting: Promise<Response> | undefined;
    try {
      hooking = gated.client.post(`/api/hooks/${webhookToken(routine)}`);
      await gate.reached;
      deleting = owner.client.delete(`/api/bots/${owner.botId}`);
      await blockedOrDone(deleting);
      gate.release();
      expect((await hooking).status).toBe(202);
      expect((await deleting).status).toBe(204);
      await settled(routine.id);
      expect((await runsOf(routine.id)).map((row) => [row.status, row.note])).toEqual([
        ["failed", EXECUTOR_DELETED_NOTE],
      ]);
    } finally {
      gate.release();
      await Promise.allSettled([hooking, deleting].filter((one) => one !== undefined));
      agent.close();
      await gated.live.close();
    }
  });

  it("归档和看过对同两条例行反序交错：归档先按 id 升序锁行，两边都不报 40P01", async () => {
    const owner = await ownerWithBot();
    const created = CreateGroupResponse.parse(
      await (
        await owner.client.post("/api/groups", { title: "多例行锁序", botIds: [owner.botId, await secondBot(owner)] })
      ).json(),
    );
    const [high] = await twoRoutinesHighThenLow(owner, created.group.id, "1");
    let archive: Promise<Response> | undefined;
    let seen: Promise<Response> | undefined;
    await withUpdateBarrier(`NEW.id = '${high}' AND NEW.state = 'paused'`, async (release) => {
      try {
        archive = owner.client.patch(`/api/tasks/${created.task.id}`, { status: "done" });
        await waitUntil(() => updateAtBarrier('update "routines" set "state"'), "归档改到高 id 那一行停在屏障上");
        seen = owner.client.post(`/api/groups/${created.group.id}/seen`);
        await waitUntil(async () => (await routineLockWaiters()).seen === 1, "看过排在例行行锁上");
        await release();
        expect((await Promise.all([archive, seen])).map((one) => one.status)).toEqual([200, 204]);
      } finally {
        await release();
        await Promise.allSettled([archive, seen].filter((one) => one !== undefined));
      }
    });
    expect(await stateOf(high)).toBe("paused");
  });

  it("转交和看过对同两条例行反序交错：转交先按 id 升序锁行，两边都不报 40P01", async () => {
    const owner = await ownerWithBot();
    const assistant = await assistantOf(owner);
    const groupId = await projectGroup(owner, [owner.botId, await secondBot(owner)]);
    const [high, low] = await twoRoutinesHighThenLow(owner, groupId, "3");
    let deleting: Promise<Response> | undefined;
    let seen: Promise<Response> | undefined;
    await withUpdateBarrier(`NEW.id = '${high}' AND NEW.bot_id <> OLD.bot_id`, async (release) => {
      try {
        deleting = owner.client.delete(`/api/bots/${owner.botId}`);
        await waitUntil(() => updateAtBarrier('update "routines" set "bot_id"'), "转交改到高 id 那一行停在屏障上");
        seen = owner.client.post(`/api/groups/${groupId}/seen`);
        await waitUntil(async () => (await routineLockWaiters()).seen === 1, "看过排在例行行锁上");
        await release();
        expect((await Promise.all([deleting, seen])).map((one) => one.status)).toEqual([204, 204]);
      } finally {
        await release();
        await Promise.allSettled([deleting, seen].filter((one) => one !== undefined));
      }
    });
    expect((await allRoutines(owner.client)).map((one) => [one.id, one.botId])).toEqual([
      [high, assistant],
      [low, assistant],
    ]);
  });

  it("删执行者后，补进主助理和卸了首席的项目群各推一条 group_updated，同账号两条连接都收到", async () => {
    const owner = await ownerWithBot();
    const assistant = await assistantOf(owner);
    const teammate = await secondBot(owner);
    const joined = await projectGroup(owner, [owner.botId, teammate]);
    await makeRoutine(owner, { name: "项目周报", groupId: joined, triggers: [] });
    const chaired = await projectGroup(owner, [owner.botId, teammate]);
    await database.sql`UPDATE groups SET chief_bot_id = ${owner.botId} WHERE id = ${chaired}`;
    const untouched = await projectGroup(owner, [owner.botId, teammate, assistant]);
    const windows = [
      await connectPush(server.server.port, owner.client.cookie ?? ""),
      await connectPush(server.server.port, owner.client.cookie ?? ""),
    ];
    try {
      expect((await owner.client.delete(`/api/bots/${owner.botId}`)).status).toBe(204);
      for (const push of windows) {
        const updates = new Map<string, GroupUpdated["group"]>();
        while (updates.size < 2) {
          const one = await untilPush(push, (event): event is GroupUpdated => event.type === "group_updated", "群快照");
          updates.set(one.group.id, one.group);
        }
        expect(updates.get(joined)?.botIds, "补进主助理的群带提交后的成员").toEqual([teammate, assistant]);
        expect([updates.get(chaired)?.botIds, updates.get(chaired)?.chiefBotId], "首席被删的群首席清空").toEqual([
          [teammate],
          null,
        ]);
        expect(updates.has(untouched), "成员和首席都没变的群不推").toBe(false);
      }
    } finally {
      for (const push of windows) push.close();
    }
  });
});

/** 清掉上一条用例留下的触发器和函数：BEFORE INSERT ON runs 只对这个 Bot 的例行 run 抛错，用户消息的 run 不受影响。 */
async function withRunInsertFailure(botId: BotId, body: () => Promise<void>): Promise<void> {
  await database.sql.unsafe(
    `CREATE FUNCTION fix3_run_failure() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN IF NEW.routine_run_id IS NOT NULL AND NEW.bot_id = '${botId}' THEN RAISE EXCEPTION '建 run 故障'; END IF; RETURN NEW; END $$`,
  );
  await database.sql.unsafe(
    "CREATE TRIGGER fix3_run_failure BEFORE INSERT ON runs FOR EACH ROW EXECUTE FUNCTION fix3_run_failure()",
  );
  try {
    await body();
  } finally {
    await database.sql.unsafe("DROP TRIGGER fix3_run_failure ON runs");
    await database.sql.unsafe("DROP FUNCTION fix3_run_failure()");
  }
}

describe("修复三轮：删执行者和结账、派发失败、自停的边界", () => {
  it("信封结束、结账和游标同事务，删执行者等事务提交后完成且不死锁", async () => {
    const owner = await ownerWithBot();
    const groupId = await projectGroup(owner, [owner.botId, await secondBot(owner)]);
    const routine = await makeRoutine(owner, { groupId, triggers: [] });
    const charging = await gatedServer(owner);
    const deleting = await gatedServer(owner);
    const { agent } = await helloAgent(charging.live.server.port, owner.computer.computerId, owner.computer.token);
    let claimGate: ReturnType<typeof charging.arm> | undefined;
    let deletion: Promise<Response> | undefined;
    let deleted = false;
    try {
      expect((await charging.client.post(`/api/routines/${routine.id}/run`)).status).toBe(202);
      const prompt = await agent.expect("prompt");
      claimGate = charging.arm(/from "runs" where "runs"\."id" in .*for update/i, "before");
      runDone(agent, prompt);
      await claimGate.reached;
      const [ended] = await database.sql<
        { ended_at: Date | null; charged_at: Date | null }[]
      >`SELECT ended_at, charged_at FROM runs WHERE id = ${prompt.runId}`;
      expect([ended?.ended_at !== null, ended?.charged_at], "结束和结账都尚未提交").toEqual([false, null]);
      deletion = deleting.client.delete(`/api/bots/${owner.botId}`).then((response) => {
        deleted = true;
        return response;
      });
      await waitUntil(async () => deleted || (await lockWaiters()) > 0, "删除等待信封事务持有的例行锁");
      expect(deleted).toBe(false);
      claimGate.release();
      await agent.ack(prompt.runId);
      expect((await deletion).status, "删除不报 40P01").toBe(204);
      const [run] = await database.sql<
        { charged_at: Date | null }[]
      >`SELECT charged_at FROM runs WHERE id = ${prompt.runId}`;
      expect(run?.charged_at).not.toBeNull();
      const [record] = await runsOf(routine.id);
      expect(record?.status, "已完成的记录不因后来的删除改回失败").toBe("ok");
      expect(record?.note).toContain("¥");
    } finally {
      claimGate?.release();
      await Promise.allSettled([deletion].filter((one) => one !== undefined));
      agent.close();
      await charging.live.close();
      await deleting.live.close();
    }
  });

  it("建 run 的事务抛错：派发把失败传回例行，记录收成 failed，三次没人看就自己停", async () => {
    const owner = await ownerWithBot();
    const routine = await makeRoutine(owner, { triggers: [] });
    const agent = await online(owner);
    try {
      await withRunInsertFailure(owner.botId, async () => {
        const statuses: number[] = [];
        for (let i = 0; i < 3; i += 1)
          statuses.push((await owner.client.post(`/api/routines/${routine.id}/run`)).status);
        expect(statuses).toEqual([202, 202, 202]);
      });
      expect((await runsOf(routine.id)).map((one) => [one.status, one.note])).toEqual([
        ["failed", DISPATCH_FAILED_NOTE],
        ["failed", DISPATCH_FAILED_NOTE],
        ["failed", DISPATCH_FAILED_NOTE],
      ]);
      expect(await stateOf(routine.id)).toBe("auto_paused");
    } finally {
      agent.close();
    }
  });

  it("删执行者把第三条没人看的记录收成 failed，例行跟着自己停", async () => {
    const owner = await ownerWithBot();
    const routine = await makeRoutine(owner, { triggers: [] });
    await failedTrial(owner, routine.id);
    await failedTrial(owner, routine.id);
    const agent = await online(owner);
    try {
      expect((await owner.client.post(`/api/routines/${routine.id}/run`)).status).toBe(202);
      await agent.expect("prompt");
      expect((await owner.client.delete(`/api/bots/${owner.botId}`)).status).toBe(204);
      expect((await runsOf(routine.id)).map((one) => one.status)).toEqual(["failed", "failed", "failed"]);
      expect(await stateOf(routine.id)).toBe("auto_paused");
    } finally {
      agent.close();
    }
  });

  it("记录落了之后派发抛错：收成 failed 之外还要自己停并推快照，错误照旧报 500", async () => {
    const owner = await ownerWithBot();
    const routine = await makeRoutine(owner, { triggers: [] });
    let faults = 0;
    // 派发开头查单聊那条语句抛错，openRoutineRun 的事务已经提交，正好落在 catch 分支。
    const faultSql = new Proxy(database.sql, {
      get(target, prop) {
        if (prop === "unsafe") {
          return (query: string, ...args: unknown[]) => {
            if (faults > 0 && /select .*"solo_bot_id".*from "groups"/i.test(query)) {
              faults -= 1;
              const rejection = Promise.reject(new Error("派发前查群故障"));
              return Object.assign(rejection, { values: () => rejection });
            }
            return Reflect.apply(target.unsafe, target, [query, ...args]);
          };
        }
        const value: unknown = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const live = await startTestServer(drizzle(faultSql, { schema }), {}, { intervalMs: 60 * 60 * 1000 });
    const client = new ApiClient(live.server.port);
    expect((await client.login(owner.email, PASSWORD)).status).toBe(200);
    const push = await connectPush(live.server.port, client.cookie ?? "");
    try {
      faults = 3;
      const statuses: number[] = [];
      for (let i = 0; i < 3; i += 1) statuses.push((await client.post(`/api/routines/${routine.id}/run`)).status);
      expect([statuses, faults]).toEqual([[500, 500, 500], 0]);
      expect((await runsOf(routine.id)).map((one) => [one.status, one.note])).toEqual([
        ["failed", DISPATCH_FAILED_NOTE],
        ["failed", DISPATCH_FAILED_NOTE],
        ["failed", DISPATCH_FAILED_NOTE],
      ]);
      expect(await stateOf(routine.id)).toBe("auto_paused");
      await untilPush(push, routinePushed(routine.id, "auto_paused"), "自己停下的快照");
    } finally {
      push.close();
      await live.close();
    }
  });

  it("同一次扫描里两个同刻 cron：第三条收尾自停之后第二个触发器不再跑第四条", async () => {
    const owner = await ownerWithBot();
    const routine = await makeRoutine(owner, {
      triggers: [
        { kind: "cron", expr: "* * * * *" },
        { kind: "cron", expr: "* * * * *" },
      ],
    });
    await failedTrial(owner, routine.id);
    await failedTrial(owner, routine.id);
    await server.server.routines.tick();
    advanceOneMinute();
    await server.server.routines.tick();
    expect(await stateOf(routine.id)).toBe("auto_paused");
    expect(await runsOf(routine.id), "第三条收尾即停，第四条不出生").toHaveLength(3);
  });
});

/** 这个库里停在某条 SQL 上等锁的连接有没有。 */
async function lockWaiterOn(fragment: string): Promise<boolean> {
  const rows = await database.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname = ${database.databaseName} AND wait_event_type = 'Lock' AND query LIKE ${`%${fragment}%`}`;
  return (rows[0]?.n ?? 0) > 0;
}

type HeldPassScene = {
  readonly owner: Owner;
  readonly charging: Awaited<ReturnType<typeof gatedServer>>;
  readonly agent: AgentClient;
  readonly held: Prompt;
  readonly current: Prompt;
};

/**
 * 多 Bot 群里小服先回 (pass)（账先记着），小内接着跑，用户再 @小服 得到一条新结果 run。
 * 死锁要靠两行的锁序反过来，而 run 的 id 是随机 UUID，所以重搭到要的 id 顺序为止。
 * held_first：先记着的那条 id 在前，删除按 id 升序先锁它，结账若先认领当前这条就反序了。
 * current_first：当前这条 id 在前，结账按 id 升序先锁它，删除若按物理顺序扫（先记着的那条先落盘）就反序了。
 */
async function heldPassScene(order: "held_first" | "current_first"): Promise<HeldPassScene> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const owner = await ownerWithBot();
    const other = await secondBot(owner);
    const groupId = await projectGroup(owner, [owner.botId, other]);
    const charging = await gatedServer(owner);
    const { agent } = await helloAgent(charging.live.server.port, owner.computer.computerId, owner.computer.token);
    expect((await charging.client.post(`/api/groups/${groupId}/messages`, { text: "@小服 @小内 初轮" })).status).toBe(
      201,
    );
    const held = await nextPrompt(agent);
    expect(held.botId).toBe(owner.botId);
    agent.send({
      type: "bot_text",
      runId: held.runId,
      botId: held.botId,
      groupId,
      messageId: MessageId.parse(randomUUID()),
      delta: "(pass)",
      done: true,
    });
    runDone(agent, held);
    await agent.ack(held.runId);
    expect((await nextPrompt(agent)).botId).toBe(other);
    const [row] = await database.sql<{ ended_at: Date | null; charged_at: Date | null }[]>`
      SELECT ended_at, charged_at FROM runs WHERE id = ${held.runId}`;
    expect([row?.ended_at !== null, row?.charged_at], "pass 已结束、账先记着").toEqual([true, null]);
    expect((await charging.client.post(`/api/groups/${groupId}/messages`, { text: "@小服 新轮" })).status).toBe(201);
    const current = await nextPrompt(agent);
    expect(current.botId).toBe(owner.botId);
    if (held.runId < current.runId === (order === "held_first")) return { owner, charging, agent, held, current };
    agent.close();
    await charging.live.close();
  }
  throw new Error(`十二次都没搭出 ${order} 的 id 顺序`);
}

async function twoCronsAligned(owner: Owner): Promise<Routine> {
  const routine = await makeRoutine(owner, {
    triggers: [
      { kind: "cron", expr: "* * * * *" },
      { kind: "cron", expr: "* * * * *" },
    ],
  });
  await server.server.routines.tick();
  return routine;
}

describe("修复四轮：多条待结账 run 的锁序、同刻两个 cron 的串行边界", () => {
  it("同 Bot 多条已结束未结账的 run：结账先持当前这条时删除排队，放行后删除 204，两条都结了账", async () => {
    const scene = await heldPassScene("held_first");
    const { owner, charging, agent, held, current } = scene;
    let gate: ReturnType<typeof charging.arm> | undefined;
    let deletion: Promise<Response> | undefined;
    try {
      gate = charging.arm(/update "runs" set "charged_at"/i, "after");
      runDone(agent, current);
      await gate.reached;
      deletion = owner.client.delete(`/api/bots/${owner.botId}`);
      await waitUntil(() => lockWaiterOn("SELECT pg_advisory_xact_lock("), "删除在 Bot 排他锁处等结账提交");
      gate.release();
      expect((await deletion).status, "删除和多行结账都要成功，不报 40P01").toBe(204);
      await agent.ack(current.runId);
      const rows = await database.sql<{ id: string; charged_at: Date | null; bot_id: string | null }[]>`
        SELECT id, charged_at, bot_id FROM runs WHERE id IN (${held.runId}, ${current.runId}) ORDER BY id`;
      expect(
        rows.map((row) => [row.charged_at !== null, row.bot_id]),
        "先记着的 pass 和当前结果都结了账",
      ).toEqual([
        [true, null],
        [true, null],
      ]);
    } finally {
      gate?.release();
      await Promise.allSettled([deletion].filter((one) => one !== undefined));
      agent.close();
      await charging.live.close();
    }
  });

  it("当前这条 id 在前：结账和删除都在它上面排队，先排上的结账拿到它之后删除不能已经持有先记着的那条", async () => {
    const scene = await heldPassScene("current_first");
    const { owner, charging, agent, held, current } = scene;
    let hold: Awaited<ReturnType<typeof holdRun>> | undefined;
    let deletion: Promise<Response> | undefined;
    const gate = charging.arm(/from "runs" where "runs"\."id" in .*for update/i, "before");
    try {
      // 收尾那条 UPDATE 先提交，结账事务停在锁行语句之前，这时才扣住当前这条，结账醒来就在它上面排队。
      runDone(agent, current);
      await gate.reached;
      hold = await holdRun(current.runId);
      gate.release();
      await waitUntil(() => lockWaiterOn('"runs"."id" in'), "结账在当前这条 run 上排队");
      deletion = owner.client.delete(`/api/bots/${owner.botId}`);
      await waitUntil(() => lockWaiterOn("SELECT pg_advisory_xact_lock("), "删除在 Bot 排他锁处排在结账后面");
      // 结账停在当前 run，删除更早停在 Bot 锁；删除尚未锁住另一条待结账的行。
      const free = await database.sql`SELECT id FROM runs WHERE id = ${held.runId} FOR UPDATE SKIP LOCKED`;
      expect(free.length, "删除排队时还没持有先记着的那条").toBe(1);
      await hold.release();
      expect((await deletion).status, "删除和多行结账都要成功，不报 40P01").toBe(204);
      await agent.ack(current.runId);
      const rows = await database.sql<{ id: string; charged_at: Date | null; bot_id: string | null }[]>`
        SELECT id, charged_at, bot_id FROM runs WHERE id IN (${held.runId}, ${current.runId}) ORDER BY id`;
      expect(
        rows.map((row) => [row.charged_at !== null, row.bot_id]),
        "先记着的 pass 和当前结果都结了账",
      ).toEqual([
        [true, null],
        [true, null],
      ]);
    } finally {
      gate.release();
      await hold?.release();
      await Promise.allSettled([deletion].filter((one) => one !== undefined));
      agent.close();
      await charging.live.close();
    }
  });

  it("两个调度器各认领同刻的一个 cron：第三条还在跑时第二个触发器不落第四条，收尾后自停，恰好三条", async () => {
    const owner = await ownerWithBot();
    const routine = await twoCronsAligned(owner);
    await failedTrial(owner, routine.id);
    await failedTrial(owner, routine.id);
    const gated = gatedDb(database.sql);
    const live = await startTestServer(gated.db, {}, { now: () => clock, intervalMs: 60 * 60 * 1000 });
    // 第一个调度器的第三条记录和消息已提交、派发查群已跑完但还没返回，记录还是 running。
    // 一次扫描会碰到这个库里别的用例留下的例行，拦的得是查这条例行所在群的那一次。
    const gate = gated.arm(/select .*"solo_bot_id".*from "groups"/i, "after", owner.groupId);
    let first: Promise<void> | undefined;
    try {
      advanceOneMinute();
      first = live.server.routines.tick();
      await gate.reached;
      await server.server.routines.tick();
      expect(
        (await runsOf(routine.id)).map((one) => one.status),
        "同一刻第二个触发器不再落一条",
      ).toEqual(["failed", "failed", "running"]);
      expect(await stateOf(routine.id), "第三条还没收尾，不该停").toBe("on");
      gate.release();
      await first;
      expect((await runsOf(routine.id)).map((one) => one.status)).toEqual(["failed", "failed", "failed"]);
      expect(await stateOf(routine.id)).toBe("auto_paused");
      const fired = (await storedTriggers(routine.id)).map((one) => (one.kind === "cron" ? one.lastFiredAt : null));
      expect(fired[0], "两个游标都推到了这一刻").toBe(fired[1]);
    } finally {
      gate.release();
      await Promise.allSettled([first].filter((one) => one !== undefined));
      await live.close();
    }
  });

  it("两个调度器同刻各认领一个 cron：后到的在例行行锁上等先到的提交，看见同刻已有记录就不再落第二条", async () => {
    const owner = await ownerWithBot();
    const routine = await twoCronsAligned(owner);
    const gated = gatedDb(database.sql);
    const live = await startTestServer(gated.db, {}, { now: () => clock, intervalMs: 60 * 60 * 1000 });
    // 派活的是先到的那个控制面，电脑连到它上面。
    const { agent } = await helloAgent(live.server.port, owner.computer.computerId, owner.computer.token);
    const gate = gated.arm(/insert into "routine_runs"/i, "before", routine.id);
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    try {
      advanceOneMinute();
      first = live.server.routines.tick();
      await gate.reached;
      second = server.server.routines.tick();
      // 先到的事务一直锁着例行行到提交，后到的推游标那条 UPDATE 就在这一行上排队。
      await waitUntil(() => lockWaiterOn('"routines"'), "第二个触发器在例行行锁上排队");
      gate.release();
      await Promise.all([first, second]);
      expect(
        (await runsOf(routine.id)).map((one) => one.status),
        "同一刻只落一条",
      ).toEqual(["running"]);
      const prompt = await agent.expect("prompt");
      runDone(agent, prompt);
      await agent.ack(prompt.runId);
      expect((await runsOf(routine.id)).map((one) => one.status)).toEqual(["ok"]);
    } finally {
      gate.release();
      await Promise.allSettled([first, second].filter((one) => one !== undefined));
      agent.close();
      await live.close();
    }
  });
});

/** 这个群里落了多少条消息。例行重复触发会多落两条，直接数表，不受分页影响。 */
async function messageCount(groupId: GroupId): Promise<number> {
  const rows = await database.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM messages WHERE group_id = ${groupId}`;
  return rows[0]?.n ?? 0;
}

type OldestChargingScene = {
  readonly routine: Routine;
  readonly charging: Awaited<ReturnType<typeof gatedServer>>;
  readonly agent: AgentClient;
  readonly oldest: Prompt;
  readonly gate: QueryGate;
};

/**
 * 20 条运行记录：最早那条遇到审批停成 stopped，后面 19 条还在跑。最早那条的 run 随后收尾，
 * 结账事务锁住它的 run 行之后停住：下一个碰这条记录的事务（第 21 次试跑的裁剪、删整条例行的级联）都要在这一行上排队，
 * 放行后结账还要改这条记录，先持记录再等 run 的就和它互等。
 */
async function oldestChargingScene(): Promise<OldestChargingScene> {
  const owner = await ownerWithBot();
  const routine = await makeRoutine(owner, { triggers: [], onFailure: "stop_and_tell" });
  const charging = await gatedServer(owner);
  const { agent } = await helloAgent(charging.live.server.port, owner.computer.computerId, owner.computer.token);
  expect((await charging.client.post(`/api/routines/${routine.id}/run`)).status).toBe(202);
  const oldest = await nextPrompt(agent);
  agent.send({
    type: "approval_request",
    runId: oldest.runId,
    botId: owner.botId,
    groupId: owner.groupId,
    callId: "call-1",
    tool: "send_email",
    action: "message_person",
    target: null,
    view: { kind: "mcp", server: "", tool: "send_email", params: [], raw: "给客户发一封邮件" },
  });
  await settled(routine.id);
  for (let i = 1; i < MAX_ROUTINE_RUNS; i += 1) {
    expect((await charging.client.post(`/api/routines/${routine.id}/run`)).status).toBe(202);
    await nextPrompt(agent);
  }
  const records = await runsOf(routine.id);
  expect(
    records.map((one) => one.status),
    "最早的停下等点头，其余还在跑",
  ).toEqual(["stopped", ...Array.from({ length: MAX_ROUTINE_RUNS - 1 }, () => "running")]);
  const gate = charging.arm(/from "runs" where "runs"\."id" in .*for update/i, "after");
  runDone(agent, oldest);
  await gate.reached;
  return { routine, charging, agent, oldest, gate };
}

describe("修复五轮：裁剪和删例行经外键改 runs 的锁序、同刻查重凭据不随裁剪消失", () => {
  it("第 21 次试跑裁掉最早那条记录时，它的 run 正在结账：裁剪先锁 run 再删记录，试跑 202、结账照常回 ack", async () => {
    const { routine, charging, agent, oldest, gate } = await oldestChargingScene();
    let trial: Promise<Response> | undefined;
    try {
      const [retired] = await runsOf(routine.id);
      trial = charging.client.post(`/api/routines/${routine.id}/run`);
      await waitUntil(async () => (await lockWaiters()) > 0, "第 21 次试跑的裁剪在最早那条的 run 行上排队");
      gate.release();
      const ack = agent.ack(oldest.runId).then(
        () => true,
        () => false,
      );
      expect([(await trial).status, await ack], "裁剪和结账都要成功，不报 40P01").toEqual([202, true]);
      const rows = await runsOf(routine.id);
      expect(rows, "只留最近 20 条").toHaveLength(MAX_ROUTINE_RUNS);
      expect(rows.map((one) => one.id)).not.toContain(retired?.id);
      const [run] = await database.sql<{ charged_at: Date | null; routine_run_id: string | null }[]>`
        SELECT charged_at, routine_run_id FROM runs WHERE id = ${oldest.runId}`;
      expect([run?.charged_at !== null, run?.routine_run_id], "账结了，记录裁掉后 run 不再指着它").toEqual([
        true,
        null,
      ]);
    } finally {
      gate.release();
      await Promise.allSettled([trial].filter((one) => one !== undefined));
      agent.close();
      await charging.live.close();
    }
  });

  it("删整条例行时最早那条记录的 run 正在结账：删除先锁它的 run 再级联，删除 204、结账照常回 ack", async () => {
    const { routine, charging, agent, oldest, gate } = await oldestChargingScene();
    let deletion: Promise<Response> | undefined;
    try {
      deletion = charging.client.delete(`/api/routines/${routine.id}`);
      // 修前级联的外键更新等在 run 行上，修后先锁 run 的那句等在同一行上，两种世界 pg_stat_activity 里都是一条等锁的。
      await waitUntil(async () => (await lockWaiters()) > 0, "删除在最早那条的 run 行上排队");
      gate.release();
      const ack = agent.ack(oldest.runId).then(
        () => true,
        () => false,
      );
      expect([(await deletion).status, await ack], "删除和结账都要成功，不报 40P01").toEqual([204, true]);
      expect(await runsOf(routine.id)).toHaveLength(0);
      const [run] = await database.sql<{ charged_at: Date | null; routine_run_id: string | null }[]>`
        SELECT charged_at, routine_run_id FROM runs WHERE id = ${oldest.runId}`;
      expect([run?.charged_at !== null, run?.routine_run_id]).toEqual([true, null]);
    } finally {
      gate.release();
      await Promise.allSettled([deletion].filter((one) => one !== undefined));
      agent.close();
      await charging.live.close();
    }
  });

  it("还在跑的记录不裁：第 21 次试跑照常派出去，21 条都在，列表仍只给最近 20 条", async () => {
    const owner = await ownerWithBot();
    const agent = await online(owner);
    try {
      const routine = await makeRoutine(owner, { triggers: [] });
      for (let i = 0; i <= MAX_ROUTINE_RUNS; i += 1) {
        expect((await owner.client.post(`/api/routines/${routine.id}/run`)).status).toBe(202);
        await nextPrompt(agent);
      }
      const rows = await runsOf(routine.id);
      expect(
        rows.map((one) => one.status),
        "派出去还没收尾的记录一条都不能裁，裁了 run 就指着不存在的记录",
      ).toEqual(Array.from({ length: MAX_ROUTINE_RUNS + 1 }, () => "running"));
      const listed = (await allRoutines(owner.client)).find((one) => one.id === routine.id);
      expect(listed?.runs, "接口上还是最近 20 条").toHaveLength(MAX_ROUTINE_RUNS);
    } finally {
      agent.close();
    }
  });

  it("同刻 cron 的记录被 20 次更晚的试跑挤出前 20 条后，另一个调度器认领同刻的第二个触发器仍不再跑", async () => {
    const owner = await ownerWithBot();
    const routine = await makeRoutine(owner, {
      triggers: [
        { kind: "cron", expr: "* * * * *" },
        { kind: "cron", expr: "* * * * *" },
      ],
    });
    // 这一条的时钟得落在真实时间之前：试跑按真实时间落记录，cron 那条才排在它们前面、第 21 条进来时被挤出前 20 条。
    let past = new Date(Date.now() - 120_000);
    const gated = gatedDb(database.sql);
    const live = await startTestServer(gated.db, {}, { now: () => past, intervalMs: 60 * 60 * 1000 });
    const later = await startTestServer(database.db, {}, { now: () => past, intervalMs: 60 * 60 * 1000 });
    await live.server.routines.tick();
    const client = new ApiClient(live.server.port);
    expect((await client.login(owner.email, PASSWORD)).status).toBe(200);
    const { agent } = await helloAgent(live.server.port, owner.computer.computerId, owner.computer.token);
    // 第一个调度器推完第一个触发器的游标、跑完这一刻，停在推第二个触发器游标之前：另一个进程这时认领第二个。
    const claims = /update "routines" set "triggers"/i;
    let gate = gated.arm(claims, "before", routine.id);
    let first: Promise<void> | undefined;
    try {
      past = new Date(past.getTime() + 61_000);
      first = live.server.routines.tick();
      await gate.reached;
      gate.release();
      gate = gated.arm(claims, "before", routine.id);
      const prompt = await nextPrompt(agent);
      runDone(agent, prompt);
      await agent.ack(prompt.runId);
      await gate.reached;
      const [moment] = await runsOf(routine.id);
      expect(moment?.status, "这一刻的记录已经收尾，不再靠「还在跑」保住").toBe("ok");
      for (let i = 0; i < MAX_ROUTINE_RUNS; i += 1) {
        expect((await client.post(`/api/routines/${routine.id}/run`)).status).toBe(202);
        await nextPrompt(agent);
      }
      const messages = await messageCount(owner.groupId);
      await later.server.routines.tick();
      const sameMoment = (await runsOf(routine.id)).filter(
        (one) => new Date(one.started_at).getTime() === new Date(moment?.started_at ?? 0).getTime(),
      );
      expect(await messageCount(owner.groupId), "第二个触发器不再往群里落消息").toBe(messages);
      expect(
        sameMoment.map((one) => one.id),
        "同一刻还是只有先到的那条记录",
      ).toEqual([moment?.id]);
      gate.release();
      await first;
      const fired = (await storedTriggers(routine.id)).map((one) => (one.kind === "cron" ? one.lastFiredAt : null));
      expect(fired[0], "两个游标都推到了这一刻").toBe(fired[1]);
    } finally {
      gate.release();
      await Promise.allSettled([first].filter((one) => one !== undefined));
      agent.close();
      await later.close();
      await live.close();
    }
  });
});

type CrossBotScene = {
  readonly routine: Routine;
  readonly groupId: GroupId;
  readonly other: BotId;
  readonly controlled: Awaited<ReturnType<typeof gatedServer>>;
  readonly agent: AgentClient;
  readonly record: RunRow;
  readonly first: Prompt;
  readonly insertGate: QueryGate;
};

/**
 * 项目群里例行派给小服，小服答完 @小内 接着做：小内的 run 带着同一条运行记录出生。
 * 它建 run 的事务停在 INSERT 之前，手里持着小内的共享锁、还没落行：此时来碰这条记录的事务只锁执行者的话看不见它。
 * 小服那条 run_done 的 ack 要等这次派发做完才发，放行 INSERT 之后再等它。
 */
async function crossBotScene(): Promise<CrossBotScene> {
  const owner = await ownerWithBot();
  const other = await secondBot(owner);
  const groupId = await projectGroup(owner, [owner.botId, other]);
  const routine = await makeRoutine(owner, { groupId, triggers: [] });
  const controlled = await gatedServer(owner);
  const { agent } = await helloAgent(controlled.live.server.port, owner.computer.computerId, owner.computer.token);
  expect((await controlled.client.post(`/api/routines/${routine.id}/run`)).status).toBe(202);
  const first = await nextPrompt(agent);
  expect(first.botId).toBe(owner.botId);
  agent.send({
    type: "bot_text",
    runId: first.runId,
    botId: first.botId,
    groupId,
    messageId: MessageId.parse(randomUUID()),
    delta: "@小内 接着完成",
    done: true,
  });
  const insertGate = controlled.arm(/insert into "runs"/i, "before", other);
  runDone(agent, first);
  await insertGate.reached;
  const [record] = await runsOf(routine.id);
  if (record === undefined) throw new Error("试跑应当落下一条运行记录");
  expect(record.status, "小服那条已经收尾").toBe("ok");
  return { routine, groupId, other, controlled, agent, record, first, insertGate };
}

async function runRef(runId: string): Promise<[boolean, string | null]> {
  const [run] = await database.sql<{ charged_at: Date | null; routine_run_id: string | null }[]>`
    SELECT charged_at, routine_run_id FROM runs WHERE id = ${runId}`;
  return [run?.charged_at !== null, run?.routine_run_id ?? null];
}

/** 等小内的 run 落地并派下来。修后小服试跑的 prompt 可能先到，跳过它。 */
async function promptOf(agent: AgentClient, botId: BotId): Promise<Prompt> {
  for (;;) {
    const prompt = await nextPrompt(agent);
    if (prompt.botId === botId) return prompt;
  }
}

/** 等这道闸被碰到，或者有谁排在锁上：修前请求直接走到闸前，修后它先在小内的共享锁上排队。 */
async function reachedOrWaiting(gate: QueryGate): Promise<void> {
  let reached = false;
  void gate.reached.then(() => (reached = true));
  await waitUntil(async () => reached || (await lockWaiters()) > 0, "走到闸前或排到锁上");
}

async function setCronCursor(routineId: string, index: number, at: Date): Promise<void> {
  await database.sql`
    UPDATE routines SET triggers = jsonb_set(triggers, ${`{${index},lastFiredAt}`}::text[], to_jsonb(${at.toISOString()}::text))
    WHERE id = ${routineId}`;
}

describe("修复六轮：同群其他成员的 run 也引用运行记录，裁剪独立成事务，保留规则只认游标相等", () => {
  it("删例行时同群的小内正带着这条记录建 run：删除先锁住群里每个 Bot，等它落地再锁它的 run，删除 204、结账回 ack", async () => {
    const { routine, other, controlled, agent, record, first, insertGate } = await crossBotScene();
    let deleteGate: QueryGate | undefined;
    let chargeGate: QueryGate | undefined;
    let deletion: Promise<Response> | undefined;
    try {
      deleteGate = controlled.arm(/delete from "routines"/i, "before", routine.id);
      deletion = controlled.client.delete(`/api/routines/${routine.id}`);
      await reachedOrWaiting(deleteGate);
      insertGate.release();
      const second = await promptOf(agent, other);
      await agent.ack(first.runId);
      await deleteGate.reached;
      expect((await runRef(second.runId))[1], "小内的 run 指着同一条记录").toBe(record.id);
      chargeGate = controlled.arm(/from "runs" where "runs"\."id" in .*for update/i, "after", second.runId);
      runDone(agent, second);
      await reachedOrWaiting(chargeGate);
      deleteGate.release();
      chargeGate.release();
      const ack = agent.ack(second.runId).then(
        () => true,
        () => false,
      );
      expect([(await deletion).status, await ack], "删除和小内的结账都要成功，不报 40P01").toEqual([204, true]);
      expect(await runsOf(routine.id)).toHaveLength(0);
      expect(await runRef(second.runId), "小内的账结了，记录没了之后 run 不再指着它").toEqual([true, null]);
    } finally {
      insertGate.release();
      deleteGate?.release();
      chargeGate?.release();
      await Promise.allSettled([deletion].filter((one) => one !== undefined));
      agent.close();
      await controlled.live.close();
    }
  });

  it("裁掉的记录被同群的小内引用着：裁剪先锁住群里每个 Bot，等它落地再锁它的 run，试跑 202、结账回 ack", async () => {
    const { routine, other, controlled, agent, record, first, insertGate } = await crossBotScene();
    let trimGate: QueryGate | undefined;
    let chargeGate: QueryGate | undefined;
    let trial: Promise<Response> | undefined;
    try {
      for (let i = 1; i <= MAX_ROUTINE_RUNS; i += 1) {
        await database.sql`
          INSERT INTO routine_runs (id, routine_id, started_at, status)
          VALUES (${randomUUID()}, ${routine.id}, now() + make_interval(secs => ${i}), 'failed')`;
      }
      trimGate = controlled.arm(/delete from "routine_runs"/i, "before", record.id);
      trial = controlled.client.post(`/api/routines/${routine.id}/run`);
      await reachedOrWaiting(trimGate);
      insertGate.release();
      const second = await promptOf(agent, other);
      await agent.ack(first.runId);
      await trimGate.reached;
      expect((await runRef(second.runId))[1], "小内的 run 指着要裁的那条记录").toBe(record.id);
      chargeGate = controlled.arm(/from "runs" where "runs"\."id" in .*for update/i, "after", second.runId);
      runDone(agent, second);
      await reachedOrWaiting(chargeGate);
      trimGate.release();
      chargeGate.release();
      const ack = agent.ack(second.runId).then(
        () => true,
        () => false,
      );
      expect([(await trial).status, await ack], "裁剪和小内的结账都要成功，不报 40P01").toEqual([202, true]);
      expect(
        (await runsOf(routine.id)).map((one) => one.id),
        "最早那条裁掉了",
      ).not.toContain(record.id);
      expect(await runRef(second.runId), "小内的账结了，记录裁掉后 run 不再指着它").toEqual([true, null]);
    } finally {
      insertGate.release();
      trimGate?.release();
      chargeGate?.release();
      await Promise.allSettled([trial].filter((one) => one !== undefined));
      agent.close();
      await controlled.live.close();
    }
  });

  it("游标离下一刻还远：21 条试跑只留 20 条，webhook 再打一次也还是 20 条", async () => {
    const owner = await ownerWithBot();
    const routine = await makeRoutine(owner, {
      triggers: [{ kind: "cron", expr: "0 9 * * 1" }, { kind: "webhook" }],
    });
    await setCronCursor(routine.id, 0, new Date(Date.now() - 60 * 60 * 1000));
    for (let i = 0; i <= MAX_ROUTINE_RUNS; i += 1) {
      await failedTrial(owner, routine.id);
      // 每次都看一眼，连着三次没人看它就自己停了，停了的 webhook 回 409。
      expect((await owner.client.post(`/api/groups/${owner.groupId}/seen`)).status).toBe(204);
    }
    expect(await runsOf(routine.id), "游标之后的试跑记录照裁，不等到下一个周期").toHaveLength(MAX_ROUTINE_RUNS);
    expect((await server.client().post(`/api/hooks/${webhookToken(routine)}`)).status).toBe(202);
    expect(await runsOf(routine.id), "webhook 的记录也照裁").toHaveLength(MAX_ROUTINE_RUNS);
  });

  it("started_at 正好等于游标的那条不裁：被 20 条更晚的试跑挤出前 20 条后仍在库里，接口照旧只给 20 条", async () => {
    const owner = await ownerWithBot();
    const routine = await makeRoutine(owner);
    let past = new Date(Date.now() - 120_000);
    const live = await startTestServer(database.db, {}, { now: () => past, intervalMs: 60 * 60 * 1000 });
    try {
      await live.server.routines.tick();
      past = new Date(past.getTime() + 61_000);
      await live.server.routines.tick();
      const [moment] = await runsOf(routine.id);
      if (moment === undefined) throw new Error("到点应当落下一条记录");
      const [cursor] = await storedTriggers(routine.id);
      expect(
        cursor?.kind === "cron" ? new Date(cursor.lastFiredAt ?? 0).getTime() : undefined,
        "游标就是这条记录的时刻",
      ).toBe(new Date(moment.started_at).getTime());
      const client = new ApiClient(live.server.port);
      expect((await client.login(owner.email, PASSWORD)).status).toBe(200);
      for (let i = 0; i < MAX_ROUTINE_RUNS; i += 1) {
        expect((await client.post(`/api/routines/${routine.id}/run`)).status).toBe(202);
      }
      const rows = await runsOf(routine.id);
      expect(
        rows.map((one) => one.id),
        "同刻查重的凭据留着",
      ).toContain(moment.id);
      expect(rows, "其余按最近 20 条裁").toHaveLength(MAX_ROUTINE_RUNS + 1);
      const listed = (await allRoutines(owner.client)).find((one) => one.id === routine.id);
      expect(listed?.runs).toHaveLength(MAX_ROUTINE_RUNS);
    } finally {
      await live.close();
    }
  });
});

/** 裁剪的 DELETE 只对这条例行的运行记录抛错，别的例行照常裁。 */
async function withTrimFailure(routineId: string, body: () => Promise<void>): Promise<void> {
  await database.sql.unsafe(
    `CREATE FUNCTION fix7_trim_failure() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN IF OLD.routine_id = '${routineId}' THEN RAISE EXCEPTION '裁剪故障'; END IF; RETURN OLD; END $$`,
  );
  await database.sql.unsafe(
    "CREATE TRIGGER fix7_trim_failure BEFORE DELETE ON routine_runs FOR EACH ROW EXECUTE FUNCTION fix7_trim_failure()",
  );
  try {
    await body();
  } finally {
    await database.sql.unsafe("DROP TRIGGER fix7_trim_failure ON routine_runs");
    await database.sql.unsafe("DROP FUNCTION fix7_trim_failure()");
  }
}

/** 删 Bot 和例行写者共用的那把 Bot 排他锁，SQL 文本和 exclusiveBotRunsLock 发出的一致，收尾锁是三个参数，匹配不上。 */
const EXCLUSIVE_BOT_LOCK = /pg_advisory_xact_lock\(\$1::int4, hashtext\(\$2::text\)\)/i;

/** 和 runs.ts 的 BOT_RUNS_LOCK 同一个命名空间。对不上的话测试里拿的锁和服务端互不相干，等锁那一步会超时。 */
const BOT_RUNS_LOCK_KEY = 0x627a6274;

/** 把这个 Bot 直接写进群成员表，相当于删别的成员时主助理被补进项目群那一下。 */
async function joinGroup(groupId: GroupId, botId: BotId): Promise<void> {
  await database.sql`
    INSERT INTO group_members (group_id, bot_id, position)
    SELECT ${groupId}, ${botId}, coalesce(max(position), -1) + 1 FROM group_members WHERE group_id = ${groupId}`;
}

async function runCountOf(botId: BotId): Promise<number> {
  const rows = await database.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM runs WHERE bot_id = ${botId}`;
  return rows[0]?.n ?? 0;
}

function maxId(ids: readonly string[]): string {
  const [last] = ids.toSorted().slice(-1);
  if (last === undefined) throw new Error("没有 id");
  return last;
}

describe("修复七轮：裁剪失败不连累派发，写者名单的重读、主助理、升序和例行行锁", () => {
  it("裁剪的 DELETE 抛错：试跑和 webhook 照样回 202，prompt 已送、记录一条不少、routine_updated 照推，下次裁剪收回", async () => {
    const owner = await ownerWithBot();
    const routine = await makeRoutine(owner, { triggers: [{ kind: "webhook" }] });
    for (let i = 1; i <= MAX_ROUTINE_RUNS + 2; i += 1) {
      await database.sql`
        INSERT INTO routine_runs (id, routine_id, started_at, status)
        VALUES (${randomUUID()}, ${routine.id}, now() - make_interval(secs => ${100 - i}), 'failed')`;
    }
    const agent = await online(owner);
    const push = await connectPush(server.server.port, owner.client.cookie ?? "");
    try {
      await withTrimFailure(routine.id, async () => {
        expect((await owner.client.post(`/api/routines/${routine.id}/run`)).status, "试跑已经派出去了").toBe(202);
        expect((await nextPrompt(agent)).botId).toBe(owner.botId);
        await untilPush(push, routinePushed(routine.id, "on"), "试跑之后的 routine_updated");
        expect((await server.client().post(`/api/hooks/${webhookToken(routine)}`)).status, "平台不该重试").toBe(202);
        expect((await nextPrompt(agent)).botId).toBe(owner.botId);
        await untilPush(push, routinePushed(routine.id, "on"), "webhook 之后的 routine_updated");
        const rows = await runsOf(routine.id);
        expect(rows, "裁剪失败只是多留几条").toHaveLength(MAX_ROUTINE_RUNS + 4);
        expect(
          rows.slice(-2).map((one) => one.status),
          "两次运行都在跑，没被当成失败",
        ).toEqual(["running", "running"]);
      });
      expect((await owner.client.post(`/api/routines/${routine.id}/run`)).status).toBe(202);
      expect(await runsOf(routine.id), "故障过去后下一次裁剪收回").toHaveLength(MAX_ROUTINE_RUNS);
    } finally {
      push.close();
      agent.close();
    }
  });

  it("执行者不同的两条项目例行同时删：写者名单按 id 升序拿锁，两条都 204", async () => {
    const owner = await ownerWithBot();
    const other = await secondBot(owner);
    const groupId = await projectGroup(owner, [owner.botId, other]);
    const mine = await makeRoutine(owner, { groupId, triggers: [] });
    const created = await owner.client.post(`/api/bots/${other}/routines`, { ...fresh, groupId });
    expect(created.status).toBe(201);
    const theirs = RoutineResponse.parse(await created.json()).routine;
    const controlled = await gatedServer(owner);
    const gate = controlled.arm(EXCLUSIVE_BOT_LOCK, "after", owner.botId);
    const deletions: Promise<Response>[] = [];
    try {
      deletions.push(controlled.client.delete(`/api/routines/${mine.id}`));
      await gate.reached;
      deletions.push(controlled.client.delete(`/api/routines/${theirs.id}`));
      await waitUntil(async () => (await lockWaiters()) > 0, "第二条删除排到锁上");
      gate.release();
      expect(
        await Promise.all(deletions.map(async (one) => (await one).status)),
        "两边按同一顺序拿锁只会排队，不报 40P01",
      ).toEqual([204, 204]);
    } finally {
      gate.release();
      await Promise.allSettled(deletions);
      await controlled.live.close();
    }
  });

  it("删例行锁写者期间有新成员进群：锁完重读名单把它也锁上，删除提交前它建不出 run", async () => {
    const owner = await ownerWithBot();
    const other = await secondBot(owner);
    const third = CreateBotResponse.parse(await (await owner.client.post("/api/bots", { name: "小丙" })).json()).bot.id;
    const groupId = await projectGroup(owner, [owner.botId, other]);
    const routine = await makeRoutine(owner, { groupId, triggers: [] });
    const agent = await online(owner);
    const controlled = await gatedServer(owner);
    const writers = [owner.botId, other, await assistantOf(owner)];
    const lockGate = controlled.arm(EXCLUSIVE_BOT_LOCK, "after", maxId(writers));
    let deleteGate: QueryGate | undefined;
    let deletion: Promise<Response> | undefined;
    let posted: Promise<Response> | undefined;
    try {
      deletion = controlled.client.delete(`/api/routines/${routine.id}`);
      await lockGate.reached;
      await joinGroup(groupId, third);
      deleteGate = controlled.arm(/delete from "routines"/i, "before", routine.id);
      lockGate.release();
      await deleteGate.reached;
      posted = owner.client.post(`/api/groups/${groupId}/messages`, { text: "@小丙 看一下" });
      await waitUntil(
        async () => (await runCountOf(third)) > 0 || (await lockWaiterOn("pg_advisory_xact_lock_shared")),
        "小丙的 run 落地或排到锁上",
      );
      expect(await runCountOf(third), "删除还没提交，新成员的 run 在它的锁上等").toBe(0);
      deleteGate.release();
      expect((await deletion).status).toBe(204);
      expect((await posted).status).toBe(201);
      expect(await runCountOf(third), "删除提交后小丙的 run 落地").toBe(1);
    } finally {
      lockGate.release();
      deleteGate?.release();
      await Promise.allSettled([deletion, posted].filter((one) => one !== undefined));
      agent.close();
      await controlled.live.close();
    }
  });

  it("主助理一开始就在写者名单里：它在删例行途中被补进项目群，删除不会已持锁再回头拿它的锁，204", async () => {
    let scene: { owner: Owner; other: BotId; groupId: GroupId; assistant: BotId } | undefined;
    for (let attempt = 0; attempt < 30 && scene === undefined; attempt += 1) {
      const owner = await ownerWithBot();
      const other = await secondBot(owner);
      const assistant = await assistantOf(owner);
      // 主助理要排在执行者和小内中较大的那个之前：屏障停在较大的那把锁上时，它的锁已经在删除手里。
      if (assistant < maxId([owner.botId, other])) {
        scene = { owner, other, assistant, groupId: await projectGroup(owner, [owner.botId, other]) };
      }
    }
    if (scene === undefined) throw new Error("30 次都没搭出主助理排在前面的 id 顺序");
    const { owner, other, groupId, assistant } = scene;
    const last = maxId([owner.botId, other]);
    const routine = await makeRoutine(owner, { groupId, triggers: [] });
    const controlled = await gatedServer(owner);
    const gate = controlled.arm(EXCLUSIVE_BOT_LOCK, "after", last);
    let deletion: Promise<Response> | undefined;
    let rival: Promise<unknown> | undefined;
    try {
      deletion = controlled.client.delete(`/api/routines/${routine.id}`);
      await gate.reached;
      await joinGroup(groupId, assistant);
      // 另一个按升序先拿主助理、再拿较大那个 Bot 的事务。死锁检测留给删除那一侧，环一成它就报 40P01。
      rival = database.sql.begin(async (tx) => {
        await tx`SET LOCAL deadlock_timeout = '60s'`;
        await tx`SELECT pg_advisory_xact_lock(${BOT_RUNS_LOCK_KEY}::int4, hashtext(${assistant}::text))`;
        await tx`SELECT pg_advisory_xact_lock(${BOT_RUNS_LOCK_KEY}::int4, hashtext(${last}::text))`;
      });
      await waitUntil(async () => (await lockWaiters()) > 0, "另一个事务排到锁上");
      gate.release();
      expect((await deletion).status, "名单只少不多，删除不回头拿更小的锁").toBe(204);
      await rival;
    } finally {
      gate.release();
      await Promise.allSettled([deletion, rival].filter((one) => one !== undefined));
      await controlled.live.close();
    }
  });

  it("改触发器的事务没提交时裁剪在例行行上等它，按提交后的触发器裁：被换掉的 cron 那一刻的记录照裁", async () => {
    const owner = await ownerWithBot();
    const routine = await makeRoutine(owner, { triggers: [{ kind: "cron", expr: "0 9 * * 1" }, { kind: "webhook" }] });
    const moment = new Date(Date.now() - 60 * 60 * 1000);
    const momentId = randomUUID();
    await database.sql`
      INSERT INTO routine_runs (id, routine_id, started_at, status) VALUES (${momentId}, ${routine.id}, ${moment.toISOString()}, 'ok')`;
    await setCronCursor(routine.id, 0, moment);
    for (let i = 1; i <= MAX_ROUTINE_RUNS; i += 1) {
      await database.sql`
        INSERT INTO routine_runs (id, routine_id, started_at, status)
        VALUES (${randomUUID()}, ${routine.id}, now() - make_interval(secs => ${100 - i}), 'ok')`;
    }
    const controlled = await gatedServer(owner);
    const trimGate = controlled.arm(EXCLUSIVE_BOT_LOCK, "after", maxId([owner.botId, await assistantOf(owner)]));
    let patchGate: QueryGate | undefined;
    let trial: Promise<Response> | undefined;
    let patch: Promise<Response> | undefined;
    try {
      trial = controlled.client.post(`/api/routines/${routine.id}/run`);
      await trimGate.reached;
      patchGate = controlled.arm(/update "routines"/i, "after", routine.id);
      patch = controlled.client.patch(`/api/routines/${routine.id}`, {
        triggers: [
          { kind: "cron", expr: "0 9 * * 2" },
          { kind: "webhook", token: webhookToken(routine) },
        ],
      });
      await patchGate.reached;
      trimGate.release();
      await blockedOrDone(trial);
      patchGate.release();
      expect([(await patch).status, (await trial).status]).toEqual([200, 202]);
      const rows = await runsOf(routine.id);
      expect(
        rows.map((one) => one.id),
        "换掉的 cron 不再有游标，那一刻的记录不再留",
      ).not.toContain(momentId);
      expect(rows).toHaveLength(MAX_ROUTINE_RUNS);
    } finally {
      trimGate.release();
      patchGate?.release();
      await Promise.allSettled([trial, patch].filter((one) => one !== undefined));
      await controlled.live.close();
    }
  });
});

async function switchExecutor(owner: Owner, routineId: string, executorBotId: BotId): Promise<Response> {
  return owner.client.patch(`/api/routines/${routineId}`, { executorBotId });
}

async function errorOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: string }).error;
}

describe("更换执行 Bot", () => {
  it("项目群的例行换给同群的另一位：运行记录留着，游标不动不补跑，下一次到点派给新 Bot", async () => {
    const owner = await ownerWithBot();
    const member = await secondBot(owner);
    const groupId = await projectGroup(owner, [owner.botId, member]);
    const routine = await makeRoutine(owner, { name: "项目周报", groupId });
    await failedTrial(owner, routine.id);
    await server.server.routines.tick();
    const cursor = await storedTriggers(routine.id);
    expect(cursor[0]?.kind === "cron" ? cursor[0].lastFiredAt : null, "扫过一遍，游标对齐到了现在").not.toBeNull();

    const push = await connectPush(server.server.port, owner.client.cookie ?? "");
    try {
      const response = await switchExecutor(owner, routine.id, member);
      expect(response.status).toBe(200);
      const switched = RoutineResponse.parse(await response.json()).routine;
      expect(switched.botId).toBe(member);
      expect(switched.groupId, "还发进原来的项目群").toBe(groupId);
      expect(
        switched.runs.map((run) => run.status),
        "换人前的运行记录照旧在",
      ).toEqual(["failed"]);
      const pushed = await untilPush(
        push,
        (one): one is Extract<ServerPush, { type: "routine_updated" }> =>
          one.type === "routine_updated" && one.routine.id === routine.id,
        "换人后的 routine_updated",
      );
      expect(pushed.routine.botId).toBe(member);
    } finally {
      push.close();
    }
    expect(await storedTriggers(routine.id), "换人不碰调度游标").toEqual(cursor);
    expect((await allRoutines(owner.client)).find((one) => one.id === routine.id)?.botId).toBe(member);

    const agent = await online(owner);
    try {
      await server.server.routines.tick();
      expect(await runsOf(routine.id), "游标没被重置，同一分钟里不会再跑").toHaveLength(1);
      advanceOneMinute();
      await server.server.routines.tick();
      const prompt = await agent.expect("prompt");
      expect(prompt.botId, "下一次到点由新执行者做").toBe(member);
      expect(prompt.groupId).toBe(groupId);
      expect(prompt.origin).toEqual({ kind: "routine" });
      expect(
        (await runsOf(routine.id)).map((row) => row.status),
        "新的一次接在旧记录后面",
      ).toEqual(["failed", "running"]);
    } finally {
      agent.close();
    }
  });

  it("发进单聊的例行跟着执行者走：换人后发进新 Bot 自己的单聊", async () => {
    const owner = await ownerWithBot();
    const other = CreateBotResponse.parse(await (await owner.client.post("/api/bots", { name: "小内" })).json());
    const plain = await makeRoutine(owner, { name: "早报", triggers: [] });
    const pinned = await makeRoutine(owner, { name: "晚报", groupId: owner.groupId, triggers: [] });
    for (const routine of [plain, pinned]) {
      const response = await switchExecutor(owner, routine.id, other.bot.id);
      expect(response.status).toBe(200);
      expect(
        RoutineResponse.parse(await response.json()).routine,
        `「${routine.name}」不再挂着旧 Bot 的单聊`,
      ).toMatchObject({
        botId: other.bot.id,
        groupId: null,
      });
    }

    const agent = await online(owner);
    try {
      expect((await owner.client.post(`/api/routines/${pinned.id}/run`, {})).status).toBe(202);
      const prompt = await agent.expect("prompt");
      expect(prompt.botId).toBe(other.bot.id);
      expect(prompt.groupId, "发进新 Bot 的单聊").toBe(other.group.id);
    } finally {
      agent.close();
    }
    const inOldSolo = MessageListResponse.parse(
      await (await owner.client.get(`/api/groups/${owner.groupId}/messages`)).json(),
    ).messages;
    expect(inOldSolo, "旧 Bot 的单聊里不再落例行的消息").toEqual([]);
  });

  it("换给不在项目群里的 Bot 回 400，执行者不变", async () => {
    const owner = await ownerWithBot();
    const member = await secondBot(owner);
    const outsider = await secondBot(owner);
    const groupId = await projectGroup(owner, [owner.botId, member]);
    const routine = await makeRoutine(owner, { groupId, triggers: [] });

    const response = await switchExecutor(owner, routine.id, outsider);
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe("这个 Bot 不在例行任务的项目群里");
    expect((await allRoutines(owner.client)).map((one) => one.botId)).toEqual([owner.botId]);
  });

  it("换给别人的 Bot 和不存在的一样回 404，执行者不变", async () => {
    const owner = await ownerWithBot();
    const stranger = await ownerWithBot();
    const routine = await makeRoutine(owner, { triggers: [] });

    const response = await switchExecutor(owner, routine.id, stranger.botId);
    expect(response.status).toBe(404);
    expect(await errorOf(response)).toBe("没有这个 Bot");
    expect((await allRoutines(owner.client)).map((one) => [one.botId, one.groupId])).toEqual([[owner.botId, null]]);
  });

  it("换给牌友回 400，执行者不变", async () => {
    const owner = await ownerWithBot();
    const routine = await makeRoutine(owner, { triggers: [] });
    expect((await owner.client.post("/api/poker/tables", { requestId: "routine-executor" })).status).toBe(201);
    const players = await database.sql<{ id: BotId }[]>`
      SELECT b.id FROM bots b JOIN users u ON u.id = b.owner_id
      WHERE u.email = ${owner.email} AND b.role = 'player' LIMIT 1`;
    const player = players[0]?.id;
    if (player === undefined) throw new Error("开桌后应当有牌友");

    const response = await switchExecutor(owner, routine.id, player);
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe("牌友和老白不能执行例行任务");
    expect((await allRoutines(owner.client)).map((one) => one.botId)).toEqual([owner.botId]);
  });

  it("webhook 已锁住旧执行者、还没锁例行行时换人：换人等它提交，这一次落进旧执行者的单聊，之后才换", async () => {
    const owner = await ownerWithBot();
    const other = CreateBotResponse.parse(await (await owner.client.post("/api/bots", { name: "小内" })).json());
    const routine = await makeRoutine(owner, { triggers: [{ kind: "webhook" }] });
    const gated = await gatedServer(owner);
    const gate = gated.arm(/from "routines" .*for update/i, "before", routine.id);
    let hooking: Promise<Response> | undefined;
    let switching: Promise<Response> | undefined;
    try {
      hooking = gated.client.post(`/api/hooks/${webhookToken(routine)}`);
      await gate.reached;
      switching = switchExecutor(owner, routine.id, other.bot.id);
      await blockedOrDone(switching);
      gate.release();
      expect((await hooking).status).toBe(202);
      expect((await switching).status).toBe(200);
      const bodies = (groupId: GroupId) =>
        owner.client
          .get(`/api/groups/${groupId}/messages`)
          .then(async (response) => MessageListResponse.parse(await response.json()).messages.map((one) => one.body));
      expect(await bodies(owner.groupId), "触发先锁到的是旧执行者，这一次就由它做").toContainEqual(
        expect.objectContaining({ kind: "user", routine: { name: "每日工单早报" } }),
      );
      expect(await bodies(other.group.id), "派给谁就得持着谁的锁，不能锁着旧的派给新的").toEqual([]);
      expect((await allRoutines(owner.client)).map((one) => one.botId)).toEqual([other.bot.id]);
    } finally {
      gate.release();
      await Promise.allSettled([hooking, switching].filter((one) => one !== undefined));
      await gated.live.close();
    }
  });

  it("删旧执行者已经把例行转给主助理、还没提交时换人：换人等它提交，回 409，例行留在主助理名下", async () => {
    const owner = await ownerWithBot();
    const assistant = await assistantOf(owner);
    const other = await secondBot(owner);
    const routine = await makeRoutine(owner, { triggers: [] });
    const gated = await gatedServer(owner);
    const gate = gated.arm(/update "routines" set "bot_id"/i, "after");
    let deleting: Promise<Response> | undefined;
    let switching: Promise<Response> | undefined;
    try {
      deleting = gated.client.delete(`/api/bots/${owner.botId}`);
      await gate.reached;
      switching = switchExecutor(owner, routine.id, other);
      await blockedOrDone(switching);
      gate.release();
      expect((await deleting).status).toBe(204);
      const switched = await switching;
      expect(switched.status, "锁到时执行者已经不是读到的那位，不追着再换").toBe(409);
      expect(await errorOf(switched)).toBe("这条例行任务的执行者刚变过，刷新后再换");
      expect((await allRoutines(owner.client)).map((one) => one.botId)).toEqual([assistant]);
    } finally {
      gate.release();
      await Promise.allSettled([deleting, switching].filter((one) => one !== undefined));
      await gated.live.close();
    }
  });

  it("换人后再删旧执行者：它手上那次当场收成失败、写明执行者已删，并推 routine_updated", async () => {
    const owner = await ownerWithBot();
    const other = await secondBot(owner);
    const routine = await makeRoutine(owner, { triggers: [] });
    const agent = await online(owner);
    const push = await connectPush(server.server.port, owner.client.cookie ?? "");
    try {
      expect((await owner.client.post(`/api/routines/${routine.id}/run`)).status).toBe(202);
      expect((await agent.expect("prompt")).botId).toBe(owner.botId);
      expect((await switchExecutor(owner, routine.id, other)).status).toBe(200);
      expect((await owner.client.delete(`/api/bots/${owner.botId}`)).status).toBe(204);

      const listed = (await allRoutines(owner.client)).find((one) => one.id === routine.id);
      expect(listed?.botId, "例行留在新执行者名下").toBe(other);
      expect(
        listed?.runs.map((run) => [run.status, run.note]),
        "旧执行者那次不再永远停在正在跑",
      ).toEqual([["failed", EXECUTOR_DELETED_NOTE]]);
      await untilPush(
        push,
        (one): one is RoutineUpdated =>
          one.type === "routine_updated" && one.routine.id === routine.id && one.routine.runs[0]?.status === "failed",
        "旧执行者那次收成失败的例行",
      );
    } finally {
      push.close();
      agent.close();
    }
  });

  it("换人后删的是新执行者：旧执行者手上那次照旧在跑，跑完记成 ok", async () => {
    const owner = await ownerWithBot();
    const other = await secondBot(owner);
    const routine = await makeRoutine(owner, { triggers: [] });
    const agent = await online(owner);
    try {
      expect((await owner.client.post(`/api/routines/${routine.id}/run`)).status).toBe(202);
      const prompt = await agent.expect("prompt");
      expect(prompt.botId).toBe(owner.botId);
      expect((await switchExecutor(owner, routine.id, other)).status).toBe(200);
      expect((await owner.client.delete(`/api/bots/${other}`)).status).toBe(204);
      expect(
        (await allRoutines(owner.client)).find((one) => one.id === routine.id)?.runs.map((run) => run.status),
        "删的不是这次的执行者，记录不该收成失败",
      ).toEqual(["running"]);

      runDone(agent, prompt);
      await settled(routine.id);
      expect((await runsOf(routine.id)).map((one) => one.status)).toEqual(["ok"]);
    } finally {
      agent.close();
    }
  });
});

/** 有没有连接正排在这个 Bot 的 advisory 锁上没拿到。两参数形式的 advisory 锁在 pg_locks 里第二个键落在 objid，按无符号存。 */
async function waitingOnBotLock(botId: BotId): Promise<boolean> {
  return (await botLockWaiters(botId)) > 0;
}

async function botLockWaiters(botId: BotId): Promise<number> {
  const rows = await database.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE a.datname = ${database.databaseName} AND l.locktype = 'advisory' AND NOT l.granted AND l.objsubid = 2
      AND l.objid::bigint = (hashtext(${botId}::text)::bigint & 4294967295)`;
  return rows[0]?.n ?? 0;
}

/**
 * 测试库上开一个事务，先拿 first 的 Bot 共享锁，等 proceed 之后再拿 second 的，然后提交。
 * 多 Bot 群派活、信封、牌桌就是这样按 Bot id 升序一把一把拿共享锁的。
 */
function sharedLocksInOrder(
  db: Db,
  first: BotId,
  second: BotId,
): { readonly holdingFirst: Promise<void>; readonly proceed: () => void; readonly done: Promise<void> } {
  let proceed!: () => void;
  const go = new Promise<void>((resolve) => (proceed = resolve));
  let holding!: () => void;
  const holdingFirst = new Promise<void>((resolve) => (holding = resolve));
  const done = db.transaction(async (tx) => {
    await shareBotRunsLock(tx, first);
    holding();
    await go;
    await shareBotRunsLock(tx, second);
  });
  return { holdingFirst, proceed, done };
}

/** 测试库上开一个事务拿着这个 Bot 的共享锁不放，直到 release。 */
async function holdBotShared(db: Db, botId: BotId): Promise<{ release: () => Promise<void> }> {
  const locks = sharedLocksInOrder(db, botId, botId);
  await locks.holdingFirst;
  return {
    release: async () => {
      locks.proceed();
      await locks.done;
    },
  };
}

async function routineOf(owner: Owner, botId: BotId, input: Partial<CreateRoutineRequest> = {}): Promise<Routine> {
  const response = await owner.client.post(`/api/bots/${botId}/routines`, {
    name: "每日工单早报",
    instruction: "把今天的工单汇总一下",
    triggers: [],
    onFailure: "stop_and_tell",
    ...input,
  });
  expect(response.status).toBe(201);
  return RoutineResponse.parse(await response.json()).routine;
}

describe("更换执行 Bot 的锁序", () => {
  // 扣锁的事务走另一个连接池：测试库的池只有 4 条，和服务端共用，换人、删例行、扣行锁、扣 Bot 锁各占一条，查 pg_locks 的就排不上了。
  let side: { readonly db: Db; readonly sql: Sql };
  beforeAll(() => {
    const url = new URL(databaseUrl());
    url.pathname = `/${database.databaseName}`;
    side = connect(url.toString(), { max: 4 });
  });
  afterAll(async () => {
    await side.sql.end();
  });

  it("单聊例行换给名单外的 Bot 时删例行在排队：删除等换人提交后才按新名单拿锁，和按升序拿共享锁的派活不成环", async () => {
    const owner = await ownerWithBot();
    const second = await secondBot(owner);
    // 新执行者 id 更小：删除要是持着旧执行者的锁再去拿它，就和先拿它、再拿旧执行者的派活反序。
    const [low, high] = [owner.botId, second].toSorted() as [BotId, BotId];
    const routine = await routineOf(owner, high);
    const row = await holdLock(
      (tx) => tx`SELECT id FROM routines WHERE id = ${routine.id} FOR NO KEY UPDATE`,
      side.sql,
    );
    let released = false;
    const dispatch = sharedLocksInOrder(side.db, low, high);
    let switching: Promise<Response> | undefined;
    let deleting: Promise<Response> | undefined;
    try {
      switching = switchExecutor(owner, routine.id, low);
      await waitUntil(() => lockWaiterOn('from "routines"'), "换人拿完 Bot 锁、排到例行行上");
      deleting = owner.client.delete(`/api/routines/${routine.id}`);
      await waitUntil(async () => (await lockWaiters()) >= 2, "删例行也排到锁上");
      await dispatch.holdingFirst;
      await row.release();
      released = true;
      expect((await switching).status).toBe(200);
      await waitUntil(() => waitingOnBotLock(low), "删例行按换人后的名单排到新执行者的锁上");
      dispatch.proceed();
      await expect(dispatch.done, "派活拿旧执行者的共享锁不该等删例行").resolves.toBeUndefined();
      expect((await deleting).status, "删例行不该被当成死锁回滚").toBe(204);
      expect(await allRoutines(owner.client)).toEqual([]);
    } finally {
      if (!released) await row.release();
      dispatch.proceed();
      await Promise.allSettled([switching, deleting, dispatch.done].filter((one) => one !== undefined));
    }
  });

  it("单聊例行换人后旧执行者那次还在跑：删例行也要等旧执行者的锁，它接续出来的 run 不会在删之前带着这条记录出生", async () => {
    const owner = await ownerWithBot();
    const other = await secondBot(owner);
    const routine = await routineOf(owner, owner.botId);
    const agent = await online(owner);
    try {
      expect((await owner.client.post(`/api/routines/${routine.id}/run`)).status).toBe(202);
      expect((await agent.expect("prompt")).botId).toBe(owner.botId);
      expect((await switchExecutor(owner, routine.id, other)).status).toBe(200);
      expect((await runsOf(routine.id)).map((one) => one.status)).toEqual(["running"]);

      // 旧执行者换电脑接续时，placeRun 拿的就是它的共享锁。
      const held = await holdBotShared(side.db, owner.botId);
      let done = false;
      const deleting = owner.client.delete(`/api/routines/${routine.id}`);
      deleting.then(
        () => (done = true),
        () => (done = true),
      );
      try {
        await waitUntil(async () => done || (await waitingOnBotLock(owner.botId)), "删例行回掉或排到旧执行者的锁上");
        expect(done, "删例行得等旧执行者手上的接续").toBe(false);
      } finally {
        await held.release();
      }
      expect((await deleting).status).toBe(204);
      expect(await allRoutines(owner.client)).toEqual([]);
    } finally {
      agent.close();
    }
  });

  it("单聊例行旧执行者那次停下等点头时换人：删例行也要等旧执行者的锁", async () => {
    const owner = await ownerWithBot();
    const other = await secondBot(owner);
    const routine = await routineOf(owner, owner.botId);
    const agent = await online(owner);
    try {
      expect((await owner.client.post(`/api/routines/${routine.id}/run`)).status).toBe(202);
      const prompt = await agent.expect("prompt");
      expect(prompt.botId).toBe(owner.botId);
      agent.send({
        type: "approval_request",
        runId: prompt.runId,
        botId: owner.botId,
        groupId: owner.groupId,
        callId: "call-1",
        tool: "send_email",
        action: "message_person",
        target: null,
        view: { kind: "mcp", server: "", tool: "send_email", params: [], raw: "给客户发一封邮件" },
      });
      await settled(routine.id);
      expect((await runsOf(routine.id)).map((one) => one.status)).toEqual(["stopped"]);
      expect((await switchExecutor(owner, routine.id, other)).status).toBe(200);

      const held = await holdBotShared(side.db, owner.botId);
      let done = false;
      const deleting = owner.client.delete(`/api/routines/${routine.id}`);
      deleting.then(
        () => (done = true),
        () => (done = true),
      );
      try {
        await waitUntil(async () => done || (await waitingOnBotLock(owner.botId)), "删例行回掉或排到旧执行者的锁上");
        expect(done, "stopped 的记录也得让删例行等旧执行者").toBe(false);
      } finally {
        await held.release();
      }
      expect((await deleting).status).toBe(204);
      expect(await allRoutines(owner.client)).toEqual([]);
    } finally {
      agent.close();
    }
  });

  it("换人时新执行者正被删：换人等删除提交，回 404「没有这个 Bot」，例行留在原执行者名下", async () => {
    const owner = await ownerWithBot();
    const other = await secondBot(owner);
    const routine = await routineOf(owner, owner.botId);
    const gated = await gatedServer(owner);
    const gate = gated.arm(/delete from "bots"/i, "after");
    let deleting: Promise<Response> | undefined;
    let switching: Promise<Response> | undefined;
    try {
      deleting = gated.client.delete(`/api/bots/${other}`);
      await gate.reached;
      switching = switchExecutor(owner, routine.id, other);
      await blockedOrDone(switching);
      gate.release();
      expect((await deleting).status).toBe(204);
      const switched = await switching;
      expect(switched.status, "路由预检时 Bot 还在，锁到之后它已经删了").toBe(404);
      expect(await errorOf(switched)).toBe("没有这个 Bot");
      expect((await allRoutines(owner.client)).map((one) => [one.botId, one.groupId])).toEqual([[owner.botId, null]]);
    } finally {
      gate.release();
      await Promise.allSettled([deleting, switching].filter((one) => one !== undefined));
      await gated.live.close();
    }
  });

  it("单聊例行触发已提交、旧执行者的 run 还没建时换人：删例行照运行记录先锁住旧执行者，run 落地不会让名单变长、逆序拿锁", async () => {
    const owner = await ownerWithBot();
    const second = await secondBot(owner);
    const [low, high] = [owner.botId, second].toSorted() as [BotId, BotId];
    const routine = await routineOf(owner, low);
    const [ownerRow] = await database.sql<{ owner_id: string }[]>`SELECT owner_id FROM bots WHERE id = ${low}`;
    const ownerId = UserId.parse(ownerRow?.owner_id);
    const agent = await online(owner);
    // 触发事务提交到 placeRun 建 run 是同一个请求里的两步，HTTP 停不在中间。
    // placeRun 第一句拿账号的共享锁，触发事务不拿，所以从旁路扣住账号的排他锁，试跑就停在这个窗口里。
    const account = await holdOwnerExclusive(side.db, ownerId);
    let accountHeld = true;
    let holder: Awaited<ReturnType<typeof holdBotShared>> | undefined;
    let dispatch: ReturnType<typeof sharedLocksInOrder> | undefined;
    let trial: Promise<Response> | undefined;
    let deleting: Promise<Response> | undefined;
    try {
      trial = owner.client.post(`/api/routines/${routine.id}/run`);
      await waitUntil(
        async () => (await runsOf(routine.id)).length === 1 && (await lockWaiters()) > 0,
        "触发事务提交、派活排到账号锁上",
      );
      expect((await switchExecutor(owner, routine.id, high)).status).toBe(200);

      holder = await holdBotShared(side.db, high);
      deleting = owner.client.delete(`/api/routines/${routine.id}`);
      await waitUntil(() => waitingOnBotLock(high), "删例行排到新执行者的锁上");

      await account.release();
      accountHeld = false;
      await waitUntil(
        async () => (await committedRunsOf(routine.id)) > 0 || (await waitingOnBotLock(low)),
        "旧执行者的 run 落地，或者派活排到删例行持着的旧执行者锁上",
      );

      dispatch = sharedLocksInOrder(side.db, low, high);
      dispatch.proceed();
      await waitUntil(
        async () => (await botLockWaiters(low)) >= 2 || (await botLockWaiters(high)) >= 2,
        "按升序拿共享锁的派活排上锁",
      );
      await holder.release();
      holder = undefined;

      await expect(dispatch.done, "按升序拿共享锁的派活不该被当成死锁回滚").resolves.toBeUndefined();
      expect((await deleting).status, "删例行不该被当成死锁回滚").toBe(204);
      expect(await allRoutines(owner.client)).toEqual([]);
    } finally {
      if (accountHeld) await account.release();
      dispatch?.proceed();
      await holder?.release();
      await Promise.allSettled([trial, deleting, dispatch?.done].filter((one) => one !== undefined));
      agent.close();
    }
  });
});

async function committedRunsOf(routineId: string): Promise<number> {
  const rows = await database.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM runs JOIN routine_runs ON routine_runs.id = runs.routine_run_id
    WHERE routine_runs.routine_id = ${routineId}`;
  return rows[0]?.n ?? 0;
}

async function holdOwnerExclusive(db: Db, ownerId: UserId): Promise<{ release: () => Promise<void> }> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const holding = new Promise<void>((resolve) => (locked = resolve));
  const done = db.transaction(async (tx) => {
    await lockOwner(tx, ownerId, "exclusive");
    locked();
    await released;
  });
  await holding;
  return {
    release: async () => {
      release();
      await done;
    },
  };
}
