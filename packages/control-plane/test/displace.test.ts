import { randomUUID } from "node:crypto";
import {
  AgentCloseCode,
  ComputerId,
  ComputerListResponse,
  ComputerTokenResponse,
  CreateBotResponse,
  PairLocalConflictResponse,
  RegisterResponse,
} from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import * as computersRepo from "../src/repo/computers.js";
import { helloAgent, openAgent, sendHello } from "./helpers/agent.js";
import { type ApiClient, startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { connectPush, type PushClient } from "./helpers/ws.js";

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

async function registered(): Promise<ApiClient> {
  const client = server.client();
  const response = await client.post("/api/register", {
    email: `${randomUUID()}@baize.dev`,
    password: "baize-dev",
    name: "顶号测试",
  });
  expect(response.status).toBe(201);
  RegisterResponse.parse(await response.json());
  return client;
}

async function paired(client: ApiClient) {
  const response = await client.request("POST", "/api/computers/local");
  expect(response.status, "首次配对无请求体也要成功").toBe(200);
  return ComputerTokenResponse.parse(await response.json());
}

async function computerStatus(push: PushClient, status: "online" | "sleeping"): Promise<void> {
  for (;;) {
    const message = await push.next();
    if (message.type === "computer_updated" && message.computer.status === status) return;
  }
}

describe("本机重新配对", () => {
  it("首次配对不带请求体返回 token，代理可以握手", async () => {
    const client = await registered();
    const local = await paired(client);
    const connected = await helloAgent(server.server.port, local.computerId, local.token);
    try {
      expect(connected.welcome.kind).toBe("local");
      expect(local.token).not.toBe("");
    } finally {
      connected.agent.close();
    }
  });

  it("已连上过且在线时未确认回 409，原 token 和连接都继续可用", async () => {
    const client = await registered();
    const local = await paired(client);
    const first = await helloAgent(server.server.port, local.computerId, local.token);
    try {
      const response = await client.request("POST", "/api/computers/local");
      expect(response.status).toBe(409);
      const raw: unknown = await response.json();
      const conflict = PairLocalConflictResponse.parse(raw);
      expect(conflict.error).toBe("这个账号已经在另一台 Mac 上用过，继续会让那台退出");
      expect(conflict.computer.id).toBe(local.computerId);
      expect(conflict.computer.lastSeenAt).not.toBeNull();
      expect(raw).not.toHaveProperty("token");

      const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "连接屏障" })).json());
      expect(
        (await first.agent.expect("config")).bots.map((bot) => bot.id),
        "409 后原连接仍接收配置",
      ).toContain(created.bot.id);
      expect(first.agent.socket.readyState).toBe(WebSocket.OPEN);
      const reconnected = await helloAgent(server.server.port, local.computerId, local.token);
      try {
        expect(reconnected.welcome.kind, "409 不得重置原 token").toBe("local");
        expect(await first.agent.closed()).toBe(AgentCloseCode.superseded);
      } finally {
        reconnected.agent.close();
      }
    } finally {
      first.agent.close();
    }
  });

  it("确认后轮换 token，用 4004 踢旧本机，远程连接继续在线", async () => {
    const client = await registered();
    const local = await paired(client);
    const first = await helloAgent(server.server.port, local.computerId, local.token);
    const remoteToken = ComputerTokenResponse.parse(await (await client.post("/api/computers/remote")).json());
    const remote = await helloAgent(server.server.port, remoteToken.computerId, remoteToken.token);
    let closeReason = "";
    first.agent.socket.once("close", (_code, reason) => (closeReason = reason.toString()));
    try {
      const response = await client.post("/api/computers/local", { confirmDisplace: true });
      expect(response.status).toBe(200);
      const replacement = ComputerTokenResponse.parse(await response.json());
      expect(replacement.computerId).toBe(local.computerId);
      expect(replacement.token).not.toBe(local.token);
      expect(await first.agent.closed()).toBe(AgentCloseCode.displaced);
      expect(closeReason).toBe("这个账号已在另一台 Mac 上登录");

      const stale = await openAgent(server.server.port);
      sendHello(stale, local.computerId, local.token);
      expect(await stale.closed(), "旧 token 再 hello 也必须收到顶号关闭码").toBe(AgentCloseCode.displaced);
      expect(stale.received(), "旧 token 不能拿到 welcome 或配置").toEqual([]);

      const listed = ComputerListResponse.parse(await (await client.get("/api/computers")).json());
      expect(listed.computers.map(({ kind, status }) => ({ kind, status }))).toEqual([
        { kind: "local", status: "sleeping" },
        { kind: "remote", status: "online" },
      ]);
      const second = await helloAgent(server.server.port, replacement.computerId, replacement.token);
      try {
        expect(second.welcome.kind, "新 token 可以重新上线").toBe("local");
        const bot = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "远程屏障" })).json());
        expect((await remote.agent.expect("config")).bots.map(({ id }) => id)).toContain(bot.bot.id);
        expect(remote.agent.socket.readyState).toBe(WebSocket.OPEN);
      } finally {
        second.agent.close();
      }
    } finally {
      first.agent.close();
      remote.agent.close();
    }
  });

  it("曾连上但现在休眠的本机也要求确认，拒绝后旧 token 仍有效", async () => {
    const client = await registered();
    const local = await paired(client);
    const push = await connectPush(server.server.port, client.cookie ?? "");
    const first = await helloAgent(server.server.port, local.computerId, local.token);
    try {
      await computerStatus(push, "online");
      first.agent.close();
      await computerStatus(push, "sleeping");
      const response = await client.post("/api/computers/local", { confirmDisplace: false });
      expect(response.status).toBe(409);
      const conflict = PairLocalConflictResponse.parse(await response.json());
      expect(conflict.computer.status).toBe("sleeping");
      expect(conflict.computer.lastSeenAt).not.toBeNull();
      const second = await helloAgent(server.server.port, local.computerId, local.token);
      second.agent.close();
    } finally {
      first.agent.close();
      push.close();
    }
  });

  it("从未连上过的本机再次配对无需确认，空对象请求也按未确认处理", async () => {
    const client = await registered();
    const first = await paired(client);
    const response = await client.post("/api/computers/local");
    expect(response.status).toBe(200);
    const second = ComputerTokenResponse.parse(await response.json());
    expect(second.computerId).toBe(first.computerId);
    expect(second.token).not.toBe(first.token);
    const listed = ComputerListResponse.parse(await (await client.get("/api/computers")).json());
    expect(listed.computers[0]?.lastSeenAt).toBeNull();
    const connected = await helloAgent(server.server.port, second.computerId, second.token);
    connected.agent.close();
  });

  it("确认字段类型错误回 400，不轮换已有 token", async () => {
    const client = await registered();
    const local = await paired(client);
    const response = await client.post("/api/computers/local", { confirmDisplace: "true" });
    expect(response.status).toBe(400);
    const connected = await helloAgent(server.server.port, local.computerId, local.token);
    connected.agent.close();
  });

  it("旧 token 已认完身份但还没入场时重新配对，旧 hello 也被 4004 拒绝", async () => {
    const client = await registered();
    const local = await paired(client);
    let authenticated!: () => void;
    const authenticatedDone = new Promise<void>((resolve) => (authenticated = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const original = computersRepo.authenticateComputer;
    let blockNext = true;
    const spy = vi.spyOn(computersRepo, "authenticateComputer").mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[1] === local.computerId && args[2] === local.token && blockNext) {
        blockNext = false;
        authenticated();
        await released;
      }
      return result;
    });
    const stale = await openAgent(server.server.port);
    try {
      sendHello(stale, local.computerId, local.token);
      await authenticatedDone;
      const response = await client.post("/api/computers/local", { confirmDisplace: true });
      expect(response.status).toBe(200);
      const replacement = ComputerTokenResponse.parse(await response.json());
      release();
      expect(await stale.closed(), "链外的旧认证结果不能越过重新配对").toBe(AgentCloseCode.displaced);
      expect(stale.received()).toEqual([]);
      const connected = await helloAgent(server.server.port, replacement.computerId, replacement.token);
      connected.agent.close();
    } finally {
      release();
      spy.mockRestore();
      stale.close();
    }
  });
});

describe("握手拒绝关闭码", () => {
  it("不存在的电脑号仍用 4001 关闭", async () => {
    const agent = await openAgent(server.server.port);
    sendHello(agent, ComputerId.parse(randomUUID()), "不存在的 token");
    expect(await agent.closed()).toBe(AgentCloseCode.badHello);
    expect(agent.received()).toEqual([]);
  });

  it.each(["不是 JSON", "{}", '{"type":"hello"}', '{"type":"heartbeat","at":"2026-10-13T00:00:00.000Z"}'])(
    "首条报文不合法仍用 4001 关闭：%s",
    async (raw) => {
      const agent = await openAgent(server.server.port);
      agent.socket.send(raw);
      expect(await agent.closed()).toBe(AgentCloseCode.badHello);
    },
  );

  it("不发 hello 超时仍用 4001 关闭", async () => {
    const agent = await openAgent(server.server.port);
    expect(await agent.closed(12_000)).toBe(AgentCloseCode.badHello);
  });
});
