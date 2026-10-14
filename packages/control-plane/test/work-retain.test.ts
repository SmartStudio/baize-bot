import {
  CreateBotResponse,
  CreateGroupResponse,
  EMPTY_WORK_HEAD,
  HubLaneSnapshot,
  RecallResponse,
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
import { PASSWORD, makeComputer, makeUser, waitFor, type TestComputer } from "./helpers/fixtures.js";

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

async function recallLane(who: Rig): Promise<Prompt> {
  const peer = CreateBotResponse.parse(await (await who.client.post("/api/bots", { name: "同事" })).json());
  await who.agent.expect("config");
  const { group } = CreateGroupResponse.parse(
    await (await who.client.post("/api/groups", { title: "召回入口", botIds: [who.botId, peer.bot.id] })).json(),
  );
  expect((await who.client.post(`/api/groups/${group.id}/messages`, { text: "@小录 查以前的记录" })).status).toBe(201);
  return who.agent.expect("prompt");
}

async function recall(who: Rig, prompt: Prompt, query: string) {
  const response = await fetch(`${who.client.origin}/hub/v1/recall`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${who.key}`,
      "x-baize-lane": `${who.botId}/${prompt.groupId}/${prompt.lane.epoch}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  expect(response.status).toBe(200);
  return RecallResponse.parse(await response.json());
}

async function snapshot(who: Rig, prompt: Prompt) {
  const response = await fetch(`${who.client.origin}/hub/v1/lanes/${who.botId}/${who.groupId}/chat`, {
    headers: {
      authorization: `Bearer ${who.key}`,
      "x-baize-lane": `${who.botId}/${who.groupId}/${prompt.lane.epoch}`,
    },
  });
  expect(response.status).toBe(200);
  return HubLaneSnapshot.parse(await response.json());
}

describe("服务器工作记录留存复查", () => {
  it("PATCH 返回时旧原文和检索文字立即消失，不等下一条上传，跨群 recall 也立即失效", async () => {
    const who = await rig();
    const tool = await connectTool(who, false);
    const prompt = await start(who);
    const body = await frame(who, [line("safe"), toolLine("private", "send_email", "safe")], { prompt });
    expect(await send(who.agent, body)).toBeNull();
    const reader = await recallLane(who);
    expect((await recall(who, reader, "本机业务原文"))[0]?.excerpt).toBe("本机业务原文");

    expect((await who.client.patch(`/api/tools/${tool.id}`, { localOnly: true })).status).toBe(200);
    const stored = await state(who);
    expect(stored.entries.map((row) => row.line)).toEqual([line("safe")]);
    expect(JSON.stringify(stored.entries)).not.toContain("本机业务原文");
    expect(stored.metadata?.next_seq).toBe(1);
    expect(await recall(who, reader, "本机业务原文")).toEqual([]);
  });

  it("读取侧按当前名单防住残留旧原文，recall 与分页 Hub 均只返回合规内容", async () => {
    const who = await rig();
    const tool = await connectTool(who, false);
    const prompt = await start(who);
    const original = [line("safe"), toolLine("private", "send_email", "safe")];
    const body = await frame(who, original, { prompt });
    expect(await send(who.agent, body)).toBeNull();
    const reader = await recallLane(who);
    expect(await recall(who, reader, "本机业务原文")).toHaveLength(1);
    expect((await snapshot(who, prompt)).entries.map((entry) => entry.line)).toEqual(original);
    await changed(who, tool.id, { localOnly: true });
    // 模拟旧版本或漏复查的历史残留，读取不能依赖写入侧已经修好。
    await database.sql`DELETE FROM work_entries WHERE bot_id = ${who.botId} AND group_id = ${who.groupId}`;
    for (const [seq, raw] of original.entries()) {
      const entry = JSON.parse(raw) as { id: string; parentId: string | null };
      await database.sql`
        INSERT INTO work_entries (bot_id, group_id, stream, seq, epoch, owner_id, run_id, entry_id, parent_id,
          pi_type, retention, line, search_text)
        VALUES (${who.botId}, ${who.groupId}, 'chat', ${seq}, 1, ${who.ownerId}, ${prompt.runId}, ${entry.id},
          ${entry.parentId}, 'message', 'verbatim', ${raw}, ${seq === 0 ? "文字safe" : "本机业务原文"})
      `;
    }
    await database.sql`UPDATE work_streams SET next_seq = 2, head = ${body.head}, tail_entry_id = 'private'
      WHERE bot_id = ${who.botId} AND group_id = ${who.groupId} AND stream = 'chat'`;
    expect(JSON.stringify((await state(who)).entries)).toContain("本机业务原文");
    expect(await recall(who, reader, "本机业务原文")).toEqual([]);
    const page = await snapshot(who, prompt);
    expect(page.entries.map((entry) => entry.line)).toEqual([original[0]]);
    expect(page.nextSeq).toBe(1);
    expect(page.head).toBe(await advanceWorkHead(EMPTY_WORK_HEAD, original.slice(0, 1)));
  });

  it("非检索元数据含 JSON 转义 NUL 的工作记录照常接收并可召回", async () => {
    const who = await rig();
    const prompt = await start(who);
    const raw = JSON.stringify({
      type: "message",
      id: "nul",
      parentId: null,
      timestamp: "2026-10-14T00:00:00.000Z",
      opaque: "before\u0000after",
      message: { role: "assistant", content: [{ type: "text", text: "NUL元数据预算" }] },
    });
    expect(await send(who.agent, await frame(who, [raw], { prompt }))).toBeNull();
    expect((await state(who)).entries[0]?.line).toBe(raw);
    const reader = await recallLane(who);
    expect(await recall(who, reader, "元数据预算")).toEqual([
      {
        groupId: who.groupId,
        groupTitle: "小录",
        at: "2026-10-14T00:00:00.000Z",
        kind: "assistant",
        excerpt: "NUL元数据预算",
      },
    ]);
  });

  it("新建本机连接在提交时复查已有的同名工具原文", async () => {
    const who = await rig();
    const prompt = await start(who);
    expect(await send(who.agent, await frame(who, [toolLine("old")], { prompt }))).toBeNull();
    expect(JSON.stringify((await state(who)).entries)).toContain("本机业务原文");
    const creating = who.client.post("/api/tools", { name: "新建本机", url: mcp.url, localOnly: true });
    const discovery = await who.agent.expect("mcp_discover");
    who.agent.send({
      type: "mcp_discovered",
      requestId: discovery.requestId,
      result: {
        ok: true,
        operations: [{ name: "send_email", description: "本机操作", inputSchema: {}, needsApproval: false }],
      },
    });
    expect((await creating).status).toBe(201);
    expect((await state(who)).entries).toEqual([]);
    expect((await state(who)).metadata?.next_seq).toBe(0);
  });

  it("recall 的名单和记录共用快照，等待读取期间的新名单与新原文不会混读", async () => {
    const who = await rig();
    const tool = await connectTool(who, false);
    const prompt = await start(who);
    expect(await send(who.agent, await frame(who, [toolLine("old")], { prompt }))).toBeNull();
    const reader = await recallLane(who);
    let locked!: () => void;
    let release!: () => void;
    let blockerPid = 0;
    const held = new Promise<void>((resolve) => (locked = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    const blocker = database.sql.begin(async (tx) => {
      const [backend] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      blockerPid = backend!.pid;
      await tx`LOCK TABLE work_entries IN ACCESS EXCLUSIVE MODE`;
      locked();
      await released;
      // 模拟另一个版本在同一事务中改名单并留下新原文；读事务必须保持开始时的快照。
      await tx`UPDATE tool_connections SET local_only = true WHERE id = ${tool.id}`;
      const raw = toolLine("new").replace("本机业务原文", "后来插入的本机业务原文");
      await tx`
        INSERT INTO work_entries (bot_id, group_id, stream, seq, epoch, owner_id, run_id, entry_id,
          pi_type, retention, line, search_text)
        VALUES (${who.botId}, ${who.groupId}, 'chat', 1, 1, ${who.ownerId}, ${prompt.runId}, 'new',
          'message', 'verbatim', ${raw}, '后来插入的本机业务原文')
      `;
    });
    let reading: Promise<Awaited<ReturnType<typeof recall>>> | undefined;
    try {
      await held;
      reading = recall(who, reader, "本机业务原文");
      await waitFor(async () => {
        const rows = await database.sql`
          SELECT pid FROM pg_stat_activity WHERE datname = ${database.databaseName}
            AND wait_event_type = 'Lock' AND query ILIKE '%work_entries%'
            AND ${blockerPid} = ANY(pg_blocking_pids(pid))
        `;
        return rows.length > 0;
      }, "recall 已读取旧名单，候选查询等待表锁");
      release();
      await blocker;
      expect((await reading).map((entry) => entry.excerpt)).toEqual(["本机业务原文"]);
      expect(await recall(who, reader, "本机业务原文")).toEqual([]);
    } finally {
      release();
      await Promise.allSettled([blocker, reading]);
    }
  });

  it("补授权发现新增本机操作后，同一 PATCH 返回前撤回它以前的原文", async () => {
    const who = await rig();
    const tool = await connectTool(who, true);
    const prompt = await start(who);
    const raw = toolLine("old", "new_private");
    expect(await send(who.agent, await frame(who, [raw], { prompt }))).toBeNull();
    expect(JSON.stringify((await state(who)).entries)).toContain("本机业务原文");
    const updating = who.client.patch(`/api/tools/${tool.id}`, { authorization: "Bearer refreshed-fixture" });
    const discovery = await who.agent.expect("mcp_discover");
    who.agent.send({
      type: "mcp_discovered",
      requestId: discovery.requestId,
      result: {
        ok: true,
        operations: [
          ...tool.operations,
          { name: "new_private", description: "新操作", inputSchema: {}, needsApproval: false },
        ],
      },
    });
    expect((await updating).status).toBe(200);
    expect((await state(who)).entries).toEqual([]);
    expect((await state(who)).metadata?.next_seq).toBe(0);
  });

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
      code: "seq_mismatch",
      nextSeq: 1,
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
        code: "seq_mismatch",
        nextSeq: 0,
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
    await database.sql`UPDATE work_streams SET retain_snapshot = NULL WHERE bot_id = ${who.botId} AND group_id = ${who.groupId}`;
    await changed(who, tool.id, { name: "连接新名" });
    expect((await state(who)).metadata?.retain_snapshot).toMatchObject({ localIds: ["local"] });
    expect((await who.client.delete(`/api/tools/${tool.id}`)).status).toBe(204);
    await who.agent.expect("config");
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
