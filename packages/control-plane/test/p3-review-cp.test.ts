import {
  BotId,
  CreateGroupResponse,
  GroupId,
  PokerEvent,
  PokerHandId,
  PokerSessionId,
  PokerTableResponse,
  RunId,
  type ControlToAgent,
  type PokerAction,
  type PokerSeatNo,
  type PokerTableView,
} from "@baize/shared";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { apply, newHand, replay, type HandState } from "../src/poker/engine.js";
import { ensurePokerPresets } from "../src/repo/poker-presets.js";
import { startServer, type RunningServer } from "../src/server.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { ApiClient, TEST_CREDENTIALS_KEY } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { makeComputer, makeUser, PASSWORD, type TestComputer } from "./helpers/fixtures.js";
import { connectPush, type PushClient } from "./helpers/ws.js";

type Prompt = Extract<ControlToAgent, { type: "prompt" }>;
const HOST_LINE = "散场了，复盘在项目页";

let database: TestDb;
let server: RunningServer;
let table: Fixture;

beforeAll(async () => {
  database = await createTestDb();
});
beforeEach(async () => {
  server = await startServer({
    db: database.db,
    port: 0,
    credentialsKey: TEST_CREDENTIALS_KEY,
    toolSecretKey: "a".repeat(64),
    poker: { intervalMs: 20, now: () => new Date(), turnTimeoutMs: 60_000 },
  });
});
afterEach(async () => {
  table?.agent?.close();
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
  agent: AgentClient | null;
  push: PushClient;
  botIds: BotId[];
  hostId: BotId;
};
async function fixture(options: { online?: boolean } = {}): Promise<Fixture> {
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
  const agent =
    options.online === false ? null : (await helloAgent(server.port, computer.computerId, computer.token)).agent;
  const push = await connectPush(server.port, client.cookie ?? "");
  table = { ownerId: user.id, groupId, computer, client, botIds, hostId: botIds[3]!, agent, push };
  return table;
}
function agentOf(): AgentClient {
  if (!table.agent) throw new Error("夹具里电脑还没连上");
  return table.agent;
}

// 用户是 4 号位。每个脚本的用户筹码变化按盲注 10/20 手算，写在名字旁边，不靠被测代码算。
type Script = { button: PokerSeatNo; actions: PokerAction[]; delta: number | null };
const fold: PokerAction = { kind: "fold" };
const raise = (amount: number): PokerAction => ({ kind: "raise", amount });
/** 用户枪口位加到 100，其余三家弃牌，赢走两个盲注。 */
const WIN_BLINDS: Script = { button: 1, actions: [raise(100), fold, fold, fold], delta: 30 };
/** 用户加到 200，大盲 3 号位反加到 600，用户弃牌，输掉 200。 */
const LOSE_RAISE: Script = { button: 1, actions: [raise(200), fold, fold, raise(600), fold], delta: -200 };
/** 用户大盲，1 号位加到 100，用户反加到 500，1 号位弃牌：底池 610 减自己投入 500。 */
const WIN_RERAISE: Script = { button: 2, actions: [raise(100), fold, fold, raise(500), fold], delta: 110 };
/** 用户小盲，其余弃牌到大盲：丢掉小盲 10。 */
const LOSE_SMALL_BLIND: Script = { button: 3, actions: [fold, fold, fold], delta: -10 };
/** 用户大盲，其余弃牌：赢走小盲 10。 */
const WIN_SMALL_BLIND: Script = { button: 2, actions: [fold, fold, fold], delta: 10 };
/** 用户全下，3 号位大盲跟，1、2 号位弃牌：两家摊牌，胜负由种子定。赢走 2000 加小盲 10，输掉 2000。 */
const SHOWDOWN: Script = { button: 1, actions: [{ kind: "all_in" }, fold, fold, { kind: "call" }], delta: null };

type Seeded = { sessionId: PokerSessionId; hands: { id: PokerHandId; number: number; state: HandState }[] };
let clock = Date.parse("2026-01-01T00:00:00Z");
async function seedSession(scripts: Script[], options: { ended: boolean }): Promise<Seeded> {
  const sessionId = PokerSessionId.parse(randomUUID());
  clock += 3_600_000;
  const startedAt = new Date(clock).toISOString();
  const endedAt = options.ended ? new Date(clock + 1_800_000).toISOString() : null;
  await database.sql`INSERT INTO poker_sessions (id, group_id, started_at, ended_at) VALUES (${sessionId}, ${table.groupId}, ${startedAt}::timestamptz, ${endedAt}::timestamptz)`;
  const [last] = await database.sql<
    { n: number }[]
  >`SELECT coalesce(max(number), 0)::int AS n FROM poker_hands WHERE group_id = ${table.groupId}`;
  const hands: Seeded["hands"] = [];
  for (const [index, script] of scripts.entries()) {
    const number = last!.n + index + 1;
    const seed = `p3-review-hand-${number}`;
    const seats = [1, 2, 3, 4].map((seat) => ({
      seat,
      botId: seat === 4 ? null : table.botIds[seat - 1],
      stack: 2000,
    }));
    let state = newHand(
      seed,
      seats.map((seat) => ({ id: String(seat.seat), stack: seat.stack })),
      String(script.button),
      { small: 10, big: 20 },
    );
    for (const action of script.actions) {
      if (state.phase.kind !== "betting") throw new Error("夹具提前结算了");
      state = apply(state, state.phase.pending[0]!, action);
    }
    if (state.phase.kind !== "complete") throw new Error("夹具这手没打完");
    const id = PokerHandId.parse(randomUUID());
    await database.sql.begin(async (sql) => {
      await sql`INSERT INTO poker_hands (id, group_id, session_id, number, seed, seats_start, button_seat, blinds, status, version, created_at, completed_at) VALUES (${id}, ${table.groupId}, ${sessionId}, ${number}, ${seed}, ${JSON.stringify(seats)}::jsonb, ${script.button}, ${JSON.stringify(state.blinds)}::jsonb, 'complete', 1, ${startedAt}::timestamptz, ${startedAt}::timestamptz)`;
      for (const [seq, event] of state.events.entries())
        await sql`INSERT INTO poker_events (hand_id, seq, event, created_at) VALUES (${id}, ${seq}, ${JSON.stringify(event)}::jsonb, now())`;
    });
    hands.push({ id, number, state });
  }
  await database.sql`UPDATE poker_tables SET hand_count = (SELECT coalesce(max(number), 0) FROM poker_hands WHERE group_id = ${table.groupId}), status = 'idle' WHERE group_id = ${table.groupId}`;
  return { sessionId, hands };
}
/** 开着的一手：button 为 1 时用户枪口位先说话，不会有牌友 prompt 冒出来。 */
async function seedInProgress(): Promise<Seeded> {
  const sessionId = PokerSessionId.parse(randomUUID());
  const handId = PokerHandId.parse(randomUUID());
  const seats = [1, 2, 3, 4].map((seat) => ({ seat, botId: seat === 4 ? null : table.botIds[seat - 1], stack: 2000 }));
  const state = newHand(
    "p3-review-in-hand",
    seats.map((seat) => ({ id: String(seat.seat), stack: seat.stack })),
    "1",
    { small: 10, big: 20 },
  );
  await database.sql.begin(async (sql) => {
    await sql`INSERT INTO poker_sessions (id, group_id) VALUES (${sessionId}, ${table.groupId})`;
    await sql`INSERT INTO poker_hands (id, group_id, session_id, number, seed, seats_start, button_seat, blinds, created_at) VALUES (${handId}, ${table.groupId}, ${sessionId}, 1, ${state.seed}, ${JSON.stringify(seats)}::jsonb, 1, ${JSON.stringify(state.blinds)}::jsonb, now())`;
    for (const [seq, event] of state.events.entries())
      await sql`INSERT INTO poker_events (hand_id, seq, event, created_at) VALUES (${handId}, ${seq}, ${JSON.stringify(event)}::jsonb, now())`;
    await sql`UPDATE poker_tables SET status = 'in_hand', hand_count = 1, button_seat = 1 WHERE group_id = ${table.groupId}`;
  });
  return { sessionId, hands: [{ id: handId, number: 1, state }] };
}
/** 五手：关键手按筹码变化绝对值是第 5 手两千上下、第 2 手 200、第 4 手 110，小的 30、10 落选。 */
async function seedFiveHands(): Promise<Seeded> {
  return seedSession([WIN_BLINDS, LOSE_RAISE, LOSE_SMALL_BLIND, WIN_RERAISE, SHOWDOWN], { ended: false });
}

const leavePath = () => `/api/poker/tables/${table.groupId}/leave`;
async function leave(): Promise<PokerTableView> {
  const response = await table.client.post(leavePath());
  expect(response.status).toBe(200);
  return PokerTableResponse.parse(await response.json()).table;
}
async function getTable(): Promise<PokerTableView> {
  const response = await table.client.get(`/api/poker/tables/${table.groupId}`);
  expect(response.status).toBe(200);
  return PokerTableResponse.parse(await response.json()).table;
}
async function reviewerPrompt(): Promise<Prompt> {
  const prompt = await agentOf().expect("prompt");
  expect(prompt.table?.role).toBe("reviewer");
  return prompt;
}
function reviewHands(prompt: Prompt, text: (number: number) => string = (number) => `第 ${number} 手：按公开信息复盘`) {
  return prompt.table!.review!.map((hand) => ({ number: hand.number, title: hand.title, text: text(hand.number) }));
}
async function finish(prompt: Prompt): Promise<void> {
  agentOf().send({
    type: "run_done",
    runId: prompt.runId,
    botId: prompt.botId,
    groupId: prompt.groupId,
    steps: 1,
    inputTokens: 1,
    outputTokens: 1,
    prompt: "entered",
  });
  await agentOf().ack(prompt.runId);
}
async function submit(prompt: Prompt, hands = reviewHands(prompt)): Promise<void> {
  agentOf().send({ type: "poker_review", runId: prompt.runId, sessionId: prompt.table!.sessionId, hands });
  await finish(prompt);
}
/** 往群里落一条确定会到的哨兵：电脑上行报文按序处理，它到了，前面的报文就都处理完了。 */
async function barrier(botId: BotId): Promise<void> {
  const runId = RunId.parse(randomUUID());
  const messageId = randomUUID() as import("@baize/shared").MessageId;
  await database.sql`INSERT INTO runs (id, bot_id, group_id, computer_id, started_at) VALUES (${runId}, ${botId}, ${table.groupId}, ${table.computer.computerId}, now())`;
  agentOf().send({
    type: "bot_text",
    runId,
    botId,
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
async function tablePush(predicate: (view: PokerTableView) => boolean): Promise<PokerTableView> {
  for (;;) {
    const push = await table.push.next();
    if (push.type === "poker_table_updated" && predicate(push.table)) return push.table;
  }
}
async function reviewOf(sessionId: string): Promise<unknown> {
  const [row] = await database.sql<{ review: unknown }[]>`SELECT review FROM poker_sessions WHERE id = ${sessionId}`;
  return row!.review;
}
async function count(query: Promise<{ n: number }[]>): Promise<number> {
  return (await query)[0]!.n;
}
const reviewerRuns = () =>
  count(
    database.sql<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM runs WHERE group_id = ${table.groupId} AND table_role = 'reviewer'`,
  );
const hostLines = () =>
  count(
    database.sql<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM messages WHERE group_id = ${table.groupId} AND body ->> 'text' = ${HOST_LINE}`,
  );
const userDeltaOf = (state: HandState): number => state.seats.find((seat) => seat.id === "4")!.stack - 2000;
function cardsIn(text: string, cards: readonly string[]): string[] {
  return cards.filter((card) => new RegExp(`(?<![0-9A-Za-z])${card}(?![0-9A-Za-z])`).test(text));
}

it("散场后接口里有三手关键牌的复盘", async () => {
  await fixture();
  const session = await seedFiveHands();
  const before = await getTable();
  expect(before.session?.id).toBe(session.sessionId);

  const left = await leave();
  expect(left.session).toBeNull();
  expect(left.status).toBe("idle");
  expect(left.version).toBeGreaterThan(before.version);

  const prompt = await reviewerPrompt();
  expect(prompt.botId).toBe(table.hostId);
  expect(prompt.table!.sessionId).toBe(session.sessionId);
  expect(prompt.table!.review!.map((hand) => hand.number)).toEqual([2, 4, 5]);
  const showdown = session.hands[4]!;
  expect(userDeltaOf(showdown.state)).toBe(2010);
  expect(prompt.table!.review!.map((hand) => hand.userDelta)).toEqual([-200, 110, userDeltaOf(showdown.state)]);

  const texts = new Map([
    [2, "长".repeat(120)],
    [4, "第四手：大盲位反加后对手弃牌。"],
    [5, "第五手：全下对跟，胜负靠牌面。"],
  ]);
  await submit(
    prompt,
    reviewHands(prompt, (number) => texts.get(number)!),
  );
  const pushed = await tablePush((view) => view.lastReview !== null);
  expect(pushed.version).toBeGreaterThan(left.version);

  const after = await getTable();
  expect(after.lastReview).toEqual({
    sessionId: session.sessionId,
    hands: prompt.table!.review!.map((hand) => ({
      number: hand.number,
      title: hand.title,
      text: texts.get(hand.number)!,
    })),
  });
  expect(pushed.lastReview).toEqual(after.lastReview);
  const [line] = await database.sql<
    { body: { kind: string; botId: string }; visible_to: unknown }[]
  >`SELECT body, visible_to FROM messages WHERE group_id = ${table.groupId} AND body ->> 'text' = ${HOST_LINE}`;
  expect(line!.body).toMatchObject({ kind: "bot", botId: table.hostId });
  expect(line!.visible_to).toBeNull();
  expect(await hostLines()).toBe(1);
});

it("复盘的 prompt 里只有用户视角，找不到未摊牌座位的底牌", async () => {
  await fixture();
  const session = await seedFiveHands();
  await leave();
  const prompt = await reviewerPrompt();
  const wire = JSON.stringify(prompt);
  expect(wire).not.toMatch(/seed|deck/);
  for (const hand of session.hands) expect(wire).not.toContain(hand.state.seed);
  expect(prompt.context).toEqual([]);
  expect(prompt.task).toBeNull();
  expect(prompt.members).toEqual([]);
  expect(prompt.table!.view).toBeNull();
  expect(prompt.table!.question).toBeNull();

  let checkedHidden = 0;
  for (const item of prompt.table!.review!) {
    const hand = session.hands.find((candidate) => candidate.number === item.number)!;
    const holeOf = (id: string) => hand.state.seats.find((seat) => seat.id === id)!.hole;
    const shown = new Set(hand.state.events.flatMap((event) => (event.kind === "showdown" ? [event.seatId] : [])));
    expect(item.view.seatId).toBe("4");
    expect(item.view.hole).toEqual(holeOf("4"));
    const json = JSON.stringify(item);
    for (const id of ["1", "2", "3"]) {
      const found = cardsIn(json, holeOf(id));
      if (shown.has(id)) expect(found, `${item.number} 手 ${id} 号位摊了牌`).toHaveLength(2);
      else {
        expect(found, `${item.number} 手 ${id} 号位没摊牌`).toEqual([]);
        checkedHidden += 1;
      }
    }
  }
  const showdownItem = prompt.table!.review!.find((item) => item.number === 5)!;
  expect(
    session.hands[4]!.state.events.flatMap((event) => (event.kind === "showdown" ? [event.seatId] : [])).toSorted(),
  ).toEqual(["3", "4"]);
  expect(showdownItem.view.seats.filter((seat) => seat.shown !== null).map((seat) => seat.seatId)).toEqual(["3", "4"]);
  expect(checkedHidden).toBe(8);
});

it("同一场点两次散场只出一份复盘", async () => {
  await fixture();
  const session = await seedFiveHands();
  const responses = await Promise.all([table.client.post(leavePath()), table.client.post(leavePath())]);
  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  const prompt = await reviewerPrompt();
  expect(await reviewerRuns()).toBe(1);
  expect(
    await count(
      database.sql<
        { n: number }[]
      >`SELECT count(*)::int AS n FROM poker_sessions WHERE group_id = ${table.groupId} AND ended_at IS NOT NULL`,
    ),
  ).toBe(1);

  await submit(prompt);
  const done = await tablePush((view) => view.lastReview !== null);
  expect(await leave()).toMatchObject({ lastReview: done.lastReview });
  await barrier(table.hostId);
  expect(await reviewerRuns()).toBe(1);
  expect(await hostLines()).toBe(1);
  expect(
    agentOf()
      .received()
      .filter((message) => message.type === "prompt"),
  ).toEqual([]);
  expect((await getTable()).lastReview).toEqual(done.lastReview);
  expect(await reviewOf(session.sessionId)).toEqual(done.lastReview);
});

it("手进行中散场回 409", async () => {
  await fixture();
  const session = await seedInProgress();
  const [before] = await database.sql<
    { version: number }[]
  >`SELECT version FROM poker_tables WHERE group_id = ${table.groupId}`;
  const response = await table.client.post(leavePath());
  expect(response.status).toBe(409);
  const body = (await response.json()) as { error: string };
  expect(body.error).toMatch(/[一-鿿]/);
  const [open] = await database.sql<
    { ended_at: Date | null }[]
  >`SELECT ended_at FROM poker_sessions WHERE id = ${session.sessionId}`;
  expect(open!.ended_at).toBeNull();
  expect(await reviewerRuns()).toBe(0);
  const [after] = await database.sql<
    { version: number }[]
  >`SELECT version FROM poker_tables WHERE group_id = ${table.groupId}`;
  expect(after!.version).toBe(before!.version);
  await barrier(table.hostId);
  expect(agentOf().received()).toEqual([]);
});

it("复盘运行失败后再点散场可重试", async () => {
  await fixture();
  const session = await seedFiveHands();
  await leave();
  const first = await reviewerPrompt();
  const [ended] = await database.sql<
    { ended_at: Date }[]
  >`SELECT ended_at FROM poker_sessions WHERE id = ${session.sessionId}`;

  agentOf().send({ type: "agent_error", code: "runner_failed", detail: "模型没响应", runId: first.runId });
  await barrier(table.hostId);
  expect(await reviewOf(session.sessionId)).toBeNull();
  expect((await getTable()).lastReview).toBeNull();
  expect(await hostLines()).toBe(0);

  await leave();
  const second = await reviewerPrompt();
  expect(second.runId).not.toBe(first.runId);
  expect(second.table!.sessionId).toBe(session.sessionId);
  expect(second.table!.review!.map((hand) => hand.number)).toEqual([2, 4, 5]);
  expect(await reviewerRuns()).toBe(2);
  const [again] = await database.sql<
    { ended_at: Date }[]
  >`SELECT ended_at FROM poker_sessions WHERE id = ${session.sessionId}`;
  expect(again!.ended_at).toEqual(ended!.ended_at);

  await submit(second);
  const done = await tablePush((view) => view.lastReview !== null);
  expect(done.lastReview!.sessionId).toBe(session.sessionId);
  expect(await hostLines()).toBe(1);
});

it("模型没交复盘就收尾，再点散场可重试", async () => {
  await fixture();
  const session = await seedFiveHands();
  await leave();
  const first = await reviewerPrompt();
  await finish(first);
  expect(await reviewOf(session.sessionId)).toBeNull();
  await leave();
  const second = await reviewerPrompt();
  expect(second.runId).not.toBe(first.runId);
  await submit(second);
  expect((await tablePush((view) => view.lastReview !== null)).lastReview!.sessionId).toBe(session.sessionId);
});

it("没有电脑在线时散场照样结束这一场，电脑回来后再点一次补派复盘", async () => {
  await fixture({ online: false });
  const session = await seedFiveHands();
  const left = await leave();
  expect(left.session).toBeNull();
  expect(await reviewerRuns()).toBe(0);
  expect(await reviewOf(session.sessionId)).toBeNull();

  table.agent = (await helloAgent(server.port, table.computer.computerId, table.computer.token)).agent;
  await leave();
  const prompt = await reviewerPrompt();
  expect(prompt.table!.sessionId).toBe(session.sessionId);
  await submit(prompt);
  expect((await tablePush((view) => view.lastReview !== null)).lastReview!.sessionId).toBe(session.sessionId);
  expect(await reviewerRuns()).toBe(1);
});

it.each<[string, (hands: ReturnType<typeof reviewHands>) => ReturnType<typeof reviewHands>]>([
  ["少一手", (hands) => hands.slice(0, 2)],
  ["多一手", (hands) => [...hands, { number: 99, title: "多出来的", text: "不在关键手里" }]],
  ["手序号重复", (hands) => [hands[0]!, hands[1]!, hands[1]!]],
  ["换了一手不在关键手里的序号", (hands) => [hands[0]!, hands[1]!, { ...hands[2]!, number: 1 }]],
  [
    "正文超过 120 字",
    (hands) => hands.map((hand, index) => (index === 1 ? { ...hand, text: "长".repeat(121) } : hand)),
  ],
])("poker_review 的 %s 整条不收，修正后重新散场可以交", async (_name, mutate) => {
  await fixture();
  const session = await seedFiveHands();
  await leave();
  const first = await reviewerPrompt();
  await submit(first, mutate(reviewHands(first)));
  expect(await reviewOf(session.sessionId)).toBeNull();
  expect(await hostLines()).toBe(0);

  await leave();
  const second = await reviewerPrompt();
  await submit(second);
  const done = await tablePush((view) => view.lastReview !== null);
  expect(done.lastReview!.hands.map((hand) => hand.number)).toEqual([2, 4, 5]);
  expect(await hostLines()).toBe(1);
});

it("poker_review 不是 reviewer 的 run 发的，或者那一场还没散，都不收", async () => {
  await fixture();
  const session = await seedFiveHands();
  await leave();
  const prompt = await reviewerPrompt();
  const hands = reviewHands(prompt);

  const plainRun = RunId.parse(randomUUID());
  await database.sql`INSERT INTO runs (id, bot_id, group_id, computer_id, started_at) VALUES (${plainRun}, ${table.hostId}, ${table.groupId}, ${table.computer.computerId}, now())`;
  agentOf().send({ type: "poker_review", runId: plainRun, sessionId: session.sessionId, hands });

  const open = await seedSession([WIN_SMALL_BLIND, WIN_BLINDS], { ended: false });
  agentOf().send({
    type: "poker_review",
    runId: prompt.runId,
    sessionId: open.sessionId,
    hands: open.hands.map((hand) => ({ number: hand.number, title: "未散场", text: "这一场还没散" })),
  });
  await barrier(table.hostId);
  expect(await reviewOf(session.sessionId)).toBeNull();
  expect(await reviewOf(open.sessionId)).toBeNull();
  expect(await hostLines()).toBe(0);

  await submit(prompt);
  expect((await tablePush((view) => view.lastReview !== null)).lastReview!.sessionId).toBe(session.sessionId);
});

it("同一个 run 连交两份复盘只认第一份，老白的收尾话只说一次", async () => {
  await fixture();
  const session = await seedFiveHands();
  await leave();
  const prompt = await reviewerPrompt();
  agentOf().send({
    type: "poker_review",
    runId: prompt.runId,
    sessionId: session.sessionId,
    hands: reviewHands(prompt, (number) => `第一份：第 ${number} 手`),
  });
  await submit(
    prompt,
    reviewHands(prompt, (number) => `第二份：第 ${number} 手`),
  );
  const done = await tablePush((view) => view.lastReview !== null);
  expect(done.lastReview!.hands.map((hand) => hand.text)).toEqual([
    "第一份：第 2 手",
    "第一份：第 4 手",
    "第一份：第 5 手",
  ]);
  expect((await getTable()).lastReview).toEqual(done.lastReview);
  expect(await hostLines()).toBe(1);
});

it("战绩的场数、你赢的场数、筹码净值按已散场的会话算", async () => {
  await fixture();
  await seedSession([WIN_BLINDS, WIN_RERAISE], { ended: true });
  await seedSession([LOSE_RAISE, LOSE_SMALL_BLIND], { ended: true });
  const open = await seedSession([WIN_SMALL_BLIND, WIN_BLINDS], { ended: false });
  expect((await getTable()).stats).toEqual({ sessions: 2, sessionsWon: 1, net: 140 - 210 });
  expect((await getTable()).session).toMatchObject({ id: open.sessionId, handCount: 2 });

  const left = await leave();
  expect(left.stats).toEqual({ sessions: 3, sessionsWon: 2, net: 140 - 210 + 40 });
  expect(await getTable()).toMatchObject({ stats: left.stats });
  expect((await tablePush((view) => view.session === null)).stats).toEqual(left.stats);
});

it("一手都没结算的一场散场，直接出空复盘，不派老白", async () => {
  await fixture();
  const empty = await seedSession([], { ended: false });
  const left = await leave();
  expect(left.session).toBeNull();
  expect(left.lastReview).toEqual({ sessionId: empty.sessionId, hands: [] });
  expect(await reviewerRuns()).toBe(0);
  expect(await hostLines()).toBe(1);
  expect(await leave()).toMatchObject({ lastReview: left.lastReview });
  expect(await hostLines()).toBe(1);
  await barrier(table.hostId);
  expect(agentOf().received()).toEqual([]);
});

it("别人的牌桌、不存在的牌桌和还没开过局的牌桌散场的回应", async () => {
  await fixture();
  const stranger = await makeUser(database.db);
  const other = new ApiClient(server.port);
  expect((await other.login(stranger.email, PASSWORD)).status).toBe(200);
  expect((await other.post(leavePath())).status).toBe(404);
  expect((await table.client.post("/api/poker/tables/不存在的桌/leave")).status).toBe(404);
  expect((await table.client.post(leavePath())).status).toBe(409);
  expect((await table.client.post(leavePath(), { extra: 1 })).status).toBe(400);
  await database.sql`DELETE FROM users WHERE id = ${stranger.id}`;
});

void PokerEvent;
void replay;
