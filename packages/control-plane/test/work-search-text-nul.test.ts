import {
  CreateBotResponse,
  CreateGroupResponse,
  EMPTY_WORK_HEAD,
  HubLaneSnapshot,
  RecallResponse,
  advanceWorkHead,
  type AgentToControl,
  type BotId,
  type ControlToAgent,
  type GroupId,
  type WorkAppend,
} from "@baize/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startServer, type RunningServer } from "../src/server.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { ApiClient, TEST_CREDENTIALS_KEY } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser } from "./helpers/fixtures.js";

let database: TestDb;
let server: RunningServer;
const agents: AgentClient[] = [];

beforeAll(async () => {
  database = await createTestDb();
  server = await startServer({
    db: database.db,
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
  await server.close();
  await database.close();
});

type Prompt = Extract<ControlToAgent, { type: "prompt" }>;
type Rig = {
  client: ApiClient;
  botId: BotId;
  sourceGroupId: GroupId;
  currentGroupId: GroupId;
  agent: AgentClient;
  key: string;
  prompt: Prompt;
  barriers: number;
};

async function rig(): Promise<Rig> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = new ApiClient(server.port);
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const own = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小录" })).json());
  const peer = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "同伴" })).json());
  const current = CreateGroupResponse.parse(
    await (await client.post("/api/groups", { title: "召回文件记录", botIds: [own.bot.id, peer.bot.id] })).json(),
  );
  const { agent, config } = await helloAgent(server.port, computer.computerId, computer.token);
  agents.push(agent);
  expect((await client.post(`/api/groups/${own.group.id}/messages`, { text: "读取文件并记录" })).status).toBe(201);
  const prompt = await agent.expect("prompt");
  expect(prompt.botId).toBe(own.bot.id);
  return {
    client,
    botId: own.bot.id,
    sourceGroupId: own.group.id,
    currentGroupId: current.group.id,
    agent,
    key: config.modelGateway.apiKey,
    prompt,
    barriers: 0,
  };
}

function toolEntry(id: string, parentId: string | null, text: string) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-10-14T00:00:00.000Z",
    message: {
      role: "toolResult",
      toolCallId: `call-${id}`,
      toolName: "read",
      content: [{ type: "text", text }],
      isError: false,
      timestamp: 1,
    },
  };
}

async function append(who: Rig, lines: string[], fromSeq = 0, previousHead = EMPTY_WORK_HEAD) {
  const body: WorkAppend = {
    type: "work_append",
    lane: { botId: who.botId, groupId: who.sourceGroupId, stream: "chat", epoch: who.prompt.lane.epoch },
    runId: who.prompt.runId,
    fromSeq,
    lines,
    head: await advanceWorkHead(previousHead, lines),
    cause: "turn_end",
  };
  const seq = who.agent.sendMalformedReliable(body);
  const barrier: Extract<AgentToControl, { type: "run_done" }> = {
    type: "run_done",
    runId: who.prompt.runId,
    botId: who.botId,
    groupId: who.sourceGroupId,
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
  who.agent.send(barrier);
  await who.agent.ack(who.prompt.runId, ++who.barriers);
  expect(who.agent.ackCount(who.prompt.runId)).toBe(who.barriers);
  const ack = who.agent.uplinkAcks().find((entry) => entry.upTo >= seq);
  expect(ack).toBeDefined();
  return { body, rejected: ack!.rejected.find((entry) => entry.seq === seq) };
}

async function entries(who: Rig) {
  return database.sql<{ seq: number; line: string; search_text: string }[]>`
    SELECT seq, line, search_text FROM work_entries
    WHERE bot_id = ${who.botId} AND group_id = ${who.sourceGroupId} AND stream = 'chat' ORDER BY seq
  `;
}

describe("工作记录检索文字中的 NUL", () => {
  it("含真 NUL 的工具结果确认成功、原行字节不变、后续帧可追加并从两侧与跨 NUL 召回", async () => {
    const who = await rig();
    const raw = `  ${JSON.stringify(toolEntry("binary", null, "读取文件：左侧词\u0000右侧词"))}  `;
    const first = await append(who, [raw]);
    expect(first.rejected).toBeUndefined();
    const [stored] = await entries(who);
    expect(stored).toEqual({ seq: 0, line: raw, search_text: "读取文件：左侧词右侧词" });
    expect(Buffer.from(stored!.line, "utf8")).toEqual(Buffer.from(raw, "utf8"));
    expect(JSON.parse(stored!.line).message.content[0].text).toBe("读取文件：左侧词\u0000右侧词");

    const nextRaw = JSON.stringify(toolEntry("next", "binary", "下一帧正常文字"));
    const next = await append(who, [nextRaw], 1, first.body.head);
    expect(next.rejected).toBeUndefined();
    expect([...(await entries(who))]).toEqual([
      { seq: 0, line: raw, search_text: "读取文件：左侧词右侧词" },
      { seq: 1, line: nextRaw, search_text: "下一帧正常文字" },
    ]);

    const snapshotResponse = await fetch(`${who.client.origin}/hub/v1/lanes/${who.botId}/${who.sourceGroupId}/chat`, {
      headers: {
        authorization: `Bearer ${who.key}`,
        "x-baize-lane": `${who.botId}/${who.sourceGroupId}/${who.prompt.lane.epoch}`,
      },
    });
    expect(snapshotResponse.status).toBe(200);
    expect(HubLaneSnapshot.parse(await snapshotResponse.json())).toEqual({
      entries: [
        { seq: 0, line: raw },
        { seq: 1, line: nextRaw },
      ],
      nextSeq: 2,
      head: next.body.head,
      piSessionVersion: 3,
    });

    expect(
      (await who.client.post(`/api/groups/${who.currentGroupId}/messages`, { text: "@小录 召回以前的文件记录" }))
        .status,
    ).toBe(201);
    const current = await who.agent.expect("prompt");
    expect(current.botId).toBe(who.botId);
    for (const query of ["左侧词", "右侧词", "左侧词右侧词"]) {
      const response = await fetch(`${who.client.origin}/hub/v1/recall`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${who.key}`,
          "x-baize-lane": `${who.botId}/${who.currentGroupId}/${current.lane.epoch}`,
        },
        body: JSON.stringify({ query }),
      });
      expect(response.status).toBe(200);
      expect(RecallResponse.parse(await response.json())).toEqual([
        {
          groupId: who.sourceGroupId,
          groupTitle: "小录",
          at: "2026-10-14T00:00:00.000Z",
          kind: "toolResult",
          excerpt: "读取文件：左侧词右侧词",
        },
      ]);
    }
  });

  it.each(["type", "id", "parentId"])(
    "含真 NUL 的 %s 帧无数据库重试地回 invalid，下一条合法帧仍从原序号追加",
    async (field) => {
      const who = await rig();
      const raw = JSON.stringify({ ...toolEntry("bad", null, "合法文本"), [field]: "前\u0000后" });
      const errors = vi.spyOn(console, "error");
      try {
        const bad = await append(who, [raw]);
        expect(bad.rejected?.code).toBe("invalid");
        expect(errors).not.toHaveBeenCalled();
      } finally {
        errors.mockRestore();
      }
      expect([...(await entries(who))]).toEqual([]);
      const validRaw = JSON.stringify(toolEntry("valid", null, "恢复追加"));
      const valid = await append(who, [validRaw]);
      expect(valid.rejected).toBeUndefined();
      expect([...(await entries(who))]).toEqual([{ seq: 0, line: validRaw, search_text: "恢复追加" }]);
    },
  );
});
