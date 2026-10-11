import {
  CreateBotResponse,
  MessageId,
  MessageListResponse,
  PokerEvent,
  PokerHandId,
  PokerTableResponse,
  type BotId,
  type ControlToAgent,
  type GroupId,
  type PokerTableView,
} from "@baize/shared";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { newHand, replay, type HandState } from "../src/poker/engine.js";
import { viewFor } from "../src/poker/view.js";
import { startServer, type RunningServer } from "../src/server.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { ApiClient, TEST_CREDENTIALS_KEY } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { makeComputer, makeUser, PASSWORD, type TestComputer } from "./helpers/fixtures.js";
import { connectPush, type PushClient } from "./helpers/ws.js";

type Prompt = Extract<ControlToAgent, { type: "prompt" }>;
type Fixture = {
  ownerId: string;
  groupId: GroupId;
  hostId: BotId;
  client: ApiClient;
  computer: TestComputer;
  agent: AgentClient | null;
  push: PushClient;
  handId: PokerHandId;
  state: HandState;
};
let database: TestDb;
let server: RunningServer;
let table: Fixture | null;
let plainOwnerId: string | null;

beforeAll(async () => {
  database = await createTestDb();
});
beforeEach(async () => {
  table = null;
  plainOwnerId = null;
  server = await startServer({
    db: database.db,
    port: 0,
    credentialsKey: TEST_CREDENTIALS_KEY,
    toolSecretKey: "a".repeat(64),
    poker: { intervalMs: 86_400_000 },
  });
});
afterEach(async () => {
  table?.agent?.close();
  table?.push.close();
  await server.close();
  if (table) await database.sql`DELETE FROM users WHERE id = ${table.ownerId}`;
  if (plainOwnerId) await database.sql`DELETE FROM users WHERE id = ${plainOwnerId}`;
});
afterAll(async () => {
  await database.close();
});

async function fixture(button: 1 | 2 = 1, online = true): Promise<Fixture> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = new ApiClient(server.port);
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const created = await client.post("/api/poker/tables", { requestId: randomUUID() });
  expect(created.status).toBe(201);
  const view = PokerTableResponse.parse(await created.json()).table;
  const agent = online ? (await helloAgent(server.port, computer.computerId, computer.token)).agent : null;
  const push = await connectPush(server.port, client.cookie ?? "");
  const handId = PokerHandId.parse(randomUUID());
  const sessionId = randomUUID();
  const seats = view.seats.map((seat) => ({ seat: seat.seat, botId: seat.botId, stack: seat.stack }));
  const state = newHand(
    "问老白夹具私有种子",
    seats.map((seat) => ({ id: String(seat.seat), stack: seat.stack })),
    String(button),
    { small: 10, big: 20 },
  );
  await database.sql.begin(async (sql) => {
    await sql`INSERT INTO poker_sessions (id, group_id) VALUES (${sessionId}, ${view.groupId})`;
    await sql`INSERT INTO poker_hands (id, group_id, session_id, number, seed, seats_start, button_seat, blinds, created_at) VALUES (${handId}, ${view.groupId}, ${sessionId}, 1, ${state.seed}, ${JSON.stringify(seats)}::jsonb, ${button}, ${JSON.stringify(state.blinds)}::jsonb, now())`;
    for (const [seq, event] of state.events.entries())
      await sql`INSERT INTO poker_events (hand_id, seq, event, created_at) VALUES (${handId}, ${seq}, ${JSON.stringify(event)}::jsonb, now())`;
    await sql`UPDATE poker_tables SET status = 'in_hand', hand_count = 1, button_seat = ${button} WHERE group_id = ${view.groupId}`;
  });
  table = {
    ownerId: user.id,
    groupId: view.groupId,
    hostId: view.host.botId,
    client,
    computer,
    agent,
    push,
    handId,
    state,
  };
  return table;
}
async function ask(f: Fixture, seq = f.state.events.length): Promise<PokerTableView> {
  const response = await f.client.post(`/api/poker/hands/${f.handId}/hint`, { seq });
  expect(response.status).toBe(200);
  return PokerTableResponse.parse(await response.json()).table;
}
async function read(f: Fixture): Promise<PokerTableView> {
  const response = await f.client.get(`/api/poker/tables/${f.groupId}`);
  expect(response.status).toBe(200);
  return PokerTableResponse.parse(await response.json()).table;
}
async function hintPush(f: Fixture, status: "waiting" | "done" | "failed"): Promise<PokerTableView> {
  for (;;) {
    const push = await f.push.next();
    if (push.type === "poker_table_updated" && push.table.hint?.status === status) return push.table;
  }
}
function answer(f: Fixture, prompt: Prompt, text = "私密建议：先跟注，保留后续加注空间", done = true): MessageId {
  const messageId = MessageId.parse(randomUUID());
  f.agent!.send({
    type: "bot_text",
    runId: prompt.runId,
    botId: prompt.botId,
    groupId: prompt.groupId,
    messageId,
    delta: text,
    done,
  });
  return messageId;
}
async function finish(f: Fixture, prompt: Prompt, entered = true): Promise<void> {
  f.agent!.send({
    type: "run_done",
    runId: prompt.runId,
    botId: prompt.botId,
    groupId: prompt.groupId,
    steps: 1,
    inputTokens: 1,
    outputTokens: 1,
    prompt: entered ? "entered" : "dropped",
  });
  await f.agent!.ack(prompt.runId);
}
async function stored(f: Fixture): Promise<HandState> {
  const events = await database.sql<
    { event: unknown }[]
  >`SELECT event FROM poker_events WHERE hand_id = ${f.handId} ORDER BY seq`;
  return replay(
    f.state.seed,
    f.state.seats.map((seat) => ({ id: seat.id, stack: 2000 })),
    f.state.button,
    f.state.blinds,
    events.map((row) => PokerEvent.parse(row.event)),
  );
}
async function hintRows(f: Fixture) {
  return database.sql<
    { run_id: string; message_id: string | null }[]
  >`SELECT run_id, message_id FROM poker_hints WHERE hand_id = ${f.handId}`;
}

it("问老白的 prompt 里有你的底牌和合法动作，没有别人的底牌和种子", async () => {
  const f = await fixture();
  const waiting = await ask(f);
  expect(waiting.hint).toEqual({ seq: f.state.events.length, status: "waiting", messageId: null });
  const prompt = await f.agent!.expect("prompt");
  expect(prompt.botId).toBe(f.hostId);
  expect(prompt.table?.role).toBe("advisor");
  expect(prompt.purpose).toBe("plan");
  expect(prompt.table?.view).toEqual(viewFor(f.state, "4"));
  expect(prompt.table?.view?.legal.kind).toBe("your_turn");
  expect(prompt.context).toEqual([]);
  expect(prompt.members).toEqual([]);
  expect(prompt.task).toBeNull();
  const json = JSON.stringify(prompt);
  expect(json).not.toMatch(/seed|deck/);
  expect(json).not.toContain(f.state.seed);
  for (const seat of f.state.seats)
    for (const card of seat.hole) expect(json.includes(`"${card}"`)).toBe(seat.id === "4");
  const [run] = await database.sql<{ visible_to: unknown }[]>`SELECT visible_to FROM runs WHERE id = ${prompt.runId}`;
  expect(run?.visible_to).toEqual([{ kind: "bot", botId: f.hostId }, { kind: "user" }]);
});

it("老白的回答只推给用户，牌友的下一次 prompt 里看不到它", async () => {
  const f = await fixture();
  await ask(f);
  const prompt = await f.agent!.expect("prompt");
  const secret = "私密建议：先跟注，保留后续加注空间";
  const messageId = answer(f, prompt, secret);
  let receivedDelta = false;
  for (;;) {
    const push = await f.push.next();
    if (push.type === "message_delta" && push.messageId === messageId) {
      expect(push.visibleTo).toEqual([{ kind: "user" }]);
      expect(push.delta).toBe(secret);
      receivedDelta = true;
    }
    if (push.type === "poker_table_updated" && push.table.hint?.status === "done") {
      expect(push.table.hint.messageId).toBe(messageId);
      break;
    }
  }
  expect(receivedDelta).toBe(true);
  const [storedMessage] = await database.sql<
    { visible_to: unknown }[]
  >`SELECT visible_to FROM messages WHERE id = ${messageId}`;
  expect(storedMessage?.visible_to).toEqual([{ kind: "user" }]);
  await finish(f, prompt);
  const history = MessageListResponse.parse(await (await f.client.get(`/api/groups/${f.groupId}/messages`)).json());
  expect(history.messages.some((message) => message.id === messageId)).toBe(true);
  expect(
    (await f.client.post(`/api/poker/hands/${f.handId}/act`, { seq: f.state.events.length, action: { kind: "call" } }))
      .status,
  ).toBe(200);
  const next = await f.agent!.expect("prompt");
  expect(next.table?.role).toBe("player");
  expect(JSON.stringify(next)).not.toContain(secret);
  expect(next.context).toEqual([]);
  expect((await read(f)).hint).toBeNull();
});

it("同一个决策点点两次只派一次活，第二次返回同一条", async () => {
  const f = await fixture();
  const views = await Promise.all(Array.from({ length: 6 }, () => ask(f)));
  expect(views.every((view) => JSON.stringify(view.hint) === JSON.stringify(views[0]?.hint))).toBe(true);
  const prompt = await f.agent!.expect("prompt");
  expect(await hintRows(f)).toEqual([{ run_id: prompt.runId, message_id: null }]);
  const messageId = answer(f, prompt);
  await finish(f, prompt);
  const again = await ask(f);
  expect(again.hint).toEqual({ seq: f.state.events.length, status: "done", messageId });
  const [count] = await database.sql<
    { n: number }[]
  >`SELECT count(*)::int AS n FROM runs WHERE group_id = ${f.groupId} AND table_role = 'advisor'`;
  expect(count?.n).toBe(1);
  expect(f.agent!.received().filter((message) => message.type === "prompt")).toEqual([]);
});

it("不是你的回合问老白回 409", async () => {
  const f = await fixture(2);
  expect((await f.client.post(`/api/poker/hands/${f.handId}/hint`, { seq: f.state.events.length })).status).toBe(409);
  expect(await hintRows(f)).toEqual([]);
});

it("老白回答完后引擎状态没变", async () => {
  const f = await fixture();
  const before = await stored(f);
  const [handBefore] = await database.sql`SELECT * FROM poker_hands WHERE id = ${f.handId}`;
  await ask(f);
  const prompt = await f.agent!.expect("prompt");
  answer(f, prompt);
  await finish(f, prompt);
  expect(await stored(f)).toEqual(before);
  const [handAfter] = await database.sql`SELECT * FROM poker_hands WHERE id = ${f.handId}`;
  expect(handAfter).toEqual(handBefore);
  const done = await read(f);
  expect(done.hint?.status).toBe("done");
  expect(done.hand?.view).toEqual(viewFor(before, "4"));
});

it("老白运行失败后可以重试", async () => {
  const f = await fixture();
  const waiting = await ask(f);
  const old = await f.agent!.expect("prompt");
  answer(f, old, "已经输出一半的建议", false);
  f.agent!.send({ type: "agent_error", code: "model_failed", runId: old.runId, detail: "测试上游失败" });
  const failed = await hintPush(f, "failed");
  expect(failed.version).toBeGreaterThan(waiting.version);
  expect((await read(f)).hint?.status).toBe("failed");
  expect((await ask(f)).hint).toEqual({ seq: f.state.events.length, status: "waiting", messageId: null });
  const retry = await f.agent!.expect("prompt");
  expect(retry.runId).not.toBe(old.runId);
  answer(f, old, "旧 run 晚到的建议");
  const messageId = answer(f, retry);
  await finish(f, retry);
  expect(await hintRows(f)).toEqual([{ run_id: retry.runId, message_id: messageId }]);
  expect((await read(f)).hint).toEqual({ seq: f.state.events.length, status: "done", messageId });
});

it("电脑离线时提示失败，上线后同一决策点可以重试", async () => {
  const f = await fixture(1, false);
  expect((await ask(f)).hint).toEqual({ seq: f.state.events.length, status: "failed", messageId: null });
  expect((await read(f)).hint?.status).toBe("failed");
  const { agent } = await helloAgent(server.port, f.computer.computerId, f.computer.token);
  f.agent = agent;
  expect((await ask(f)).hint?.status).toBe("waiting");
  expect((await agent.expect("prompt")).table?.role).toBe("advisor");
});

it("老白没有回答就收尾时提示失败，可以重试", async () => {
  const f = await fixture();
  await ask(f);
  const prompt = await f.agent!.expect("prompt");
  await finish(f, prompt);
  expect((await hintPush(f, "failed")).hint?.messageId).toBeNull();
  expect((await ask(f)).hint?.status).toBe("waiting");
});

it("流式回答在 run_done 收成定稿后回填 message_id，版本递增", async () => {
  const f = await fixture();
  const waiting = await ask(f);
  const prompt = await f.agent!.expect("prompt");
  const messageId = answer(f, prompt, "还在输出的建议", false);
  await finish(f, prompt);
  const done = await hintPush(f, "done");
  expect(done.version).toBeGreaterThan(waiting.version);
  expect(done.hint?.messageId).toBe(messageId);
  expect((await read(f)).hint).toEqual(done.hint);
});

it("代理重连对账收掉老白的 run 后提示失败，可以重试", async () => {
  const f = await fixture();
  await ask(f);
  await f.agent!.expect("prompt");
  f.agent!.close();
  await f.agent!.closed();
  f.agent = (await helloAgent(server.port, f.computer.computerId, f.computer.token)).agent;
  expect((await hintPush(f, "failed")).hint?.status).toBe("failed");
  expect((await ask(f)).hint?.status).toBe("waiting");
});

it("提示拒绝过期 seq、坏参数和别人手牌，不留下 hint 或 advisor run", async () => {
  const f = await fixture();
  const path = `/api/poker/hands/${f.handId}/hint`;
  expect((await f.client.post(path, { seq: 0 })).status).toBe(409);
  for (const body of [{}, { seq: -1 }, { seq: 1.5 }, { seq: "2" }, { seq: 2, extra: true }])
    expect((await f.client.post(path, body)).status).toBe(400);
  const other = await makeUser(database.db);
  const client = new ApiClient(server.port);
  expect((await client.login(other.email, PASSWORD)).status).toBe(200);
  expect((await client.post(path, { seq: 2 })).status).toBe(404);
  expect((await f.client.post("/api/poker/hands/不存在/hint", { seq: 2 })).status).toBe(404);
  expect((await new ApiClient(server.port).post(path, { seq: 2 })).status).toBe(401);
  expect(await hintRows(f)).toEqual([]);
  const [count] = await database.sql<
    { n: number }[]
  >`SELECT count(*)::int AS n FROM runs WHERE group_id = ${f.groupId} AND table_role = 'advisor'`;
  expect(count?.n).toBe(0);
});

it("旧决策点的老白晚到回答不会覆盖当前回合的提示", async () => {
  const f = await fixture();
  await ask(f);
  const old = await f.agent!.expect("prompt");
  expect(
    (await f.client.post(`/api/poker/hands/${f.handId}/act`, { seq: f.state.events.length, action: { kind: "call" } }))
      .status,
  ).toBe(200);
  expect((await f.agent!.expect("prompt")).table?.role).toBe("player");
  answer(f, old);
  await finish(f, old);
  expect((await read(f)).hint).toBeNull();
});

it("普通单 Bot 群的对话照常，推送里没有 poker_table_updated", async () => {
  const user = await makeUser(database.db);
  plainOwnerId = user.id;
  const computer = await makeComputer(database.db, user.id);
  const client = new ApiClient(server.port);
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小服" })).json());
  const { agent } = await helloAgent(server.port, computer.computerId, computer.token);
  const push = await connectPush(server.port, client.cookie ?? "");
  const previousDebug = database.sql.options.debug;
  const hintQueries: string[] = [];
  database.sql.options.debug = (_connection, query) => {
    if (query.includes('from "poker_hints"')) hintQueries.push(query);
  };
  try {
    expect((await client.post(`/api/groups/${created.group.id}/messages`, { text: "帮我安排明天" })).status).toBe(201);
    const prompt = await agent.expect("prompt");
    expect(prompt.table).toBeNull();
    expect(prompt.botId).toBe(created.bot.id);
    const messageId = MessageId.parse(randomUUID());
    agent.send({
      type: "bot_text",
      runId: prompt.runId,
      botId: prompt.botId,
      groupId: prompt.groupId,
      messageId,
      delta: "明天先处理报告",
      done: false,
    });
    agent.send({
      type: "bot_text",
      runId: prompt.runId,
      botId: prompt.botId,
      groupId: prompt.groupId,
      messageId,
      delta: "，再安排会议",
      done: true,
    });
    agent.send({
      type: "run_done",
      runId: prompt.runId,
      botId: prompt.botId,
      groupId: prompt.groupId,
      steps: 1,
      inputTokens: 1,
      outputTokens: 1,
      prompt: "entered",
    });
    await agent.ack(prompt.runId);
    // 两条 bot_text 加一次 run_done，各只多查一条 run_id，未命中不再查牌桌或手牌。
    expect(hintQueries).toHaveLength(3);
    for (const query of hintQueries) {
      expect(query).toContain('"poker_hints"."run_id" = $1');
      expect(query).not.toContain("join");
    }
    // 同一连接上收尾费用卡是哨兵，之前的文字和提示推送都已到达。
    const received = [];
    for (;;) {
      const event = await push.next();
      received.push(event);
      expect(event.type).not.toBe("poker_table_updated");
      if (event.type === "message" && event.message.body.kind === "cost") break;
    }
    expect(received.filter((event) => event.type === "message_delta").map((event) => event.delta)).toEqual([
      "明天先处理报告",
      "，再安排会议",
    ]);
    const history = MessageListResponse.parse(
      await (await client.get(`/api/groups/${created.group.id}/messages`)).json(),
    );
    expect(history.messages.find((message) => message.id === messageId)).toMatchObject({
      visibleTo: null,
      body: { kind: "bot", text: "明天先处理报告，再安排会议", streaming: false },
    });
  } finally {
    database.sql.options.debug = previousDebug;
    agent.close();
    push.close();
  }
});
