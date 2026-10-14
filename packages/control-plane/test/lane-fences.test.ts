import { randomUUID } from "node:crypto";
import {
  ComputerTokenResponse,
  CreateBotResponse,
  HubLaneSnapshot,
  ToolResponse,
  type BotId,
  type GroupId,
  type ToolConnectionId,
} from "@baize/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { startTestServer, type ApiClient, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { makeComputer, makeUser, PASSWORD, type TestComputer } from "./helpers/fixtures.js";
import { startTestMcp, type TestMcp } from "./helpers/mcp.js";
import { startUpstream, type FakeUpstream } from "./helpers/upstream.js";

let database: TestDb;
let server: TestServer;
let upstream: FakeUpstream;
let mcp: TestMcp;
let agents: AgentClient[] = [];

beforeAll(async () => {
  database = await createTestDb();
  upstream = await startUpstream({ json: { id: "chatcmpl-fence", model: "fence-model", choices: [] } });
  mcp = await startTestMcp();
  server = await startTestServer(database.db, {
    upstreamBaseUrl: upstream.baseUrl,
    upstreamApiKey: "fence-upstream-key",
    gatewayModels: { plan: "fence-model", fast: "fence-fast" },
  });
});

afterEach(async () => {
  for (const agent of agents) agent.close();
  await Promise.all(agents.map((agent) => agent.closed()));
  agents = [];
});

afterAll(async () => {
  await server.close();
  await upstream.close();
  await mcp.close();
  await database.close();
});

const ENDPOINTS = ["gateway", "mcp", "hub"] as const;
type Endpoint = (typeof ENDPOINTS)[number];
type Fixture = {
  readonly client: ApiClient;
  readonly local: TestComputer;
  readonly holder: AgentClient;
  readonly holderKey: string;
  readonly otherKey: string;
  readonly botId: BotId;
  readonly groupId: GroupId;
  readonly epoch: number;
  readonly header: string;
  readonly peer: ReturnType<typeof CreateBotResponse.parse>;
  readonly toolId: ToolConnectionId;
};

async function settle(agent: AgentClient, prompt: Awaited<ReturnType<AgentClient["expect"]>>): Promise<void> {
  if (prompt.type !== "prompt") throw new Error("应当收到 prompt");
  agent.send({
    type: "run_done",
    runId: prompt.runId,
    botId: prompt.botId,
    groupId: prompt.groupId,
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
  });
  await agent.ack(prompt.runId);
}

async function fixture(): Promise<Fixture> {
  const user = await makeUser(database.db);
  const local = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const remote = ComputerTokenResponse.parse(await (await client.post("/api/computers/remote")).json());
  const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "栅栏测试" })).json());
  const peer = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "同账号队友" })).json());
  const tool = ToolResponse.parse(
    await (await client.post("/api/tools", { name: "栅栏插件", url: mcp.url, authorization: "fence-mcp-key" })).json(),
  ).tool;
  expect((await client.patch(`/api/tools/${tool.id}`, { assignedBotIds: [created.bot.id, peer.bot.id] })).status).toBe(
    200,
  );
  const connected = await helloAgent(server.server.port, local.computerId, local.token);
  agents.push(connected.agent);
  const other = await helloAgent(server.server.port, remote.computerId, remote.token);
  agents.push(other.agent);
  expect((await client.post(`/api/groups/${created.group.id}/messages`, { text: "认领调用道" })).status).toBe(201);
  const prompt = await connected.agent.expect("prompt");
  expect(prompt.botId).toBe(created.bot.id);
  await settle(connected.agent, prompt);
  return {
    client,
    local,
    holder: connected.agent,
    holderKey: connected.config.modelGateway.apiKey,
    otherKey: other.config.modelGateway.apiKey,
    botId: created.bot.id,
    groupId: created.group.id,
    epoch: prompt.lane.epoch,
    header: `${created.bot.id}/${created.group.id}/${prompt.lane.epoch}`,
    peer,
    toolId: tool.id,
  };
}

function request(
  who: Fixture,
  endpoint: Endpoint,
  options: {
    readonly key?: string | null;
    readonly header?: string | null;
    readonly botId?: BotId;
    readonly cookie?: string;
  } = {},
): Promise<Response> {
  const key = options.key === undefined ? who.holderKey : options.key;
  const header = options.header === undefined ? who.header : options.header;
  const headers: Record<string, string> = {};
  if (key !== null) headers["authorization"] = `Bearer ${key}`;
  if (header !== null) headers["x-baize-lane"] = header;
  if (options.cookie !== undefined) headers["cookie"] = options.cookie;
  if (endpoint === "hub")
    return fetch(`${who.client.origin}/hub/v1/lanes/${who.botId}/${who.groupId}/chat`, { headers });
  headers["content-type"] = "application/json";
  const path = endpoint === "gateway" ? "/gateway/v1/chat/completions" : `/mcp-proxy/${who.toolId}/call`;
  const body =
    endpoint === "gateway"
      ? { model: "baize:plan", messages: [{ role: "user", content: "只用假的上游" }] }
      : { botId: options.botId ?? who.botId, tool: "lookup_stock", arguments: { sku: "X3" } };
  return fetch(`${who.client.origin}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

const FAILURES = [
  { kind: "stale_epoch", text: "代际过时" },
  { kind: "not_holder", text: "不是持有者" },
  { kind: "expired", text: "租约已过期" },
  { kind: "missing", text: "缺少或格式不对" },
] as const;

describe.each(ENDPOINTS)("%s 的道栅栏", (endpoint) => {
  it("持有者的当前代际可以访问", async () => {
    const who = await fixture();
    const modelCalls = upstream.calls.length;
    const toolCalls = mcp.calls().length;
    const response = await request(who, endpoint);
    expect(response.status).toBe(200);
    if (endpoint === "hub") {
      expect(HubLaneSnapshot.parse(await response.json())).toEqual({
        entries: [],
        nextSeq: 0,
        head: "0".repeat(64),
        piSessionVersion: null,
      });
    } else await response.json();
    expect(upstream.calls.length).toBe(modelCalls + (endpoint === "gateway" ? 1 : 0));
    expect(mcp.calls().length).toBe(toolCalls + (endpoint === "mcp" ? 1 : 0));
  });

  it.each(FAILURES)("$kind 回 409 和固定中文分类，不触达上游", async ({ kind, text }) => {
    const who = await fixture();
    if (kind === "stale_epoch")
      await database.sql`UPDATE lane_leases SET epoch = epoch + 1 WHERE bot_id = ${who.botId} AND group_id = ${who.groupId}`;
    if (kind === "expired")
      await database.sql`UPDATE computers SET lease_until = clock_timestamp() - interval '1 second' WHERE id = ${who.local.computerId}`;
    const modelCalls = upstream.calls.length;
    const toolCalls = mcp.calls().length;
    const response = await request(who, endpoint, {
      key: kind === "not_holder" ? who.otherKey : who.holderKey,
      header: kind === "missing" ? null : who.header,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: text });
    expect(upstream.calls).toHaveLength(modelCalls);
    expect(mcp.calls()).toHaveLength(toolCalls);
  });

  it("格式不对的头回 409，不触达上游", async () => {
    const who = await fixture();
    const modelCalls = upstream.calls.length;
    const toolCalls = mcp.calls().length;
    const response = await request(who, endpoint, { header: `${who.botId}/${who.groupId}/0` });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "缺少或格式不对" });
    expect(upstream.calls).toHaveLength(modelCalls);
    expect(mcp.calls()).toHaveLength(toolCalls);
  });

  it("安装标识已更换时旧道回不是持有者", async () => {
    const who = await fixture();
    await database.sql`UPDATE computers SET install_id = ${randomUUID()} WHERE id = ${who.local.computerId}`;
    const modelCalls = upstream.calls.length;
    const toolCalls = mcp.calls().length;
    const response = await request(who, endpoint);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "不是持有者" });
    expect(upstream.calls).toHaveLength(modelCalls);
    expect(mcp.calls()).toHaveLength(toolCalls);
  });

  it("只有登录 cookie 和正确道头仍回 401", async () => {
    const who = await fixture();
    expect(who.client.cookie).not.toBeNull();
    const modelCalls = upstream.calls.length;
    const toolCalls = mcp.calls().length;
    const response = await request(who, endpoint, { key: null, cookie: who.client.cookie ?? "" });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "网关 key 不对，换一把再来" });
    expect(upstream.calls).toHaveLength(modelCalls);
    expect(mcp.calls()).toHaveLength(toolCalls);
  });
});

it("GET /models 也要求道头", async () => {
  const who = await fixture();
  const response = await fetch(`${who.client.origin}/gateway/v1/models`, {
    headers: { authorization: `Bearer ${who.holderKey}` },
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "缺少或格式不对" });
});

it("MCP 即使分配给同账号的两个 Bot，也不能借另一 Bot 的道头调用", async () => {
  const who = await fixture();
  expect((await who.client.post(`/api/groups/${who.peer.group.id}/messages`, { text: "认领队友调用道" })).status).toBe(
    201,
  );
  const peerPrompt = await who.holder.expect("prompt");
  expect(peerPrompt.botId).toBe(who.peer.bot.id);
  await settle(who.holder, peerPrompt);
  const allowed = await request(who, "mcp", {
    botId: who.peer.bot.id,
    header: `${peerPrompt.botId}/${peerPrompt.groupId}/${peerPrompt.lane.epoch}`,
  });
  expect(allowed.status).toBe(200);
  await allowed.json();
  const modelCalls = upstream.calls.length;
  const toolCalls = mcp.calls().length;
  const denied = await request(who, "mcp", { botId: who.peer.bot.id });
  expect(denied.status).toBe(404);
  expect(await denied.json()).toEqual({ error: "没有分配给这个 Bot 的插件" });
  expect(upstream.calls).toHaveLength(modelCalls);
  expect(mcp.calls()).toHaveLength(toolCalls);
});
