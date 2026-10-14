import { randomUUID } from "node:crypto";
import {
  AgentCloseCode,
  ComputerTokenResponse,
  CreateBotResponse,
  CreateGroupResponse,
  MessageListResponse,
  type BotId,
  type ComputerId,
  type ControlToAgent,
  type GroupId,
  type UserId,
} from "@baize/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentHub } from "../src/agent/hub.js";
import { startServer, type RunningServer } from "../src/server.js";
import { expectHello, openAgent, sendHello, type AgentClient, type HelloOverrides } from "./helpers/agent.js";
import { ApiClient, TEST_CREDENTIALS_KEY } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { makeComputer, makeUser, PASSWORD, waitFor, type TestComputer } from "./helpers/fixtures.js";
import { connectPush, type PushClient } from "./helpers/ws.js";

let database: TestDb;
let server: RunningServer;
let agents: AgentClient[] = [];
let pushes: PushClient[] = [];

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
  vi.restoreAllMocks();
  for (const push of pushes) push.close();
  for (const agent of agents) agent.close();
  await Promise.all(agents.map((agent) => agent.closed()));
  agents = [];
  pushes = [];
});

afterAll(async () => {
  await server.close();
  await database.close();
});

type Prompt = Extract<ControlToAgent, { type: "prompt" }>;
type Owner = {
  readonly ownerId: UserId;
  readonly client: ApiClient;
  readonly local: TestComputer;
  readonly remote: TestComputer;
  readonly botId: BotId;
  readonly groupId: GroupId;
};
type Lease = {
  holder_computer_id: string;
  holder_install_id: string;
  epoch: number;
  updated_at: string;
};

async function owner(): Promise<Owner> {
  const user = await makeUser(database.db);
  const local = await makeComputer(database.db, user.id);
  const client = new ApiClient(server.port);
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const remoteResponse = await client.post("/api/computers/remote");
  expect(remoteResponse.status).toBe(200);
  const remote = ComputerTokenResponse.parse(await remoteResponse.json());
  const created = await bot(client, "小运");
  return {
    ownerId: user.id,
    client,
    local,
    remote: { computerId: remote.computerId, token: remote.token },
    botId: created.bot.id,
    groupId: created.group.id,
  };
}

async function bot(client: ApiClient, name: string): Promise<ReturnType<typeof CreateBotResponse.parse>> {
  const response = await client.post("/api/bots", { name });
  expect(response.status).toBe(201);
  return CreateBotResponse.parse(await response.json());
}

async function online(
  computer: TestComputer,
  activeRuns: readonly Prompt["runId"][] = [],
  overrides: HelloOverrides = {},
): Promise<AgentClient> {
  // 不确认下行，才能观察接管后发件箱中 cancel 的保留与合并。
  const agent = await openAgent(server.port, { ackDownlink: false });
  agents.push(agent);
  sendHello(agent, computer.computerId, computer.token, activeRuns, overrides);
  await expectHello(agent);
  return agent;
}

async function lease(botId: BotId, groupId: GroupId): Promise<Lease | undefined> {
  const [row] = await database.sql<Lease[]>`
    SELECT holder_computer_id, holder_install_id, epoch, updated_at
    FROM lane_leases WHERE bot_id = ${botId} AND group_id = ${groupId}
  `;
  return row;
}

async function expire(computer: TestComputer): Promise<void> {
  await database.sql`UPDATE computers SET lease_until = now() - interval '1 second' WHERE id = ${computer.computerId}`;
}

async function renew(computer: TestComputer): Promise<void> {
  await database.sql`UPDATE computers SET lease_until = now() + interval '2 minutes' WHERE id = ${computer.computerId}`;
}

async function post(client: ApiClient, groupId: GroupId, text: string): Promise<Response> {
  const response = await client.post(`/api/groups/${groupId}/messages`, { text });
  expect(response.status).toBe(201);
  return response;
}

async function prompt(agent: AgentClient, text: string): Promise<Prompt> {
  const message = await agent.expect("prompt");
  expect(message.text).toBe(text);
  return message;
}

async function finish(agent: AgentClient, message: Prompt): Promise<void> {
  agent.send({
    type: "run_done",
    runId: message.runId,
    botId: message.botId,
    groupId: message.groupId,
    steps: 1,
    inputTokens: 1,
    outputTokens: 1,
  });
  await agent.ack(message.runId);
}

async function runComputers(groupId: GroupId): Promise<string[]> {
  const rows = await database.sql<{ computer_id: string }[]>`
    SELECT computer_id FROM runs WHERE group_id = ${groupId} ORDER BY started_at, id
  `;
  return rows.map((row) => row.computer_id);
}

async function cancelInOutbox(computerId: ComputerId, botId: BotId, groupId: GroupId): Promise<unknown[]> {
  const rows = await database.sql<{ body: unknown }[]>`
    SELECT body FROM agent_outbox WHERE computer_id = ${computerId}
      AND body->>'type' = 'cancel' AND body->'lane'->>'botId' = ${botId}
      AND body->'lane'->>'groupId' = ${groupId} ORDER BY seq
  `;
  return rows.map((row) => row.body);
}

async function pushedSleeping(push: PushClient, computerIds: readonly ComputerId[]): Promise<void> {
  const waiting = new Set(computerIds);
  while (waiting.size > 0) {
    const message = await push.next();
    if (message.type === "computer_updated" && message.computer.status === "sleeping")
      waiting.delete(message.computer.id);
  }
}

async function seedRecords(who: Owner, message: Prompt): Promise<void> {
  for (const stream of ["chat", "table"] as const) {
    const entryId = randomUUID();
    const line = JSON.stringify({
      type: "message",
      id: entryId,
      parentId: null,
      message: { role: "user", content: "记录" },
    });
    await database.sql`
      INSERT INTO work_streams (bot_id, group_id, stream, next_seq, head, tail_entry_id, pi_session_version)
      VALUES (${message.botId}, ${message.groupId}, ${stream}, 1, ${"a".repeat(64)}, ${entryId}, 3)
    `;
    await database.sql`
      INSERT INTO work_entries
        (bot_id, group_id, stream, seq, epoch, owner_id, run_id, entry_id, parent_id, pi_type, retention, line, search_text)
      VALUES (${message.botId}, ${message.groupId}, ${stream}, 0, ${message.lane.epoch}, ${who.ownerId}, ${message.runId},
        ${entryId}, null, 'message', 'verbatim', ${line}, '记录')
    `;
  }
}

async function recordCounts(
  botId: BotId,
  groupId: GroupId,
): Promise<{ leases: number; streams: number; entries: number }> {
  const [counts] = await database.sql<{ leases: number; streams: number; entries: number }[]>`
    SELECT
      (SELECT count(*)::int FROM lane_leases WHERE bot_id = ${botId} AND group_id = ${groupId}) AS leases,
      (SELECT count(*)::int FROM work_streams WHERE bot_id = ${botId} AND group_id = ${groupId}) AS streams,
      (SELECT count(*)::int FROM work_entries WHERE bot_id = ${botId} AND group_id = ${groupId}) AS entries
  `;
  if (counts === undefined) throw new Error("计数查询没有返回");
  return counts;
}

async function laneCancel(agent: AgentClient, botId: BotId, groupId: GroupId, epoch: number): Promise<void> {
  for (;;) {
    const message = await agent.next().catch(() => {
      throw new Error(`等 ${botId}/${groupId} 的第 ${epoch} 代 cancel 超时`);
    });
    if (message.type === "cancel" && message.lane?.botId === botId && message.lane.groupId === groupId) {
      expect(message).toEqual({ type: "cancel", lane: { botId, groupId }, epoch });
      return;
    }
  }
}

describe("道租约派活", () => {
  it("hello 按静默与宽限续租，合并窗口内不重写，断线缩到宽限且同安装重连不加代际", async () => {
    const who = await owner();
    const beforeHello = Date.now();
    const local = await online(who.local);
    const afterHello = Date.now();
    const [connected] = await database.sql<{ lease_until: string; install_id: string }[]>`
      SELECT lease_until, install_id FROM computers WHERE id = ${who.local.computerId}
    `;
    expect(connected?.install_id).toBe(who.local.computerId);
    expect(new Date(connected?.lease_until ?? "").getTime()).toBeGreaterThanOrEqual(beforeHello + 120_000);
    expect(new Date(connected?.lease_until ?? "").getTime()).toBeLessThanOrEqual(afterHello + 120_000);
    await post(who.client, who.groupId, "同一安装第一条");
    await finish(local, await prompt(local, "同一安装第一条"));
    const [renewed] = await database.sql<{ lease_until: string }[]>`
      SELECT lease_until FROM computers WHERE id = ${who.local.computerId}
    `;
    expect(renewed?.lease_until, "合并窗口内已经落地的上行不再写租约时钟").toEqual(connected?.lease_until);

    const push = await connectPush(server.port, who.client.cookie ?? "");
    pushes.push(push);
    const beforeClose = Date.now();
    local.close();
    await pushedSleeping(push, [who.local.computerId]);
    const afterClose = Date.now();
    const [disconnected] = await database.sql<{ lease_until: string }[]>`
      SELECT lease_until FROM computers WHERE id = ${who.local.computerId}
    `;
    expect(new Date(disconnected?.lease_until ?? "").getTime()).toBeGreaterThanOrEqual(beforeClose + 60_000);
    expect(new Date(disconnected?.lease_until ?? "").getTime()).toBeLessThanOrEqual(afterClose + 60_000);
    const reconnected = await online(who.local);
    await post(who.client, who.groupId, "同一安装重连后");
    expect((await prompt(reconnected, "同一安装重连后")).lane.epoch).toBe(1);
  });

  it("远程持有有效忙道时，本机上线也粘在远程，代际不变", async () => {
    const who = await owner();
    const remote = await online(who.remote);
    await post(who.client, who.groupId, "第一件事");
    const first = await prompt(remote, "第一件事");
    expect(first.lane).toEqual({ epoch: 1, heads: {} });
    const local = await online(who.local);

    await post(who.client, who.groupId, "排在同一道里");
    expect((await prompt(remote, "排在同一道里")).lane).toEqual(first.lane);
    expect(await runComputers(who.groupId)).toEqual([who.remote.computerId, who.remote.computerId]);
    expect(await lease(who.botId, who.groupId)).toMatchObject({
      holder_computer_id: who.remote.computerId,
      holder_install_id: who.remote.computerId,
      epoch: 1,
    });
    expect(local.received().filter((message) => message.type === "prompt")).toEqual([]);
  });

  it("远程闲道在本机回来后迁回，prompt 带服务器已有的两条流头", async () => {
    const who = await owner();
    const remote = await online(who.remote);
    await post(who.client, who.groupId, "先在远程做完");
    const first = await prompt(remote, "先在远程做完");
    await seedRecords(who, first);
    await finish(remote, first);
    const local = await online(who.local);

    await post(who.client, who.groupId, "回到本机");
    const next = await prompt(local, "回到本机");
    expect(next.lane).toEqual({
      epoch: 2,
      heads: { chat: { seq: 1, head: "a".repeat(64) }, table: { seq: 1, head: "a".repeat(64) } },
    });
    expect(await cancelInOutbox(who.remote.computerId, who.botId, who.groupId)).toEqual([
      { type: "cancel", lane: { botId: who.botId, groupId: who.groupId }, epoch: 2 },
    ]);
    await laneCancel(remote, who.botId, who.groupId, 2);
    expect(await runComputers(who.groupId)).toEqual([who.remote.computerId, who.local.computerId]);
  });

  it("持有电脑租约过期后接管，连续换手只在旧主发件箱保留最大代际的 cancel", async () => {
    const who = await owner();
    const local = await online(who.local);
    const remote = await online(who.remote);
    await post(who.client, who.groupId, "第一代");
    expect((await prompt(local, "第一代")).lane.epoch).toBe(1);

    await expire(who.local);
    await post(who.client, who.groupId, "第二代");
    expect((await prompt(remote, "第二代")).lane.epoch).toBe(2);
    expect(await cancelInOutbox(who.local.computerId, who.botId, who.groupId)).toEqual([
      { type: "cancel", lane: { botId: who.botId, groupId: who.groupId }, epoch: 2 },
    ]);
    await laneCancel(local, who.botId, who.groupId, 2);

    await expire(who.remote);
    await renew(who.local);
    await post(who.client, who.groupId, "第三代");
    expect((await prompt(local, "第三代")).lane.epoch).toBe(3);
    await laneCancel(remote, who.botId, who.groupId, 3);

    await expire(who.local);
    await renew(who.remote);
    await post(who.client, who.groupId, "第四代");
    expect((await prompt(remote, "第四代")).lane.epoch).toBe(4);
    await laneCancel(local, who.botId, who.groupId, 4);
    expect(await cancelInOutbox(who.local.computerId, who.botId, who.groupId)).toEqual([
      { type: "cancel", lane: { botId: who.botId, groupId: who.groupId }, epoch: 4 },
    ]);
    expect(await lease(who.botId, who.groupId)).toMatchObject({ holder_computer_id: who.remote.computerId, epoch: 4 });
  });

  it("持有者在派活等电脑锁期间租约过期，未收尾的run不阻止新电脑接管", async () => {
    const who = await owner();
    const local = await online(who.local);
    const remote = await online(who.remote);
    await post(who.client, who.groupId, "持有者仍在跑");
    const first = await prompt(local, "持有者仍在跑");
    expect(first.lane.epoch).toBe(1);

    const originalOnline = AgentHub.prototype.isOnline;
    const selection = vi.spyOn(AgentHub.prototype, "isOnline").mockImplementation(function (this: AgentHub, id) {
      return id === who.local.computerId ? false : originalOnline.call(this, id);
    });
    let release!: () => void;
    let held!: () => void;
    let blockerPid = 0;
    let leaseUntil = 0;
    const locked = new Promise<void>((resolve) => (held = resolve));
    const unlock = new Promise<void>((resolve) => (release = resolve));
    const blocker = database.sql.begin(async (tx) => {
      const [backend] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      if (backend === undefined) throw new Error("持锁连接不存在");
      blockerPid = backend.pid;
      await tx`SELECT id FROM computers WHERE id = ${who.local.computerId} FOR NO KEY UPDATE`;
      const [deadline] = await tx<{ lease_until_ms: string }[]>`
        UPDATE computers SET lease_until = clock_timestamp() + interval '1 second'
        WHERE id = ${who.local.computerId}
        RETURNING extract(epoch FROM lease_until) * 1000 AS lease_until_ms
      `;
      if (deadline === undefined) throw new Error("持有电脑不存在");
      leaseUntil = Number(deadline.lease_until_ms);
      held();
      await unlock;
    });
    let running: Promise<Response> | undefined;
    try {
      await locked;
      running = post(who.client, who.groupId, "等锁后由远程接管");
      let transactionStartedAt = Number.POSITIVE_INFINITY;
      await waitFor(async () => {
        const [waiting] = await database.sql<{ xact_start_ms: string }[]>`
          SELECT extract(epoch FROM xact_start) * 1000 AS xact_start_ms FROM pg_stat_activity
          WHERE datname = ${database.databaseName} AND wait_event_type = 'Lock'
            AND query ILIKE '%computers%' AND ${blockerPid} = ANY(pg_blocking_pids(pid))
        `;
        if (waiting === undefined) return false;
        transactionStartedAt = Number(waiting.xact_start_ms);
        return true;
      }, "接管派活排在持有者的电脑锁后面");
      selection.mockRestore();
      expect(transactionStartedAt, "冻结的事务时间仍在持有者租约有效期内").toBeLessThan(leaseUntil);
      await waitFor(async () => {
        const [clock] = await database.sql<{ now_ms: string }[]>`
          SELECT extract(epoch FROM clock_timestamp()) * 1000 AS now_ms
        `;
        return Number(clock?.now_ms) > leaseUntil;
      }, "数据库时钟越过持有者的租约到期点");
      const [busy] = await database.sql<{ ended_at: string | null }[]>`
        SELECT ended_at FROM runs WHERE id = ${first.runId}
      `;
      expect(busy?.ended_at, "接管必须靠持有者已过期，不能靠道已闲置").toBeNull();
      release();
      await blocker;
      await running;

      expect(await lease(who.botId, who.groupId)).toMatchObject({
        holder_computer_id: who.remote.computerId,
        holder_install_id: who.remote.computerId,
        epoch: 2,
      });
      expect((await prompt(remote, "等锁后由远程接管")).lane.epoch).toBe(2);
      await laneCancel(local, who.botId, who.groupId, 2);
      expect(await runComputers(who.groupId)).toEqual([who.local.computerId, who.remote.computerId]);
    } finally {
      release();
      await Promise.allSettled([blocker, running]);
    }
  });

  it("同一 computerId 换 installId 后下一条活接管并加代际", async () => {
    const who = await owner();
    const old = await online(who.local);
    await post(who.client, who.groupId, "旧安装的活");
    const first = await prompt(old, "旧安装的活");
    const installId = randomUUID();
    const replacement = await online(who.local, [first.runId], { installId });
    expect(await old.closed()).toBe(AgentCloseCode.superseded);

    await post(who.client, who.groupId, "新安装接手");
    await laneCancel(replacement, who.botId, who.groupId, 2);
    const second = await prompt(replacement, "新安装接手");
    expect(second.lane.epoch).toBe(2);
    expect(await lease(who.botId, who.groupId)).toMatchObject({
      holder_computer_id: who.local.computerId,
      holder_install_id: installId,
      epoch: 2,
    });
  });

  it("所有电脑已过宽限时不建 run，群里留提示且道租约不变", async () => {
    const who = await owner();
    const local = await online(who.local);
    const remote = await online(who.remote);
    const push = await connectPush(server.port, who.client.cookie ?? "");
    pushes.push(push);
    await post(who.client, who.groupId, "已有的活");
    await prompt(local, "已有的活");
    local.close();
    remote.close();
    await pushedSleeping(push, [who.local.computerId, who.remote.computerId]);
    await database.sql`
      UPDATE computers SET lease_until = now() - interval '1 second', idle_since = now() - interval '2 minutes'
      WHERE owner_id = ${who.ownerId}
    `;
    const before = await lease(who.botId, who.groupId);

    await post(who.client, who.groupId, "没人接的活");
    expect(await runComputers(who.groupId)).toEqual([who.local.computerId]);
    expect(await lease(who.botId, who.groupId)).toEqual(before);
    const page = MessageListResponse.parse(await (await who.client.get(`/api/groups/${who.groupId}/messages`)).json());
    expect(
      page.messages.flatMap(({ body }) => (body.kind === "system" && body.tone === "error" ? [body.text] : [])),
    ).toEqual(["你的电脑都不在线，这条没派出去，有一台回来后再说一次"]);
  });

  it("两个群同时从 A 接管到 B 和从 B 接管到 A，不发生 40P01", async () => {
    const who = await owner();
    const peer = await bot(who.client, "队友");
    const local = await online(who.local);
    const remote = await online(who.remote);
    await post(who.client, who.groupId, "A 先持有");
    await finish(local, await prompt(local, "A 先持有"));

    const originalOnline = AgentHub.prototype.isOnline;
    let preferred: ComputerId | null = who.remote.computerId;
    const checked = new Set<ComputerId>();
    let selectionDone: (() => void) | undefined;
    const spy = vi.spyOn(AgentHub.prototype, "isOnline").mockImplementation(function (this: AgentHub, id) {
      if (preferred === null || (id !== who.local.computerId && id !== who.remote.computerId))
        return originalOnline.call(this, id);
      checked.add(id);
      if (checked.size === 2) selectionDone?.();
      return id === preferred;
    });
    await post(who.client, peer.group.id, "B 先持有");
    preferred = null;
    await finish(remote, await prompt(remote, "B 先持有"));

    let release!: () => void;
    let locked!: () => void;
    const held = new Promise<void>((resolve) => (locked = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    const blocker = database.sql.begin(async (tx) => {
      await tx`SELECT id FROM computers WHERE owner_id = ${who.ownerId} ORDER BY id FOR UPDATE`;
      locked();
      await released;
    });
    await held;
    let left: Promise<Response> | undefined;
    let right: Promise<Response> | undefined;
    try {
      preferred = who.remote.computerId;
      spy.mockImplementation(function (this: AgentHub, id) {
        if (preferred === null || (id !== who.local.computerId && id !== who.remote.computerId))
          return originalOnline.call(this, id);
        checked.add(id);
        if (checked.size === 2) selectionDone?.();
        return id === preferred;
      });
      checked.clear();
      const firstSelected = new Promise<void>((resolve) => (selectionDone = resolve));
      left = who.client.post(`/api/groups/${who.groupId}/messages`, { text: "A 到 B" });
      await firstSelected;
      preferred = who.local.computerId;
      checked.clear();
      const secondSelected = new Promise<void>((resolve) => (selectionDone = resolve));
      right = who.client.post(`/api/groups/${peer.group.id}/messages`, { text: "B 到 A" });
      await secondSelected;
      spy.mockRestore();
      release();
      await blocker;
      expect((await left).status).toBe(201);
      expect((await right).status).toBe(201);
      const remoteMessages = [await remote.next(), await remote.next()];
      const localMessages = [await local.next(), await local.next()];
      expect(remoteMessages).toContainEqual({
        type: "cancel",
        lane: { botId: peer.bot.id, groupId: peer.group.id },
        epoch: 2,
      });
      expect(remoteMessages).toContainEqual(
        expect.objectContaining({ type: "prompt", text: "A 到 B", lane: { epoch: 2, heads: {} } }),
      );
      expect(localMessages).toContainEqual({
        type: "cancel",
        lane: { botId: who.botId, groupId: who.groupId },
        epoch: 2,
      });
      expect(localMessages).toContainEqual(
        expect.objectContaining({ type: "prompt", text: "B 到 A", lane: { epoch: 2, heads: {} } }),
      );
      expect(await runComputers(who.groupId)).toEqual([who.local.computerId, who.remote.computerId]);
      expect(await runComputers(peer.group.id)).toEqual([who.remote.computerId, who.local.computerId]);
    } finally {
      spy.mockRestore();
      release();
      await blocker;
      await Promise.allSettled([left, right]);
    }
  });

  it("删除 Bot 会删除它的单聊群与三张道表，持有者收到下一代 cancel", async () => {
    const who = await owner();
    const local = await online(who.local);
    await post(who.client, who.groupId, "待删除的单聊");
    const first = await prompt(local, "待删除的单聊");
    await seedRecords(who, first);
    expect(await recordCounts(who.botId, who.groupId)).toEqual({ leases: 1, streams: 2, entries: 2 });

    expect((await who.client.delete(`/api/bots/${who.botId}`)).status).toBe(204);
    await laneCancel(local, who.botId, who.groupId, first.lane.epoch + 1);
    expect(await recordCounts(who.botId, who.groupId)).toEqual({ leases: 0, streams: 0, entries: 0 });
    const groups = await database.sql<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM groups WHERE id = ${who.groupId}`;
    expect(groups[0]?.count).toBe(0);
  });

  it("删除多 Bot 群里的 Bot 只清它的道记录，群和其他 Bot 的道仍保留", async () => {
    const who = await owner();
    const peer = await bot(who.client, "队友");
    const response = await who.client.post("/api/groups", { title: "工作群", botIds: [who.botId, peer.bot.id] });
    expect(response.status).toBe(201);
    const group = CreateGroupResponse.parse(await response.json()).group;
    const local = await online(who.local);
    await post(who.client, group.id, "@小运 这条会删");
    const first = await prompt(local, "@小运 这条会删");
    await seedRecords(who, first);
    await finish(local, first);
    await post(who.client, group.id, "@队友 这条保留");
    const second = await prompt(local, "@队友 这条保留");
    await seedRecords(who, second);

    expect((await who.client.delete(`/api/bots/${who.botId}`)).status).toBe(204);
    await laneCancel(local, who.botId, group.id, first.lane.epoch + 1);
    expect(await recordCounts(who.botId, group.id)).toEqual({ leases: 0, streams: 0, entries: 0 });
    expect(await recordCounts(peer.bot.id, group.id)).toEqual({ leases: 1, streams: 2, entries: 2 });
    const groups = await database.sql<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM groups WHERE id = ${group.id}`;
    expect(groups[0]?.count).toBe(1);
  });
});
