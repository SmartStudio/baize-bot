import { randomUUID } from "node:crypto";
import { AgentCloseCode, ComputerListResponse, ComputerTokenResponse, RegisterResponse } from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { expectHello, openAgent, sendHello } from "./helpers/agent.js";
import { type ApiClient, startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { gatedDb } from "./helpers/gated-db.js";
import { connectPush } from "./helpers/ws.js";

let database: TestDb;
let gate: ReturnType<typeof gatedDb>;
let server: TestServer;

beforeAll(async () => {
  database = await createTestDb();
  gate = gatedDb(database.sql);
  server = await startTestServer(gate.db);
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
    name: "顶号链屏障",
  });
  expect(response.status).toBe(201);
  RegisterResponse.parse(await response.json());
  return client;
}

async function paired(client: ApiClient) {
  const response = await client.request("POST", "/api/computers/local");
  expect(response.status).toBe(200);
  return ComputerTokenResponse.parse(await response.json());
}

async function computerStatus(client: ApiClient) {
  const listed = ComputerListResponse.parse(await (await client.get("/api/computers")).json());
  const computer = listed.computers[0];
  if (computer === undefined || computer.kind !== "local") throw new Error("本机电脑没有出现在列表里");
  return computer.status;
}

describe("重新配对与 hello 同链", () => {
  it("等旧 hello 完成后才关闭，并让新 token 单独上线", async () => {
    const client = await registered();
    const local = await paired(client);
    const push = await connectPush(server.server.port, client.cookie ?? "");
    const rotate = gate.arm(/^update "computers" set "gateway_key_hash"/, "before", local.computerId);
    const old = await openAgent(server.server.port);
    let confirming: Promise<Response> | undefined;
    const emit = WebSocket.prototype.emit;
    const delayedCloses: Array<() => void> = [];
    // 扣住服务端 socket 的 close 回调，休眠只能由确认请求自己完成，不能被稍后的 close 补上。
    const closeGate = vi.spyOn(WebSocket.prototype, "emit").mockImplementation(function (
      this: WebSocket,
      event,
      ...args
    ) {
      if (event === "close" && args[0] === AgentCloseCode.displaced && this !== old.socket) {
        delayedCloses.push(() => {
          emit.call(this, event, ...args);
        });
        return true;
      }
      return emit.call(this, event, ...args);
    });
    try {
      expect(await computerStatus(client)).toBe("creating");
      sendHello(old, local.computerId, local.token);
      await rotate.reached;

      let confirmationDone = false;
      confirming = client.post("/api/computers/local", { confirmDisplace: true }).then((response) => {
        confirmationDone = true;
        return response;
      });

      for (;;) {
        const message = await push.next();
        if (message.type === "computer_updated" && message.computer.id === local.computerId) break;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(confirmationDone, "确认请求已轮换 token，但必须等握手链完成才能返回").toBe(false);
      rotate.release();
      const hello = await expectHello(old);
      expect(hello.welcome.kind).toBe("local");
      expect(await old.closed()).toBe(AgentCloseCode.displaced);
      expect(old.socket.readyState).toBe(3);

      const response = await confirming;
      expect(response.status).toBe(200);
      const replacement = ComputerTokenResponse.parse(await response.json());
      expect(replacement.computerId).toBe(local.computerId);
      expect(replacement.token).not.toBe(local.token);
      expect(await computerStatus(client), "socket close 回调尚未放行，确认请求必须自己完成休眠").toBe("sleeping");
      closeGate.mockRestore();
      for (const close of delayedCloses.splice(0)) close();

      const fresh = await openAgent(server.server.port);
      try {
        sendHello(fresh, replacement.computerId, replacement.token);
        const accepted = await expectHello(fresh);
        expect(accepted.welcome.kind).toBe("local");
        expect(old.socket.readyState, "旧连接必须先关闭，新 token 才能握手").toBe(3);
        expect(fresh.socket.readyState).toBe(1);
        expect(await computerStatus(client)).toBe("online");
      } finally {
        fresh.close();
      }
    } finally {
      rotate.release();
      closeGate.mockRestore();
      for (const close of delayedCloses.splice(0)) close();
      old.close();
      push.close();
      await confirming?.catch(() => undefined);
    }
  });
});
