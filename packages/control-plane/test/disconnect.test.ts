import { Computer, CreateBotResponse, MessageListResponse, type GroupId, type RunId } from "@baize/shared";
import { afterAll, beforeAll, expect, it } from "vitest";
import { DEFAULT_RUNTIME_CONFIG, startServer, type RunningServer } from "../src/server.js";
import { ApiClient } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, waitFor, type TestComputer } from "./helpers/fixtures.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { connectPush } from "./helpers/ws.js";

const notice = "电脑断过线，这次活没做完";
const graceMs = 200;
let database: TestDb;
let server: RunningServer;

beforeAll(async () => {
  database = await createTestDb();
  server = await startServer({ db: database.db, port: 0, config: DEFAULT_RUNTIME_CONFIG, disconnectGraceMs: graceMs });
});

afterAll(async () => {
  await server.close();
  await database.close();
});

async function ownerWithBot() {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = new ApiClient(server.port);
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小服" })).json());
  return { computer, client, groupId: created.group.id };
}

async function connect(computer: TestComputer, activeRuns: readonly RunId[] = []): Promise<AgentClient> {
  return (await helloAgent(server.port, computer.computerId, computer.token, activeRuns)).agent;
}

async function startRun(client: ApiClient, groupId: GroupId, agent: AgentClient): Promise<RunId> {
  expect((await client.post(`/api/groups/${groupId}/messages`, { text: "做这件事" })).status).toBe(201);
  const prompt = await agent.expect("prompt");
  return prompt.runId;
}

async function ended(runId: RunId): Promise<boolean> {
  const rows = await database.sql<{ ended_at: string | null }[]>`SELECT ended_at FROM runs WHERE id = ${runId}`;
  const row = rows[0];
  return row !== undefined && row.ended_at !== null;
}

async function notices(client: ApiClient, groupId: GroupId): Promise<number> {
  const page = MessageListResponse.parse(await (await client.get(`/api/groups/${groupId}/messages`)).json());
  return page.messages.filter((message) => message.body.kind === "system" && message.body.text === notice).length;
}

it("hello 只收尾 activeRuns 之外的 run，并推送失败消息", async () => {
  const owner = await ownerWithBot();
  const first = await connect(owner.computer);
  const push = await connectPush(server.port, owner.client.cookie ?? "");
  try {
    const alive = await startRun(owner.client, owner.groupId, first);
    const missing = await startRun(owner.client, owner.groupId, first);
    const second = await connect(owner.computer, [alive]);
    try {
      expect(await first.closed()).toBe(4000);
      await waitFor(() => ended(missing), "丢失的 run 收尾");
      expect(await ended(alive), "hello 报活着的 run 不能收尾").toBe(false);
      expect(await notices(owner.client, owner.groupId)).toBe(1);
      const received: string[] = [];
      while (received.length < 1) {
        const event = await push.next();
        if (event.type === "message" && event.message.body.kind === "system") received.push(event.message.body.text);
      }
      expect(received).toEqual([notice]);
    } finally {
      second.close();
    }
  } finally {
    first.close();
    push.close();
  }
});

it("宽限到期且电脑未重连时收尾", async () => {
  const owner = await ownerWithBot();
  const agent = await connect(owner.computer);
  const runId = await startRun(owner.client, owner.groupId, agent);
  agent.close();
  await agent.closed();
  await waitFor(() => ended(runId), "宽限到期后 run 收尾");
  expect(await notices(owner.client, owner.groupId)).toBe(1);
});

it("宽限到期前重连并报告活着的 run，不收尾", async () => {
  const owner = await ownerWithBot();
  const first = await connect(owner.computer);
  const runId = await startRun(owner.client, owner.groupId, first);
  first.close();
  await first.closed();
  const second = await connect(owner.computer, [runId]);
  try {
    await new Promise((resolve) => setTimeout(resolve, graceMs + 80));
    expect(await ended(runId)).toBe(false);
    expect(await notices(owner.client, owner.groupId)).toBe(0);
    expect(Computer.parse(await (await owner.client.get("/api/computer")).json()).status).toBe("online");
  } finally {
    second.close();
  }
});

it("被顶掉的旧连接关闭不启动收尾", async () => {
  const owner = await ownerWithBot();
  const first = await connect(owner.computer);
  const runId = await startRun(owner.client, owner.groupId, first);
  const second = await connect(owner.computer, [runId]);
  try {
    expect(await first.closed()).toBe(4000);
    await new Promise((resolve) => setTimeout(resolve, graceMs + 80));
    expect(await ended(runId)).toBe(false);
    expect(await notices(owner.client, owner.groupId)).toBe(0);
  } finally {
    second.close();
  }
});

it("宽限收尾后重复 hello 只留一条失败消息", async () => {
  const owner = await ownerWithBot();
  const first = await connect(owner.computer);
  const runId = await startRun(owner.client, owner.groupId, first);
  first.close();
  await first.closed();
  await waitFor(() => ended(runId), "首次收尾");
  const second = await connect(owner.computer);
  try {
    expect(await notices(owner.client, owner.groupId)).toBe(1);
  } finally {
    second.close();
  }
});
