import {
  CreateBotResponse,
  EMPTY_WORK_HEAD,
  HubLaneSnapshot,
  ToolResponse,
  UplinkAck,
  advanceWorkHead,
  type BotId,
  type ControlToAgent,
  type GroupId,
  type UserId,
  type WorkAppend,
  type WorkStream,
} from "@baize/shared";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/server.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { ApiClient, TEST_CREDENTIALS_KEY } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser } from "./helpers/fixtures.js";
import { gatedDb } from "./helpers/gated-db.js";
import { startTestMcp, type TestMcp } from "./helpers/mcp.js";

/** Hub 分页读本页的那条：元数据已经读完，本页还没读。drizzle 把列名带引号发出，重放前缀复查的那条多一列 entry_id，不会误中。 */
const LANE_PAGE_QUERY = /^select "seq", "line" from "work_entries"/;

let database: TestDb;
let gate: ReturnType<typeof gatedDb>;
let server: RunningServer;
let mcp: TestMcp;
const agents: AgentClient[] = [];

beforeAll(async () => {
  database = await createTestDb();
  gate = gatedDb(database.sql);
  mcp = await startTestMcp();
  server = await startServer({
    db: gate.db,
    port: 0,
    credentialsKey: TEST_CREDENTIALS_KEY,
    toolSecretKey: "a".repeat(64),
    disconnectGraceMs: 60_000,
    silenceTimeoutMs: 60_000,
    leaseRenewalIntervalMs: 60_000,
    scheduler: { intervalMs: 86_400_000 },
    publisher: { intervalMs: 86_400_000 },
    poker: { intervalMs: 86_400_000 },
  });
});

afterEach(async () => {
  for (const agent of agents) agent.close();
  await Promise.all(agents.map((agent) => agent.closed()));
  agents.length = 0;
});

afterAll(async () => {
  await mcp.close();
  await server.close();
  await database.close();
});

type Prompt = Extract<ControlToAgent, { type: "prompt" }>;
type Rig = {
  ownerId: UserId;
  client: ApiClient;
  botId: BotId;
  groupId: GroupId;
  agent: AgentClient;
  key: string;
};

async function rig(): Promise<Rig> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = new ApiClient(server.port);
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小录" })).json());
  const { agent, config } = await helloAgent(server.port, computer.computerId, computer.token, [], {
    piSessionVersion: 3,
  });
  agents.push(agent);
  return {
    ownerId: user.id,
    client,
    botId: created.bot.id,
    groupId: created.group.id,
    agent,
    key: config.modelGateway.apiKey,
  };
}

async function start(who: Rig): Promise<Prompt> {
  expect((await who.client.post(`/api/groups/${who.groupId}/messages`, { text: "记录这次活" })).status).toBe(201);
  return who.agent.expect("prompt");
}

function line(id: string, parentId: string | null = null): string {
  return JSON.stringify({
    type: "message",
    id,
    parentId,
    message: { role: "assistant", content: [{ type: "text", text: `文字${id}` }] },
  });
}

function toolLine(id: string, parentId: string | null = null): string {
  return JSON.stringify({
    type: "message",
    id,
    parentId,
    timestamp: "2026-10-14T00:00:00.000Z",
    message: {
      role: "toolResult",
      toolCallId: "call",
      toolName: "send_email",
      content: [{ type: "text", text: "本机业务原文" }],
      isError: false,
      timestamp: 1,
    },
  });
}

async function frame(
  who: Rig,
  lines: string[],
  options: { prompt?: Prompt; epoch?: number; stream?: WorkStream } = {},
): Promise<WorkAppend> {
  return {
    type: "work_append",
    lane: {
      botId: who.botId,
      groupId: who.groupId,
      stream: options.stream ?? "chat",
      epoch: options.epoch ?? options.prompt?.lane.epoch ?? 1,
    },
    runId: options.prompt?.runId ?? null,
    fromSeq: 0,
    lines,
    head: await advanceWorkHead(EMPTY_WORK_HEAD, lines),
    cause: options.prompt === undefined ? "import" : "turn_end",
  };
}

async function append(agent: AgentClient, body: WorkAppend): Promise<void> {
  const seq = agent.sendMalformedReliable(body);
  const ack = await new Promise<UplinkAck>((resolve, reject) => {
    const received = agent.uplinkAcks().find((entry) => entry.upTo >= seq);
    if (received !== undefined) return resolve(received);
    const onMessage = (raw: import("ws").RawData) => {
      const value: unknown = JSON.parse(raw.toString());
      if (typeof value !== "object" || value === null || !("type" in value) || value.type !== "uplink_ack") return;
      const parsed = UplinkAck.parse(value);
      if (parsed.upTo < seq) return;
      clearTimeout(timer);
      agent.socket.off("message", onMessage);
      resolve(parsed);
    };
    const timer = setTimeout(() => {
      agent.socket.off("message", onMessage);
      reject(new Error(`等工作记录上行 ${seq} 确认超时`));
    }, 5000);
    agent.socket.on("message", onMessage);
  });
  expect(ack.rejected.filter((entry) => entry.seq === seq)).toEqual([]);
}

async function connectTool(who: Rig) {
  const response = await who.client.post("/api/tools", { name: "留存连接", url: mcp.url });
  expect(response.status).toBe(201);
  const tool = ToolResponse.parse(await response.json()).tool;
  await who.agent.expect("config");
  return tool;
}

async function makeLocalOnly(who: Rig, toolId: string) {
  expect((await who.client.patch(`/api/tools/${toolId}`, { localOnly: true })).status).toBe(200);
  await who.agent.expect("config");
}

async function readLane(who: Rig, epoch: number, stream: WorkStream = "chat"): Promise<string> {
  const response = await fetch(`${who.client.origin}/hub/v1/lanes/${who.botId}/${who.groupId}/${stream}`, {
    headers: { authorization: `Bearer ${who.key}`, "x-baize-lane": `${who.botId}/${who.groupId}/${epoch}` },
  });
  expect(response.status).toBe(200);
  return response.text();
}

async function stored(who: Rig, stream: WorkStream) {
  const [metadata] = await database.sql<{ next_seq: number; head: string }[]>`
    SELECT next_seq, head FROM work_streams
    WHERE bot_id = ${who.botId} AND group_id = ${who.groupId} AND stream = ${stream}`;
  const entries = await database.sql<{ line: string }[]>`
    SELECT line FROM work_entries
    WHERE bot_id = ${who.botId} AND group_id = ${who.groupId} AND stream = ${stream} ORDER BY seq`;
  return { nextSeq: metadata?.next_seq, head: metadata?.head, lines: entries.map((entry) => entry.line) };
}

describe("Hub 分页读取的快照", () => {
  it.each([
    ["快路径：快照指纹等于当前名单", false],
    ["慢路径：没有留存快照，从头复查", true],
  ])("%s，夹在元数据和本页之间的截断提交不会让 entries 与 nextSeq、head 错位", async (_name, withoutSnapshot) => {
    const who = await rig();
    const tool = await connectTool(who);
    const prompt = await start(who);
    const original = [line("safe"), toolLine("private", "safe")];
    const body = await frame(who, original, { prompt });
    await append(who.agent, body);
    if (withoutSnapshot)
      await database.sql`UPDATE work_streams SET retain_snapshot = NULL
        WHERE bot_id = ${who.botId} AND group_id = ${who.groupId} AND stream = 'chat'`;

    const before = await readLane(who, prompt.lane.epoch);
    expect(HubLaneSnapshot.parse(JSON.parse(before))).toMatchObject({
      entries: [
        { seq: 0, line: original[0] },
        { seq: 1, line: original[1] },
      ],
      nextSeq: 2,
      head: body.head,
    });

    const held = gate.arm(LANE_PAGE_QUERY);
    const reading = readLane(who, prompt.lane.epoch);
    try {
      await held.reached;
      await makeLocalOnly(who, tool.id);
      expect((await stored(who, "chat")).lines).toEqual([original[0]]);
    } finally {
      held.release();
    }
    expect(await reading).toBe(before);

    const prefixHead = await advanceWorkHead(EMPTY_WORK_HEAD, original.slice(0, 1));
    expect(HubLaneSnapshot.parse(JSON.parse(await readLane(who, prompt.lane.epoch)))).toMatchObject({
      entries: [{ seq: 0, line: original[0] }],
      nextSeq: 1,
      head: prefixHead,
    });
  });
});

describe("Hub 快路径的提交上界", () => {
  it("seq 不小于 nextSeq 的尾行不会进本页，nextSeq 和 head 保持提交时的值", async () => {
    const who = await rig();
    await connectTool(who);
    const prompt = await start(who);
    const committed = [line("safe")];
    const body = await frame(who, committed, { prompt });
    await append(who.agent, body);
    await database.sql`INSERT INTO work_entries
      (bot_id, group_id, stream, seq, epoch, owner_id, run_id, entry_id, parent_id, pi_type, retention, line, search_text)
      SELECT bot_id, group_id, stream, 1, epoch, owner_id, run_id, 'beyond-cursor', parent_id, pi_type, retention,
        ${line("beyond-cursor")}, search_text
      FROM work_entries
      WHERE bot_id = ${who.botId} AND group_id = ${who.groupId} AND stream = 'chat' AND seq = 0`;
    expect((await stored(who, "chat")).lines).toHaveLength(2);

    const page = await readLane(who, prompt.lane.epoch);
    expect(page).not.toContain("beyond-cursor");
    expect(HubLaneSnapshot.parse(JSON.parse(page))).toMatchObject({
      entries: [{ seq: 0, line: committed[0] }],
      nextSeq: 1,
      head: body.head,
    });
  });
});

describe("名单变更的即时截断覆盖全部流", () => {
  it("牌桌的 table 流和同一户的 chat 流在 PATCH 返回时一起被截，不等下一次追加", async () => {
    const who = await rig();
    const tool = await connectTool(who);
    const prompt = await start(who);
    await database.sql`INSERT INTO poker_tables
      (group_id, owner_id, request_id, seats, button_seat, small_blind, big_blind, starting_stack)
      VALUES (${who.groupId}, ${who.ownerId}, ${randomUUID()}, '[]', 1, 1, 2, 100)`;
    const chat = [line("chat-safe"), toolLine("chat-private", "chat-safe")];
    const table = [line("table-safe"), toolLine("table-private", "table-safe")];
    await append(who.agent, await frame(who, chat, { prompt }));
    await append(who.agent, await frame(who, table, { stream: "table", epoch: prompt.lane.epoch }));
    for (const [stream, lines] of [
      ["chat", chat],
      ["table", table],
    ] as const) {
      expect((await stored(who, stream)).lines).toEqual(lines);
      expect(HubLaneSnapshot.parse(JSON.parse(await readLane(who, prompt.lane.epoch, stream))).nextSeq).toBe(2);
    }

    expect((await who.client.patch(`/api/tools/${tool.id}`, { localOnly: true })).status).toBe(200);

    for (const [stream, lines] of [
      ["chat", chat],
      ["table", table],
    ] as const) {
      const prefixHead = await advanceWorkHead(EMPTY_WORK_HEAD, lines.slice(0, 1));
      expect(await stored(who, stream), `PATCH 一返回，${stream} 流库里的行`).toEqual({
        nextSeq: 1,
        head: prefixHead,
        lines: lines.slice(0, 1),
      });
    }
    await who.agent.expect("config");

    for (const [stream, lines] of [
      ["chat", chat],
      ["table", table],
    ] as const) {
      const prefixHead = await advanceWorkHead(EMPTY_WORK_HEAD, lines.slice(0, 1));
      const page = await readLane(who, prompt.lane.epoch, stream);
      expect(page).not.toContain("本机业务原文");
      expect(HubLaneSnapshot.parse(JSON.parse(page)), `${stream} 流 Hub 读到的页`).toMatchObject({
        entries: [{ seq: 0, line: lines[0] }],
        nextSeq: 1,
        head: prefixHead,
      });
    }
  });
});
