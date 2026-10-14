import {
  BotId,
  CreateGroupResponse,
  MessageListResponse,
  GroupId,
  PokerHandId,
  PokerEvent,
  PokerSessionId,
  PokerTableResponse,
  RunId,
  UserId,
  type ControlToAgent,
  type PokerAction,
  type PokerSeatNo,
  type PokerTableView,
} from "@baize/shared";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { apply, newHand, replay, type HandState } from "../src/poker/engine.js";
import type { AfterCommitStep } from "../src/poker/converge.js";
import { SWEEP_FAILURE_LIMIT } from "../src/poker/sweeper.js";
import { ensureComputer } from "../src/repo/computers.js";
import { ensurePokerPresets } from "../src/repo/poker-presets.js";
import { startServer, type RunningServer, type StartOptions } from "../src/server.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { ApiClient, TEST_CREDENTIALS_KEY } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { makeComputer, makeUser, PASSWORD, type TestComputer } from "./helpers/fixtures.js";
import { connectPush, type PushClient } from "./helpers/ws.js";

type Prompt = Extract<ControlToAgent, { type: "prompt" }>;
let database: TestDb;
let server: RunningServer;
let now: Date;
let table: Fixture;

beforeAll(async () => {
  database = await createTestDb();
});
beforeEach(async () => {
  now = new Date();
  server = await startServer({
    db: database.db,
    port: 0,
    credentialsKey: TEST_CREDENTIALS_KEY,
    toolSecretKey: "a".repeat(64),
    poker: { intervalMs: 20, now: () => now, turnTimeoutMs: 60_000 },
  });
});
/** 换一套牌桌启动参数重起控制面，故障和时钟都从这里注入。要在 fixture() 之前调用，fixture 连的是新端口。 */
async function restartWith(poker: NonNullable<StartOptions["poker"]>): Promise<void> {
  await server.close();
  server = await startServer({
    db: database.db,
    port: 0,
    credentialsKey: TEST_CREDENTIALS_KEY,
    toolSecretKey: "a".repeat(64),
    poker,
  });
}
/** 日志里第一条事件换成解析不了的样子，载入这手必然抛错：从库这一侧做出一手推进不下去的牌。 */
async function corrupt(handId: PokerHandId): Promise<void> {
  await database.sql`UPDATE poker_events SET event = ${JSON.stringify({ kind: "种子不得出现在日志" })}::jsonb WHERE hand_id = ${handId} AND seq = 0`;
}
afterEach(async () => {
  vi.restoreAllMocks();
  table?.agent.close();
  table?.push.close();
  await server.close();
  if (table) await database.sql`DELETE FROM users WHERE id = ${table.ownerId}`;
});
afterAll(async () => {
  await database.close();
});

type Fixture = {
  ownerId: string;
  groupId: GroupId;
  client: ApiClient;
  computer: TestComputer;
  agent: AgentClient;
  push: PushClient;
  botIds: BotId[];
};
async function fixture(): Promise<Fixture> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  await ensurePokerPresets(database.db, user.id);
  const client = new ApiClient(server.port);
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const bots = await database.sql<
    { id: string; preset: string }[]
  >`SELECT id, preset FROM bots WHERE owner_id = ${user.id} AND preset IS NOT NULL`;
  const botIds = ["leopard", "old_k", "jasmine", "laobai"].map((preset) =>
    BotId.parse(bots.find((bot) => bot.preset === preset)?.id),
  );
  const response = await client.post("/api/groups", { title: "测试德州", botIds });
  expect(response.status).toBe(201);
  const groupId = CreateGroupResponse.parse(await response.json()).group.id;
  await database.sql`UPDATE groups SET chief_bot_id = ${botIds[3]!} WHERE id = ${groupId}`;
  const seats = [1, 2, 3, 4].map((seat) => ({ seat, botId: seat === 4 ? null : botIds[seat - 1], stack: 2000 }));
  await database.sql`INSERT INTO poker_tables (group_id, owner_id, request_id, seats, button_seat, small_blind, big_blind, starting_stack, created_at) VALUES (${groupId}, ${user.id}, ${randomUUID()}, ${JSON.stringify(seats)}::jsonb, 4, 10, 20, 2000, now())`;
  const { agent } = await helloAgent(server.port, computer.computerId, computer.token);
  const push = await connectPush(server.port, client.cookie ?? "");
  table = { ownerId: user.id, groupId, computer, client, botIds, agent, push };
  return table;
}
async function start(): Promise<PokerTableView> {
  const response = await table.client.post(`/api/poker/tables/${table.groupId}/hands`);
  expect(response.status).toBe(201);
  const raw: unknown = await response.json();
  expect(JSON.stringify(raw)).not.toMatch(/seed|deck/);
  return PokerTableResponse.parse(raw).table;
}
async function seeded(button: PokerSeatNo = 2, actions: PokerAction[] = [], stack = 2000): Promise<PokerHandId> {
  const handId = PokerHandId.parse(randomUUID());
  const sessionId = PokerSessionId.parse(randomUUID());
  const seats = [1, 2, 3, 4].map((seat) => ({ seat, botId: seat === 4 ? null : table.botIds[seat - 1], stack }));
  let state = newHand(
    "本单固定种子",
    seats.map((seat) => ({ id: String(seat.seat), stack })),
    String(button),
    { small: 10, big: 20 },
  );
  for (const action of actions) {
    if (state.phase.kind !== "betting") throw new Error("夹具已经结算");
    state = apply(state, state.phase.pending[0]!, action);
  }
  await database.sql.begin(async (sql) => {
    await sql`INSERT INTO poker_sessions (id, group_id) VALUES (${sessionId}, ${table.groupId})`;
    await sql`INSERT INTO poker_hands (id, group_id, session_id, number, seed, seats_start, button_seat, blinds, created_at) VALUES (${handId}, ${table.groupId}, ${sessionId}, 1, ${state.seed}, ${JSON.stringify(seats)}::jsonb, ${button}, ${JSON.stringify(state.blinds)}::jsonb, now())`;
    for (const [seq, event] of state.events.entries())
      await sql`INSERT INTO poker_events (hand_id, seq, event, created_at) VALUES (${handId}, ${seq}, ${JSON.stringify(event)}::jsonb, now())`;
    await sql`UPDATE poker_tables SET seats = ${JSON.stringify(seats)}::jsonb, status = 'in_hand', hand_count = 1, button_seat = ${button} WHERE group_id = ${table.groupId}`;
  });
  return handId;
}
async function stored(handId: string): Promise<HandState> {
  const [hand] = await database.sql<
    {
      seed: string;
      seats_start: { seat: number; stack: number }[];
      button_seat: number;
      blinds: { small: number; big: number };
    }[]
  >`SELECT * FROM poker_hands WHERE id = ${handId}`;
  if (!hand) throw new Error("没有测试手牌");
  const events = await database.sql<
    { event: HandState["events"][number] }[]
  >`SELECT event FROM poker_events WHERE hand_id = ${handId} ORDER BY seq`;
  return replay(
    hand.seed,
    hand.seats_start.map((seat) => ({ id: String(seat.seat), stack: seat.stack })),
    String(hand.button_seat),
    hand.blinds,
    events.map((row) => PokerEvent.parse(row.event)),
  );
}
function act(
  prompt: Prompt,
  action: PokerAction,
  extra: { runId?: ReturnType<typeof RunId.parse>; seq?: number; say?: string } = {},
): void {
  if (!prompt.table) throw new Error("不是牌桌 prompt");
  table.agent.send({
    type: "poker_act",
    runId: extra.runId ?? prompt.runId,
    callId: randomUUID(),
    handId: prompt.table.handId,
    seq: extra.seq ?? prompt.table.seq,
    action,
    ...(extra.say === undefined ? {} : { say: extra.say }),
  });
}
async function finish(prompt: Prompt): Promise<void> {
  table.agent.send({
    type: "run_done",
    runId: prompt.runId,
    botId: prompt.botId,
    groupId: prompt.groupId,
    steps: 1,
    inputTokens: 1,
    outputTokens: 1,
    prompt: "entered",
  });
  await table.agent.ack(prompt.runId);
}
async function barrier(prompt: Prompt): Promise<void> {
  const runId = RunId.parse(randomUUID());
  const messageId = randomUUID() as import("@baize/shared").MessageId;
  await database.sql`INSERT INTO runs (id, bot_id, group_id, computer_id, started_at) VALUES (${runId}, ${prompt.botId}, ${table.groupId}, ${table.computer.computerId}, now())`;
  table.agent.send({
    type: "bot_text",
    runId,
    botId: prompt.botId,
    groupId: table.groupId,
    messageId,
    delta: "确定落地的哨兵",
    done: true,
  });
  for (;;) {
    const push = await table.push.next();
    if (push.type === "message_delta" && push.messageId === messageId) return;
  }
}
async function expectRunClosedAck(agent: AgentClient, runId: RunId): Promise<void> {
  await vi.waitFor(() => {
    expect(agent.uplinkAcks().flatMap((ack) => ack.rejected)).toContainEqual({
      seq: expect.any(Number),
      code: "run_closed",
      runId,
    });
  });
}
async function tablePush(predicate: (view: PokerTableView) => boolean): Promise<PokerTableView> {
  for (;;) {
    const push = await table.push.next();
    if (push.type === "poker_table_updated" && predicate(push.table)) return push.table;
  }
}
async function advanceUser(view: PokerTableView, action: PokerAction): Promise<Response> {
  if (!view.hand) throw new Error("没有手牌");
  return table.client.post(`/api/poker/hands/${view.hand.id}/act`, { seq: view.hand.view.events.length, action });
}

it("开一手后用户的响应里找不到别的座位的牌和种子", async () => {
  await fixture();
  const view = await start();
  const state = await stored(view.hand!.id);
  const json = JSON.stringify(view);
  expect(json).not.toMatch(/seed|deck/);
  expect(json).not.toContain(state.seed);
  for (const seat of state.seats)
    for (const card of seat.hole) expect(json.includes(`"${card}"`)).toBe(seat.id === "4");
  expect(view.status).toBe("in_hand");
  expect(view.hand!.deadline).toBeNull();
  expect((await table.client.post(`/api/poker/tables/${table.groupId}/hands`)).status).toBe(409);
});
it("轮到牌友时给对应 Bot 派一次表桌活，prompt 里只有它自己的底牌且找不到种子", async () => {
  await fixture();
  const handId = await seeded();
  const prompt = await table.agent.expect("prompt");
  expect(prompt.botId).toBe(table.botIds[0]);
  expect(prompt.table!.role).toBe("player");
  expect(prompt.context).toEqual([]);
  expect(prompt.task).toBeNull();
  expect(prompt.members).toEqual([]);
  const state = await stored(handId);
  const json = JSON.stringify(prompt);
  expect(json).not.toContain(state.seed);
  expect(json).not.toMatch(/seed|deck/);
  for (const seat of state.seats)
    for (const card of seat.hole) expect(json.includes(`"${card}"`)).toBe(seat.id === "1");
  table.agent.send({ type: "heartbeat", at: new Date().toISOString() });
  await table.client.get("/api/bots");
  const [count] = await database.sql<
    { n: number }[]
  >`SELECT count(*)::int AS n FROM runs WHERE group_id = ${table.groupId} AND table_role = 'player'`;
  expect(count!.n).toBe(1);
});
it("牌友出牌后推进到下一位，用户的 WebSocket 收到 poker_table_updated 且版本递增", async () => {
  await fixture();
  await seeded();
  const prompt = await table.agent.expect("prompt");
  const before = await tablePush((view) => view.hand?.toAct === 1);
  act(prompt, { kind: "call" }, { say: "跟你玩一手" });
  expect((await table.agent.expect("poker_result")).result).toEqual({ ok: true });
  const next = await table.agent.expect("prompt");
  expect(next.botId).toBe(table.botIds[1]);
  const after = await tablePush((view) => view.hand?.toAct === 2);
  expect(after.version).toBeGreaterThan(before.version);
  const [say] = await database.sql<
    { body: { kind: string; text: string }; visible_to: unknown }[]
  >`SELECT body, visible_to FROM messages WHERE group_id = ${table.groupId} AND body ->> 'text' = '跟你玩一手'`;
  expect(say!.body.kind).toBe("bot");
  expect(say!.visible_to).toBeNull();
});
it("所有人弃牌只剩一人时不摊牌直接收池，桌子回 idle", async () => {
  await fixture();
  const handId = await seeded(2, [{ kind: "fold" }, { kind: "fold" }]);
  const p = await table.agent.expect("prompt");
  act(p, { kind: "fold" });
  expect((await table.agent.expect("poker_result")).result.ok).toBe(true);
  const view = await tablePush((candidate) => candidate.status === "idle");
  const state = await stored(handId);
  expect(state.phase.kind).toBe("complete");
  expect(state.events.some((event) => event.kind === "showdown")).toBe(false);
  expect(view.seats.reduce((sum, seat) => sum + seat.stack, 0)).toBe(8000);
});
it("摊牌结算后各座位筹码之和不变", async () => {
  await fixture();
  const handId = await seeded(1, [{ kind: "all_in" }], 40);
  for (let i = 0; i < 3; i++) {
    const p = await table.agent.expect("prompt");
    act(p, { kind: "all_in" });
    expect((await table.agent.expect("poker_result")).result.ok).toBe(true);
    await finish(p);
  }
  const view = await tablePush((candidate) => candidate.status === "idle");
  expect(view.seats.reduce((sum, seat) => sum + seat.stack, 0)).toBe(160);
  expect((await stored(handId)).events.filter((event) => event.kind === "showdown")).toHaveLength(4);
  const response = await table.client.get(`/api/poker/tables/${table.groupId}`);
  expect(response.status).toBe(200);
  const reloaded = PokerTableResponse.parse(await response.json()).table;
  expect(reloaded.hand?.id, "结算后刷新仍保留这一手").toBe(handId);
  expect(reloaded.hand?.view.street).toBe("complete");
  expect(reloaded.hand?.view.events.filter((event) => event.kind === "showdown")).toHaveLength(4);
  expect(reloaded.hand?.view.awards).toEqual(view.hand?.view.awards);
});
it("再来一手庄位轮转、破产座位补码", async () => {
  await fixture();
  await database.sql`UPDATE poker_tables SET hand_count=2, button_seat=1, seats=jsonb_set(seats,'{1,stack}','0') WHERE group_id=${table.groupId}`;
  const view = await start();
  const [hand] = await database.sql<
    { button_seat: number }[]
  >`SELECT button_seat FROM poker_hands WHERE id=${view.hand!.id}`;
  expect(hand!.button_seat).toBe(3);
  expect(view.hand!.number).toBe(3);
  const state = await stored(view.hand!.id);
  expect(
    state.seats.find((seat) => seat.id === "2")!.stack + state.seats.find((seat) => seat.id === "2")!.committed,
  ).toBe(2000);
  const rebuy =
    await database.sql`SELECT * FROM messages WHERE group_id=${table.groupId} AND body ->> 'text' LIKE '%补码%'`;
  expect(rebuy).toHaveLength(1);
});
it("牌友出非法动作得到失败结果和中文原因，手牌不变", async () => {
  await fixture();
  const id = await seeded();
  const p = await table.agent.expect("prompt");
  const before = await stored(id);
  act(p, { kind: "check" });
  const result = await table.agent.expect("poker_result");
  expect(result.result).toEqual({ ok: false, error: "有人下注了，不能过牌，要跟注或弃牌" });
  expect(await stored(id)).toEqual(before);
  const [hand] = await database.sql<{ turn_attempts: number }[]>`SELECT turn_attempts FROM poker_hands WHERE id=${id}`;
  expect(hand!.turn_attempts).toBe(1);
});
it("同一回合第三次非法动作按兜底处理", async () => {
  await fixture();
  const id = await seeded();
  const p = await table.agent.expect("prompt");
  for (let i = 0; i < 3; i++) {
    act(p, { kind: "check" });
    expect((await table.agent.expect("poker_result")).result.ok).toBe(false);
  }
  const next = await table.agent.expect("prompt");
  expect(next.botId).toBe(table.botIds[1]);
  const state = await stored(id);
  expect(state.events.filter((event) => event.kind === "action")).toEqual([
    { kind: "action", seatId: "1", action: { kind: "fold" }, put: 0 },
  ]);
  const [row] = await database.sql<{ turn_attempts: number }[]>`SELECT turn_attempts FROM poker_hands WHERE id=${id}`;
  expect(row!.turn_attempts).toBe(0);
});
it("牌友超时没出牌，扫描后自动过牌；不能过牌时弃牌", async () => {
  await fixture();
  const id = await seeded(1, [{ kind: "call" }, { kind: "call" }, { kind: "call" }]);
  await table.agent.expect("prompt");
  now = new Date(now.getTime() + 60_001);
  await tablePush((view) =>
    view.hand!.view.events.some(
      (event) => event.kind === "action" && event.seatId === "3" && event.action.kind === "check",
    ),
  );
  const p = await table.agent.expect("prompt");
  expect(p.botId).toBe(table.botIds[1]);
  act(p, { kind: "raise", amount: 40 });
  expect((await table.agent.expect("poker_result")).result.ok).toBe(true);
  await table.agent.expect("prompt");
  now = new Date(now.getTime() + 60_001);
  await tablePush((view) =>
    view.hand!.view.events.some(
      (event) => event.kind === "action" && event.seatId === "3" && event.action.kind === "fold",
    ),
  );
  expect(
    (await stored(id)).events
      .filter((event) => event.kind === "action" && event.seatId === "3")
      .map((event) => (event.kind === "action" ? event.action.kind : "")),
  ).toEqual(["check", "fold"]);
});
it("群里的播报把用户座位叫「你」，不写主人名", async () => {
  await fixture();
  const view = await start();
  expect((await advanceUser(view, { kind: "call" })).status).toBe(200);
  const [owner] = await database.sql<{ name: string }[]>`SELECT name FROM users WHERE id = ${table.ownerId}`;
  const history = JSON.stringify(
    MessageListResponse.parse(await (await table.client.get(`/api/groups/${table.groupId}/messages`)).json()),
  );
  expect(history, "用户的跟注播报成「你 跟注」").toMatch(/你 跟注/);
  expect(history, "播报里没有主人名").not.toContain(`${owner!.name} `);
});
it("用户加注不足最小额回 400 和中文原因", async () => {
  await fixture();
  const view = await start();
  const r = await advanceUser(view, { kind: "raise", amount: 21 });
  expect(r.status).toBe(400);
  expect(JSON.stringify(await r.json())).toMatch(/加注/);
});
it("过期 run 的 poker_act 得到失败回执、不落动作", async () => {
  await fixture();
  const id = await seeded();
  const p = await table.agent.expect("prompt");
  const before = await stored(id);
  const replacement = RunId.parse(randomUUID());
  await database.sql`INSERT INTO runs(id,bot_id,group_id,computer_id,started_at) VALUES(${replacement},${p.botId},${table.groupId},${table.computer.computerId},now())`;
  await database.sql`UPDATE poker_hands SET turn_run_id=${replacement} WHERE id=${id}`;
  act(p, { kind: "fold" });
  const result = await table.agent.expect("poker_result");
  expect(result.result.ok).toBe(false);
  expect(JSON.stringify(result.result)).toMatch(/[\u4e00-\u9fff]/);
  await barrier(p);
  expect(await stored(id)).toEqual(before);
});
it("seq 过期的牌友出牌得到失败回执、不增加拒绝次数", async () => {
  await fixture();
  const id = await seeded();
  const p = await table.agent.expect("prompt");
  const before = await stored(id);
  act(p, { kind: "call" }, { seq: 0 });
  expect((await table.agent.expect("poker_result")).result.ok).toBe(false);
  await barrier(p);
  expect(await stored(id)).toEqual(before);
  const [hand] = await database.sql<{ turn_attempts: number }[]>`SELECT turn_attempts FROM poker_hands WHERE id=${id}`;
  expect(hand!.turn_attempts).toBe(0);
});
it("seq 过期的用户出牌回 409", async () => {
  await fixture();
  const view = await start();
  const r = await table.client.post(`/api/poker/hands/${view.hand!.id}/act`, { seq: 0, action: { kind: "fold" } });
  expect(r.status).toBe(409);
});
it("不轮到用户时出牌回 409", async () => {
  await fixture();
  const id = await seeded();
  const r = await table.client.post(`/api/poker/hands/${id}/act`, { seq: 2, action: { kind: "fold" } });
  expect(r.status).toBe(409);
});
it("同一个 poker_act 重复上行只落一次", async () => {
  await fixture();
  const id = await seeded();
  const p = await table.agent.expect("prompt");
  const duplicate = {
    type: "poker_act",
    runId: p.runId,
    callId: "重复",
    handId: id,
    seq: p.table!.seq,
    action: { kind: "call" },
  } as const;
  table.agent.send(duplicate);
  table.agent.send(duplicate);
  const results: Extract<ControlToAgent, { type: "poker_result" }>[] = [];
  while (results.length < 2) {
    const message = await table.agent.next();
    if (message.type === "poker_result") results.push(message);
  }
  expect(results.map((message) => message.result)).toEqual([{ ok: true }, { ok: true }]);
  await barrier(p);
  expect((await stored(id)).events.filter((event) => event.kind === "action")).toHaveLength(1);
  expect(table.agent.received().filter((event) => event.type === "poker_result")).toHaveLength(0);
});
it("用户出牌和扫描器兜底同时到，只落一个动作", async () => {
  await fixture();
  const view = await start();
  now = new Date(now.getTime() + 120_000);
  const results = await Promise.all([advanceUser(view, { kind: "call" }), advanceUser(view, { kind: "call" })]);
  expect(results.map((r) => r.status).toSorted()).toEqual([200, 409]);
  const state = await stored(view.hand!.id);
  expect(state.events.filter((event) => event.kind === "action" && event.seatId === "4")).toHaveLength(1);
});
it("控制面重启后手牌从种子和日志恢复，轮到的人不变", async () => {
  await fixture();
  const view = await start();
  const state = await stored(view.hand!.id);
  await server.close();
  server = await startServer({
    db: database.db,
    port: 0,
    credentialsKey: TEST_CREDENTIALS_KEY,
    toolSecretKey: "a".repeat(64),
    poker: { intervalMs: 20 },
  });
  table.client = new ApiClient(server.port);
  expect(
    (
      await table.client.login(
        (await database.sql<{ email: string }[]>`SELECT email FROM users WHERE id=${table.ownerId}`)[0]!.email,
        PASSWORD,
      )
    ).status,
  ).toBe(200);
  const response = await advanceUser(view, { kind: "call" });
  expect(response.status).toBe(200);
  const next = PokerTableResponse.parse(await response.json()).table;
  expect(next.hand!.view.hole).toEqual(state.seats.find((seat) => seat.id === "4")!.hole);
  expect(next.hand!.toAct).toBe(1);
  expect(next.hand!.view.events.slice(0, 2)).toEqual(state.events);
});
it("代理重连后，轮到牌友但 run 已丢，重新派活", async () => {
  await fixture();
  const id = await seeded();
  const old = await table.agent.expect("prompt");
  table.agent.close();
  await table.agent.closed();
  table.agent = (await helloAgent(server.port, table.computer.computerId, table.computer.token, [])).agent;
  const next = await table.agent.expect("prompt");
  expect(next.runId).not.toBe(old.runId);
  expect(next.botId).toBe(old.botId);
  expect(next.table!.seq).toBe(old.table!.seq);
  expect((await stored(id)).events).toHaveLength(2);
});
it("向牌桌群发普通消息回 409", async () => {
  await fixture();
  const r = await table.client.post(`/api/groups/${table.groupId}/messages`, { text: "来打牌" });
  expect(r.status).toBe(409);
  expect(await r.json()).toEqual({ error: "牌桌里请用按钮出牌" });
});

it("牌友 run 已收尾却没出牌，扫描后立即兜底", async () => {
  await fixture();
  const id = await seeded();
  const p = await table.agent.expect("prompt");
  await finish(p);
  const next = await table.agent.expect("prompt");
  expect(next.botId).toBe(table.botIds[1]);
  expect((await stored(id)).events.filter((event) => event.kind === "action")).toEqual([
    { kind: "action", seatId: "1", action: { kind: "fold" }, put: 0 },
  ]);
});
it("同一牌友连续两个决策点清掉拒绝次数并派新 run", async () => {
  await fixture();
  const id = await seeded(1, [{ kind: "call" }, { kind: "fold" }, { kind: "fold" }]);
  const first = await table.agent.expect("prompt");
  expect(first.botId).toBe(table.botIds[2]);
  act(first, { kind: "raise", amount: 21 });
  expect((await table.agent.expect("poker_result")).result.ok).toBe(false);
  act(first, { kind: "check" });
  expect((await table.agent.expect("poker_result")).result.ok).toBe(true);
  await finish(first);
  const next = await table.agent.expect("prompt");
  expect(next.botId).toBe(first.botId);
  expect(next.runId).not.toBe(first.runId);
  expect(next.table!.seq).toBeGreaterThan(first.table!.seq);
  const [row] = await database.sql<
    { turn_attempts: number; turn_run_id: string }[]
  >`SELECT turn_attempts,turn_run_id FROM poker_hands WHERE id=${id}`;
  expect(row!.turn_attempts).toBe(0);
  expect(row!.turn_run_id).toBe(next.runId);
});
it("牌友出牌和到点扫描竞争只落一次动作", async () => {
  const errors = vi.spyOn(console, "error");
  await fixture();
  const id = await seeded();
  const p = await table.agent.expect("prompt");
  now = new Date(now.getTime() + 60_001);
  act(p, { kind: "call" });
  await tablePush((view) => view.hand!.view.events.some((event) => event.kind === "action" && event.seatId === "1"));
  await barrier(p);
  expect((await stored(id)).events.filter((event) => event.kind === "action" && event.seatId === "1")).toHaveLength(1);
  expect(errors.mock.calls.flat().join(" "), "出牌与扫描不能靠死锁重试才成功").not.toContain("40P01");
});
it("六条并发用户出牌只接受一条且不耗尽连接池", async () => {
  await fixture();
  const view = await start();
  const responses = await Promise.all(Array.from({ length: 6 }, () => advanceUser(view, { kind: "call" })));
  expect(responses.map((response) => response.status).toSorted()).toEqual([200, 409, 409, 409, 409, 409]);
});
it("用户回合保留过期的牌友记录也不触发兜底", async () => {
  await fixture();
  const view = await start();
  await database.sql`UPDATE poker_hands SET turn_seat=4, turn_deadline=now()-interval '1 minute', turn_attempts=3 WHERE id=${view.hand!.id}`;
  const r = await advanceUser(view, { kind: "call" });
  expect(r.status).toBe(200);
  expect(
    (await stored(view.hand!.id)).events.filter((event) => event.kind === "action" && event.seatId === "4"),
  ).toEqual([{ kind: "action", seatId: "4", action: { kind: "call" }, put: 20 }]);
});
it("重连仍带当前 activeRun 时不重复派活", async () => {
  await fixture();
  const id = await seeded();
  const p = await table.agent.expect("prompt");
  table.agent.close();
  await table.agent.closed();
  table.agent = (await helloAgent(server.port, table.computer.computerId, table.computer.token, [p.runId])).agent;
  await barrier(p);
  act(p, { kind: "call" });
  expect((await table.agent.expect("poker_result")).result.ok).toBe(true);
  await table.agent.expect("prompt");
  expect((await stored(id)).events.filter((event) => event.kind === "action")).toHaveLength(1);
  const [count] = await database.sql<
    { n: number }[]
  >`SELECT count(*)::int AS n FROM runs WHERE group_id=${table.groupId} AND bot_id=${p.botId} AND table_role='player'`;
  expect(count!.n).toBe(1);
});
it("别人的开手与用户出牌均回 404，坏请求回 400", async () => {
  await fixture();
  const other = await makeUser(database.db);
  const client = new ApiClient(server.port);
  await client.login(other.email, PASSWORD);
  expect((await client.post(`/api/poker/tables/${table.groupId}/hands`)).status).toBe(404);
  const view = await start();
  expect(
    (await client.post(`/api/poker/hands/${view.hand!.id}/act`, { seq: 2, action: { kind: "fold" } })).status,
  ).toBe(404);
  expect(
    (await table.client.post(`/api/poker/hands/${view.hand!.id}/act`, { seq: -1, action: { kind: "fold" } })).status,
  ).toBe(400);
});

it("开手落库失败时日志和响应也不泄露种子", async () => {
  await fixture();
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  await database.sql`ALTER TABLE poker_hands ADD CONSTRAINT p3_table_cp_seed_logging CHECK (false) NOT VALID`;
  try {
    const response = await table.client.post(`/api/poker/tables/${table.groupId}/hands`);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "服务端出错" });
    expect(JSON.stringify(logged.mock.calls)).not.toMatch(/[a-f0-9]{64}/);
    expect(String(logged.mock.calls[0]?.[0])).toContain("牌桌开手失败");
    const [row] = await database.sql<
      { status: string; hand_count: number }[]
    >`SELECT status,hand_count FROM poker_tables WHERE group_id=${table.groupId}`;
    expect(row).toEqual({ status: "idle", hand_count: 0 });
  } finally {
    await database.sql`ALTER TABLE poker_hands DROP CONSTRAINT p3_table_cp_seed_logging`;
    logged.mockRestore();
  }
});

it("第三次非法被兜底后同一 run 再出牌得到 run_closed 确认", async () => {
  await fixture();
  const id = await seeded();
  const p = await table.agent.expect("prompt");
  for (let attempt = 0; attempt < 3; attempt++) {
    act(p, { kind: "check" });
    expect((await table.agent.expect("poker_result")).result.ok).toBe(false);
  }
  await table.agent.expect("prompt");
  const before = await stored(id);
  act(p, { kind: "call" });
  await barrier(p);
  await expectRunClosedAck(table.agent, p.runId);
  expect(await stored(id)).toEqual(before);
});
it("兜底后新 run 正常出牌，旧 run 的晚到出牌得到 run_closed 确认", async () => {
  await fixture();
  const id = await seeded();
  const p = await table.agent.expect("prompt");
  now = new Date(now.getTime() + 60_001);
  const fresh = await table.agent.expect("prompt");
  expect(fresh.runId).not.toBe(p.runId);
  act(fresh, { kind: "call" });
  expect((await table.agent.expect("poker_result")).result).toEqual({ ok: true });
  const before = await stored(id);
  act(p, { kind: "call" });
  await barrier(p);
  await expectRunClosedAck(table.agent, p.runId);
  expect(await stored(id)).toEqual(before);
});
it("已收尾 run 仍对着当前 turn 时出牌得到 run_closed 确认", async () => {
  await restartWith({ intervalMs: 3_600_000, now: () => now, turnTimeoutMs: 60_000 });
  await fixture();
  expect((await advanceUser(await start(), { kind: "call" })).status).toBe(200);
  const p = await table.agent.expect("prompt");
  const handId = p.table!.handId;
  await database.sql`UPDATE runs SET ended_at=now(),context_confirmed_at=NULL WHERE id=${p.runId}`;
  const [turn] = await database.sql<{ turn_run_id: string }[]>`SELECT turn_run_id FROM poker_hands WHERE id=${handId}`;
  expect(turn!.turn_run_id).toBe(p.runId);
  const before = await stored(handId);
  act(p, { kind: "call" });
  await barrier(p);
  await expectRunClosedAck(table.agent, p.runId);
  expect(await stored(handId)).toEqual(before);
});
it("run 收尾却没确认，扫描器恰好给同一 Bot 的同一决策点重派一次新 run", async () => {
  await fixture();
  const id = await seeded();
  const p = await table.agent.expect("prompt");
  await database.sql`UPDATE runs SET ended_at=now(),context_confirmed_at=NULL WHERE id=${p.runId}`;
  const redispatch = await table.agent.expect("prompt");
  expect(redispatch.runId).not.toBe(p.runId);
  expect(redispatch.botId).toBe(p.botId);
  expect(redispatch.groupId).toBe(p.groupId);
  expect(redispatch.table!.role).toBe("player");
  expect(redispatch.table!.handId).toBe(p.table!.handId);
  expect(redispatch.table!.seq).toBe(p.table!.seq);
  const [hand] = await database.sql<
    { dispatch_count: number; turn_run_id: string }[]
  >`SELECT dispatch_count, turn_run_id FROM poker_hands WHERE id=${id}`;
  expect(hand).toEqual({ dispatch_count: 2, turn_run_id: redispatch.runId });
  expect((await stored(id)).events.filter((event) => event.kind === "action")).toHaveLength(0);
});
it("不属于这台电脑、这个 Bot 或这个群的出牌静默丢弃", async () => {
  await fixture();
  const id = await seeded();
  const p = await table.agent.expect("prompt");
  const { computer: other } = await ensureComputer(database.db, UserId.parse(table.ownerId), "remote");
  const [solo] = await database.sql<
    { id: string }[]
  >`SELECT id FROM groups WHERE owner_id=${table.ownerId} AND id<>${table.groupId} LIMIT 1`;
  const invalids = [
    { bot: p.botId, group: table.groupId, computer: other.id, role: "player" },
    { bot: table.botIds[3]!, group: table.groupId, computer: table.computer.computerId, role: "player" },
    { bot: p.botId, group: solo!.id, computer: table.computer.computerId, role: "player" },
    { bot: p.botId, group: table.groupId, computer: table.computer.computerId, role: "advisor" },
  ];
  for (const invalid of invalids) {
    const runId = RunId.parse(randomUUID());
    await database.sql`INSERT INTO runs(id,bot_id,group_id,computer_id,started_at,ended_at,table_role) VALUES(${runId},${invalid.bot},${invalid.group},${invalid.computer},now(),now(),${invalid.role})`;
    act(p, { kind: "call" }, { runId });
  }
  await barrier(p);
  expect(table.agent.received().some((message) => message.type === "poker_result")).toBe(false);
  expect((await stored(id)).events.filter((event) => event.kind === "action")).toHaveLength(0);
});
it("重复非法动作回同一失败结果且拒绝次数只加一次", async () => {
  await fixture();
  const id = await seeded();
  const p = await table.agent.expect("prompt");
  const duplicate = {
    type: "poker_act",
    runId: p.runId,
    callId: "非法重复",
    handId: id,
    seq: p.table!.seq,
    action: { kind: "check" },
  } as const;
  table.agent.send(duplicate);
  const first = await table.agent.expect("poker_result");
  table.agent.send(duplicate);
  expect((await table.agent.expect("poker_result")).result).toEqual(first.result);
  const [hand] = await database.sql<{ turn_attempts: number }[]>`SELECT turn_attempts FROM poker_hands WHERE id=${id}`;
  expect(hand!.turn_attempts).toBe(1);
});
it("控制面重启后重复成功出牌仍回原成功结果且台词只落一次", async () => {
  await fixture();
  const id = await seeded();
  const p = await table.agent.expect("prompt");
  const duplicate = {
    type: "poker_act",
    runId: p.runId,
    callId: "重启重复",
    handId: id,
    seq: p.table!.seq,
    action: { kind: "call" },
    say: "只说一次",
  } as const;
  table.agent.send(duplicate);
  expect((await table.agent.expect("poker_result")).result).toEqual({ ok: true });
  const next = await table.agent.expect("prompt");
  table.agent.close();
  table.push.close();
  await server.close();
  server = await startServer({
    db: database.db,
    port: 0,
    credentialsKey: TEST_CREDENTIALS_KEY,
    toolSecretKey: "a".repeat(64),
    poker: { intervalMs: 20, now: () => now },
  });
  table.agent = (
    await helloAgent(server.port, table.computer.computerId, table.computer.token, [p.runId, next.runId])
  ).agent;
  table.agent.send(duplicate);
  expect((await table.agent.expect("poker_result")).result).toEqual({ ok: true });
  expect((await stored(id)).events.filter((event) => event.kind === "action")).toHaveLength(1);
  const [said] = await database.sql<
    { n: number }[]
  >`SELECT count(*)::int AS n FROM messages WHERE group_id=${table.groupId} AND body->>'text'='只说一次'`;
  expect(said!.n).toBe(1);
});
it("扫描器一手失败仍推进后面的桌且日志不含原异常", async () => {
  const broken = await fixture();
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const brokenId = await seeded();
  await corrupt(brokenId);
  broken.agent.close();
  broken.push.close();
  try {
    await fixture();
    await seeded();
    await table.agent.expect("prompt");
    expect(logged.mock.calls.length).toBeGreaterThan(0);
    expect(JSON.stringify(logged.mock.calls)).not.toContain("种子不得出现在日志");
    expect(logged.mock.calls.some((args) => args.includes(brokenId))).toBe(true);
    expect(logged.mock.calls.every((args) => args.every((arg) => typeof arg === "string"))).toBe(true);
  } finally {
    await database.sql`DELETE FROM users WHERE id=${broken.ownerId}`;
  }
});
it("扫描器对同一手连续失败到上限就作废它，桌子回 idle、筹码退回开手时，之后不再扫它", async () => {
  const broken = await fixture();
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const brokenId = await seeded(2, [], 1500);
  await database.sql`UPDATE poker_tables SET seats = ${JSON.stringify(
    [1, 2, 3, 4].map((seat) => ({ seat, botId: seat === 4 ? null : broken.botIds[seat - 1], stack: 1 })),
  )}::jsonb WHERE group_id = ${broken.groupId}`;
  const runId = (await broken.agent.expect("prompt")).runId;
  await corrupt(brokenId);
  for (;;) {
    const push = await broken.push.next(10_000);
    if (push.type === "message" && JSON.stringify(push.message.body).includes("这一手作废")) break;
  }
  const failures = () => logged.mock.calls.filter((args) => args[0] === "扫描牌桌手失败" && args[1] === brokenId);
  expect(failures()).toHaveLength(SWEEP_FAILURE_LIMIT);
  const [hand] = await database.sql<
    { status: string; turn_run_id: string | null }[]
  >`SELECT status, turn_run_id FROM poker_hands WHERE id = ${brokenId}`;
  expect(hand).toEqual({ status: "abandoned", turn_run_id: null });
  const [row] = await database.sql<
    { status: string; seats: { stack: number }[] }[]
  >`SELECT status, seats FROM poker_tables WHERE group_id = ${broken.groupId}`;
  expect(row!.status).toBe("idle");
  expect(row!.seats.map((seat) => seat.stack)).toEqual([1500, 1500, 1500, 1500]);
  const [run] = await database.sql<
    { ended: boolean }[]
  >`SELECT ended_at IS NOT NULL AS ended FROM runs WHERE id = ${runId}`;
  expect(run!.ended, "在途的牌友 run 收掉了").toBe(true);
  broken.agent.close();
  broken.push.close();
  try {
    await fixture();
    await seeded();
    await table.agent.expect("prompt");
    expect(failures(), "作废之后扫描器不再碰这一手").toHaveLength(SWEEP_FAILURE_LIMIT);
  } finally {
    await database.sql`DELETE FROM users WHERE id=${broken.ownerId}`;
  }
});
it("同一手失败到差一次上限时成功一次，计数清零，再失败到差一次上限也不作废", async () => {
  let clock: "steady" | "fail" | "pass_once" | "fail_again" | "pass" = "steady";
  let reached!: () => void;
  const done = new Promise<void>((resolve) => {
    reached = resolve;
  });
  await restartWith({
    intervalMs: 20,
    turnTimeoutMs: 60_000,
    now: () => {
      if (clock === "fail" || clock === "fail_again") throw new Error("推进时钟故障");
      if (clock === "pass_once") clock = "fail_again";
      if (clock === "pass") reached();
      return now;
    },
  });
  await fixture();
  const id = await seeded();
  await table.agent.expect("prompt");
  const logged = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    if (args[1] !== id) return;
    if (args[0] === "扫描牌桌手失败" && args[2] === `${SWEEP_FAILURE_LIMIT - 1}/${SWEEP_FAILURE_LIMIT}`)
      clock = clock === "fail" ? "pass_once" : "pass";
    if (args[0] !== "扫描牌桌手失败") reached();
  });
  clock = "fail";
  await done;
  const round = Array.from({ length: SWEEP_FAILURE_LIMIT - 1 }, (_, i) => `${i + 1}/${SWEEP_FAILURE_LIMIT}`);
  const calls = logged.mock.calls.filter((args) => args[1] === id);
  expect(
    calls.map((args) => args[2]),
    "成功一次之后从 1 重新数，两轮都没碰到上限",
  ).toEqual([...round, ...round]);
  expect(
    calls.every((args) => args[0] === "扫描牌桌手失败"),
    "没有试过作废",
  ).toBe(true);
  const [hand] = await database.sql<{ status: string }[]>`SELECT status FROM poker_hands WHERE id = ${id}`;
  expect(hand!.status).toBe("playing");
});
it("作废本身失败时之后的扫描不再每次记日志，满一轮才再试，库恢复后下一次作废成功", async () => {
  let down = false;
  await restartWith({
    intervalMs: 20,
    turnTimeoutMs: 60_000,
    // 坏手在载入时就抛错，推进读不到时钟；读时钟的只有作废，时钟抛错就是作废写不进库。
    now: () => {
      if (down) throw new Error("库断开");
      return now;
    },
  });
  await fixture();
  const id = await seeded();
  await table.agent.expect("prompt");
  let abandonFailures = 0;
  let abandoned!: () => void;
  const done = new Promise<void>((resolve) => {
    abandoned = resolve;
  });
  const logged = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    if (args[1] !== id) return;
    if (args[0] === "作废牌桌手失败" && ++abandonFailures === 2) down = false;
    if (args[0] === "牌桌手连续推进失败，已作废") abandoned();
  });
  down = true;
  await corrupt(id);
  await done;
  const scan = (n: number) => ["扫描牌桌手失败", id, `${n}/${SWEEP_FAILURE_LIMIT}`, expect.any(String)];
  expect(logged.mock.calls.filter((args) => args[1] === id)).toEqual([
    ...Array.from({ length: SWEEP_FAILURE_LIMIT }, (_, i) => scan(i + 1)),
    ["作废牌桌手失败", id, "Error"],
    scan(2 * SWEEP_FAILURE_LIMIT),
    ["作废牌桌手失败", id, "Error"],
    scan(3 * SWEEP_FAILURE_LIMIT),
    ["牌桌手连续推进失败，已作废", id],
  ]);
  expect(JSON.stringify(logged.mock.calls)).not.toContain("库断开");
  const [hand] = await database.sql<{ status: string }[]>`SELECT status FROM poker_hands WHERE id = ${id}`;
  expect(hand!.status).toBe("abandoned");
});
for (const failure of ["message_push", "converge", "table_push", "snapshot"] as const satisfies AfterCommitStep[]) {
  const failAt = (step: AfterCommitStep): void => {
    if (step === failure) throw new Error("后处理失败");
  };
  it(`开手提交后 ${failure} 失败仍返回 201 和已落库视图`, async () => {
    await restartWith({ intervalMs: 20, now: () => now, turnTimeoutMs: 60_000, afterCommitProbe: failAt });
    await fixture();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await table.client.post(`/api/poker/tables/${table.groupId}/hands`);
    expect(response.status).toBe(201);
    const view = PokerTableResponse.parse(await response.json()).table;
    expect(view.status).toBe("in_hand");
    expect(view.hand).not.toBeNull();
    expect((await stored(view.hand!.id)).events).toEqual(view.hand!.view.events);
    expect(logged.mock.calls).toContainEqual(["牌桌提交后这一步失败", view.hand!.id, failure, "Error"]);
  });
  it(`用户动作提交后 ${failure} 失败仍返回 200 和已落库视图`, async () => {
    let armed = false;
    await restartWith({
      intervalMs: 20,
      now: () => now,
      turnTimeoutMs: 60_000,
      afterCommitProbe: (step) => {
        if (armed) failAt(step);
      },
    });
    await fixture();
    const view = await start();
    armed = true;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await advanceUser(view, { kind: "call" });
    expect(response.status).toBe(200);
    const after = PokerTableResponse.parse(await response.json()).table;
    expect(after.hand!.view.events.some((event) => event.kind === "action" && event.seatId === "4")).toBe(true);
    expect(after.version).toBeGreaterThan(view.version);
    expect(
      (await stored(view.hand!.id)).events.filter((event) => event.kind === "action" && event.seatId === "4"),
    ).toHaveLength(1);
    expect(logged.mock.calls).toContainEqual(["牌桌提交后这一步失败", view.hand!.id, failure, "Error"]);
  });
}
it("dropped run 在同一决策点最多重派三次，重启后仍受限并等截止兜底", async () => {
  await fixture();
  const id = await seeded();
  let p = await table.agent.expect("prompt");
  for (let retry = 0; retry < 3; retry++) {
    table.agent.send({
      type: "run_done",
      runId: p.runId,
      botId: p.botId,
      groupId: p.groupId,
      steps: 0,
      inputTokens: 0,
      outputTokens: 0,
      prompt: "dropped",
    });
    await table.agent.ack(p.runId);
    p = await table.agent.expect("prompt");
    expect(p.botId).toBe(table.botIds[0]);
  }
  table.agent.send({
    type: "run_done",
    runId: p.runId,
    botId: p.botId,
    groupId: p.groupId,
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    prompt: "dropped",
  });
  await table.agent.ack(p.runId);
  table.agent.close();
  table.push.close();
  await server.close();
  // 库里只有这一手在打，converge 每圈取一次时钟、扫描串行：第二次取时钟时第一次扫描已经推进完。
  let scanned!: () => void;
  const scan = new Promise<void>((resolve) => {
    scanned = resolve;
  });
  let clockReads = 0;
  server = await startServer({
    db: database.db,
    port: 0,
    credentialsKey: TEST_CREDENTIALS_KEY,
    toolSecretKey: "a".repeat(64),
    poker: {
      intervalMs: 20,
      now: () => {
        if (++clockReads === 2) scanned();
        return now;
      },
    },
  });
  table.agent = (await helloAgent(server.port, table.computer.computerId, table.computer.token)).agent;
  await scan;
  const [runs] = await database.sql<
    { n: number }[]
  >`SELECT count(*)::int AS n FROM runs WHERE group_id=${table.groupId} AND table_role='player'`;
  expect(runs!.n).toBe(4);
  const [hand] = await database.sql<{ turn_attempts: number }[]>`SELECT turn_attempts FROM poker_hands WHERE id=${id}`;
  expect(hand!.turn_attempts).toBe(0);
  expect((await stored(id)).events.filter((event) => event.kind === "action")).toHaveLength(0);
  expect(table.agent.received().filter((message) => message.type === "prompt")).toHaveLength(0);
  now = new Date(now.getTime() + 60_001);
  expect((await table.agent.expect("prompt")).botId).toBe(table.botIds[1]);
  expect((await stored(id)).events.filter((event) => event.kind === "action")).toHaveLength(1);
});

it("启动时给了发牌种子，开手就用它，同一个种子发出同样的手牌", async () => {
  await fixture();
  await server.close();
  server = await startServer({
    db: database.db,
    port: 0,
    credentialsKey: TEST_CREDENTIALS_KEY,
    toolSecretKey: "a".repeat(64),
    poker: { intervalMs: 20, now: () => now, turnTimeoutMs: 60_000, seed: () => "验收固定种子" },
  });
  table.client = new ApiClient(server.port);
  const [owner] = await database.sql<{ email: string }[]>`SELECT email FROM users WHERE id = ${table.ownerId}`;
  expect((await table.client.login(owner!.email, PASSWORD)).status).toBe(200);
  table.agent = (await helloAgent(server.port, table.computer.computerId, table.computer.token)).agent;
  const view = await start();
  const [hand] = await database.sql<
    { id: string; seed: string }[]
  >`SELECT id, seed FROM poker_hands WHERE group_id = ${table.groupId}`;
  expect(hand!.seed, "开手用的是注入的种子").toBe("验收固定种子");
  const expected = (await stored(hand!.id)).seats.find((seat) => seat.id === "4")!.hole;
  expect(view.hand?.view.hole, "用户看到的两张牌由种子决定").toEqual(expected);
});
