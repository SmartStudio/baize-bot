import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { BotListResponse, MeResponse, type ServerPush } from "@baize/shared";
import { startAgent, type AgentHandle } from "@baize/computer-agent";
import { computers } from "@baize/control-plane/testing";
import { startStack, type Stack } from "../src/stack.js";
import { startUpstream } from "../src/upstream.js";

const MISMATCH = "电脑代理和控制面版本对不上，配置被拒";

type OldControlPlane = {
  readonly url: string;
  /** 代理往控制面报的每一帧。 */
  readonly upFrames: { readonly type: string; readonly [key: string]: unknown }[];
  /** 控制面往代理发的每一帧的 type。 */
  readonly downTypes: string[];
  /** 控制面升级了：不再删字段，把最近那条 config 原样补发一遍，等代理回 config_applied。 */
  upgrade(): Promise<void>;
  close(): Promise<void>;
};

async function waitUntil(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`等${what}超时`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 夹在电脑代理和真控制面之间，把下行 config 里的 accountsProxy 删掉，扮一个还没有这个字段的旧控制面。 */
async function oldControlPlane(target: string): Promise<OldControlPlane> {
  const upFrames: OldControlPlane["upFrames"] = [];
  const downTypes: string[] = [];
  let strip = true;
  let lastConfig: string | null = null;
  let agentSide: WebSocket | null = null;
  let controlSide: WebSocket | null = null;
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  server.on("connection", (agent) => {
    const control = new WebSocket(target);
    agentSide = agent;
    controlSide = control;
    const early: string[] = [];
    control.on("open", () => {
      for (const frame of early.splice(0)) control.send(frame);
    });
    agent.on("message", (raw) => {
      const text = raw.toString();
      const parsed = JSON.parse(text) as { readonly body?: unknown };
      const body = parsed.body ?? parsed;
      upFrames.push(body as OldControlPlane["upFrames"][number]);
      if (control.readyState === WebSocket.OPEN) control.send(text);
      else early.push(text);
    });
    control.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as {
        type: string;
        body?: { type: string; accountsProxy?: unknown };
        accountsProxy?: unknown;
      };
      const body = frame.body ?? frame;
      downTypes.push(body.type);
      if (body.type === "config") {
        lastConfig = raw.toString();
        if (strip) delete body.accountsProxy;
      }
      agent.send(JSON.stringify(frame));
    });
    agent.on("close", () => control.close());
    control.on("close", () => agent.close());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/agent`,
    upFrames,
    downTypes,
    upgrade: async () => {
      strip = false;
      if (agentSide === null || controlSide === null || lastConfig === null) throw new Error("代理还没连上来");
      const applied = upFrames.filter((frame) => frame.type === "config_applied").length;
      agentSide.send(lastConfig);
      await waitUntil(
        () => upFrames.filter((frame) => frame.type === "config_applied").length > applied,
        "代理收下补发的 config",
      );
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) client.terminate();
        server.close(() => resolve());
      }),
  };
}

async function nextPushWhere(stack: Stack, match: (push: ServerPush) => boolean): Promise<ServerPush> {
  for (;;) {
    const push = await stack.nextPush();
    if (match(push)) return push;
  }
}

const systemText = (push: ServerPush): string | null =>
  push.type === "message" && push.message.body.kind === "system" ? push.message.body.text : null;

describe("端到端：新电脑代理连旧控制面", () => {
  it("旧 config 缺 accountsProxy：代理报 config_rejected，控制面不再派活、推 stuck 说版本对不上；控制面补发合格 config 后恢复", async () => {
    const upstream = await startUpstream(() => ({ textChunks: ["收到"], usage: { input: 10, output: 1 } }));
    const dataDir = mkdtempSync(join(tmpdir(), "e2e-config-rejected-"));
    let stack: Stack | undefined;
    let proxy: OldControlPlane | undefined;
    let agent: AgentHandle | undefined;
    let log = "";
    try {
      stack = await startStack({
        upstreamBaseUrl: upstream.baseUrl,
        priceInputPerM: 3,
        priceOutputPerM: 15,
        startComputer: false,
      });
      const { user } = MeResponse.parse(await stack.get("/api/me"));
      const credentials = await computers.resetComputerToken(stack.db, user.id);
      if (credentials === null) throw new Error("seed 没建出本机电脑");
      proxy = await oldControlPlane(`ws://127.0.0.1:${stack.port}/agent`);
      agent = startAgent({
        url: proxy.url,
        computerId: credentials.computerId,
        token: credentials.token,
        version: "0.1.0-e2e-new",
        dataDir,
        log: (line) => {
          log += `${line}\n`;
        },
        makeChrome: () => ({
          kind: "local",
          profileDir: join(dataDir, "chrome"),
          connection: () => Promise.reject(new Error("这条用例不该起 Chrome")),
          login: async () => ({ login: "failed", reason: "window_failed" }),
          reveal: async () => {},
          conceal: async () => {},
          pid: () => null,
          stop: async () => {},
        }),
      });

      const stuck = await nextPushWhere(stack, (push) => push.type === "notify");
      const trace = `电脑代理日志：\n${log}`;
      expect(stuck.type === "notify" ? stuck.notice : null, `用户收到的原因是版本对不上。${trace}`).toMatchObject({
        kind: "stuck",
        text: expect.stringContaining(MISMATCH),
      });
      expect(
        proxy.upFrames.filter((frame) => frame.type === "agent_error"),
        "代理把拒掉的字段报给了控制面",
      ).toEqual([
        {
          type: "agent_error",
          code: "config_rejected",
          generation: 1,
          detail: "config 不合这个电脑代理的版本，校验不过的字段：accountsProxy",
        },
      ]);

      const bots = BotListResponse.parse(await stack.get("/api/bots"));
      const first = bots.items[0];
      if (first === undefined) throw new Error("seed 没建出 Bot");
      await stack.post(`/api/groups/${first.groupId}/messages`, { text: "被拒期间的活" });
      const refused = await nextPushWhere(stack, (push) => systemText(push) !== null);
      expect(systemText(refused), "这条没派出去").toContain("没派出去");
      expect(proxy.downTypes, "控制面没往这台电脑派 prompt").not.toContain("prompt");
      const [open] = await stack.sql<{ n: string }[]>`SELECT count(*) AS n FROM runs WHERE ended_at IS NULL`;
      expect(Number(open?.n), "没留下 running 的 run").toBe(0);

      await proxy.upgrade();
      await stack.post(`/api/groups/${first.groupId}/messages`, { text: "升级之后的活" });
      await nextPushWhere(stack, (push) => push.type === "message" && push.message.body.kind === "cost");
      expect(proxy.downTypes, "收下合格 config 之后照常派活").toContain("prompt");
      expect(upstream.requests().length, "模型那端真的接到了这一轮").toBeGreaterThan(0);
    } finally {
      await agent?.stop();
      await proxy?.close();
      await stack?.close();
      await upstream.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
