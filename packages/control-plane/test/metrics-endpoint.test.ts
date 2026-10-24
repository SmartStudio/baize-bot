import { CreateBotResponse } from "@baize/shared";
import { afterEach, expect, it } from "vitest";
import { helloAgent } from "./helpers/agent.js";
import { startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { makeComputer, makeUser, PASSWORD } from "./helpers/fixtures.js";
import { scrapeMetrics } from "./helpers/metrics.js";
import { connectPush } from "./helpers/ws.js";

const METRICS_TOKEN = "metrics-token-for-tests";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function serve(metricsToken: string | null): Promise<{ server: TestServer; database: TestDb }> {
  const database = await createTestDb();
  cleanups.push(() => database.close());
  const server = await startTestServer(database.db, { metricsToken });
  cleanups.push(() => server.close());
  return { server, database };
}

function metrics(server: TestServer, authorization?: string): Promise<Response> {
  return fetch(`http://localhost:${server.server.port}/metrics`, {
    headers: authorization === undefined ? {} : { authorization },
  });
}

it("没设 METRICS_TOKEN 时 /metrics 当不存在，带什么 token 都回 404", async () => {
  const { server } = await serve(null);

  expect((await metrics(server)).status).toBe(404);
  expect((await metrics(server, `Bearer ${METRICS_TOKEN}`)).status).toBe(404);
});

it("设了 METRICS_TOKEN：不带或带错回 401，对了回 Prometheus 文本，在线电脑和 WebSocket 数对得上", async () => {
  const { server, database } = await serve(METRICS_TOKEN);

  expect((await metrics(server)).status).toBe(401);
  const wrong = await metrics(server, "Bearer not-the-token");
  expect(wrong.status).toBe(401);
  expect(await wrong.json()).toEqual({ error: "指标 token 不对" });

  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);
  cleanups.push(() => agent.close());
  const push = await connectPush(server.server.port, client.cookie ?? "");
  cleanups.push(() => push.close());

  const samples = await scrapeMetrics(server.server.port, METRICS_TOKEN);
  expect(Object.fromEntries(samples)).toEqual({
    baize_computers_online: 1,
    'baize_runs{state="running"}': 0,
    'baize_runs{state="unsettled"}': 0,
    'baize_runs{state="settled"}': 0,
    baize_continuation_backlog: 0,
    'baize_websocket_connections{kind="agent"}': 1,
    'baize_websocket_connections{kind="push"}': 1,
    'baize_websocket_connections{kind="live"}': 0,
  });
});

it("派出一个 run 记成 running，run_done 结完账挪到 settled", async () => {
  const { server, database } = await serve(METRICS_TOKEN);
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小数" })).json());
  const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);
  cleanups.push(() => agent.close());
  const runs = async () => {
    const samples = await scrapeMetrics(server.server.port, METRICS_TOKEN);
    return ["running", "unsettled", "settled"].map((state) => samples.get(`baize_runs{state="${state}"}`));
  };

  expect(await runs()).toEqual([0, 0, 0]);
  expect((await client.post(`/api/groups/${created.group.id}/messages`, { text: "数一下" })).status).toBe(201);
  const prompt = await agent.expect("prompt");
  expect(await runs(), "派出去还没收尾").toEqual([1, 0, 0]);

  agent.send({
    type: "run_done",
    runId: prompt.runId,
    botId: prompt.botId,
    groupId: prompt.groupId,
    steps: 1,
    inputTokens: 10,
    outputTokens: 5,
  });
  await agent.ack(prompt.runId);
  expect(await runs(), "收尾和结账在同一条报文里做完").toEqual([0, 0, 1]);
});
