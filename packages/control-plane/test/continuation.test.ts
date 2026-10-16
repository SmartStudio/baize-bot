import {
  ComputerChoices,
  ComputerTokenResponse,
  CreateBotResponse,
  CreateGroupResponse,
  MessageListResponse,
  type BotId,
  type ComputerKind,
  type ControlToAgent,
  type GroupId,
  type RunId,
  type UserId,
} from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MENTION_LOOP_NOTICE } from "../src/agent/group-turn.js";
import { DEFAULT_RUNTIME_CONFIG, startServer } from "../src/server.js";
import { ApiClient, TEST_CREDENTIALS_KEY, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, type TestComputer } from "./helpers/fixtures.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { connectPush, type PushClient } from "./helpers/ws.js";

let database: TestDb;
let server: TestServer;

type Prompt = Extract<ControlToAgent, { type: "prompt" }>;

const HOUR = 60 * 60 * 1000;

async function boot(): Promise<TestServer> {
  const running = await startServer({
    db: database.db,
    port: 0,
    credentialsKey: TEST_CREDENTIALS_KEY,
    toolSecretKey: "a".repeat(64),
    config: DEFAULT_RUNTIME_CONFIG,
    // 断线宽限压短：电脑合盖那一类用例要等宽限过去、控制面放弃旧 run，在线的电脑每条上行都续租，不受影响。
    disconnectGraceMs: 50,
    scheduler: { now: () => new Date("2030-01-07T08:59:00"), intervalMs: HOUR },
    notificationScheduler: { now: () => new Date("2030-01-07T08:59:00"), intervalMs: HOUR },
    publisher: { intervalMs: 24 * HOUR },
  });
  return { server: running, client: () => new ApiClient(running.port), close: () => running.close() };
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

async function finish(on: Online, prompt: Prompt, nth = 1): Promise<void> {
  on.agent.send({
    type: "run_done",
    runId: prompt.runId,
    botId: prompt.botId,
    groupId: prompt.groupId,
    steps: 1,
    inputTokens: 1,
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
