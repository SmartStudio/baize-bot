import {
  CreateBotResponse,
  EMPTY_WORK_HEAD,
  UplinkAck,
  ToolResponse,
  advanceWorkHead,
  type BotId,
  type ControlToAgent,
  type GroupId,
  type UserId,
  type WorkAppend,
  type WorkStream,
} from "@baize/shared";
import { createRetainer, emptySnapshot, type RetainContext } from "@baize/shared/work-record";
import { startTestMcp, type TestMcp } from "./helpers/mcp.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/server.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { ApiClient, TEST_CREDENTIALS_KEY } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, type TestComputer } from "./helpers/fixtures.js";

let database: TestDb;
let server: RunningServer;
let mcp: TestMcp;
const agents: AgentClient[] = [];

beforeAll(async () => {
  database = await createTestDb();
  mcp = await startTestMcp();
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
  await mcp.close();
  await server.close();
  await database.close();
});

type Prompt = Extract<ControlToAgent, { type: "prompt" }>;
type Rig = {
  ownerId: UserId;
  client: ApiClient;
  computer: TestComputer;
  botId: BotId;
  groupId: GroupId;
  agent: AgentClient;
  key: string;
};

async function rig(piSessionVersion = 3): Promise<Rig> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = new ApiClient(server.port);
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小录" })).json());
  const { agent, config } = await helloAgent(server.port, computer.computerId, computer.token, [], {
    piSessionVersion,
  });
  agents.push(agent);
  return {
    ownerId: user.id,
    client,
    computer,
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
    message: {
      role: "assistant",
      content: [
        { type: "text", text: `文字${id}` },
        { type: "thinking", thinking: "不索引" },
      ],
    },
  });
}

async function frame(
  who: Rig,
  lines: string[],
  options: { prompt?: Prompt; fromSeq?: number; previousHead?: string; stream?: WorkStream; epoch?: number } = {},
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
    fromSeq: options.fromSeq ?? 0,
    lines,
    head: await advanceWorkHead(options.previousHead ?? EMPTY_WORK_HEAD, lines),
    cause: options.prompt === undefined ? "import" : "turn_end",
  };
}

async function send(
  agent: AgentClient,
  body: unknown,
): Promise<Omit<UplinkAck["rejected"][number], "seq" | "lane" | "runId"> | null> {
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
  const rejected = ack.rejected.find((entry) => entry.seq === seq);
  if (rejected === undefined) return null;
  const { seq: _seq, lane: _lane, runId: _runId, ...result } = rejected;
  return result;
}

async function state(who: Rig, stream: WorkStream = "chat") {
  const [metadata] = await database.sql<
    { next_seq: number; head: string; tail_entry_id: string; pi_session_version: number; retain_snapshot: unknown }[]
  >`
    SELECT next_seq, head, tail_entry_id, pi_session_version, retain_snapshot FROM work_streams
    WHERE bot_id = ${who.botId} AND group_id = ${who.groupId} AND stream = ${stream}
  `;
  const entries = await database.sql<
    {
      seq: number;
      epoch: number;
      owner_id: string;
      run_id: string | null;
      entry_id: string;
      parent_id: string | null;
      pi_type: string;
      retention: string;
      line: string;
      search_text: string;
      visible_to: unknown;
    }[]
  >`
    SELECT seq, epoch, owner_id, run_id, entry_id, parent_id, pi_type, retention, line, search_text, visible_to
    FROM work_entries WHERE bot_id = ${who.botId} AND group_id = ${who.groupId} AND stream = ${stream} ORDER BY seq
  `;
  return { metadata, entries: [...entries] };
}

async function lease(who: Rig) {
  const [row] = await database.sql<
    { holder_computer_id: string; holder_install_id: string; epoch: number; updated_at: string }[]
  >`
    SELECT holder_computer_id, holder_install_id, epoch, updated_at FROM lane_leases WHERE bot_id = ${who.botId} AND group_id = ${who.groupId}
  `;
  return row;
}

const localCtx: RetainContext = { localOnlyToolNames: new Set(["send_email", "lookup_stock"]) };
const emptyCtx: RetainContext = { localOnlyToolNames: new Set() };

function toolLine(id: string, toolName = "send_email", parentId: string | null = null): string {
  return JSON.stringify({
    type: "message",
    id,
    parentId,
    timestamp: "2026-10-14T00:00:00.000Z",
    message: {
      role: "toolResult",
      toolCallId: "call",
      toolName,
      content: [{ type: "text", text: "本机业务原文" }],
      isError: false,
      timestamp: 1,
    },
  });
}

function filtered(lines: string[], ctx = localCtx): string[] {
  const retainer = createRetainer(ctx);
  return lines.map((raw) => {
    const result = retainer.retain(raw);
    if (result.status !== "retained") throw new Error(`测试行被过滤器拒收：${result.reason}`);
    return result.line;
  });
}

async function connectTool(who: Rig, localOnly: boolean) {
  const response = await who.client.post("/api/tools", { name: "留存连接", url: mcp.url });
  expect(response.status).toBe(201);
  const tool = ToolResponse.parse(await response.json()).tool;
  await who.agent.expect("config");
  if (localOnly) {
    expect((await who.client.patch(`/api/tools/${tool.id}`, { localOnly: true })).status).toBe(200);
    await who.agent.expect("config");
  }
  return tool;
}

async function changed(who: Rig, toolId: string, patch: unknown) {
  expect((await who.client.patch(`/api/tools/${toolId}`, patch)).status).toBe(200);
  await who.agent.expect("config");
}

describe("服务器工作记录留存复查", () => {
  it.each([
    [
      "图片块",
      JSON.stringify({
        type: "message",
        id: "bad",
        parentId: null,
        message: { role: "assistant", content: [{ type: "image", data: "原图", mimeType: "image/png" }] },
      }),
    ],
    [
      "超长文字",
      JSON.stringify({
        type: "message",
        id: "bad",
        parentId: null,
        message: { role: "assistant", content: [{ type: "text", text: "文".repeat(6000) }] },
      }),
    ],
    ["本机工具原文", toolLine("bad")],
  ])("%s 整帧拒收，伪造名单无效且不认领导入道", async (_name, bad) => {
    const who = await rig();
    await connectTool(who, true);
    const body = await frame(who, [line("good"), bad]);
    expect(await send(who.agent, { ...body, localOnlyToolNames: [], toolFingerprint: "伪造名单" })).toEqual({
      code: "invalid",
      reason: "unfiltered",
      lineIndex: 1,
    });
    expect(await state(who)).toEqual({ metadata: undefined, entries: [] });
    expect(await lease(who)).toBeUndefined();
  });

  it("过滤过的图片、长文和本机结果照收，快照与原样条目同事务保存", async () => {
    const who = await rig();
    await connectTool(who, true);
    const raws = [
      JSON.stringify({
        type: "message",
        id: "image",
        parentId: null,
        message: { role: "assistant", content: [{ type: "image", data: "原图", mimeType: "image/png" }] },
      }),
      JSON.stringify({
        type: "message",
        id: "long",
        parentId: "image",
        message: { role: "assistant", content: [{ type: "text", text: "文".repeat(6000) }] },
      }),
      toolLine("local", "send_email", "long"),
    ];
    const lines = filtered(raws);
    const body = await frame(who, lines);
    expect(await send(who.agent, { ...body, localOnlyToolNames: ["其他假工具"] })).toBeNull();
    const stored = await state(who);
    expect(stored.entries.map((entry) => entry.line)).toEqual(lines);
    expect(stored.metadata).toMatchObject({
      next_seq: 3,
      head: body.head,
      tail_entry_id: "local",
      retain_snapshot: { ...emptySnapshot(localCtx), knownIds: ["image", "long", "local"], localIds: ["local"] },
    });
    expect(stored.entries.every((entry) => entry.retention === "verbatim")).toBe(true);
  });

  it("快照跨帧记住本机结果，原文上下文编辑和重复 id 被字面量拒收", async () => {
    const who = await rig();
    await connectTool(who, true);
    const first = await frame(who, filtered([toolLine("local")]));
    expect(await send(who.agent, first)).toBeNull();
    const before = await state(who);
    const edit = JSON.stringify({
      type: "context_edit",
      id: "edit",
      parentId: "local",
      targetId: "local",
      replacement: { content: "编辑里的原文" },
    });
    expect(await send(who.agent, await frame(who, [edit], { fromSeq: 1, previousHead: first.head }))).toEqual({
      code: "invalid",
      reason: "unfiltered",
      lineIndex: 0,
    });
    expect(await send(who.agent, await frame(who, first.lines, { fromSeq: 1, previousHead: first.head }))).toEqual({
      code: "invalid",
      reason: "duplicate_id",
      lineIndex: 0,
    });
    expect(await state(who)).toEqual(before);
  });

  it("已知条目畸形时带 malformed_entry 和帧内行号拒收，不写合规前缀", async () => {
    const who = await rig();
    const prompt = await start(who);
    const malformed = JSON.stringify({ type: "message", id: "bad", parentId: "good", message: null });
    expect(await send(who.agent, await frame(who, [line("good"), malformed], { prompt }))).toEqual({
      code: "invalid",
      reason: "malformed_entry",
      lineIndex: 1,
    });
    expect(await state(who)).toEqual({ metadata: undefined, entries: [] });
  });

  it("改成本机连接后按新名单截旧原文，重算前缀链头并从截断点重传", async () => {
    const who = await rig();
    const tool = await connectTool(who, false);
    const prompt = await start(who);
    const original = [line("safe"), toolLine("raw", "send_email", "safe"), line("tail", "raw")];
    const first = await frame(who, original, { prompt });
    expect(await send(who.agent, first)).toBeNull();
    await changed(who, tool.id, { localOnly: true });
    const rejected = await frame(who, [line("new", "tail")], { prompt, fromSeq: 3, previousHead: first.head });
    const prefixHead = await advanceWorkHead(EMPTY_WORK_HEAD, original.slice(0, 1));
    expect(await send(who.agent, rejected)).toEqual({
      code: "invalid",
      reason: "tool_list_changed",
      replayReason: "unfiltered",
      lineIndex: 1,
      nextSeq: 1,
      head: prefixHead,
    });
    const stored = await state(who);
    expect(stored.entries.map((entry) => entry.line)).toEqual(original.slice(0, 1));
    expect(stored.metadata).toMatchObject({
      next_seq: 1,
      head: prefixHead,
      tail_entry_id: "safe",
      retain_snapshot: { ...emptySnapshot(localCtx), knownIds: ["safe"] },
    });
    expect(await send(who.agent, rejected)).toEqual({ code: "seq_mismatch", nextSeq: 1 });
    const retainer = createRetainer(localCtx);
    expect(retainer.retain(original[0]!)).toMatchObject({ status: "retained" });
    const replacement = original.slice(1).map((raw) => {
      const result = retainer.retain(raw);
      if (result.status !== "retained") throw new Error("重传过滤失败");
      return result.line;
    });
    const retransmit = await frame(who, replacement, { prompt, fromSeq: 1, previousHead: prefixHead });
    expect(await send(who.agent, retransmit)).toBeNull();
    expect((await state(who)).metadata).toMatchObject({ next_seq: 3, head: retransmit.head, tail_entry_id: "tail" });
  });

  it("两帧同时遇到名单变化，只截一次，后一帧看到真实截断序号", async () => {
    const who = await rig();
    const tool = await connectTool(who, false);
    const prompt = await start(who);
    const first = await frame(who, [toolLine("raw"), line("tail")], { prompt });
    expect(await send(who.agent, first)).toBeNull();
    await changed(who, tool.id, { localOnly: true });
    const next = await frame(who, [line("new")], { prompt, fromSeq: 2, previousHead: first.head });
    expect(await Promise.all([send(who.agent, next), send(who.agent, next)])).toEqual([
      {
        code: "invalid",
        reason: "tool_list_changed",
        replayReason: "unfiltered",
        lineIndex: 0,
        nextSeq: 0,
        head: EMPTY_WORK_HEAD,
      },
      { code: "seq_mismatch", nextSeq: 0 },
    ]);
    expect((await state(who)).metadata).toMatchObject({
      next_seq: 0,
      head: EMPTY_WORK_HEAD,
      tail_entry_id: null,
      retain_snapshot: emptySnapshot(localCtx),
    });
    expect((await state(who)).entries).toEqual([]);
  });

  it("改名、删连接即使操作名集合不变也触发重放，跨用户连接不触发", async () => {
    const who = await rig();
    const tool = await connectTool(who, true);
    const prompt = await start(who);
    const first = await frame(who, filtered([toolLine("local")]), { prompt });
    expect(await send(who.agent, first)).toBeNull();
    const next = await frame(who, [line("next")], { prompt, fromSeq: 1, previousHead: first.head });
    const other = await rig();
    const otherTool = await connectTool(other, false);
    await changed(other, otherTool.id, { name: "其他人的新名" });
    expect((await state(who)).metadata?.retain_snapshot).toEqual({
      ...emptySnapshot(localCtx),
      knownIds: ["local"],
      localIds: ["local"],
    });
    await changed(who, tool.id, { name: "连接新名" });
    expect(await send(who.agent, next)).toEqual({
      code: "invalid",
      reason: "tool_list_changed",
      nextSeq: 1,
      head: first.head,
    });
    expect((await state(who)).metadata?.retain_snapshot).toMatchObject({ localIds: ["local"] });
    expect((await who.client.delete(`/api/tools/${tool.id}`)).status).toBe(204);
    await who.agent.expect("config");
    expect(await send(who.agent, next)).toEqual({
      code: "invalid",
      reason: "tool_list_changed",
      nextSeq: 1,
      head: first.head,
    });
    expect((await state(who)).metadata?.retain_snapshot).toMatchObject({
      ...emptySnapshot(emptyCtx),
      knownIds: ["local"],
      localIds: [],
    });
    expect(await send(who.agent, next)).toBeNull();
  });

  it("旧流没有快照时从头重放，保留历史 id 并挡住重复定义", async () => {
    const who = await rig();
    const prompt = await start(who);
    const first = await frame(who, [line("old")], { prompt });
    expect(await send(who.agent, first)).toBeNull();
    await database.sql`UPDATE work_streams SET retain_snapshot = NULL WHERE bot_id = ${who.botId} AND group_id = ${who.groupId}`;
    expect(
      await send(who.agent, await frame(who, [line("old")], { prompt, fromSeq: 1, previousHead: first.head })),
    ).toEqual({ code: "invalid", reason: "duplicate_id", lineIndex: 0 });
    expect((await state(who)).metadata?.retain_snapshot).toMatchObject({
      ...emptySnapshot(emptyCtx),
      knownIds: ["old"],
    });
    expect((await state(who)).entries).toHaveLength(1);
  });
});
