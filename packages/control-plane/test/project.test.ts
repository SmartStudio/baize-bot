import {
  CreateBotResponse,
  CreateGroupResponse,
  ProjectResponse,
  RunId,
  type BotId,
  type GroupId,
  type UserId,
} from "@baize/shared";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accounts, drafts, messages, publications, runs, tasks } from "../src/db/schema.js";
import { newId } from "../src/ids.js";
import { ApiClient, startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, type TestComputer } from "./helpers/fixtures.js";

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
  readonly userId: UserId;
  readonly client: ApiClient;
  readonly computer: TestComputer;
  readonly soloGroupId: GroupId;
  readonly projectId: GroupId;
  readonly projectTaskId: string;
  readonly botIds: readonly [BotId, BotId];
};

async function ownerWithProject(title = "白泽开源首发"): Promise<Owner> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const first = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "阿文" })).json());
  const second = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "老周" })).json());
  const project = CreateGroupResponse.parse(
    await (await client.post("/api/groups", { title, botIds: [first.bot.id, second.bot.id] })).json(),
  );
  return {
    userId: user.id,
    client,
    computer,
    soloGroupId: first.group.id,
    projectId: project.group.id,
    projectTaskId: project.task.id,
    botIds: [first.bot.id, second.bot.id],
  };
}

async function projectOf(owner: Owner, groupId: GroupId = owner.projectId): Promise<ProjectResponse> {
  const res = await owner.client.get(`/api/projects/${groupId}`);
  expect(res.status, "自己的多 Bot 群打得开项目页").toBe(200);
  return ProjectResponse.parse(await res.json());
}

async function accountOf(owner: Owner, platform: "x" | "xiaohongshu" | "github"): Promise<string> {
  const id = newId();
  await database.db.insert(accounts).values({
    id,
    ownerId: owner.userId,
    computerId: owner.computer.computerId,
    platform,
    handle: `@${id}`,
    login: "valid",
    tier: "confirm_publish",
  });
  return id;
}

const post = (title: string | null, text: string) => ({ kind: "post" as const, title, text, images: [], github: null });

async function published(
  owner: Owner,
  input: {
    groupId: GroupId;
    platform: "x" | "xiaohongshu" | "github";
    title: string | null;
    text?: string;
    url: string;
    at: Date;
  },
): Promise<void> {
  const accountId = await accountOf(owner, input.platform);
  const draftId = newId();
  await database.db.insert(drafts).values({
    id: draftId,
    ownerId: owner.userId,
    groupId: input.groupId,
    botId: owner.botIds[0],
    accountId,
    platform: input.platform,
    content: post(input.title, input.text ?? `${input.title}的正文`),
    contentHash: draftId,
    status: "published",
    createdAt: new Date(input.at.getTime() - 60_000),
  });
  await database.db.insert(publications).values({
    id: newId(),
    ownerId: owner.userId,
    draftId,
    groupId: input.groupId,
    accountId,
    platform: input.platform,
    url: input.url,
    publishedAt: input.at,
  });
}

describe("GET /api/projects/:groupId", () => {
  it("成果只来自发布记录，不读历史消息", async () => {
    const owner = await ownerWithProject();
    const now = Date.now();
    await database.db.insert(messages).values({
      id: newId(),
      groupId: owner.projectId,
      body: {
        kind: "bot",
        botId: owner.botIds[0],
        text: "已发布到 X：https://x.com/baize/status/999 ，发布成功",
        streaming: false,
      },
      createdAt: new Date(now - 1_000),
    });
    await published(owner, {
      groupId: owner.projectId,
      platform: "x",
      title: "白泽的第一条推文",
      url: "https://x.com/baize/status/1",
      at: new Date(now - 3 * 60_000),
    });
    await published(owner, {
      groupId: owner.projectId,
      platform: "xiaohongshu",
      title: "三张图看懂白泽",
      url: "https://creator.xiaohongshu.com/new/note-manager",
      at: new Date(now - 60_000),
    });
    await published(owner, {
      groupId: owner.projectId,
      platform: "github",
      title: "v0.2 发布说明",
      url: "https://github.com/baize-tech/baize/issues/7",
      at: new Date(now - 2 * 60_000),
    });
    await published(owner, {
      groupId: owner.soloGroupId,
      platform: "x",
      title: "单聊里发的",
      url: "https://x.com/baize/status/2",
      at: new Date(now - 30_000),
    });

    const project = await projectOf(owner);
    expect(
      project.achievements.map((item) =>
        item.kind === "publication" ? { url: item.url, platform: item.platform, title: item.title } : item.kind,
      ),
      "只有这个群的三条发布记录，按时间倒序；Bot 消息里那条链接不算成果，读不到笔记 id 的管理页链接照样给",
    ).toEqual([
      { url: "https://creator.xiaohongshu.com/new/note-manager", platform: "xiaohongshu", title: "三张图看懂白泽" },
      { url: "https://github.com/baize-tech/baize/issues/7", platform: "github", title: "v0.2 发布说明" },
      { url: "https://x.com/baize/status/1", platform: "x", title: "白泽的第一条推文" },
    ]);
    expect(project.weekPublished, "本周这个群发出了三条").toBe(3);
  });

  it("无标题的推文正文带 emoji，项目页照样打得开，标题按码元截到 80，截断处不劈开 emoji", async () => {
    const owner = await ownerWithProject();
    const now = Date.now();
    const tweet = "🎉" + "白泽今天开源了".repeat(12);
    const edge = "白".repeat(79) + "🎉🎉";
    await published(owner, {
      groupId: owner.projectId,
      platform: "x",
      title: null,
      text: tweet,
      url: "https://x.com/baize/status/85",
      at: new Date(now - 1_000),
    });
    await published(owner, {
      groupId: owner.projectId,
      platform: "xiaohongshu",
      title: edge,
      url: "https://creator.xiaohongshu.com/new/note-manager",
      at: new Date(now - 2_000),
    });

    const res = await owner.client.get(`/api/projects/${owner.projectId}`);
    expect(res.status, "85 个码点、86 个码元的正文不能让项目页 500").toBe(200);
    const project = ProjectResponse.parse(await res.json());
    expect(project.achievements.map((item) => item.title)).toEqual([tweet.slice(0, 80), "白".repeat(79)]);
  });

  it("成果和本周发出只算本人的发布记录，挂在我群上的别人的记录不算", async () => {
    const owner = await ownerWithProject();
    const stranger = await ownerWithProject("别人的项目");
    const now = Date.now();
    await published(owner, {
      groupId: owner.projectId,
      platform: "x",
      title: "我的",
      url: "https://x.com/baize/status/10",
      at: new Date(now - 2_000),
    });
    await published(stranger, {
      groupId: owner.projectId,
      platform: "x",
      title: "别人的",
      url: "https://x.com/other/status/11",
      at: new Date(now - 1_000),
    });

    const project = await projectOf(owner);
    expect(
      project.achievements.map((item) => item.title),
      "别人的发布记录即使 groupId 指着我的项目也不出现",
    ).toEqual(["我的"]);
    expect(project.weekPublished, "本周发出也只数我的").toBe(1);
  });

  it("本周勾掉只数这周勾上、现在还勾着的项：重存不刷新老的勾选时刻，取消勾选就不算", async () => {
    const owner = await ownerWithProject();
    const save = async (done: readonly boolean[]) => {
      const checklist = ["比三家价", "定交期", "写报价"].map((text, at) => ({
        text,
        done: done[at] ?? false,
        ownerBotId: null,
      }));
      const res = await owner.client.patch(`/api/tasks/${owner.projectTaskId}`, { checklist });
      expect(res.status).toBe(200);
      expect((await res.json()).task.checklist, "勾选时刻不往外带，回的清单就是存进去的那份").toEqual(checklist);
    };

    expect((await projectOf(owner)).weekChecked, "一项没勾").toBe(0);
    await save([true, false, false]);
    expect((await projectOf(owner)).weekChecked, "刚勾上第一项").toBe(1);

    const lastWeek = new Date(Date.now() - 8 * 86_400_000).toISOString();
    await database.db
      .update(tasks)
      .set({ checklist: sql`jsonb_set(${tasks.checklist}, '{0,doneAt}', to_jsonb(${lastWeek}::text))` })
      .where(eq(tasks.id, owner.projectTaskId));
    expect((await projectOf(owner)).weekChecked, "第一项是八天前勾的，不算这周").toBe(0);

    await save([true, true, false]);
    expect((await projectOf(owner)).weekChecked, "整份重存时第一项接着用八天前的时刻，只有第二项算这周").toBe(1);
    const [row] = await database.db
      .select({ checklist: tasks.checklist })
      .from(tasks)
      .where(eq(tasks.id, owner.projectTaskId));
    expect(row?.checklist.map((item) => item.doneAt)).toEqual([lastWeek, expect.any(String), null]);

    await save([true, false, true]);
    expect((await projectOf(owner)).weekChecked, "第二项取消、第三项勾上，本周还是一项").toBe(1);
    await save([false, false, false]);
    expect((await projectOf(owner)).weekChecked, "全取消就是零").toBe(0);
    await save([true, false, false]);
    expect((await projectOf(owner)).weekChecked, "取消过再勾上记的是这回的时刻，八天前那次不留").toBe(1);
  });

  it("不是本人的群、单 Bot 群回 404", async () => {
    const owner = await ownerWithProject();
    const stranger = await ownerWithProject("别人的项目");

    expect((await owner.client.get(`/api/projects/${stranger.projectId}`)).status, "别人的项目").toBe(404);
    expect((await owner.client.get(`/api/projects/${owner.soloGroupId}`)).status, "自己的单 Bot 群不是项目").toBe(404);
    expect((await owner.client.get(`/api/projects/grp_nothing`)).status, "不存在的群").toBe(404);
    expect((await owner.client.get(`/api/projects/${owner.projectId}`)).status, "自己的多 Bot 群").toBe(200);
  });

  it("等你只放这个群的卡，没结束的 run 以一行在做的事出现，轮数是你说过的句数", async () => {
    const owner = await ownerWithProject();
    const accountId = await accountOf(owner, "x");
    const now = Date.now();
    const mine = newId();
    await database.db.insert(drafts).values([
      {
        id: mine,
        ownerId: owner.userId,
        groupId: owner.projectId,
        botId: owner.botIds[0],
        accountId,
        platform: "x",
        content: post("项目里的稿子", "等你批"),
        contentHash: mine,
        status: "pending",
      },
      {
        id: newId(),
        ownerId: owner.userId,
        groupId: owner.soloGroupId,
        botId: owner.botIds[0],
        accountId,
        platform: "x",
        content: post("单聊里的稿子", "不该出现在项目页"),
        contentHash: newId(),
        status: "pending",
      },
    ]);
    const said = newId();
    await database.db.insert(messages).values([
      {
        id: newId(),
        groupId: owner.projectId,
        body: { kind: "user", text: "先排个计划" },
        createdAt: new Date(now - 5_000),
      },
      {
        id: said,
        groupId: owner.projectId,
        body: { kind: "user", text: "这周多发两条小红书" },
        createdAt: new Date(now - 2_000),
      },
    ]);
    await database.db.insert(runs).values([
      {
        id: newId(),
        ownerId: owner.userId,
        botId: owner.botIds[0],
        groupId: owner.projectId,
        triggerMessageId: said,
        startedAt: new Date(now - 1_000),
      },
      {
        id: newId(),
        ownerId: owner.userId,
        botId: owner.botIds[1],
        groupId: owner.projectId,
        triggerMessageId: said,
        startedAt: new Date(now - 60_000),
        endedAt: new Date(now - 30_000),
      },
    ]);

    const project = await projectOf(owner);
    expect(
      project.pending.map((item) => (item.kind === "draft" ? item.draft.id : item.kind)),
      "单聊里的稿子不进项目页",
    ).toEqual([mine]);
    expect(project.working, "结束了的 run 不算在做").toEqual([
      { botId: owner.botIds[0], title: "这周多发两条小红书", since: new Date(now - 1_000).toISOString() },
    ]);
    expect(project.latestTurn?.said.body, "最近一轮从后说的那句起").toMatchObject({ text: "这周多发两条小红书" });
    expect(project.olderTurns, "两句话两轮，更早的是一轮").toBe(1);
  });

  it("最近一轮直接从库里取：你那句落在最近 50 条之外也在，回应只给最近 50 条，cost 不算", async () => {
    const owner = await ownerWithProject();
    const start = Date.now() - 600_000;
    const saidId = newId();
    const step = (at: number) => ({
      id: newId(),
      groupId: owner.projectId,
      body: { kind: "system" as const, text: `第 ${at} 步` },
      createdAt: new Date(start + at * 1_000),
    });
    await database.db.insert(messages).values([
      { id: newId(), groupId: owner.projectId, body: { kind: "user", text: "先排个计划" }, createdAt: new Date(start) },
      {
        id: saidId,
        groupId: owner.projectId,
        body: { kind: "user", text: "开干" },
        createdAt: new Date(start + 1_000),
      },
      ...Array.from({ length: 60 }, (_, at) => step(at + 2)),
      {
        id: newId(),
        groupId: owner.projectId,
        body: { kind: "cost", runId: RunId.parse(newId()), botId: owner.botIds[0], steps: 60, amount: 1 },
        createdAt: new Date(start + 70_000),
      },
    ]);

    const page = await (await owner.client.get(`/api/groups/${owner.projectId}/messages`)).json();
    expect(JSON.stringify(page), "群历史默认那一页里已经没有你那句").not.toContain("开干");

    const project = await projectOf(owner);
    expect(project.latestTurn?.said.id, "最近一轮从你最后那句起").toBe(saidId);
    expect(
      project.latestTurn?.replies.map((message) => Date.parse(message.createdAt) - start),
      "回应按时间升序，超过 50 条只给最近的 50 条，cost 不算",
    ).toEqual(Array.from({ length: 50 }, (_, at) => (at + 12) * 1_000));
    expect(project.olderTurns, "更早还有一轮").toBe(1);
  });

  it("最近一轮按 createdAt 挑你那句：后到的旧话不顶掉新话，同一毫秒的上一轮消息按落库先后排除", async () => {
    const owner = await ownerWithProject();
    const start = Date.now() - 60_000;
    const newer = newId();
    const reply = newId();
    await database.db.insert(messages).values({
      id: newId(),
      groupId: owner.projectId,
      body: { kind: "bot", botId: owner.botIds[0], text: "上一轮的收尾", streaming: false },
      createdAt: new Date(start + 5_000),
    });
    await database.db.insert(messages).values({
      id: newer,
      groupId: owner.projectId,
      body: { kind: "user", text: "后说的" },
      createdAt: new Date(start + 5_000),
    });
    await database.db.insert(messages).values({
      id: newId(),
      groupId: owner.projectId,
      body: { kind: "user", text: "先说的，但后落库" },
      createdAt: new Date(start),
    });
    await database.db.insert(messages).values({
      id: reply,
      groupId: owner.projectId,
      body: { kind: "bot", botId: owner.botIds[1], text: "收到", streaming: false },
      createdAt: new Date(start + 10_000),
    });

    const project = await projectOf(owner);
    expect(project.latestTurn?.said.id, "createdAt 最晚的那句才是最近一轮的起点").toBe(newer);
    expect(
      project.latestTurn?.replies.map((message) => message.id),
      "和你那句同一毫秒、先落库的上一轮消息不算进来",
    ).toEqual([reply]);
    expect(project.olderTurns).toBe(1);
  });

  it("你一句都没说过：没有最近一轮，更早也是零轮", async () => {
    const owner = await ownerWithProject();
    await database.db.insert(messages).values({
      id: newId(),
      groupId: owner.projectId,
      body: { kind: "bot", botId: owner.botIds[0], text: "我先把资料读一遍", streaming: false },
      createdAt: new Date(),
    });

    const project = await projectOf(owner);
    expect(project.latestTurn, "Bot 说过话不等于你开过口").toBeNull();
    expect(project.olderTurns).toBe(0);
  });
});
