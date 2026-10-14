import { CreateBotResponse, MessageListResponse } from "@baize/shared";
import { afterAll, beforeAll, expect, it } from "vitest";
import { helloAgent } from "./helpers/agent.js";
import { startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { makeComputer, makeUser, PASSWORD, waitFor } from "./helpers/fixtures.js";
import { gatedDb } from "./helpers/gated-db.js";

let database: TestDb;
let gate: ReturnType<typeof gatedDb>;
let server: TestServer;

beforeAll(async () => {
  database = await createTestDb();
  gate = gatedDb(database.sql);
  server = await startTestServer(gate.db);
});

afterAll(async () => {
  await server.close();
  await database.close();
});

it("一台电脑两条 open 道：无 runId 无群号的错误不落群，指定群号只落该群，唯一 run 才兜底", async () => {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const first = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "第一道" })).json());
  const second = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "第二道" })).json());
  const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);
  try {
    expect((await client.post(`/api/groups/${first.group.id}/messages`, { text: "第一道开工" })).status).toBe(201);
    const one = await agent.expect("prompt");
    expect((await client.post(`/api/groups/${second.group.id}/messages`, { text: "第二道开工" })).status).toBe(201);
    const two = await agent.expect("prompt");
    const [open] = await database.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM runs WHERE computer_id = ${computer.computerId} AND ended_at IS NULL`;
    expect(open?.n).toBe(2);
    agent.send({ type: "agent_error", code: "runner_failed", detail: "归属不明的错误" });
    agent.send({ type: "agent_error", code: "runner_failed", detail: "第一道的错误", groupId: first.group.id });
    agent.send({
      type: "run_done",
      runId: two.runId,
      botId: two.botId,
      groupId: two.groupId,
      steps: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
    await agent.ack(two.runId);
    const errors = async (groupId: string) =>
      MessageListResponse.parse(await (await client.get(`/api/groups/${groupId}/messages`)).json()).messages.flatMap(
        (message) => (message.body.kind === "system" && message.body.tone === "error" ? [message.body.text] : []),
      );
    expect(await errors(first.group.id)).toEqual(["电脑那边没干成这件事，跑活的进程出错了。原话是：第一道的错误"]);
    expect(await errors(second.group.id)).toEqual([]);
    agent.send({ type: "agent_error", code: "runner_failed", detail: "唯一道的错误" });
    agent.send({
      type: "run_done",
      runId: one.runId,
      botId: one.botId,
      groupId: one.groupId,
      steps: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
    await agent.ack(one.runId);
    expect(await errors(first.group.id)).toEqual([
      "电脑那边没干成这件事，跑活的进程出错了。原话是：第一道的错误",
      "电脑那边没干成这件事，跑活的进程出错了。原话是：唯一道的错误",
    ]);
  } finally {
    agent.close();
    await agent.closed();
  }
});

it("消息已查到群、插入前删号提交：回 404 没有这个对象，会话失效且不留消息", async () => {
  const user = await makeUser(database.db);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "插入交错" })).json());
  const members = gate.arm(/^select .* from "group_members" inner join "bots"/, "after", created.group.id);
  const posting = client.post(`/api/groups/${created.group.id}/messages`, { text: "删号先提交" });
  try {
    await members.reached;
    expect((await client.request("DELETE", "/api/me", { email: user.email })).status).toBe(204);
    members.release();
    const posted = await posting;
    expect(posted.status, await posted.clone().text()).toBe(404);
    expect(await posted.json()).toEqual({ error: "没有这个对象" });
    expect((await client.get("/api/me")).status).toBe(401);
    const [left] = await database.sql<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM messages WHERE group_id = ${created.group.id}`;
    expect(left?.n).toBe(0);
  } finally {
    members.release();
    await posting;
  }
});

it.each(["停机", "启动"] as const)("%s批量休眠先等删号 owner 锁，尚未持有电脑行", async (phase) => {
  const db = await createTestDb();
  const gated = gatedDb(db.sql);
  const live = await startTestServer(gated.db);
  const user = await makeUser(db.db);
  const computer = await makeComputer(db.db, user.id);
  const client = live.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const { agent } = await helloAgent(live.server.port, computer.computerId, computer.token);
  await waitFor(async () => {
    const rows = await db.sql`SELECT 1 FROM computers WHERE id = ${computer.computerId} AND down_applied = down_seq`;
    return rows.length === 1;
  }, "握手下行确认提交");
  const owner = gated.arm(/^SELECT pg_advisory_xact_lock\(/, "after", user.id);
  const deleting = client.request("DELETE", "/api/me", { email: user.email });
  let batch: ReturnType<typeof gated.arm> | undefined;
  let operation: Promise<unknown> | undefined;
  let next: TestServer | undefined;
  try {
    await owner.reached;
    batch = gated.arm(/^update "computers" set "status"/, "before");
    let rowWrite = false;
    void batch.reached.then(() => (rowWrite = true));
    operation = phase === "停机" ? live.close() : startTestServer(gated.db).then((started) => (next = started));
    await waitFor(async () => {
      if (rowWrite) return true;
      const waiting = await db.sql`
        SELECT 1 FROM pg_stat_activity a JOIN pg_locks l ON l.pid = a.pid
        WHERE a.datname = ${db.databaseName} AND a.wait_event_type = 'Lock'
          AND a.query LIKE 'SELECT pg_advisory_xact_lock_shared(%'
          AND NOT l.granted AND l.locktype = 'advisory'
          AND l.classid = 1652191095::oid AND l.objid = hashtext(${user.id})::oid`;
      return waiting.length > 0;
    }, "批量写到达电脑 UPDATE 或等待 owner 共享锁");
    expect(rowWrite, "删号持有 owner 排他锁时批量休眠不能先持有电脑行").toBe(false);
    const held = await db.sql`
      SELECT l.mode FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE a.datname = ${db.databaseName} AND a.wait_event_type = 'Lock'
        AND a.query LIKE 'SELECT pg_advisory_xact_lock_shared(%'
        AND l.relation = 'computers'::regclass AND l.mode IN ('RowShareLock', 'RowExclusiveLock')`;
    expect(held, "owner 锁等待者不能提前锁电脑行").toHaveLength(0);
    owner.release();
    expect((await deleting).status).toBe(204);
    batch.release();
    await operation;
    const rows = await db.sql`SELECT 1 FROM computers WHERE owner_id = ${user.id}`;
    expect(rows).toHaveLength(0);
  } finally {
    owner.release();
    batch?.release();
    await Promise.allSettled([deleting, operation]);
    if (phase === "启动") await live.close();
    await next?.close();
    agent.close();
    await agent.closed();
    await db.close();
  }
});
