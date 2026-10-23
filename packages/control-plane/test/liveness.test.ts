import { randomUUID } from "node:crypto";
import {
  ComputerTokenResponse,
  CreateBotResponse,
  MessageListResponse,
  RoutineResponse,
  type BotId,
  type Computer,
  type ComputerId,
  type GroupId,
  type ServerPush,
} from "@baize/shared";
import { afterAll, beforeAll, expect, it } from "vitest";
import { DEFAULT_RUNTIME_CONFIG, startServer, type RunningServer } from "../src/server.js";
import { ApiClient, TEST_CREDENTIALS_KEY } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, type TestComputer } from "./helpers/fixtures.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { connectPush, type PushClient } from "./helpers/ws.js";

const SILENCE_MS = 500;
const HEARTBEAT_MS = 100;
const HOUR_MS = 60 * 60 * 1000;
const DISCONNECT_NOTICE = "电脑断过线，这次活没做完";

let database: TestDb;
let server: RunningServer;
let clock = new Date("2030-01-07T08:59:00");

beforeAll(async () => {
  database = await createTestDb();
  server = await startServer({
    db: database.db,
    port: 0,
    config: DEFAULT_RUNTIME_CONFIG,
    credentialsKey: TEST_CREDENTIALS_KEY,
    toolSecretKey: "a".repeat(64),
    scheduler: { now: () => clock, intervalMs: HOUR_MS },
    publisher: { intervalMs: 24 * HOUR_MS },
    silenceTimeoutMs: SILENCE_MS,
    disconnectGraceMs: 200,
    leaseRenewalIntervalMs: HEARTBEAT_MS,
  });
});

afterAll(async () => {
  await server.close();
  await database.close();
});

type Owner = {
  readonly client: ApiClient;
  readonly push: PushClient;
  readonly local: TestComputer;
  readonly remote: TestComputer;
  readonly groupId: GroupId;
  readonly botId: BotId;
};

async function owner(): Promise<Owner> {
  const user = await makeUser(database.db);
  const local = await makeComputer(database.db, user.id);
  const client = new ApiClient(server.port);
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const token = ComputerTokenResponse.parse(await (await client.post("/api/computers/remote")).json());
  const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小运" })).json());
  const push = await connectPush(server.port, client.cookie ?? "");
  return {
    client,
    push,
    local,
    remote: { computerId: token.computerId, token: token.token },
    groupId: created.group.id,
    botId: created.bot.id,
  };
}

/** 像真电脑代理那样定时发心跳。返回的函数让它停下，socket 仍然开着。 */
type Live = { readonly agent: AgentClient; stop(): void };

async function live(computer: TestComputer): Promise<Live> {
  const { agent } = await helloAgent(server.port, computer.computerId, computer.token);
  const timer = setInterval(() => {
    if (agent.socket.readyState === agent.socket.OPEN) agent.send({ type: "heartbeat", at: new Date().toISOString() });
  }, HEARTBEAT_MS);
  return { agent, stop: () => clearInterval(timer) };
}

/** 合盖：进程冻住，不再发帧，也不再读，连接却没关。 */
function freeze(computer: Live): void {
  computer.stop();
  computer.agent.socket.pause();
}

type StatusChange = { readonly computerId: ComputerId; readonly status: string; readonly dispatchable: boolean };

function changeOf(computer: Computer): StatusChange {
  return { computerId: computer.id, status: computer.status, dispatchable: computer.dispatchable };
}

/** 一直读推送，直到这台电脑变成 status；返回这之前（含这条）看到的全部电脑状态变化。 */
async function untilStatus(push: PushClient, computerId: ComputerId, status: string): Promise<StatusChange[]> {
  const seen: StatusChange[] = [];
  for (;;) {
    const item = await push.next();
    if (item.type !== "computer_updated") continue;
    seen.push(changeOf(item.computer));
    if (item.computer.id === computerId && item.computer.status === status) return seen;
  }
}

type Notice = Extract<ServerPush, { type: "notify" }>["notice"];

/** 改一次 Bot 描述当顺序标记：标记推到之前的推送就是此刻为止的全部。 */
async function pushesBeforeMarker(o: Owner): Promise<{ changes: StatusChange[]; notices: Notice[] }> {
  const description = `标记 ${randomUUID()}`;
  expect((await o.client.patch(`/api/bots/${o.botId}`, { description })).status).toBe(200);
  const changes: StatusChange[] = [];
  const notices: Notice[] = [];
  for (;;) {
    const item = await o.push.next();
    if (item.type === "bot_updated" && item.bot.description === description) return { changes, notices };
    if (item.type === "computer_updated") changes.push(changeOf(item.computer));
    if (item.type === "notify") notices.push(item.notice);
  }
}

async function say(o: Owner, text: string): Promise<void> {
  expect((await o.client.post(`/api/groups/${o.groupId}/messages`, { text })).status).toBe(201);
}

async function runComputers(groupId: GroupId): Promise<string[]> {
  const rows = await database.sql<{ computer_id: string }[]>`
    SELECT computer_id FROM runs WHERE group_id = ${groupId} ORDER BY started_at ASC, id ASC`;
  return rows.map((row) => row.computer_id);
}

async function computerStatus(id: ComputerId): Promise<string | undefined> {
  const rows = await database.sql<{ status: string }[]>`SELECT status FROM computers WHERE id = ${id}`;
  return rows[0]?.status;
}

async function errorNotices(o: Owner): Promise<string[]> {
  const page = MessageListResponse.parse(await (await o.client.get(`/api/groups/${o.groupId}/messages`)).json());
  return page.messages.flatMap(({ body }) => (body.kind === "system" && body.tone === "error" ? [body.text] : []));
}

it("本机 socket 还开着但不再发帧，超过阈值后被认定离线，下一次派活走远程", async () => {
  const o = await owner();
  const local = await live(o.local);
  const remote = await live(o.remote);

  freeze(local);
  await untilStatus(o.push, o.local.computerId, "sleeping");
  await say(o, "排一下本周计划");

  const prompt = await remote.agent.expect("prompt");
  expect(prompt.groupId).toBe(o.groupId);
  expect(await runComputers(o.groupId), "本机判死后这次派活记在远程").toEqual([o.remote.computerId]);
  expect(await errorNotices(o), "派出去了，群里没有派不出去的提示").toEqual([]);

  remote.stop();
  remote.agent.close();
  local.agent.close();
  o.push.close();
});

it("被判死的电脑重连回来，派活又走本机", async () => {
  const o = await owner();
  const dead = await live(o.local);
  const remote = await live(o.remote);

  freeze(dead);
  await untilStatus(o.push, o.local.computerId, "sleeping");

  const back = await live(o.local);
  await untilStatus(o.push, o.local.computerId, "online");
  await say(o, "本机回来了吗");
  expect((await back.agent.expect("prompt")).groupId).toBe(o.groupId);
  expect(await runComputers(o.groupId), "重连后派活回到本机").toEqual([o.local.computerId]);

  // 合盖的进程醒过来，在那条早被判死的旧连接上补发一帧。它到不了控制面，也不能改掉新连接的在线状态。
  dead.agent.socket.resume();
  dead.agent.send({ type: "heartbeat", at: new Date().toISOString() });
  const after = await pushesBeforeMarker(o);
  expect(after.changes, "旧连接醒来不改电脑状态").toEqual([]);
  expect(await computerStatus(o.local.computerId)).toBe("online");
  expect((await back.agent.next()).type, "标记改了 Bot 描述，新连接照常收到重发的 config").toBe("config");
  await say(o, "再来一条");
  expect((await back.agent.expect("prompt")).groupId).toBe(o.groupId);
  expect(await runComputers(o.groupId), "第二条还走本机").toEqual([o.local.computerId, o.local.computerId]);

  back.stop();
  back.agent.close();
  remote.stop();
  remote.agent.close();
  dead.agent.close();
  o.push.close();
});

it("判死走的是正常离线处理：断线和宽限到期各推一次电脑状态，断线收尾和 stuck 照常，各只一次", async () => {
  const o = await owner();
  const local = await live(o.local);
  clock = new Date("2030-01-07T08:59:00");
  const response = await o.client.post(`/api/bots/${o.botId}/routines`, {
    name: "排本周计划",
    instruction: "排本周计划",
    triggers: [{ kind: "cron", expr: "0 9 * * 1" }],
    onFailure: "stop_and_tell",
  });
  expect(response.status).toBe(201);
  const routineId = RoutineResponse.parse(await response.json()).routine.id;
  await server.routines.tick();
  clock = new Date("2030-01-07T09:00:00");
  await server.routines.tick();
  expect((await local.agent.expect("prompt")).origin).toEqual({ kind: "routine" });

  freeze(local);
  const changes = await untilStatus(o.push, o.local.computerId, "sleeping");
  const notices: Notice[] = [];
  for (;;) {
    const item = await o.push.next();
    if (item.type === "computer_updated") changes.push(changeOf(item.computer));
    if (item.type === "notify") notices.push(item.notice);
    if (item.type === "notify" && item.notice.kind === "stuck") break;
  }
  const rest = await pushesBeforeMarker(o);

  expect(
    [...changes, ...rest.changes].filter((change) => change.status === "sleeping"),
    "离线推送两条：断线那一拍还在宽限期里能派，宽限到期才不能派",
  ).toEqual([
    { computerId: o.local.computerId, status: "sleeping", dispatchable: true },
    { computerId: o.local.computerId, status: "sleeping", dispatchable: false },
  ]);
  expect(
    [...notices, ...rest.notices].filter((notice) => notice.kind === "stuck").map((notice) => notice.text),
    "stuck 恰好一条",
  ).toEqual(["例行任务「排本周计划」没跑完：电脑中途断线"]);
  expect(await errorNotices(o), "群里的断线提示恰好一句").toEqual([DISCONNECT_NOTICE]);
  const runs = await database.sql<{ status: string; note: string }[]>`
    SELECT status, note FROM routine_runs WHERE routine_id = ${routineId}`;
  expect(runs).toEqual([{ status: "failed", note: DISCONNECT_NOTICE }]);

  local.agent.close();
  o.push.close();
});

it("一直在发心跳的电脑不会被误判", async () => {
  const o = await owner();
  const local = await live(o.local);
  const [initial] = await database.sql<{ lease_until: string }[]>`
    SELECT lease_until FROM computers WHERE id = ${o.local.computerId}`;
  // 远程比本机晚连上、一帧不发。它被判死的时候，本机从连上算起已经过了不止一个阈值。
  const { agent: silent } = await helloAgent(server.port, o.remote.computerId, o.remote.token);

  const changes = await untilStatus(o.push, o.remote.computerId, "sleeping");
  const [renewed] = await database.sql<{ lease_until: string; live: boolean }[]>`
    SELECT lease_until, lease_until > clock_timestamp() AS live FROM computers WHERE id = ${o.local.computerId}`;
  expect(new Date(renewed?.lease_until ?? "").getTime(), "落地心跳已推进租约时钟").toBeGreaterThan(
    new Date(initial?.lease_until ?? "").getTime(),
  );
  expect(renewed?.live, "静默判死其他电脑时，本机数据库租约仍有效").toBe(true);
  expect(
    changes.filter((change) => change.computerId === o.local.computerId && change.status === "sleeping"),
    "发着心跳的本机没被判死",
  ).toEqual([]);
  expect(local.agent.socket.readyState).toBe(local.agent.socket.OPEN);
  await say(o, "本机还在吗");
  expect((await local.agent.expect("prompt")).groupId).toBe(o.groupId);
  expect(await runComputers(o.groupId)).toEqual([o.local.computerId]);

  local.stop();
  local.agent.close();
  silent.close();
  o.push.close();
});

it("电脑在旧连接判死之前就重连上了，旧连接到点不会顶掉新连接", async () => {
  const o = await owner();
  const stale = await live(o.local);
  freeze(stale);
  const fresh = await live(o.local);
  // 远程在旧连接停发之后才连上、一帧不发。它被判死时，旧连接的阈值早就到了。
  const { agent: clockwork } = await helloAgent(server.port, o.remote.computerId, o.remote.token);

  const changes = await untilStatus(o.push, o.remote.computerId, "sleeping");
  expect(
    changes.filter((change) => change.computerId === o.local.computerId && change.status === "sleeping"),
    "旧连接到点没把本机写成休眠",
  ).toEqual([]);
  expect(fresh.agent.socket.readyState).toBe(fresh.agent.socket.OPEN);
  expect(await computerStatus(o.local.computerId)).toBe("online");
  await say(o, "新连接在吗");
  expect((await fresh.agent.expect("prompt")).groupId).toBe(o.groupId);

  fresh.stop();
  fresh.agent.close();
  stale.agent.close();
  clockwork.close();
  o.push.close();
});
