import { randomUUID } from "node:crypto";
import {
  BotListResponse,
  ComputerTokenResponse,
  ContentPlanId,
  CreateBotResponse,
  CreateGroupResponse,
  GroupResponse,
  MessageId,
  MessageListResponse,
  type AgentToControl,
  type BotId,
  type GroupId,
  type MessageBody,
  type RunId,
  type ServerPush,
} from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { startTestServer, type ApiClient, type TestServer } from "./helpers/client.js";
import { contentJob, createDraft, sendDraft, specOf, tweet } from "./helpers/content.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, waitFor, type TestComputer } from "./helpers/fixtures.js";
import { gatedDb } from "./helpers/gated-db.js";
import { connectPush, type PushClient } from "./helpers/ws.js";

/**
 * run 名下的写在自己的事务里先查一遍 run 行再写，闸门卡在这条上就是「已过 resolveRun、还没写」。
 * 只认按 run id 查、不带 computer_id 的那条：resolveRun 里 runBelongsTo 那条带 computer_id，
 * 删 Bot 先锁 runs 的那条按 bot_id 开头。
 * 不按 for share 和 bot_id 认：锁或 Bot 条件去掉了闸门照样落在这条上，用例才能看出漏进来的写。
 */
const LOCK_OPEN_RUN = /^select "id" from "runs" where \("runs"\."id" = \$1 and (?!.*"computer_id")/;

/** 收尾收文字的那条 UPDATE。 */
const SETTLE_SQL = /update "messages" set "body".*'streaming'.*not exists/;

/** 这个测试库里在等某种锁的会话数。 */
async function lockWaiters(kind: "advisory" | "any"): Promise<number> {
  const rows = await database.sql<{ waiting: number }[]>`
    SELECT count(*)::int AS waiting FROM pg_stat_activity
    WHERE datname = ${database.databaseName} AND wait_event_type = 'Lock'
      AND (${kind} = 'any' OR wait_event = 'advisory')`;
  return rows[0]?.waiting ?? 0;
}

async function runsOf(live: Live): Promise<{ id: string; ended: boolean }[]> {
  return database.sql<{ id: string; ended: boolean }[]>`
    SELECT id, ended_at IS NOT NULL AS ended FROM runs WHERE group_id = ${live.groupId} ORDER BY started_at`;
}

let database: TestDb;
let gates: { readonly a: ReturnType<typeof gatedDb>; readonly b: ReturnType<typeof gatedDb> };
// 两台控制面连同一个库，像滚动重启时新旧进程并存：电脑的帧卡在 A 上，收尾在 B 上先提交。
// 同一台控制面里帧和收尾排在这台电脑的同一条链上，排不出这种交错。
let serverA: TestServer;
let serverB: TestServer;

beforeAll(async () => {
  database = await createTestDb();
  gates = { a: gatedDb(database.sql), b: gatedDb(database.sql) };
  serverA = await startTestServer(gates.a.db);
  serverB = await startTestServer(gates.b.db);
});

afterAll(async () => {
  await serverA.close();
  await serverB.close();
  await database.close();
});

type Live = {
  readonly client: ApiClient;
  readonly computer: TestComputer;
  readonly agent: AgentClient;
  readonly push: PushClient;
  readonly botId: BotId;
  readonly groupId: GroupId;
  readonly runId: RunId;
  close(): void;
};

type Owner = { readonly client: ApiClient; readonly computer: TestComputer };

async function owner(): Promise<Owner> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = serverA.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  return { client, computer };
}

async function startRun(who: Owner, groupId: GroupId, text: string): Promise<Live> {
  const { agent } = await helloAgent(serverA.server.port, who.computer.computerId, who.computer.token);
  const push = await connectPush(serverA.server.port, who.client.cookie ?? "");
  expect((await who.client.post(`/api/groups/${groupId}/messages`, { text })).status).toBe(201);
  const prompt = await agent.expect("prompt");
  const echoed = await push.next();
  expect(echoed.type).toBe("message");
  return {
    ...who,
    agent,
    push,
    botId: prompt.botId,
    groupId,
    runId: prompt.runId,
    close: () => {
      agent.close();
      push.close();
    },
  };
}

async function soloRun(): Promise<Live> {
  const who = await owner();
  const created = CreateBotResponse.parse(await (await who.client.post("/api/bots", { name: "小服" })).json());
  return startRun(who, created.group.id, "做这件事");
}

type RunFrame =
  | Extract<AgentToControl, { runId: RunId; botId: BotId; groupId: GroupId }>
  | (Omit<Extract<AgentToControl, { type: "bot_text" }>, "done"> & {
      done: boolean;
      runId: RunId;
      botId: BotId;
      groupId: GroupId;
    });
type Unaddressed<T> = T extends unknown ? Omit<T, "runId" | "botId" | "groupId"> : never;

function send(live: Live, frame: Unaddressed<RunFrame>): void {
  live.agent.send({ ...frame, runId: live.runId, botId: live.botId, groupId: live.groupId } as RunFrame);
}

function say(live: Live, messageId: MessageId, delta: string, done: boolean): void {
  send(live, { type: "bot_text", messageId, delta, done });
}

/** 发一段文字并等到它的 delta 推出来。头一段不足 6 个字会先攒着不推，这里的每段都够长。 */
async function stream(live: Live, messageId: MessageId, delta: string, done: boolean): Promise<void> {
  say(live, messageId, delta, done);
  for (;;) {
    const push = await live.push.next();
    if (push.type === "message_delta" && push.messageId === messageId) return;
  }
}

function toolCall(live: Live, callId: string, status: "running" | "ok"): void {
  send(live, {
    type: "bot_tool_call",
    callId,
    tool: "test.probe",
    view: { kind: "mcp", server: "", tool: "test.probe", params: [] },
    status,
    durationMs: status === "running" ? null : 3,
  });
}

function requestApproval(live: Live, callId: string): void {
  send(live, {
    type: "approval_request",
    callId,
    tool: "test.spend",
    action: "spend",
    target: null,
    view: { kind: "mcp", server: "", tool: "test.spend", params: [] },
  });
}

function runDone(live: Live): void {
  send(live, { type: "run_done", steps: 1, inputTokens: 0, outputTokens: 0 });
}

/**
 * 收尾之后这个 run 名下的帧什么都不推，等它没有终点。屏障是一条不带 runId 的报错：它排在前面的帧后面，
 * 推出来的 system 消息到了，前面的帧就都做完了。返回屏障之前的全部推送。
 */
async function barrier(agent: AgentClient, push: PushClient, groupId: GroupId, tag: string): Promise<ServerPush[]> {
  agent.send({ type: "agent_error", code: "runner_failed", detail: tag, groupId });
  const before: ServerPush[] = [];
  for (;;) {
    const next = await push.next();
    if (next.type === "message" && next.message.body.kind === "system" && next.message.body.text.endsWith(tag))
      return before;
    before.push(next);
  }
}

async function pendingPushes(push: PushClient): Promise<ServerPush[]> {
  const pending: ServerPush[] = [];
  for (;;) {
    try {
      pending.push(await push.next(100));
    } catch {
      return pending;
    }
  }
}

const settledDelta = (live: Live, messageId: MessageId): ServerPush => ({
  type: "message_delta",
  messageId,
  groupId: live.groupId,
  delta: "",
  done: true,
  revision: expect.any(Number) as number,
  visibleTo: null,
});

const pushesAbout = (pushed: readonly ServerPush[], messageId: MessageId): ServerPush[] =>
  pushed.filter(
    (push) =>
      (push.type === "message_delta" && push.messageId === messageId) ||
      (push.type === "message" && push.message.id === messageId),
  );

const pushedKinds = (pushed: readonly ServerPush[]): string[] =>
  pushed.map((push) => (push.type === "message" ? `message:${push.message.body.kind}` : push.type));

async function page(live: Live) {
  const response = await live.client.get(`/api/groups/${live.groupId}/messages`);
  expect(response.status).toBe(200);
  return MessageListResponse.parse(await response.json());
}

async function bodiesOf(live: Live, kind: MessageBody["kind"]): Promise<MessageBody[]> {
  return (await page(live)).messages.map((message) => message.body).filter((body) => body.kind === kind);
}

async function botText(live: Live, messageId: MessageId): Promise<{ text: string; streaming: boolean } | null> {
  const found = (await page(live)).messages.find((message) => message.id === messageId);
  if (found === undefined) return null;
  if (found.body.kind !== "bot") throw new Error(`消息 ${messageId} 不是 Bot 文字`);
  return { text: found.body.text, streaming: found.body.streaming };
}

const newMessageId = (): MessageId => MessageId.parse(randomUUID());

/** 小销、小服两个 Bot 拉一个群，小销先接一条活。 */
async function teamRun() {
  const who = await owner();
  const sales = CreateBotResponse.parse(
    await (await who.client.post("/api/bots", { name: "小销", tags: ["销售"] })).json(),
  ).bot;
  const service = CreateBotResponse.parse(
    await (await who.client.post("/api/bots", { name: "小服", tags: ["客服"] })).json(),
  ).bot;
  const group = CreateGroupResponse.parse(
    await (await who.client.post("/api/groups", { title: "双十一大促", botIds: [sales.id, service.id] })).json(),
  ).group;
  const live = await startRun(who, group.id, "@小销 看看库存");
  expect(live.botId).toBe(sales.id);
  return { live, sales, service };
}

async function groupOf(live: Live, groupId: GroupId = live.groupId) {
  const response = await live.client.get(`/api/groups/${groupId}`);
  expect(response.status).toBe(200);
  return GroupResponse.parse(await response.json());
}

describe("收尾时收掉还在流的文字", () => {
  it("run_done 时还没 done 的文字块收成定稿，Web 收到一条带 done 的空 delta，说完的那块不再推", async () => {
    const live = await soloRun();
    try {
      const said = newMessageId();
      const saying = newMessageId();
      await stream(live, said, "第一块已经说完了", true);
      await stream(live, saying, "第二块说到一半", false);
      runDone(live);
      const pushed = await barrier(live.agent, live.push, live.groupId, "run_done 之后");
      expect(pushesAbout(pushed, saying)).toEqual([settledDelta(live, saying)]);
      expect(pushesAbout(pushed, said)).toEqual([]);
      expect(await botText(live, saying)).toEqual({ text: "第二块说到一半", streaming: false });
      expect(await botText(live, said)).toEqual({ text: "第一块已经说完了", streaming: false });
    } finally {
      live.close();
    }
  });

  it("断线收尾（重连的 hello 不带这个 run）同样收掉", async () => {
    const live = await soloRun();
    const saying = newMessageId();
    await stream(live, saying, "说到一半电脑掉线了", false);
    const { agent: back } = await helloAgent(serverA.server.port, live.computer.computerId, live.computer.token);
    try {
      const pushed = await barrier(back, live.push, live.groupId, "重连之后");
      expect(pushesAbout(pushed, saying)).toEqual([settledDelta(live, saying)]);
      expect(await botText(live, saying)).toEqual({ text: "说到一半电脑掉线了", streaming: false });
    } finally {
      back.close();
      live.close();
    }
  });

  it("运行器报错收尾（agent_error 带 runId）同样收掉", async () => {
    const live = await soloRun();
    try {
      const saying = newMessageId();
      await stream(live, saying, "说到一半运行器出错了", false);
      live.agent.send({ type: "agent_error", code: "runner_failed", detail: "模型挂了", runId: live.runId });
      const pushed = await barrier(live.agent, live.push, live.groupId, "报错之后");
      expect(pushesAbout(pushed, saying)).toEqual([settledDelta(live, saying)]);
      expect(await botText(live, saying)).toEqual({ text: "说到一半运行器出错了", streaming: false });
    } finally {
      live.close();
    }
  });

  it("多 Bot 群里只收收尾那个 Bot 的文字，另一个 Bot 还在流的那条不动", async () => {
    const who = await owner();
    const sales = CreateBotResponse.parse(
      await (await who.client.post("/api/bots", { name: "小销", tags: ["销售"] })).json(),
    ).bot;
    const service = CreateBotResponse.parse(
      await (await who.client.post("/api/bots", { name: "小服", tags: ["客服"] })).json(),
    ).bot;
    const group = CreateGroupResponse.parse(
      await (await who.client.post("/api/groups", { title: "双十一大促", botIds: [sales.id, service.id] })).json(),
    ).group;
    const salesRun = await startRun(who, group.id, "@小销 看看库存");
    try {
      const salesSaying = newMessageId();
      await stream(salesRun, salesSaying, "小销说到一半", false);
      expect((await who.client.post(`/api/groups/${group.id}/messages`, { text: "@小服 你也看下" })).status).toBe(201);
      const prompt = await salesRun.agent.expect("prompt");
      expect(prompt.botId).toBe(service.id);
      const serviceRun: Live = { ...salesRun, botId: service.id, runId: prompt.runId };
      const serviceSaying = newMessageId();
      await stream(serviceRun, serviceSaying, "小服也说到一半", false);
      runDone(salesRun);
      const pushed = await barrier(salesRun.agent, salesRun.push, group.id, "小销收尾之后");
      expect(pushesAbout(pushed, salesSaying)).toEqual([settledDelta(salesRun, salesSaying)]);
      expect(pushesAbout(pushed, serviceSaying), "小服的 run 还开着，它那条不推").toEqual([]);
      expect(await botText(serviceRun, serviceSaying)).toEqual({ text: "小服也说到一半", streaming: true });
    } finally {
      salesRun.close();
    }
  });
  it.each([
    { mode: "run_done", how: "旧电脑回来报 run_done" },
    { mode: "abandon", how: "旧电脑回来 hello 不带旧 run，对账收尾" },
  ] as const)(
    "同一个 Bot 在别的电脑上还有 run 开着（$how）：旧 run 收尾一条不收，留给最后结束的 run 一起收",
    async ({ mode }) => {
      const old = await soloRun();
      const oldSaying = newMessageId();
      const freshSaying = newMessageId();
      let remote: AgentClient | undefined;
      let back: AgentClient | undefined;
      try {
        await stream(old, oldSaying, "旧电脑上说到一半的话", false);
        const token = ComputerTokenResponse.parse(await (await old.client.post("/api/computers/remote")).json());
        remote = (await helloAgent(serverA.server.port, token.computerId, token.token)).agent;
        // 本机掉线，下一条派到远程电脑：同一个 Bot、同一个群，旧 run 还开着，新 run 起来了。
        old.agent.close();
        await old.agent.closed();
        for (;;) {
          const push = await old.push.next();
          if (
            push.type === "computer_updated" &&
            push.computer.id === old.computer.computerId &&
            push.computer.status === "sleeping"
          )
            break;
        }
        expect((await old.client.post(`/api/groups/${old.groupId}/messages`, { text: "接着做下一件" })).status).toBe(
          201,
        );
        const prompt = await remote.expect("prompt");
        expect(prompt.botId).toBe(old.botId);
        const fresh: Live = { ...old, agent: remote, runId: prompt.runId };
        await stream(fresh, freshSaying, "远程电脑上新 run 正在说", false);

        back = (
          await helloAgent(
            serverA.server.port,
            old.computer.computerId,
            old.computer.token,
            mode === "run_done" ? [old.runId] : [],
          )
        ).agent;
        if (mode === "run_done") runDone({ ...old, agent: back });
        const pushed = await barrier(back, old.push, old.groupId, "旧 run 收尾之后");
        const ended = await database.sql<{ id: string; ended: boolean }[]>`
        SELECT id, ended_at IS NOT NULL AS ended FROM runs WHERE id IN (${old.runId}, ${fresh.runId})`;
        expect(Object.fromEntries(ended.map((row) => [row.id, row.ended]))).toEqual({
          [old.runId]: true,
          [fresh.runId]: false,
        });
        expect(pushesAbout(pushed, freshSaying), "新 run 还开着，它的文字不推定稿").toEqual([]);
        expect(pushesAbout(pushed, oldSaying), "还有别的 run 开着，整条跳过").toEqual([]);
        expect(await botText(fresh, freshSaying)).toEqual({ text: "远程电脑上新 run 正在说", streaming: true });
        expect(await botText(old, oldSaying)).toEqual({ text: "旧电脑上说到一半的话", streaming: true });

        runDone(fresh);
        const settled = await barrier(remote, old.push, old.groupId, "新 run 收尾之后");
        expect(pushesAbout(settled, oldSaying)).toEqual([settledDelta(old, oldSaying)]);
        expect(pushesAbout(settled, freshSaying)).toEqual([settledDelta(fresh, freshSaying)]);
        expect(await botText(old, oldSaying)).toEqual({ text: "旧电脑上说到一半的话", streaming: false });
        expect(await botText(fresh, freshSaying)).toEqual({ text: "远程电脑上新 run 正在说", streaming: false });
      } finally {
        back?.close();
        remote?.close();
        old.close();
      }
    },
  );
});

describe("收尾后晚到的帧按可靠性处理", () => {
  it("晚到的 delta 不接上，完整文字仍会定稿", async () => {
    const live = await soloRun();
    try {
      const saying = newMessageId();
      const fresh = newMessageId();
      await stream(live, saying, "说到一半就收尾了", false);
      runDone(live);
      say(live, saying, "晚到的这一段不能接上", false);
      say(live, fresh, "收尾之后才起的一段话", true);
      const pushed = await barrier(live.agent, live.push, live.groupId, "晚到的文字之后");
      expect(pushesAbout(pushed, saying), "只有收尾那一条").toEqual([settledDelta(live, saying)]);
      expect(pushesAbout(pushed, fresh)).toEqual([
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({
            id: fresh,
            body: expect.objectContaining({ kind: "bot", text: "", streaming: true }),
          }),
        }),
        expect.objectContaining({
          type: "message_delta",
          messageId: fresh,
          delta: "收尾之后才起的一段话",
          done: true,
        }),
      ]);
      expect(await botText(live, saying)).toEqual({ text: "说到一半就收尾了", streaming: false });
      expect(await botText(live, fresh)).toEqual({ text: "收尾之后才起的一段话", streaming: false });
    } finally {
      live.close();
    }
  });

  it("审批请求不出卡、不推审批", async () => {
    const live = await soloRun();
    try {
      runDone(live);
      requestApproval(live, "call-late");
      const pushed = await barrier(live.agent, live.push, live.groupId, "晚到的审批之后");
      expect(pushedKinds(pushed)).not.toContain("approval_updated");
      expect(pushedKinds(pushed)).not.toContain("message:approval");
      expect((await page(live)).approvals).toEqual([]);
    } finally {
      live.close();
    }
  });

  it("晚到的工具结果更新已有行，也保留新的工具行", async () => {
    const live = await soloRun();
    try {
      toolCall(live, "call-running", "running");
      for (;;) {
        const push = await live.push.next();
        if (push.type === "message" && push.message.body.kind === "tool_call") break;
      }
      runDone(live);
      toolCall(live, "call-running", "ok");
      toolCall(live, "call-late", "running");
      const pushed = await barrier(live.agent, live.push, live.groupId, "晚到的工具之后");
      expect(
        pushed.flatMap((push) =>
          push.type === "message" && push.message.body.kind === "tool_call" ? [push.message.body.status] : [],
        ),
      ).toEqual(["failed", "ok", "running"]);
      expect(
        (await bodiesOf(live, "tool_call")).flatMap((body) => (body.kind === "tool_call" ? [body.status] : [])),
      ).toEqual(["ok", "running"]);
    } finally {
      live.close();
    }
  });

  it("skill_offer 不落卡", async () => {
    const live = await soloRun();
    try {
      runDone(live);
      send(live, { type: "skill_offer", name: "周报", steps: ["拉数据", "写周报"] });
      const pushed = await barrier(live.agent, live.push, live.groupId, "晚到的 skill 之后");
      expect(pushedKinds(pushed)).not.toContain("message:skill_offer");
      expect(await bodiesOf(live, "skill_offer")).toEqual([]);
    } finally {
      live.close();
    }
  });

  it("@ 队友不落消息、不派活", async () => {
    const who = await owner();
    const sales = CreateBotResponse.parse(
      await (await who.client.post("/api/bots", { name: "小销", tags: ["销售"] })).json(),
    ).bot;
    const service = CreateBotResponse.parse(
      await (await who.client.post("/api/bots", { name: "小服", tags: ["客服"] })).json(),
    ).bot;
    const group = CreateGroupResponse.parse(
      await (await who.client.post("/api/groups", { title: "双十一大促", botIds: [sales.id, service.id] })).json(),
    ).group;
    const live = await startRun(who, group.id, "@小销 看看库存");
    try {
      runDone(live);
      send(live, { type: "mention", targetBotId: service.id, text: "@小服 收尾之后才 @ 的" });
      const pushed = await barrier(live.agent, live.push, live.groupId, "晚到的 @ 之后");
      expect(pushedKinds(pushed)).not.toContain("message:bot");
      const texts = (await bodiesOf(live, "bot")).map((body) => body.kind === "bot" && body.text);
      expect(texts).not.toContain("@小服 收尾之后才 @ 的");
      expect(live.agent.received().filter((message) => message.type === "prompt")).toEqual([]);
    } finally {
      live.close();
    }
  });

  it("主助理的方案卡不落", async () => {
    const who = await owner();
    const items = BotListResponse.parse(await (await who.client.get("/api/bots")).json()).items;
    const assistant = items.find((item) => item.bot.role === "assistant");
    if (assistant === undefined) throw new Error("登录之后应当有主助理");
    const live = await startRun(who, assistant.groupId, "帮我起个推广项目");
    try {
      runDone(live);
      send(live, {
        type: "project_offer",
        name: "推广白泽",
        goal: "年底 1000 星",
        team: [{ name: "小内", tags: ["内容"], description: "写帖子" }],
        platforms: [{ kind: "supported", platform: "github" }],
        cadence: "每周两篇",
        firstStep: "先改 README",
      });
      const pushed = await barrier(live.agent, live.push, live.groupId, "晚到的方案卡之后");
      expect(pushedKinds(pushed)).not.toContain("message:project_offer");
      expect(await bodiesOf(live, "project_offer")).toEqual([]);
    } finally {
      live.close();
    }
  });

  it("草稿不新建、计划不落、已有的草稿不被改", async () => {
    const job = await contentJob(serverA, database.db, [{ platform: "x", handle: "baize_x", token: "x-unit" }]);
    const live: Live = job;
    try {
      const [x] = job.accounts;
      if (x === undefined) throw new Error("没挂上账号");
      const early = specOf(x, tweet("收尾之前起的稿"));
      await createDraft(job, early);
      runDone(live);
      sendDraft(job, specOf(x, tweet("收尾之后才起的稿")));
      send(live, {
        type: "plan_propose",
        planId: ContentPlanId.parse(randomUUID()),
        title: "收尾之后的计划",
        drafts: [specOf(x, tweet("计划里的稿"))],
      });
      send(live, { type: "draft_edit", draftId: early.draftId, content: tweet("收尾之后改的") });
      const pushed = await barrier(job.agent, job.push, job.groupId, "晚到的草稿之后");
      expect(pushedKinds(pushed)).not.toContain("draft_updated");
      expect(pushedKinds(pushed)).not.toContain("plan_updated");
      const after = await page(live);
      expect(after.drafts.map((draft) => [draft.id, draft.content.text])).toEqual([[early.draftId, "收尾之前起的稿"]]);
      expect(after.plans).toEqual([]);
    } finally {
      job.close();
    }
  });
  it("交接不建卡，也不排进下一轮派活", async () => {
    const { live, sales, service } = await teamRun();
    try {
      runDone(live);
      send(live, {
        type: "handoff",
        toBotId: service.id,
        done: "库存看完了",
        notDone: "还没回客户",
        next: "回客户",
        checklistIndex: null,
      });
      const pushed = await barrier(live.agent, live.push, live.groupId, "晚到的交接之后");
      expect(pushedKinds(pushed)).not.toContain("handoff_updated");
      expect(pushedKinds(pushed)).not.toContain("message:handoff");
      expect((await page(live)).handoffs).toEqual([]);

      expect((await live.client.post(`/api/groups/${live.groupId}/messages`, { text: "@小销 再看一眼" })).status).toBe(
        201,
      );
      const next = await live.agent.expect("prompt");
      expect(next.botId).toBe(sales.id);
      runDone({ ...live, runId: next.runId });
      await barrier(live.agent, live.push, live.groupId, "下一轮收尾之后");
      expect(
        live.agent.received().filter((message) => message.type === "prompt"),
        "下一轮收尾不派给小服",
      ).toEqual([]);
    } finally {
      live.close();
    }
  });

  it("交接确认不接卡、不换经手", async () => {
    const { live, sales, service } = await teamRun();
    try {
      send(live, {
        type: "handoff",
        toBotId: service.id,
        done: "库存看完了",
        notDone: "还没回客户",
        next: "回客户",
        checklistIndex: null,
      });
      runDone(live);
      const handed = await live.agent.expect("prompt");
      expect(handed).toMatchObject({ botId: service.id, reason: "handoff" });
      const target: Live = { ...live, botId: service.id, runId: handed.runId };
      runDone(target);
      await barrier(live.agent, live.push, live.groupId, "接手的 run 收尾之后");
      const [card] = (await page(live)).handoffs;
      if (card === undefined) throw new Error("收尾之前发的交接应当建卡");

      send(target, { type: "handoff_accept", handoffId: card.id });
      const pushed = await barrier(live.agent, live.push, live.groupId, "晚到的确认之后");
      expect(pushedKinds(pushed)).not.toContain("handoff_updated");
      expect(pushedKinds(pushed)).not.toContain("task_updated");
      expect((await page(live)).handoffs.map((handoff) => handoff.status)).toEqual(["pending"]);
      expect((await groupOf(live)).task.currentBotId).toBe(sales.id);
    } finally {
      live.close();
    }
  });

  it("清单不覆盖用户刚改的那份", async () => {
    const { live } = await teamRun();
    try {
      runDone(live);
      await barrier(live.agent, live.push, live.groupId, "清单用例收尾");
      const newer = [{ text: "用户刚写的新清单", done: false, ownerBotId: null }];
      const task = (await groupOf(live)).task;
      expect((await live.client.patch(`/api/tasks/${task.id}`, { checklist: newer })).status).toBe(200);
      send(live, { type: "task_checklist", checklist: [{ text: "旧 run 的过时清单", done: true, ownerBotId: null }] });
      const pushed = await barrier(live.agent, live.push, live.groupId, "晚到的清单之后");
      const checklists = pushed.flatMap((push) => (push.type === "task_updated" ? [push.task.checklist] : []));
      expect(checklists, "只有用户自己改的那一次").toEqual([newer]);
      expect(pushedKinds(pushed)).not.toContain("message:system");
      expect((await groupOf(live)).task.checklist).toEqual(newer);
    } finally {
      live.close();
    }
  });

  it("设首席不改群、不推", async () => {
    const { live, sales } = await teamRun();
    try {
      expect((await groupOf(live)).group.chiefBotId).toBeNull();
      runDone(live);
      send(live, { type: "set_chief", targetBotId: sales.id });
      const pushed = await barrier(live.agent, live.push, live.groupId, "晚到的首席之后");
      expect(pushedKinds(pushed)).not.toContain("group_updated");
      expect(pushedKinds(pushed)).not.toContain("message:system");
      expect((await groupOf(live)).group.chiefBotId).toBeNull();
    } finally {
      live.close();
    }
  });

  it("主助理改节奏不落、不推", async () => {
    const who = await owner();
    const items = BotListResponse.parse(await (await who.client.get("/api/bots")).json()).items;
    const assistant = items.find((item) => item.bot.role === "assistant");
    if (assistant === undefined) throw new Error("登录之后应当有主助理");
    const first = CreateBotResponse.parse(await (await who.client.post("/api/bots", { name: "小内" })).json()).bot;
    const second = CreateBotResponse.parse(await (await who.client.post("/api/bots", { name: "小社" })).json()).bot;
    const project = CreateGroupResponse.parse(
      await (await who.client.post("/api/groups", { title: "推广白泽", botIds: [first.id, second.id] })).json(),
    );
    expect((await who.client.patch(`/api/tasks/${project.task.id}`, { cadence: "每周两篇" })).status).toBe(200);
    const live = await startRun(who, assistant.groupId, "下周多发点");
    try {
      runDone(live);
      send(live, { type: "set_cadence", projectGroupId: project.group.id, cadence: "每周五篇" });
      const pushed = await barrier(live.agent, live.push, live.groupId, "晚到的节奏之后");
      expect(pushedKinds(pushed)).not.toContain("task_updated");
      expect((await groupOf(live, project.group.id)).task.cadence).toBe("每周两篇");
    } finally {
      live.close();
    }
  });
});

describe("写帧与另一台控制面的握手、收尾按可靠性排队", () => {
  async function endElsewhere(live: Live): Promise<AgentClient> {
    // 这台电脑在 B 上重连，hello 不带这个 run：welcome 回来时 B 上的收尾已经提交。
    const { agent } = await helloAgent(serverB.server.port, live.computer.computerId, live.computer.token);
    return agent;
  }

  it("放行晚到的 delta：不接上、不推，收掉的消息不被重新打开成 streaming", async () => {
    const live = await soloRun();
    const saying = newMessageId();
    await stream(live, saying, "说到一半的这句话", false);
    const held = gates.a.arm(LOCK_OPEN_RUN);
    let elsewhere: AgentClient | undefined;
    try {
      say(live, saying, "卡在闸门上的这一段", false);
      await held.reached;
      elsewhere = await endElsewhere(live);
      expect(await botText(live, saying), "B 上的收尾已经收掉").toEqual({ text: "说到一半的这句话", streaming: false });
      held.release();
      await held.finished;
      const pushed = await pendingPushes(live.push);
      expect(pushesAbout(pushed, saying)).toEqual([]);
      expect(await botText(live, saying)).toEqual({ text: "说到一半的这句话", streaming: false });
    } finally {
      held.release();
      elsewhere?.close();
      live.close();
    }
  });

  it("审批事务未提交时，新连接在电脑锁上等它；之后收尾只使已有卡过期", async () => {
    const live = await soloRun();
    const held = gates.a.arm(LOCK_OPEN_RUN);
    let elsewhere: AgentClient | undefined;
    let reconnecting: Promise<AgentClient> | undefined;
    try {
      requestApproval(live, "call-held");
      await held.reached;
      reconnecting = endElsewhere(live);
      await waitFor(async () => (await lockWaiters("any")) > 0, "新 hello 等可靠审批帧提交");
      expect((await page(live)).approvals).toEqual([]);
      held.release();
      elsewhere = await reconnecting;
      expect((await page(live)).approvals).toMatchObject([{ status: "expired" }]);
      requestApproval({ ...live, agent: elsewhere }, "call-late");
      await waitFor(
        async () =>
          elsewhere
            ?.uplinkAcks()
            .some((ack) => ack.rejected.some((item) => item.code === "run_closed" && item.runId === live.runId)) ===
          true,
        "晚到审批收到 run_closed",
      );
      expect((await page(live)).approvals).toHaveLength(1);
    } finally {
      held.release();
      if (reconnecting !== undefined) elsewhere ??= await reconnecting;
      elsewhere?.close();
      live.close();
    }
  });

  it("可靠工具事务先提交，新连接收尾后同 callId 的完整结果仍覆盖同一行", async () => {
    const live = await soloRun();
    const held = gates.a.arm(/^insert into "messages"/);
    let elsewhere: AgentClient | undefined;
    let reconnecting: Promise<AgentClient> | undefined;
    try {
      toolCall(live, "call-held", "running");
      await held.reached;
      reconnecting = endElsewhere(live);
      await waitFor(async () => (await lockWaiters("any")) > 0, "新 hello 等工具帧提交");
      expect(await bodiesOf(live, "tool_call")).toEqual([]);
      held.release();
      elsewhere = await reconnecting;
      toolCall({ ...live, agent: elsewhere }, "call-held", "ok");
      await waitFor(async () => elsewhere?.uplinkAcks().some((ack) => ack.upTo >= 1) === true, "晚到工具结果已提交");
      expect(await bodiesOf(live, "tool_call")).toMatchObject([{ status: "ok", runId: live.runId }]);
      expect(await bodiesOf(live, "tool_call")).toHaveLength(1);
    } finally {
      held.release();
      if (reconnecting !== undefined) elsewhere ??= await reconnecting;
      elsewhere?.close();
      live.close();
    }
  });

  it("同连接收尾事务未提交时，工具结果排在其后，提交后落库且只一行", async () => {
    const live = await soloRun();
    const ending = gates.a.arm(SETTLE_SQL, "after");
    try {
      runDone(live);
      await ending.reached;
      toolCall(live, "call-racing", "ok");
      expect(await bodiesOf(live, "tool_call")).toEqual([]);
      expect((await runsOf(live)).find((run) => run.id === live.runId)?.ended).toBe(false);
      ending.release();
      await live.agent.ack(live.runId);
      await barrier(live.agent, live.push, live.groupId, "收尾后工具提交");
      expect(await bodiesOf(live, "tool_call")).toMatchObject([{ status: "ok", runId: live.runId }]);
      expect(await bodiesOf(live, "tool_call")).toHaveLength(1);
    } finally {
      ending.release();
      live.close();
    }
  });
});

describe("同 Bot 同群的收尾、建 run、删 Bot 排队", () => {
  /** 同一个 Bot 在同一个群里两条 run 都开着：旧的在 B 上重连回来，新的在 A 上的远程电脑。 */
  async function twoRuns() {
    const old = await soloRun();
    const oldSaying = newMessageId();
    await stream(old, oldSaying, "旧电脑上说到一半的话", false);
    const token = ComputerTokenResponse.parse(await (await old.client.post("/api/computers/remote")).json());
    const remote = (await helloAgent(serverA.server.port, token.computerId, token.token)).agent;
    old.agent.close();
    await old.agent.closed();
    for (;;) {
      const push = await old.push.next();
      if (
        push.type === "computer_updated" &&
        push.computer.id === old.computer.computerId &&
        push.computer.status === "sleeping"
      )
        break;
    }
    expect((await old.client.post(`/api/groups/${old.groupId}/messages`, { text: "接着做下一件" })).status).toBe(201);
    const prompt = await remote.expect("prompt");
    expect(prompt.botId).toBe(old.botId);
    const fresh: Live = { ...old, agent: remote, runId: prompt.runId };
    const freshSaying = newMessageId();
    await stream(fresh, freshSaying, "远程电脑上新 run 正在说", false);
    const back = (await helloAgent(serverB.server.port, old.computer.computerId, old.computer.token, [old.runId]))
      .agent;
    const pushB = await connectPush(serverB.server.port, old.client.cookie ?? "");
    return {
      old: { ...old, agent: back },
      fresh,
      oldSaying,
      freshSaying,
      pushB,
      close: () => {
        back.close();
        remote.close();
        pushB.close();
        old.close();
      },
    };
  }

  it("两条 run 在两台控制面上同时收尾：后到的等先到的提交，两条文字都收成定稿", async () => {
    const pair = await twoRuns();
    // B 上旧 run 的收尾停在收文字之后、提交之前：它看见新 run 还开着，一条没收。
    const first = gates.b.arm(SETTLE_SQL, "after");
    const second = gates.a.arm(SETTLE_SQL, "after");
    try {
      runDone(pair.old);
      await first.reached;
      let secondSettled = false;
      void second.reached.then(() => {
        secondSettled = true;
      });
      runDone(pair.fresh);
      // 有锁时 A 上的收尾在 advisory 锁上等；没锁时它直接收到快照里旧 run 还开着，跳过。
      await waitFor(async () => secondSettled || (await lockWaiters("advisory")) === 1, "A 上的收尾等 B 的收尾锁");
      first.release();
      second.release();
      const onB = await barrier(pair.old.agent, pair.pushB, pair.old.groupId, "B 上收尾之后");
      const onA = await barrier(pair.fresh.agent, pair.old.push, pair.old.groupId, "A 上收尾之后");
      expect((await runsOf(pair.old)).map((run) => run.ended)).toEqual([true, true]);
      expect(await botText(pair.old, pair.oldSaying)).toEqual({ text: "旧电脑上说到一半的话", streaming: false });
      expect(await botText(pair.fresh, pair.freshSaying)).toEqual({
        text: "远程电脑上新 run 正在说",
        streaming: false,
      });
      expect(pushesAbout(onA, pair.oldSaying)).toEqual([settledDelta(pair.old, pair.oldSaying)]);
      expect(pushesAbout(onA, pair.freshSaying)).toEqual([settledDelta(pair.fresh, pair.freshSaying)]);
      expect(pushesAbout(onB, pair.oldSaying), "B 上那次收尾跳过了").toEqual([]);
    } finally {
      first.release();
      second.release();
      pair.close();
    }
  });

  it("收尾持锁期间新消息派活：新 run 等收尾提交后才建出来，收掉的文字不受影响", async () => {
    const live = await soloRun();
    const saying = newMessageId();
    await stream(live, saying, "说到一半就收尾了", false);
    const settling = gates.a.arm(SETTLE_SQL, "after");
    try {
      runDone(live);
      await settling.reached;
      const posting = live.client.post(`/api/groups/${live.groupId}/messages`, { text: "再做一件" });
      // 有锁时建 run 在 advisory 锁上等；没锁时第二条 run 直接出生。
      await waitFor(
        async () => (await lockWaiters("any")) >= 1 || (await runsOf(live)).length === 2,
        "新消息的派活走到了建 run",
      );
      // 收尾还没提交，从外面看 run 还开着；要紧的是只有这一条。
      expect(
        (await runsOf(live)).map((run) => run.id),
        "收尾提交前不冒出新 run",
      ).toEqual([live.runId]);
      settling.release();
      expect((await posting).status).toBe(201);
      const prompt = await live.agent.expect("prompt");
      expect(await runsOf(live)).toEqual([
        { id: live.runId, ended: true },
        { id: prompt.runId, ended: false },
      ]);
      const pushed = await barrier(live.agent, live.push, live.groupId, "新 run 建出来之后");
      expect(pushesAbout(pushed, saying)).toEqual([settledDelta(live, saying)]);
      expect(await botText(live, saying)).toEqual({ text: "说到一半就收尾了", streaming: false });
    } finally {
      settling.release();
      live.close();
    }
  });

  it("清单帧已拿 run 的共享锁时删 Bot：删除等它提交，回 204 不死锁，清单在删除前生效", async () => {
    const { live, sales } = await teamRun();
    const checklist = [{ text: "和删 Bot 同时到的清单", done: false, ownerBotId: null }];
    const held = gates.a.arm(LOCK_OPEN_RUN, "after");
    let deleting: Promise<Response> | undefined;
    try {
      send(live, { type: "task_checklist", checklist });
      await held.reached;
      deleting = live.client.delete(`/api/bots/${sales.id}`);
      await waitFor(async () => (await lockWaiters("any")) === 1, "删 Bot 在 run 行上等清单帧的共享锁");
      held.release();
      const response = await deleting;
      expect(response.status, await response.clone().text()).toBe(204);
      const pushed = await barrier(live.agent, live.push, live.groupId, "删 Bot 和清单都处理完");
      const checklists = pushed.flatMap((push) => (push.type === "task_updated" ? [push.task.checklist] : []));
      expect(checklists).toContainEqual(checklist);
      expect((await groupOf(live)).task.checklist).toEqual(checklist);
    } finally {
      held.release();
      await deleting;
      live.close();
    }
  });

  it("帧已过 resolveRun 时它的 Bot 被删、外键把 run 的 bot_id 置空：放行后一行不写、不推", async () => {
    const { live, sales, service } = await teamRun();
    expect((await live.client.delete(`/api/bots/${service.id}`)).status).toBe(204);
    const before = (await groupOf(live)).task.checklist;
    const checklist = [{ text: "Bot 删了之后的清单", done: false, ownerBotId: null }];
    const held = gates.a.arm(LOCK_OPEN_RUN);
    try {
      send(live, { type: "task_checklist", checklist });
      await held.reached;
      expect((await live.client.delete(`/api/bots/${sales.id}`)).status).toBe(204);
      expect((await live.client.get(`/api/groups/${live.groupId}`)).status).toBe(404);
      held.release();
      await held.finished;
      const pushed = await barrier(live.agent, live.push, live.groupId, "删空之后的清单");
      // 删 Bot 自己会推经手清空的 task_updated，这里只看清单帧的产物。
      const checklists = pushed.flatMap((push) => (push.type === "task_updated" ? [push.task.checklist] : []));
      expect(checklists).not.toContainEqual(checklist);
      expect(pushedKinds(pushed)).not.toContain("message:system");
      const [run] = await database.sql<{ bot_id: string | null }[]>`SELECT bot_id FROM runs WHERE id = ${live.runId}`;
      expect(run?.bot_id).toBeNull();
      const [task] = await database.sql<{ checklist: unknown }[]>`
        SELECT checklist FROM tasks WHERE group_id = ${live.groupId}`;
      expect(task?.checklist).toEqual(before);
    } finally {
      held.release();
      live.close();
    }
  });

  it("别的 Bot 正在确认被删 Bot 交出来的活：删除等确认提交，回 204 不死锁，经手换成确认的那位", async () => {
    const { live, sales, service } = await teamRun();
    send(live, {
      type: "handoff",
      toBotId: service.id,
      done: "库存看完了",
      notDone: "",
      next: "回客户",
      checklistIndex: null,
    });
    runDone(live);
    const handed = await live.agent.expect("prompt");
    expect(handed).toMatchObject({ botId: service.id, reason: "handoff" });
    if (handed.handoffId === undefined) throw new Error("交接派活应当带 handoffId");
    const target: Live = { ...live, botId: service.id, runId: handed.runId };
    // 确认停在改完交接卡之后、换经手之前：它拿着交接卡的行锁，还没碰任务卡。
    const accepting = gates.a.arm(/^update "handoffs" set "status"/, "after");
    let deleting: Promise<Response> | undefined;
    try {
      send(target, { type: "handoff_accept", handoffId: handed.handoffId });
      await accepting.reached;
      deleting = live.client.delete(`/api/bots/${sales.id}`);
      await waitFor(async () => (await lockWaiters("any")) === 1, "删小销在交接卡上等确认");
      accepting.release();
      const response = await deleting;
      expect(response.status, await response.clone().text()).toBe(204);
      await barrier(live.agent, live.push, live.groupId, "确认和删除都处理完");
      expect((await groupOf(live)).task.currentBotId, "确认在删除之前生效").toBe(service.id);
    } finally {
      accepting.release();
      await deleting;
      live.close();
    }
  });

  it("删 Bot 已锁住它的 run 之后才建的群里派给它：建 run 等删除提交，Bot 已不在群里就不建，删除回 204 不死锁", async () => {
    const live = await soloRun();
    const other = CreateBotResponse.parse(await (await live.client.post("/api/bots", { name: "小新" })).json()).bot;
    await live.agent.expect("config");
    // 删除停在锁住 run 行之后、动 bots 之前，这时它读成员表、锁 run 都已做完。
    const deletion = gates.a.arm(/^select "id" from "runs" where .*for update$/, "after");
    let writing: ReturnType<typeof gates.a.arm> | undefined;
    let deleting: Promise<Response> | undefined;
    let posting: Promise<Response> | undefined;
    try {
      deleting = live.client.delete(`/api/bots/${live.botId}`);
      await deletion.reached;
      const created = await live.client.post("/api/groups", {
        title: "删除开始之后才建的群",
        botIds: [live.botId, other.id],
      });
      const group = CreateGroupResponse.parse(await created.json()).group;
      posting = live.client.post(`/api/groups/${group.id}/messages`, { text: "@小服 新群里的活" });
      const prompted = () => live.agent.received().find((message) => message.type === "prompt");
      // 有锁时建 run 在 Bot 锁上等删除；没锁时新 run 当场出生，prompt 发了出来。
      await waitFor(
        async () => prompted() !== undefined || (await lockWaiters("advisory")) === 1,
        "新群的派活走到了建 run",
      );
      const prompt = prompted();
      if (prompt?.type === "prompt") {
        // 漏进来的 run 上来一条清单帧：它拿着 run 的共享锁去写任务卡，删除的级联已经先改了这张卡的经手。
        writing = gates.a.arm(LOCK_OPEN_RUN, "after");
        send(
          { ...live, groupId: group.id, runId: prompt.runId },
          { type: "task_checklist", checklist: [{ text: "漏进来的 run 的清单", done: false, ownerBotId: null }] },
        );
        await writing.reached;
        deletion.release();
        await waitFor(async () => (await lockWaiters("any")) === 1, "删除在漏进来的 run 上等清单帧");
        writing.release();
      }
      deletion.release();
      const response = await deleting;
      expect(response.status, await response.clone().text()).toBe(204);
      expect((await posting).status).toBe(201);
      expect(prompt, "删除提交之后不再给它派活").toBeUndefined();
      expect(await database.sql`SELECT id FROM runs WHERE group_id = ${group.id}`).toEqual([]);
      expect((await groupOf(live, group.id)).group.botIds).toEqual([other.id]);
    } finally {
      deletion.release();
      writing?.release();
      await deleting;
      await posting;
      live.close();
    }
  });
});
