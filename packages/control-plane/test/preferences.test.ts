import {
  BotProfileResponse,
  CreateBotResponse,
  CreateGroupResponse,
  DecidePreferenceOfferResponse,
  MessageListResponse,
  PreferenceListResponse,
  PreferenceResponse,
  type BotId,
  type ControlToAgent,
  type GroupId,
  type Message,
  type MessageBody,
  type MessageId,
  type Preference,
  type RunId,
  type ServerPush,
} from "@baize/shared";
import { afterAll, beforeAll, expect, it } from "vitest";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { startTestServer, type ApiClient, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, waitFor, type TestComputer } from "./helpers/fixtures.js";
import { gatedDb } from "./helpers/gated-db.js";
import {
  decidePreferenceOffer,
  offerPreference,
  savePreferenceOffer,
  sendPreferenceOffer,
} from "./helpers/preference-offer.js";
import { connectPush, type PushClient } from "./helpers/ws.js";

let database: TestDb;
let gates: ReturnType<typeof gatedDb>;
let server: TestServer;

beforeAll(async () => {
  database = await createTestDb();
  gates = gatedDb(database.sql);
  server = await startTestServer(gates.db);
});

afterAll(async () => {
  await server.close();
  await database.close();
});

type Owner = {
  readonly client: ApiClient;
  readonly computer: TestComputer;
  readonly groupId: GroupId;
  readonly botId: BotId;
};

async function ownerWithBot(): Promise<Owner> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小服" })).json());
  return { client, computer, groupId: created.group.id, botId: created.bot.id };
}

async function addBot(owner: Owner, name: string): Promise<BotId> {
  const response = await owner.client.post("/api/bots", { name });
  expect(response.status).toBe(201);
  return CreateBotResponse.parse(await response.json()).bot.id;
}

async function openProject(owner: Owner, title: string, botIds: BotId[]): Promise<GroupId> {
  const response = await owner.client.post("/api/groups", { title, botIds });
  expect(response.status).toBe(201);
  return CreateGroupResponse.parse(await response.json()).group.id;
}

async function online(owner: Owner): Promise<AgentClient> {
  const { agent } = await helloAgent(server.server.port, owner.computer.computerId, owner.computer.token);
  return agent;
}

async function watch(owner: Owner): Promise<PushClient> {
  const cookie = owner.client.cookie;
  if (cookie === null) throw new Error("还没登录，没有 cookie 可以连推送");
  return connectPush(server.server.port, cookie);
}

async function pushUntil<T extends ServerPush["type"]>(
  push: PushClient,
  type: T,
): Promise<Extract<ServerPush, { type: T }>> {
  for (let seen = 0; seen < 20; seen += 1) {
    const one = await push.next();
    if (one.type === type) return one as Extract<ServerPush, { type: T }>;
  }
  throw new Error(`推送里一直没有要的 ${type}`);
}

async function agentUntil<T extends ControlToAgent["type"]>(
  agent: AgentClient,
  type: T,
): Promise<Extract<ControlToAgent, { type: T }>> {
  for (let seen = 0; seen < 20; seen += 1) {
    const one = await agent.next();
    if (one.type === type) return one as Extract<ControlToAgent, { type: T }>;
  }
  throw new Error(`下发的报文里一直没有要的 ${type}`);
}

/** 在某个群里说一句，拿到派给电脑的那条 prompt 的 runId。 */
async function runIn(owner: Owner, agent: AgentClient, groupId: GroupId, text: string): Promise<RunId> {
  const response = await owner.client.post(`/api/groups/${groupId}/messages`, { text });
  expect(response.status).toBe(201);
  return (await agentUntil(agent, "prompt")).runId;
}

type ConfigMessage = Extract<ControlToAgent, { type: "config" }>;

/** 收 config 直到有一份满足 done，连这份一起返回。done 挑一份确定会下发的当屏障，漏发的 config 就是序列里少一份。 */
async function configsThrough(agent: AgentClient, done: (config: ConfigMessage) => boolean): Promise<ConfigMessage[]> {
  const seen: ConfigMessage[] = [];
  for (let received = 0; received < 20; received += 1) {
    const one = await agent.next();
    if (one.type !== "config") continue;
    seen.push(one);
    if (done(one)) return seen;
  }
  throw new Error("下发的 config 里一直没有要的那一份");
}

/** Bot 在它的单聊里提议一条偏好，等确认卡推上来。 */
async function offerNote(
  owner: Owner,
  agent: AgentClient,
  push: PushClient,
  text: string,
  options: { readonly runId?: RunId; readonly private?: boolean; readonly sourceMessageId?: MessageId | null } = {},
): Promise<Message> {
  const runId = options.runId ?? (await runIn(owner, agent, owner.groupId, `记住：${text}`));
  return offerPreference(agent, push, {
    runId,
    botId: owner.botId,
    groupId: owner.groupId,
    text,
    private: options.private ?? false,
    sourceMessageId: options.sourceMessageId ?? null,
  });
}

/** Bot 提议、用户点「记住」，等偏好推送回来为止。 */
async function remember(owner: Owner, agent: AgentClient, push: PushClient, text: string): Promise<Preference> {
  const card = await offerNote(owner, agent, push, text);
  await savePreferenceOffer(owner.client, card);
  const pushed = await pushUntil(push, "preference_updated");
  expect(pushed.preference.text).toBe(text);
  return pushed.preference;
}

/**
 * 提议并点记住，但不碰推送队列：等卡落库靠轮询群消息，不读 WebSocket，前面还没读的偏好推送原样留着给调用方。
 * 屏障要的就是「前面谁多推了、谁推晚了，都落在 before 里」。
 */
async function settleNote(owner: Owner, agent: AgentClient, text: string): Promise<void> {
  const runId = await runIn(owner, agent, owner.groupId, `记住：${text}`);
  sendPreferenceOffer(agent, { runId, botId: owner.botId, groupId: owner.groupId, text });
  let card: Message | undefined;
  await waitFor(async () => {
    card = (await messagesIn(owner.client, owner.groupId)).find(
      (one) => one.body.kind === "preference_offer" && one.body.text === text,
    );
    return card !== undefined;
  }, `「${text}」的确认卡落库`);
  if (card === undefined) throw new Error("卡应当已经落库");
  await savePreferenceOffer(owner.client, card);
}

type PreferencePush = Extract<ServerPush, { type: "preference_updated" | "preference_deleted" }>;

/** 收屏障之前的全部偏好推送（更新和删除都算），屏障是后发的一条确定会落地的偏好。 */
async function preferencePushesBefore(
  push: PushClient,
  barrierText: string,
): Promise<{ readonly before: PreferencePush[]; readonly barrier: Preference }> {
  const before: PreferencePush[] = [];
  for (let seen = 0; seen < 20; seen += 1) {
    const one = await push.next();
    if (one.type !== "preference_updated" && one.type !== "preference_deleted") continue;
    if (one.type === "preference_updated" && one.preference.text === barrierText) {
      return { before, barrier: one.preference };
    }
    before.push(one);
  }
  throw new Error(`推送里一直没有屏障 ${barrierText}`);
}

async function messagesIn(client: ApiClient, groupId: GroupId): Promise<Message[]> {
  const response = await client.get(`/api/groups/${groupId}/messages`);
  expect(response.status).toBe(200);
  return MessageListResponse.parse(await response.json()).messages;
}

function offerBody(message: Message): Extract<MessageBody, { kind: "preference_offer" }> {
  if (message.body.kind !== "preference_offer")
    throw new Error(`这条消息不是 preference_offer，是 ${message.body.kind}`);
  return message.body;
}

async function preferencesOf(client: ApiClient, botId: BotId): Promise<Preference[]> {
  const response = await client.get(`/api/bots/${botId}/preferences`);
  expect(response.status).toBe(200);
  return PreferenceListResponse.parse(await response.json()).items;
}

it("Bot 提议后群里多一张 offered 的卡，偏好表和 config 都不动", async () => {
  const owner = await ownerWithBot();
  const agent = await online(owner);
  const push = await watch(owner);
  try {
    const runId = await runIn(owner, agent, owner.groupId, "标题别超过 15 个字，记住");
    const card = await offerNote(owner, agent, push, "标题别超过 15 个字", { runId, private: true });

    expect(offerBody(card), "卡上写着要记的那句话，还没点").toMatchObject({
      botId: owner.botId,
      text: "标题别超过 15 个字",
      private: true,
      sourceMessageId: null,
      status: "offered",
      preferenceId: null,
    });
    expect(
      (await messagesIn(owner.client, owner.groupId)).filter((one) => one.body.kind === "preference_offer"),
      "群里恰好这一张卡",
    ).toEqual([card]);
    expect(await preferencesOf(owner.client, owner.botId), "点之前偏好表不动").toEqual([]);

    // 建 skill 一定重发 config，当屏障：它之前下发的每一份 config 里都不该有这句偏好。
    expect(
      (await owner.client.post(`/api/bots/${owner.botId}/skills`, { name: "屏障", steps: ["一步", "两步"] })).status,
    ).toBe(201);
    const configs = await configsThrough(agent, (config) => config.skills?.length === 1);
    expect(
      configs.map((config) => config.preferences),
      "点之前不下发",
    ).toEqual(configs.map(() => []));
  } finally {
    push.close();
    agent.close();
  }
});

it("点记住：偏好表多一行，卡变 saved 并重推，Web 收到 preference_updated，电脑收到带这句的新 config", async () => {
  const owner = await ownerWithBot();
  const agent = await online(owner);
  const push = await watch(owner);
  try {
    const runId = await runIn(owner, agent, owner.groupId, "标题别超过 15 个字，记住");
    const source = (await messagesIn(owner.client, owner.groupId)).find((one) => one.body.kind === "user");
    if (source === undefined) throw new Error("单聊里该有用户发的那条");
    const card = await offerNote(owner, agent, push, "标题别超过 15 个字", {
      runId,
      private: true,
      sourceMessageId: source.id,
    });

    const saved = await savePreferenceOffer(owner.client, card);
    const preference = saved.preference;
    expect(preference, "回的是刚写下的整条").toMatchObject({
      botId: owner.botId,
      text: "标题别超过 15 个字",
      private: true,
      sourceMessageId: source.id,
    });
    expect(offerBody(saved.message)).toMatchObject({ status: "saved", preferenceId: preference?.id });

    const repushed = await pushUntil(push, "message");
    expect(repushed.message, "卡的状态住在正文里，点完重推同一条").toEqual(saved.message);
    const pushed = await pushUntil(push, "preference_updated");
    expect(pushed.preference).toEqual(preference);
    expect(await preferencesOf(owner.client, owner.botId), "列表里多的就是这一条").toEqual([pushed.preference]);

    const config = await agentUntil(agent, "config");
    expect(config.preferences, "私人的也照样下发给它写作时套用").toEqual([pushed.preference]);
    expect(
      (await messagesIn(owner.client, owner.groupId)).find((one) => one.id === card.id)?.body,
      "库里的卡也变了，刷新页面看到的是 saved",
    ).toMatchObject({ status: "saved", preferenceId: preference?.id });
  } finally {
    push.close();
    agent.close();
  }
});

it("点不用：卡变 dismissed 并重推，偏好表不动，也不重发 config", async () => {
  const owner = await ownerWithBot();
  const agent = await online(owner);
  const push = await watch(owner);
  try {
    const card = await offerNote(owner, agent, push, "回复都带一句问候");

    const response = await decidePreferenceOffer(owner.client, card, "dismiss");
    expect(response.status).toBe(200);
    const decided = DecidePreferenceOfferResponse.parse(await response.json());
    expect(decided.preference, "不用就没有偏好").toBeNull();
    expect(offerBody(decided.message)).toMatchObject({ status: "dismissed", preferenceId: null });
    expect((await pushUntil(push, "message")).message, "重推这条卡").toEqual(decided.message);
    expect(await preferencesOf(owner.client, owner.botId), "偏好表不动").toEqual([]);

    expect(
      (await owner.client.post(`/api/bots/${owner.botId}/skills`, { name: "屏障", steps: ["一步", "两步"] })).status,
    ).toBe(201);
    const configs = await configsThrough(agent, (config) => config.skills?.length === 1);
    expect(
      configs.map((config) => config.preferences),
      "点不用不下发",
    ).toEqual(configs.map(() => []));
  } finally {
    push.close();
    agent.close();
  }
});

it("同一张卡点第二次回 409，先点的那个结果不变，偏好只有一行", async () => {
  const owner = await ownerWithBot();
  const agent = await online(owner);
  const push = await watch(owner);
  try {
    const card = await offerNote(owner, agent, push, "报价一律含税");
    await savePreferenceOffer(owner.client, card);

    expect((await decidePreferenceOffer(owner.client, card, "save")).status, "再点记住").toBe(409);
    expect((await decidePreferenceOffer(owner.client, card, "dismiss")).status, "改口点不用").toBe(409);
    expect(await preferencesOf(owner.client, owner.botId), "只写过一行").toHaveLength(1);
    expect((await messagesIn(owner.client, owner.groupId)).find((one) => one.id === card.id)?.body).toMatchObject({
      status: "saved",
    });

    const dismissed = await offerNote(owner, agent, push, "另一条先说不用");
    expect((await decidePreferenceOffer(owner.client, dismissed, "dismiss")).status).toBe(200);
    expect((await decidePreferenceOffer(owner.client, dismissed, "save")).status, "说过不用的卡不能再记").toBe(409);
    expect(await preferencesOf(owner.client, owner.botId), "说过不用的没写进去").toHaveLength(1);
  } finally {
    push.close();
    agent.close();
  }
});

it("同一张卡并发点记住只写一行", async () => {
  const owner = await ownerWithBot();
  const agent = await online(owner);
  const push = await watch(owner);
  try {
    const card = await offerNote(owner, agent, push, "并发也只记一次");
    const statuses = (await Promise.all([1, 2, 3].map(() => decidePreferenceOffer(owner.client, card, "save")))).map(
      (response) => response.status,
    );

    expect(statuses.toSorted(), "一个 200，其余 409").toEqual([200, 409, 409]);
    expect(await preferencesOf(owner.client, owner.botId), "没有留下孤儿偏好").toHaveLength(1);
  } finally {
    push.close();
    agent.close();
  }
});

it("不是 preference_offer 的消息、别人的卡、不存在的消息都是 404", async () => {
  const owner = await ownerWithBot();
  const stranger = await ownerWithBot();
  const agent = await online(owner);
  const push = await watch(owner);
  try {
    const card = await offerNote(owner, agent, push, "只有我能点");
    const plain = (await messagesIn(owner.client, owner.groupId)).find((one) => one.body.kind === "user");
    if (plain === undefined) throw new Error("单聊里该有用户发的那条");

    expect((await owner.client.post(`/api/messages/${plain.id}/preference-offer`, { decision: "save" })).status).toBe(
      404,
    );
    expect((await stranger.client.post(`/api/messages/${card.id}/preference-offer`, { decision: "save" })).status).toBe(
      404,
    );
    expect((await owner.client.post("/api/messages/not-a-message/preference-offer", { decision: "save" })).status).toBe(
      404,
    );
    expect(await preferencesOf(owner.client, owner.botId), "404 的都没写").toEqual([]);
  } finally {
    push.close();
    agent.close();
  }
});

it("run 结束以后点记住照样能存", async () => {
  const owner = await ownerWithBot();
  const agent = await online(owner);
  const push = await watch(owner);
  try {
    await owner.client.post(`/api/groups/${owner.groupId}/messages`, { text: "记住：先问价再下单" });
    const prompt = await agentUntil(agent, "prompt");
    const card = await offerPreference(agent, push, {
      runId: prompt.runId,
      botId: owner.botId,
      groupId: owner.groupId,
      text: "先问价再下单",
      private: false,
      sourceMessageId: null,
    });
    agent.send({
      type: "run_done",
      runId: prompt.runId,
      botId: owner.botId,
      groupId: owner.groupId,
      steps: 1,
      inputTokens: 0,
      outputTokens: 0,
    });
    for (;;) {
      const one = await push.next();
      if (one.type === "message" && one.message.body.kind === "cost" && one.message.body.runId === prompt.runId) break;
    }

    const saved = await savePreferenceOffer(owner.client, card);
    expect(saved.preference?.text, "run 早收尾了，点卡不靠它").toBe("先问价再下单");
    expect(await preferencesOf(owner.client, owner.botId)).toEqual([saved.preference]);
  } finally {
    push.close();
    agent.close();
  }
});

it("项目群里的 preference_offer 静默丢弃", async () => {
  const owner = await ownerWithBot();
  const other = await addBot(owner, "小财");
  const project = await openProject(owner, "大促", [owner.botId, other]);
  const agent = await online(owner);
  const push = await watch(owner);
  try {
    const projectRun = await runIn(owner, agent, project, "@小服 这次大促的标题都写短一点");
    agent.send({
      type: "preference_offer",
      runId: projectRun,
      botId: owner.botId,
      groupId: project,
      text: "项目群里记的",
      private: false,
      sourceMessageId: null,
    });
    // 同一条连接上的帧按序处理，单聊那张卡到了，前面项目群那条就已经处理完。
    const barrier = await offerNote(owner, agent, push, "单聊里记的");

    expect(
      (await messagesIn(owner.client, project)).filter((one) => one.body.kind === "preference_offer"),
      "项目群里没有落卡",
    ).toEqual([]);
    expect(
      (await messagesIn(owner.client, owner.groupId)).filter((one) => one.body.kind === "preference_offer"),
      "单聊里只有屏障那张",
    ).toEqual([barrier]);
    expect(await preferencesOf(owner.client, owner.botId), "更没有偏好").toEqual([]);
  } finally {
    push.close();
    agent.close();
  }
});

it("删偏好后下一份 config 里没有它", async () => {
  const owner = await ownerWithBot();
  const agent = await online(owner);
  const push = await watch(owner);
  try {
    const kept = await remember(owner, agent, push, "周五不发");
    const dropped = await remember(owner, agent, push, "多用 emoji");
    let config = await agentUntil(agent, "config");
    while (config.preferences.length < 2) config = await agentUntil(agent, "config");
    expect(
      config.preferences.map((one) => one.id),
      "删之前两条都在",
    ).toEqual([kept.id, dropped.id]);

    const response = await owner.client.delete(`/api/preferences/${dropped.id}`);
    expect(response.status).toBe(204);

    const deleted = await pushUntil(push, "preference_deleted");
    expect(deleted).toEqual({ type: "preference_deleted", preferenceId: dropped.id, botId: owner.botId });
    expect((await agentUntil(agent, "config")).preferences, "删掉的不在下一份 config 里，留下的还在").toEqual([kept]);
    expect(await preferencesOf(owner.client, owner.botId)).toEqual([kept]);
    expect((await owner.client.delete(`/api/preferences/${dropped.id}`)).status, "再删一次是 404").toBe(404);
  } finally {
    push.close();
    agent.close();
  }
});

it("切私人只改 private，推整条，下一份 config 跟着变", async () => {
  const owner = await ownerWithBot();
  const agent = await online(owner);
  const push = await watch(owner);
  try {
    const before = await remember(owner, agent, push, "我的手机号 138 开头");
    expect((await agentUntil(agent, "config")).preferences, "记下那份 config 里它还不是私人的").toEqual([before]);

    const response = await owner.client.patch(`/api/preferences/${before.id}`, { private: true });
    expect(response.status).toBe(200);
    const { preference } = PreferenceResponse.parse(await response.json());
    expect(preference, "只有 private 变了").toEqual({ ...before, private: true });
    expect((await pushUntil(push, "preference_updated")).preference).toEqual(preference);
    expect((await owner.client.patch(`/api/preferences/${before.id}`, { text: "改正文" })).status, "正文不让改").toBe(
      400,
    );

    expect((await owner.client.delete(`/api/preferences/${before.id}`)).status).toBe(204);
    const configs = await configsThrough(agent, (config) => config.preferences.length === 0);
    expect(
      configs.map((config) => config.preferences),
      "切完重发了一份 config 且里面它已是私人的，之后删掉那份才是空的",
    ).toEqual([[preference], []]);
  } finally {
    push.close();
    agent.close();
  }
});

it("切私人的 config 还没读回来时偏好被删，推送顺序仍是先更新后删除", async () => {
  const owner = await ownerWithBot();
  const agent = await online(owner);
  const push = await watch(owner);
  let held: ReturnType<typeof gates.arm> | undefined;
  let patching: Promise<Response> | undefined;
  try {
    const before = await remember(owner, agent, push, "删了就不能再回来");
    await agentUntil(agent, "config");

    held = gates.arm(/^select .* from "bot_preferences" inner join "bots"/, "after");
    patching = owner.client.patch(`/api/preferences/${before.id}`, { private: true });
    await held.reached;
    expect((await owner.client.delete(`/api/preferences/${before.id}`)).status, "PATCH 悬着时删掉了它").toBe(204);
    held.release();
    expect((await patching).status).toBe(200);

    await settleNote(owner, agent, "放行之后的屏障");
    const { before: pushes } = await preferencePushesBefore(push, "放行之后的屏障");
    expect(pushes, "页面收到的最后一条关于它的推送必须是删除，否则已删的偏好会在页面上复活").toEqual([
      { type: "preference_updated", preference: { ...before, private: true } },
      { type: "preference_deleted", preferenceId: before.id, botId: owner.botId },
    ]);
    expect(await preferencesOf(owner.client, owner.botId), "库里它已经没了").toEqual([
      expect.objectContaining({ text: "放行之后的屏障" }),
    ]);
  } finally {
    held?.release();
    await patching?.catch(() => undefined);
    push.close();
    agent.close();
  }
});

it("别人的偏好删不到", async () => {
  const owner = await ownerWithBot();
  const stranger = await ownerWithBot();
  const agent = await online(owner);
  const push = await watch(owner);
  try {
    const mine = await remember(owner, agent, push, "回复先给结论");

    expect((await stranger.client.delete(`/api/preferences/${mine.id}`)).status, "别人删是 404").toBe(404);
    expect((await stranger.client.patch(`/api/preferences/${mine.id}`, { private: true })).status, "别人改是 404").toBe(
      404,
    );
    expect((await stranger.client.get(`/api/bots/${owner.botId}/preferences`)).status, "别人的 Bot 列不出").toBe(404);
    expect((await stranger.client.get(`/api/bots/${owner.botId}/profile`)).status, "别人的 Bot 没有 profile").toBe(404);
    expect(await preferencesOf(owner.client, owner.botId), "自己那条一个字没动").toEqual([mine]);
  } finally {
    push.close();
    agent.close();
  }
});

it("profile 计数和偏好、skill、所在项目数一致", async () => {
  const owner = await ownerWithBot();
  const other = await addBot(owner, "小财");
  const agent = await online(owner);
  const push = await watch(owner);
  try {
    await remember(owner, agent, push, "周五不发");
    await remember(owner, agent, push, "标题别超过 15 个字");
    expect(
      (await owner.client.post(`/api/bots/${owner.botId}/skills`, { name: "写周报", steps: ["汇总"] })).status,
    ).toBe(201);
    await openProject(owner, "大促", [owner.botId, other]);
    await openProject(owner, "开源", [owner.botId, other]);
    await openProject(owner, "招聘", [other, await addBot(owner, "小人")]);

    const response = await owner.client.get(`/api/bots/${owner.botId}/profile`);
    expect(response.status).toBe(200);
    expect(BotProfileResponse.parse(await response.json()), "单聊不算项目，别的 Bot 的偏好不算它的").toEqual({
      preferences: 2,
      skills: 1,
      projects: 2,
    });
    const otherProfile = BotProfileResponse.parse(await (await owner.client.get(`/api/bots/${other}/profile`)).json());
    expect(otherProfile).toEqual({ preferences: 0, skills: 0, projects: 3 });
  } finally {
    push.close();
    agent.close();
  }
});
