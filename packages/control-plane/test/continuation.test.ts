import { randomUUID } from "node:crypto";
import {
  ComputerChoices,
  ComputerTokenResponse,
  CreateBotResponse,
  CreateGroupResponse,
  GroupId,
  MessageId,
  MessageListResponse,
  PokerTableResponse,
  RoutineListResponse,
  RoutineResponse,
  type BotId,
  type ComputerKind,
  type ControlToAgent,
  type ModelPurpose,
  type OnFailure,
  type RoutineBoundary,
  type RunId,
  type ServerPush,
  type ToolView,
  type UserId,
} from "@baize/shared";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MENTION_LOOP_NOTICE } from "../src/agent/group-turn.js";
import type { Db } from "../src/db/client.js";
import { databaseUrl } from "../src/env.js";
import { DEFAULT_RUNTIME_CONFIG, startServer } from "../src/server.js";
import { ApiClient, TEST_CREDENTIALS_KEY, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { gatedDb, type QueryGate } from "./helpers/gated-db.js";
import { PASSWORD, makeComputer, makeUser, type TestComputer } from "./helpers/fixtures.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { connectPush, type PushClient } from "./helpers/ws.js";

let database: TestDb;
let server: TestServer;

type Prompt = Extract<ControlToAgent, { type: "prompt" }>;

const HOUR = 60 * 60 * 1000;

async function boot(db: Db = database.db, start: typeof startServer = startServer): Promise<TestServer> {
  const running = await start({
    db,
    port: 0,
    credentialsKey: TEST_CREDENTIALS_KEY,
    toolSecretKey: "a".repeat(64),
    // 每百万输入 token 800 元：输入 1000 是 ¥0.80，例行运行记录的 note 里看得出是哪一轮的花费。
    config: { ...DEFAULT_RUNTIME_CONFIG, priceInputPerM: 800 },
    // 断线宽限压短：电脑合盖那一类用例要等宽限过去、控制面放弃旧 run，在线的电脑每条上行都续租，不受影响。
    disconnectGraceMs: 50,
    scheduler: { now: () => new Date("2030-01-07T08:59:00"), intervalMs: HOUR },
    notificationScheduler: { now: () => new Date("2030-01-07T08:59:00"), intervalMs: HOUR },
    publisher: { intervalMs: 24 * HOUR },
  });
  return { server: running, client: () => new ApiClient(running.port), close: () => running.close() };
}

/** 模块重新加载一遍再起服务：控制面进程重启后内存里什么都不剩，库还是那个库。 */
async function bootFreshProcess(): Promise<TestServer> {
  vi.resetModules();
  const fresh = await import("../src/server.js");
  return boot(database.db, fresh.startServer);
}

beforeAll(async () => {
  database = await createTestDb();
  server = await boot();
});

afterAll(async () => {
  await server.close();
  await database.close();
});

const CONTINUE_ON_REMOTE =
  "刚才你请求换电脑，现在已经换到云电脑上了。接着刚才没做完的事做，之前对话里的内容都在，不要重新问主人，也不要把前面做过的再做一遍。";
const CONTINUE_ON_LOCAL =
  "刚才你请求换电脑，现在已经换到主人的电脑上了。接着刚才没做完的事做，之前对话里的内容都在，不要重新问主人，也不要把前面做过的再做一遍。";
const CONTINUATION_UNPLACED =
  "这个 Bot 在这个群里选了用云电脑，云电脑现在不在线，刚才换电脑后要接着做的活没派出去，也不会改派到你的电脑，云电脑回来后再说一次，或在群顶部改用你的电脑";

type Owner = {
  readonly ownerId: UserId;
  readonly email: string;
  readonly client: ApiClient;
  readonly local: TestComputer;
  readonly remote: TestComputer | null;
  readonly groupId: GroupId;
  readonly botId: BotId;
  readonly push: PushClient;
};

type Online = { readonly agent: AgentClient; readonly key: string };

async function owner(options: { readonly remote: boolean }): Promise<Owner> {
  const user = await makeUser(database.db);
  const local = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  let remote: TestComputer | null = null;
  if (options.remote) {
    const response = await client.post("/api/computers/remote");
    expect(response.status).toBe(200);
    const token = ComputerTokenResponse.parse(await response.json());
    remote = { computerId: token.computerId, token: token.token };
  }
  const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小运" })).json());
  const push = await connectPush(server.server.port, client.cookie ?? "");
  return {
    ownerId: user.id,
    email: user.email,
    client,
    local,
    remote,
    groupId: created.group.id,
    botId: created.bot.id,
    push,
  };
}

/** 控制面重启后端口变了，同一个人重新登录、重新连推送。 */
async function reconnect(o: Owner): Promise<Owner> {
  const client = server.client();
  expect((await client.login(o.email, PASSWORD)).status).toBe(200);
  const push = await connectPush(server.server.port, client.cookie ?? "");
  return { ...o, client, push };
}

/** 再建一个 Bot，顺带得到它的单聊群：往里说一句是条确定落地的报文，可以用来等 hello 的补扫过去。 */
async function soloGroup(o: Owner, name: string): Promise<{ readonly groupId: GroupId; readonly botId: BotId }> {
  const created = CreateBotResponse.parse(await (await o.client.post("/api/bots", { name })).json());
  return { groupId: created.group.id, botId: created.bot.id };
}

function remoteOf(o: Owner): TestComputer {
  if (o.remote === null) throw new Error("这个用户没有云电脑");
  return o.remote;
}

/** 上线一台电脑，连同它的网关 key：换电脑的请求用这把 key 认电脑。 */
async function online(computer: TestComputer, activeRuns: readonly RunId[] = []): Promise<Online> {
  const { agent, config } = await helloAgent(server.server.port, computer.computerId, computer.token, activeRuns);
  return { agent, key: config.modelGateway.apiKey };
}

async function say(o: Owner, text: string, groupId: GroupId = o.groupId): Promise<void> {
  const response = await o.client.post(`/api/groups/${groupId}/messages`, { text });
  expect(response.status).toBe(201);
}

async function switchComputer(
  on: Online,
  prompt: Prompt,
  kind: ComputerKind,
  runId: RunId = prompt.runId,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(`http://localhost:${server.server.port}/hub/v1/lane/computer`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${on.key}`,
      "x-baize-lane": `${prompt.botId}/${prompt.groupId}/${prompt.lane.epoch}`,
    },
    body: JSON.stringify({ runId, kind }),
  });
  return { status: response.status, body: await response.json() };
}

async function finish(on: Online, prompt: Prompt, nth = 1, inputTokens = 1): Promise<void> {
  on.agent.send({
    type: "run_done",
    runId: prompt.runId,
    botId: prompt.botId,
    groupId: prompt.groupId,
    steps: 1,
    inputTokens,
    outputTokens: 1,
  });
  await on.agent.ack(prompt.runId, nth);
}

async function continuationsOf(runId: RunId): Promise<string[]> {
  const rows = await database.sql<{ id: string }[]>`SELECT id FROM runs WHERE continues_run_id = ${runId}`;
  return rows.map((row) => row.id);
}

async function flagOf(runId: RunId): Promise<boolean> {
  const rows = await database.sql<{ continue_requested: boolean }[]>`
    SELECT continue_requested FROM runs WHERE id = ${runId}
  `;
  return rows[0]?.continue_requested ?? false;
}

async function choices(o: Owner, groupId: GroupId = o.groupId): Promise<ComputerChoices> {
  const response = await o.client.get(`/api/groups/${groupId}/computer-choices`);
  expect(response.status).toBe(200);
  return ComputerChoices.parse(await response.json());
}

async function errorTexts(o: Owner, groupId: GroupId = o.groupId): Promise<string[]> {
  const page = MessageListResponse.parse(await (await o.client.get(`/api/groups/${groupId}/messages`)).json());
  return page.messages.flatMap(({ body }) => (body.kind === "system" && body.tone === "error" ? [body.text] : []));
}

/** 等到这个 Bot 在这个群里的选择推送。 */
async function choicePush(o: Owner, botId: BotId, kind: ComputerKind): Promise<void> {
  for (;;) {
    const item = await o.push.next();
    if (item.type === "computer_choice_updated" && item.botId === botId && item.kind === kind) return;
  }
}

async function systemPush(o: Owner, text: string): Promise<void> {
  for (;;) {
    const item = await o.push.next();
    if (item.type === "message" && item.message.body.kind === "system" && item.message.body.text === text) return;
  }
}

/** 等到这台电脑被推成派不过去：断线宽限过了，控制面推一条它的新状态。 */
async function offlinePush(o: Owner, computerId: string): Promise<void> {
  for (;;) {
    const item = await o.push.next();
    if (item.type === "computer_updated" && item.computer.id === computerId && !item.computer.dispatchable) return;
  }
}

function expectContinuation(prompt: Prompt, from: Prompt, text: string): void {
  expect(prompt.reason, "接续的 prompt 带 continuation").toBe("continuation");
  expect(prompt.text).toBe(text);
  expect(prompt.context, "接续不带群历史，上一轮的对话都在会话里").toEqual([]);
  expect(prompt.task).toBeNull();
  expect(prompt.members).toEqual([]);
  expect(prompt.messageId, "接续沿用旧 run 的触发消息").toBe(from.messageId);
  expect(prompt.origin).toEqual(from.origin);
  expect(prompt.botId).toBe(from.botId);
  expect(prompt.groupId).toBe(from.groupId);
}

describe("Bot 自己换电脑", () => {
  it("在本机上请求换到云电脑：这一轮结束后接续在云电脑上起，带接续提示，选择和 runningOn 都变成云电脑", async () => {
    const me = await owner({ remote: true });
    const local = await online(me.local);
    const remote = await online(remoteOf(me));

    try {
      await say(me, "把这周的报表整理一下");
      const first = await local.agent.expect("prompt");
      expect(await choices(me)).toEqual([{ botId: me.botId, kind: null, runningOn: "local" }]);

      const switched = await switchComputer(local, first, "remote");
      expect(switched.status).toBe(200);
      expect(switched.body).toEqual({ result: "switching" });
      await choicePush(me, me.botId, "remote");
      expect(await flagOf(first.runId), "请求换电脑在 run 行上留下标记").toBe(true);
      expect(await choices(me), "选择已经改了，这一轮还在本机上跑完").toEqual([
        { botId: me.botId, kind: "remote", runningOn: "local" },
      ]);

      await finish(local, first);
      const next = await remote.agent.expect("prompt");
      expectContinuation(next, first, CONTINUE_ON_REMOTE);
      expect(next.computer).toEqual({ other: { kind: "local", dispatchable: true }, choice: "remote" });
      expect(await continuationsOf(first.runId), "接续 run 记着它接的是哪一轮").toEqual([next.runId]);
      expect(await choices(me), "接续起来后 runningOn 是云电脑").toEqual([
        { botId: me.botId, kind: "remote", runningOn: "remote" },
      ]);
      expect(await errorTexts(me), "群里没有派不出去的提示").toEqual([]);
      expect(
        local.agent.received().filter((message) => message.type === "prompt"),
        "本机没有再收到 prompt",
      ).toEqual([]);
    } finally {
      local.agent.close();
      remote.agent.close();
      me.push.close();
    }
  });

  it("在云电脑上换回主人的电脑，接续文案说的是主人的电脑", async () => {
    const me = await owner({ remote: true });
    const local = await online(me.local);
    const remote = await online(remoteOf(me));

    try {
      expect(
        (await me.client.request("PUT", `/api/groups/${me.groupId}/bots/${me.botId}/computer`, { kind: "remote" }))
          .status,
      ).toBe(204);
      await say(me, "打开主人电脑上的那份合同");
      const first = await remote.agent.expect("prompt");
      expect(await switchComputer(remote, first, "local")).toEqual({ status: 200, body: { result: "switching" } });
      await finish(remote, first);
      const next = await local.agent.expect("prompt");
      expectContinuation(next, first, CONTINUE_ON_LOCAL);
      expect(await choices(me)).toEqual([{ botId: me.botId, kind: "local", runningOn: "local" }]);
    } finally {
      local.agent.close();
      remote.agent.close();
      me.push.close();
    }
  });

  it("模型重试同一次换电脑仍回 switching，run_done 重放也只起一条接续", async () => {
    const me = await owner({ remote: true });
    const local = await online(me.local);
    const remote = await online(remoteOf(me));

    try {
      await say(me, "再整理一次");
      const first = await local.agent.expect("prompt");
      expect(await switchComputer(local, first, "remote")).toEqual({ status: 200, body: { result: "switching" } });
      expect(await switchComputer(local, first, "remote"), "重试是幂等的").toEqual({
        status: 200,
        body: { result: "switching" },
      });
      await finish(local, first);
      const next = await remote.agent.expect("prompt");
      expectContinuation(next, first, CONTINUE_ON_REMOTE);
      await finish(local, first, 2);
      expect(await continuationsOf(first.runId), "重放 run_done 不再起第二条").toEqual([next.runId]);
      expect(
        remote.agent.received().filter((message) => message.type === "prompt"),
        "云电脑只收到那一条接续",
      ).toEqual([]);
    } finally {
      local.agent.close();
      remote.agent.close();
      me.push.close();
    }
  });

  it("五种拒绝各一次，文案原样回给模型，选择不动", async () => {
    const me = await owner({ remote: true });
    const local = await online(me.local);

    try {
      await say(me, "换个地方做");
      const first = await local.agent.expect("prompt");
      expect(await switchComputer(local, first, "remote"), "云电脑没上线").toEqual({
        status: 200,
        body: {
          result: "refused",
          reason: "target_offline",
          text: "云电脑现在不在线，换不过去，这一轮继续在当前这台上做。",
        },
      });
      expect(await switchComputer(local, first, "local"), "就在本机上").toEqual({
        status: 200,
        body: { result: "refused", reason: "same_computer", text: "你这一轮就在主人的电脑上，不用换。" },
      });
      expect(await flagOf(first.runId)).toBe(false);
      expect(await choices(me)).toEqual([{ botId: me.botId, kind: null, runningOn: "local" }]);

      const remote = await online(remoteOf(me));
      try {
        expect(await switchComputer(local, first, "remote")).toEqual({ status: 200, body: { result: "switching" } });
        await finish(local, first);
        const next = await remote.agent.expect("prompt");
        expectContinuation(next, first, CONTINUE_ON_REMOTE);
        expect(await switchComputer(remote, next, "local"), "接续的这一轮不能再换").toEqual({
          status: 200,
          body: {
            result: "refused",
            reason: "already_continued",
            text: "这一轮已经换过一次电脑，不能再换，请在当前这台上做完或告诉主人。",
          },
        });
        expect(await switchComputer(remote, next, "local", first.runId), "拿别的 run 来换也当不是当前这一轮").toEqual({
          status: 200,
          body: { result: "refused", reason: "not_current_run", text: "这一轮已经结束，换不了电脑。" },
        });
        expect(await switchComputer(local, first, "remote"), "道已经换到云电脑，本机的道头按租约错回").toEqual({
          status: 409,
          body: { error: "代际过时" },
        });
        expect(await choices(me)).toEqual([{ botId: me.botId, kind: "remote", runningOn: "remote" }]);
        await finish(remote, next);
        expect(await switchComputer(remote, next, "local"), "已经结束的 run 换不了").toEqual({
          status: 200,
          body: { result: "refused", reason: "not_current_run", text: "这一轮已经结束，换不了电脑。" },
        });
        expect(await choices(me)).toEqual([{ botId: me.botId, kind: "remote", runningOn: null }]);
      } finally {
        remote.agent.close();
      }

      const solo = await owner({ remote: false });
      const soloLocal = await online(solo.local);
      try {
        await say(solo, "能换到云电脑吗");
        const prompt = await soloLocal.agent.expect("prompt");
        expect(await switchComputer(soloLocal, prompt, "remote"), "Mac 单机用户没有云电脑").toEqual({
          status: 200,
          body: { result: "refused", reason: "no_such_computer", text: "没有云电脑这台电脑，换不了。" },
        });
      } finally {
        soloLocal.agent.close();
        solo.push.close();
      }
    } finally {
      local.agent.close();
      me.push.close();
    }
  });

  it("道头对不上这台电脑时按租约错回 409，不碰 run", async () => {
    const me = await owner({ remote: true });
    const local = await online(me.local);
    const remote = await online(remoteOf(me));

    try {
      await say(me, "试试别人的 key");
      const first = await local.agent.expect("prompt");
      const stolen = await switchComputer({ agent: remote.agent, key: remote.key }, first, "remote");
      expect(stolen).toEqual({ status: 409, body: { error: "不是持有者" } });
      expect(await flagOf(first.runId)).toBe(false);
    } finally {
      local.agent.close();
      remote.agent.close();
      me.push.close();
    }
  });

  it("请求换电脑后本机掉线：旧 run 被放弃，接续照样在云电脑上起", async () => {
    const me = await owner({ remote: true });
    const local = await online(me.local);
    const remote = await online(remoteOf(me));

    try {
      await say(me, "合盖之前说一句");
      const first = await local.agent.expect("prompt");
      expect(await switchComputer(local, first, "remote")).toEqual({ status: 200, body: { result: "switching" } });
      await choicePush(me, me.botId, "remote");
      local.agent.close();
      const next = await remote.agent.expect("prompt");
      expectContinuation(next, first, CONTINUE_ON_REMOTE);
      expect(await continuationsOf(first.runId)).toEqual([next.runId]);
    } finally {
      remote.agent.close();
      me.push.close();
    }
  });

  it("请求换电脑后用户又在群里说了话：接续作废，云电脑收不到 prompt", async () => {
    const me = await owner({ remote: true });
    const local = await online(me.local);
    const remote = await online(remoteOf(me));

    try {
      await say(me, "先做这个");
      const first = await local.agent.expect("prompt");
      expect(await switchComputer(local, first, "remote")).toEqual({ status: 200, body: { result: "switching" } });
      await choicePush(me, me.botId, "remote");
      await say(me, "算了，先停一下");
      expect(await flagOf(first.runId), "用户插话把换电脑的标记清掉").toBe(false);
      await finish(local, first);
      const second = await local.agent.expect("prompt");
      expect(second.text, "用户那句照常派活，这一轮还在本机上所以仍派到本机").toBe("算了，先停一下");
      expect(second.reason).toBe("solo");
      await finish(local, second);
      expect(await continuationsOf(first.runId)).toEqual([]);
      expect(remote.agent.received().filter((message) => message.type === "prompt")).toEqual([]);
    } finally {
      local.agent.close();
      remote.agent.close();
      me.push.close();
    }
  });

  it("多 Bot 群里回合已有排队的 @，接续排在它们前面；说满 10 句之后接续照样起", async () => {
    const me = await owner({ remote: true });
    const second = CreateBotResponse.parse(await (await me.client.post("/api/bots", { name: "小服" })).json());
    const team = CreateGroupResponse.parse(
      await (await me.client.post("/api/groups", { title: "两人群", botIds: [me.botId, second.bot.id] })).json(),
    ).group.id;
    const local = await online(me.local);
    const remote = await online(remoteOf(me));
    const mention = (prompt: Prompt, text: string): void =>
      local.agent.send({
        type: "mention",
        runId: prompt.runId,
        botId: me.botId,
        groupId: team,
        targetBotId: second.bot.id,
        text,
      });

    try {
      await say(me, "@小运 开始", team);
      const first = await local.agent.expect("prompt");
      expect(first.botId).toBe(me.botId);
      for (let i = 0; i < 3; i += 1) mention(first, `@小服 第 ${i + 1} 件`);
      expect(await switchComputer(local, first, "remote")).toEqual({ status: 200, body: { result: "switching" } });
      await finish(local, first);
      const next = await remote.agent.expect("prompt");
      expectContinuation(next, first, CONTINUE_ON_REMOTE);
      expect(next.groupId).toBe(team);
      expect(
        local.agent.received().filter((message) => message.type === "prompt"),
        "小服的那几条 @ 要等接续做完才轮到",
      ).toEqual([]);
      await finish(remote, next);
      // 小运的道换到了云电脑，本机先收到这条道的 cancel，然后才轮到小服。
      await local.agent.expect("cancel");
      const service = await local.agent.expect("prompt");
      expect(service.botId, "同一回合里 @ 同一个 Bot 只派一次").toBe(second.bot.id);
      expect(service.reason).toBe("mentioned");
      await finish(local, service);

      await say(me, "@小运 再来", team);
      const again = await remote.agent.expect("prompt");
      expect(again.botId, "小运在这个群里已经选了云电脑，下一次 @ 它直接派到云电脑").toBe(me.botId);
      expect(again.reason).toBe("mentioned");
    } finally {
      local.agent.close();
      remote.agent.close();
      me.push.close();
    }
  });

  it("回合里 Bot 已说满 10 句被挡下，接续仍然起", async () => {
    const me = await owner({ remote: true });
    const second = CreateBotResponse.parse(await (await me.client.post("/api/bots", { name: "小服" })).json());
    const team = CreateGroupResponse.parse(
      await (await me.client.post("/api/groups", { title: "两人群", botIds: [me.botId, second.bot.id] })).json(),
    ).group.id;
    const local = await online(me.local);
    const remote = await online(remoteOf(me));

    try {
      await say(me, "@小运 开始", team);
      const first = await local.agent.expect("prompt");
      for (let i = 0; i < 10; i += 1)
        local.agent.send({
          type: "mention",
          runId: first.runId,
          botId: me.botId,
          groupId: team,
          targetBotId: second.bot.id,
          text: `@小服 第 ${i + 1} 件`,
        });
      await systemPush(me, MENTION_LOOP_NOTICE);
      expect(await switchComputer(local, first, "remote")).toEqual({ status: 200, body: { result: "switching" } });
      await finish(local, first);
      const next = await remote.agent.expect("prompt");
      expectContinuation(next, first, CONTINUE_ON_REMOTE);
      expect(next.groupId).toBe(team);
    } finally {
      local.agent.close();
      remote.agent.close();
      me.push.close();
    }
  });

  it("接续派不出去：群里原话说明，不回退到本机，标记清掉", async () => {
    const me = await owner({ remote: true });
    const local = await online(me.local);
    const remote = await online(remoteOf(me));

    try {
      await say(me, "换过去之后云电脑又掉了");
      const first = await local.agent.expect("prompt");
      expect(await switchComputer(local, first, "remote")).toEqual({ status: 200, body: { result: "switching" } });
      await choicePush(me, me.botId, "remote");
      remote.agent.close();
      await offlinePush(me, remoteOf(me).computerId);
      await finish(local, first);
      await systemPush(me, CONTINUATION_UNPLACED);
      expect(await errorTexts(me)).toEqual([CONTINUATION_UNPLACED]);
      expect(await continuationsOf(first.runId), "没有接续 run，也没落到本机").toEqual([]);
      expect(await flagOf(first.runId), "说过了就不再补起").toBe(false);
      expect(
        local.agent.received().filter((message) => message.type === "prompt"),
        "不改派到本机",
      ).toEqual([]);
      expect(await choices(me), "选择仍是云电脑").toEqual([{ botId: me.botId, kind: "remote", runningOn: null }]);
    } finally {
      local.agent.close();
      me.push.close();
    }
  });

  it("控制面在结账后、接续起之前没了：重启后云电脑一 hello 就补起，本机先 hello 不替它派，再 hello 一次不重复", async () => {
    let me = await owner({ remote: true });
    let local = await online(me.local);
    let remote = await online(remoteOf(me));

    try {
      await say(me, "重启之前说一句");
      const first = await local.agent.expect("prompt");
      expect(await switchComputer(local, first, "remote")).toEqual({ status: 200, body: { result: "switching" } });
      await choicePush(me, me.botId, "remote");
      // 模拟结账提交后进程没了：run 已结束、已结账、标记还在、没有接续，然后整个控制面重启。
      await database.sql`UPDATE runs SET ended_at = now(), charged_at = now() WHERE id = ${first.runId}`;
      local.agent.close();
      remote.agent.close();
      me.push.close();
      await server.close();
      server = await boot();
      me = await reconnect(me);

      // 本机先回来：云电脑还没上线，接续不替它派到本机，也不说派不出去。
      local = await online(me.local);
      await say(me, "本机回来了之后在别的群说一句", (await soloGroup(me, "另一个群")).groupId);
      expect(await flagOf(first.runId), "标记还在，等云电脑上线").toBe(true);
      expect(await continuationsOf(first.runId)).toEqual([]);
      expect(await errorTexts(me)).toEqual([]);

      remote = await online(remoteOf(me));
      const next = await remote.agent.expect("prompt");
      expectContinuation(next, first, CONTINUE_ON_REMOTE);
      expect(await continuationsOf(first.runId)).toEqual([next.runId]);

      remote.agent.close();
      remote = await online(remoteOf(me), [next.runId]);
      // 第二次 hello 又扫了一遍。等接续这一轮结清，这条确定落地的报文排在扫描之后。
      await finish(remote, next);
      expect(await continuationsOf(first.runId), "再扫一遍不起第二条").toEqual([next.runId]);
      expect(remote.agent.received().filter((message) => message.type === "prompt")).toEqual([]);
    } finally {
      local.agent.close();
      remote.agent.close();
      me.push.close();
    }
  });
});

const ROUTINE_NAME = "每日工单早报";
const SPEND_VIEW: ToolView = { kind: "mcp", server: "", tool: "shop.refund", params: [], raw: "给这单退 120 块" };

/** 建一条例行再试跑一次。cron 定在周一 9 点，测试的时钟停在 8:59，只有试跑会起 run。 */
async function trialRoutine(o: Owner, onFailure: OnFailure): Promise<string> {
  const created = await o.client.post(`/api/bots/${o.botId}/routines`, {
    name: ROUTINE_NAME,
    instruction: "把今天的工单汇总一下",
    triggers: [{ kind: "cron", expr: "0 9 * * 1" }],
    onFailure,
  });
  expect(created.status).toBe(201);
  const routine = RoutineResponse.parse(await created.json()).routine;
  expect((await o.client.post(`/api/routines/${routine.id}/run`)).status).toBe(202);
  return routine.id;
}

async function recordsOf(o: Owner, routineId: string): Promise<{ status: string; note: string }[]> {
  const response = await o.client.get("/api/routines");
  expect(response.status).toBe(200);
  const routine = RoutineListResponse.parse(await response.json()).items.find((item) => item.id === routineId);
  if (routine === undefined) throw new Error(`例行任务 ${routineId} 不在列表里`);
  return routine.runs.map(({ status, note }) => ({ status, note }));
}

async function routineRunIdOf(runId: RunId): Promise<string | null> {
  const rows = await database.sql<{ routine_run_id: string | null }[]>`
    SELECT routine_run_id FROM runs WHERE id = ${runId}
  `;
  return rows[0]?.routine_run_id ?? null;
}

function speak(on: Online, prompt: Prompt, delta: string): void {
  on.agent.send({
    type: "bot_text",
    runId: prompt.runId,
    botId: prompt.botId,
    groupId: prompt.groupId,
    messageId: MessageId.parse(randomUUID()),
    delta,
    done: true,
  });
}

/**
 * 屏障：不带 runId 的 agent_error 排在这台电脑此前所有帧后面，它那句 system 推出来，前面的帧就处理完了。
 * 落在主助理的单聊里，那个群没有开着的 run，不会替哪条例行记失败。返回屏障之前收到的全部推送。
 */
async function barrier(on: Online, o: Owner): Promise<ServerPush[]> {
  const tag = `屏障 ${randomUUID()}`;
  const [beacon] = await database.sql<{ id: string }[]>`
    SELECT g.id FROM groups g JOIN bots b ON b.id = g.solo_bot_id
    WHERE b.role = 'assistant' AND g.owner_id = ${o.ownerId}
  `;
  if (beacon === undefined) throw new Error("这个用户没有主助理");
  on.agent.send({ type: "agent_error", code: "runner_failed", detail: tag, groupId: GroupId.parse(beacon.id) });
  const before: ServerPush[] = [];
  for (;;) {
    const event = await o.push.nextRaw();
    if (event.type === "message" && event.message.body.kind === "system" && event.message.body.text.endsWith(tag)) {
      return before;
    }
    before.push(event);
  }
}

/** 通知去掉时刻只比内容。 */
function notices(pushes: readonly ServerPush[]) {
  return pushes.flatMap((event) => {
    if (event.type !== "notify") return [];
    const { at: _at, ...notice } = event.notice;
    return [notice];
  });
}

/** 用另一条连接锁住这一行 run：结账和起接续都要改这一行，谁先排上锁谁先做，先后由测试定。 */
async function holdRunRow(runId: RunId): Promise<{ release(): Promise<void> }> {
  const url = new URL(databaseUrl());
  url.pathname = `/${database.databaseName}`;
  const holder = postgres(url.toString(), { max: 1 });
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const held = new Promise<void>((resolve) => (locked = resolve));
  const holding = holder.begin(async (tx) => {
    await tx`SELECT id FROM runs WHERE id = ${runId} FOR UPDATE`;
    locked();
    await released;
  });
  await held;
  return {
    release: async () => {
      release();
      await holding;
      await holder.end();
    },
  };
}

/** 等到库里有这么多条语句在等锁。 */
async function lockWaiters(count: number): Promise<void> {
  for (;;) {
    const [row] = await database.sql<{ waiting: number }[]>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = ${database.databaseName} AND wait_event_type = 'Lock'`;
    if ((row?.waiting ?? 0) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("例行任务里换电脑", () => {
  it("旧 run 说过话再结账：运行记录还在 running、不弹通知；接续结账后记成 ok，两段花费都在", async () => {
    const me = await owner({ remote: true });
    const local = await online(me.local);
    const remote = await online(remoteOf(me));

    try {
      const routineId = await trialRoutine(me, "stop_and_tell");
      const first = await local.agent.expect("prompt");
      expect(first.origin).toEqual({ kind: "routine" });
      speak(local, first, "先把本机上的工单导出来了");
      expect(await switchComputer(local, first, "remote")).toEqual({ status: 200, body: { result: "switching" } });
      await choicePush(me, me.botId, "remote");
      await finish(local, first, 1, 1000);
      const next = await remote.agent.expect("prompt");
      expectContinuation(next, first, CONTINUE_ON_REMOTE);
      const firstRecord = await routineRunIdOf(first.runId);
      expect(firstRecord).not.toBeNull();
      expect(await routineRunIdOf(next.runId), "接续属于同一次例行触发").toBe(firstRecord);

      expect(notices(await barrier(local, me)), "活还没做完，不弹通知").toEqual([]);
      expect(await recordsOf(me, routineId), "旧 run 的花费记上，状态等接续").toEqual([
        { status: "running", note: "¥0.80" },
      ]);

      speak(remote, next, "工单早报整理好了");
      await finish(remote, next, 1, 2000);
      expect(notices(await barrier(remote, me)), "例行做完不弹通知，接续做完也一样").toEqual([]);
      expect(await recordsOf(me, routineId)).toEqual([{ status: "ok", note: "¥0.80 · ¥1.60" }]);
    } finally {
      local.agent.close();
      remote.agent.close();
      me.push.close();
    }
  });

  it("换电脑后本机掉线：运行记录不记失败、不找主人，接续做完后是 ok", async () => {
    const me = await owner({ remote: true });
    const local = await online(me.local);
    const remote = await online(remoteOf(me));
    let back: Online | null = null;

    try {
      const routineId = await trialRoutine(me, "stop_and_tell");
      const first = await local.agent.expect("prompt");
      expect(await switchComputer(local, first, "remote")).toEqual({ status: 200, body: { result: "switching" } });
      await choicePush(me, me.botId, "remote");
      local.agent.close();
      const next = await remote.agent.expect("prompt");
      expectContinuation(next, first, CONTINUE_ON_REMOTE);

      // 本机重新 hello 排在放弃旧 run 那一串后面，屏障从它发出去，放弃那一轮的推送都已经出来了。
      back = await online(me.local);
      expect(notices(await barrier(back, me)), "接续还在跑，不发没跑完").toEqual([]);
      expect(await recordsOf(me, routineId)).toEqual([{ status: "running", note: "" }]);
      expect(await routineRunIdOf(next.runId), "旧 run 被放弃后另起回合，接续照样记着这次例行").toBe(
        await routineRunIdOf(first.runId),
      );

      await finish(remote, next, 1, 2000);
      expect(await recordsOf(me, routineId)).toEqual([{ status: "ok", note: "¥1.60" }]);
    } finally {
      back?.agent.close();
      remote.agent.close();
      me.push.close();
    }
  });

  it("旧段说话后本机掉线、接续静默结束：记成 ok，不弹通知", async () => {
    const me = await owner({ remote: true });
    const local = await online(me.local);
    const remote = await online(remoteOf(me));
    let back: Online | null = null;

    try {
      const routineId = await trialRoutine(me, "stop_and_tell");
      const first = await local.agent.expect("prompt");
      speak(local, first, "工单早报整理好了");
      expect(await switchComputer(local, first, "remote")).toEqual({ status: 200, body: { result: "switching" } });
      await choicePush(me, me.botId, "remote");
      local.agent.close();
      const next = await remote.agent.expect("prompt");
      back = await online(me.local);
      expect(notices(await barrier(back, me))).toEqual([]);

      await finish(remote, next, 1, 2000);
      expect(notices(await barrier(remote, me)), "例行做完不弹通知").toEqual([]);
      expect(await recordsOf(me, routineId)).toEqual([{ status: "ok", note: "¥1.60" }]);
    } finally {
      back?.agent.close();
      remote.agent.close();
      me.push.close();
    }
  });

  it("本机掉线后起的接续里出审批：带十分钟截止，stop_and_tell 的运行记录停在等你点头", async () => {
    const me = await owner({ remote: true });
    const local = await online(me.local);
    const remote = await online(remoteOf(me));

    try {
      const routineId = await trialRoutine(me, "stop_and_tell");
      const first = await local.agent.expect("prompt");
      expect(await switchComputer(local, first, "remote")).toEqual({ status: 200, body: { result: "switching" } });
      await choicePush(me, me.botId, "remote");
      local.agent.close();
      const next = await remote.agent.expect("prompt");
      remote.agent.send({
        type: "approval_request",
        runId: next.runId,
        botId: next.botId,
        groupId: next.groupId,
        callId: "call-refund",
        tool: "shop.refund",
        action: "spend",
        target: null,
        view: SPEND_VIEW,
      });
      const pushed = await barrier(remote, me);
      const approval = pushed.flatMap((event) =>
        event.type === "approval_updated" && event.approval.runId === next.runId ? [event.approval] : [],
      )[0];
      if (approval === undefined) throw new Error("接续这一轮没推审批");
      const page = MessageListResponse.parse(await (await me.client.get(`/api/groups/${me.groupId}/messages`)).json());
      const card = page.messages.find(
        (message) => message.body.kind === "approval" && message.body.approvalId === approval.id,
      );
      if (card === undefined) throw new Error("审批卡不在群里");
      if (approval.deadlineAt === null) throw new Error("例行接续里的审批必须有截止时间");
      expect(
        Math.abs(new Date(approval.deadlineAt).getTime() - new Date(card.createdAt).getTime() - 10 * 60_000),
      ).toBeLessThan(1000);
      expect(await recordsOf(me, routineId)).toEqual([{ status: "stopped", note: "1 条等你点头" }]);
    } finally {
      local.agent.close();
      remote.agent.close();
      me.push.close();
    }
  });

  it("本机掉线后起的接续里报上来的 skill 卡照样不落：接续还是那次例行在做", async () => {
    const me = await owner({ remote: true });
    const local = await online(me.local);
    const remote = await online(remoteOf(me));

    try {
      await trialRoutine(me, "stop_and_tell");
      const first = await local.agent.expect("prompt");
      expect(await switchComputer(local, first, "remote")).toEqual({ status: 200, body: { result: "switching" } });
      await choicePush(me, me.botId, "remote");
      local.agent.close();
      const next = await remote.agent.expect("prompt");
      remote.agent.send({
        type: "skill_offer",
        runId: next.runId,
        botId: next.botId,
        groupId: next.groupId,
        name: "工单早报",
        steps: ["拉今天的工单", "按状态分组"],
      });
      const cards = (await barrier(remote, me)).flatMap((event) =>
        event.type === "message" && event.message.body.kind === "skill_offer" ? [event.message] : [],
      );
      expect(cards, "例行派的活不问存不存，换了电脑接着做也一样").toEqual([]);
    } finally {
      local.agent.close();
      remote.agent.close();
      me.push.close();
    }
  });

  it("换电脑后接续派不出去：运行记录记失败，note 是群里那句原因加旧 run 的花费，找主人一次", async () => {
    const me = await owner({ remote: true });
    const local = await online(me.local);
    const remote = await online(remoteOf(me));

    try {
      const routineId = await trialRoutine(me, "stop_and_tell");
      const first = await local.agent.expect("prompt");
      expect(await switchComputer(local, first, "remote")).toEqual({ status: 200, body: { result: "switching" } });
      await choicePush(me, me.botId, "remote");
      remote.agent.close();
      await offlinePush(me, remoteOf(me).computerId);
      await finish(local, first, 1, 1000);
      expect(notices(await barrier(local, me)), "链在这里断了，没人在看的例行要找主人").toEqual([
        {
          kind: "stuck",
          text: `例行任务「${ROUTINE_NAME}」没跑完：这个 Bot 在这个群里选了用云电脑，云电脑现在不在线，换电脑后没接着做`,
          groupId: me.groupId,
        },
      ]);
      expect(await errorTexts(me)).toEqual([CONTINUATION_UNPLACED]);
      expect(await recordsOf(me, routineId), "旧 run 先记下的花费留在原因后面").toEqual([
        { status: "failed", note: "这个 Bot 在这个群里选了用云电脑，云电脑现在不在线，换电脑后没接着做 · ¥0.80" },
      ]);
    } finally {
      local.agent.close();
      me.push.close();
    }
  });

  it("接续在跑时删掉执行它的 Bot：运行记录随删除记失败", async () => {
    const me = await owner({ remote: true });
    const local = await online(me.local);
    const remote = await online(remoteOf(me));

    try {
      const routineId = await trialRoutine(me, "stop_and_tell");
      const first = await local.agent.expect("prompt");
      expect(await switchComputer(local, first, "remote")).toEqual({ status: 200, body: { result: "switching" } });
      await choicePush(me, me.botId, "remote");
      await finish(local, first, 1, 1000);
      await remote.agent.expect("prompt");
      expect((await me.client.request("DELETE", `/api/bots/${me.botId}`)).status).toBe(204);
      expect(await recordsOf(me, routineId), "旧段的花费留着").toEqual([
        { status: "failed", note: "执行者已删除，这次没跑完 · ¥0.80" },
      ]);
    } finally {
      local.agent.close();
      remote.agent.close();
      me.push.close();
    }
  });

  it("旧 run 还没结束主人就插话：标记清掉，旧 run 结账照常收尾成 ok", async () => {
    const me = await owner({ remote: true });
    const local = await online(me.local);
    const remote = await online(remoteOf(me));

    try {
      const routineId = await trialRoutine(me, "stop_and_tell");
      const first = await local.agent.expect("prompt");
      expect(await switchComputer(local, first, "remote")).toEqual({ status: 200, body: { result: "switching" } });
      await choicePush(me, me.botId, "remote");
      await say(me, "先别换了，就在这台上做完");
      expect(await flagOf(first.runId)).toBe(false);
      await finish(local, first, 1, 1000);
      expect(await continuationsOf(first.runId)).toEqual([]);
      expect(await recordsOf(me, routineId)).toEqual([{ status: "ok", note: "¥0.80" }]);
    } finally {
      local.agent.close();
      remote.agent.close();
      me.push.close();
    }
  });

  it("旧 run 结账后、接续起之前主人插话：运行记录记 stopped，花费留着，不再起接续", async () => {
    const gated = gatedDb(database.sql);
    await server.close();
    server = await boot(gated.db);
    const me = await owner({ remote: true });
    const local = await online(me.local);
    const remote = await online(remoteOf(me));

    try {
      const routineId = await trialRoutine(me, "stop_and_tell");
      const first = await local.agent.expect("prompt");
      expect(await switchComputer(local, first, "remote")).toEqual({ status: 200, body: { result: "switching" } });
      await choicePush(me, me.botId, "remote");
      // 结账提交后、起接续前读欠着的接续那一下停住，主人这时插话。
      const resume = gated.arm(/from "runs" where \("runs"\."continue_requested" = /, "before", first.runId);
      local.agent.send({
        type: "run_done",
        runId: first.runId,
        botId: first.botId,
        groupId: first.groupId,
        steps: 1,
        inputTokens: 1000,
        outputTokens: 1,
      });
      await resume.reached;
      expect(await recordsOf(me, routineId), "旧 run 结过账，还等接续").toEqual([{ status: "running", note: "¥0.80" }]);
      await say(me, "先不用做了");
      expect(await flagOf(first.runId)).toBe(false);
      resume.release();
      await local.agent.ack(first.runId, 1);

      expect(await continuationsOf(first.runId)).toEqual([]);
      const interjected = await remote.agent.expect("prompt");
      expect(interjected.reason, "云电脑收到的是主人那句，不是接续").toBe("solo");
      expect(interjected.text).toBe("先不用做了");
      expect(await recordsOf(me, routineId)).toEqual([
        { status: "stopped", note: "换电脑后你在群里插了话，没接着做 · ¥0.80" },
      ]);
    } finally {
      local.agent.close();
      remote.agent.close();
      me.push.close();
      await server.close();
      server = await boot();
    }
  });

  it("未结账的恢复状态：接续先起、旧 run 后结账，结账看得到已经起了的接续，运行记录仍是 running", async () => {
    let me = await owner({ remote: true });
    let local = await online(me.local);
    let remote = await online(remoteOf(me));
    let hold: { release(): Promise<void> } | null = null;

    try {
      const routineId = await trialRoutine(me, "stop_and_tell");
      const first = await local.agent.expect("prompt");
      speak(local, first, "先把本机上的工单导出来了");
      expect(await switchComputer(local, first, "remote")).toEqual({ status: 200, body: { result: "switching" } });
      await choicePush(me, me.botId, "remote");
      // 用 SQL 直接造出未结账的恢复状态：run 已结束、用量记上、charged_at 为空、标记还在，再重启控制面。
      // 钉的是从这种状态恢复时补结账和起接续的先后，不是复现哪一次崩溃。
      await database.sql`
        UPDATE runs SET ended_at = now(), steps = 1, input_tokens = 1000, output_tokens = 1, amount = 0.8
        WHERE id = ${first.runId}
      `;
      local.agent.close();
      remote.agent.close();
      me.push.close();
      await server.close();
      server = await boot();
      me = await reconnect(me);

      // 云电脑先排上这一行的锁、起接续，本机 hello 补结账排在它后面。
      hold = await holdRunRow(first.runId);
      const remoteBack = online(remoteOf(me));
      await lockWaiters(1);
      const localBack = online(me.local);
      await lockWaiters(2);
      await hold.release();
      hold = null;
      [local, remote] = await Promise.all([localBack, remoteBack]);
      const next = await remote.agent.expect("prompt");
      expectContinuation(next, first, CONTINUE_ON_REMOTE);
      expect(notices(await barrier(local, me)), "接续已经起了，旧 run 结账不弹通知").toEqual([]);
      expect(await recordsOf(me, routineId), "旧 run 的花费记上，状态等接续").toEqual([
        { status: "running", note: "¥0.80" },
      ]);

      speak(remote, next, "工单早报整理好了");
      await finish(remote, next, 1, 2000);
      expect(notices(await barrier(remote, me))).toEqual([]);
      expect(await recordsOf(me, routineId)).toEqual([{ status: "ok", note: "¥0.80 · ¥1.60" }]);
    } finally {
      await hold?.release();
      local.agent.close();
      remote.agent.close();
      me.push.close();
    }
  });
  it("只有旧段说话、接续静默结束：记成 ok，不弹通知", async () => {
    const me = await owner({ remote: true });
    const local = await online(me.local);
    const remote = await online(remoteOf(me));

    try {
      const routineId = await trialRoutine(me, "stop_and_tell");
      const first = await local.agent.expect("prompt");
      speak(local, first, "工单早报整理好了");
      expect(await switchComputer(local, first, "remote")).toEqual({ status: 200, body: { result: "switching" } });
      await choicePush(me, me.botId, "remote");
      await finish(local, first, 1, 1000);
      const next = await remote.agent.expect("prompt");
      expect(notices(await barrier(local, me))).toEqual([]);

      await finish(remote, next, 1, 2000);
      expect(notices(await barrier(remote, me)), "例行做完不弹通知").toEqual([]);
      expect(await recordsOf(me, routineId)).toEqual([{ status: "ok", note: "¥0.80 · ¥1.60" }]);
    } finally {
      local.agent.close();
      remote.agent.close();
      me.push.close();
    }
  });

  it("旧段说话、结账后控制面重启，接续静默结束：记成 ok，不弹通知", async () => {
    let me = await owner({ remote: true });
    let local = await online(me.local);
    let remote = await online(remoteOf(me));

    try {
      const routineId = await trialRoutine(me, "stop_and_tell");
      const first = await local.agent.expect("prompt");
      speak(local, first, "工单早报整理好了");
      expect(await switchComputer(local, first, "remote")).toEqual({ status: 200, body: { result: "switching" } });
      await choicePush(me, me.botId, "remote");
      await finish(local, first, 1, 1000);
      const next = await remote.agent.expect("prompt");
      expect(notices(await barrier(local, me))).toEqual([]);

      local.agent.close();
      remote.agent.close();
      me.push.close();
      await server.close();
      server = await bootFreshProcess();
      me = await reconnect(me);
      local = await online(me.local);
      remote = await online(remoteOf(me), [next.runId]);

      await finish(remote, next, 1, 2000);
      expect(notices(await barrier(remote, me)), "例行做完不弹通知，重启前后都一样").toEqual([]);
      expect(await recordsOf(me, routineId)).toEqual([{ status: "ok", note: "¥0.80 · ¥1.60" }]);
    } finally {
      local.agent.close();
      remote.agent.close();
      me.push.close();
    }
  });

  it("旧段只流式说过话、结账后控制面重启，接续静默结束：记成 ok，不弹通知", async () => {
    let me = await owner({ remote: true });
    let local = await online(me.local);
    let remote = await online(remoteOf(me));

    try {
      const routineId = await trialRoutine(me, "stop_and_tell");
      const first = await local.agent.expect("prompt");
      // 只发没定稿的一段，长过前缀缓冲：走流式落字那条路，不经可靠定稿。
      local.agent.send({
        type: "bot_text",
        runId: first.runId,
        botId: first.botId,
        groupId: first.groupId,
        messageId: MessageId.parse(randomUUID()),
        delta: "工单早报整理好了，正在核对",
        done: false,
      });
      expect(await switchComputer(local, first, "remote")).toEqual({ status: 200, body: { result: "switching" } });
      await choicePush(me, me.botId, "remote");
      await finish(local, first, 1, 1000);
      const next = await remote.agent.expect("prompt");
      expect(notices(await barrier(local, me))).toEqual([]);

      local.agent.close();
      remote.agent.close();
      me.push.close();
      await server.close();
      server = await bootFreshProcess();
      me = await reconnect(me);
      local = await online(me.local);
      remote = await online(remoteOf(me), [next.runId]);

      await finish(remote, next, 1, 2000);
      expect(notices(await barrier(remote, me)), "例行做完不弹通知，重启前后都一样").toEqual([]);
      expect(await recordsOf(me, routineId)).toEqual([{ status: "ok", note: "¥0.80 · ¥1.60" }]);
    } finally {
      local.agent.close();
      remote.agent.close();
      me.push.close();
    }
  });

  it("接续里的审批被放弃、记录已收成 failed，接续再静默结账：记录停在 failed", async () => {
    const me = await owner({ remote: true });
    const local = await online(me.local);
    const remote = await online(remoteOf(me));

    try {
      const routineId = await trialRoutine(me, "stop_and_tell");
      const first = await local.agent.expect("prompt");
      speak(local, first, "先把本机上的工单导出来了");
      expect(await switchComputer(local, first, "remote")).toEqual({ status: 200, body: { result: "switching" } });
      await choicePush(me, me.botId, "remote");
      await finish(local, first, 1, 1000);
      const next = await remote.agent.expect("prompt");
      remote.agent.send({
        type: "approval_request",
        runId: next.runId,
        botId: next.botId,
        groupId: next.groupId,
        callId: "call-refund",
        tool: "shop.refund",
        action: "spend",
        target: null,
        view: SPEND_VIEW,
      });
      await barrier(remote, me);
      expect(await recordsOf(me, routineId)).toEqual([{ status: "stopped", note: "1 条等你点头 · ¥0.80" }]);
      remote.agent.send({ type: "approval_abandoned", runId: next.runId, callId: "call-refund", reason: "stopped" });
      await barrier(remote, me);
      expect(await recordsOf(me, routineId), "等点头那句换成失效原因，旧段的花费留着").toEqual([
        { status: "failed", note: "审批已失效 · ¥0.80" },
      ]);

      await finish(remote, next, 1, 2000);
      expect(notices(await barrier(remote, me)), "记录已经是 failed，接续结账不改它，也不再弹").toEqual([]);
      expect(await recordsOf(me, routineId)).toEqual([{ status: "failed", note: "审批已失效 · ¥0.80 · ¥1.60" }]);
    } finally {
      local.agent.close();
      remote.agent.close();
      me.push.close();
    }
  });

  it("接续落行的事务失败：运行记录记失败，找主人一次", async () => {
    const me = await owner({ remote: true });
    const local = await online(me.local);
    const remote = await online(remoteOf(me));

    try {
      const routineId = await trialRoutine(me, "stop_and_tell");
      const first = await local.agent.expect("prompt");
      expect(await switchComputer(local, first, "remote")).toEqual({ status: 200, body: { result: "switching" } });
      await choicePush(me, me.botId, "remote");
      await withContinuationInsertFailure(async () => {
        await finish(local, first, 1, 1000);
        expect(notices(await barrier(local, me))).toEqual([
          { kind: "stuck", text: `例行任务「${ROUTINE_NAME}」没跑完：派活出错，换电脑后没接着做`, groupId: me.groupId },
        ]);
      });
      expect(await continuationsOf(first.runId), "落行回滚了，没有接续").toEqual([]);
      expect(await flagOf(first.runId), "认领过标记，hello 的补扫不再捡它").toBe(false);
      expect(await recordsOf(me, routineId)).toEqual([
        { status: "failed", note: "派活出错，换电脑后没接着做 · ¥0.80" },
      ]);
      expect(remote.agent.received().filter((message) => message.type === "prompt")).toEqual([]);
    } finally {
      local.agent.close();
      remote.agent.close();
      me.push.close();
    }
  });

  it("接续落行前读群的准备查询出错一次：运行记录记失败，标记认领掉，找主人一次", async () => {
    const gated = gatedDb(database.sql);
    await server.close();
    server = await boot(gated.db);
    const me = await owner({ remote: true });
    const local = await online(me.local);
    const remote = await online(remoteOf(me));

    try {
      const routineId = await trialRoutine(me, "stop_and_tell");
      const first = await local.agent.expect("prompt");
      expect(await switchComputer(local, first, "remote")).toEqual({ status: 200, body: { result: "switching" } });
      await choicePush(me, me.botId, "remote");
      // 派接续这一位时读群主 Bot 那一下抛错，还没进落行的事务。
      gated.arm(/^select "chief_bot_id" from "groups"/, "fail", me.groupId);
      await finish(local, first, 1, 1000);
      expect(notices(await barrier(local, me))).toEqual([
        { kind: "stuck", text: `例行任务「${ROUTINE_NAME}」没跑完：派活出错，换电脑后没接着做`, groupId: me.groupId },
      ]);
      expect(await flagOf(first.runId), "认领过标记，hello 的补扫不再捡它").toBe(false);
      expect(await continuationsOf(first.runId)).toEqual([]);
      expect(await recordsOf(me, routineId)).toEqual([
        { status: "failed", note: "派活出错，换电脑后没接着做 · ¥0.80" },
      ]);
      expect(remote.agent.received().filter((message) => message.type === "prompt")).toEqual([]);
    } finally {
      local.agent.close();
      remote.agent.close();
      me.push.close();
      await server.close();
      server = await boot();
    }
  });

  it("本机掉线后起接续时读触发消息位置的查询出错一次：运行记录记失败，找主人一次", async () => {
    const gated = gatedDb(database.sql);
    await server.close();
    server = await boot(gated.db);
    const me = await owner({ remote: true });
    const local = await online(me.local);
    const remote = await online(remoteOf(me));
    let back: Online | null = null;

    try {
      const routineId = await trialRoutine(me, "stop_and_tell");
      const first = await local.agent.expect("prompt");
      expect(await switchComputer(local, first, "remote")).toEqual({ status: 200, body: { result: "switching" } });
      await choicePush(me, me.botId, "remote");
      // 旧 run 被放弃时回合跟着收掉，接续自己开一轮，开轮前读触发消息位置那一下抛错。
      const seq = gated.arm(/^select "seq" from "messages"/, "fail", first.messageId);
      local.agent.close();
      await seq.reached;
      back = await online(me.local);
      expect(notices(await barrier(back, me))).toEqual([
        { kind: "stuck", text: `例行任务「${ROUTINE_NAME}」没跑完：派活出错，换电脑后没接着做`, groupId: me.groupId },
      ]);
      expect(await flagOf(first.runId)).toBe(false);
      expect(await recordsOf(me, routineId)).toEqual([{ status: "failed", note: "派活出错，换电脑后没接着做" }]);
      expect(remote.agent.received().filter((message) => message.type === "prompt")).toEqual([]);
    } finally {
      back?.agent.close();
      remote.agent.close();
      me.push.close();
      await server.close();
      server = await boot();
    }
  });

  it("旧段说话、结账前控制面重启，重放 run_done 后接续静默结束：记成 ok，不弹通知", async () => {
    let me = await owner({ remote: true });
    let local = await online(me.local);
    let remote = await online(remoteOf(me));

    try {
      const routineId = await trialRoutine(me, "stop_and_tell");
      const first = await local.agent.expect("prompt");
      speak(local, first, "工单早报整理好了");
      expect(await switchComputer(local, first, "remote")).toEqual({ status: 200, body: { result: "switching" } });
      await choicePush(me, me.botId, "remote");
      await barrier(local, me);

      // 文字已经落库，run_done 还没到控制面就没了；电脑重连时报这个 run 还在跑，再重放 run_done。
      local.agent.close();
      remote.agent.close();
      me.push.close();
      await server.close();
      server = await bootFreshProcess();
      me = await reconnect(me);
      remote = await online(remoteOf(me));
      local = await online(me.local, [first.runId]);
      await finish(local, first, 1, 1000);
      const next = await remote.agent.expect("prompt");
      expectContinuation(next, first, CONTINUE_ON_REMOTE);
      expect(notices(await barrier(local, me))).toEqual([]);

      await finish(remote, next, 1, 2000);
      expect(notices(await barrier(remote, me)), "例行做完不弹通知，重启前后都一样").toEqual([]);
      expect(await recordsOf(me, routineId)).toEqual([{ status: "ok", note: "¥0.80 · ¥1.60" }]);
    } finally {
      local.agent.close();
      remote.agent.close();
      me.push.close();
    }
  });

  it("retry_next_time 的接续里出审批：note 补那一句，旧段的花费留着，状态仍在跑", async () => {
    const me = await owner({ remote: true });
    const local = await online(me.local);
    const remote = await online(remoteOf(me));

    try {
      const routineId = await trialRoutine(me, "retry_next_time");
      const first = await local.agent.expect("prompt");
      expect(await switchComputer(local, first, "remote")).toEqual({ status: 200, body: { result: "switching" } });
      await choicePush(me, me.botId, "remote");
      await finish(local, first, 1, 1000);
      const next = await remote.agent.expect("prompt");
      remote.agent.send({
        type: "approval_request",
        runId: next.runId,
        botId: next.botId,
        groupId: next.groupId,
        callId: "call-refund",
        tool: "shop.refund",
        action: "spend",
        target: null,
        view: SPEND_VIEW,
      });
      await barrier(remote, me);
      expect(await recordsOf(me, routineId)).toEqual([{ status: "running", note: "等你点头，下次照常跑 · ¥0.80" }]);
    } finally {
      local.agent.close();
      remote.agent.close();
      me.push.close();
    }
  });

  it("触发消息对执行它的 Bot 不可见了：接续不起，运行记录记失败，标记认领掉，找主人一次", async () => {
    const me = await owner({ remote: true });
    const local = await online(me.local);
    const remote = await online(remoteOf(me));

    try {
      const routineId = await trialRoutine(me, "stop_and_tell");
      const first = await local.agent.expect("prompt");
      expect(await switchComputer(local, first, "remote")).toEqual({ status: 200, body: { result: "switching" } });
      await choicePush(me, me.botId, "remote");
      // 造不该有的数据：派起这一轮的那条消息此后只给主人看。
      await database.sql`UPDATE messages SET visible_to = '[{"kind":"user"}]'::jsonb WHERE id = ${first.messageId}`;
      await finish(local, first, 1, 1000);
      expect(notices(await barrier(local, me))).toEqual([
        {
          kind: "stuck",
          text: `例行任务「${ROUTINE_NAME}」没跑完：换电脑后读不到派起它的那条消息，没接着做`,
          groupId: me.groupId,
        },
      ]);
      expect(await flagOf(first.runId)).toBe(false);
      expect(await recordsOf(me, routineId)).toEqual([
        { status: "failed", note: "换电脑后读不到派起它的那条消息，没接着做 · ¥0.80" },
      ]);
      expect(remote.agent.received().filter((message) => message.type === "prompt")).toEqual([]);
    } finally {
      local.agent.close();
      remote.agent.close();
      me.push.close();
    }
  });

  it("本机掉线后起接续时触发消息刚好对执行它的 Bot 不可见了：运行记录记失败，找主人一次", async () => {
    const gated = gatedDb(database.sql);
    await server.close();
    server = await boot(gated.db);
    const me = await owner({ remote: true });
    const local = await online(me.local);
    const remote = await online(remoteOf(me));
    let back: Online | null = null;

    try {
      const routineId = await trialRoutine(me, "stop_and_tell");
      const first = await local.agent.expect("prompt");
      expect(await switchComputer(local, first, "remote")).toEqual({ status: 200, body: { result: "switching" } });
      await choicePush(me, me.botId, "remote");
      // 读到欠着的接续之后、读触发消息位置之前，那条消息变成只给主人看。
      const seq = gated.arm(/^select "seq" from "messages"/, "before", first.messageId);
      local.agent.close();
      await seq.reached;
      await database.sql`UPDATE messages SET visible_to = '[{"kind":"user"}]'::jsonb WHERE id = ${first.messageId}`;
      seq.release();
      back = await online(me.local);
      expect(notices(await barrier(back, me))).toEqual([
        {
          kind: "stuck",
          text: `例行任务「${ROUTINE_NAME}」没跑完：换电脑后读不到派起它的那条消息，没接着做`,
          groupId: me.groupId,
        },
      ]);
      expect(await flagOf(first.runId)).toBe(false);
      expect(await recordsOf(me, routineId)).toEqual([
        { status: "failed", note: "换电脑后读不到派起它的那条消息，没接着做" },
      ]);
      expect(remote.agent.received().filter((message) => message.type === "prompt")).toEqual([]);
    } finally {
      back?.agent.close();
      remote.agent.close();
      me.push.close();
      await server.close();
      server = await boot();
    }
  });

  it("本机掉线、宽限到点收尾时记运行记录失败那一下出错：run 不算收完，回来再收一次，记失败、找主人一次", async () => {
    const gated = gatedDb(database.sql);
    await server.close();
    server = await boot(gated.db);
    const me = await owner({ remote: false });
    const local = await online(me.local);
    let back: Online | null = null;

    try {
      const routineId = await trialRoutine(me, "stop_and_tell");
      const first = await local.agent.expect("prompt");
      const fail = gated.arm(
        /^update "routine_runs" set "status" = \$1, "note"/,
        "fail",
        (await routineRunIdOf(first.runId)) ?? undefined,
      );
      local.agent.close();
      await fail.reached;
      back = await online(me.local);
      expect(notices(await barrier(back, me))).toEqual([
        { kind: "stuck", text: `例行任务「${ROUTINE_NAME}」没跑完：电脑中途断线`, groupId: me.groupId },
      ]);
      expect(await recordsOf(me, routineId)).toEqual([{ status: "failed", note: "电脑断过线，这次活没做完" }]);
    } finally {
      back?.agent.close();
      me.push.close();
      await server.close();
      server = await boot();
    }
  });

  it("例行不能建在牌桌群上", async () => {
    const me = await owner({ remote: true });
    try {
      const { table } = await pokerTable(me);
      const seatBot = seatThree(table);
      const created = await me.client.post(`/api/bots/${seatBot}/routines`, {
        name: ROUTINE_NAME,
        instruction: "把今天的工单汇总一下",
        triggers: [{ kind: "cron", expr: "0 9 * * 1" }],
        onFailure: "stop_and_tell",
        groupId: table.groupId,
      });
      expect(created.status).toBe(400);
      expect(await created.json()).toEqual({ error: "牌桌群里不能建例行任务" });
    } finally {
      me.push.close();
    }
  });

  it("旧数据里绑在牌桌群上的例行：换电脑后牌友被换下，运行记录收成 stopped，不找主人", async () => {
    const me = await owner({ remote: true });
    // 先开桌再上线：牌友随 hello 的那份 config 下去，电脑上收到的第一条就是例行的 prompt。
    const { table } = await pokerTable(me);
    const seatBot = seatThree(table);
    const local = await online(me.local);
    const remote = await online(remoteOf(me));

    try {
      const created = await me.client.post(`/api/bots/${seatBot}/routines`, {
        name: ROUTINE_NAME,
        instruction: "把今天的工单汇总一下",
        triggers: [{ kind: "cron", expr: "0 9 * * 1" }],
        onFailure: "stop_and_tell",
      });
      expect(created.status).toBe(201);
      const routineId = RoutineResponse.parse(await created.json()).routine.id;
      // 建例行挡牌桌群之前留下的数据：例行直接绑在牌桌群上。
      await database.sql`UPDATE routines SET group_id = ${table.groupId} WHERE id = ${routineId}`;
      expect((await me.client.post(`/api/routines/${routineId}/run`)).status).toBe(202);
      const first = await local.agent.expect("prompt");
      expect(first.groupId).toBe(table.groupId);
      expect(await switchComputer(local, first, "remote")).toEqual({ status: 200, body: { result: "switching" } });
      await choicePush(me, seatBot, "remote");
      expect((await me.client.post(`/api/poker/tables/${table.groupId}/seats/3`, { persona: "dalu" })).status).toBe(
        200,
      );
      await finish(local, first, 1, 1000);

      expect(notices(await barrier(local, me)), "牌友是主人自己换下的，不找他").toEqual([]);
      expect(await flagOf(first.runId)).toBe(false);
      expect(await continuationsOf(first.runId)).toEqual([]);
      expect(await recordsOf(me, routineId)).toEqual([
        { status: "stopped", note: "换电脑后执行它的 Bot 不在这个群里了，没接着做 · ¥0.80" },
      ]);
      expect(remote.agent.received().filter((message) => message.type === "prompt")).toEqual([]);
    } finally {
      local.agent.close();
      remote.agent.close();
      me.push.close();
    }
  });

  it("旧数据里绑在牌桌群上的例行：换下牌友后旧 run 结账已提交、接续没起控制面就没了，重启补扫把记录收成 stopped", async () => {
    const gated = gatedDb(database.sql);
    await server.close();
    const crashed = await boot(gated.db);
    server = crashed;
    let resume: QueryGate | null = null;
    let me = await owner({ remote: true });
    const { table } = await pokerTable(me);
    const seatBot = seatThree(table);
    let local = await online(me.local);
    const remote = await online(remoteOf(me));

    try {
      const created = await me.client.post(`/api/bots/${seatBot}/routines`, {
        name: ROUTINE_NAME,
        instruction: "把今天的工单汇总一下",
        triggers: [{ kind: "cron", expr: "0 9 * * 1" }],
        onFailure: "stop_and_tell",
      });
      expect(created.status).toBe(201);
      const routineId = RoutineResponse.parse(await created.json()).routine.id;
      await database.sql`UPDATE routines SET group_id = ${table.groupId} WHERE id = ${routineId}`;
      expect((await me.client.post(`/api/routines/${routineId}/run`)).status).toBe(202);
      const first = await local.agent.expect("prompt");
      expect(await switchComputer(local, first, "remote")).toEqual({ status: 200, body: { result: "switching" } });
      await choicePush(me, seatBot, "remote");
      expect((await me.client.post(`/api/poker/tables/${table.groupId}/seats/3`, { persona: "dalu" })).status).toBe(
        200,
      );
      // 结账提交后、读欠着的接续那一下停住，直到新进程收完尾才放开：旧进程起不了接续，等同于在这之间没了。
      resume = gated.arm(/from "runs" where \("runs"\."continue_requested" = /, "before", first.runId);
      local.agent.send({
        type: "run_done",
        runId: first.runId,
        botId: first.botId,
        groupId: first.groupId,
        steps: 1,
        inputTokens: 1000,
        outputTokens: 1,
      });
      await resume.reached;
      expect(await recordsOf(me, routineId), "结账已提交，还欠着接续").toEqual([{ status: "running", note: "¥0.80" }]);
      expect(await flagOf(first.runId)).toBe(true);

      // 崩掉的进程不会体面停机：不 close 它，直接起一个新的，它的帧处理停在原地。
      local.agent.close();
      remote.agent.close();
      me.push.close();
      server = await boot();
      me = await reconnect(me);
      local = await online(me.local);

      expect(notices(await barrier(local, me)), "牌友是主人自己换下的，不找他").toEqual([]);
      expect(await flagOf(first.runId), "补扫收了尾，标记清掉").toBe(false);
      expect(await continuationsOf(first.runId)).toEqual([]);
      expect(await recordsOf(me, routineId)).toEqual([
        { status: "stopped", note: "换电脑后执行它的 Bot 不在这个群里了，没接着做 · ¥0.80" },
      ]);
    } finally {
      local.agent.close();
      remote.agent.close();
      me.push.close();
      resume?.release();
      await crashed.close();
      if (server === crashed) server = await boot();
    }
  });
});

async function pokerTable(o: Owner) {
  const created = await o.client.post("/api/poker/tables", { requestId: randomUUID() });
  expect(created.status).toBe(201);
  return PokerTableResponse.parse(await created.json());
}

function seatThree(table: PokerTableResponse["table"]): BotId {
  const botId = table.seats.find((seat) => seat.seat === 3)?.botId;
  if (botId === undefined || botId === null) throw new Error("3 号位没有牌友");
  return botId;
}

/** 起接续那条 INSERT 抛错：落行的事务回滚，换电脑的标记跟着恢复成立着。 */
async function withContinuationInsertFailure(body: () => Promise<void>): Promise<void> {
  await database.sql.unsafe(
    `CREATE FUNCTION continuation_insert_failure() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN IF NEW.continues_run_id IS NOT NULL THEN RAISE EXCEPTION '建接续故障'; END IF; RETURN NEW; END $$`,
  );
  await database.sql.unsafe(
    "CREATE TRIGGER continuation_insert_failure BEFORE INSERT ON runs FOR EACH ROW EXECUTE FUNCTION continuation_insert_failure()",
  );
  try {
    await body();
  } finally {
    await database.sql.unsafe("DROP TRIGGER continuation_insert_failure ON runs");
    await database.sql.unsafe("DROP FUNCTION continuation_insert_failure()");
  }
}

/** 建一条例行再试跑一次，名字自定：同一个人的两条例行要分得清是谁的记录。 */
async function trialNamedRoutine(
  o: Owner,
  name: string,
  extra: { readonly groupId?: GroupId; readonly purpose?: ModelPurpose; readonly boundary?: RoutineBoundary } = {},
): Promise<string> {
  const created = await o.client.post(`/api/bots/${o.botId}/routines`, {
    name,
    instruction: "把今天的工单汇总一下",
    triggers: [{ kind: "cron", expr: "0 9 * * 1" }],
    onFailure: "stop_and_tell",
    ...extra,
  });
  expect(created.status).toBe(201);
  const routine = RoutineResponse.parse(await created.json()).routine;
  expect((await o.client.post(`/api/routines/${routine.id}/run`)).status).toBe(202);
  return routine.id;
}

describe("接续的定期补扫", () => {
  it("结账后读欠着的接续那一下出错一次：接续没起、标记还立着，补扫一轮后在云电脑上起，做完记成 ok", async () => {
    const gated = gatedDb(database.sql);
    await server.close();
    server = await boot(gated.db);
    const me = await owner({ remote: true });
    const local = await online(me.local);
    const remote = await online(remoteOf(me));

    try {
      const routineId = await trialRoutine(me, "stop_and_tell");
      const first = await local.agent.expect("prompt");
      expect(await switchComputer(local, first, "remote")).toEqual({ status: 200, body: { result: "switching" } });
      await choicePush(me, me.botId, "remote");
      gated.arm(/from "runs" where \("runs"\."continue_requested" = /, "fail", first.runId);
      await finish(local, first, 1, 1000);
      expect(notices(await barrier(local, me)), "接续没起也没断链，不找主人").toEqual([]);
      expect(await flagOf(first.runId), "标记还立着，等补扫").toBe(true);
      expect(await continuationsOf(first.runId)).toEqual([]);
      expect(await recordsOf(me, routineId)).toEqual([{ status: "running", note: "¥0.80" }]);

      await server.server.sweepContinuations();
      const next = await remote.agent.expect("prompt");
      expectContinuation(next, first, CONTINUE_ON_REMOTE);
      speak(remote, next, "工单早报整理好了");
      await finish(remote, next, 1, 2000);
      expect(notices(await barrier(remote, me))).toEqual([]);
      expect(await recordsOf(me, routineId)).toEqual([{ status: "ok", note: "¥0.80 · ¥1.60" }]);
    } finally {
      local.agent.close();
      remote.agent.close();
      me.push.close();
      await server.close();
      server = await boot();
    }
  });

  it("两条例行同群：A 换电脑后结账排进 B 的回合，B 被 agent_error 放弃、回合收掉，电脑不重连，补扫一轮后 A 的接续起来，A 记 ok、B 记 failed", async () => {
    const me = await owner({ remote: true });
    const local = await online(me.local);
    const remote = await online(remoteOf(me));

    try {
      const routineA = await trialNamedRoutine(me, "早报 A");
      const first = await local.agent.expect("prompt");
      // B 的试跑在同一个群开新回合，顶掉 A 那一轮：A 结账时看到的是 B 正在跑的回合，接续排进它的队列。
      const routineB = await trialNamedRoutine(me, "早报 B");
      const other = await local.agent.expect("prompt");
      expect(await switchComputer(local, first, "remote")).toEqual({ status: 200, body: { result: "switching" } });
      await choicePush(me, me.botId, "remote");
      await finish(local, first, 1, 1000);
      local.agent.send({
        type: "agent_error",
        code: "runner_failed",
        detail: "运行器崩了",
        runId: other.runId,
        groupId: other.groupId,
      });
      await barrier(local, me);
      expect(await flagOf(first.runId), "排着的接续随回合一起丢了，标记还立着").toBe(true);
      expect(await continuationsOf(first.runId)).toEqual([]);

      await server.server.sweepContinuations();
      const next = await remote.agent.expect("prompt");
      expectContinuation(next, first, CONTINUE_ON_REMOTE);
      speak(remote, next, "工单早报整理好了");
      await finish(remote, next, 1, 2000);
      expect(notices(await barrier(remote, me))).toEqual([]);
      expect(await recordsOf(me, routineA)).toEqual([{ status: "ok", note: "¥0.80 · ¥1.60" }]);
      expect(await recordsOf(me, routineB)).toEqual([{ status: "failed", note: "跑活的进程出错了" }]);
    } finally {
      local.agent.close();
      remote.agent.close();
      me.push.close();
    }
  });
});

describe("不带 runId 的报错落在欠接续的旧 run 上", () => {
  it("请求换电脑 → 不带 runId 的报错 → 旧 run_done → 接续做完：运行记录记 ok，不弹通知", async () => {
    const me = await owner({ remote: true });
    const local = await online(me.local);
    const remote = await online(remoteOf(me));

    try {
      const routineId = await trialRoutine(me, "stop_and_tell");
      const first = await local.agent.expect("prompt");
      expect(await switchComputer(local, first, "remote")).toEqual({ status: 200, body: { result: "switching" } });
      await choicePush(me, me.botId, "remote");
      local.agent.send({ type: "agent_error", code: "runner_failed", detail: "工具进程退出了", groupId: me.groupId });
      await finish(local, first, 1, 1000);
      const next = await remote.agent.expect("prompt");
      expectContinuation(next, first, CONTINUE_ON_REMOTE);
      expect(await recordsOf(me, routineId), "欠着接续，结局留给链尾").toEqual([{ status: "running", note: "¥0.80" }]);
      speak(remote, next, "工单早报整理好了");
      await finish(remote, next, 1, 2000);
      expect(notices(await barrier(remote, me))).toEqual([]);
      expect(await recordsOf(me, routineId)).toEqual([{ status: "ok", note: "¥0.80 · ¥1.60" }]);
    } finally {
      local.agent.close();
      remote.agent.close();
      me.push.close();
    }
  });
});

describe("多 Bot 项目群里的例行", () => {
  it("执行它的 Bot 回 (pass)：运行记录照样结账，花费单落一张卡", async () => {
    const me = await owner({ remote: false });
    // 先建好群再上线：新 Bot 的 config 随 hello 下去，电脑上收到的下一条就是例行的 prompt。
    const helper = await soloGroup(me, "小内");
    const created = await me.client.post("/api/groups", { title: "工单项目", botIds: [me.botId, helper.botId] });
    expect(created.status).toBe(201);
    const groupId = CreateGroupResponse.parse(await created.json()).group.id;
    const local = await online(me.local);

    try {
      const routineId = await trialNamedRoutine(me, ROUTINE_NAME, { groupId });
      const prompt = await local.agent.expect("prompt");
      expect(prompt.groupId).toBe(groupId);
      local.agent.send({
        type: "bot_text",
        runId: prompt.runId,
        botId: prompt.botId,
        groupId,
        messageId: MessageId.parse(randomUUID()),
        delta: "(pass)",
        done: true,
      });
      await finish(local, prompt, 1, 1000);
      await barrier(local, me);
      expect(await recordsOf(me, routineId)).toEqual([{ status: "ok", note: "¥0.80" }]);
      const page = MessageListResponse.parse(await (await me.client.get(`/api/groups/${groupId}/messages`)).json());
      expect(page.messages.flatMap(({ body }) => (body.kind === "cost" ? [body.amount] : []))).toEqual([0.8]);
    } finally {
      local.agent.close();
      me.push.close();
    }
  });
});

describe("放弃旧 run 之后的推送", () => {
  it("请求换电脑后运行器带 runId 报错，收尾后刷新牌桌提示那一下出错一次：旧 run 照样收完，接续照样在云电脑上起", async () => {
    const gated = gatedDb(database.sql);
    await server.close();
    server = await boot(gated.db);
    const me = await owner({ remote: true });
    const local = await online(me.local);
    const remote = await online(remoteOf(me));

    try {
      await say(me, "把今天的工单导出来");
      const first = await local.agent.expect("prompt");
      expect(await switchComputer(local, first, "remote")).toEqual({ status: 200, body: { result: "switching" } });
      await choicePush(me, me.botId, "remote");
      gated.arm(/from "poker_hints"/, "fail", first.runId);
      local.agent.send({
        type: "agent_error",
        code: "runner_failed",
        detail: "运行器崩了",
        runId: first.runId,
        groupId: first.groupId,
      });
      const next = await remote.agent.expect("prompt");
      expectContinuation(next, first, CONTINUE_ON_REMOTE);
      expect(await errorTexts(me)).toEqual(["电脑那边没干成这件事，跑活的进程出错了。原话是：运行器崩了"]);
    } finally {
      local.agent.close();
      remote.agent.close();
      me.push.close();
      await server.close();
      server = await boot();
    }
  });
});

describe("停机撞上在途的补扫", () => {
  it("补扫过了可派判断、读群成员时停机：标记还立着、记录还在 running、群里不说派不出去，重启后云电脑上线接着做，做完记 ok", async () => {
    const gated = gatedDb(database.sql);
    await server.close();
    server = await boot(gated.db);
    let me = await owner({ remote: true });
    const local = await online(me.local);
    let remote = await online(remoteOf(me));

    try {
      const routineId = await trialRoutine(me, "stop_and_tell");
      const first = await local.agent.expect("prompt");
      expect(await switchComputer(local, first, "remote")).toEqual({ status: 200, body: { result: "switching" } });
      await choicePush(me, me.botId, "remote");
      // 结账后读接续那一下出错：run 已结束、已结账、标记立着、没有接续，只等补扫。
      gated.arm(/from "runs" where \("runs"\."continue_requested" = /, "fail", first.runId);
      await finish(local, first, 1, 1000);
      await barrier(local, me);
      expect(await flagOf(first.runId)).toBe(true);
      const gate = gated.arm(/from "group_members" inner join "bots"/, "before", me.groupId);
      const sweep = server.server.sweepContinuations();
      await gate.reached;
      const closing = server.close();
      await remote.agent.closed();
      gate.release();
      await closing;
      await sweep.catch(() => 0);
      expect(await flagOf(first.runId), "停机期间不清标记").toBe(true);
      expect(await continuationsOf(first.runId)).toEqual([]);

      local.agent.close();
      me.push.close();
      server = await boot();
      me = await reconnect(me);
      expect(await recordsOf(me, routineId), "停机期间不记失败").toEqual([{ status: "running", note: "¥0.80" }]);
      expect(await errorTexts(me), "停机不是派不出去，群里不留话").toEqual([]);

      remote = await online(remoteOf(me));
      const next = await remote.agent.expect("prompt");
      expectContinuation(next, first, CONTINUE_ON_REMOTE);
      speak(remote, next, "工单早报整理好了");
      await finish(remote, next, 1, 2000);
      expect(notices(await barrier(remote, me))).toEqual([]);
      expect(await recordsOf(me, routineId)).toEqual([{ status: "ok", note: "¥0.80 · ¥1.60" }]);
    } finally {
      local.agent.close();
      remote.agent.close();
      me.push.close();
      await server.close().catch(() => undefined);
      server = await boot();
    }
  });
});

describe("排进别的回合的接续按自己的链取配置", () => {
  it("A、B 两条例行用途和边界不同：A 的接续排进 B 的回合、B 正常做完后派出，接续的 prompt 是 A 的用途和边界，两条记录各记各的", async () => {
    const me = await owner({ remote: true });
    const local = await online(me.local);
    const remote = await online(remoteOf(me));

    try {
      const routineA = await trialNamedRoutine(me, "早报 A", { purpose: "plan", boundary: "draft" });
      const first = await local.agent.expect("prompt");
      expect(first.routine).toEqual({ routineId: routineA, boundary: "draft" });
      // B 的试跑在同一个群开新回合，顶掉 A 那一轮：A 结账时接续排进 B 正在跑的回合。
      const routineB = await trialNamedRoutine(me, "早报 B", { purpose: "fast", boundary: "read_only" });
      const other = await local.agent.expect("prompt");
      expect(other.routine).toEqual({ routineId: routineB, boundary: "read_only" });
      expect(other.purpose).toBe("fast");
      expect(await switchComputer(local, first, "remote")).toEqual({ status: 200, body: { result: "switching" } });
      await choicePush(me, me.botId, "remote");
      await finish(local, first, 1, 1000);
      await finish(local, other, 1, 500);

      const next = await remote.agent.expect("prompt");
      expectContinuation(next, first, CONTINUE_ON_REMOTE);
      expect(next.routine, "接续按 A 的边界跑").toEqual({ routineId: routineA, boundary: "draft" });
      expect(next.purpose, "接续按 A 的用途选模型").toBe("plan");
      expect(await routineRunIdOf(next.runId)).toBe(await routineRunIdOf(first.runId));
      speak(remote, next, "工单早报整理好了");
      await finish(remote, next, 1, 2000);
      expect(notices(await barrier(remote, me))).toEqual([]);
      expect(await recordsOf(me, routineA)).toEqual([{ status: "ok", note: "¥0.80 · ¥1.60" }]);
      expect(await recordsOf(me, routineB)).toEqual([{ status: "ok", note: "¥0.40" }]);
    } finally {
      local.agent.close();
      remote.agent.close();
      me.push.close();
    }
  });

  it("A 是普通聊天、B 是例行：A 的接续排进 B 的回合派出，不关联 B 的运行记录，A 的花费不进 B 的 note", async () => {
    const me = await owner({ remote: true });
    const local = await online(me.local);
    const remote = await online(remoteOf(me));

    try {
      await say(me, "把今天的工单导出来");
      const first = await local.agent.expect("prompt");
      expect(first.routine).toBeNull();
      const routineB = await trialNamedRoutine(me, "早报 B", { purpose: "fast", boundary: "read_only" });
      const other = await local.agent.expect("prompt");
      expect(await switchComputer(local, first, "remote")).toEqual({ status: 200, body: { result: "switching" } });
      await choicePush(me, me.botId, "remote");
      await finish(local, first, 1, 1000);
      await finish(local, other, 1, 500);

      const next = await remote.agent.expect("prompt");
      expectContinuation(next, first, CONTINUE_ON_REMOTE);
      expect(next.routine, "普通聊天的接续不带例行边界").toBeNull();
      expect(next.purpose).toBe("plan");
      expect(await routineRunIdOf(next.runId), "父链没有运行记录，接续也没有").toBeNull();
      speak(remote, next, "工单导出来了");
      await finish(remote, next, 1, 2000);
      expect(notices(await barrier(remote, me))).toEqual([]);
      expect(await recordsOf(me, routineB)).toEqual([{ status: "ok", note: "¥0.40" }]);
    } finally {
      local.agent.close();
      remote.agent.close();
      me.push.close();
    }
  });
});

describe("报错先于换电脑", () => {
  it("不带 runId 的报错先把例行记成失败，之后请求换电脑被拒、不起接续：记录停在 failed", async () => {
    const me = await owner({ remote: true });
    const local = await online(me.local);
    const remote = await online(remoteOf(me));

    try {
      const routineId = await trialRoutine(me, "stop_and_tell");
      const first = await local.agent.expect("prompt");
      local.agent.send({ type: "agent_error", code: "runner_failed", detail: "写工作记录失败", groupId: me.groupId });
      await barrier(local, me);
      expect(await recordsOf(me, routineId)).toEqual([{ status: "failed", note: "跑活的进程出错了" }]);
      expect(await switchComputer(local, first, "remote")).toEqual({
        status: 200,
        body: {
          result: "refused",
          reason: "routine_failed",
          text: "这次例行任务已经记成失败，换不了电脑，请在当前这台上收尾或告诉主人。",
        },
      });
      speak(local, first, "工单早报整理好了");
      await finish(local, first, 1, 1000);
      expect(notices(await barrier(local, me)), "记成失败那一下之后不再弹").toEqual([]);
      expect(await continuationsOf(first.runId)).toEqual([]);
      expect(remote.agent.received().filter((message) => message.type === "prompt")).toEqual([]);
      expect(await recordsOf(me, routineId)).toEqual([{ status: "failed", note: "跑活的进程出错了 · ¥0.80" }]);
    } finally {
      local.agent.close();
      remote.agent.close();
      me.push.close();
    }
  });
});
