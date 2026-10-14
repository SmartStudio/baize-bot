import { randomUUID } from "node:crypto";
import {
  ComputerTokenResponse,
  CreateBotResponse,
  CreateGroupResponse,
  RecallResponse,
  type BotId,
  type ControlToAgent,
  type GroupId,
  type RecallEntry,
  type UserId,
  type Viewer,
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
  peerId: BotId;
  currentGroupId: GroupId;
  sourceGroupId: GroupId;
  agent: AgentClient;
  key: string;
  header: string;
  prompt: Prompt;
};

async function rig(): Promise<Rig> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = new ApiClient(server.port);
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const own = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小忆" })).json());
  const peer = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "牌友" })).json());
  const source = CreateGroupResponse.parse(
    await (await client.post("/api/groups", { title: "季度预算讨论", botIds: [own.bot.id, peer.bot.id] })).json(),
  );
  const { agent, config } = await helloAgent(server.port, computer.computerId, computer.token);
  agents.push(agent);
  expect((await client.post(`/api/groups/${own.group.id}/messages`, { text: "在这里召回以前的记录" })).status).toBe(
    201,
  );
  const prompt = await agent.expect("prompt");
  expect(prompt.botId).toBe(own.bot.id);
  agent.send({
    type: "run_done",
    runId: prompt.runId,
    botId: prompt.botId,
    groupId: prompt.groupId,
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
  });
  await agent.ack(prompt.runId);
  return {
    ownerId: user.id,
    client,
    computer,
    botId: own.bot.id,
    peerId: peer.bot.id,
    currentGroupId: own.group.id,
    sourceGroupId: source.group.id,
    agent,
    key: config.modelGateway.apiKey,
    header: `${own.bot.id}/${own.group.id}/${prompt.lane.epoch}`,
    prompt,
  };
}

async function record(
  who: Rig,
  text: string,
  options: {
    botId?: BotId;
    groupId?: GroupId;
    ownerId?: UserId;
    stream?: WorkStream;
    visibleTo?: Viewer[];
    role?: string;
    piType?: string;
    timestamp?: string | null;
    runId?: string;
    searchText?: string;
  } = {},
): Promise<string> {
  const entryId = randomUUID();
  const groupId = options.groupId ?? who.sourceGroupId;
  const botId = options.botId ?? who.botId;
  const stream = options.stream ?? "chat";
  const piType = options.piType ?? "message";
  const timestamp = options.timestamp === null ? null : (options.timestamp ?? "2026-10-01T00:00:00.000Z");
  const entryAt =
    stream === "chat" &&
    piType === "message" &&
    timestamp !== null &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp) &&
    Number.isFinite(Date.parse(timestamp))
      ? new Date(Date.parse(timestamp)).toISOString()
      : null;
  const [next] = await database.sql<{ seq: number }[]>`
    SELECT coalesce(max(seq) + 1, 0) AS seq FROM work_entries
    WHERE bot_id = ${botId} AND group_id = ${groupId} AND stream = ${stream}
  `;
  const line = JSON.stringify({
    type: piType,
    id: entryId,
    parentId: null,
    ...(timestamp === null ? {} : { timestamp }),
    message: { role: options.role ?? "assistant", content: [{ type: "text", text }] },
  });
  await database.sql`
    INSERT INTO work_entries
      (bot_id, group_id, stream, seq, epoch, owner_id, run_id, entry_id, parent_id, pi_type, retention, line, search_text, visible_to, entry_at)
    VALUES (${botId}, ${groupId}, ${stream}, ${next!.seq}, 1, ${options.ownerId ?? who.ownerId},
      ${options.runId ?? null}, ${entryId}, null, ${piType}, 'verbatim', ${line}, ${options.searchText ?? text},
      ${options.visibleTo === undefined ? null : JSON.stringify(options.visibleTo)}::jsonb, ${entryAt})
  `;
  return entryId;
}

function request(
  who: Rig,
  body: unknown = { query: "预算" },
  options: { key?: string | null; header?: string | null; raw?: string; cookie?: boolean } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.key !== null) headers.authorization = `Bearer ${options.key ?? who.key}`;
  if (options.header !== null) headers["x-baize-lane"] = options.header ?? who.header;
  if (options.cookie && who.client.cookie !== null) headers.cookie = who.client.cookie;
  return fetch(`${who.client.origin}/hub/v1/recall`, {
    method: "POST",
    headers,
    body: options.raw ?? JSON.stringify(body),
  });
}

async function recall(who: Rig, query: string): Promise<RecallEntry[]> {
  const response = await request(who, { query });
  expect(response.status).toBe(200);
  return RecallResponse.parse(await response.json());
}

describe("现查现用的 recall", () => {
  it("返回来源群当前标题、ISO时间和三种消息角色，先相似度再时间排序", async () => {
    const who = await rig();
    await record(who, "预算", { role: "user", timestamp: "2026-10-01T01:00:00+08:00" });
    await record(who, "预算", { role: "toolResult", timestamp: "2026-10-02T00:00:00.000Z" });
    await record(who, "预算已经经过审批，项目经理明天给出完整安排", {
      role: "assistant",
      timestamp: "2026-10-03T00:00:00.000Z",
    });
    await database.sql`UPDATE tasks SET title = '季度预算终稿' WHERE group_id = ${who.sourceGroupId}`;
    const entries = await recall(who, "预算");
    expect(entries).toEqual([
      {
        groupId: who.sourceGroupId,
        groupTitle: "季度预算终稿",
        at: "2026-10-02T00:00:00.000Z",
        kind: "toolResult",
        excerpt: "预算",
      },
      {
        groupId: who.sourceGroupId,
        groupTitle: "季度预算终稿",
        at: "2026-09-30T17:00:00.000Z",
        kind: "user",
        excerpt: "预算",
      },
      {
        groupId: who.sourceGroupId,
        groupTitle: "季度预算终稿",
        at: "2026-10-03T00:00:00.000Z",
        kind: "assistant",
        excerpt: "预算已经经过审批，项目经理明天给出完整安排",
      },
    ]);
  });

  it("牌友 Bot 查不到别人的底牌：牌桌流和隐藏 run 都不进入召回", async () => {
    const who = await rig();
    await record(who, "牌桌底牌只有牌友知道", { stream: "table" });
    const hiddenRunId = randomUUID();
    await database.sql`
      INSERT INTO runs (id, owner_id, bot_id, group_id, computer_id, started_at, visible_to)
      VALUES (${hiddenRunId}, ${who.ownerId}, ${who.botId}, ${who.sourceGroupId}, ${who.computer.computerId},
        '2026-10-01T00:00:00Z', ${JSON.stringify([{ kind: "bot", botId: who.botId }])}::jsonb)
    `;
    await record(who, "隐藏底牌只能私下展示", { runId: hiddenRunId, visibleTo: [{ kind: "bot", botId: who.botId }] });
    expect(await recall(who, "底牌")).toEqual([]);
  });

  it("别的 Bot 的条目查不到", async () => {
    const who = await rig();
    await record(who, "队友的专属预算", { botId: who.peerId });
    expect(await recall(who, "专属预算")).toEqual([]);
  });

  it("visible_to 非空的条目查不到，包括只对当前 Bot 可见的私密记录", async () => {
    const who = await rig();
    for (const viewer of [
      { kind: "user" } as const,
      { kind: "bot", botId: who.peerId } as const,
      { kind: "bot", botId: who.botId } as const,
    ])
      await record(who, "私密预算不能回流", { visibleTo: [viewer] });
    expect(await recall(who, "私密预算")).toEqual([]);
  });

  it("当前群不出现在召回结果", async () => {
    const who = await rig();
    await record(who, "当前预算已经在会话里", { groupId: who.currentGroupId });
    expect(await recall(who, "当前预算")).toEqual([]);
  });

  it("别的归属人的条目和群标题均查不到", async () => {
    const who = await rig();
    const other = await makeUser(database.db);
    await record(who, "异主预算记录", { ownerId: other.id });
    expect(await recall(who, "异主预算")).toEqual([]);
    await record(who, "异主来源群记录");
    await database.sql`UPDATE groups SET owner_id = ${other.id} WHERE id = ${who.sourceGroupId}`;
    expect(await recall(who, "异主来源群")).toEqual([]);
  });

  it("Bot 已被移出来源群后不能读旧记录或标题", async () => {
    const who = await rig();
    await record(who, "移出之前的预算");
    expect(await recall(who, "移出之前")).toHaveLength(1);
    await database.sql`DELETE FROM group_members WHERE group_id = ${who.sourceGroupId} AND bot_id = ${who.botId}`;
    expect(await recall(who, "移出之前")).toEqual([]);
  });

  it("来源群已删除后同一查询回空，工作记录随群级联删除", async () => {
    const who = await rig();
    await record(who, "删群之前的预算");
    expect(await recall(who, "删群之前")).toHaveLength(1);
    await database.sql`DELETE FROM groups WHERE id = ${who.sourceGroupId}`;
    expect(await recall(who, "删群之前")).toEqual([]);
    expect(await database.sql`SELECT entry_id FROM work_entries WHERE group_id = ${who.sourceGroupId}`).toHaveLength(0);
  });

  it("删除 Bot 后原道的同一召回请求被栅栏拒绝且没有工作记录残留", async () => {
    const who = await rig();
    await record(who, "删Bot之前的预算");
    expect(await recall(who, "删Bot之前")).toHaveLength(1);
    expect((await who.client.delete(`/api/bots/${who.botId}`)).status).toBe(204);
    const response = await request(who, { query: "删Bot之前" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "不是持有者" });
    expect(await database.sql`SELECT entry_id FROM work_entries WHERE bot_id = ${who.botId}`).toHaveLength(0);
  });

  it("最多返回8条，按时间保留最新的命中", async () => {
    const who = await rig();
    for (let day = 1; day <= 12; day += 1)
      await record(who, "限量预算", { timestamp: `2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z` });
    const entries = await recall(who, "限量预算");
    expect(entries).toHaveLength(8);
    expect(entries.map((entry) => entry.at)).toEqual(
      Array.from({ length: 8 }, (_, offset) => `2026-10-${String(12 - offset).padStart(2, "0")}T00:00:00.000Z`),
    );
  });

  it("最新的命中被过滤掉时分批续取：前几批全是不合规条目也能凑够8条", async () => {
    const who = await rig();
    for (let day = 1; day <= 12; day += 1)
      await record(who, "续取预算", { timestamp: `2026-09-${String(day).padStart(2, "0")}T00:00:00.000Z` });
    // 70 条有效时间的非法角色会跨过 32 条首批并进入 64 条第二批，之后仍能取到正常条目。
    for (let index = 0; index < 70; index += 1)
      await record(who, "续取预算", {
        role: "system",
        timestamp: new Date(Date.UTC(2026, 9, 1) + index * 60_000).toISOString(),
      });
    const entries = await recall(who, "续取预算");
    expect(entries.map((entry) => entry.at)).toEqual(
      Array.from({ length: 8 }, (_, offset) => `2026-09-${String(12 - offset).padStart(2, "0")}T00:00:00.000Z`),
    );
  });

  it("前两批96条陈旧角色命中全部过滤后，第三批返回最新8条合法命中", async () => {
    const who = await rig();
    const query = "分页预算";
    for (let index = 0; index < 12; index += 1)
      await record(who, query, {
        timestamp: new Date(Date.UTC(2026, 9, 1) + index * 60_000).toISOString(),
      });
    for (let index = 0; index < 96; index += 1)
      await record(who, "历史陈旧条目", {
        role: "system",
        timestamp: new Date(Date.UTC(2026, 9, 2) + index * 60_000).toISOString(),
        searchText: query,
      });

    const entries = await recall(who, query);
    expect(entries).toHaveLength(8);
    expect(entries.map((entry) => entry.at)).toEqual(
      Array.from({ length: 8 }, (_, offset) => new Date(Date.UTC(2026, 9, 1) + (11 - offset) * 60_000).toISOString()),
    );
  });

  it("命中全部被过滤时取完即停，回空", async () => {
    const who = await rig();
    for (let index = 0; index < 40; index += 1) await record(who, "全滤预算", { role: "system" });
    expect(await recall(who, "全滤预算")).toEqual([]);
  });

  it("相似度和时间都相同时按群号的码点序、再按seq倒序", async () => {
    const who = await rig();
    const second = CreateGroupResponse.parse(
      await (await who.client.post("/api/groups", { title: "第二个预算群", botIds: [who.botId, who.peerId] })).json(),
    );
    const timestamp = "2026-10-05T00:00:00.000Z";
    await record(who, "同分预算", { groupId: who.sourceGroupId, timestamp });
    await record(who, "同分预算", { groupId: second.group.id, timestamp });
    await record(who, "同分预算", { groupId: second.group.id, timestamp });
    const entries = await recall(who, "同分预算");
    const ordered = [who.sourceGroupId, second.group.id].toSorted((a, b) => (a < b ? -1 : 1));
    const expected = ordered.flatMap((groupId) => (groupId === second.group.id ? [groupId, groupId] : [groupId]));
    expect(entries.map((entry) => entry.groupId)).toEqual(expected);
  });

  it("摘录最多400字符且保留靠近长文末尾的关键词", async () => {
    const who = await rig();
    const text = `${"历史背景".repeat(250)}末尾预算${"后续安排".repeat(12)}`;
    await record(who, text);
    const [entry] = await recall(who, "末尾预算");
    expect(entry!.excerpt).toHaveLength(400);
    expect(entry!.excerpt).toContain("末尾预算");
    expect(text).toContain(entry!.excerpt);
  });

  it("百分号、下划线和反斜线都按字面量匹配", async () => {
    const who = await rig();
    for (const text of ["折扣20%方案", "文件budget_2026", "目录budget\\2026", "普通预算记录"]) await record(who, text);
    for (const [query, expected] of [
      ["%", "折扣20%方案"],
      ["_", "文件budget_2026"],
      ["\\", "目录budget\\2026"],
    ] as const)
      expect((await recall(who, query)).map((entry) => entry.excerpt)).toEqual([expected]);
  });

  it("关键词去掉首尾空白并按大小写无关子串匹配", async () => {
    const who = await rig();
    await record(who, "BaIzE预算");
    expect((await recall(who, "  baize  ")).map((entry) => entry.excerpt)).toEqual(["BaIzE预算"]);
  });

  it("缺失或非法时间回退到run开始时间或群创建时间，非message和非法role不召回", async () => {
    const who = await rig();
    await record(who, "回退群时间", { timestamp: "坏时间" });
    await record(who, "回退run时间", { timestamp: null, runId: who.prompt.runId });
    await record(who, "排除其他类型", { piType: "compaction" });
    await record(who, "排除其他角色", { role: "system" });
    const [group] = await database.sql<
      { at: string }[]
    >`SELECT created_at AS at FROM groups WHERE id = ${who.sourceGroupId}`;
    const [run] = await database.sql<
      { at: string }[]
    >`SELECT started_at AS at FROM runs WHERE id = ${who.prompt.runId}`;
    expect((await recall(who, "回退群时间"))[0]!.at).toBe(new Date(group!.at).toISOString());
    expect((await recall(who, "回退run时间"))[0]!.at).toBe(new Date(run!.at).toISOString());
    expect(await recall(who, "排除其他")).toEqual([]);
  });

  it("请求不能自报Bot、群或归属人，非法body和坏JSON回400", async () => {
    const who = await rig();
    for (const body of [
      {},
      { query: "" },
      { query: "  " },
      { query: "字".repeat(101) },
      { query: "预算\u0000" },
      { query: 1 },
      { query: "预算", botId: who.peerId },
      { query: "预算", groupId: who.sourceGroupId },
      { query: "预算", ownerId: who.ownerId },
    ]) {
      const response = await request(who, body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "召回参数格式不对" });
    }
    const invalid = await request(who, undefined, { raw: "{" });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "召回参数格式不对" });
  });

  it("缺少租约头、格式不对和旧代际均被栅栏挡下", async () => {
    const who = await rig();
    await record(who, "预算");
    for (const header of [null, `${who.botId}/${who.currentGroupId}/0`]) {
      const response = await request(who, undefined, { header });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "缺少或格式不对" });
    }
    await database.sql`UPDATE lane_leases SET epoch = epoch + 1 WHERE bot_id = ${who.botId} AND group_id = ${who.currentGroupId}`;
    const stale = await request(who);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "代际过时" });
  });

  it("没有租约行、不是持有者和租约过期均被栅栏挡下", async () => {
    const who = await rig();
    const remote = ComputerTokenResponse.parse(await (await who.client.post("/api/computers/remote")).json());
    const other = await helloAgent(server.port, remote.computerId, remote.token);
    agents.push(other.agent);
    const notHolder = await request(who, undefined, { key: other.config.modelGateway.apiKey });
    expect(notHolder.status).toBe(409);
    expect(await notHolder.json()).toEqual({ error: "不是持有者" });
    await database.sql`UPDATE computers SET lease_until = clock_timestamp() - interval '1 second' WHERE id = ${who.computer.computerId}`;
    const expired = await request(who);
    expect(expired.status).toBe(409);
    expect(await expired.json()).toEqual({ error: "租约已过期" });
    await database.sql`DELETE FROM lane_leases WHERE bot_id = ${who.botId} AND group_id = ${who.currentGroupId}`;
    const missing = await request(who);
    expect(missing.status).toBe(409);
    expect(await missing.json()).toEqual({ error: "不是持有者" });
  });

  it("只带登录cookie或错误网关key都不能召回", async () => {
    const who = await rig();
    for (const key of [null, "wrong-key"]) {
      const response = await request(who, undefined, { key, cookie: true });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "网关 key 不对，换一把再来" });
    }
  });
});
