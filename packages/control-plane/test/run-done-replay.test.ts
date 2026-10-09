import {
  CreateBotResponse,
  MessageListResponse,
  UsageResponse,
  type GroupId,
  type RunId,
  type ServerPush,
} from "@baize/shared";
import { afterAll, beforeAll, expect, it } from "vitest";
import { DEFAULT_RUNTIME_CONFIG, startServer, type RunningServer } from "../src/server.js";
import { ApiClient, TEST_CREDENTIALS_KEY } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser } from "./helpers/fixtures.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { connectPush } from "./helpers/ws.js";

const notice = "电脑断过线，这次活没做完";
const config = { ...DEFAULT_RUNTIME_CONFIG, priceInputPerM: 3, priceOutputPerM: 15 };
// 输入 10 万、输出 2 万 token：0.1 × 3 + 0.02 × 15。
const totals = { steps: 3, inputTokens: 100_000, outputTokens: 20_000 } as const;
const amount = 0.6;

let database: TestDb;
let patient: RunningServer;
let hasty: RunningServer;

beforeAll(async () => {
  database = await createTestDb();
  const base = { db: database.db, port: 0, config, credentialsKey: TEST_CREDENTIALS_KEY } as const;
  // 宽限设长，断开到重连之间只有 hello 对账会收尾。
  patient = await startServer({ ...base, disconnectGraceMs: 60_000 });
  hasty = await startServer({ ...base, disconnectGraceMs: 50 });
});

afterAll(async () => {
  await patient.close();
  await hasty.close();
  await database.close();
});

async function ownerWithBot(server: RunningServer) {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = new ApiClient(server.port);
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小服" })).json());
  const push = await connectPush(server.port, client.cookie ?? "");
  return { computer, client, push, groupId: created.group.id, botId: created.bot.id };
}

type Owner = Awaited<ReturnType<typeof ownerWithBot>>;

async function startRun(owner: Owner, agent: AgentClient): Promise<RunId> {
  expect((await owner.client.post(`/api/groups/${owner.groupId}/messages`, { text: "做这件事" })).status).toBe(201);
  return (await agent.expect("prompt")).runId;
}

function runDone(owner: Owner, runId: RunId) {
  return { type: "run_done", runId, botId: owner.botId, groupId: owner.groupId, ...totals } as const;
}

async function usageOf(client: ApiClient, runId: RunId) {
  const usage = UsageResponse.parse(await (await client.get("/api/usage")).json());
  return usage.recent.find((item) => item.runId === runId);
}

async function systemTexts(client: ApiClient, groupId: GroupId): Promise<string[]> {
  const page = MessageListResponse.parse(await (await client.get(`/api/groups/${groupId}/messages`)).json());
  return page.messages.flatMap((message) => (message.body.kind === "system" ? [message.body.text] : []));
}

/** 发一条用户消息当哨兵，收下它之前的推送。推送按产生顺序到，哨兵之前没出现的，之后也不会再为这个 run 出现。 */
async function pushesUntilSentinel(owner: Owner): Promise<ServerPush[]> {
  const sentinel = `哨兵 ${Math.random()}`;
  expect((await owner.client.post(`/api/groups/${owner.groupId}/messages`, { text: sentinel })).status).toBe(201);
  const seen: ServerPush[] = [];
  for (;;) {
    const event = await owner.push.next();
    if (event.type === "message" && event.message.body.kind === "user" && event.message.body.text === sentinel) {
      return seen;
    }
    seen.push(event);
  }
}

/** 这个 run 推出去的收尾：费用卡和断线那句。 */
function endings(pushes: readonly ServerPush[], runId: RunId) {
  return pushes.flatMap((event) => {
    if (event.type !== "message") return [];
    const body = event.message.body;
    if (body.kind === "cost" && body.runId === runId) return [`cost ${body.steps} ${body.amount}`];
    if (body.kind === "system" && body.text === notice) return ["notice"];
    return [];
  });
}

async function disconnect(agent: AgentClient): Promise<void> {
  agent.close();
  await agent.closed();
}

it("断线期间跑完的 run：hello 报它还在跑，welcome 后补发的 run_done 记下真步骤和真费用，只推一张费用卡，重复补发不再推", async () => {
  const owner = await ownerWithBot(patient);
  const first = (await helloAgent(patient.port, owner.computer.computerId, owner.computer.token)).agent;
  const runId = await startRun(owner, first);
  await disconnect(first);

  const second = (await helloAgent(patient.port, owner.computer.computerId, owner.computer.token, [runId])).agent;
  try {
    expect((await usageOf(owner.client, runId))?.endedAt, "hello 报着它，对账不能按断线收尾").toBeNull();
    second.send(runDone(owner, runId));
    await second.ack(runId);
    second.send(runDone(owner, runId));
    await second.ack(runId, 2);

    expect(endings(await pushesUntilSentinel(owner), runId), "补发和重复补发合起来只推一张费用卡").toEqual([
      `cost ${totals.steps} ${amount}`,
    ]);
    expect(await usageOf(owner.client, runId)).toMatchObject({ steps: totals.steps, amount });
    expect(await systemTexts(owner.client, owner.groupId)).not.toContain(notice);
  } finally {
    second.close();
    owner.push.close();
  }
});

it("代理重启丢了待发表：hello 没报它，对账按断线收尾；之后晚到的 run_done 不改写结果、不推费用卡，照样回确认", async () => {
  const owner = await ownerWithBot(patient);
  const first = (await helloAgent(patient.port, owner.computer.computerId, owner.computer.token)).agent;
  const runId = await startRun(owner, first);
  await disconnect(first);

  const second = (await helloAgent(patient.port, owner.computer.computerId, owner.computer.token)).agent;
  try {
    second.send(runDone(owner, runId));
    await second.ack(runId);

    expect(endings(await pushesUntilSentinel(owner), runId), "对账先收尾，只有那句断线").toEqual(["notice"]);
    expect(await usageOf(owner.client, runId)).toMatchObject({ steps: 0, amount: 0 });
  } finally {
    second.close();
    owner.push.close();
  }
});

it("宽限到期先按断线收尾，代理回来时仍报着它并补发：只有那句断线，不推费用卡，照样回确认", async () => {
  const owner = await ownerWithBot(hasty);
  const first = (await helloAgent(hasty.port, owner.computer.computerId, owner.computer.token)).agent;
  const runId = await startRun(owner, first);
  await disconnect(first);
  for (;;) {
    const event = await owner.push.next();
    if (event.type === "message" && event.message.body.kind === "system" && event.message.body.text === notice) break;
  }

  const second = (await helloAgent(hasty.port, owner.computer.computerId, owner.computer.token, [runId])).agent;
  try {
    second.send(runDone(owner, runId));
    await second.ack(runId);

    expect(endings(await pushesUntilSentinel(owner), runId), "宽限已经收过尾，补发不再推").toEqual([]);
    expect(await usageOf(owner.client, runId)).toMatchObject({ steps: 0, amount: 0 });
    expect((await systemTexts(owner.client, owner.groupId)).filter((text) => text === notice)).toHaveLength(1);
  } finally {
    second.close();
    owner.push.close();
  }
});

it("连接一直在时的 run_done 也回确认，代理靠它把这条从待发表里删掉", async () => {
  const owner = await ownerWithBot(patient);
  const { agent } = await helloAgent(patient.port, owner.computer.computerId, owner.computer.token);
  try {
    const runId = await startRun(owner, agent);
    agent.send(runDone(owner, runId));
    await agent.ack(runId);
    expect(endings(await pushesUntilSentinel(owner), runId)).toEqual([`cost ${totals.steps} ${amount}`]);
  } finally {
    agent.close();
    owner.push.close();
  }
});
