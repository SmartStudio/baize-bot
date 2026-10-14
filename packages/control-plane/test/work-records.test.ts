import { randomUUID } from "node:crypto";
import {
  ComputerTokenResponse,
  CreateBotResponse,
  EMPTY_WORK_HEAD,
  HubLaneSnapshot,
  RunId,
  UplinkAck,
  advanceWorkHead,
  type BotId,
  type ControlToAgent,
  type GroupId,
  type UserId,
  type WorkAppend,
  type WorkStream,
} from "@baize/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/server.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { ApiClient, TEST_CREDENTIALS_KEY } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, type TestComputer } from "./helpers/fixtures.js";

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

async function send(agent: AgentClient, body: unknown): Promise<{ code: string; nextSeq?: number } | null> {
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
  return rejected === undefined
    ? null
    : { code: rejected.code, ...(rejected.nextSeq === undefined ? {} : { nextSeq: rejected.nextSeq }) };
}

async function state(who: Rig, stream: WorkStream = "chat") {
  const [metadata] = await database.sql<
    { next_seq: number; head: string; tail_entry_id: string; pi_session_version: number }[]
  >`
    SELECT next_seq, head, tail_entry_id, pi_session_version FROM work_streams
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

function hub(
  who: Rig,
  options: { header?: string | null; path?: string; cookie?: boolean; key?: string | null; query?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.key !== null) headers.authorization = `Bearer ${options.key ?? who.key}`;
  if (options.header !== null) headers["x-baize-lane"] = options.header ?? `${who.botId}/${who.groupId}/1`;
  if (options.cookie && who.client.cookie !== null) headers.cookie = who.client.cookie;
  return fetch(
    `http://localhost:${server.port}/hub/v1/lanes/${options.path ?? `${who.botId}/${who.groupId}/chat`}${options.query ?? ""}`,
    { headers },
  );
}

describe("可靠上行工作记录", () => {
  it("按原样行落盘、派生条目字段与搜索文本，序号从0开始并盖连接Pi版本", async () => {
    const who = await rig(7);
    const prompt = await start(who);
    const lines = [`  ${line("a")}  `, line("b", "a")];
    const body = await frame(who, lines, { prompt });
    expect(await send(who.agent, body)).toBeNull();
    const stored = await state(who);
    expect(stored.metadata).toEqual({ next_seq: 2, head: body.head, tail_entry_id: "b", pi_session_version: 7 });
    expect(stored.entries).toEqual(
      lines.map((raw, seq) => ({
        seq,
        epoch: 1,
        owner_id: who.ownerId,
        run_id: prompt.runId,
        entry_id: seq === 0 ? "a" : "b",
        parent_id: seq === 0 ? null : "a",
        pi_type: "message",
        retention: "verbatim",
        line: raw,
        search_text: seq === 0 ? "文字a" : "文字b",
        visible_to: null,
      })),
    );
  });

  it("重复与缺号都带真实nextSeq拒收，条目和链头不变", async () => {
    const who = await rig();
    const prompt = await start(who);
    const body = await frame(who, [line("a")], { prompt });
    expect(await send(who.agent, body)).toBeNull();
    const before = await state(who);
    expect(await send(who.agent, body)).toEqual({ code: "seq_mismatch", nextSeq: 1 });
    expect(await send(who.agent, { ...body, fromSeq: 8 })).toEqual({ code: "seq_mismatch", nextSeq: 1 });
    expect(await state(who)).toEqual(before);
  });

  it("两个同时追加相同起始序号的帧只有一条生效", async () => {
    const who = await rig();
    const prompt = await start(who);
    const body = await frame(who, [line("a")], { prompt });
    const results = await Promise.all([send(who.agent, body), send(who.agent, body)]);
    expect(results).toEqual([null, { code: "seq_mismatch", nextSeq: 1 }]);
    expect((await state(who)).entries).toHaveLength(1);
  });

  it("旧代际优先于run校验，非持有者与错头都不增加记录", async () => {
    const who = await rig();
    const prompt = await start(who);
    const body = await frame(who, [line("a")], { prompt });
    const remote = ComputerTokenResponse.parse(await (await who.client.post("/api/computers/remote")).json());
    const { agent } = await helloAgent(server.port, remote.computerId, remote.token);
    agents.push(agent);
    expect(await send(who.agent, { ...body, lane: { ...body.lane, epoch: 2 }, runId: randomUUID() })).toEqual({
      code: "stale_epoch",
    });
    expect(await send(agent, body)).toEqual({ code: "not_holder" });
    expect(await send(who.agent, { ...body, head: "a".repeat(64) })).toEqual({ code: "head_mismatch" });
    expect(await state(who)).toEqual({ metadata: undefined, entries: [] });
  });

  it("安装标识不符拒收，work_append不附加HTTP时钟条件", async () => {
    const who = await rig();
    const prompt = await start(who);
    const body = await frame(who, [line("a")], { prompt });
    await database.sql`UPDATE lane_leases SET holder_install_id = ${randomUUID()} WHERE bot_id = ${who.botId} AND group_id = ${who.groupId}`;
    expect(await send(who.agent, body)).toEqual({ code: "not_holder" });
    await database.sql`UPDATE lane_leases SET holder_install_id = ${who.computer.computerId} WHERE bot_id = ${who.botId} AND group_id = ${who.groupId}`;
    await database.sql`UPDATE computers SET lease_until = clock_timestamp() - interval '1 second' WHERE id = ${who.computer.computerId}`;
    expect(await send(who.agent, body)).toBeNull();
    expect((await state(who)).entries).toHaveLength(1);
  });

  it("65行、坏JSON、缺派生字段与SessionHeader都拒收且不留下空流", async () => {
    const who = await rig();
    const prompt = await start(who);
    for (const lines of [
      Array.from({ length: 65 }, (_, index) => line(String(index))),
      ["{"],
      [JSON.stringify({ type: "message", id: "a" })],
      [JSON.stringify({ type: "session", id: "header", parentId: null })],
    ]) {
      expect(await send(who.agent, await frame(who, lines, { prompt }))).toEqual({ code: "invalid" });
      expect(await state(who)).toEqual({ metadata: undefined, entries: [] });
    }
  });

  it("非空帧必须匹配computer、owner、Bot、group的run，已结束run仍可追加", async () => {
    const who = await rig();
    const prompt = await start(who);
    const body = await frame(who, [line("a")], { prompt });
    expect(await send(who.agent, { ...body, runId: randomUUID() })).toEqual({ code: "invalid" });
    expect(await send(who.agent, { ...body, runId: null })).toEqual({ code: "invalid" });
    who.agent.send({
      type: "run_done",
      runId: prompt.runId,
      botId: who.botId,
      groupId: who.groupId,
      steps: 1,
      inputTokens: 1,
      outputTokens: 1,
    });
    await who.agent.ack(prompt.runId);
    expect(await send(who.agent, body)).toBeNull();
    expect((await state(who)).entries).toHaveLength(1);
  });

  it("复制run的visibleTo，不接受已离群成员或其他owner的道", async () => {
    const who = await rig();
    const prompt = await start(who);
    const visibleTo = [{ kind: "user" }];
    await database.sql`UPDATE runs SET visible_to = ${JSON.stringify(visibleTo)}::jsonb WHERE id = ${prompt.runId}`;
    expect(await send(who.agent, await frame(who, [line("a")], { prompt }))).toBeNull();
    expect((await state(who)).entries[0]?.visible_to).toEqual(visibleTo);
    const other = await rig();
    await start(other);
    expect(await send(who.agent, await frame(other, [line("b")], { epoch: 99 }))).toEqual({ code: "not_holder" });
    await database.sql`DELETE FROM group_members WHERE bot_id = ${who.botId} AND group_id = ${who.groupId}`;
    expect(await send(who.agent, await frame(who, [], { prompt }))).toEqual({ code: "not_holder" });
    expect((await state(who)).entries).toHaveLength(1);
  });

  it("空探针只看持有者和代际，不查run/seq/head，不创建流也不改租约", async () => {
    const who = await rig();
    const probe = { ...(await frame(who, [])), fromSeq: 999, head: "b".repeat(64), runId: RunId.parse(randomUUID()) };
    expect(await send(who.agent, probe)).toEqual({ code: "not_holder" });
    expect(await lease(who)).toBeUndefined();
    const prompt = await start(who);
    const before = await lease(who);
    expect(await send(who.agent, { ...probe, lane: { ...probe.lane, epoch: prompt.lane.epoch } })).toBeNull();
    expect(await lease(who)).toEqual(before);
    expect(await state(who)).toEqual({ metadata: undefined, entries: [] });
    expect(await send(who.agent, { ...probe, lane: { ...probe.lane, epoch: prompt.lane.epoch + 1 } })).toEqual({
      code: "stale_epoch",
    });
  });
});

describe("旧会话导入", () => {
  it("首帧认领epoch1，重复首帧与重新跑都拒收而记录不变", async () => {
    const who = await rig();
    const body = await frame(who, [line("a")]);
    expect(await send(who.agent, body)).toBeNull();
    expect(await lease(who)).toMatchObject({
      holder_computer_id: who.computer.computerId,
      holder_install_id: who.computer.computerId,
      epoch: 1,
    });
    const before = await state(who);
    expect(before.entries[0]).toMatchObject({ run_id: null, visible_to: null, seq: 0 });
    expect(await send(who.agent, body)).toEqual({ code: "invalid" });
    expect(await send(who.agent, await frame(who, [line("another")]))).toEqual({ code: "invalid" });
    expect(await state(who)).toEqual(before);
  });

  it("超过64条导入分两帧，重复首帧拒收而有效续帧继续追加", async () => {
    const who = await rig();
    const lines = Array.from({ length: 65 }, (_, index) => line(String(index), index === 0 ? null : String(index - 1)));
    const first = await frame(who, lines.slice(0, 64));
    expect(await send(who.agent, first)).toBeNull();
    expect(await send(who.agent, first)).toEqual({ code: "invalid" });
    const next = await frame(who, lines.slice(64), { fromSeq: 64, previousHead: first.head });
    expect(await send(who.agent, next)).toBeNull();
    expect(await send(who.agent, next)).toEqual({ code: "seq_mismatch", nextSeq: 65 });
    const stored = await state(who);
    expect(stored.metadata).toMatchObject({ next_seq: 65, head: next.head });
    expect(stored.entries.map((entry) => entry.line)).toEqual(lines);
    expect((await lease(who))?.epoch).toBe(1);
  });

  it("坏首帧不认领，首帧必须epoch1且runId为null", async () => {
    const who = await rig();
    const valid = await frame(who, [line("a")]);
    for (const body of [
      { ...valid, head: "f".repeat(64) },
      await frame(who, ["{"]),
      await frame(who, [line("a")], { epoch: 2 }),
      { ...valid, runId: randomUUID() },
    ]) {
      const result = await send(who.agent, body);
      expect(result?.code).toBe(body.head === "f".repeat(64) ? "head_mismatch" : "invalid");
      expect(await lease(who)).toBeUndefined();
      expect(await state(who)).toEqual({ metadata: undefined, entries: [] });
    }
  });

  it("同安装持有者的空流可重置epoch1，其他持有者不可夺取", async () => {
    const who = await rig();
    await start(who);
    await database.sql`UPDATE lane_leases SET epoch = 3 WHERE bot_id = ${who.botId} AND group_id = ${who.groupId}`;
    expect(await send(who.agent, await frame(who, [line("a")]))).toBeNull();
    expect((await lease(who))?.epoch).toBe(1);
    const remote = ComputerTokenResponse.parse(await (await who.client.post("/api/computers/remote")).json());
    const { agent } = await helloAgent(server.port, remote.computerId, remote.token);
    agents.push(agent);
    expect(await send(agent, await frame(who, [line("table")], { stream: "table" }))).toEqual({ code: "not_holder" });
    expect((await state(who, "table")).metadata).toBeUndefined();
  });

  it("牌桌旧记录按最严范围只给当前Bot", async () => {
    const who = await rig();
    await database.sql`INSERT INTO poker_tables
      (group_id, owner_id, request_id, seats, button_seat, small_blind, big_blind, starting_stack)
      VALUES (${who.groupId}, ${who.ownerId}, ${randomUUID()}, '[]', 1, 1, 2, 100)`;
    expect(await send(who.agent, await frame(who, [line("a")], { stream: "table" }))).toBeNull();
    expect((await state(who, "table")).entries[0]?.visible_to).toEqual([{ kind: "bot", botId: who.botId }]);
  });
});

describe("Hub租约快照", () => {
  it("seq0默认纳入分页，页头始终返回全流元数据，空流版本为null", async () => {
    const who = await rig(9);
    const first = await frame(
      who,
      Array.from({ length: 64 }, (_, index) => line(String(index))),
    );
    expect(await send(who.agent, first)).toBeNull();
    const second = await frame(who, [line("64")], { fromSeq: 64, previousHead: first.head });
    expect(await send(who.agent, second)).toBeNull();
    const page = HubLaneSnapshot.parse(await (await hub(who)).json());
    expect(page.entries.map((entry) => entry.seq)).toEqual(Array.from({ length: 64 }, (_, index) => index));
    expect(page).toMatchObject({ nextSeq: 65, head: second.head, piSessionVersion: 9 });
    const tail = HubLaneSnapshot.parse(await (await hub(who, { query: "?after=63&limit=2" })).json());
    expect(tail.entries).toEqual([{ seq: 64, line: second.lines[0] }]);
    expect(tail).toMatchObject({ nextSeq: 65, head: second.head, piSessionVersion: 9 });
    expect(HubLaneSnapshot.parse(await (await hub(who, { query: "?after=64&limit=200" })).json()).entries).toEqual([]);
    const empty = await hub(who, { path: `${who.botId}/${who.groupId}/table` });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ entries: [], nextSeq: 0, head: EMPTY_WORK_HEAD, piSessionVersion: null });
  });

  it("只接受Bearer网关key，登录cookie不能授权", async () => {
    const who = await rig();
    await start(who);
    expect((await hub(who, { key: null, cookie: true })).status).toBe(401);
    expect((await hub(who, { key: "wrong", cookie: true })).status).toBe(401);
    expect((await hub(who)).status).toBe(200);
  });

  it("缺头、格式不对、旧代际、不是持有者与过期分别返回固定分类", async () => {
    const who = await rig();
    await start(who);
    for (const header of [
      null,
      "",
      `${who.botId}/${who.groupId}/0`,
      `${who.botId}/${who.groupId}/01`,
      `${who.botId}/${who.groupId}/1.5`,
      `${who.botId}/${who.groupId}/9007199254740992`,
      `${who.botId}/${who.groupId}/1/extra`,
    ]) {
      const response = await hub(who, { header });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "缺少或格式不对" });
    }
    const stale = await hub(who, { header: `${who.botId}/${who.groupId}/2` });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "代际过时" });
    const remote = ComputerTokenResponse.parse(await (await who.client.post("/api/computers/remote")).json());
    const { agent, config } = await helloAgent(server.port, remote.computerId, remote.token);
    agents.push(agent);
    const notHolder = await hub(who, { key: config.modelGateway.apiKey });
    expect(notHolder.status).toBe(409);
    expect(await notHolder.json()).toEqual({ error: "不是持有者" });
    await database.sql`UPDATE computers SET install_id = ${randomUUID()} WHERE id = ${who.computer.computerId}`;
    expect(await (await hub(who)).json()).toEqual({ error: "不是持有者" });
    await database.sql`UPDATE computers SET install_id = ${who.computer.computerId}, lease_until = clock_timestamp() - interval '1 second' WHERE id = ${who.computer.computerId}`;
    const expired = await hub(who);
    expect(expired.status).toBe(409);
    expect(await expired.json()).toEqual({ error: "租约已过期" });
  });

  it("路径须匹配头中的道，不泄漏跨owner或无租约的道", async () => {
    const who = await rig();
    const other = await rig();
    await start(who);
    await start(other);
    for (const path of [`${other.botId}/${other.groupId}/chat`, `${who.botId}/${who.groupId}/unknown`]) {
      const response = await hub(who, { path });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "不是持有者" });
    }
    expect(await (await hub(who, { header: `${other.botId}/${other.groupId}/999` })).json()).toEqual({
      error: "不是持有者",
    });
    const empty = await rig();
    expect(await (await hub(empty)).json()).toEqual({ error: "不是持有者" });
  });

  it("分页拒绝越界、非整数与不安全整数", async () => {
    const who = await rig();
    await start(who);
    for (const query of [
      "?after=-2",
      "?after=1.5",
      "?after=9007199254740992",
      "?limit=0",
      "?limit=201",
      "?limit=x",
      "?after=",
    ]) {
      const response = await hub(who, { query });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "分页参数格式不对" });
    }
  });
});
