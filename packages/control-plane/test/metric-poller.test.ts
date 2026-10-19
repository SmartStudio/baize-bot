import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  CreateBotResponse,
  CreateGroupResponse,
  GroupResponse,
  type AccountId,
  type Bot,
  type GroupId,
  type ServerPush,
  type TopicTask,
  type UserId,
} from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addAccountWithToken, CredentialCrypto } from "../src/credentials.js";
import { METRIC_WINDOW_MS } from "../src/metrics/poller.js";
import type { Db } from "../src/db/client.js";
import { DEFAULT_RUNTIME_CONFIG, startServer, type RunningServer } from "../src/server.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { ApiClient, TEST_CREDENTIALS_KEY } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { gatedDb } from "./helpers/gated-db.js";
import { PASSWORD, makeComputer, makeUser, waitFor, type TestComputer } from "./helpers/fixtures.js";
import { connectPush, type PushClient } from "./helpers/ws.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

type GithubRequest = { readonly path: string; readonly authorization: string | null };

/** 只认 GET /repos/:owner/:repo 的假 GitHub，星数由用例定。 */
type FakeGithub = {
  readonly baseUrl: string;
  readonly stars: Map<string, number>;
  requestsFor(repo: string): readonly GithubRequest[];
  /** 下一条读这个仓库的请求到了先挂着：arrived 在它到达时兑现，release 之后才回。 */
  hold(repo: string): { readonly arrived: Promise<void>; release(): void };
  close(): Promise<void>;
};

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let settle: (() => void) | undefined;
  const promise = new Promise<void>((done) => {
    settle = done;
  });
  return { promise, resolve: () => settle?.() };
}

type Hold = { readonly arrive: () => void; readonly released: Promise<void> };

async function startFakeGithub(): Promise<FakeGithub> {
  const stars = new Map<string, number>();
  const requests: GithubRequest[] = [];
  const holds = new Map<string, Hold>();
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? "/", "http://fake").pathname;
    requests.push({ path, authorization: req.headers.authorization ?? null });
    const repo = /^\/repos\/([^/]+\/[^/]+)$/.exec(path)?.[1];
    const held = repo === undefined ? undefined : holds.get(repo);
    if (repo !== undefined && held !== undefined) {
      holds.delete(repo);
      held.arrive();
      await held.released;
    }
    const count = repo === undefined ? undefined : stars.get(repo);
    res.writeHead(count === undefined ? 404 : 200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(count === undefined ? { message: "Not Found" } : { full_name: repo, stargazers_count: count }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stars,
    requestsFor: (repo) => requests.filter((request) => request.path === `/repos/${repo}`),
    hold: (repo) => {
      const released = deferred();
      const arrived = deferred();
      holds.set(repo, { arrive: arrived.resolve, released: released.promise });
      return { arrived: arrived.promise, release: released.resolve };
    },
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

let database: TestDb;
let github: FakeGithub;
const open: RunningServer[] = [];

beforeAll(async () => {
  database = await createTestDb();
  github = await startFakeGithub();
});

afterAll(async () => {
  for (const server of open) await server.close();
  await github.close();
  await database.close();
});

/** 时钟由用例拨。窗口按 6 小时对齐，从真实当前窗口的开头往后一分钟起步。 */
type Clock = { now: Date };

function windowClock(): Clock {
  const start = Math.floor(Date.now() / METRIC_WINDOW_MS) * METRIC_WINDOW_MS;
  return { now: new Date(start + 60_000) };
}

async function boot(clock: Clock, db: Db = database.db): Promise<RunningServer> {
  const server = await startServer({
    db,
    port: 0,
    hostname: "127.0.0.1",
    toolSecretKey: "a".repeat(64),
    credentialsKey: TEST_CREDENTIALS_KEY,
    config: { ...DEFAULT_RUNTIME_CONFIG, githubApiBaseUrl: github.baseUrl, xApiBaseUrl: "http://127.0.0.1:9/x" },
    publisher: { intervalMs: DAY_MS },
    // 只在用例手动 tick 时取样。
    metrics: { now: () => clock.now, intervalMs: DAY_MS },
  });
  open.push(server);
  return server;
}

async function shutdown(server: RunningServer): Promise<void> {
  open.splice(open.indexOf(server), 1);
  await server.close();
}

type Owner = {
  readonly userId: UserId;
  readonly client: ApiClient;
  readonly computer: TestComputer;
  readonly push: PushClient;
  readonly sales: Bot;
  readonly service: Bot;
  close(): void;
};

async function makeOwner(server: RunningServer): Promise<Owner> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = new ApiClient(server.port);
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const bot = async (name: string): Promise<Bot> => {
    const response = await client.post("/api/bots", { name, tags: ["推广"] });
    expect(response.status).toBe(201);
    return CreateBotResponse.parse(await response.json()).bot;
  };
  const sales = await bot("小销");
  const service = await bot("小服");
  const push = await connectPush(server.port, client.cookie ?? "");
  return { userId: user.id, client, computer, push, sales, service, close: () => push.close() };
}

async function makeProject(owner: Owner, title: string): Promise<{ groupId: GroupId; task: TopicTask }> {
  const response = await owner.client.post("/api/groups", { title, botIds: [owner.sales.id, owner.service.id] });
  expect(response.status).toBe(201);
  const created = CreateGroupResponse.parse(await response.json());
  return { groupId: created.group.id, task: created.task };
}

async function githubAccount(owner: Owner, token: string): Promise<AccountId> {
  const account = await addAccountWithToken(
    database.db,
    new CredentialCrypto(TEST_CREDENTIALS_KEY),
    {
      ownerId: owner.userId,
      computerId: owner.computer.computerId,
      platform: "github",
      via: "api",
      handle: "baize-dev",
    },
    token,
  );
  return account.id;
}

/** 建一个读 GitHub 星数的项目。PATCH 的那条 task_updated 在这里吃掉。 */
async function starsProject(
  owner: Owner,
  repo: string,
  token: string,
): Promise<{ groupId: GroupId; accountId: AccountId }> {
  const accountId = await githubAccount(owner, token);
  const { groupId, task } = await makeProject(owner, `推广 ${repo}`);
  const patched = await owner.client.patch(`/api/tasks/${task.id}`, {
    goal: { target: 1000, unit: "星", dueAt: null },
    metricSource: { kind: "github_stars", accountId, repo },
  });
  expect(patched.status).toBe(200);
  await nextOfType(owner.push, "task_updated");
  return { groupId, accountId };
}

async function nextOfType<T extends ServerPush["type"]>(push: PushClient, type: T) {
  for (let seen = 0; seen < 30; seen += 1) {
    const item = await push.next();
    if (item.type === type) return item as Extract<ServerPush, { type: T }>;
  }
  throw new Error(`等了 30 条推送都没有 ${type}`);
}

async function taskOf(client: ApiClient, groupId: GroupId): Promise<TopicTask> {
  return GroupResponse.parse(await (await client.get(`/api/groups/${groupId}`)).json()).task;
}

async function samplesOf(groupId: GroupId): Promise<{ value: string; source: string }[]> {
  return database.sql<{ value: string; source: string }[]>`
    SELECT value::text AS value, source FROM metric_samples WHERE group_id = ${groupId} ORDER BY sampled_at, id
  `;
}

/**
 * 本测试库里出现一个没拿到的 advisory 锁就回 true，等到 settled() 先成立就回 false。
 * pg_locks 是整个集群的，按库过滤，别的测试文件的库不算。
 */
async function lockWaiterAppears(settled: () => boolean): Promise<boolean> {
  for (;;) {
    if (settled()) return false;
    const [row] = await database.sql<{ waiting: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
      ) AS waiting`;
    if (row?.waiting === true) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * 屏障：手动记一个数，它的 task_updated 一定会推。前面的 tick 已经 await 完，
 * 它要是推过任何东西，都排在这条前面。返回屏障之前收到的推送。
 */
async function pushesBefore(owner: Owner, groupId: GroupId, marker: number): Promise<ServerPush[]> {
  expect((await owner.client.post(`/api/projects/${groupId}/metric`, { value: marker })).status).toBe(200);
  const before: ServerPush[] = [];
  for (;;) {
    const push = await owner.push.next();
    if (push.type === "task_updated" && push.task.groupId === groupId && push.task.metric?.current === marker) {
      return before;
    }
    before.push(push);
  }
}

describe("GitHub 星数轮询", () => {
  it("GitHub 星数按时读回写一条样本", async () => {
    const clock = windowClock();
    const server = await boot(clock);
    const owner = await makeOwner(server);
    try {
      const repo = "baize/stars-on-time";
      const { groupId } = await starsProject(owner, repo, "ghu_on_time");
      github.stars.set(repo, 412);

      await server.metrics.tick();
      const pushed = await nextOfType(owner.push, "task_updated");
      expect(pushed.task.groupId).toBe(groupId);
      expect(pushed.task.metric?.current, "推出去的任务卡带读回的星数").toBe(412);
      expect(pushed.task.goal, "取样不动目标").toEqual({ target: 1000, unit: "星", dueAt: null });
      expect(await samplesOf(groupId), "落一条 github_stars 样本").toEqual([{ value: "412", source: "github_stars" }]);
      expect(github.requestsFor(repo), "带着账号的令牌读仓库").toEqual([
        { path: `/repos/${repo}`, authorization: "Bearer ghu_on_time" },
      ]);
      expect((await taskOf(owner.client, groupId)).metric?.current).toBe(412);

      github.stars.set(repo, 420);
      clock.now = new Date(clock.now.getTime() + HOUR_MS);
      await server.metrics.tick();
      expect(github.requestsFor(repo), "同一个 6 小时窗口里不再读").toHaveLength(1);
      expect(await samplesOf(groupId)).toHaveLength(1);

      clock.now = new Date(Math.ceil(clock.now.getTime() / METRIC_WINDOW_MS) * METRIC_WINDOW_MS);
      await server.metrics.tick();
      const next = await nextOfType(owner.push, "task_updated");
      expect(next.task.metric?.current, "下一个窗口一开头就再读一次").toBe(420);
      expect(github.requestsFor(repo)).toHaveLength(2);
      expect(await samplesOf(groupId)).toEqual([
        { value: "412", source: "github_stars" },
        { value: "420", source: "github_stars" },
      ]);
    } finally {
      owner.close();
      await shutdown(server);
    }
  });

  it("账号过期时不写样本也不推通知", async () => {
    const clock = windowClock();
    const server = await boot(clock);
    const owner = await makeOwner(server);
    try {
      const repo = "baize/stars-expired";
      const { groupId, accountId } = await starsProject(owner, repo, "ghu_expired");
      github.stars.set(repo, 500);
      await database.sql`UPDATE accounts SET login = 'expired' WHERE id = ${accountId}`;

      await server.metrics.tick();
      const before = await pushesBefore(owner, groupId, 7);
      expect(before, "过期账号的项目这一轮什么都不推：没有 task_updated，没有通知").toEqual([]);
      expect(github.requestsFor(repo), "过期的账号不拿去读平台").toEqual([]);
      expect(
        (await samplesOf(groupId)).filter((sample) => sample.source === "github_stars"),
        "没有 github_stars 样本",
      ).toEqual([]);
    } finally {
      owner.close();
      await shutdown(server);
    }
  });

  it("控制面重启后 poller 不在同一窗口重复取样", async () => {
    const clock = windowClock();
    const first = await boot(clock);
    const owner = await makeOwner(first);
    const repo = "baize/stars-restart";
    let groupId: GroupId;
    try {
      ({ groupId } = await starsProject(owner, repo, "ghu_restart"));
      github.stars.set(repo, 100);
      await first.metrics.tick();
      expect(await samplesOf(groupId)).toEqual([{ value: "100", source: "github_stars" }]);
    } finally {
      owner.close();
      await shutdown(first);
    }

    clock.now = new Date(clock.now.getTime() + HOUR_MS);
    github.stars.set(repo, 130);
    const second = await boot(clock);
    try {
      await second.metrics.tick();
      expect(github.requestsFor(repo), "重启后同一窗口不再读平台").toHaveLength(1);
      expect(await samplesOf(groupId), "重启后同一窗口不多一条样本").toEqual([
        { value: "100", source: "github_stars" },
      ]);

      clock.now = new Date(Math.ceil(clock.now.getTime() / METRIC_WINDOW_MS) * METRIC_WINDOW_MS);
      await second.metrics.tick();
      expect(await samplesOf(groupId), "重启后的 poller 到下一个窗口照常取样").toEqual([
        { value: "100", source: "github_stars" },
        { value: "130", source: "github_stars" },
      ]);
    } finally {
      await shutdown(second);
    }
  });

  it("两个控制面的取样在同一窗口重叠时只落一条", async () => {
    const clock = windowClock();
    const first = await boot(clock);
    const second = await boot(clock);
    const owner = await makeOwner(first);
    try {
      const repo = "baize/stars-overlap";
      const { groupId } = await starsProject(owner, repo, "ghu_overlap");
      github.stars.set(repo, 200);

      const held = github.hold(repo);
      const slow = first.metrics.tick();
      await held.arrived;
      await second.metrics.tick();
      expect(await samplesOf(groupId), "后起的那一轮先落了样本").toEqual([{ value: "200", source: "github_stars" }]);

      github.stars.set(repo, 201);
      held.release();
      await slow;
      expect(github.requestsFor(repo), "两边都读过平台").toHaveLength(2);
      expect(await samplesOf(groupId), "先起的那一轮读完时这一格已经有样本，不再落").toEqual([
        { value: "200", source: "github_stars" },
      ]);
    } finally {
      owner.close();
      await shutdown(first);
      await shutdown(second);
    }
  });

  it("同一格两笔取样交错提交：先插的没提交时后到的等锁，先插的提交后后到的不落第二条", async () => {
    const gate = gatedDb(database.sql);
    const clock = windowClock();
    const first = await boot(clock, gate.db);
    const second = await boot(clock);
    const owner = await makeOwner(first);
    const held = gate.arm(/^insert into "metric_samples"/, "after");
    try {
      const repo = "baize/stars-interleave";
      const { groupId } = await starsProject(owner, repo, "ghu_interleave");
      github.stars.set(repo, 300);

      const slow = first.metrics.tick();
      await held.reached;
      github.stars.set(repo, 301);
      let fastSettled = false;
      const fast = second.metrics.tick().finally(() => {
        fastSettled = true;
      });
      const waited = await lockWaiterAppears(() => fastSettled);
      held.release();
      await slow;
      await fast;

      expect(github.requestsFor(repo), "两边都读过平台").toHaveLength(2);
      expect(await samplesOf(groupId), "先插的那条提交之后，后到的那条看得见它，不再落").toEqual([
        { value: "300", source: "github_stars" },
      ]);
      expect(waited, "先插的还没提交时，后到的那笔写停在锁上").toBe(true);
    } finally {
      held.release();
      owner.close();
      await shutdown(first);
      await shutdown(second);
    }
  });

  it("读平台期间项目标成 done，读回的星数不落样本", async () => {
    const clock = windowClock();
    const server = await boot(clock);
    const owner = await makeOwner(server);
    try {
      const repo = "baize/stars-done-midway";
      const { groupId } = await starsProject(owner, repo, "ghu_done_midway");
      github.stars.set(repo, 600);
      const taskId = (await taskOf(owner.client, groupId)).id;

      const held = github.hold(repo);
      const ticking = server.metrics.tick();
      await held.arrived;
      expect((await owner.client.patch(`/api/tasks/${taskId}`, { status: "done" })).status).toBe(200);
      held.release();
      await ticking;

      expect(github.requestsFor(repo), "读已经发出去了").toHaveLength(1);
      expect(
        (await samplesOf(groupId)).filter((sample) => sample.source === "github_stars"),
        "写入时项目已经 done，不落",
      ).toEqual([]);
    } finally {
      owner.close();
      await shutdown(server);
    }
  });
});

/** resolveRun 里 runBelongsTo 那条：带 computer_id。停在它交回结果之前，就是「归属已校验、还没写」。 */
const RUN_BELONGS_TO = /^select "id" from "runs" where .*"computer_id"/;

const withMetric = (pushes: readonly ServerPush[]) =>
  pushes.filter((push) => push.type === "task_updated" && push.task.metric !== null);

describe("Bot 报数", () => {
  it("metric_report 带别的群的 runId 静默丢弃", async () => {
    const server = await boot(windowClock());
    const owner = await makeOwner(server);
    let agent: AgentClient | null = null;
    try {
      const a = await makeProject(owner, "推广白泽");
      const b = await makeProject(owner, "推广小红书");
      ({ agent } = await helloAgent(server.port, owner.computer.computerId, owner.computer.token));

      expect((await owner.client.post(`/api/groups/${a.groupId}/messages`, { text: "@小销 读一下星数" })).status).toBe(
        201,
      );
      const prompt = await agent.expect("prompt");
      expect(prompt.groupId).toBe(a.groupId);
      const report = { type: "metric_report", runId: prompt.runId, botId: prompt.botId, label: "星数" } as const;

      agent.send({ ...report, groupId: b.groupId, value: 999 });
      agent.send({ ...report, groupId: a.groupId, value: 412 });

      // 派活换当前经手也推 task_updated，那几条不带数，跳过。
      let updated = await nextOfType(owner.push, "task_updated");
      while (updated.task.metric === null) updated = await nextOfType(owner.push, "task_updated");
      expect(updated.task.groupId, "第一条带数的 task_updated 是本群的，别的群那条没落").toBe(a.groupId);
      expect(updated.task.metric?.current).toBe(412);
      expect(await samplesOf(a.groupId)).toEqual([{ value: "412", source: "reported" }]);
      expect(await samplesOf(b.groupId), "别的群一条样本都没有").toEqual([]);
      expect((await taskOf(owner.client, b.groupId)).metric).toBeNull();
    } finally {
      agent?.close();
      owner.close();
      await shutdown(server);
    }
  });

  it("已收尾的 run 晚到的 metric_report 不落样本", async () => {
    const server = await boot(windowClock());
    const owner = await makeOwner(server);
    let agent: AgentClient | null = null;
    try {
      const { groupId } = await makeProject(owner, "推广白泽");
      ({ agent } = await helloAgent(server.port, owner.computer.computerId, owner.computer.token));
      expect((await owner.client.post(`/api/groups/${groupId}/messages`, { text: "@小销 读一下星数" })).status).toBe(
        201,
      );
      const prompt = await agent.expect("prompt");
      const run = { runId: prompt.runId, botId: prompt.botId, groupId } as const;
      const done = { type: "run_done", ...run, steps: 1, inputTokens: 0, outputTokens: 0 } as const;

      agent.send(done);
      await agent.ack(prompt.runId, 1);
      agent.send({ type: "metric_report", ...run, value: 999, label: "星数" });
      // 第二条 run_done 排在报数后面，它的确认回来时报数已经处理完。
      agent.send(done);
      await agent.ack(prompt.runId, 2);

      expect(await samplesOf(groupId), "收尾之后的报数不落样本").toEqual([]);
      expect(withMetric(await pushesBefore(owner, groupId, 5)), "收尾之后的报数不推任务卡").toEqual([]);
    } finally {
      agent?.close();
      owner.close();
      await shutdown(server);
    }
  });

  it("可靠报数未提交时新控制面的握手等待，报数先落地再收尾，旧连接续帧不落样本", async () => {
    // 两台控制面连同一个库，像滚动重启时新旧进程并存。同一台里报文和收尾排在同一条链上，排不出这种交错。
    const gate = gatedDb(database.sql);
    const clock = windowClock();
    const serverA = await boot(clock, gate.db);
    const serverB = await boot(clock);
    const owner = await makeOwner(serverA);
    let agent: AgentClient | null = null;
    let elsewhere: AgentClient | null = null;
    let held: ReturnType<typeof gate.arm> | undefined;
    try {
      const { groupId } = await makeProject(owner, "推广白泽");
      ({ agent } = await helloAgent(serverA.port, owner.computer.computerId, owner.computer.token));
      expect((await owner.client.post(`/api/groups/${groupId}/messages`, { text: "@小销 读一下星数" })).status).toBe(
        201,
      );
      const prompt = await agent.expect("prompt");
      const run = { runId: prompt.runId, botId: prompt.botId, groupId } as const;
      const done = { type: "run_done", ...run, steps: 1, inputTokens: 0, outputTokens: 0 } as const;

      held = gate.arm(RUN_BELONGS_TO, "after");
      agent.send({ type: "metric_report", ...run, value: 999, label: "星数" });
      await held.reached;
      const reconnecting = helloAgent(serverB.port, owner.computer.computerId, owner.computer.token, [prompt.runId]);
      await waitFor(async () => {
        const [row] = await database.sql<
          { n: number }[]
        >`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=${database.databaseName} AND wait_event_type='Lock'`;
        return (row?.n ?? 0) > 0;
      }, "新 hello 等可靠报数事务提交");
      expect(await samplesOf(groupId)).toEqual([]);
      held.release();
      ({ agent: elsewhere } = await reconnecting);
      elsewhere.send(done);
      await elsewhere.ack(prompt.runId, 1);
      expect(await samplesOf(groupId)).toHaveLength(1);
      agent.send({ type: "metric_report", ...run, value: 1000, label: "旧代际" });
      elsewhere.send({ type: "metric_report", ...run, value: 1001, label: "收尾后" });
      await waitFor(
        async () =>
          elsewhere?.uplinkAcks().some((ack) => ack.rejected.some((item) => item.code === "run_closed")) === true,
        "收尾后报数拒收",
      );
      expect(await samplesOf(groupId)).toHaveLength(1);
      expect(agent.uplinkAcks().flatMap((ack) => ack.rejected)).toEqual([]);
    } finally {
      held?.release();
      elsewhere?.close();
      agent?.close();
      owner.close();
      await shutdown(serverB);
      await shutdown(serverA);
    }
  });
});
