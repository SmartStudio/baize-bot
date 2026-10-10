import {
  BotListResponse,
  CreateBotResponse,
  CreateGroupResponse,
  DecideTeamOfferResponse,
  GroupResponse,
  MessageListResponse,
  TodayResponse,
  type AgentToControl,
  type BotId,
  type ControlToAgent,
  type GroupId,
  type Message,
  type MessageBody,
  type ServerPush,
  type TeamOfferMember,
} from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { connect, type Sql } from "../src/db/client.js";
import { databaseUrl } from "../src/env.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { ApiClient, startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, waitFor } from "./helpers/fixtures.js";
import { gatedDb } from "./helpers/gated-db.js";
import { connectPush, type PushClient } from "./helpers/ws.js";

/** 确认给新人发号那条：带 next_hue_index 的是 claimCounter，建群的 openGroup 只推进 next_task_number。 */
const CLAIM_COUNTER = /^update "user_counters" set "next_task_number" = .* "next_hue_index" = /;
/** run 名下的写开头那条 lockOpenRun；runBelongsTo 那条没有 for share。 */
const LOCK_OPEN_RUN = /^select "id" from "runs" where .* for share$/;
/** 落卡事务锁 Bot 之前读目标群成员那条。 */
const READ_TARGET_MEMBERS = /^select "bot_id" from "group_members" where /;
/** 落卡事务锁完 Bot 之后重查目标群还有成员那条 findProjectGroupId。 */
const FIND_PROJECT_GROUP = /^select "id" from "groups" where .*exists.*limit /;
/** findGroup 读群成员那条：库里的群名单在这条里取快照。 */
const READ_GROUP_BOTS = /from "group_members" inner join "bots"/;
/** 落卡事务锁完 Bot 之后重查候选归属那条 ownsAllBots；带 for key share 的是锁那条，不算。 */
const OWNS_ALL_BOTS = /^select "id" from "bots" where (?!.*for key share)/;

let database: TestDb;
let sqlGate: ReturnType<typeof gatedDb>;
let server: TestServer;
/** 测试自己持锁、看锁等待用的连接池。和控制面分开，四方交错时控制面那 4 条连接全在等锁，测试还查得动。 */
let observer: Sql;

beforeAll(async () => {
  database = await createTestDb();
  sqlGate = gatedDb(database.sql);
  server = await startTestServer(sqlGate.db);
  const url = new URL(databaseUrl());
  url.pathname = `/${database.databaseName}`;
  observer = connect(url.toString(), { max: 4 }).sql;
});

afterAll(async () => {
  await server.close();
  await observer.end();
  await database.close();
});

type Prompt = Extract<ControlToAgent, { type: "prompt" }>;
type TeamOfferEvent = Extract<AgentToControl, { type: "team_offer" }>;
type TeamOfferBody = Extract<MessageBody, { kind: "team_offer" }>;
type Members = TeamOfferEvent["members"];

const RESEARCHER = {
  kind: "new",
  name: "小研",
  tags: ["调研"],
  description: "查竞品和资料，不写稿",
  note: "缺个人盯竞品",
  suggested: false,
} satisfies TeamOfferMember;
const DESIGNER = {
  kind: "new",
  name: "小设",
  tags: ["设计"],
  description: "做封面图",
  note: "封面图现在没人做",
  suggested: true,
} satisfies TeamOfferMember;

type Session = {
  readonly client: ApiClient;
  readonly agent: AgentClient;
  readonly push: PushClient;
  readonly assistant: { readonly botId: BotId; readonly groupId: GroupId };
  /** 项目群：主助理加上 memberNames 里的队员。 */
  readonly project: { readonly groupId: GroupId; readonly memberIds: readonly BotId[] };
  close(): void;
};

/** Bot 和项目群都在电脑连上之前建好，这样代理收到的第一条就是带齐它们的 config，用例不用一条条跳过。 */
async function session(memberNames: readonly string[] = ["小内"]): Promise<Session> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const assistant = (await bots(client)).find((item) => item.bot.role === "assistant");
  if (assistant === undefined) throw new Error("登录后应当有主助理");
  const memberIds: BotId[] = [];
  for (const name of memberNames) {
    const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name })).json());
    memberIds.push(created.bot.id);
  }
  const group = CreateGroupResponse.parse(
    await (await client.post("/api/groups", { title: "推广白泽", botIds: [assistant.bot.id, ...memberIds] })).json(),
  );
  const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);
  const push = await connectPush(server.server.port, client.cookie ?? "");
  return {
    client,
    agent,
    push,
    assistant: { botId: assistant.bot.id, groupId: assistant.groupId },
    project: { groupId: group.group.id, memberIds },
    close: () => {
      agent.close();
      push.close();
    },
  };
}

async function bots(client: ApiClient) {
  return BotListResponse.parse(await (await client.get("/api/bots")).json()).items;
}

async function projectBotNames(s: Session): Promise<string[]> {
  const detail = GroupResponse.parse(await (await s.client.get(`/api/groups/${s.project.groupId}`)).json());
  return detail.bots.map((bot) => bot.name);
}

async function messagesOf(client: ApiClient, groupId: string) {
  return MessageListResponse.parse(await (await client.get(`/api/groups/${groupId}/messages`)).json()).messages;
}

async function nextOfType<T extends ServerPush["type"]>(push: PushClient, type: T) {
  for (let seen = 0; seen < 20; seen += 1) {
    const item = await push.next();
    if (item.type === type) return item as Extract<ServerPush, { type: T }>;
  }
  throw new Error(`等了 20 条推送都没有 ${type}`);
}

async function sendAndPrompt(s: Session, groupId: string, text: string): Promise<Prompt> {
  expect((await s.client.post(`/api/groups/${groupId}/messages`, { text })).status).toBe(201);
  return s.agent.expect("prompt");
}

/** run_done 之后控制面一定落一张花费卡，等到它就说明前面那条上行已经处理完了。 */
async function finishRun(s: Session, prompt: Prompt): Promise<void> {
  s.agent.send({
    type: "run_done",
    runId: prompt.runId,
    botId: prompt.botId,
    groupId: prompt.groupId,
    steps: 1,
    inputTokens: 0,
    outputTokens: 0,
  });
  for (;;) {
    const item = await nextOfType(s.push, "message");
    if (item.message.body.kind === "cost" && item.message.body.runId === prompt.runId) return;
  }
}

function sendOffer(s: Session, prompt: Prompt, members: Members, projectGroupId: GroupId = s.project.groupId): void {
  s.agent.send({
    type: "team_offer",
    runId: prompt.runId,
    botId: prompt.botId,
    groupId: prompt.groupId,
    projectGroupId,
    members,
  });
}

/** 跟主助理说一句，它出一张建队卡，这次活收尾。回的是推过来的那条卡。 */
async function offerCard(s: Session, members: Members): Promise<Message> {
  const prompt = await sendAndPrompt(s, s.assistant.groupId, "项目缺人，帮我补一下");
  expect(prompt.botId, "单聊里那句话归主助理").toBe(s.assistant.botId);
  sendOffer(s, prompt, members);
  let card: Message | null = null;
  while (card === null) {
    const item = await nextOfType(s.push, "message");
    if (item.message.body.kind === "team_offer") card = item.message;
  }
  await finishRun(s, prompt);
  return card;
}

function offerBody(message: Message): TeamOfferBody {
  if (message.body.kind !== "team_offer") throw new Error(`本应是建队卡，实际是 ${message.body.kind}`);
  return message.body;
}

async function decide(client: ApiClient, messageId: string, body: unknown) {
  return client.post(`/api/messages/${messageId}/team-offer`, body);
}

async function confirm(client: ApiClient, messageId: string, picked: number[]) {
  const response = await decide(client, messageId, { decision: "confirm", picked });
  expect(response.status).toBe(200);
  return DecideTeamOfferResponse.parse(await response.json());
}

async function cardNow(s: Session, card: Message): Promise<Message | undefined> {
  return (await messagesOf(s.client, s.assistant.groupId)).find((message) => message.id === card.id);
}

/** 测试自己开一个事务锁住一行，放行前别人要这行的写都排在它后面。 */
async function holdRow(lock: "project" | "counter", id: string) {
  let release!: () => void;
  let locked!: () => void;
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = observer.begin(async (tx) => {
    if (lock === "project") await tx`SELECT id FROM groups WHERE id = ${id} FOR UPDATE`;
    else await tx`SELECT user_id FROM user_counters WHERE user_id = ${id} FOR UPDATE`;
    locked();
    await gate;
  });
  await ready;
  return { release, done };
}

/** 等到这个测试库里有 count 个会话卡在行锁上，交错就是确定的。 */
async function lockWaiters(count: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const [row] = await observer<{ waiting: number }[]>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = ${database.databaseName} AND wait_event_type = 'Lock'`;
    if ((row?.waiting ?? 0) >= count) return;
  }
  throw new Error(`没等到 ${count} 个会话卡在行锁上`);
}

async function ownerOf(s: Session): Promise<string> {
  const [row] = await database.sql<{ owner_id: string }[]>`SELECT owner_id FROM bots WHERE id = ${s.assistant.botId}`;
  if (row === undefined) throw new Error("主助理应当有归属人");
  return row.owner_id;
}

async function outsider(s: Session, name: string): Promise<TeamOfferMember & { kind: "existing" }> {
  const created = CreateBotResponse.parse(await (await s.client.post("/api/bots", { name })).json());
  await s.agent.expect("config");
  return { kind: "existing", botId: created.bot.id, note: "", suggested: false };
}

async function pendingOffers(s: Session): Promise<string[]> {
  const today = TodayResponse.parse(await (await s.client.get("/api/today")).json());
  return today.pending.flatMap((item) => (item.kind === "team_offer" ? [item.message.id] : []));
}

/** 再开一个项目群：主助理加上 chief，并让主助理把 chief 设成首席。回的 Session 指向这个群。 */
async function projectWithChief(s: Session, title: string, chief: BotId): Promise<Session> {
  const created = CreateGroupResponse.parse(
    await (await s.client.post("/api/groups", { title, botIds: [s.assistant.botId, chief] })).json(),
  );
  const groupId = created.group.id;
  const prompt = await sendAndPrompt(s, groupId, "@主助理 设个首席");
  s.agent.send({ type: "set_chief", runId: prompt.runId, botId: prompt.botId, groupId, targetBotId: chief });
  expect((await nextOfType(s.push, "group_updated")).group.chiefBotId).toBe(chief);
  await finishRun(s, prompt);
  return { ...s, project: { groupId, memberIds: [chief] } };
}

describe("建队卡", () => {
  it("建队卡没确认时群成员不变", async () => {
    const s = await session();
    try {
      const botsBefore = (await bots(s.client)).length;
      const membersBefore = await projectBotNames(s);
      const card = await offerCard(s, [RESEARCHER]);
      expect(card.groupId, "卡落在主助理的单聊里").toBe(s.assistant.groupId);
      expect(card.body).toEqual({
        kind: "team_offer",
        botId: s.assistant.botId,
        members: [RESEARCHER],
        status: "offered",
        groupId: s.project.groupId,
      });
      expect(await projectBotNames(s), "项目群成员一个不多").toEqual(membersBefore);
      expect((await bots(s.client)).length, "也没有建 Bot").toBe(botsBefore);
    } finally {
      s.close();
    }
  });

  it("确认两次只加一次人", async () => {
    const s = await session();
    try {
      const botsBefore = (await bots(s.client)).length;
      const card = await offerCard(s, [RESEARCHER]);
      const responses = await Promise.all([
        decide(s.client, card.id, { decision: "confirm", picked: [0] }),
        decide(s.client, card.id, { decision: "confirm", picked: [0] }),
      ]);
      expect(responses.map((response) => response.status).toSorted(), "先到的确认，后到的撞上已确认回 409").toEqual([
        200, 409,
      ]);
      expect(await projectBotNames(s)).toEqual(["主助理", "小内", "小研"]);
      expect((await bots(s.client)).length, "小研只建了一个").toBe(botsBefore + 1);

      const again = await decide(s.client, card.id, { decision: "confirm", picked: [0] });
      expect(again.status, "过后再点还是 409").toBe(409);
      expect(await projectBotNames(s)).toEqual(["主助理", "小内", "小研"]);
      expect(offerBody((await cardNow(s, card)) ?? card).status).toBe("confirmed");
    } finally {
      s.close();
    }
  });

  it("新请的人重名自动避开", async () => {
    const s = await session(["小内", "小研"]);
    try {
      const card = await offerCard(s, [RESEARCHER]);
      const confirmed = await confirm(s.client, card.id, [0]);
      expect(
        confirmed.bots.map((bot) => bot.name),
        "已经有小研，新请的接序号",
      ).toEqual(["小研2"]);
      expect(await projectBotNames(s)).toEqual(["主助理", "小内", "小研", "小研2"]);
      expect(offerBody(confirmed.message), "卡上写回建出来的名字").toMatchObject({
        status: "confirmed",
        members: [{ ...RESEARCHER, name: "小研2" }],
      });
      expect((await bots(s.client)).map((entry) => entry.bot.name)).toEqual(["主助理", "小内", "小研", "小研2"]);
    } finally {
      s.close();
    }
  });

  it("勾掉的建议人选不加", async () => {
    const s = await session();
    try {
      const botsBefore = (await bots(s.client)).length;
      const card = await offerCard(s, [RESEARCHER, DESIGNER]);
      const confirmed = await confirm(s.client, card.id, [0]);
      expect(confirmed.bots.map((bot) => bot.name)).toEqual(["小研"]);
      expect(await projectBotNames(s), "没勾的小设不进群").toEqual(["主助理", "小内", "小研"]);
      expect((await bots(s.client)).length, "也不建").toBe(botsBefore + 1);
      expect(offerBody(confirmed.message).members, "卡上只留确认进来的人").toEqual([RESEARCHER]);
    } finally {
      s.close();
    }
  });

  it("加人后超过 6 个回 400 卡留在 offered", async () => {
    const s = await session(["小内", "小社", "小数", "小采"]);
    try {
      const botsBefore = (await bots(s.client)).length;
      const membersBefore = await projectBotNames(s);
      const card = await offerCard(s, [RESEARCHER, DESIGNER]);
      const response = await decide(s.client, card.id, { decision: "confirm", picked: [0, 1] });
      expect(response.status, "5 个再加 2 个就是 7 个").toBe(400);
      expect(((await response.json()) as { error: string }).error).toContain("6");
      expect(await projectBotNames(s)).toEqual(membersBefore);
      expect((await bots(s.client)).length, "回滚了，一个都没建").toBe(botsBefore);
      expect((await cardNow(s, card))?.body, "卡原样留着，还能少勾一个再确认").toEqual(card.body);

      const fewer = await confirm(s.client, card.id, [0]);
      expect(offerBody(fewer.message).status).toBe("confirmed");
      expect(await projectBotNames(s)).toHaveLength(6);
    } finally {
      s.close();
    }
  });

  it("队员发的 team_offer 静默丢弃", async () => {
    const s = await session();
    const [memberId] = s.project.memberIds;
    if (memberId === undefined) throw new Error("项目群里应当有一个队员");
    try {
      const solo = (await bots(s.client)).find((entry) => entry.bot.id === memberId);
      if (solo === undefined) throw new Error("队员应当有单聊");
      const prompt = await sendAndPrompt(s, solo.groupId, "项目缺人，帮我补一下");
      expect(prompt.botId).toBe(memberId);
      sendOffer(s, prompt, [RESEARCHER]);
      await finishRun(s, prompt);
      for (const groupId of [solo.groupId, s.assistant.groupId, s.project.groupId]) {
        const kinds = (await messagesOf(s.client, groupId)).map((message) => message.body.kind);
        expect(kinds, "哪个群里都不落建队卡").not.toContain("team_offer");
      }
    } finally {
      s.close();
    }
  });

  it("主助理在项目群里发、或目标不是自己的项目群，team_offer 也丢弃", async () => {
    const s = await session();
    const stranger = await session();
    try {
      const inProject = await sendAndPrompt(s, s.project.groupId, "@主助理 项目缺人");
      expect(inProject.botId).toBe(s.assistant.botId);
      sendOffer(s, inProject, [RESEARCHER]);
      await finishRun(s, inProject);

      const prompt = await sendAndPrompt(s, s.assistant.groupId, "项目缺人，帮我补一下");
      sendOffer(s, prompt, [RESEARCHER], s.assistant.groupId);
      sendOffer(s, prompt, [RESEARCHER], stranger.project.groupId);
      await finishRun(s, prompt);

      for (const groupId of [s.assistant.groupId, s.project.groupId]) {
        const kinds = (await messagesOf(s.client, groupId)).map((message) => message.body.kind);
        expect(kinds, "单聊和别人的群都不是项目群").not.toContain("team_offer");
      }
    } finally {
      s.close();
      stranger.close();
    }
  });

  it("确认后先推新人的 bot_created，再推 group_updated 和那条卡，新人进 config", async () => {
    const s = await session();
    try {
      const card = await offerCard(s, [
        RESEARCHER,
        { kind: "existing", botId: s.assistant.botId, note: "", suggested: false },
      ]);
      const confirmed = await confirm(s.client, card.id, [0, 1]);
      const [researcher] = confirmed.bots;
      if (researcher === undefined) throw new Error("确认后应当回新建的小研");
      expect(confirmed.bots, "主助理本来就在群里，不算新加的").toHaveLength(1);

      const created = await nextOfType(s.push, "bot_created");
      expect(created.bot).toEqual(researcher);
      expect(created.groupId, "带上新人的单聊群").not.toBe(s.project.groupId);
      const updated = await nextOfType(s.push, "group_updated");
      expect(updated.group).toEqual(confirmed.group);
      expect(confirmed.group?.botIds.at(-1)).toBe(researcher.id);
      const repushed = await nextOfType(s.push, "message");
      expect(repushed.message, "卡的状态住在正文里，点完重推").toEqual(confirmed.message);

      const config = await s.agent.expect("config");
      expect(config.bots.map((bot) => bot.name)).toContain("小研");
    } finally {
      s.close();
    }
  });

  it("先放着之后卡还在首页等你确认，确认后从首页消失", async () => {
    const s = await session();
    try {
      const card = await offerCard(s, [RESEARCHER]);
      const pending = async () =>
        TodayResponse.parse(await (await s.client.get("/api/today")).json()).pending.filter(
          (item) => item.kind === "team_offer",
        );
      expect(await pending()).toEqual([{ kind: "team_offer", since: card.createdAt, message: card }]);

      const deferred = await decide(s.client, card.id, { decision: "defer" });
      expect(deferred.status).toBe(200);
      const body = DecideTeamOfferResponse.parse(await deferred.json());
      expect(body.group).toBeNull();
      expect(body.bots).toEqual([]);
      expect(offerBody(body.message).status).toBe("deferred");
      expect((await nextOfType(s.push, "message")).message).toEqual(body.message);
      expect(await projectBotNames(s), "先放着不加人").toEqual(["主助理", "小内"]);
      expect((await pending()).map((item) => item.kind === "team_offer" && item.message)).toEqual([body.message]);

      await confirm(s.client, card.id, [0]);
      expect(await pending(), "确认过的卡不再等你").toEqual([]);
    } finally {
      s.close();
    }
  });

  it("别人的建队卡、不是建队卡的消息 404，勾了卡上没有的人 400", async () => {
    const s = await session();
    const stranger = await session();
    try {
      const card = await offerCard(s, [RESEARCHER]);
      expect((await decide(stranger.client, card.id, { decision: "defer" })).status).toBe(404);
      const [greeting] = await messagesOf(s.client, s.assistant.groupId);
      if (greeting === undefined) throw new Error("主助理单聊里没有第一句");
      expect((await decide(s.client, greeting.id, { decision: "defer" })).status).toBe(404);
      expect((await decide(s.client, card.id, { decision: "confirm", picked: [1] })).status).toBe(400);
      expect((await decide(s.client, card.id, { decision: "confirm", picked: [] })).status).toBe(400);
      expect((await cardNow(s, card))?.body).toEqual(card.body);
    } finally {
      s.close();
      stranger.close();
    }
  });
  it("确认时目标项目群已经删空回 404，卡原样留着还能再确认", async () => {
    const s = await session(["甲", "乙"]);
    try {
      const created = CreateGroupResponse.parse(
        await (await s.client.post("/api/groups", { title: "没有主助理", botIds: s.project.memberIds })).json(),
      );
      const target: Session = { ...s, project: { groupId: created.group.id, memberIds: s.project.memberIds } };
      const [first] = s.project.memberIds;
      if (first === undefined) throw new Error("应当有队员");
      const card = await offerCard(target, [
        { kind: "existing", botId: first, note: "", suggested: false },
        RESEARCHER,
      ]);
      const botsBefore = (await bots(s.client)).length;
      for (const id of s.project.memberIds) expect((await s.client.delete(`/api/bots/${id}`)).status).toBe(204);
      expect((await s.client.get(`/api/groups/${created.group.id}`)).status, "删空的群对外就是不存在").toBe(404);

      const response = await decide(s.client, card.id, { decision: "confirm", picked: [1] });
      expect(response.status, "项目没了是业务结果，不是先提交再 500").toBe(404);
      expect((await cardNow(s, card))?.body, "整个事务回滚，卡还是 offered").toEqual(card.body);
      expect((await bots(s.client)).length, "新人也没建").toBe(botsBefore - 2);

      const deferred = await decide(s.client, card.id, { decision: "defer" });
      expect(deferred.status).toBe(200);
      const again = await decide(s.client, card.id, { decision: "confirm", picked: [1] });
      expect(again.status, "还能再确认，不是 409 已确认").toBe(404);
      expect(offerBody((await cardNow(s, card)) ?? card).status, "先放着的卡回滚后还是先放着").toBe("deferred");
    } finally {
      s.close();
    }
  });

  it("勾的已有 Bot 已经删了回 409，卡和群原样，重勾能确认", async () => {
    const s = await session();
    try {
      const gone = await outsider(s, "小采");
      const card = await offerCard(s, [gone, RESEARCHER]);
      expect((await s.client.delete(`/api/bots/${gone.botId}`)).status).toBe(204);
      const botsBefore = (await bots(s.client)).length;

      const response = await decide(s.client, card.id, { decision: "confirm", picked: [0, 1] });
      expect(response.status, "不静默跳过已删的人").toBe(409);
      expect(((await response.json()) as { error: string }).error).toBe("卡上第 1 位已经不在了，重新勾一下");
      expect(await projectBotNames(s), "群原样").toEqual(["主助理", "小内"]);
      expect((await bots(s.client)).length, "勾着的新人也没建").toBe(botsBefore);
      expect((await cardNow(s, card))?.body, "卡原样").toEqual(card.body);

      const retry = await confirm(s.client, card.id, [1]);
      expect(retry.bots.map((bot) => bot.name)).toEqual(["小研"]);
      expect(offerBody(retry.message).members).toEqual([RESEARCHER]);
    } finally {
      s.close();
    }
  });

  it("确认还在等群锁时就已经锁住勾选的已有 Bot，这时删它要排在确认后面", async () => {
    const s = await session();
    try {
      const joining = await outsider(s, "小采");
      const card = await offerCard(s, [joining, RESEARCHER]);
      const lock = await holdRow("project", s.project.groupId);
      try {
        const confirming = decide(s.client, card.id, { decision: "confirm", picked: [0, 1] });
        await lockWaiters(1);
        const deleting = s.client.delete(`/api/bots/${joining.botId}`);
        await lockWaiters(2);
        lock.release();
        await lock.done;
        const [confirmed, deleted] = await Promise.all([confirming, deleting]);
        expect([confirmed.status, deleted.status], "Bot 锁在群锁之前，删除等确认提交").toEqual([200, 204]);
        const body = DecideTeamOfferResponse.parse(await confirmed.json());
        expect(body.bots.map((bot) => bot.name)).toEqual(["小采", "小研"]);
        expect(body.group?.botIds, "回包的群里小采还在").toContain(joining.botId);
      } finally {
        lock.release();
        await lock.done;
      }
      expect(await projectBotNames(s), "小采进群之后才被删").toEqual(["主助理", "小内", "小研"]);
    } finally {
      s.close();
    }
  });

  it("确认锁住要入群的已有 Bot 之后再删它，删除等确认提交，不死锁也不 500", async () => {
    const s = await session();
    try {
      const joining = await outsider(s, "小采");
      const card = await offerCard(s, [joining, RESEARCHER]);
      const lock = await holdRow("counter", await ownerOf(s));
      try {
        const confirming = decide(s.client, card.id, { decision: "confirm", picked: [0, 1] });
        await lockWaiters(1);
        const deleting = s.client.delete(`/api/bots/${joining.botId}`);
        await lockWaiters(2);
        lock.release();
        await lock.done;
        const [confirmed, deleted] = await Promise.all([confirming, deleting]);
        expect([confirmed.status, deleted.status], "确认先提交，删除排在它后面").toEqual([200, 204]);
        const body = DecideTeamOfferResponse.parse(await confirmed.json());
        expect(body.bots.map((bot) => bot.name)).toEqual(["小采", "小研"]);
      } finally {
        lock.release();
        await lock.done;
      }
      expect(await projectBotNames(s), "确认加进来的小采随后被删").toEqual(["主助理", "小内", "小研"]);
    } finally {
      s.close();
    }
  });

  it("群内的勾选成员确认中被删，删除等确认提交，卡上的人和回包的群一致", async () => {
    const s = await session();
    try {
      const [insider] = s.project.memberIds;
      if (insider === undefined) throw new Error("项目群里应当有一个队员");
      const member = { kind: "existing", botId: insider, note: "已在群里", suggested: false } satisfies TeamOfferMember;
      const card = await offerCard(s, [member, RESEARCHER]);
      const lock = await holdRow("counter", await ownerOf(s));
      try {
        const confirming = decide(s.client, card.id, { decision: "confirm", picked: [0, 1] });
        await lockWaiters(1);
        const deleting = s.client.delete(`/api/bots/${insider}`);
        await lockWaiters(2);
        lock.release();
        await lock.done;
        const [confirmed, deleted] = await Promise.all([confirming, deleting]);
        expect([confirmed.status, deleted.status], "已在群里的勾选成员也锁住，删除排在确认后面").toEqual([200, 204]);
        const body = DecideTeamOfferResponse.parse(await confirmed.json());
        const [researcher] = body.bots;
        if (researcher === undefined) throw new Error("确认后应当回新建的小研");
        expect(body.group?.botIds, "回包的群里还有小内").toEqual([s.assistant.botId, insider, researcher.id]);
        expect(offerBody(body.message).members, "卡上的人和回包的群一致").toEqual([member, RESEARCHER]);
      } finally {
        lock.release();
        await lock.done;
      }
      expect(await projectBotNames(s), "小内随后才被删").toEqual(["主助理", "小研"]);
    } finally {
      s.close();
    }
  });

  it("两个项目互邀对方的首席，确认和删首席四方交错不死锁", async () => {
    const s = await session(["甲", "乙"]);
    try {
      const [x, y] = s.project.memberIds;
      if (x === undefined || y === undefined) throw new Error("应当有两个队员");
      const a = await projectWithChief(s, "A 项目", x);
      const b = await projectWithChief(s, "B 项目", y);
      const cardA = await offerCard(a, [{ kind: "existing", botId: y, note: "B 的首席", suggested: false }]);
      const cardB = await offerCard(b, [{ kind: "existing", botId: x, note: "A 的首席", suggested: false }]);
      const lockA = await holdRow("project", a.project.groupId);
      const lockB = await holdRow("project", b.project.groupId);
      try {
        const confirming = [
          decide(s.client, cardA.id, { decision: "confirm", picked: [0] }),
          decide(s.client, cardB.id, { decision: "confirm", picked: [0] }),
        ];
        await lockWaiters(2);
        const deleting = [s.client.delete(`/api/bots/${x}`), s.client.delete(`/api/bots/${y}`)];
        await lockWaiters(4);
        lockA.release();
        lockB.release();
        await Promise.all([lockA.done, lockB.done]);
        const statuses = (await Promise.all([...confirming, ...deleting])).map((response) => response.status);
        expect(statuses, "两张卡都确认成功，两个首席之后才被删，没有一方被数据库挑成死锁牺牲品").toEqual([
          200, 200, 204, 204,
        ]);
      } finally {
        lockA.release();
        lockB.release();
        await Promise.all([lockA.done, lockB.done]);
      }
      expect(offerBody((await cardNow(s, cardA)) ?? cardA).status).toBe("confirmed");
      expect(offerBody((await cardNow(s, cardB)) ?? cardB).status).toBe("confirmed");
      expect(await projectBotNames(a), "乙进了 A 再被删，甲也被删").toEqual(["主助理"]);
      expect(await projectBotNames(b)).toEqual(["主助理"]);
    } finally {
      s.close();
    }
  });

  it("目标项目群已经删空，主助理有效的上行也不落建队卡", async () => {
    const s = await session(["甲", "乙"]);
    try {
      const created = CreateGroupResponse.parse(
        await (await s.client.post("/api/groups", { title: "将删空", botIds: s.project.memberIds })).json(),
      );
      for (const id of s.project.memberIds) {
        expect((await s.client.delete(`/api/bots/${id}`)).status).toBe(204);
        await s.agent.expect("config");
      }
      expect((await s.client.get(`/api/groups/${created.group.id}`)).status, "删空的群对外就是不存在").toBe(404);

      const prompt = await sendAndPrompt(s, s.assistant.groupId, "给那个群补人");
      sendOffer(s, prompt, [RESEARCHER], created.group.id);
      await finishRun(s, prompt);
      const kinds = (await messagesOf(s.client, s.assistant.groupId)).map((message) => message.body.kind);
      expect(kinds, "指向删空群的卡永远确认不了，不落").not.toContain("team_offer");
      expect(await pendingOffers(s), "首页也没有这张待办").toEqual([]);
    } finally {
      s.close();
    }
  });

  it("先放着的建队卡排到仍待处理的项之后，各组按来的先后", async () => {
    const s = await session();
    try {
      const oldest = await offerCard(s, [RESEARCHER]);
      const middle = await offerCard(s, [DESIGNER]);
      const newest = await offerCard(s, [{ ...RESEARCHER, name: "小采" }]);
      expect(await pendingOffers(s)).toEqual([oldest.id, middle.id, newest.id]);
      for (const card of [middle, oldest]) {
        expect((await decide(s.client, card.id, { decision: "defer" })).status).toBe(200);
      }
      expect(await pendingOffers(s), "先放着的不再排在前面").toEqual([newest.id, oldest.id, middle.id]);
    } finally {
      s.close();
    }
  });

  it("两个项目外的已有 Bot 勾甲不勾乙，乙不进群", async () => {
    const s = await session();
    try {
      const picked = await outsider(s, "甲");
      const skipped = await outsider(s, "乙");
      const botsBefore = (await bots(s.client)).length;
      const card = await offerCard(s, [picked, skipped]);
      const confirmed = await confirm(s.client, card.id, [0]);
      expect(confirmed.bots.map((bot) => bot.id)).toEqual([picked.botId]);
      expect(await projectBotNames(s), "没勾的乙不进群").toEqual(["主助理", "小内", "甲"]);
      expect((await bots(s.client)).length, "已有的人入群不建 Bot").toBe(botsBefore);
      expect(offerBody(confirmed.message).members, "卡上只留勾的甲").toEqual([picked]);
    } finally {
      s.close();
    }
  });

  it("同一个五人群两张卡同时各加一人，只成一张，另一张原样回 400", async () => {
    const s = await session(["小内", "小社", "小数", "小采"]);
    try {
      const first = await offerCard(s, [RESEARCHER]);
      const second = await offerCard(s, [DESIGNER]);
      const botsBefore = (await bots(s.client)).length;
      const lock = await holdRow("project", s.project.groupId);
      try {
        const a = decide(s.client, first.id, { decision: "confirm", picked: [0] });
        await lockWaiters(1);
        const b = decide(s.client, second.id, { decision: "confirm", picked: [0] });
        await lockWaiters(2);
        lock.release();
        await lock.done;
        const statuses = (await Promise.all([a, b])).map((response) => response.status);
        expect(statuses, "两张卡在同一把群锁上排队，后到的数到 6 人").toEqual([200, 400]);
      } finally {
        lock.release();
        await lock.done;
      }
      expect(await projectBotNames(s)).toHaveLength(6);
      expect((await cardNow(s, second))?.body, "失败的卡原样").toEqual(second.body);
      expect((await bots(s.client)).length, "只多一个 Bot").toBe(botsBefore + 1);
    } finally {
      s.close();
    }
  });

  it("只勾新人的确认、拉首席建另一群、删首席三方交错不死锁", async () => {
    const s = await session(["甲"]);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const [x] = s.project.memberIds;
      if (x === undefined) throw new Error("应当有一个队员");
      const g = await projectWithChief(s, "G 项目", x);
      const card = await offerCard(g, [RESEARCHER]);

      // 确认持着 G、停在发号器前；删 x 持着 x 行、级联置空 G 的首席时等 G；建群要 x 的 KEY SHARE，等删除。
      // 建群若先拿发号器再等 x，确认放行后等发号器，三方成环。
      const claiming = sqlGate.arm(CLAIM_COUNTER, "before");
      const confirming = decide(s.client, card.id, { decision: "confirm", picked: [0] });
      await within(claiming.reached, "确认走到发号器前");
      try {
        const deleting = s.client.delete(`/api/bots/${x}`);
        await lockWaiters(1);
        const creating = s.client.post("/api/groups", { title: "再拉一群", botIds: [s.assistant.botId, x] });
        await lockWaiters(2);
        claiming.release();
        const responses = await Promise.all([confirming, deleting, creating]);
        expect(
          { statuses: responses.map((response) => response.status), deadlocks: errorLog(logged).match(/40P01/g) ?? [] },
          "确认成功，删除排在它后面，建群醒来发现 x 已删回 404；没有一方被挑成死锁牺牲品，日志里没有 40P01",
        ).toEqual({ statuses: [200, 204, 404], deadlocks: [] });
      } finally {
        claiming.release();
      }
      expect(offerBody((await cardNow(s, card)) ?? card).status).toBe("confirmed");
      expect(await projectBotNames(g), "小研进了 G，x 随后被删").toEqual(["主助理", "小研"]);
    } finally {
      logged.mockRestore();
      s.close();
    }
  });

  it("上行校验过了、落卡前目标群被删空，卡不落、首页待办不增", async () => {
    const s = await session(["甲", "乙"]);
    try {
      const created = CreateGroupResponse.parse(
        await (await s.client.post("/api/groups", { title: "将删空", botIds: s.project.memberIds })).json(),
      );
      const prompt = await sendAndPrompt(s, s.assistant.groupId, "给那个群补人");
      const locking = sqlGate.arm(LOCK_OPEN_RUN, "before");
      sendOffer(s, prompt, [RESEARCHER], created.group.id);
      await within(locking.reached, "上行走到落卡事务");
      try {
        for (const id of s.project.memberIds) {
          expect((await s.client.delete(`/api/bots/${id}`)).status).toBe(204);
          await s.agent.expect("config");
        }
        expect((await s.client.get(`/api/groups/${created.group.id}`)).status, "删空的群对外就是不存在").toBe(404);
      } finally {
        locking.release();
      }
      await finishRun(s, prompt);
      const kinds = (await messagesOf(s.client, s.assistant.groupId)).map((message) => message.body.kind);
      expect(kinds, "落卡事务里重验目标，已删空就不落").not.toContain("team_offer");
      expect(await pendingOffers(s), "首页也没有这张待办").toEqual([]);
    } finally {
      s.close();
    }
  });

  it("卡落下之后目标群才删空，首页不再列它，确认回 404", async () => {
    const s = await session(["甲", "乙"]);
    try {
      const created = CreateGroupResponse.parse(
        await (await s.client.post("/api/groups", { title: "将删空", botIds: s.project.memberIds })).json(),
      );
      const target: Session = { ...s, project: { groupId: created.group.id, memberIds: s.project.memberIds } };
      const card = await offerCard(target, [RESEARCHER]);
      expect(await pendingOffers(s), "目标还在时首页列着它").toEqual([card.id]);
      for (const id of s.project.memberIds) {
        expect((await s.client.delete(`/api/bots/${id}`)).status).toBe(204);
        await s.agent.expect("config");
      }
      expect(await pendingOffers(s), "目标删空后首页不列确认不了的卡").toEqual([]);
      expect(offerBody((await cardNow(s, card)) ?? card).status, "单聊里那条卡还在，只是不上首页").toBe("offered");
      expect((await decide(s.client, card.id, { decision: "confirm", picked: [0] })).status).toBe(404);
    } finally {
      s.close();
    }
  });

  it("落卡事务校验过目标群之后删它的成员，删除要等卡落下；落下后目标删空，首页不列、确认回 404", async () => {
    const s = await session(["甲", "乙"]);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const [first, second] = s.project.memberIds;
      if (first === undefined || second === undefined) throw new Error("应当有两个队员");
      const created = CreateGroupResponse.parse(
        await (await s.client.post("/api/groups", { title: "将删空", botIds: s.project.memberIds })).json(),
      );
      const prompt = await sendAndPrompt(s, s.assistant.groupId, "给那个群补人");
      // 停在重查目标群那条跑完之后：校验看到群还在，成员的 KEY SHARE 已在手里，删成员只能排在卡落下之后。
      const checking = sqlGate.arm(FIND_PROJECT_GROUP, "after");
      sendOffer(s, prompt, [RESEARCHER], created.group.id);
      await within(checking.reached, "落卡事务查完目标群");
      const deleting = s.client.delete(`/api/bots/${first}`);
      try {
        await lockWaiters(1);
      } finally {
        checking.release();
      }
      expect((await deleting).status, "卡落下之后删除才进行").toBe(204);
      await s.agent.expect("config");
      expect((await s.client.delete(`/api/bots/${second}`)).status).toBe(204);
      await s.agent.expect("config");
      await finishRun(s, prompt);
      const card = (await messagesOf(s.client, s.assistant.groupId)).find(
        (message) => message.body.kind === "team_offer",
      );
      if (card === undefined) throw new Error("校验时目标还在，卡应当落下");
      expect(offerBody(card).status).toBe("offered");
      expect(await pendingOffers(s), "目标随后删空，首页不列它").toEqual([]);
      expect((await decide(s.client, card.id, { decision: "confirm", picked: [0] })).status).toBe(404);
      expect(errorLog(logged), "删除排队等卡，没有一方被挑成死锁牺牲品").not.toContain("40P01");
    } finally {
      logged.mockRestore();
      s.close();
    }
  });

  it("落卡事务读完目标群成员、锁之前被删空，锁到的是空集，重查看到删空，卡不落", async () => {
    const s = await session(["甲", "乙"]);
    try {
      const created = CreateGroupResponse.parse(
        await (await s.client.post("/api/groups", { title: "将删空", botIds: s.project.memberIds })).json(),
      );
      const prompt = await sendAndPrompt(s, s.assistant.groupId, "给那个群补人");
      const reading = sqlGate.arm(READ_TARGET_MEMBERS, "after");
      sendOffer(s, prompt, [RESEARCHER], created.group.id);
      await within(reading.reached, "落卡事务读完目标群成员");
      try {
        for (const id of s.project.memberIds) {
          expect((await s.client.delete(`/api/bots/${id}`)).status, "锁还没拿，删除不用等").toBe(204);
          await s.agent.expect("config");
        }
        expect((await s.client.get(`/api/groups/${created.group.id}`)).status).toBe(404);
      } finally {
        reading.release();
      }
      await finishRun(s, prompt);
      const kinds = (await messagesOf(s.client, s.assistant.groupId)).map((message) => message.body.kind);
      expect(kinds, "锁之后的重查看到目标已删空，不落卡").not.toContain("team_offer");
      expect(await pendingOffers(s)).toEqual([]);
    } finally {
      s.close();
    }
  });

  it("落卡事务校验过候选归属之后删这个候选，删除要等卡落下；落下后候选没了，卡留在首页、确认回 409", async () => {
    const s = await session();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const candidate = await outsider(s, "丙");
      const prompt = await sendAndPrompt(s, s.assistant.groupId, "把丙拉进来");
      const checking = sqlGate.arm(OWNS_ALL_BOTS, "after");
      sendOffer(s, prompt, [candidate]);
      await within(checking.reached, "落卡事务查完候选归属");
      const deleting = s.client.delete(`/api/bots/${candidate.botId}`);
      try {
        await lockWaiters(1);
      } finally {
        checking.release();
      }
      expect((await deleting).status, "卡落下之后删除才进行").toBe(204);
      await s.agent.expect("config");
      await finishRun(s, prompt);
      const card = (await messagesOf(s.client, s.assistant.groupId)).find(
        (message) => message.body.kind === "team_offer",
      );
      if (card === undefined) throw new Error("校验时候选还在，卡应当落下");
      expect(offerBody(card)).toMatchObject({ status: "offered", members: [candidate] });
      // 已知缺口：候选全被删之后这张卡清不掉，首页照列，确认永远 409。这里钉的是现状，改了这条就要改首页的过滤。
      expect(await pendingOffers(s), "候选被删的卡仍列在首页").toEqual([card.id]);
      expect((await decide(s.client, card.id, { decision: "confirm", picked: [0] })).status).toBe(409);
      expect(offerBody((await cardNow(s, card)) ?? card).status).toBe("offered");
      expect(errorLog(logged), "删除排队等卡，没有一方被挑成死锁牺牲品").not.toContain("40P01");
    } finally {
      logged.mockRestore();
      s.close();
    }
  });

  it("落卡事务读完目标群成员之后成员被整批换掉，换上来的人也锁住，删它要等卡落下", async () => {
    const s = await session(["甲", "乙"]);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const created = CreateGroupResponse.parse(
        await (await s.client.post("/api/groups", { title: "将换人", botIds: s.project.memberIds })).json(),
      );
      const target: Session = { ...s, project: { groupId: created.group.id, memberIds: s.project.memberIds } };
      const substitute = await outsider(s, "替补");
      const earlier = await offerCard(target, [substitute]);
      const prompt = await sendAndPrompt(s, s.assistant.groupId, "给那个群补人");
      const reading = sqlGate.arm(READ_TARGET_MEMBERS, "after");
      sendOffer(s, prompt, [RESEARCHER], created.group.id);
      await within(reading.reached, "落卡事务读完目标群成员");
      const checking = sqlGate.arm(FIND_PROJECT_GROUP, "after");
      try {
        await confirm(s.client, earlier.id, [0]);
        for (const id of s.project.memberIds) {
          expect((await s.client.delete(`/api/bots/${id}`)).status, "读到的那批成员还没锁，删除不用等").toBe(204);
          await s.agent.expect("config");
        }
        expect(await projectBotNames(target), "目标群整批换成了替补").toEqual(["替补"]);
      } finally {
        reading.release();
      }
      await within(checking.reached, "落卡事务查完目标群");
      const deleting = s.client.delete(`/api/bots/${substitute.botId}`);
      try {
        await lockWaiters(1);
      } finally {
        checking.release();
      }
      expect((await deleting).status, "卡落下之后删除才进行").toBe(204);
      await s.agent.expect("config");
      await finishRun(s, prompt);
      const card = (await messagesOf(s.client, s.assistant.groupId)).find(
        (message) => message.body.kind === "team_offer" && message.id !== earlier.id,
      );
      if (card === undefined) throw new Error("校验时替补还在群里，卡应当落下");
      expect(offerBody(card).status).toBe("offered");
      expect(await pendingOffers(s), "目标随后删空，首页不列它").toEqual([]);
      expect((await decide(s.client, card.id, { decision: "confirm", picked: [0] })).status).toBe(404);
      expect(errorLog(logged), "删除排队等卡，没有一方被挑成死锁牺牲品").not.toContain("40P01");
    } finally {
      logged.mockRestore();
      s.close();
    }
  });

  it("先放着的建队卡攒满 50 张，更新的审批照样留在首页，排在它们前面", async () => {
    const s = await session();
    try {
      const prompt = await sendAndPrompt(s, s.assistant.groupId, "项目缺人，帮我补一下");
      for (let at = 0; at < 50; at += 1) sendOffer(s, prompt, [{ ...RESEARCHER, name: `小研${at}` }]);
      const cards: Message[] = [];
      while (cards.length < 50) {
        const item = await nextOfType(s.push, "message");
        if (item.message.body.kind === "team_offer") cards.push(item.message);
      }
      for (const card of cards) {
        expect((await decide(s.client, card.id, { decision: "defer" })).status).toBe(200);
      }
      s.agent.send({
        type: "approval_request",
        runId: prompt.runId,
        botId: prompt.botId,
        groupId: prompt.groupId,
        callId: "call-1",
        tool: "shop.refund",
        action: "spend",
        target: null,
        view: { kind: "mcp", server: "", tool: "shop.refund", params: [], raw: "给这单退 120 块" },
      });
      let raised: Extract<ServerPush, { type: "approval_updated" }> | null = null;
      while (raised === null) {
        const item = await s.push.next();
        if (item.type === "approval_updated") raised = item;
      }
      const today = TodayResponse.parse(await (await s.client.get("/api/today")).json());
      expect(today.pending, "超过 50 条留最新的 50 条").toHaveLength(50);
      expect(today.pending[0], "最新的审批留下，排在先放着的卡前面").toMatchObject({
        kind: "approval",
        approval: { id: raised.approval.id },
      });
      expect(today.pending.slice(1).map((item) => item.kind)).toEqual(Array(49).fill("team_offer"));
    } finally {
      s.close();
    }
  });

  it("先放着再确认，每改一次状态 revision 都涨", async () => {
    const s = await session();
    try {
      const card = await offerCard(s, [RESEARCHER]);
      const deferred = DecideTeamOfferResponse.parse(
        await (await decide(s.client, card.id, { decision: "defer" })).json(),
      ).message;
      const confirmed = (await confirm(s.client, card.id, [0])).message;
      // Web 只肯用 revision 更大的那份覆盖手里的卡，回包 revision 不涨，先放着和确认在页面上就落不下。
      expect([card.revision, deferred.revision, confirmed.revision], "三份回包的 revision 严格递增").toSatisfy(
        (revisions: number[]) => revisions.every((revision, at) => at === 0 || revision > (revisions[at - 1] ?? 0)),
      );
    } finally {
      s.close();
    }
  });

  it("同群两张卡都确认成功，先提交的那次回执晚到，最后推的群也不少人", async () => {
    const s = await session();
    let releaseA!: () => void;
    const receiptA = new Promise<void>((resolve) => (releaseA = resolve));
    let delayed: { mockRestore(): void } | null = null;
    try {
      const cardA = await offerCard(s, [RESEARCHER]);
      const cardB = await offerCard(s, [DESIGNER]);
      const transaction = sqlGate.db.transaction.bind(sqlGate.db);
      let committedA!: () => void;
      const reachedA = new Promise<void>((resolve) => (committedA = resolve));
      // A 的事务已经提交、群锁已放，结果扣着不交回路由。
      delayed = vi
        .spyOn(sqlGate.db, "transaction")
        .mockImplementationOnce(async (...args: Parameters<typeof transaction>) => {
          const result = await transaction(...args);
          committedA();
          await receiptA;
          return result;
        });
      const confirmingA = decide(s.client, cardA.id, { decision: "confirm", picked: [0] });
      await within(reachedA, "A 的确认已提交");
      const confirmedB = await confirm(s.client, cardB.id, [0]);
      releaseA();
      expect((await confirmingA).status).toBe(200);
      const persisted = GroupResponse.parse(await (await s.client.get(`/api/groups/${s.project.groupId}`)).json());
      expect(persisted.group.botIds, "两张卡各加一人").toHaveLength(4);
      const pushed = [await nextOfType(s.push, "group_updated"), await nextOfType(s.push, "group_updated")];
      expect(pushed.at(-1)?.group.botIds, "最后一次群推送就是库里的成员").toEqual(persisted.group.botIds);
      expect(confirmedB.group?.botIds).toEqual(persisted.group.botIds);
    } finally {
      releaseA();
      delayed?.mockRestore();
      s.close();
    }
  });

  it("同群两张卡都确认成功，先提交的那次读群晚到，最后推的群也不少人", async () => {
    const s = await session();
    const held: { gate: ReturnType<typeof sqlGate.arm> | null } = { gate: null };
    let delayed: { mockRestore(): void } | null = null;
    try {
      const cardA = await offerCard(s, [RESEARCHER]);
      const cardB = await offerCard(s, [DESIGNER]);
      const transaction = sqlGate.db.transaction.bind(sqlGate.db);
      let committedA!: () => void;
      const reachedA = new Promise<void>((resolve) => (committedA = resolve));
      let committedB!: () => void;
      const reachedB = new Promise<void>((resolve) => (committedB = resolve));
      delayed = vi
        .spyOn(sqlGate.db, "transaction")
        .mockImplementationOnce(async (...args: Parameters<typeof transaction>) => {
          const result = await transaction(...args);
          // A 提交之后下一条读群成员停住：读到的是 3 人，结果扣着不交回。
          held.gate = sqlGate.arm(READ_GROUP_BOTS, "after");
          committedA();
          return result;
        })
        .mockImplementationOnce(async (...args: Parameters<typeof transaction>) => {
          const result = await transaction(...args);
          committedB();
          return result;
        });
      const confirmingA = decide(s.client, cardA.id, { decision: "confirm", picked: [0] });
      await within(reachedA, "A 的确认已提交");
      const gate = held.gate;
      if (gate === null) throw new Error("A 提交后应当布好读群的屏障");
      await within(gate.reached, "A 提交之后读完群成员");
      const confirmingB = decide(s.client, cardB.id, { decision: "confirm", picked: [0] });
      await within(reachedB, "B 的确认已提交");
      gate.release();
      expect((await confirmingA).status).toBe(200);
      expect((await confirmingB).status).toBe(200);
      const persisted = GroupResponse.parse(await (await s.client.get(`/api/groups/${s.project.groupId}`)).json());
      expect(persisted.group.botIds, "两张卡各加一人").toHaveLength(4);
      const pushed = [await nextOfType(s.push, "group_updated"), await nextOfType(s.push, "group_updated")];
      expect(pushed.at(-1)?.group.botIds, "最后一次群推送就是库里的成员").toEqual(persisted.group.botIds);
    } finally {
      held.gate?.release();
      delayed?.mockRestore();
      s.close();
    }
  });
});

/** 屏障没在 5 秒内到达就是交错没按预期走，报出来而不是等 vitest 超时。 */
async function within(reached: Promise<void>, what: string): Promise<void> {
  let arrived = false;
  void reached.then(() => (arrived = true));
  await waitFor(async () => arrived, what);
}

/** console.error 收到的每个参数：Error 带上 PostgresError 的 code，死锁的 40P01 只在 code 里。 */
function errorLog(logged: { mock: { calls: unknown[][] } }): string {
  return logged.mock.calls
    .flat()
    .map((arg) => (arg instanceof Error ? `${arg.message} ${(arg as { code?: string }).code ?? ""}` : String(arg)))
    .join("\n");
}
