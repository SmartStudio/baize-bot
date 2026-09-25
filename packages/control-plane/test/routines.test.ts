import {
  CreateBotResponse,
  MessageListResponse,
  RoutineResponse,
  type BotId,
  type CreateRoutineRequest,
  type GroupId,
  type Routine,
} from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StoredTrigger } from "../src/db/schema.js";
import { MAX_ROUTINE_RUNS, advanceCronTrigger } from "../src/repo/routines.js";
import { WAITING_APPROVAL_NOTE } from "../src/routines/run.js";
import { ApiClient, startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, type TestComputer } from "./helpers/fixtures.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";

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
  readonly groupId: GroupId;
  readonly botId: BotId;
};

async function ownerWithBot(): Promise<Owner> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小服" })).json());
  return { client, computer, groupId: created.group.id, botId: created.bot.id };
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

describe("例行任务到点触发", () => {
  it("到点跑一次：群里多两条消息，活派了下去", async () => {
    const owner = await ownerWithBot();
    const agent = await online(owner);

    try {
      const routine = await makeRoutine(owner);
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

      const page = MessageListResponse.parse(
        await (await owner.client.get(`/api/groups/${owner.groupId}/messages`)).json(),
      );
      const bodies = page.messages.map((message) => message.body);
      expect(bodies[0]).toEqual({ kind: "system", text: "例行任务「每日工单早报」自动运行" });
      expect(bodies[1], "第二条是用户消息，运行器看到的和手打的一模一样").toMatchObject({
        kind: "user",
        text: "把今天的工单汇总一下",
      });

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
      const routine = await makeRoutine(owner, { enabled: false });
      await server.server.routines.tick();
      advanceOneMinute();
      await server.server.routines.tick();
      expect(await runsOf(routine.id)).toHaveLength(0);

      expect((await owner.client.patch(`/api/routines/${routine.id}`, { enabled: true })).status).toBe(200);
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

    expect((await owner.client.patch(`/api/routines/${routine.id}`, { enabled: false })).status).toBe(200);
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
  it("和到点触发走同一条路，回 202 且最前面多一条 running", async () => {
    const owner = await ownerWithBot();
    const agent = await online(owner);

    try {
      const routine = await makeRoutine(owner, { enabled: false });
      const response = await owner.client.post(`/api/routines/${routine.id}/run`);
      expect(response.status, "停用只挡自动触发，试跑照跑").toBe(202);

      const body = RoutineResponse.parse(await response.json());
      expect(body.routine.runs[0]?.status).toBe("running");

      const prompt = await agent.expect("prompt");
      expect(prompt.text).toBe("把今天的工单汇总一下");

      const page = MessageListResponse.parse(
        await (await owner.client.get(`/api/groups/${owner.groupId}/messages`)).json(),
      );
      expect(page.messages[0]?.body).toEqual({ kind: "system", text: "例行任务「每日工单早报」自动运行" });
    } finally {
      agent.close();
    }
  });

  it("第 21 条运行记录挤掉最早那条", async () => {
    const owner = await ownerWithBot();
    const agent = await online(owner);

    try {
      const routine = await makeRoutine(owner, { triggers: [] });
      await owner.client.post(`/api/routines/${routine.id}/run`);
      const [oldest] = await runsOf(routine.id);
      expect(oldest).toBeDefined();

      for (let i = 1; i <= MAX_ROUTINE_RUNS; i += 1) {
        expect((await owner.client.post(`/api/routines/${routine.id}/run`)).status).toBe(202);
      }

      const rows = await runsOf(routine.id);
      expect(rows).toHaveLength(MAX_ROUTINE_RUNS);
      expect(
        rows.map((row) => row.id),
        "只留最近 20 条，最早那条跟着第 21 次运行一起没了",
      ).not.toContain(oldest?.id);
    } finally {
      agent.close();
    }
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
        kind: "send_external",
        summary: "给客户发一封邮件",
        view: { kind: "mcp", server: "", tool: "send_email", params: [] },
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
        kind: "send_external",
        summary: "给客户发一封邮件",
        view: { kind: "mcp", server: "", tool: "send_email", params: [] },
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
        kind: "send_external",
        summary: "给客户发一封邮件",
        view: { kind: "mcp", server: "", tool: "send_email", params: [] },
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
