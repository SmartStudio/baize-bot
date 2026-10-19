import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import {
  CreateBotResponse,
  CreateGroupResponse,
  MessageId,
  MessageListResponse,
  RoutineListResponse,
  RoutineResponse,
  UsageResponse,
  type BotId,
  type ControlToAgent,
  GroupId,
  type Routine,
  type RunId,
  type ServerPush,
} from "@baize/shared";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { databaseUrl } from "../src/env.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { ApiClient, startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, type TestComputer } from "./helpers/fixtures.js";
import { connectPush, type PushClient } from "./helpers/ws.js";

let database: TestDb;
let server: TestServer;

beforeAll(async () => {
  database = await createTestDb();
  server = await startTestServer(database.db, { priceInputPerM: 3, priceOutputPerM: 15 });
});

afterAll(async () => {
  await server.close();
  await database.close();
});

// 输入 10 万、输出 2 万 token：0.1 × 3 + 0.02 × 15。
const totals = { steps: 3, inputTokens: 100_000, outputTokens: 20_000 } as const;
const card = { steps: totals.steps, amount: 0.6 };
const ROUTINE_NAME = "每日工单早报";

type Owner = {
  readonly client: ApiClient;
  readonly agent: AgentClient;
  readonly push: PushClient;
  readonly botId: BotId;
  readonly groupId: GroupId;
  readonly computer: TestComputer;
  close(): void;
};

async function login(): Promise<{ client: ApiClient; computer: TestComputer }> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  return { client, computer };
}

async function ownerWithBot(): Promise<Owner> {
  const { client, computer } = await login();
  const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小服" })).json());
  const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);
  const push = await connectPush(server.server.port, client.cookie ?? "");
  return {
    client,
    agent,
    push,
    botId: created.bot.id,
    groupId: created.group.id,
    computer,
    close: () => {
      agent.close();
      push.close();
    },
  };
}

function runDone(botId: BotId, groupId: GroupId, runId: RunId) {
  return { type: "run_done", runId, botId, groupId, ...totals } as const;
}

/**
 * 库约束当测试钩子：费用卡那条 INSERT 在触发器上抛错，产品代码不知道有它。返回拆掉它的函数，拆两次也行。
 * reason 只能是测试里写死的字面量，它和 onlyRun 原样拼进 SQL。
 */
async function rejectCostCards(
  reason = "p1-sidefx 测试钩子：费用卡写不进去",
  onlyRun?: RunId,
): Promise<() => Promise<void>> {
  const only = onlyRun === undefined ? "" : `AND NEW.body->>'runId' = '${onlyRun}'`;
  await database.sql.unsafe(`
    CREATE FUNCTION p1_sidefx_reject_cost() RETURNS trigger AS $$
    BEGIN
      IF NEW.body->>'kind' = 'cost' ${only} THEN RAISE EXCEPTION '${reason}'; END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
    CREATE TRIGGER p1_sidefx_reject_cost BEFORE INSERT ON messages
      FOR EACH ROW EXECUTE FUNCTION p1_sidefx_reject_cost();
  `);
  return async () => {
    await database.sql.unsafe(`
      DROP TRIGGER IF EXISTS p1_sidefx_reject_cost ON messages;
      DROP FUNCTION IF EXISTS p1_sidefx_reject_cost();
    `);
  };
}

/** 同上，例行记账把运行记录改成 ok 的那条 UPDATE 抛错。 */
async function rejectRoutineOk(): Promise<() => Promise<void>> {
  await database.sql.unsafe(`
    CREATE FUNCTION p1_sidefx_reject_ok() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'p1-sidefx 测试钩子：例行记账写不进去';
    END $$ LANGUAGE plpgsql;
    CREATE TRIGGER p1_sidefx_reject_ok BEFORE UPDATE ON routine_runs
      FOR EACH ROW WHEN (NEW.status = 'ok') EXECUTE FUNCTION p1_sidefx_reject_ok();
  `);
  return async () => {
    await database.sql.unsafe(`
      DROP TRIGGER IF EXISTS p1_sidefx_reject_ok ON routine_runs;
      DROP FUNCTION IF EXISTS p1_sidefx_reject_ok();
    `);
  };
}

/**
 * 屏障：不带 runId 的 agent_error 排在这台电脑此前所有帧后面，它那句 system 推出来，前面的 run_done 就处理完了，
 * 成功和抛错都算。返回屏障之前收到的全部推送，group_turn 也留着。
 */
async function barrier(agent: AgentClient, push: PushClient, groupId: GroupId): Promise<ServerPush[]> {
  const tag = `屏障 ${randomUUID()}`;
  // 毒帧回滚后原 run 仍开着，屏障落到同一人的主助理群，避免把待重试的例行记成失败。
  const [beacon] = await database.sql<
    { id: string }[]
  >`SELECT g.id FROM groups g JOIN bots b ON b.id=g.solo_bot_id WHERE b.role='assistant' AND g.owner_id=(SELECT owner_id FROM groups WHERE id=${groupId}) LIMIT 1`;
  const beaconGroup = GroupId.parse(beacon?.id ?? groupId);
  agent.send({ type: "agent_error", code: "runner_failed", detail: tag, groupId: beaconGroup });
  const before: ServerPush[] = [];
  for (;;) {
    const event = await push.nextRaw();
    if (event.type === "message" && event.message.body.kind === "system" && event.message.body.text.endsWith(tag)) {
      return before;
    }
    before.push(event);
  }
}

function pushedCards(pushes: readonly ServerPush[], runId: RunId) {
  return pushes.flatMap((event) =>
    event.type === "message" && event.message.body.kind === "cost" && event.message.body.runId === runId
      ? [{ steps: event.message.body.steps, amount: event.message.body.amount }]
      : [],
  );
}

async function storedCards(client: ApiClient, groupId: GroupId, runId: RunId) {
  const page = MessageListResponse.parse(await (await client.get(`/api/groups/${groupId}/messages`)).json());
  return page.messages.flatMap((message) =>
    message.body.kind === "cost" && message.body.runId === runId
      ? [{ steps: message.body.steps, amount: message.body.amount }]
      : [],
  );
}

async function usageOf(client: ApiClient, runId: RunId) {
  const usage = UsageResponse.parse(await (await client.get("/api/usage")).json());
  return usage.recent.find((item) => item.runId === runId);
}

function turns(pushes: readonly ServerPush[], groupId: GroupId) {
  return pushes.flatMap((event) =>
    event.type === "group_turn" && event.groupId === groupId ? [{ current: event.current, next: event.next }] : [],
  );
}

function notices(pushes: readonly ServerPush[]) {
  return pushes.flatMap((event) => (event.type === "notify" ? [event.notice] : []));
}

/** 运行记录记成 ok 的那几次推送。试跑开始时也推一条，那条是 running，不算。 */
function okUpdates(pushes: readonly ServerPush[], routineId: string) {
  return pushes.filter(
    (event) =>
      event.type === "routine_updated" && event.routine.id === routineId && event.routine.runs[0]?.status === "ok",
  );
}

async function routineOf(client: ApiClient, routineId: string): Promise<Routine> {
  const response = await client.get("/api/routines");
  expect(response.status).toBe(200);
  const routine = RoutineListResponse.parse(await response.json()).items.find((item) => item.id === routineId);
  if (routine === undefined) throw new Error(`例行任务 ${routineId} 不在列表里`);
  return routine;
}

/** 协议 1 的两阶段结账遗留数据：只用于验证升级后的 hello 仍能补结旧账。 */
async function legacyUncharged(runId: RunId): Promise<void> {
  await database.sql`UPDATE runs SET ended_at=now(), charged_at=NULL, steps=3, input_tokens=100000, output_tokens=20000, amount=0.6 WHERE id=${runId}`;
}

it("费用卡毒帧回滚 run 和费用卡，新帧在故障排除后只结一次", async () => {
  const owner = await ownerWithBot();
  const restore = await rejectCostCards();
  try {
    expect((await owner.client.post(`/api/groups/${owner.groupId}/messages`, { text: "做这件事" })).status).toBe(201);
    const { runId } = await owner.agent.expect("prompt");

    owner.agent.send(runDone(owner.botId, owner.groupId, runId));
    const failed = await barrier(owner.agent, owner.push, owner.groupId);
    expect(owner.agent.ackCount(runId), "毒帧只有拒收确认，不计成功").toBe(0);
    expect(pushedCards(failed, runId)).toEqual([]);
    expect(await storedCards(owner.client, owner.groupId, runId)).toEqual([]);
    expect((await usageOf(owner.client, runId))?.endedAt, "结束和费用卡一起回滚").toBeNull();
    await vi.waitFor(() => {
      expect(owner.agent.uplinkAcks().flatMap((ack) => ack.rejected)).toMatchObject([{ code: "invalid", seq: 1 }]);
    });

    await restore();
    owner.agent.send(runDone(owner.botId, owner.groupId, runId));
    await owner.agent.ack(runId);
    owner.agent.send(runDone(owner.botId, owner.groupId, runId));
    await owner.agent.ack(runId, 2);
    const replayed = await barrier(owner.agent, owner.push, owner.groupId);
    expect(pushedCards(replayed, runId), "补发补出一张，再补发不再出").toEqual([card]);
    expect(await storedCards(owner.client, owner.groupId, runId)).toEqual([card]);
    expect(await usageOf(owner.client, runId)).toMatchObject(card);
  } finally {
    await restore();
    owner.close();
  }
});

it("例行毒帧回滚结束、费用卡和例行账，新帧只结一次", async () => {
  const owner = await ownerWithBot();
  const restore = await rejectRoutineOk();
  try {
    const created = await owner.client.post(`/api/bots/${owner.botId}/routines`, {
      name: ROUTINE_NAME,
      instruction: "把今天的工单汇总一下",
      triggers: [{ kind: "cron", expr: "* * * * *" }],
      onFailure: "stop_and_tell",
    });
    expect(created.status).toBe(201);
    const routine = RoutineResponse.parse(await created.json()).routine;
    expect((await owner.client.post(`/api/routines/${routine.id}/run`)).status).toBe(202);
    const { runId } = await owner.agent.expect("prompt");
    owner.agent.send({
      type: "bot_text",
      runId,
      botId: owner.botId,
      groupId: owner.groupId,
      messageId: MessageId.parse(randomUUID()),
      delta: "工单早报已经整理好",
      done: true,
    });

    owner.agent.send(runDone(owner.botId, owner.groupId, runId));
    const failed = await barrier(owner.agent, owner.push, owner.groupId);
    expect(owner.agent.ackCount(runId), "毒帧只有拒收确认，不计成功").toBe(0);
    expect(pushedCards(failed, runId), "费用卡和记账在一个事务里，记账没成费用卡也不出").toEqual([]);
    expect(okUpdates(failed, routine.id)).toEqual([]);
    expect(notices(failed), "账没结清不弹结果通知").toEqual([]);
    expect((await routineOf(owner.client, routine.id)).runs, "记账回滚，运行记录还在 running").toMatchObject([
      { status: "running", note: "" },
    ]);

    await restore();
    owner.agent.send(runDone(owner.botId, owner.groupId, runId));
    await owner.agent.ack(runId);
    owner.agent.send(runDone(owner.botId, owner.groupId, runId));
    await owner.agent.ack(runId, 2);
    const replayed = await barrier(owner.agent, owner.push, owner.groupId);
    expect((await routineOf(owner.client, routine.id)).runs, "补发记成 ok，花费只缀一次").toMatchObject([
      { status: "ok", note: "¥0.60" },
    ]);
    expect(pushedCards(replayed, runId)).toEqual([card]);
    expect(okUpdates(replayed, routine.id), "两次补发各推一次 ok，按 id 整条覆盖，重复无害").toHaveLength(2);
    expect(notices(replayed), "例行做完不弹通知，补发也不会补出一条").toEqual([]);
  } finally {
    await restore();
    owner.close();
  }
});

it("正常 run_done 重复送达不重复出费用卡、不重复推进回合", async () => {
  const { client, computer } = await login();
  const makeBot = async (name: string, tag: string) =>
    CreateBotResponse.parse(await (await client.post("/api/bots", { name, tag })).json());
  const sales = await makeBot("小销", "销售");
  const service = await makeBot("小服", "客服");
  const response = await client.post("/api/groups", { title: "双十一大促", botIds: [sales.bot.id, service.bot.id] });
  expect(response.status).toBe(201);
  const group = CreateGroupResponse.parse(await response.json()).group;
  const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);
  const push = await connectPush(server.server.port, client.cookie ?? "");
  const nextPrompt = async (): Promise<Extract<ControlToAgent, { type: "prompt" }>> => {
    for (;;) {
      const message = await agent.next();
      if (message.type === "prompt") return message;
    }
  };
  try {
    expect((await client.post(`/api/groups/${group.id}/messages`, { text: "@小服 @小销 回答" })).status).toBe(201);
    const first = await nextPrompt();
    expect(first.botId).toBe(service.bot.id);
    agent.send(runDone(service.bot.id, group.id, first.runId));
    await agent.ack(first.runId);
    agent.send(runDone(service.bot.id, group.id, first.runId));
    await agent.ack(first.runId, 2);
    const second = await nextPrompt();
    expect(second.botId).toBe(sales.bot.id);
    const between = await barrier(agent, push, service.group.id);

    agent.send(runDone(sales.bot.id, group.id, second.runId));
    await agent.ack(second.runId);
    const after = await barrier(agent, push, service.group.id);

    expect(turns(between, group.id), "小服重复的 run_done 没把小销这一轮提前关掉").toEqual([
      { current: service.bot.id, next: [sales.bot.id] },
      { current: sales.bot.id, next: [] },
    ]);
    expect(turns(after, group.id), "小销做完才关轮").toEqual([{ current: null, next: [] }]);
    expect(pushedCards([...between, ...after], first.runId), "小服只出一张费用卡").toEqual([card]);
    expect(await storedCards(client, group.id, first.runId)).toEqual([card]);
    expect(pushedCards(after, second.runId)).toEqual([card]);
  } finally {
    agent.close();
    push.close();
  }
});

/** 两个 Bot 的群，用户 @ 两个，先派到 firstName。 */
async function team(target: { readonly server: { readonly port: number }; client(): ApiClient } = server) {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = target.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const makeBot = async (name: string) =>
    CreateBotResponse.parse(await (await client.post("/api/bots", { name })).json());
  const first = await makeBot("小甲");
  const second = await makeBot("小乙");
  const response = await client.post("/api/groups", { title: "结账", botIds: [first.bot.id, second.bot.id] });
  expect(response.status).toBe(201);
  const group = CreateGroupResponse.parse(await response.json()).group;
  const { agent } = await helloAgent(target.server.port, computer.computerId, computer.token);
  const push = await connectPush(target.server.port, client.cookie ?? "");
  expect((await client.post(`/api/groups/${group.id}/messages`, { text: "@小甲 @小乙 各说一句" })).status).toBe(201);
  const prompt = await agent.expect("prompt");
  expect(prompt.botId).toBe(first.bot.id);
  return { user, computer, client, agent, push, group, first, second, prompt };
}

function say(agent: AgentClient, prompt: Extract<ControlToAgent, { type: "prompt" }>, text: string): void {
  agent.send({
    type: "bot_text",
    runId: prompt.runId,
    botId: prompt.botId,
    groupId: prompt.groupId,
    messageId: MessageId.parse(randomUUID()),
    delta: text,
    done: true,
  });
}

async function groupCards(client: ApiClient, groupId: GroupId) {
  const page = MessageListResponse.parse(await (await client.get(`/api/groups/${groupId}/messages`)).json());
  return page.messages.flatMap((message) =>
    message.body.kind === "cost"
      ? [{ runId: message.body.runId, steps: message.body.steps, amount: message.body.amount }]
      : [],
  );
}

async function runLedger(groupId: GroupId) {
  const [row] = await database.sql<{ amount: string; uncharged: number }[]>`
    SELECT sum(amount)::text AS amount, count(*) FILTER (WHERE ended_at IS NOT NULL AND charged_at IS NULL)::int AS uncharged
    FROM runs WHERE group_id = ${groupId}`;
  return row;
}

/**
 * 同一个测试库上另起一个控制面子进程。重启要真换进程：回合、先记着的 pass、结账失败时的结论都在模块级内存里，
 * 同进程里关了再开还记得。
 */
async function childServer() {
  const url = new URL(databaseUrl());
  url.pathname = `/${database.databaseName}`;
  const source = `
    const root = "file://" + process.cwd() + "/";
    const { connect } = await import(new URL("src/db/client.ts", root).href);
    const { startTestServer } = await import(new URL("test/helpers/client.ts", root).href);
    const { db, sql } = connect(process.env.SIDEFX_DATABASE_URL, { max: 4 });
    const server = await startTestServer(db, { priceInputPerM: 3, priceOutputPerM: 15 });
    process.once("message", async () => {
      await server.close();
      await sql.end();
      process.exit(0);
    });
    process.send({ port: server.server.port });
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    cwd: process.cwd(),
    env: { ...process.env, SIDEFX_DATABASE_URL: url.toString() },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  const port = await new Promise<number>((resolve, reject) => {
    child.once("exit", (code) => reject(new Error(`控制面子进程提前退出：${code}`)));
    child.once("message", (message) => {
      if (typeof message === "object" && message !== null && "port" in message && typeof message.port === "number") {
        resolve(message.port);
      }
    });
  });
  return {
    server: { port },
    client: () => new ApiClient(port),
    close: async () => {
      if (child.connected) child.send("close");
      expect(await exited, "子进程正常退出").toBe(0);
    },
  };
}

it("先记着的 pass 不结账，下一张费用卡认领它，金额并进那张卡", async () => {
  const who = await team();
  try {
    say(who.agent, who.prompt, "(pass)");
    who.agent.send(runDone(who.first.bot.id, who.group.id, who.prompt.runId));
    await who.agent.ack(who.prompt.runId);
    const second = await who.agent.expect("prompt");
    expect(await runLedger(who.group.id), "pass 的账先记着：run 行有金额，charged_at 还空").toEqual({
      amount: "0.600000",
      uncharged: 1,
    });

    who.agent.send(runDone(who.first.bot.id, who.group.id, who.prompt.runId));
    await who.agent.ack(who.prompt.runId, 2);
    who.agent.send(runDone(who.second.bot.id, who.group.id, second.runId));
    await who.agent.ack(second.runId);
    await barrier(who.agent, who.push, who.group.id);
    expect(await groupCards(who.client, who.group.id), "小乙一张卡带上小甲的 pass").toEqual([
      { runId: second.runId, steps: 6, amount: 1.2 },
    ]);
    expect(await runLedger(who.group.id)).toEqual({ amount: "1.200000", uncharged: 0 });
  } finally {
    who.agent.close();
    who.push.close();
  }
});

it("已确认的 pass 在控制面重启后自己成一张卡，卡上合计和 run 账本一致", async () => {
  let current = await childServer();
  const who = await team(current);
  let agent = who.agent;
  let push = who.push;
  const restore = await rejectCostCards();
  try {
    say(agent, who.prompt, "(pass)");
    agent.send(runDone(who.first.bot.id, who.group.id, who.prompt.runId));
    await agent.ack(who.prompt.runId);
    const second = await agent.expect("prompt");
    agent.send(runDone(who.second.bot.id, who.group.id, second.runId));
    await barrier(agent, push, who.group.id);
    expect(agent.ackCount(second.runId), "小乙的毒帧拒收").toBe(0);
    await legacyUncharged(second.runId);
    expect(await groupCards(who.client, who.group.id)).toEqual([]);

    agent.close();
    push.close();
    await current.close();
    await restore();
    current = await childServer();
    const client = current.client();
    expect((await client.login(who.user.email, PASSWORD)).status).toBe(200);
    push = await connectPush(current.server.port, client.cookie ?? "");
    agent = (await helloAgent(current.server.port, who.computer.computerId, who.computer.token)).agent;
    await barrier(agent, push, who.group.id);
    expect(await groupCards(client, who.group.id), "新进程不记得 pass，hello 补结账各单落一张").toEqual([
      { runId: who.prompt.runId, steps: 3, amount: 0.6 },
      { runId: second.runId, steps: 3, amount: 0.6 },
    ]);
    expect(await runLedger(who.group.id)).toEqual({ amount: "1.200000", uncharged: 0 });

    agent.send(runDone(who.second.bot.id, who.group.id, second.runId));
    await agent.ack(second.runId);
    await barrier(agent, push, who.group.id);
    expect((await groupCards(client, who.group.id)).length, "补发撞上已结的行不再出卡").toBe(2);
  } finally {
    await restore();
    agent.close();
    push.close();
    await current.close();
  }
});

async function makeRoutine(owner: Owner, name = ROUTINE_NAME): Promise<Routine> {
  const created = await owner.client.post(`/api/bots/${owner.botId}/routines`, {
    name,
    instruction: "把今天的工单汇总一下",
    triggers: [{ kind: "cron", expr: "* * * * *" }],
    onFailure: "stop_and_tell",
  });
  expect(created.status).toBe(201);
  return RoutineResponse.parse(await created.json()).routine;
}

/** 让指定例行任务第一次「ok」的状态推送在 PushHub 上抛错，其余照发。 */
function failFirstOkPush(routineId: string) {
  const hub = server.server.hub;
  const send = hub.push.bind(hub);
  const state = { failed: false };
  const spy = vi.spyOn(hub, "push").mockImplementation((userId, event) => {
    if (
      !state.failed &&
      event.type === "routine_updated" &&
      event.routine.id === routineId &&
      event.routine.runs[0]?.status === "ok"
    ) {
      state.failed = true;
      throw new Error("测试钩子：例行推送发不出去");
    }
    send(userId, event);
  });
  return { state, spy };
}

it("例行推送在结账提交后抛错只记日志：确认照回，HTTP 读到 ok", async () => {
  const owner = await ownerWithBot();
  const routine = await makeRoutine(owner);
  const fault = failFirstOkPush(routine.id);
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect((await owner.client.post(`/api/routines/${routine.id}/run`)).status).toBe(202);
    const { runId } = await owner.agent.expect("prompt");
    owner.agent.send(runDone(owner.botId, owner.groupId, runId));
    await owner.agent.ack(runId);
    const first = await barrier(owner.agent, owner.push, owner.groupId);
    expect(fault.state.failed, "故障钩子确实命中").toBe(true);
    expect(okUpdates(first, routine.id)).toEqual([]);
    expect(pushedCards(first, runId), "账已经结了").toEqual([card]);
    expect((await routineOf(owner.client, routine.id)).runs, "实时推送丢了，HTTP 拉到的是对的").toMatchObject([
      { status: "ok", note: "¥0.60" },
    ]);
  } finally {
    logged.mockRestore();
    fault.spy.mockRestore();
    owner.close();
  }
});

it("hello 补结账时前一条的例行推送抛错，同一次 hello 里后一条欠账照样补上", async () => {
  const owner = await ownerWithBot();
  const { computer } = owner;
  const morning = await makeRoutine(owner, "早报");
  const evening = await makeRoutine(owner, "晚报");
  const restore = await rejectCostCards();
  let agent = owner.agent;
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  let fault: ReturnType<typeof failFirstOkPush> | null = null;
  try {
    expect((await owner.client.post(`/api/routines/${morning.id}/run`)).status).toBe(202);
    const first = await agent.expect("prompt");
    agent.send(runDone(owner.botId, owner.groupId, first.runId));
    await barrier(agent, owner.push, owner.groupId);
    expect((await owner.client.post(`/api/routines/${evening.id}/run`)).status).toBe(202);
    const second = await agent.expect("prompt");
    agent.send(runDone(owner.botId, owner.groupId, second.runId));
    await barrier(agent, owner.push, owner.groupId);
    expect(agent.ackCount(first.runId) + agent.ackCount(second.runId), "两条都拒收").toBe(0);
    await legacyUncharged(first.runId);
    await legacyUncharged(second.runId);

    await restore();
    fault = failFirstOkPush(morning.id);
    agent.close();
    agent = (await helloAgent(server.server.port, computer.computerId, computer.token)).agent;
    const recovered = await barrier(agent, owner.push, owner.groupId);
    expect(fault.state.failed, "早报的推送确实抛了").toBe(true);
    expect(pushedCards(recovered, first.runId)).toEqual([card]);
    expect(pushedCards(recovered, second.runId), "晚报没被前一条的推送故障挡住").toEqual([card]);
    expect(okUpdates(recovered, evening.id)).toHaveLength(1);
    expect((await routineOf(owner.client, morning.id)).runs).toMatchObject([{ status: "ok", note: "¥0.60" }]);
    expect((await routineOf(owner.client, evening.id)).runs).toMatchObject([{ status: "ok", note: "¥0.60" }]);
  } finally {
    logged.mockRestore();
    fault?.spy.mockRestore();
    await restore();
    agent.close();
    owner.close();
  }
});

it("hello 补结账时一条欠账结不成，不挡同一次 hello 里后面的", async () => {
  const owner = await ownerWithBot();
  const { computer } = owner;
  let restore = await rejectCostCards();
  let agent = owner.agent;
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const runs: RunId[] = [];
    for (const text of ["先做这件", "再做那件"]) {
      expect((await owner.client.post(`/api/groups/${owner.groupId}/messages`, { text })).status).toBe(201);
      const { runId } = await agent.expect("prompt");
      agent.send(runDone(owner.botId, owner.groupId, runId));
      await barrier(agent, owner.push, owner.groupId);
      await legacyUncharged(runId);
      runs.push(runId);
    }
    const [stuck, later] = runs as [RunId, RunId];
    await restore();
    restore = await rejectCostCards("p1-sidefx 测试钩子：只有前一条写不进去", stuck);

    agent.close();
    agent = (await helloAgent(server.server.port, computer.computerId, computer.token)).agent;
    await barrier(agent, owner.push, owner.groupId);
    expect(await storedCards(owner.client, owner.groupId, stuck), "前一条还欠着").toEqual([]);
    expect(await storedCards(owner.client, owner.groupId, later), "后一条照样补上").toEqual([card]);

    await restore();
    agent.close();
    agent = (await helloAgent(server.server.port, computer.computerId, computer.token)).agent;
    await barrier(agent, owner.push, owner.groupId);
    expect(await storedCards(owner.client, owner.groupId, stuck), "故障排除后下一次 hello 补上前一条").toEqual([card]);
  } finally {
    logged.mockRestore();
    await restore();
    agent.close();
    owner.close();
  }
});

it("run_done 结账出错的日志只带错误类别和 id，不带异常原文", async () => {
  const owner = await ownerWithBot();
  const marker = "synthetic_private_prompt_r3";
  const restore = await rejectCostCards(`费用卡写不进去 ${marker} Bearer synthetic_bearer_r3`);
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect((await owner.client.post(`/api/groups/${owner.groupId}/messages`, { text: "做这件事" })).status).toBe(201);
    const { runId } = await owner.agent.expect("prompt");
    logged.mockClear();
    owner.agent.send(runDone(owner.botId, owner.groupId, runId));
    await barrier(owner.agent, owner.push, owner.groupId);
    expect(owner.agent.ackCount(runId), "结账失败，不回确认").toBe(0);
    const printed = logged.mock.calls.map((args) => args.map((arg) => inspect(arg, { depth: 10 })).join(" "));
    for (const line of printed) {
      expect(line, "异常原文不进日志").not.toContain(marker);
      expect(line).not.toContain("synthetic_bearer_r3");
    }
    const all = printed.join("\n");
    expect(all, "日志带 pg 错误码").toContain("P0001");
    expect(all, "日志带 run").toContain(runId);
    expect(all, "日志带电脑").toContain(owner.computer.computerId);
  } finally {
    logged.mockRestore();
    await restore();
    owner.close();
  }
});

it("hello 补结账出错的日志只带错误类别和 id，不带异常原文", async () => {
  const owner = await ownerWithBot();
  const { computer } = owner;
  const marker = "synthetic_private_prompt_7f3a";
  const restore = await rejectCostCards(`费用卡写不进去 ${marker} Bearer synthetic_bearer_7f3a`);
  let agent = owner.agent;
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect((await owner.client.post(`/api/groups/${owner.groupId}/messages`, { text: "做这件事" })).status).toBe(201);
    const { runId } = await agent.expect("prompt");
    agent.send(runDone(owner.botId, owner.groupId, runId));
    await barrier(agent, owner.push, owner.groupId);
    await legacyUncharged(runId);
    logged.mockClear();

    agent.close();
    agent = (await helloAgent(server.server.port, computer.computerId, computer.token)).agent;
    await barrier(agent, owner.push, owner.groupId);
    expect(agent.ackCount(runId), "补结账失败，不回确认").toBe(0);
    const printed = logged.mock.calls.map((args) => args.map((arg) => inspect(arg, { depth: 10 })).join(" "));
    for (const line of printed) {
      expect(line, "异常原文不进日志").not.toContain(marker);
      expect(line).not.toContain("synthetic_bearer_7f3a");
    }
    const all = printed.join("\n");
    expect(all, "日志带 pg 错误码").toContain("P0001");
    expect(all, "日志带 run").toContain(runId);
    expect(all, "日志带电脑").toContain(computer.computerId);
  } finally {
    logged.mockRestore();
    await restore();
    agent.close();
    owner.close();
  }
});

it("补发放手之后欠的账，故障排除后下一次 hello 补齐；故障还在时不回确认", async () => {
  const owner = await ownerWithBot();
  const { computer } = owner;
  const created = await owner.client.post(`/api/bots/${owner.botId}/routines`, {
    name: ROUTINE_NAME,
    instruction: "把今天的工单汇总一下",
    triggers: [{ kind: "cron", expr: "* * * * *" }],
    onFailure: "stop_and_tell",
  });
  const routine = RoutineResponse.parse(await created.json()).routine;
  expect((await owner.client.post(`/api/routines/${routine.id}/run`)).status).toBe(202);
  const { runId } = await owner.agent.expect("prompt");
  const restore = await rejectCostCards();
  let agent = owner.agent;
  try {
    // 首次发送加三次重连补发都失败，代理放手，之后的 hello 不再报它。
    for (let attempt = 0; attempt < 4; attempt++) {
      agent.send(runDone(owner.botId, owner.groupId, runId));
      await barrier(agent, owner.push, owner.groupId);
      expect(agent.ackCount(runId), `第 ${attempt + 1} 次毒帧拒收`).toBe(0);
      if (attempt === 0) await legacyUncharged(runId);
      agent.close();
      agent = (await helloAgent(server.server.port, computer.computerId, computer.token)).agent;
      await barrier(agent, owner.push, owner.groupId);
      expect(agent.ackCount(runId), "故障还在时 hello 补结账也失败，不回确认").toBe(0);
    }
    expect(await storedCards(owner.client, owner.groupId, runId)).toEqual([]);
    expect((await routineOf(owner.client, routine.id)).runs).toMatchObject([{ status: "running", note: "" }]);

    await restore();
    agent.close();
    agent = (await helloAgent(server.server.port, computer.computerId, computer.token)).agent;
    const recovered = await barrier(agent, owner.push, owner.groupId);
    expect(pushedCards(recovered, runId), "hello 补出费用卡").toEqual([card]);
    expect(okUpdates(recovered, routine.id), "补推例行状态").toHaveLength(1);
    expect(await storedCards(owner.client, owner.groupId, runId)).toEqual([card]);
    expect((await routineOf(owner.client, routine.id)).runs).toMatchObject([{ status: "ok", note: "¥0.60" }]);

    agent.close();
    agent = (await helloAgent(server.server.port, computer.computerId, computer.token)).agent;
    await barrier(agent, owner.push, owner.groupId);
    expect(await storedCards(owner.client, owner.groupId, runId), "再 hello 不重复").toEqual([card]);
  } finally {
    await restore();
    agent.close();
    owner.close();
  }
});
