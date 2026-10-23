import { AgentCloseCode, CreateBotResponse, SendMessageResponse, UplinkAck, type ServerPush } from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RawData } from "ws";
import { helloAgent, openAgent, type AgentClient } from "./helpers/agent.js";
import { startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser } from "./helpers/fixtures.js";
import { connectPush, type PushClient } from "./helpers/ws.js";

const MiB = 1024 * 1024;
const MESSAGE_TOO_BIG = 1009;

let database: TestDb;
let server: TestServer;

beforeAll(async () => {
  database = await createTestDb();
  server = await startTestServer(database.db);
});

afterAll(async () => {
  await server.close();
  await database.close();
});

async function ownerWithGroup() {
  const user = await makeUser(database.db);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const created = CreateBotResponse.parse(await (await client.post("/api/bots", {})).json());
  return { user, client, groupId: created.group.id, cookie: client.cookie ?? "" };
}

function pushClosed(push: PushClient): Promise<number> {
  return new Promise((resolve) => push.socket.once("close", (code) => resolve(code)));
}

async function nextMessagePush(push: PushClient): Promise<Extract<ServerPush, { type: "message" }>> {
  for (;;) {
    const next = await push.next();
    if (next.type === "message") return next;
  }
}

function reliableAcked(agent: AgentClient, seq: number): Promise<UplinkAck> {
  return new Promise((resolve, reject) => {
    const received = agent.uplinkAcks().find((entry) => entry.upTo >= seq);
    if (received !== undefined) return resolve(received);
    const timer = setTimeout(() => reject(new Error(`等上行 ${seq} 确认超时`)), 10_000);
    const onMessage = (raw: RawData) => {
      const value: unknown = JSON.parse(raw.toString());
      if (typeof value !== "object" || value === null || !("type" in value) || value.type !== "uplink_ack") return;
      const ack = UplinkAck.parse(value);
      if (ack.upTo < seq) return;
      clearTimeout(timer);
      agent.socket.off("message", onMessage);
      resolve(ack);
    };
    agent.socket.on("message", onMessage);
  });
}

describe("/api/ws 帧大小", () => {
  it("网页发来超过 1 KiB 的帧，这条连接以 1009 关闭，控制面照常推送", async () => {
    const { client, groupId, cookie } = await ownerWithGroup();
    const oversized = await connectPush(server.server.port, cookie);
    const closed = pushClosed(oversized);
    oversized.socket.send("x".repeat(2048));
    expect(await closed, "超限帧要以 1009 关闭").toBe(MESSAGE_TOO_BIG);

    const push = await connectPush(server.server.port, cookie);
    try {
      push.socket.send("x".repeat(512));
      const { message } = SendMessageResponse.parse(
        await (await client.post(`/api/groups/${groupId}/messages`, { text: "还在吗" })).json(),
      );
      const pushed = await nextMessagePush(push);
      expect(pushed.message.id, "上限以内的帧不断连，推送照常到").toBe(message.id);
    } finally {
      push.close();
    }
  });
});

describe("/agent 帧大小与握手", () => {
  it("没报 hello 就发来超过 16 MiB 的帧，以 1009 关闭", async () => {
    const agent = await openAgent(server.server.port);
    const closed = agent.closed(10_000);
    agent.socket.send(Buffer.alloc(16 * MiB + 1, 0x20));
    expect(await closed).toBe(MESSAGE_TOO_BIG);
  });

  it("握手之后 4 MiB 的上行照收照确认，超过 16 MiB 的以 1009 关闭", async () => {
    const user = await makeUser(database.db);
    const computer = await makeComputer(database.db, user.id);
    const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);
    try {
      const seq = agent.sendMalformedReliable({ type: "padding", text: "x".repeat(4 * MiB) });
      const ack = await reliableAcked(agent, seq);
      expect(ack.upTo, "4 MiB 的帧到了控制面并被确认").toBeGreaterThanOrEqual(seq);

      const closed = agent.closed(10_000);
      agent.sendMalformedReliable({ type: "padding", text: "x".repeat(16 * MiB) });
      expect(await closed).toBe(MESSAGE_TOO_BIG);
    } finally {
      agent.close();
    }
  });

  it("连上 10 秒不报 hello，控制面按坏 hello 关掉", { timeout: 20_000 }, async () => {
    const agent = await openAgent(server.server.port);
    expect(await agent.closed(15_000)).toBe(AgentCloseCode.badHello);
  });
});
