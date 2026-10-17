import {
  BotListResponse,
  CreateBotResponse,
  CreateGroupResponse,
  DecideRoutineOfferResponse,
  MessageListResponse,
  PokerTableResponse,
  RoutineListResponse,
  TodayResponse,
  type AgentToControl,
  type BotId,
  type GroupId,
  type Message,
  type MessageBody,
  type ServerPush,
} from "@baize/shared";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { ApiClient, startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, waitFor } from "./helpers/fixtures.js";
import { gatedDb, type QueryGate } from "./helpers/gated-db.js";
import { connectPush, type PushClient } from "./helpers/ws.js";

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

type RoutineOfferEvent = Extract<AgentToControl, { type: "routine_offer" }>;
type RoutineOfferBody = Extract<MessageBody, { kind: "routine_offer" }>;
type OfferFields = Omit<RoutineOfferEvent, "type" | "runId" | "botId" | "groupId">;

type Session = {
  readonly client: ApiClient;
  readonly agent: AgentClient;
  readonly push: PushClient;
  readonly assistant: { readonly botId: BotId; readonly groupId: GroupId };
  /** 项目群里只有主助理和小内。 */
  readonly project: { readonly groupId: GroupId; readonly memberId: BotId };
  /** 自己的 Bot，但不在项目群里。 */
  readonly outsider: { readonly botId: BotId; readonly groupId: GroupId };
  close(): void;
};

/** Bot 和项目群都在电脑连上之前建好，代理收到的第一条 config 就带齐它们。 */
async function session(): Promise<Session> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const listed = BotListResponse.parse(await (await client.get("/api/bots")).json()).items;
  const assistant = listed.find((item) => item.bot.role === "assistant");
  if (assistant === undefined) throw new Error("登录后应当有主助理");
  const member = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小内" })).json());
  const outsider = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小外" })).json());
  const group = CreateGroupResponse.parse(
    await (await client.post("/api/groups", { title: "推广白泽", botIds: [assistant.bot.id, member.bot.id] })).json(),
  );
  const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);
  const push = await connectPush(server.server.port, client.cookie ?? "");
  return {
    client,
    agent,
    push,
    assistant: { botId: assistant.bot.id, groupId: assistant.groupId },
    project: { groupId: group.group.id, memberId: member.bot.id },
    outsider: { botId: outsider.bot.id, groupId: outsider.group.id },
    close: () => {
      agent.close();
      push.close();
    },
  };
}

function weeklyOffer(s: Session, overrides: Partial<OfferFields> = {}): OfferFields {
  return {
    name: "周一读星数",
    instruction: "读一下仓库星数，报回来",
    cron: "0 9 * * 1",
    executorBotId: s.project.memberId,
    boundary: "read_only",
    purpose: "plan",
    onToday: true,
    projectGroupId: s.project.groupId,
    ...overrides,
  };
}

/**
 * 在 by 的单聊（或项目群）里说一句拿到 prompt，用那条 run 上报确认卡，再收尾。
 * 等到 run_done 的确认就说明前面那条卡已经处理完：同一条连接上的报文按到达顺序处理。
 */
async function offerFrom(
  s: Session,
  by: { readonly botId: BotId; readonly groupId: GroupId },
  fields: OfferFields,
  /** 报文里自报的 Bot 和群，不给就是实际跑这条 run 的那个。 */
  claim: { readonly botId: BotId; readonly groupId: GroupId } = by,
): Promise<void> {
  expect((await s.client.post(`/api/groups/${by.groupId}/messages`, { text: "每周一帮我读一下星数" })).status).toBe(
    201,
  );
  const prompt = await s.agent.expect("prompt");
  const run = { runId: prompt.runId, botId: by.botId, groupId: by.groupId };
  s.agent.send({ type: "routine_offer", ...run, ...claim, ...fields });
  s.agent.send({ type: "run_done", ...run, steps: 1, inputTokens: 0, outputTokens: 0 });
  await s.agent.ack(prompt.runId);
}

async function offerCards(client: ApiClient, groupId: GroupId): Promise<(Message & { body: RoutineOfferBody })[]> {
  const page = MessageListResponse.parse(await (await client.get(`/api/groups/${groupId}/messages`)).json());
  return page.messages.filter(
    (message): message is Message & { body: RoutineOfferBody } => message.body.kind === "routine_offer",
  );
}

async function onlyCard(s: Session): Promise<Message & { body: RoutineOfferBody }> {
  const cards = await offerCards(s.client, s.assistant.groupId);
  expect(cards, "主助理单聊里应当恰好一张例行确认卡").toHaveLength(1);
  const [card] = cards;
  if (card === undefined) throw new Error("没有例行确认卡");
  return card;
}

async function routines(client: ApiClient) {
  return RoutineListResponse.parse(await (await client.get("/api/routines")).json()).items;
}

async function pendingOffers(client: ApiClient) {
  const today = TodayResponse.parse(await (await client.get("/api/today")).json());
  return today.pending.filter((item) => item.kind === "routine_offer");
}

async function nextOfType<T extends ServerPush["type"]>(push: PushClient, type: T) {
  for (let seen = 0; seen < 20; seen += 1) {
    const item = await push.next();
    if (item.type === type) return item as Extract<ServerPush, { type: T }>;
  }
  throw new Error(`等了 20 条推送都没有 ${type}`);
}

async function advisoryWaiters(): Promise<number> {
  const rows = await database.sql<{ waiting: number }[]>`
    SELECT count(*)::int AS waiting FROM pg_stat_activity
    WHERE datname = ${database.databaseName} AND wait_event_type = 'Lock' AND wait_event = 'advisory'`;
  return rows[0]?.waiting ?? 0;
}

/** 删 Bot 拿完排他锁、锁 open run 的那条。 */
const DELETE_LOCKS_RUNS = /^select "id" from "runs" .*for update/;

const decide = (client: ApiClient, messageId: string, decision: "add" | "dismiss") =>
  client.post(`/api/messages/${messageId}/routine-offer`, { decision });

it("确认卡没点加上时不建例行", async () => {
  const s = await session();
  try {
    await offerFrom(s, s.assistant, weeklyOffer(s));
    const card = await onlyCard(s);
    const { projectGroupId, ...spec } = weeklyOffer(s);
    expect(card.body).toEqual({
      kind: "routine_offer",
      botId: s.assistant.botId,
      ...spec,
      groupId: projectGroupId,
      status: "offered",
      routineId: null,
    });
    expect(await routines(s.client), "卡落下了但没点加上，例行一条都不该有").toEqual([]);
    expect(
      (await pendingOffers(s.client)).map((item) => item.message.id),
      "首页「等你确认」出这张卡",
    ).toEqual([card.id]);

    const dismissed = await decide(s.client, card.id, "dismiss");
    expect(dismissed.status).toBe(200);
    const body = DecideRoutineOfferResponse.parse(await dismissed.json());
    expect(body.routine).toBeNull();
    expect(body.message.body).toMatchObject({ kind: "routine_offer", status: "dismissed", routineId: null });
    expect(await routines(s.client), "点了不要也不建例行").toEqual([]);
    expect(await pendingOffers(s.client), "有了结论的卡不再等你确认").toEqual([]);
  } finally {
    s.close();
  }
});

it("不是主助理发的例行卡整条丢掉，冒充主助理的、主助理在项目群里发的也丢掉", async () => {
  const s = await session();
  try {
    await offerFrom(s, s.outsider, weeklyOffer(s));
    expect(await offerCards(s.client, s.outsider.groupId), "队员单聊里不落卡").toEqual([]);
    await offerFrom(s, s.outsider, weeklyOffer(s), s.assistant);
    expect(await offerCards(s.client, s.assistant.groupId), "队员的 run 冒充主助理也不落卡").toEqual([]);
    await offerFrom(s, { botId: s.assistant.botId, groupId: s.project.groupId }, weeklyOffer(s));
    expect(await offerCards(s.client, s.project.groupId), "主助理只在自己单聊里出卡").toEqual([]);
    expect(await offerCards(s.client, s.assistant.groupId)).toEqual([]);
    expect(await pendingOffers(s.client)).toEqual([]);
  } finally {
    s.close();
  }
});

it("点两次加上只建一条", async () => {
  const s = await session();
  try {
    await offerFrom(s, s.assistant, weeklyOffer(s));
    const card = await onlyCard(s);

    const [first, second] = await Promise.all([decide(s.client, card.id, "add"), decide(s.client, card.id, "add")]);
    expect([first.status, second.status].toSorted(), "并发的两次点加上只有一次成").toEqual([200, 409]);
    expect((await decide(s.client, card.id, "add")).status, "之后再点也是已有结论").toBe(409);

    const all = await routines(s.client);
    expect(all, "两次加上只建一条例行").toHaveLength(1);
    const [routine] = all;
    expect(routine).toMatchObject({
      botId: s.project.memberId,
      groupId: s.project.groupId,
      name: "周一读星数",
      instruction: "读一下仓库星数，报回来",
      triggers: [{ kind: "cron", expr: "0 9 * * 1" }],
      state: "on",
      boundary: "read_only",
      purpose: "plan",
      onToday: true,
    });

    const settled = await onlyCard(s);
    expect(settled.body).toMatchObject({ status: "added", routineId: routine?.id });
    expect(settled.revision, "卡只被改过一次").toBe(card.revision + 1);
    const pushed = await nextOfType(s.push, "routine_updated");
    expect(pushed.routine.id).toBe(routine?.id);
    expect(await pendingOffers(s.client)).toEqual([]);
  } finally {
    s.close();
  }
});

it("执行者不在目标项目群里回 400", async () => {
  const s = await session();
  try {
    await offerFrom(s, s.assistant, weeklyOffer(s, { executorBotId: s.outsider.botId }));
    const card = await onlyCard(s);

    const response = await decide(s.client, card.id, "add");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "执行者不在那个项目群里" });
    expect(await routines(s.client), "不建例行").toEqual([]);
    const after = await onlyCard(s);
    expect(after.body.status, "卡留在 offered").toBe("offered");
    expect(after.revision).toBe(card.revision);
  } finally {
    s.close();
  }
});

it("主助理提议把例行放进牌桌群：点加上回 400，不建例行，卡留在 offered", async () => {
  const s = await session();
  try {
    const opened = await s.client.post("/api/poker/tables", { requestId: randomUUID() });
    expect(opened.status).toBe(201);
    const { table } = PokerTableResponse.parse(await opened.json());
    const seatBot = table.seats.find((seat) => seat.seat === 3)?.botId;
    if (seatBot === undefined || seatBot === null) throw new Error("3 号位没有牌友");
    // 开桌重发一次 config，把牌友带下去。
    await s.agent.expect("config");
    await offerFrom(s, s.assistant, weeklyOffer(s, { projectGroupId: table.groupId, executorBotId: seatBot }));
    const card = await onlyCard(s);
    expect(card.body.groupId, "牌友在牌桌群里，卡照常落下").toBe(table.groupId);

    const response = await decide(s.client, card.id, "add");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "牌桌群里不能建例行任务" });
    expect(await routines(s.client), "不建例行").toEqual([]);
    const after = await onlyCard(s);
    expect(after.body.status, "卡留在 offered").toBe("offered");
    expect(after.revision).toBe(card.revision);
  } finally {
    s.close();
  }
});

it("用途 fast 的卡建出的例行 purpose 是 fast", async () => {
  const s = await session();
  try {
    await offerFrom(
      s,
      s.assistant,
      weeklyOffer(s, { purpose: "fast", projectGroupId: null, executorBotId: s.outsider.botId, onToday: false }),
    );
    const card = await onlyCard(s);
    expect(card.body.groupId, "目标是 null 时发进执行者单聊").toBeNull();

    const response = await decide(s.client, card.id, "add");
    expect(response.status).toBe(200);
    const decided = DecideRoutineOfferResponse.parse(await response.json());
    expect(decided.routine).toMatchObject({
      botId: s.outsider.botId,
      groupId: null,
      purpose: "fast",
      state: "on",
      onToday: false,
    });
    expect((await routines(s.client)).map((routine) => routine.purpose)).toEqual(["fast"]);
  } finally {
    s.close();
  }
});

it("未登录点加上、点不要都回 401", async () => {
  const anonymous = server.client();
  for (const decision of ["add", "dismiss"] as const) {
    const response = await decide(anonymous, "00000000-0000-4000-8000-000000000000", decision);
    expect(response.status, `未登录 ${decision}`).toBe(401);
  }
});

it("加上已过完执行者校验、还没建例行时删执行者，删除等它提交，新例行转给主助理", async () => {
  const s = await session();
  let held: QueryGate | undefined;
  try {
    await offerFrom(s, s.assistant, weeklyOffer(s, { executorBotId: s.outsider.botId, projectGroupId: null }));
    const card = await onlyCard(s);
    held = gate.arm(/^insert into "routines"/, "before");
    const adding = decide(s.client, card.id, "add");
    await held.reached;

    let deletedFirst = false;
    const deleting = s.client.delete(`/api/bots/${s.outsider.botId}`).then((response) => {
      deletedFirst = true;
      return response;
    });
    await waitFor(async () => deletedFirst || (await advisoryWaiters()) > 0, "删除卡在执行者的锁上");
    expect(deletedFirst, "删除要等加上提交").toBe(false);
    held.release();

    const added = await adding;
    expect(added.status, `删除不等加上提交，例行插进一个已删的 Bot：${await added.clone().text()}`).toBe(200);
    expect((await deleting).status).toBe(204);
    const settled = (await onlyCard(s)).body;
    expect(settled.status).toBe("added");
    expect(
      (await routines(s.client)).map((one) => [one.id, one.botId, one.groupId]),
      "回了 200 的例行不能丢，删执行者的转交扫描看得见它",
    ).toEqual([[settled.routineId, s.assistant.botId, null]]);
  } finally {
    held?.release();
    s.close();
  }
});

it("删执行者先拿到锁，点加上等它提交后回 404，卡留在 offered", async () => {
  const s = await session();
  let held: QueryGate | undefined;
  try {
    await offerFrom(s, s.assistant, weeklyOffer(s, { executorBotId: s.outsider.botId, projectGroupId: null }));
    const card = await onlyCard(s);
    held = gate.arm(DELETE_LOCKS_RUNS, "after");
    const deleting = s.client.delete(`/api/bots/${s.outsider.botId}`);
    await held.reached;

    let addedFirst = false;
    const adding = decide(s.client, card.id, "add").then((response) => {
      addedFirst = true;
      return response;
    });
    await waitFor(async () => addedFirst || (await advisoryWaiters()) > 0, "加上卡在执行者的锁上");
    held.release();

    expect((await deleting).status).toBe(204);
    const added = await adding;
    expect(added.status, `加上没等删除提交：${await added.clone().text()}`).toBe(404);
    expect(await added.json()).toEqual({ error: "执行这条例行的 Bot 已经不在了" });
    const after = await onlyCard(s);
    expect(after.body.status, "卡留在 offered").toBe("offered");
    expect(after.revision).toBe(card.revision);
    expect(await routines(s.client)).toEqual([]);
  } finally {
    held?.release();
    s.close();
  }
});

/** 另开一个事务替删 Bot 拿住这个 Bot 的排他锁，release 之后才提交。 */
async function holdBotExclusive(botId: BotId) {
  let release!: () => void;
  let acquired!: () => void;
  const open = new Promise<void>((resolve) => (release = resolve));
  const locked = new Promise<void>((resolve) => (acquired = resolve));
  const finished = database.sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${0x627a6274}::int4, hashtext(${botId}::text))`;
    acquired();
    await open;
  });
  await locked;
  return { release, finished };
}

it("方案卡点开始先拿主助理的共享锁，主助理被排他锁住时连卡都不碰，放行后照常建出两条例行", async () => {
  const s = await session();
  let exclusive: Awaited<ReturnType<typeof holdBotExclusive>> | undefined;
  let claim: QueryGate | undefined;
  try {
    expect((await s.client.post(`/api/groups/${s.assistant.groupId}/messages`, { text: "建个项目" })).status).toBe(201);
    const prompt = await s.agent.expect("prompt");
    const run = { runId: prompt.runId, botId: s.assistant.botId, groupId: s.assistant.groupId };
    s.agent.send({
      type: "project_offer",
      ...run,
      name: "锁序项目",
      goal: "点开始也守建例行的锁",
      team: [{ name: "专员", tags: [], description: "协作" }],
      platforms: [],
      cadence: "每周",
      firstStep: "先读",
    });
    s.agent.send({ type: "run_done", ...run, steps: 1, inputTokens: 0, outputTokens: 0 });
    await s.agent.ack(prompt.runId);
    const page = MessageListResponse.parse(
      await (await s.client.get(`/api/groups/${s.assistant.groupId}/messages`)).json(),
    );
    const card = page.messages.find((message) => message.body.kind === "project_offer");
    if (card === undefined) throw new Error("方案卡应当落在主助理单聊里");

    exclusive = await holdBotExclusive(s.assistant.botId);
    claim = gate.arm(/^update "messages"/, "before");
    let claimed = false;
    void claim.reached.then(() => {
      claimed = true;
    });
    const starting = s.client.post(`/api/messages/${card.id}/project-offer`, { decision: "start" });
    await waitFor(async () => claimed || (await advisoryWaiters()) > 0, "点开始卡在主助理的锁上");
    expect(claimed, "主助理被排他锁住时，点开始不能先抢卡、建队员、建例行").toBe(false);
    exclusive.release();
    await exclusive.finished;
    claim.release();

    const started = await starting;
    expect(started.status, await started.clone().text()).toBe(200);
    const all = await routines(s.client);
    expect(all.map((routine) => routine.botId)).toEqual([s.assistant.botId, s.assistant.botId]);
  } finally {
    exclusive?.release();
    claim?.release();
    await exclusive?.finished;
    s.close();
  }
});
