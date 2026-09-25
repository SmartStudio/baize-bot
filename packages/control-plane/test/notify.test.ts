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
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { ApiClient, startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, waitFor, type TestComputer } from "./helpers/fixtures.js";
import { connectPush, type PushClient } from "./helpers/ws.js";

let database: TestDb;
let server: TestServer;
let clock = new Date("2030-01-01T02:00:00.000Z");

beforeAll(async () => {
  database = await createTestDb();
  server = await startTestServer(database.db, {}, undefined, { now: () => clock, intervalMs: 60 * 60_000 });
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

async function ownerWithBot(): Promise<Owner> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
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

/** 同一条电脑连接再发一段话当标记，报文按到达顺序处理，run_done 该推的都排在它前面。 */
function noticesBeforeTextMarker(owner: Owner, job: Job): Promise<Notice[]> {
  const marker = `顺序标记 ${randomUUID()}`;
  sendText(owner, job, marker);
  return noticesBefore(job.push, (item) => item.type === "message_delta" && item.delta === marker);
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
      expect(await noticesBeforeTextMarker(owner, job), "用户就在群里看着，回一句话不该弹通知").toEqual([]);
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
      const notices = await noticesBeforeTextMarker(owner, job);
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
      expect(await noticesBeforeTextMarker(owner, job)).toEqual([]);
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

  it("离线期连跑三次例行只推一次 stuck，代理 hello 之后再派不出去又推一次", async () => {
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

      await runRoutineNow(owner, routine);
      await runRoutineNow(owner, routine);
      const second = await noticesBeforeBotMarker(owner, push);
      expect(
        second.map((notice) => notice.text),
        "hello 结束了上一段离线期",
      ).toEqual([OFFLINE_STUCK]);
    } finally {
      push.close();
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
