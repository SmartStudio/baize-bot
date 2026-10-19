import {
  CreateBotResponse,
  DecideSkillOfferResponse,
  MessageListResponse,
  RoutineResponse,
  SkillListResponse,
  SkillResponse,
  type BotId,
  type ControlToAgent,
  type GroupId,
  type Message,
  type MessageBody,
  type RunId,
  type ServerPush,
  type Skill,
} from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { ApiClient, startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, type TestComputer } from "./helpers/fixtures.js";
import { connectPush, type PushClient } from "./helpers/ws.js";

let database: TestDb;
let server: TestServer;

beforeAll(async () => {
  database = await createTestDb();
  server = await startTestServer(database.db);
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

type Decided = { readonly message: Message; readonly skill: Skill | null };

const STEPS = ["打开 CRM 找到这家客户", "把上个季度的成交价拉出来", "按新折扣算一遍填进报价单"];

async function ownerWithBot(): Promise<Owner> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小服" })).json());
  return { client, computer, groupId: created.group.id, botId: created.bot.id };
}

/** 同一个用户的第二个 Bot。复制的目标、跨 Bot 重名都要它。 */
async function secondBot(owner: Owner, name = "小财"): Promise<BotId> {
  const response = await owner.client.post("/api/bots", { name });
  expect(response.status).toBe(201);
  return CreateBotResponse.parse(await response.json()).bot.id;
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

/**
 * 读推送直到读到要的那一条，中间夹着的用户消息、别的 skill 一概跳过。
 * 读不到就是 `next()` 超时，等异步效果不靠 sleep。
 */
async function pushUntil<T extends ServerPush["type"]>(
  push: PushClient,
  type: T,
  accept: (one: Extract<ServerPush, { type: T }>) => boolean = () => true,
): Promise<Extract<ServerPush, { type: T }>> {
  for (let seen = 0; seen < 20; seen += 1) {
    const one = await push.next();
    if (one.type !== type) continue;
    const typed = one as Extract<ServerPush, { type: T }>;
    if (accept(typed)) return typed;
  }
  throw new Error(`推送里一直没有要的 ${type}`);
}

/** 同上，读的是下发给电脑的报文。建 Bot、建例行任务都会插进来一条 config，所以不能直接 `expect`。 */
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

async function teach(owner: Owner, botId: BotId, name: string, steps: string[]): Promise<Skill> {
  const response = await owner.client.post(`/api/bots/${botId}/skills`, { name, steps });
  expect(response.status).toBe(201);
  return SkillResponse.parse(await response.json()).skill;
}

async function skillsOf(owner: Owner, botId: BotId): Promise<Skill[]> {
  const response = await owner.client.get(`/api/bots/${botId}/skills`);
  expect(response.status).toBe(200);
  return SkillListResponse.parse(await response.json()).items;
}

async function messagesOf(owner: Owner): Promise<Message[]> {
  const response = await owner.client.get(`/api/groups/${owner.groupId}/messages`);
  expect(response.status).toBe(200);
  return MessageListResponse.parse(await response.json()).messages;
}

/** 发一条消息。接口回来时 `/名` 的用量已经加过了，所以调用方不用再等。 */
async function say(owner: Owner, text: string): Promise<void> {
  const response = await owner.client.post(`/api/groups/${owner.groupId}/messages`, { text });
  expect(response.status).toBe(201);
}

/** 让这个 Bot 手上有个跑着的活，上行报文要拿它的 runId。 */
async function startRun(owner: Owner, agent: AgentClient): Promise<RunId> {
  await say(owner, "帮我跑一件多步的活");
  return (await agentUntil(agent, "prompt")).runId;
}

/**
 * Bot 干完活问存不存，回群里那张卡。
 * 认卡认到名字和 offered 为止：点存会把同一张卡重推一遍，只按 kind 认会认回上一张已经有结论的。
 */
async function offerSkill(
  owner: Owner,
  agent: AgentClient,
  push: PushClient,
  name: string,
  steps: string[],
  runId?: RunId,
): Promise<Message> {
  const on = runId ?? (await startRun(owner, agent));
  agent.send({ type: "skill_offer", runId: on, botId: owner.botId, groupId: owner.groupId, name, steps });
  const pushed = await pushUntil(
    push,
    "message",
    (one) => one.message.body.kind === "skill_offer" && one.message.body.name === name,
  );
  expect(offerBody(pushed.message).status, "刚推上来的卡还没点过").toBe("offered");
  return pushed.message;
}

async function decide(owner: Owner, card: Message, decision: "save" | "dismiss"): Promise<Decided> {
  const response = await owner.client.post(`/api/messages/${card.id}/skill-offer`, { decision });
  expect(response.status).toBe(200);
  return DecideSkillOfferResponse.parse(await response.json());
}

function offerBody(message: Message | undefined): Extract<MessageBody, { kind: "skill_offer" }> {
  if (message === undefined) throw new Error("这里本该有一条消息");
  if (message.body.kind !== "skill_offer") throw new Error(`这条消息不是 skill_offer，是 ${message.body.kind}`);
  return message.body;
}

describe("在 Web 上教它一个", () => {
  it("建一条：来源记 taught，用量从零起", async () => {
    const owner = await ownerWithBot();
    const response = await owner.client.post(`/api/bots/${owner.botId}/skills`, { name: "Globex 报价", steps: STEPS });
    expect(response.status).toBe(201);

    const { skill } = SkillResponse.parse(await response.json());
    expect(skill.botId).toBe(owner.botId);
    expect(skill.name).toBe("Globex 报价");
    expect(skill.steps, "步骤整份存下来，一条不少").toEqual(STEPS);
    expect(skill.source, "用户在 Web 上教的记 taught").toBe("taught");
    expect(skill.useCount, "刚建好还没用过").toBe(0);

    expect(await skillsOf(owner, owner.botId), "列表里就是刚建的那条").toEqual([skill]);
  });

  it("改名和改步骤，给到的字段整份替换", async () => {
    const owner = await ownerWithBot();
    const skill = await teach(owner, owner.botId, "Globex 报价", STEPS);

    const renamed = await owner.client.patch(`/api/skills/${skill.id}`, { name: "Globex 续约报价" });
    expect(renamed.status).toBe(200);
    expect(SkillResponse.parse(await renamed.json()).skill, "只给了名字，步骤一个字不动").toMatchObject({
      name: "Globex 续约报价",
      steps: STEPS,
    });

    const restepped = await owner.client.patch(`/api/skills/${skill.id}`, { steps: ["只剩这一步"] });
    expect(restepped.status).toBe(200);
    expect(SkillResponse.parse(await restepped.json()).skill, "步骤给了就是整份替换，不是往后追加").toMatchObject({
      name: "Globex 续约报价",
      steps: ["只剩这一步"],
    });
  });

  it("删掉之后列表里没了，并推一条 skill_deleted", async () => {
    const owner = await ownerWithBot();
    const skill = await teach(owner, owner.botId, "Globex 报价", STEPS);
    const kept = await teach(owner, owner.botId, "月度对账", ["拉流水", "对一遍"]);
    const push = await watch(owner);

    try {
      const response = await owner.client.delete(`/api/skills/${skill.id}`);
      expect(response.status).toBe(204);
      expect(await response.text(), "204 不带正文").toBe("");

      const pushed = await pushUntil(push, "skill_deleted");
      expect(pushed, "客户端按 id 把这条从那个 Bot 下面拿掉").toEqual({
        type: "skill_deleted",
        skillId: skill.id,
        botId: owner.botId,
      });

      expect(
        (await skillsOf(owner, owner.botId)).map((one) => one.id),
        "删的只是那一条，别的活还在",
      ).toEqual([kept.id]);
    } finally {
      push.close();
    }
  });

  it("复制给自己的另一个 Bot：来源保留，用量归零，原来那条还在", async () => {
    const owner = await ownerWithBot();
    const agent = await online(owner);
    const push = await watch(owner);

    try {
      // 走对话那条路建，来源因此是 chat。拿一条 taught 的来复制，看不出「保留来源」和「一律记 taught」的区别。
      const card = await offerSkill(owner, agent, push, "Globex 报价", STEPS);
      const saved = await decide(owner, card, "save");
      expect(saved.skill?.source, "对话里攒出来的记 chat").toBe("chat");

      await say(owner, "/Globex 报价 先跑一遍");
      const [origin] = await skillsOf(owner, owner.botId);
      expect(origin?.useCount, "引过一次了，复制出来的那条不该跟着带走").toBe(1);

      const target = await secondBot(owner);
      const response = await owner.client.post(`/api/skills/${origin?.id}/copy`, { botId: target });
      expect(response.status).toBe(201);

      const copy = SkillResponse.parse(await response.json()).skill;
      expect(copy.botId, "复制出来的那条归目标 Bot").toBe(target);
      expect(copy.id, "是新的一条，不是同一条改了归属").not.toBe(origin?.id);
      expect(copy.name).toBe("Globex 报价");
      expect(copy.steps).toEqual(STEPS);
      expect(copy.source, "这件活当初是对话里攒的，换个 Bot 做不改变它的出身").toBe("chat");
      expect(copy.useCount, "用量是每条自己的账，复制不带走").toBe(0);

      expect(await skillsOf(owner, owner.botId), "原来那条一个字没动").toEqual([origin]);
      expect(await skillsOf(owner, target), "目标那边多出来的就是这一条").toEqual([copy]);
    } finally {
      push.close();
      agent.close();
    }
  });
});

describe("同一个 Bot 下名字不重复", () => {
  it("建重名回 409", async () => {
    const owner = await ownerWithBot();
    await teach(owner, owner.botId, "Globex 报价", STEPS);

    const response = await owner.client.post(`/api/bots/${owner.botId}/skills`, { name: "Globex 报价", steps: STEPS });
    expect(response.status).toBe(409);
    expect(await skillsOf(owner, owner.botId), "409 就是没建，列表里不该多一条").toHaveLength(1);
  });

  it("改成已有的名字回 409", async () => {
    const owner = await ownerWithBot();
    await teach(owner, owner.botId, "Globex 报价", STEPS);
    const other = await teach(owner, owner.botId, "月度对账", ["拉流水", "对一遍"]);

    const response = await owner.client.patch(`/api/skills/${other.id}`, { name: "Globex 报价" });
    expect(response.status, "撞唯一索引是用户打得出来的输入，不是服务端出错").toBe(409);
    expect(
      (await skillsOf(owner, owner.botId)).map((one) => one.name),
      "两条名字都没变",
    ).toEqual(["Globex 报价", "月度对账"]);
  });

  it("复制到已经有同名的 Bot 回 409", async () => {
    const owner = await ownerWithBot();
    const skill = await teach(owner, owner.botId, "Globex 报价", STEPS);
    const target = await secondBot(owner);
    await teach(owner, target, "Globex 报价", ["它自己那一套"]);

    const response = await owner.client.post(`/api/skills/${skill.id}/copy`, { botId: target });
    expect(response.status).toBe(409);

    const there = await skillsOf(owner, target);
    expect(there, "目标那条没被顶掉，也没多一条").toHaveLength(1);
    expect(there[0]?.steps).toEqual(["它自己那一套"]);
  });

  it("换个 Bot 就能重名", async () => {
    const owner = await ownerWithBot();
    const skill = await teach(owner, owner.botId, "Globex 报价", STEPS);
    const target = await secondBot(owner);

    const also = await teach(owner, target, "Globex 报价", ["它自己那一套"]);
    expect(also.id, "不重复只在一个 Bot 里面算，两个 Bot 各会各的活").not.toBe(skill.id);
  });
});

describe("别人的东西一律 404", () => {
  it("别人的 Bot、别人的 skill、复制到别人的 Bot，都查不到", async () => {
    const owner = await ownerWithBot();
    const mine = await teach(owner, owner.botId, "Globex 报价", STEPS);

    const stranger = await ownerWithBot();
    const theirs = await teach(stranger, stranger.botId, "他们家的活", ["一步", "两步"]);

    expect((await owner.client.get(`/api/bots/${stranger.botId}/skills`)).status).toBe(404);
    const inserting = await owner.client.post(`/api/bots/${stranger.botId}/skills`, { name: "插一条", steps: STEPS });
    expect(inserting.status).toBe(404);
    expect((await owner.client.patch(`/api/skills/${theirs.id}`, { name: "改个名" })).status).toBe(404);
    expect((await owner.client.delete(`/api/skills/${theirs.id}`)).status).toBe(404);
    expect(
      (await owner.client.post(`/api/skills/${mine.id}/copy`, { botId: stranger.botId })).status,
      "源是自己的，目标不是，一样 404：复制是往目标里写东西",
    ).toBe(404);

    expect(await skillsOf(stranger, stranger.botId), "别人那边一条没多也一条没少").toEqual([theirs]);
  });
});

describe("群里那张卡", () => {
  it("上行 skill_offer 落一张 offered 的卡，还没建 skill 行", async () => {
    const owner = await ownerWithBot();
    const agent = await online(owner);
    const push = await watch(owner);

    try {
      const card = await offerSkill(owner, agent, push, "Globex 报价", STEPS);
      expect(offerBody(card), "推上来的就是还没点的样子").toEqual({
        kind: "skill_offer",
        botId: owner.botId,
        name: "Globex 报价",
        steps: STEPS,
        status: "offered",
        skillId: null,
      });

      expect((await messagesOf(owner)).at(-1), "群里落的和推的是同一条").toEqual(card);
      expect(await skillsOf(owner, owner.botId), "只是问一句，用户没点之前不建 skill 行").toEqual([]);
    } finally {
      push.close();
      agent.close();
    }
  });

  it("点存：建出 skill、卡变 saved、电脑收到带这条 skill 的新 config", async () => {
    const owner = await ownerWithBot();
    const agent = await online(owner);
    const push = await watch(owner);

    try {
      const card = await offerSkill(owner, agent, push, "Globex 报价", STEPS);
      const decided = await decide(owner, card, "save");

      expect(decided.skill, "存下来的就是卡上那件活").toMatchObject({
        botId: owner.botId,
        name: "Globex 报价",
        steps: STEPS,
        useCount: 0,
      });
      expect(offerBody(decided.message), "卡的状态住在正文里，点完整条换掉").toMatchObject({
        status: "saved",
        skillId: decided.skill?.id,
      });

      expect(await skillsOf(owner, owner.botId), "这一条进了 skills 表").toEqual([decided.skill]);
      expect(offerBody((await messagesOf(owner)).at(-1)).status, "库里那条也改了，不是只改了回给客户端的那份").toBe(
        "saved",
      );

      const pushed = await pushUntil(push, "skill_updated");
      expect(pushed.skill, "客户端不用再拉一次列表").toEqual(decided.skill);

      const config = await agentUntil(agent, "config");
      expect(config.skills, "运行器靠整份名单和 skills 目录对账，新存的这条要在里面").toEqual([decided.skill]);
    } finally {
      push.close();
      agent.close();
    }
  });

  it("再点一次存回 409", async () => {
    const owner = await ownerWithBot();
    const agent = await online(owner);
    const push = await watch(owner);

    try {
      const card = await offerSkill(owner, agent, push, "Globex 报价", STEPS);
      await decide(owner, card, "save");

      const again = await owner.client.post(`/api/messages/${card.id}/skill-offer`, { decision: "save" });
      expect(again.status, "幂等靠那条 UPDATE 的 WHERE 本身，不靠先查后写").toBe(409);
      expect(await skillsOf(owner, owner.botId), "没有多出第二条同名的活").toHaveLength(1);
    } finally {
      push.close();
      agent.close();
    }
  });

  it("点不存：卡变 dismissed，回的 skill 是 null，一条活都没多", async () => {
    const owner = await ownerWithBot();
    const agent = await online(owner);
    const push = await watch(owner);

    try {
      const card = await offerSkill(owner, agent, push, "Globex 报价", STEPS);
      const decided = await decide(owner, card, "dismiss");

      expect(decided.skill, "说了不存就没有这条 skill").toBeNull();
      expect(offerBody(decided.message)).toMatchObject({ status: "dismissed", skillId: null });
      expect(decided.message.revision, "点完那次写版本加一").toBe(card.revision + 1);
      expect(await skillsOf(owner, owner.botId), "一条活都没多").toEqual([]);

      const again = await owner.client.post(`/api/messages/${card.id}/skill-offer`, { decision: "save" });
      expect(again.status, "不存也是结论，回头再点存也晚了").toBe(409);
    } finally {
      push.close();
      agent.close();
    }
  });

  it("拿一条普通消息打这条接口回 404", async () => {
    const owner = await ownerWithBot();
    await say(owner, "随便说一句");

    const plain = (await messagesOf(owner)).find((one) => one.body.kind === "user");
    expect(plain, "刚发的那条在群里").toBeDefined();

    const response = await owner.client.post(`/api/messages/${plain?.id}/skill-offer`, { decision: "save" });
    expect(response.status, "正文不是这张卡的消息，和不存在的消息是同一件事").toBe(404);
  });

  it("例行任务那次运行里报上来的不落卡：例行本来就是重复的活，再问存不存是打扰", async () => {
    const owner = await ownerWithBot();
    const agent = await online(owner);
    const push = await watch(owner);

    try {
      const made = await owner.client.post(`/api/bots/${owner.botId}/routines`, {
        name: "每日工单早报",
        instruction: "把今天的工单汇总一下",
        triggers: [],
        onFailure: "stop_and_tell",
      });
      expect(made.status).toBe(201);
      const routine = RoutineResponse.parse(await made.json()).routine;
      expect((await owner.client.post(`/api/routines/${routine.id}/run`)).status).toBe(202);
      const dispatched = await agentUntil(agent, "prompt");
      agent.send({
        type: "skill_offer",
        runId: dispatched.runId,
        botId: owner.botId,
        groupId: owner.groupId,
        name: "工单早报",
        steps: ["拉今天的工单", "按状态分组"],
      });

      // 上行报文按到达顺序处理，后发的这张先落了，前面那张就是被丢了，不靠等超时。
      const fromChat = await offerSkill(owner, agent, push, "Globex 报价", STEPS);
      expect(
        (await messagesOf(owner)).filter((one) => one.body.kind === "skill_offer").map((one) => one.id),
        "群里只有普通对话里问的那一张",
      ).toEqual([fromChat.id]);
      expect((await decide(owner, fromChat, "save")).skill?.source, "普通对话里攒出来的记 chat").toBe("chat");
    } finally {
      push.close();
      agent.close();
    }
  });

  it("已经存过同名的活，或者同名的卡还没点，再报上来都不落卡", async () => {
    const owner = await ownerWithBot();
    const agent = await online(owner);
    const push = await watch(owner);

    try {
      await teach(owner, owner.botId, "Globex 报价", STEPS);
      const pending = await offerSkill(owner, agent, push, "工单早报", ["拉今天的工单", "按状态分组"]);

      const runId = await startRun(owner, agent);
      agent.send({
        type: "skill_offer",
        runId,
        botId: owner.botId,
        groupId: owner.groupId,
        name: "Globex 报价",
        steps: STEPS,
      });
      agent.send({
        type: "skill_offer",
        runId,
        botId: owner.botId,
        groupId: owner.groupId,
        name: "工单早报",
        steps: ["再拉一遍", "再分一遍"],
      });
      const barrier = await offerSkill(owner, agent, push, "周报", ["汇总本周", "发给我"], runId);

      expect(
        (await messagesOf(owner)).filter((one) => one.body.kind === "skill_offer").map((one) => one.id),
        "重名的两张都没落，只剩先前那张和最后那张",
      ).toEqual([pending.id, barrier.id]);

      await decide(owner, pending, "dismiss");
      await pushUntil(push, "message", (one) => one.message.id === pending.id);
      const again = await offerSkill(owner, agent, push, "工单早报", ["拉今天的工单", "按状态分组"], runId);
      expect(offerBody(again).status, "上一张已经有了结论，同名的可以再问").toBe("offered");
    } finally {
      push.close();
      agent.close();
    }
  });
});

describe("正文里的 `/名`", () => {
  it("引一次用量加一，并推一条 skill_updated，正文一个字不改", async () => {
    const owner = await ownerWithBot();
    const skill = await teach(owner, owner.botId, "Globex 报价", STEPS);
    expect(skill.useCount, "刚建好还没用过").toBe(0);
    const push = await watch(owner);

    try {
      await say(owner, "/Globex 报价 跑一下");

      const pushed = await pushUntil(push, "skill_updated");
      expect(pushed.skill.id).toBe(skill.id);
      expect(pushed.skill.useCount, "客户端不用再拉一次列表就看得到新的用量").toBe(1);

      expect((await skillsOf(owner, owner.botId))[0]?.useCount, "库里也加了一次").toBe(1);
      expect((await messagesOf(owner))[0]?.body, "控制面不改写正文，Pi 自己按名字找那份 SKILL.md").toEqual({
        kind: "user",
        text: "/Globex 报价 跑一下",
      });
    } finally {
      push.close();
    }
  });

  it("不带 `/` 的消息谁的用量都不加", async () => {
    const owner = await ownerWithBot();
    const skill = await teach(owner, owner.botId, "Globex 报价", STEPS);

    await say(owner, "Globex 报价 跑一下");

    expect((await skillsOf(owner, owner.botId))[0], "光提名字不算引用，`/` 才算").toEqual(skill);
  });

  it("名字长的先试：`/小结报告` 不算到「小结」头上", async () => {
    const owner = await ownerWithBot();
    const short = await teach(owner, owner.botId, "小结", ["写三句话"]);
    const long = await teach(owner, owner.botId, "小结报告", ["写三句话", "配一张表"]);

    await say(owner, "/小结报告 一下");

    const uses = new Map((await skillsOf(owner, owner.botId)).map((one) => [one.id, one.useCount]));
    expect(uses.get(long.id), "命中的是名字长的那条").toBe(1);
    expect(uses.get(short.id), "一个 `/` 位置只认一条，短的这条没被顺带算上").toBe(0);
  });
});
