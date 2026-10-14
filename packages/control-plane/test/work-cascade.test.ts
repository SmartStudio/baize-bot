import { createHash, randomUUID } from "node:crypto";
import {
  AttachmentUploadResponse,
  ComputerTokenResponse,
  CreateBotResponse,
  CreateGroupResponse,
  EMPTY_WORK_HEAD,
  UplinkAck,
  advanceWorkHead,
  type BotId,
  type GroupId,
} from "@baize/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { RawData } from "ws";
import { openAgent, sendHello, type AgentClient } from "./helpers/agent.js";
import { startTestServer, type ApiClient, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { makeComputer, makeUser, PASSWORD, type TestComputer } from "./helpers/fixtures.js";

let database: TestDb;
let server: TestServer;
const agents: AgentClient[] = [];
const IMAGE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1EAAAAASUVORK5CYII=",
  "base64",
);

beforeAll(async () => {
  database = await createTestDb();
  server = await startTestServer(database.db);
});

afterEach(async () => {
  const closing = agents.splice(0);
  for (const agent of closing) agent.close();
  await Promise.all(closing.map((agent) => agent.closed()));
});

afterAll(async () => {
  await server.close();
  await database.close();
});

type Person = { readonly id: string; readonly email: string };
type BotGroup = { readonly botId: BotId; readonly groupId: GroupId };
type OnlineAgent = { readonly agent: AgentClient; readonly computer: TestComputer; readonly key: string };
type Prompt = Extract<import("@baize/shared").ControlToAgent, { type: "prompt" }>;

async function login(name: string): Promise<{ user: Person; client: ApiClient; computer: TestComputer }> {
  const user = await makeUser(database.db, name);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  return { user, client, computer };
}

async function newBot(client: ApiClient, name: string): Promise<BotGroup> {
  const response = await client.post("/api/bots", { name });
  expect(response.status).toBe(201);
  const { bot, group } = CreateBotResponse.parse(await response.json());
  return { botId: bot.id, groupId: group.id };
}

async function online(computer: TestComputer): Promise<OnlineAgent> {
  const agent = await openAgent(server.server.port, { ackDownlink: false });
  agents.push(agent);
  sendHello(agent, computer.computerId, computer.token);
  const { config } = await importHello(agent);
  return { agent, computer, key: config.modelGateway.apiKey };
}

async function importHello(agent: AgentClient) {
  const welcome = await agent.expect("welcome");
  const config = await agent.expect("config");
  for (const bot of config.bots) {
    const state = await agent.next();
    expect(["pause", "resume"]).toContain(state.type);
    expect(state.type === "pause" || state.type === "resume" ? state.botId : null).toBe(bot.id);
  }
  return { welcome, config };
}

async function postPrompt(client: ApiClient, groupId: GroupId, text: string, agent: AgentClient): Promise<Prompt> {
  const response = await client.post(`/api/groups/${groupId}/messages`, { text });
  expect(response.status, await response.clone().text()).toBe(201);
  const prompt = await agent.expect("prompt");
  expect(prompt.text).toBe(text);
  return prompt;
}

async function appendRecord(agent: AgentClient, prompt: Prompt): Promise<void> {
  const entryId = randomUUID();
  const lines = [
    JSON.stringify({
      type: "message",
      id: entryId,
      parentId: null,
      message: { role: "assistant", content: [{ type: "text", text: "已完成的工作" }] },
    }),
  ];
  const seq = agent.sendMalformedReliable({
    type: "work_append",
    lane: { botId: prompt.botId, groupId: prompt.groupId, stream: "chat", epoch: prompt.lane.epoch },
    runId: prompt.runId,
    fromSeq: 0,
    lines,
    head: await advanceWorkHead(EMPTY_WORK_HEAD, lines),
    cause: "turn_end",
  });
  const ack = await uplinkAck(agent, seq);
  expect(ack.rejected, "工作记录经可靠上行确认").toEqual([]);
}

async function uplinkAck(agent: AgentClient, seq: number): Promise<UplinkAck> {
  const existing = agent.uplinkAcks().find((ack) => ack.upTo >= seq);
  if (existing !== undefined) return existing;
  return new Promise((resolve, reject) => {
    const onMessage = (raw: RawData) => {
      const value: unknown = JSON.parse(raw.toString());
      if (typeof value !== "object" || value === null || !("type" in value) || value.type !== "uplink_ack") return;
      const ack = UplinkAck.parse(value);
      if (ack.upTo < seq) return;
      clearTimeout(timer);
      agent.socket.off("message", onMessage);
      resolve(ack);
    };
    const timer = setTimeout(() => {
      agent.socket.off("message", onMessage);
      reject(new Error(`等工作记录上行 ${seq} 确认超时`));
    }, 5000);
    agent.socket.on("message", onMessage);
  });
}

async function upload(agent: OnlineAgent, botId: BotId, groupId: GroupId) {
  const query = new URLSearchParams({ botId, groupId });
  const response = await fetch(`http://localhost:${server.server.port}/hub/v1/attachments?${query}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${agent.key}`,
      "content-type": "image/png",
      "x-baize-sha256": createHash("sha256").update(IMAGE).digest("hex"),
    },
    body: new Uint8Array(IMAGE),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return AttachmentUploadResponse.parse(await response.json());
}

async function recordCounts(botId: BotId, groupId: GroupId) {
  const [counts] = await database.sql<{ leases: number; streams: number; entries: number; attachments: number }[]>`
    SELECT
      (SELECT count(*)::int FROM lane_leases WHERE bot_id = ${botId} AND group_id = ${groupId}) AS leases,
      (SELECT count(*)::int FROM work_streams WHERE bot_id = ${botId} AND group_id = ${groupId}) AS streams,
      (SELECT count(*)::int FROM work_entries WHERE bot_id = ${botId} AND group_id = ${groupId}) AS entries,
      (SELECT count(*)::int FROM attachments WHERE bot_id = ${botId} AND group_id = ${groupId}) AS attachments
  `;
  if (counts === undefined) throw new Error("道级联计数查询没有返回");
  return counts;
}

async function expectLaneCancel(agent: AgentClient, botId: BotId, groupId: GroupId, epoch: number): Promise<void> {
  for (;;) {
    const message = await agent.next();
    if (message.type !== "cancel" || message.lane?.botId !== botId || message.lane.groupId !== groupId) continue;
    expect(message).toEqual({ type: "cancel", lane: { botId, groupId }, epoch });
    return;
  }
}

async function cancelCount(computerId: string, botId: BotId, groupId: GroupId): Promise<number> {
  const rows = await database.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM agent_outbox WHERE computer_id = ${computerId}
      AND body->>'type' = 'cancel' AND body->'lane'->>'botId' = ${botId}
      AND body->'lane'->>'groupId' = ${groupId}
  `;
  return rows[0]?.n ?? 0;
}

describe("工作记录和附件级联删除验收", () => {
  it("删 Bot 清单聊道和多 Bot 群里的目标道，保留队友数据且重复删除不重复取消", async () => {
    const { client, computer } = await login("级联 Bot 所有人");
    const target = await newBot(client, "待删");
    const peer = await newBot(client, "群友");
    const grouped = await client.post("/api/groups", { title: "多人工作群", botIds: [target.botId, peer.botId] });
    expect(grouped.status).toBe(201);
    const groupId = CreateGroupResponse.parse(await grouped.json()).group.id;
    const local = await online(computer);

    const soloPrompt = await postPrompt(client, target.groupId, "单聊里的工作", local.agent);
    await appendRecord(local.agent, soloPrompt);
    const targetPrompt = await postPrompt(client, groupId, "@待删 这项由待删负责", local.agent);
    await appendRecord(local.agent, targetPrompt);
    local.agent.send({
      type: "run_done",
      runId: targetPrompt.runId,
      botId: target.botId,
      groupId,
      steps: 1,
      inputTokens: 1,
      outputTokens: 1,
    });
    await local.agent.ack(targetPrompt.runId);
    const peerPrompt = await postPrompt(client, groupId, "@群友 这项留给队友", local.agent);
    await appendRecord(local.agent, peerPrompt);
    const soloAttachment = await upload(local, target.botId, target.groupId);
    const targetAttachment = await upload(local, target.botId, groupId);
    const peerAttachment = await upload(local, peer.botId, groupId);

    expect(await recordCounts(target.botId, target.groupId)).toEqual({
      leases: 1,
      streams: 1,
      entries: 1,
      attachments: 1,
    });
    expect(await recordCounts(target.botId, groupId)).toEqual({ leases: 1, streams: 1, entries: 1, attachments: 1 });
    expect(await recordCounts(peer.botId, groupId)).toEqual({ leases: 1, streams: 1, entries: 1, attachments: 1 });
    expect((await client.delete(`/api/groups/${groupId}`)).status, "群没有删除入口").toBe(404);

    const soloEpoch = soloPrompt.lane.epoch;
    const targetEpoch = targetPrompt.lane.epoch;
    expect((await client.delete(`/api/bots/${target.botId}`)).status).toBe(204);
    const cancels = [];
    while (cancels.length < 2) {
      const message = await local.agent.next();
      if (message.type === "cancel" && message.lane?.botId === target.botId) cancels.push(message);
    }
    expect(cancels).toEqual(
      expect.arrayContaining([
        { type: "cancel", lane: { botId: target.botId, groupId: target.groupId }, epoch: soloEpoch + 1 },
        { type: "cancel", lane: { botId: target.botId, groupId }, epoch: targetEpoch + 1 },
      ]),
    );
    expect(await recordCounts(target.botId, target.groupId)).toEqual({
      leases: 0,
      streams: 0,
      entries: 0,
      attachments: 0,
    });
    expect(await recordCounts(target.botId, groupId)).toEqual({ leases: 0, streams: 0, entries: 0, attachments: 0 });
    expect(await recordCounts(peer.botId, groupId)).toEqual({ leases: 1, streams: 1, entries: 1, attachments: 1 });
    expect((await client.get(`/api/groups/${groupId}`)).status).toBe(200);
    expect(await database.sql`SELECT 1 FROM bots WHERE id = ${peer.botId}`).toHaveLength(1);
    expect(
      (
        await fetch(`${client.origin}/hub/v1/attachments/${peerAttachment.attachmentId}`, {
          headers: { authorization: `Bearer ${local.key}` },
        })
      ).status,
    ).toBe(200);

    const before = await Promise.all([
      cancelCount(computer.computerId, target.botId, target.groupId),
      cancelCount(computer.computerId, target.botId, groupId),
    ]);
    expect(before).toEqual([1, 1]);
    expect((await client.delete(`/api/bots/${target.botId}`)).status).toBe(404);
    expect(
      await Promise.all([
        cancelCount(computer.computerId, target.botId, target.groupId),
        cancelCount(computer.computerId, target.botId, groupId),
      ]),
    ).toEqual(before);
    expect(soloAttachment.attachmentId).not.toBe(targetAttachment.attachmentId);
  });

  it("确认邮箱删号取消两台电脑的持有道，清空级联数据并拒绝旧 token", async () => {
    const { user, client, computer: firstComputer } = await login("删号数据所有人");
    const firstBot = await newBot(client, "第一台电脑的 Bot");
    const secondBot = await newBot(client, "第二台电脑的 Bot");
    const secondResponse = await client.post("/api/computers/remote");
    expect(secondResponse.status).toBe(200);
    const secondToken = ComputerTokenResponse.parse(await secondResponse.json());

    const first = await online(firstComputer);
    const firstPrompt = await postPrompt(client, firstBot.groupId, "第一台电脑的工作", first.agent);
    await appendRecord(first.agent, firstPrompt);
    const [queued] = await database.sql<{ down_seq: number }[]>`
      UPDATE computers SET down_seq = down_seq + 1 WHERE id = ${firstComputer.computerId} RETURNING down_seq
    `;
    if (queued === undefined) throw new Error("待投递任务没有取得下行序号");
    await database.sql`
      INSERT INTO agent_outbox (computer_id, seq, body, run_id)
      VALUES (${firstComputer.computerId}, ${queued.down_seq},
        ${JSON.stringify({ ...firstPrompt, text: "未投递的旧任务" })}::jsonb, ${firstPrompt.runId})
    `;
    const pendingPrompt = await database.sql<{ text: string }[]>`
      SELECT body->>'text' AS text FROM agent_outbox
      WHERE computer_id = ${firstComputer.computerId} AND seq = ${queued.down_seq}
    `;
    expect(pendingPrompt, "发件箱确实含有尚未投递的旧任务").toEqual([{ text: "未投递的旧任务" }]);
    const second = await online({ computerId: secondToken.computerId, token: secondToken.token });
    await database.sql`UPDATE computers SET lease_until = now() - interval '1 second' WHERE id = ${firstComputer.computerId}`;
    const secondPrompt = await postPrompt(client, secondBot.groupId, "第二台电脑的工作", second.agent);
    await appendRecord(second.agent, secondPrompt);
    await upload(first, firstBot.botId, firstBot.groupId);
    await upload(second, secondBot.botId, secondBot.groupId);

    expect(await recordCounts(firstBot.botId, firstBot.groupId)).toEqual({
      leases: 1,
      streams: 1,
      entries: 1,
      attachments: 1,
    });
    expect(await recordCounts(secondBot.botId, secondBot.groupId)).toEqual({
      leases: 1,
      streams: 1,
      entries: 1,
      attachments: 1,
    });
    const outbox = await database.sql<{ computer_id: string; n: number }[]>`
      SELECT computer_id, count(*)::int AS n FROM agent_outbox
      WHERE computer_id IN (${firstComputer.computerId}, ${secondToken.computerId}) GROUP BY computer_id ORDER BY computer_id
    `;
    expect(outbox.map((row) => row.computer_id).toSorted()).toEqual(
      [firstComputer.computerId, secondToken.computerId].toSorted(),
    );
    expect(
      outbox.every((row) => row.n > 0),
      "两台电脑都有未 ACK 发件箱报文",
    ).toBe(true);

    const bystander = await login("删号旁观者");
    const bystanderBot = await newBot(bystander.client, "保留的 Bot");
    const bystanderAgent = await online(bystander.computer);
    const bystanderPrompt = await postPrompt(
      bystander.client,
      bystanderBot.groupId,
      "旁观者保留的工作",
      bystanderAgent.agent,
    );
    await appendRecord(bystanderAgent.agent, bystanderPrompt);
    await upload(bystanderAgent, bystanderBot.botId, bystanderBot.groupId);
    const beforeBystander = await recordCounts(bystanderBot.botId, bystanderBot.groupId);

    const deletion = await client.request("DELETE", "/api/me", { email: user.email });
    expect(deletion.status, await deletion.clone().text()).toBe(204);
    expect(await first.agent.closed()).toBe(4002);
    expect(await second.agent.closed()).toBe(4002);
    expect(
      first.agent.received().filter((message) => message.type === "prompt"),
      "删号后不再投递未发出的任务",
    ).toEqual([]);
    await expectLaneCancel(first.agent, firstBot.botId, firstBot.groupId, firstPrompt.lane.epoch + 1);
    await expectLaneCancel(second.agent, secondBot.botId, secondBot.groupId, secondPrompt.lane.epoch + 1);

    const left = await database.sql<
      { leases: number; streams: number; entries: number; attachments: number; outbox: number }[]
    >`
      SELECT
        (SELECT count(*)::int FROM lane_leases WHERE bot_id IN (${firstBot.botId}, ${secondBot.botId})) AS leases,
        (SELECT count(*)::int FROM work_streams WHERE bot_id IN (${firstBot.botId}, ${secondBot.botId})) AS streams,
        (SELECT count(*)::int FROM work_entries WHERE bot_id IN (${firstBot.botId}, ${secondBot.botId})) AS entries,
        (SELECT count(*)::int FROM attachments WHERE owner_id = ${user.id}) AS attachments,
        (SELECT count(*)::int FROM agent_outbox WHERE computer_id IN (${firstComputer.computerId}, ${secondToken.computerId})) AS outbox
    `;
    expect(left[0]).toEqual({ leases: 0, streams: 0, entries: 0, attachments: 0, outbox: 0 });
    expect(await recordCounts(bystanderBot.botId, bystanderBot.groupId)).toEqual(beforeBystander);
    expect((await bystander.client.get(`/api/groups/${bystanderBot.groupId}`)).status).toBe(200);
    expect(await database.sql`SELECT 1 FROM bots WHERE id = ${bystanderBot.botId}`).toHaveLength(1);
    expect((await bystander.client.get("/api/me")).status).toBe(200);

    const reconnect = await openAgent(server.server.port);
    agents.push(reconnect);
    sendHello(reconnect, firstComputer.computerId, firstComputer.token);
    expect(await reconnect.closed()).toBe(4001);
  });
});
