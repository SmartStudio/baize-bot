import {
  ComputerTokenResponse,
  CreateBotResponse,
  CreateGroupResponse,
  ProjectResponse,
  RoutineResponse,
  type BotId,
  type ControlToAgent,
  type GroupId,
  type UserId,
} from "@baize/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as events from "../src/agent/events.js";
import { accounts, drafts, projectReviews, publications, runs } from "../src/db/schema.js";
import { newId } from "../src/ids.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { startTestServer, type ApiClient, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, waitFor, type TestComputer } from "./helpers/fixtures.js";

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
  readonly botId: BotId;
};

type Prompt = Extract<ControlToAgent, { type: "prompt" }>;

async function ownerWithProject(): Promise<Owner> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const first = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "阿文" })).json());
  const second = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "老周" })).json());
  const project = CreateGroupResponse.parse(
    await (await client.post("/api/groups", { title: "白泽开源首发", botIds: [first.bot.id, second.bot.id] })).json(),
  );
  return {
    userId: user.id,
    client,
    computer,
    soloGroupId: first.group.id,
    projectId: project.group.id,
    botId: first.bot.id,
  };
}

/** 建一条挂在 groupId 上的例行并试跑一次，拿到派给电脑的那条 prompt。groupId 为 null 时例行落在 Bot 的单聊里。 */
async function routinePrompt(owner: Owner, agent: AgentClient, groupId: GroupId | null): Promise<Prompt> {
  const created = await owner.client.post(`/api/bots/${owner.botId}/routines`, {
    name: "周五复盘",
    instruction: "复盘这个项目本周",
    triggers: [],
    onFailure: "stop_and_tell",
    groupId,
  });
  expect(created.status).toBe(201);
  const routine = RoutineResponse.parse(await created.json()).routine;
  expect((await owner.client.post(`/api/routines/${routine.id}/run`)).status).toBe(202);
  return agent.expect("prompt");
}

function submit(agent: AgentClient, prompt: Prompt, body: string): void {
  agent.send({ type: "review_submit", runId: prompt.runId, botId: prompt.botId, groupId: prompt.groupId, body });
}

/** 同一条连接上的报文按顺序处理，run_done 的确认回来时，前面交的复盘一定已经处理完。 */
async function settle(agent: AgentClient, prompt: Prompt): Promise<void> {
  agent.send({
    type: "run_done",
    runId: prompt.runId,
    botId: prompt.botId,
    groupId: prompt.groupId,
    steps: 1,
    inputTokens: 0,
    outputTokens: 0,
  });
  await agent.ack(prompt.runId);
}

async function projectOf(owner: Owner): Promise<ProjectResponse> {
  const res = await owner.client.get(`/api/projects/${owner.projectId}`);
  expect(res.status).toBe(200);
  return ProjectResponse.parse(await res.json());
}

async function reviewsOf(owner: Owner) {
  return database.db
    .select({ body: projectReviews.body, weekStart: projectReviews.weekStart })
    .from(projectReviews)
    .where(eq(projectReviews.groupId, owner.projectId));
}

/** 另开一个事务对 run 行持 FOR UPDATE，扣住这个 run 上的复盘写入（whileRunOpen 要拿共享锁），模拟收帧之后处理被拖住。 */
async function holdRun(prompt: Prompt): Promise<{ release(): Promise<void> }> {
  let locked!: () => void;
  let unblock!: () => void;
  const ready = new Promise<void>((resolve) => (locked = resolve));
  const blocked = new Promise<void>((resolve) => (unblock = resolve));
  const done = database.db.transaction(async (tx) => {
    await tx.select({ id: runs.id }).from(runs).where(eq(runs.id, prompt.runId)).for("update");
    locked();
    await blocked;
  });
  await ready;
  return {
    release: async () => {
      unblock();
      await done;
    },
  };
}

/** 数据库里能看到有一条语句卡在 runs 的共享锁上，说明那份复盘已经收下、正等着写。 */
async function reviewWaitingOnRun(): Promise<void> {
  await waitFor(async () => {
    const [row] = await database.sql<{ n: number }[]>`
      select count(*)::int as n from pg_stat_activity
      where datname = ${database.databaseName} and wait_event_type = 'Lock' and query like '%runs%for share%'`;
    return (row?.n ?? 0) > 0;
  }, "复盘写入卡在 run 的共享锁上");
}

/** pong 回来说明服务端已经读完这条连接上先发的帧，它们的 message 回调都跑过了，收帧时刻已经取下。 */
function received(agent: AgentClient): Promise<void> {
  return new Promise((resolve) => {
    agent.socket.once("pong", () => resolve());
    agent.socket.ping();
  });
}

/** 扣住这台电脑链上的下一条 heartbeat，后面的帧只能排在电脑链上等，模拟收帧之后处理被前一帧拖住。 */
function holdNextHeartbeat(computerId: TestComputer["computerId"]) {
  let reached!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => (reached = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  const original = events.handleAgentEvent;
  const spy = vi.spyOn(events, "handleAgentEvent").mockImplementation(async (deps, conn, message, receivedAt) => {
    if (conn.computerId === computerId && message.type === "heartbeat") {
      reached();
      await released;
    }
    await original(deps, conn, message, receivedAt);
  });
  return { started, release, restore: () => spy.mockRestore() };
}

async function publishedYesterday(owner: Owner, title: string): Promise<void> {
  const accountId = newId();
  await database.db.insert(accounts).values({
    id: accountId,
    ownerId: owner.userId,
    computerId: owner.computer.computerId,
    platform: "x",
    via: "api",
    handle: `@${accountId}`,
    login: "valid",
    tier: "confirm_publish",
  });
  const draftId = newId();
  const at = new Date(Date.now() - 86_400_000);
  await database.db.insert(drafts).values({
    id: draftId,
    ownerId: owner.userId,
    groupId: owner.projectId,
    botId: owner.botId,
    accountId,
    platform: "x",
    content: { kind: "post", title, text: `${title}的正文`, images: [], github: null },
    contentHash: draftId,
    status: "published",
    createdAt: new Date(at.getTime() - 60_000),
  });
  await database.db.insert(publications).values({
    id: newId(),
    ownerId: owner.userId,
    draftId,
    groupId: owner.projectId,
    accountId,
    platform: "x",
    url: "https://x.com/baize/status/1",
    publishedAt: at,
  });
}

describe("review_submit", () => {
  it("复盘落库后项目页成果里多一条 review", async () => {
    const owner = await ownerWithProject();
    await publishedYesterday(owner, "白泽的第一条推文");
    const { agent } = await helloAgent(server.server.port, owner.computer.computerId, owner.computer.token);
    try {
      const prompt = await routinePrompt(owner, agent, owner.projectId);
      submit(agent, prompt, "本周发了一条推文，星数涨了 37。下周把发布挪到周二上午。");
      await settle(agent, prompt);

      const project = await projectOf(owner);
      expect(
        project.achievements.map((item) => (item.kind === "review" ? { kind: item.kind, body: item.body } : item.kind)),
        "复盘排在昨天那条发布前面：成果按时间倒序，复盘是刚交的",
      ).toEqual([{ kind: "review", body: "本周发了一条推文，星数涨了 37。下周把发布挪到周二上午。" }, "publication"]);
      const [review] = project.achievements;
      if (review?.kind !== "review") throw new Error("第一条不是复盘");
      expect(review.weekStart, "周界按上海时区的周一").toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(`${review.weekStart}T00:00:00+08:00`).getUTCDay(), "周一 00:00 上海是周日 16:00 UTC").toBe(0);
    } finally {
      agent.close();
    }
  });

  it("同一周交两次只留后一份", async () => {
    const owner = await ownerWithProject();
    const { agent } = await helloAgent(server.server.port, owner.computer.computerId, owner.computer.token);
    try {
      const first = await routinePrompt(owner, agent, owner.projectId);
      submit(agent, first, "第一版复盘");
      await settle(agent, first);
      const second = await routinePrompt(owner, agent, owner.projectId);
      submit(agent, second, "第二版复盘");
      await settle(agent, second);

      const reviews = (await projectOf(owner)).achievements.filter((item) => item.kind === "review");
      expect(
        reviews.map((item) => item.body),
        "同一周再交是覆盖，不是多一条",
      ).toEqual(["第二版复盘"]);
    } finally {
      agent.close();
    }
  });

  it("单聊里交的复盘丢弃", async () => {
    const owner = await ownerWithProject();
    const { agent } = await helloAgent(server.server.port, owner.computer.computerId, owner.computer.token);
    try {
      const solo = await routinePrompt(owner, agent, null);
      expect(solo.groupId, "不挂项目的例行落在执行者的单聊").toBe(owner.soloGroupId);
      submit(agent, solo, "单聊里的复盘");
      await settle(agent, solo);

      const said = await owner.client.post(`/api/groups/${owner.projectId}/messages`, { text: "@阿文 复盘一下" });
      expect(said.status).toBe(201);
      const byHand = await agent.expect("prompt");
      expect(byHand.groupId).toBe(owner.projectId);
      submit(agent, byHand, "当面让交的复盘");
      await settle(agent, byHand);

      const stored = await database.db
        .select({ body: projectReviews.body })
        .from(projectReviews)
        .where(eq(projectReviews.groupId, owner.soloGroupId));
      expect(stored, "单聊没有项目页，交上来的复盘不落库").toEqual([]);
      expect(
        (await projectOf(owner)).achievements.filter((item) => item.kind === "review"),
        "项目群里不是例行派的活交的复盘也丢掉：复盘只认周五那条例行",
      ).toEqual([]);
    } finally {
      agent.close();
    }
  });
  it("先收到但被拖住的旧稿不会顶掉后收到的新稿", async () => {
    const owner = await ownerWithProject();
    const remote = ComputerTokenResponse.parse(await (await owner.client.post("/api/computers/remote")).json());
    // 旧电脑租约到期后本机接管，保留旧 run，让两份复盘沿不同电脑链并行处理。
    const far = (await helloAgent(server.server.port, remote.computerId, remote.token)).agent;
    let near: AgentClient | null = null;
    try {
      const older = await routinePrompt(owner, far, owner.projectId);
      near = (await helloAgent(server.server.port, owner.computer.computerId, owner.computer.token)).agent;
      await database.sql`UPDATE computers SET lease_until = now() - interval '1 second' WHERE id = ${remote.computerId}`;
      const newer = await routinePrompt(owner, near, owner.projectId);
      const hold = await holdRun(older);
      try {
        submit(far, older, "先收到的旧稿");
        await reviewWaitingOnRun();
        submit(near, newer, "后收到的新稿");
        await settle(near, newer);
      } finally {
        await hold.release();
      }
      await settle(far, older);

      expect(
        (await reviewsOf(owner)).map((row) => row.body),
        "同一周以控制面收到的先后为准：旧稿收到得早，写库再晚也不能覆盖",
      ).toEqual(["后收到的新稿"]);
    } finally {
      far.close();
      near?.close();
    }
  });

  it("周日深夜收到、写库拖到周一的复盘仍算上一周", async () => {
    const owner = await ownerWithProject();
    const { agent } = await helloAgent(server.server.port, owner.computer.computerId, owner.computer.token);
    try {
      const prompt = await routinePrompt(owner, agent, owner.projectId);
      const hold = await holdRun(prompt);
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2026-10-11T23:59:59+08:00"));
        submit(agent, prompt, "周日收到的复盘");
        await reviewWaitingOnRun();
        vi.setSystemTime(new Date("2026-10-12T00:00:00+08:00"));
      } finally {
        await hold.release();
      }
      await settle(agent, prompt);

      expect(
        (await reviewsOf(owner)).map((row) => row.weekStart),
        "周界按控制面收到这条报文的时刻算，不按开始写库的时刻",
      ).toEqual(["2026-10-05"]);
    } finally {
      vi.useRealTimers();
      agent.close();
    }
  });
  it("周日深夜收到、在电脑链上排到周一才处理的复盘仍算上一周", async () => {
    const owner = await ownerWithProject();
    const { agent } = await helloAgent(server.server.port, owner.computer.computerId, owner.computer.token);
    const gate = holdNextHeartbeat(owner.computer.computerId);
    try {
      const prompt = await routinePrompt(owner, agent, owner.projectId);
      agent.send({ type: "heartbeat", at: new Date().toISOString() });
      await gate.started;
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-11T23:59:59+08:00"));
      submit(agent, prompt, "周日收到、排在链上的复盘");
      await received(agent);
      vi.setSystemTime(new Date("2026-10-12T00:00:00+08:00"));
      gate.release();
      await settle(agent, prompt);

      const rows = await database.db
        .select({ weekStart: projectReviews.weekStart, createdAt: projectReviews.createdAt })
        .from(projectReviews)
        .where(eq(projectReviews.groupId, owner.projectId));
      expect(
        rows.map((row) => [row.weekStart, row.createdAt.toISOString()]),
        "收帧时刻在进电脑链之前取：周界和排序时刻都是周日收到的那一刻，不是轮到它处理的周一",
      ).toEqual([["2026-10-05", "2026-10-11T15:59:59.000Z"]]);
    } finally {
      gate.release();
      gate.restore();
      vi.useRealTimers();
      agent.close();
    }
  });
});
