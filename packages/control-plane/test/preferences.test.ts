import {
  BotProfileResponse,
  CreateBotResponse,
  CreateGroupResponse,
  PreferenceListResponse,
  PreferenceResponse,
  type BotId,
  type ControlToAgent,
  type GroupId,
  type Preference,
  type RunId,
  type ServerPush,
} from "@baize/shared";
import { afterAll, beforeAll, expect, it } from "vitest";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { startTestServer, type ApiClient, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, type TestComputer } from "./helpers/fixtures.js";
import { gatedDb } from "./helpers/gated-db.js";
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

type PreferencePush = Extract<ServerPush, { type: "preference_updated" | "preference_deleted" }>;

/**
 * 收屏障之前的全部偏好推送（更新和删除都算），屏障是后发的一条确定会落地的 preference_add。
 * 前面谁多推了、谁推晚了，都落在 before 里，不靠等超时来证明没有。
 */
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

/** Bot 在它的单聊里报一条偏好，不等推送。 */
async function sendNote(owner: Owner, agent: AgentClient, text: string): Promise<void> {
  const runId = await runIn(owner, agent, owner.groupId, `记住：${text}`);
  agent.send({
    type: "preference_add",
    runId,
    botId: owner.botId,
    groupId: owner.groupId,
    text,
    private: false,
    sourceMessageId: null,
  });
}

/** Bot 在它的单聊里当场记一条，等到推送回来为止。 */
async function remember(owner: Owner, agent: AgentClient, push: PushClient, text: string): Promise<Preference> {
  await sendNote(owner, agent, text);
  const pushed = await pushUntil(push, "preference_updated");
  expect(pushed.preference.text).toBe(text);
  return pushed.preference;
}

async function preferencesOf(client: ApiClient, botId: BotId): Promise<Preference[]> {
  const response = await client.get(`/api/bots/${botId}/preferences`);
  expect(response.status).toBe(200);
  return PreferenceListResponse.parse(await response.json()).items;
}

it("单聊里记一条偏好后列表多一条并推送", async () => {
  const owner = await ownerWithBot();
  const agent = await online(owner);
  const push = await watch(owner);
  try {
    expect(await preferencesOf(owner.client, owner.botId), "还没记过").toEqual([]);

    const runId = await runIn(owner, agent, owner.groupId, "标题别超过 15 个字，记住");
    agent.send({
      type: "preference_add",
      runId,
      botId: owner.botId,
      groupId: owner.groupId,
      text: "标题别超过 15 个字",
      private: true,
      sourceMessageId: null,
    });
    const pushed = await pushUntil(push, "preference_updated");
    expect(pushed.preference, "推的是刚记下的整条").toMatchObject({
      botId: owner.botId,
      text: "标题别超过 15 个字",
      private: true,
      sourceMessageId: null,
    });
    expect(await preferencesOf(owner.client, owner.botId), "列表里多的就是推上来的那条").toEqual([pushed.preference]);

    const config = await agentUntil(agent, "config");
    expect(config.preferences, "记下之后重发 config，私人的也照样下发给它写作时套用").toEqual([pushed.preference]);
  } finally {
    push.close();
    agent.close();
  }
});

it("项目群里的 preference_add 静默丢弃", async () => {
  const owner = await ownerWithBot();
  const other = await addBot(owner, "小财");
  const project = await openProject(owner, "大促", [owner.botId, other]);
  const agent = await online(owner);
  const push = await watch(owner);
  try {
    const projectRun = await runIn(owner, agent, project, "@小服 这次大促的标题都写短一点");
    agent.send({
      type: "preference_add",
      runId: projectRun,
      botId: owner.botId,
      groupId: project,
      text: "项目群里记的",
      private: false,
      sourceMessageId: null,
    });
    await sendNote(owner, agent, "单聊里记的");

    const { before, barrier } = await preferencePushesBefore(push, "单聊里记的");
    expect(before, "项目群那条被拒时更新和删除都不推，屏障之前没有任何偏好事件").toEqual([]);
    expect(await preferencesOf(owner.client, owner.botId), "库里只有单聊那条").toEqual([barrier]);
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

    await sendNote(owner, agent, "放行之后的屏障");
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
