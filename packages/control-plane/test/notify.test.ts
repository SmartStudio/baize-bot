import { randomUUID } from "node:crypto";
import {
  CreateBotResponse,
  MessageId,
  RoutineResponse,
  type BotId,
  type GroupId,
  type Routine,
  type RunId,
  type ServerPush,
  type UserId,
} from "@baize/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_CONFIG, startServer } from "../src/server.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { ApiClient, TEST_CREDENTIALS_KEY, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, waitFor, type TestComputer } from "./helpers/fixtures.js";
import { connectPush, type PushClient } from "./helpers/ws.js";

let database: TestDb;
let server: TestServer;
let clock = new Date("2030-01-01T02:00:00.000Z");
const DISCONNECT_GRACE_MS = 5_000;

beforeAll(async () => {
  database = await createTestDb();
  const running = await startServer({
    db: database.db,
    port: 0,
    config: DEFAULT_RUNTIME_CONFIG,
    credentialsKey: TEST_CREDENTIALS_KEY,
    toolSecretKey: "a".repeat(64),
    disconnectGraceMs: DISCONNECT_GRACE_MS,
    notificationScheduler: { now: () => clock, intervalMs: 60 * 60_000 },
    publisher: { intervalMs: 24 * 60 * 60_000 },
  });
  server = { server: running, client: () => new ApiClient(running.port), close: () => running.close() };
});

beforeEach(() => {
  clock = new Date("2030-01-01T02:00:00.000Z");
});

afterAll(async () => {
  await server.close();
  await database.close();
});

const ROUTINE_NAME = "每日工单早报";
const OFFLINE_STUCK = `例行任务「${ROUTINE_NAME}」没跑：电脑不在线`;
const SUMMARY_ONE = "免打扰期间有 1 件事，打开「今天」看";

type Notice = Extract<ServerPush, { type: "notify" }>["notice"];

type Owner = {
  readonly userId: UserId;
  readonly client: ApiClient;
  readonly computer: TestComputer;
  readonly groupId: GroupId;
  readonly botId: BotId;
};

async function ownerWithBot(port = server.server.port): Promise<Owner> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = new ApiClient(port);
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小服" })).json());
  return { userId: user.id, client, computer, groupId: created.group.id, botId: created.bot.id };
}

async function makeRoutine(owner: Owner): Promise<Routine> {
  const response = await owner.client.post(`/api/bots/${owner.botId}/routines`, {
    name: ROUTINE_NAME,
    instruction: "把今天的工单汇总一下",
    triggers: [],
    onFailure: "stop_and_tell",
  });
  expect(response.status).toBe(201);
  return RoutineResponse.parse(await response.json()).routine;
}

async function runRoutineNow(owner: Owner, routine: Routine): Promise<void> {
  expect((await owner.client.post(`/api/routines/${routine.id}/run`)).status).toBe(202);
}

/** 一直读推送直到标记出现，返回标记之前的 notify。 */
async function noticesBefore(push: PushClient, isMarker: (item: ServerPush) => boolean): Promise<Notice[]> {
  const notices: Notice[] = [];
  for (;;) {
    const item = await push.next();
    if (isMarker(item)) return notices;
    if (item.type === "notify") notices.push(item.notice);
  }
}

/** 改一次 Bot 描述当顺序标记：它落地时，之前发生的事该推的 notify 都已经推过了。 */
async function noticesBeforeBotMarker(owner: Owner, push: PushClient): Promise<Notice[]> {
  const description = `标记 ${randomUUID()}`;
  expect((await owner.client.patch(`/api/bots/${owner.botId}`, { description })).status).toBe(200);
  return noticesBefore(push, (item) => item.type === "bot_updated" && item.bot.description === description);
}

/** 连上推送后先收齐预期的几条 notify，再用标记确认后面没有多出来的。 */
async function noticesOnConnect(owner: Owner, push: PushClient, expected: number): Promise<Notice[]> {
  const notices: Notice[] = [];
  while (notices.length < expected) {
    const item = await push.next();
    if (item.type === "notify") notices.push(item.notice);
  }
  return [...notices, ...(await noticesBeforeBotMarker(owner, push))];
}

type Job = { readonly agent: AgentClient; readonly push: PushClient; readonly runId: RunId; close(): void };

/** 推送连接在 prompt 之后才连，派活那一串推送都不进收件箱。 */
async function startJob(owner: Owner, dispatch: () => Promise<void>): Promise<Job> {
  const { agent } = await helloAgent(server.server.port, owner.computer.computerId, owner.computer.token);
  await dispatch();
  const prompt = await agent.expect("prompt");
  const push = await connectPush(server.server.port, owner.client.cookie ?? "");
  return {
    agent,
    push,
    runId: prompt.runId,
    close: () => {
      agent.close();
      push.close();
    },
  };
}

function userJob(owner: Owner): Promise<Job> {
  return startJob(owner, async () => {
    expect((await owner.client.post(`/api/groups/${owner.groupId}/messages`, { text: "干活" })).status).toBe(201);
  });
}

async function routineJob(owner: Owner): Promise<Job> {
  const routine = await makeRoutine(owner);
  return startJob(owner, () => runRoutineNow(owner, routine));
}

function sendText(owner: Owner, job: Job, delta: string): void {
  job.agent.send({
    type: "bot_text",
    runId: job.runId,
    botId: owner.botId,
    groupId: owner.groupId,
    messageId: MessageId.parse(randomUUID()),
    delta,
    done: true,
  });
}

function sendRunDone(owner: Owner, job: Job): void {
  job.agent.send({
    type: "run_done",
    runId: job.runId,
    botId: owner.botId,
    groupId: owner.groupId,
    steps: 1,
    inputTokens: 10,
    outputTokens: 20,
  });
}

/**
 * 同一条电脑连接再报一条不带 runId 的错当标记，报文按到达顺序处理，run_done 该推的都排在它前面。
 * 不用 bot_text：run 收尾后它名下的话不再落库。
 */
function noticesBeforeErrorMarker(owner: Owner, job: Job): Promise<Notice[]> {
  const marker = `顺序标记 ${randomUUID()}`;
  job.agent.send({ type: "agent_error", code: "runner_failed", detail: marker, groupId: owner.groupId });
  return noticesBefore(
    job.push,
    (item) => item.type === "message" && item.message.body.kind === "system" && item.message.body.text.endsWith(marker),
  );
}

async function expectOfflineMessages(owner: Owner, push: PushClient): Promise<void> {
  expect((await owner.client.post(`/api/groups/${owner.groupId}/messages`, { text: "看看库存" })).status).toBe(201);
  const user = await push.next();
  expect(user.type === "message" ? user.message.body.kind : null).toBe("user");
  const offline = await push.next();
  expect(offline.type === "message" && offline.message.body.kind === "system" ? offline.message.body.text : null).toBe(
    "电脑不在线，这条没派出去，电脑回来后再说一次",
  );
}

async function computerStatus(owner: Owner): Promise<string> {
  const rows = await database.sql<{ status: string }[]>`
    SELECT status FROM computers WHERE id = ${owner.computer.computerId}
  `;
  return rows[0]?.status ?? "";
}

async function graceState(owner: Owner): Promise<{
  now_ms: number;
  lease_until_ms: number;
  open_runs: number;
  prompts: number;
}> {
  const [row] = await database.sql<{ now_ms: string; lease_until_ms: string; open_runs: number; prompts: number }[]>`
    SELECT extract(epoch FROM clock_timestamp()) * 1000 AS now_ms,
      extract(epoch FROM c.lease_until) * 1000 AS lease_until_ms,
      (SELECT count(*)::int FROM runs WHERE group_id = ${owner.groupId} AND ended_at IS NULL) AS open_runs,
      (SELECT count(*)::int FROM agent_outbox WHERE computer_id = c.id AND body->>'type' = 'prompt') AS prompts
    FROM computers c WHERE c.id = ${owner.computer.computerId}
  `;
  if (row === undefined) throw new Error("电脑租约状态不存在");
  return { ...row, now_ms: Number(row.now_ms), lease_until_ms: Number(row.lease_until_ms) };
}

describe("confirm 和 result", () => {
  it("新审批请求推一条 confirm", async () => {
    const owner = await ownerWithBot();
    const job = await userJob(owner);
    try {
      job.agent.send({
        type: "approval_request",
        runId: job.runId,
        botId: owner.botId,
        groupId: owner.groupId,
        callId: "refund-1",
        tool: "shop.refund",
        action: "spend",
        target: null,
        view: { kind: "mcp", server: "shop", tool: "refund", params: [], raw: "退款" },
      });

      expect((await job.push.next()).type).toBe("approval_updated");
      expect((await job.push.next()).type).toBe("message");
      const notified = await job.push.next();
      expect(notified.type === "notify" ? notified.notice : null).toMatchObject({
        kind: "confirm",
        groupId: owner.groupId,
      });
    } finally {
      job.close();
    }
  });

  it("用户消息触发的 run 有可见回复也不推 result", async () => {
    const owner = await ownerWithBot();
    const job = await userJob(owner);
    try {
      sendText(owner, job, "库存结果已经整理好");
      sendRunDone(owner, job);
      expect(await noticesBeforeErrorMarker(owner, job), "用户就在群里看着，回一句话不该弹通知").toEqual([]);
    } finally {
      job.close();
    }
  });

  it("例行 run 有可见回复推一条 result", async () => {
    const owner = await ownerWithBot();
    const job = await routineJob(owner);
    try {
      sendText(owner, job, "工单早报已经整理好");
      sendRunDone(owner, job);
      const notices = await noticesBeforeErrorMarker(owner, job);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({
        kind: "result",
        text: `例行任务「${ROUTINE_NAME}」做完了，打开群聊看结果`,
        groupId: owner.groupId,
      });
    } finally {
      job.close();
    }
  });

  it("例行 run 没有可见回复不推 result", async () => {
    const owner = await ownerWithBot();
    const job = await routineJob(owner);
    try {
      sendRunDone(owner, job);
      expect(await noticesBeforeErrorMarker(owner, job)).toEqual([]);
    } finally {
      job.close();
    }
  });
});

describe("stuck", () => {
  it("用户自己发的消息派不出去，群里落一句 system，不再推 stuck", async () => {
    const owner = await ownerWithBot();
    const push = await connectPush(server.server.port, owner.client.cookie ?? "");
    try {
      await expectOfflineMessages(owner, push);
      expect(await noticesBeforeBotMarker(owner, push)).toEqual([]);
    } finally {
      push.close();
    }
  });

  it("离线期例行只推一次 stuck，断线宽限内的例行入箱并在重连后送达", async () => {
    const owner = await ownerWithBot();
    const routine = await makeRoutine(owner);
    const push = await connectPush(server.server.port, owner.client.cookie ?? "");
    try {
      for (let i = 0; i < 3; i += 1) await runRoutineNow(owner, routine);
      const first = await noticesBeforeBotMarker(owner, push);
      expect(first.map((notice) => [notice.kind, notice.text, notice.groupId])).toEqual([
        ["stuck", OFFLINE_STUCK, owner.groupId],
      ]);

      const { agent } = await helloAgent(server.server.port, owner.computer.computerId, owner.computer.token);
      agent.close();
      await waitFor(async () => (await computerStatus(owner)) === "sleeping", "电脑变休眠");

      const sleeping = await graceState(owner);
      await runRoutineNow(owner, routine);
      const placed = await graceState(owner);
      expect(placed.now_ms, "例行派活完成必须仍在已捕获的断线宽限内").toBeLessThan(sleeping.lease_until_ms);
      expect(placed).toMatchObject({ open_runs: 1, prompts: 1 });
      const reconnected = await helloAgent(server.server.port, owner.computer.computerId, owner.computer.token);
      try {
        expect((await graceState(owner)).now_ms, "重连握手完成仍在同一次断线宽限内").toBeLessThan(
          sleeping.lease_until_ms,
        );
        const prompt = await reconnected.agent.expect("prompt");
        expect(prompt.origin).toEqual({ kind: "routine" });
        reconnected.agent.send({
          type: "run_done",
          runId: prompt.runId,
          botId: owner.botId,
          groupId: owner.groupId,
          steps: 1,
          inputTokens: 10,
          outputTokens: 20,
        });
        await reconnected.agent.ack(prompt.runId);
      } finally {
        reconnected.agent.close();
      }
      expect(await noticesBeforeBotMarker(owner, push), "宽限期内已派出的例行不应记成 stuck").toEqual([]);
    } finally {
      push.close();
    }
  });

  it("派活等电脑锁跨过租约到期时不建 run、不留 prompt，例行推真实离线的 stuck", async () => {
    const short = await startServer({
      db: database.db,
      port: 0,
      config: DEFAULT_RUNTIME_CONFIG,
      credentialsKey: TEST_CREDENTIALS_KEY,
      toolSecretKey: "a".repeat(64),
      disconnectGraceMs: 200,
      notificationScheduler: { now: () => clock, intervalMs: 60 * 60_000 },
      publisher: { intervalMs: 24 * 60 * 60_000 },
    });
    let agent: AgentClient | undefined;
    let push: PushClient | undefined;
    let release: (() => void) | undefined;
    let blocker: Promise<unknown> | undefined;
    let running: Promise<void> | undefined;
    try {
      const owner = await ownerWithBot(short.port);
      const routine = await makeRoutine(owner);
      agent = (await helloAgent(short.port, owner.computer.computerId, owner.computer.token)).agent;
      push = await connectPush(short.port, owner.client.cookie ?? "");
      agent.close();
      await noticesBefore(push, (item) => item.type === "computer_updated" && item.computer.status === "sleeping");
      const sleeping = await graceState(owner);
      let held!: () => void;
      let blockerPid = 0;
      const locked = new Promise<void>((resolve) => (held = resolve));
      const unlock = new Promise<void>((resolve) => (release = resolve));
      blocker = database.sql.begin(async (tx) => {
        const [backend] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        if (backend === undefined) throw new Error("持锁连接不存在");
        blockerPid = backend.pid;
        await tx`SELECT id FROM computers WHERE id = ${owner.computer.computerId} FOR NO KEY UPDATE`;
        held();
        await unlock;
      });
      await locked;
      running = runRoutineNow(owner, routine);
      let transactionStartedAt = Number.POSITIVE_INFINITY;
      await waitFor(async () => {
        const [waiting] = await database.sql<{ xact_start_ms: string }[]>`
          SELECT extract(epoch FROM xact_start) * 1000 AS xact_start_ms FROM pg_stat_activity
          WHERE datname = ${database.databaseName} AND wait_event_type = 'Lock'
            AND query ILIKE '%computers%' AND ${blockerPid} = ANY(pg_blocking_pids(pid))
        `;
        if (waiting === undefined) return false;
        transactionStartedAt = Number(waiting.xact_start_ms);
        return true;
      }, "例行派活排在测试持有的电脑锁后面");
      expect(transactionStartedAt, "事务在宽限内开始，不能拿冻结的事务时间通过放锁后的过期校验").toBeLessThan(
        sleeping.lease_until_ms,
      );
      await waitFor(async () => (await graceState(owner)).now_ms > sleeping.lease_until_ms, "数据库时钟越过租约到期");
      release?.();
      await blocker;
      await running;
      const after = await graceState(owner);
      expect(after.now_ms).toBeGreaterThan(sleeping.lease_until_ms);
      expect(after).toMatchObject({ open_runs: 0, prompts: 0 });
      const records = await database.sql<{ status: string; note: string }[]>`
        SELECT status, note FROM routine_runs WHERE routine_id = ${routine.id}
      `;
      expect(records, "没有派出 run 的例行必须按真实离线原因收尾").toEqual([
        { status: "failed", note: "电脑不在线，没跑起来" },
      ]);
      expect(
        (await noticesBeforeBotMarker(owner, push)).map((notice) => [notice.kind, notice.text, notice.groupId]),
      ).toEqual([["stuck", OFFLINE_STUCK, owner.groupId]]);
    } finally {
      release?.();
      await Promise.allSettled([blocker, running]);
      agent?.close();
      push?.close();
      await short.close();
    }
  });

  it("例行 run 跑到一半电脑断线，收尾时推一条 stuck", async () => {
    const owner = await ownerWithBot();
    const job = await routineJob(owner);
    try {
      job.agent.close();
      await waitFor(async () => (await computerStatus(owner)) === "sleeping", "电脑变休眠");
      // 重连时不报这个 run，控制面把它当丢了收尾；标记是紧随其后的上线推送。
      const { agent } = await helloAgent(server.server.port, owner.computer.computerId, owner.computer.token);
      agent.close();
      const notices = await noticesBefore(
        job.push,
        (item) => item.type === "computer_updated" && item.computer.status === "online",
      );
      expect(notices.map((notice) => [notice.kind, notice.text, notice.groupId])).toEqual([
        ["stuck", `例行任务「${ROUTINE_NAME}」没跑完：电脑中途断线`, owner.groupId],
      ]);
    } finally {
      job.close();
    }
  });

  it("用户消息触发的 run 中途断线，不推 stuck", async () => {
    const owner = await ownerWithBot();
    const job = await userJob(owner);
    try {
      job.agent.close();
      await waitFor(async () => (await computerStatus(owner)) === "sleeping", "电脑变休眠");
      const { agent } = await helloAgent(server.server.port, owner.computer.computerId, owner.computer.token);
      agent.close();
      const notices = await noticesBefore(
        job.push,
        (item) => item.type === "computer_updated" && item.computer.status === "online",
      );
      expect(notices, "用户自己的消息断线时群里已经看得到，不该弹 stuck").toEqual([]);
    } finally {
      job.close();
    }
  });

  it("用户没有推送连接时，例行派不出去，连上后收到一条 stuck", async () => {
    const owner = await ownerWithBot();
    const routine = await makeRoutine(owner);
    const failedAt = clock;
    await runRoutineNow(owner, routine);

    clock = new Date("2030-01-01T03:00:00.000Z");
    const push = await connectPush(server.server.port, owner.client.cookie ?? "");
    try {
      expect(await noticesOnConnect(owner, push, 1), "Mac 睡着时没跑成的例行，醒来要知道").toEqual([
        { kind: "stuck", text: OFFLINE_STUCK, groupId: owner.groupId, at: failedAt.toISOString() },
      ]);
    } finally {
      push.close();
    }
  });

  it("同一段离线期派不出去三次，连上后只收到一条", async () => {
    const owner = await ownerWithBot();
    const routine = await makeRoutine(owner);
    for (let i = 0; i < 3; i += 1) await runRoutineNow(owner, routine);

    const push = await connectPush(server.server.port, owner.client.cookie ?? "");
    try {
      expect((await noticesOnConnect(owner, push, 1)).map((notice) => notice.text)).toEqual([OFFLINE_STUCK]);
    } finally {
      push.close();
    }
  });

  it("连上时先推免打扰汇总，再推宽限期内完成的例行结果", async () => {
    const owner = await ownerWithBot();
    await owner.client.patch("/api/settings", { dndFrom: "09:00", dndTo: "11:00" });
    const routine = await makeRoutine(owner);
    await runRoutineNow(owner, routine);

    clock = new Date("2030-01-01T03:00:00.000Z");
    const { agent } = await helloAgent(server.server.port, owner.computer.computerId, owner.computer.token);
    agent.close();
    await waitFor(async () => (await computerStatus(owner)) === "sleeping", "电脑变休眠");
    await runRoutineNow(owner, routine);

    const push = await connectPush(server.server.port, owner.client.cookie ?? "");
    try {
      const reconnected = await helloAgent(server.server.port, owner.computer.computerId, owner.computer.token);
      try {
        const prompt = await reconnected.agent.expect("prompt");
        expect(prompt.origin).toEqual({ kind: "routine" });
        reconnected.agent.send({
          type: "bot_text",
          runId: prompt.runId,
          botId: owner.botId,
          groupId: owner.groupId,
          messageId: MessageId.parse(randomUUID()),
          delta: "例行结果已整理好",
          done: true,
        });
        reconnected.agent.send({
          type: "run_done",
          runId: prompt.runId,
          botId: owner.botId,
          groupId: owner.groupId,
          steps: 1,
          inputTokens: 10,
          outputTokens: 20,
        });
        await reconnected.agent.ack(prompt.runId);
        expect((await noticesOnConnect(owner, push, 2)).map((notice) => [notice.kind, notice.text])).toEqual([
          ["result", SUMMARY_ONE],
          ["result", `例行任务「${ROUTINE_NAME}」做完了，打开群聊看结果`],
        ]);
      } finally {
        reconnected.agent.close();
      }
    } finally {
      push.close();
    }
  });
});

describe("免打扰", () => {
  it("区间内不推，结束时只推一条汇总", async () => {
    const owner = await ownerWithBot();
    await owner.client.patch("/api/settings", { dndFrom: "09:00", dndTo: "11:00" });
    const routine = await makeRoutine(owner);
    const push = await connectPush(server.server.port, owner.client.cookie ?? "");
    try {
      await runRoutineNow(owner, routine);
      expect(await noticesBeforeBotMarker(owner, push), "免打扰内不推").toEqual([]);

      clock = new Date("2030-01-01T03:00:00.000Z");
      await server.server.notifications.tick();
      expect(await noticesBeforeBotMarker(owner, push)).toEqual([
        { kind: "result", text: SUMMARY_ONE, groupId: null, at: clock.toISOString() },
      ]);
    } finally {
      push.close();
    }
  });

  it("跨午夜区间到第二天结束时汇总", async () => {
    clock = new Date("2030-01-01T15:30:00.000Z");
    const owner = await ownerWithBot();
    await owner.client.patch("/api/settings", { dndFrom: "22:00", dndTo: "08:00" });
    const routine = await makeRoutine(owner);
    const push = await connectPush(server.server.port, owner.client.cookie ?? "");
    try {
      await runRoutineNow(owner, routine);
      expect(await noticesBeforeBotMarker(owner, push)).toEqual([]);

      clock = new Date("2030-01-01T23:59:00.000Z");
      await server.server.notifications.tick();
      expect(await noticesBeforeBotMarker(owner, push), "跨午夜区间结束前不能汇总").toEqual([]);

      clock = new Date("2030-01-02T00:00:00.000Z");
      await server.server.notifications.tick();
      expect((await noticesBeforeBotMarker(owner, push)).map((notice) => notice.text)).toEqual([SUMMARY_ONE]);
    } finally {
      push.close();
    }
  });

  it("关闭通知后一条也不推", async () => {
    const owner = await ownerWithBot();
    await owner.client.patch("/api/settings", { notify: false });
    const routine = await makeRoutine(owner);
    const push = await connectPush(server.server.port, owner.client.cookie ?? "");
    try {
      await runRoutineNow(owner, routine);
      expect(await noticesBeforeBotMarker(owner, push)).toEqual([]);
    } finally {
      push.close();
    }
  });

  it("缩短免打扰后，在新的结束时刻汇总", async () => {
    const owner = await ownerWithBot();
    await owner.client.patch("/api/settings", { dndFrom: "09:00", dndTo: "11:00" });
    const routine = await makeRoutine(owner);
    const push = await connectPush(server.server.port, owner.client.cookie ?? "");
    try {
      await runRoutineNow(owner, routine);
      expect(await noticesBeforeBotMarker(owner, push)).toEqual([]);
      expect((await owner.client.patch("/api/settings", { dndFrom: "09:00", dndTo: "10:30" })).status).toBe(200);

      clock = new Date("2030-01-01T02:30:00.000Z");
      await server.server.notifications.tick();
      expect(
        (await noticesBeforeBotMarker(owner, push)).map((notice) => notice.text),
        "不能等到原来的 11:00",
      ).toEqual([SUMMARY_ONE]);
    } finally {
      push.close();
    }
  });

  it("免打扰结束时没有连接，连上后收到汇总", async () => {
    const owner = await ownerWithBot();
    await owner.client.patch("/api/settings", { dndFrom: "09:00", dndTo: "11:00" });
    const routine = await makeRoutine(owner);
    await runRoutineNow(owner, routine);

    clock = new Date("2030-01-01T03:00:00.000Z");
    await server.server.notifications.tick();

    const push = await connectPush(server.server.port, owner.client.cookie ?? "");
    try {
      expect((await noticesBeforeBotMarker(owner, push)).map((notice) => notice.text)).toEqual([SUMMARY_ONE]);
    } finally {
      push.close();
    }
  });

  it("设置改成不在免打扰里时，先汇总攒下的再发这一条", async () => {
    const owner = await ownerWithBot();
    await owner.client.patch("/api/settings", { dndFrom: "09:00", dndTo: "11:00" });
    const routine = await makeRoutine(owner);
    const push = await connectPush(server.server.port, owner.client.cookie ?? "");
    try {
      await runRoutineNow(owner, routine);
      expect(await noticesBeforeBotMarker(owner, push)).toEqual([]);
      expect((await owner.client.patch("/api/settings", { dndFrom: null, dndTo: null })).status).toBe(200);

      const { agent } = await helloAgent(server.server.port, owner.computer.computerId, owner.computer.token);
      try {
        expect((await owner.client.post(`/api/groups/${owner.groupId}/messages`, { text: "退款" })).status).toBe(201);
        const prompt = await agent.expect("prompt");
        agent.send({
          type: "approval_request",
          runId: prompt.runId,
          botId: owner.botId,
          groupId: owner.groupId,
          callId: "refund-1",
          tool: "shop.refund",
          action: "spend",
          target: null,
          view: { kind: "mcp", server: "shop", tool: "refund", params: [], raw: "退款" },
        });
        const notices = await noticesBefore(push, (item) => item.type === "notify" && item.notice.kind === "confirm");
        expect(
          notices.map((notice) => notice.text),
          "汇总要排在 confirm 前面",
        ).toEqual([SUMMARY_ONE]);
      } finally {
        agent.close();
      }
    } finally {
      push.close();
    }
  });
});
