import {
  ComputerChoices,
  ComputerListResponse,
  ComputerTokenResponse,
  CreateBotResponse,
  CreateGroupResponse,
  MessageListResponse,
  PokerTableResponse,
  RoutineResponse,
  type BotId,
  type ComputerId,
  type ComputerKind,
  type GroupId,
  type RunId,
  type ServerPush,
  type UserId,
} from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_CONFIG, startServer } from "../src/server.js";
import { ApiClient, TEST_CREDENTIALS_KEY, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, type TestComputer } from "./helpers/fixtures.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { connectPush, type PushClient } from "./helpers/ws.js";

let database: TestDb;
let server: TestServer;

/** 2030-01-07 是周一。扫描间隔顶到一小时，只有测试自己调 `tick()` 才会到点。 */
const MONDAY_BEFORE_NINE = new Date("2030-01-07T08:59:00");
const MONDAY_NINE = new Date("2030-01-07T09:00:00");
let clock = new Date(MONDAY_BEFORE_NINE);

beforeAll(async () => {
  database = await createTestDb();
  const running = await startServer({
    db: database.db,
    port: 0,
    credentialsKey: TEST_CREDENTIALS_KEY,
    toolSecretKey: "a".repeat(64),
    config: DEFAULT_RUNTIME_CONFIG,
    scheduler: { now: () => clock, intervalMs: 60 * 60 * 1000 },
    notificationScheduler: { now: () => clock, intervalMs: 60 * 60 * 1000 },
    publisher: { intervalMs: 24 * 60 * 60 * 1000 },
  });
  server = { server: running, client: () => new ApiClient(running.port), close: () => running.close() };
});

afterAll(async () => {
  await server.close();
  await database.close();
});

type Owner = {
  readonly ownerId: UserId;
  readonly client: ApiClient;
  readonly local: TestComputer;
  readonly remote: TestComputer | null;
  readonly groupId: GroupId;
  readonly botId: BotId;
};

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
  return { ownerId: user.id, client, local, remote, groupId: created.group.id, botId: created.bot.id };
}

function remoteOf(o: Owner): TestComputer {
  if (o.remote === null) throw new Error("这个用户没有云电脑");
  return o.remote;
}

async function online(computer: TestComputer): Promise<AgentClient> {
  const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);
  return agent;
}

function choose(o: Owner, groupId: GroupId, botId: BotId, kind: unknown): Promise<Response> {
  return o.client.request("PUT", `/api/groups/${groupId}/bots/${botId}/computer`, { kind });
}

async function choices(o: Owner, groupId: GroupId): Promise<ComputerChoices> {
  const response = await o.client.get(`/api/groups/${groupId}/computer-choices`);
  expect(response.status).toBe(200);
  return ComputerChoices.parse(await response.json());
}

async function runComputers(groupId: GroupId): Promise<string[]> {
  const rows = await database.sql<{ computer_id: string }[]>`
    SELECT computer_id FROM runs WHERE group_id = ${groupId} ORDER BY started_at ASC, id ASC
  `;
  return rows.map((row) => row.computer_id);
}

async function systemTexts(o: Owner, groupId: GroupId, tone: "error" | "plain"): Promise<string[]> {
  const page = MessageListResponse.parse(await (await o.client.get(`/api/groups/${groupId}/messages`)).json());
  return page.messages.flatMap(({ body }) =>
    body.kind === "system" && (body.tone === "error") === (tone === "error") ? [body.text] : [],
  );
}

async function finish(agent: AgentClient, botId: BotId, groupId: GroupId, runId: RunId): Promise<void> {
  agent.send({ type: "run_done", runId, botId, groupId, steps: 1, inputTokens: 1, outputTokens: 1 });
  await agent.ack(runId);
}

type ChoicePush = Extract<ServerPush, { type: "computer_choice_updated" }>;

/** 收到 `until` 那条选择推送为止，沿途的选择推送和 system 消息推送都记下来。 */
async function choicePushesUntil(
  push: PushClient,
  until: { readonly botId: BotId; readonly kind: ComputerKind },
): Promise<{ choices: ChoicePush[]; systems: string[] }> {
  const seen: ChoicePush[] = [];
  const systems: string[] = [];
  for (;;) {
    const item = await push.next();
    if (item.type === "message" && item.message.body.kind === "system") systems.push(item.message.body.text);
    if (item.type !== "computer_choice_updated") continue;
    seen.push(item);
    if (item.botId === until.botId && item.kind === until.kind) return { choices: seen, systems };
  }
}

const CHOSEN_REMOTE_OFFLINE =
  "这个 Bot 在这个群里选了用云电脑，云电脑现在不在线，这条没派出去，也不会改派到你的电脑，云电脑回来后再说一次，或在群顶部改用你的电脑";

describe("每个 Bot 在每个群里选哪台电脑", () => {
  it("单聊里选了云电脑，这个群的活派到云电脑，同一个 Bot 在别的群照旧本机优先", async () => {
    const me = await owner({ remote: true });
    const second = CreateBotResponse.parse(await (await me.client.post("/api/bots", { name: "小销" })).json());
    const team = CreateGroupResponse.parse(
      await (await me.client.post("/api/groups", { title: "两人群", botIds: [me.botId, second.bot.id] })).json(),
    ).group.id;
    const local = await online(me.local);
    const remote = await online(remoteOf(me));

    try {
      expect((await choose(me, me.groupId, me.botId, "remote")).status, "选择成功回 204").toBe(204);
      expect(await systemTexts(me, me.groupId, "plain"), "群里留一句换到了哪台").toContain(
        "小运之后在这个群里用云电脑",
      );

      await me.client.post(`/api/groups/${me.groupId}/messages`, { text: "第一件事" });
      expect(await systemTexts(me, me.groupId, "error"), "云电脑在线，不该说派不出去").toEqual([]);
      expect(await runComputers(me.groupId), "选了云电脑的群落到云电脑").toEqual([remoteOf(me).computerId]);
      expect((await remote.expect("prompt")).text).toBe("第一件事");

      await me.client.post(`/api/groups/${team}/messages`, { text: "@小运 看看" });
      expect(await systemTexts(me, team, "error")).toEqual([]);
      expect(await runComputers(team), "别的群没选过，两台都在线时本机优先").toEqual([me.local.computerId]);
      expect((await local.expect("prompt")).groupId).toBe(team);
    } finally {
      local.close();
      remote.close();
    }
  });

  it("选了云电脑而云电脑不在线，例行记失败、群里说明白，也不落到本机", async () => {
    const me = await owner({ remote: true });
    const local = await online(me.local);
    clock = new Date(MONDAY_BEFORE_NINE);

    try {
      expect((await choose(me, me.groupId, me.botId, "remote")).status, "用户替 Bot 选一台不在线的电脑也行").toBe(204);
      const response = await me.client.post(`/api/bots/${me.botId}/routines`, {
        name: "排本周计划",
        instruction: "排本周计划",
        triggers: [{ kind: "cron", expr: "0 9 * * 1" }],
        onFailure: "stop_and_tell",
      });
      expect(response.status).toBe(201);
      const routineId = RoutineResponse.parse(await response.json()).routine.id;
      await server.server.routines.tick();
      clock = new Date(MONDAY_NINE);
      await server.server.routines.tick();

      // tick 等这一轮例行派活结束才回，运行记录和群里那句话这时都已落定。
      const runs = await database.sql<{ status: string; note: string }[]>`
        SELECT status, note FROM routine_runs WHERE routine_id = ${routineId}
      `;
      expect(runs, "派不出去的例行不能停在运行中").toEqual([
        { status: "failed", note: "这个 Bot 在这个群里选了用云电脑，云电脑现在不在线，没跑起来" },
      ]);
      expect(await systemTexts(me, me.groupId, "error")).toEqual([CHOSEN_REMOTE_OFFLINE]);
      expect(await runComputers(me.groupId), "本机在线也不改派过去").toEqual([]);

      await me.client.post(`/api/groups/${me.groupId}/messages`, { text: "那现在呢" });
      expect(await systemTexts(me, me.groupId, "error"), "用户自己发的也一样").toEqual([
        CHOSEN_REMOTE_OFFLINE,
        CHOSEN_REMOTE_OFFLINE,
      ]);
      expect(await runComputers(me.groupId)).toEqual([]);
    } finally {
      local.close();
    }
  });

  it("同一个值再选一次不推送、不留话", async () => {
    const me = await owner({ remote: true });
    const push = await connectPush(server.server.port, me.client.cookie ?? "");

    try {
      expect((await choose(me, me.groupId, me.botId, "remote")).status).toBe(204);
      expect((await choose(me, me.groupId, me.botId, "remote")).status, "重复选同一台也是 204").toBe(204);
      // 换回本机当标记：它的推送到了，前面两次 PUT 该推的都已经推完。
      expect((await choose(me, me.groupId, me.botId, "local")).status).toBe(204);

      const seen = await choicePushesUntil(push, { botId: me.botId, kind: "local" });
      expect(seen.choices.map(({ groupId, botId, kind }) => ({ groupId, botId, kind }))).toEqual([
        { groupId: me.groupId, botId: me.botId, kind: "remote" },
        { groupId: me.groupId, botId: me.botId, kind: "local" },
      ]);
      expect(seen.systems, "消息推送在选择推送之前，每次真换了才一条").toEqual([
        "小运之后在这个群里用云电脑",
        "小运之后在这个群里用你的电脑",
      ]);
      expect(await systemTexts(me, me.groupId, "plain")).toEqual([
        "小运之后在这个群里用云电脑",
        "小运之后在这个群里用你的电脑",
      ]);
    } finally {
      push.close();
    }
  });

  it("单聊和多 Bot 群都能选；别人的群、不在群里的 Bot 一律 404，没有那种电脑 409", async () => {
    const me = await owner({ remote: false });
    const second = CreateBotResponse.parse(await (await me.client.post("/api/bots", { name: "小销" })).json());
    const outsider = CreateBotResponse.parse(await (await me.client.post("/api/bots", { name: "小三" })).json());
    const team = CreateGroupResponse.parse(
      await (await me.client.post("/api/groups", { title: "两人群", botIds: [me.botId, second.bot.id] })).json(),
    ).group.id;

    expect(await choices(me, me.groupId), "没选过是 null，没在跑也是 null").toEqual([
      { botId: me.botId, kind: null, runningOn: null },
    ]);
    expect((await choose(me, me.groupId, me.botId, "local")).status, "单聊能选").toBe(204);
    expect((await choose(me, team, second.bot.id, "local")).status, "多 Bot 群能选").toBe(204);
    expect(await choices(me, me.groupId)).toEqual([{ botId: me.botId, kind: "local", runningOn: null }]);
    expect(await choices(me, team), "按成员顺序，一个群各管各的").toEqual([
      { botId: me.botId, kind: null, runningOn: null },
      { botId: second.bot.id, kind: "local", runningOn: null },
    ]);

    expect((await choose(me, team, outsider.bot.id, "local")).status, "不在这个群里的 Bot").toBe(404);
    const refused = await choose(me, me.groupId, me.botId, "remote");
    expect(refused.status, "账号下没有云电脑").toBe(409);
    expect(await refused.json()).toEqual({ error: "你还没有云电脑，选不了" });
    expect((await choose(me, me.groupId, me.botId, "cloud")).status, "kind 不是两种之一").toBe(400);

    const stranger = await owner({ remote: true });
    expect((await choose(stranger, me.groupId, me.botId, "local")).status, "别人的群").toBe(404);
    expect((await stranger.client.get(`/api/groups/${me.groupId}/computer-choices`)).status).toBe(404);
    expect(await choices(me, me.groupId), "别人改不动").toEqual([{ botId: me.botId, kind: "local", runningOn: null }]);
  });

  it("runningOn 跟着这条道上没跑完的 run 走，跑完了新选择才落地", async () => {
    const me = await owner({ remote: true });
    const local = await online(me.local);
    const remote = await online(remoteOf(me));

    try {
      expect((await choose(me, me.groupId, me.botId, "remote")).status).toBe(204);
      await me.client.post(`/api/groups/${me.groupId}/messages`, { text: "第一件事" });
      const first = await remote.expect("prompt");
      expect(await choices(me, me.groupId), "这一轮在云电脑上").toEqual([
        { botId: me.botId, kind: "remote", runningOn: "remote" },
      ]);

      expect((await choose(me, me.groupId, me.botId, "local")).status).toBe(204);
      expect(await choices(me, me.groupId), "改了选择，这一轮还在云电脑上跑完").toEqual([
        { botId: me.botId, kind: "local", runningOn: "remote" },
      ]);

      await finish(remote, me.botId, me.groupId, first.runId);
      expect(await choices(me, me.groupId), "跑完了没有在跑的").toEqual([
        { botId: me.botId, kind: "local", runningOn: null },
      ]);

      await me.client.post(`/api/groups/${me.groupId}/messages`, { text: "第二件事" });
      expect(await runComputers(me.groupId), "下一条起落到新选的那台").toEqual([
        remoteOf(me).computerId,
        me.local.computerId,
      ]);
      expect((await local.expect("prompt")).text).toBe("第二件事");
      expect(await choices(me, me.groupId)).toEqual([{ botId: me.botId, kind: "local", runningOn: "local" }]);
    } finally {
      local.close();
      remote.close();
    }
  });

  it("电脑列表和上线推送带 dispatchable：连着的能派，没连过的不能", async () => {
    const me = await owner({ remote: true });
    const push = await connectPush(server.server.port, me.client.cookie ?? "");
    const local = await online(me.local);

    try {
      for (;;) {
        const item = await push.next();
        if (item.type !== "computer_updated" || item.computer.id !== me.local.computerId) continue;
        expect(item.computer, "上线那条推送就已经能派").toMatchObject({ status: "online", dispatchable: true });
        break;
      }
      const listed = ComputerListResponse.parse(await (await me.client.get("/api/computers")).json());
      const byId = new Map<ComputerId, boolean>(
        listed.computers.map((computer) => [computer.id, computer.dispatchable]),
      );
      expect(byId.get(me.local.computerId)).toBe(true);
      expect(byId.get(remoteOf(me).computerId), "云电脑还没连过").toBe(false);
    } finally {
      push.close();
      local.close();
    }
  });

  it("牌桌赛前换人，换上来的牌友不继承前一个选的电脑", async () => {
    const me = await owner({ remote: true });
    const created = await me.client.post("/api/poker/tables", { requestId: "choice-swap" });
    expect(created.status).toBe(201);
    const table = PokerTableResponse.parse(await created.json()).table;
    const seatThree = table.seats.find((seat) => seat.seat === 3)?.botId;
    if (seatThree === undefined || seatThree === null) throw new Error("3 号位没有牌友");
    expect((await choose(me, table.groupId, seatThree, "remote")).status).toBe(204);

    const swapped = await me.client.post(`/api/poker/tables/${table.groupId}/seats/3`, { persona: "dalu" });

    expect(swapped.status).toBe(200);
    const newcomer = PokerTableResponse.parse(await swapped.json()).table.seats.find((seat) => seat.seat === 3)?.botId;
    expect(newcomer).not.toBe(seatThree);
    const seated = (await choices(me, table.groupId)).find((choice) => choice.botId === newcomer);
    expect(seated, "换上来的牌友还没选过").toMatchObject({ kind: null });
  });
});
