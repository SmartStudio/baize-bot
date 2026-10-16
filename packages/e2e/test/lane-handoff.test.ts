import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  AgentToControl,
  BotListResponse,
  ComputerListResponse,
  ComputerTokenResponse,
  ControlToAgent,
  DownlinkFrame,
  MessageListResponse,
  type ComputerId,
  type RunId,
} from "@baize/shared";
import { createRunner, type Runner } from "@baize/bot-runner";
import { startAgent, type AgentHandle } from "@baize/computer-agent";
import { startRelayEntry } from "../src/relay.js";
import { startStack, type Stack } from "../src/stack.js";
import { startUpstream } from "../src/upstream.js";

const poll = { timeout: 10_000, interval: 25 };
const LOCAL_MESSAGE = "本机先持有这条道";
const REMOTE_MESSAGE = "断线后由远程接手这条新消息";

type Relay = {
  readonly url: string;
  readonly up: AgentToControl[];
  readonly down: ControlToAgent[];
  readonly reliableDown: DownlinkFrame[];
  cut(): void;
  restore(): void;
  close(): Promise<void>;
};

async function relay(controlPort: number): Promise<Relay> {
  const up: AgentToControl[] = [];
  const down: ControlToAgent[] = [];
  const reliableDown: DownlinkFrame[] = [];
  const sockets = new Set<WebSocket>();
  let cut = false;
  const entry = await startRelayEntry(controlPort);
  entry.agents.on("connection", (agent) => {
    if (cut) {
      agent.terminate();
      return;
    }
    const control = new WebSocket(`ws://127.0.0.1:${controlPort}/agent`);
    const early: string[] = [];
    for (const socket of [agent, control]) {
      sockets.add(socket);
      socket.on("error", () => {
        agent.terminate();
        control.terminate();
      });
      socket.on("close", () => sockets.delete(socket));
    }
    control.on("open", () => {
      for (const frame of early.splice(0)) control.send(frame);
    });
    agent.on("message", (raw) => {
      const text = raw.toString();
      const frame = JSON.parse(text) as { readonly body?: unknown };
      const message = AgentToControl.safeParse(frame.body ?? frame);
      if (message.success) up.push(message.data);
      if (control.readyState === WebSocket.OPEN) control.send(text);
      else early.push(text);
    });
    control.on("message", (raw) => {
      const text = raw.toString();
      const frame = JSON.parse(text) as { readonly body?: unknown };
      const reliable = DownlinkFrame.safeParse(frame);
      if (reliable.success) reliableDown.push(reliable.data);
      const message = ControlToAgent.safeParse(frame.body ?? frame);
      if (message.success) down.push(message.data);
      if (agent.readyState === WebSocket.OPEN) agent.send(text);
    });
    agent.on("close", () => control.close());
    control.on("close", () => agent.close());
  });
  const disconnect = () => {
    for (const socket of sockets) socket.terminate();
  };
  return {
    url: `ws://127.0.0.1:${entry.port}/agent`,
    up,
    down,
    reliableDown,
    cut: () => {
      cut = true;
      disconnect();
    },
    restore: () => {
      cut = false;
    },
    close: async () => {
      disconnect();
      await entry.close();
    },
  };
}

function computer(link: Relay, credentials: { computerId: ComputerId; token: string }, dataDir: string) {
  const cancelled: Parameters<Runner["cancel"]>[0][] = [];
  let runner: Runner | undefined;
  let log = "";
  const agent = startAgent({
    ...credentials,
    url: link.url,
    version: "0.1.0-e2e-lease",
    dataDir,
    backoff: { initialMs: 100, maxMs: 200, factor: 1 },
    makeChrome: () => ({
      kind: "local",
      profileDir: join(dataDir, "chrome"),
      connection: () => Promise.reject(new Error("租约接手用例不使用 Chrome")),
      onExit: () => () => {},
      reveal: async () => {},
      conceal: async () => {},
      pid: () => null,
      stop: async () => {},
    }),
    makeRunner: (config) => {
      const current = createRunner(config);
      runner = current;
      return {
        ...current,
        cancel: (target) => {
          cancelled.push(target);
          current.cancel(target);
        },
      };
    },
    log: (line) => {
      log += `${line}\n`;
    },
  });
  return { agent, cancelled, activeRuns: () => runner?.activeRuns() ?? [], log: () => log };
}

async function waitForAbandoned(stack: Stack, computerId: ComputerId, groupId: string): Promise<void> {
  let sleeping = false;
  let abandoned = false;
  while (!sleeping || !abandoned) {
    const push = await stack.nextPush();
    if (push.type === "computer_updated" && push.computer.id === computerId && push.computer.status === "sleeping")
      sleeping = true;
    if (
      push.type === "message" &&
      push.message.groupId === groupId &&
      push.message.body.kind === "system" &&
      push.message.body.text === "电脑断过线，这次活没做完"
    )
      abandoned = true;
  }
}

const runDones = (link: Relay, runId: RunId) =>
  link.up.filter((message) => message.type === "run_done" && message.runId === runId);

it("本机断线过宽限后远程接手：run_done 一次，本机重连收到道取消，旧代际模型请求被挡", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let localWaiting = false;
  const upstream = await startUpstream((request) => {
    const current = JSON.stringify(request.messages.findLast((message) => message.role === "user")?.content);
    if (current?.includes(REMOTE_MESSAGE)) return { textChunks: ["远程接手完成。"], usage: { input: 30, output: 8 } };
    if (current?.includes(LOCAL_MESSAGE)) {
      return {
        textChunks: [
          "本机开始了，",
          async () => {
            localWaiting = true;
            await held;
          },
          "本机旧回合结束。",
        ],
        usage: { input: 20, output: 5 },
      };
    }
    throw new Error("模型请求没有租约验收的当前消息");
  });
  const dataDir = mkdtempSync(join(tmpdir(), "e2e-lane-handoff-"));
  let stack: Stack | undefined;
  let localLink: Relay | undefined;
  let remoteLink: Relay | undefined;
  let localAgent: AgentHandle | undefined;
  let remoteAgent: AgentHandle | undefined;
  try {
    stack = await startStack({
      upstreamBaseUrl: upstream.baseUrl,
      priceInputPerM: 3,
      priceOutputPerM: 15,
      startComputer: false,
      disconnectGraceMs: 100,
      leaseRenewalIntervalMs: 25,
    });
    const local = ComputerTokenResponse.parse(await stack.post("/api/computers/local", { confirmDisplace: true }));
    const remote = ComputerTokenResponse.parse(await stack.post("/api/computers/remote", {}));
    localLink = await relay(stack.port);
    remoteLink = await relay(stack.port);
    const localComputer = computer(localLink, local, join(dataDir, "local"));
    const remoteComputer = computer(remoteLink, remote, join(dataDir, "remote"));
    localAgent = localComputer.agent;
    remoteAgent = remoteComputer.agent;
    await expect.poll(() => localLink!.up.some((message) => message.type === "config_applied"), poll).toBe(true);
    await expect.poll(() => remoteLink!.up.some((message) => message.type === "config_applied"), poll).toBe(true);
    expect(ComputerListResponse.parse(await stack.get("/api/computers")).computers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: local.computerId, kind: "local", status: "online" }),
        expect.objectContaining({ id: remote.computerId, kind: "remote", status: "online" }),
      ]),
    );
    const service = BotListResponse.parse(await stack.get("/api/bots")).items.find((item) => item.bot.name === "小服");
    if (service === undefined) throw new Error("seed 没建出小服");
    const { bot, groupId } = service;
    await stack.post(`/api/groups/${groupId}/messages`, { text: LOCAL_MESSAGE });
    await expect.poll(() => localWaiting, { ...poll, message: localComputer.log() }).toBe(true);
    const first = localLink.down.find((message) => message.type === "prompt" && message.text === LOCAL_MESSAGE);
    if (first?.type !== "prompt") throw new Error("本机没有收到旧 prompt");
    const [initialLease] = await stack.sql<{ holder_computer_id: string; epoch: number }[]>`
      SELECT holder_computer_id, epoch FROM lane_leases WHERE bot_id = ${bot.id} AND group_id = ${groupId}
    `;
    expect(initialLease).toEqual({ holder_computer_id: local.computerId, epoch: first.lane.epoch });
    expect(remoteLink.down.filter((message) => message.type === "prompt")).toHaveLength(0);

    localLink.cut();
    await waitForAbandoned(stack, local.computerId, groupId);
    const [abandoned] = await stack.sql<
      { ended: boolean }[]
    >`SELECT ended_at IS NOT NULL AS ended FROM runs WHERE id = ${first.runId}`;
    expect(abandoned?.ended, "服务器宽限到期已经收尾旧 run").toBe(true);
    expect(runDones(localLink, first.runId), "假上游仍挂着，本机没有正常收尾").toHaveLength(0);

    await stack.post(`/api/groups/${groupId}/messages`, { text: REMOTE_MESSAGE });
    let settledRunId: RunId | undefined;
    while (settledRunId === undefined) {
      const push = await stack.nextPush();
      if (push.type === "message" && push.message.groupId === groupId && push.message.body.kind === "cost") {
        const runId = push.message.body.runId;
        const done = remoteLink.down.find(
          (message) => message.type === "prompt" && message.text === REMOTE_MESSAGE && message.runId === runId,
        );
        if (done?.type === "prompt") settledRunId = done.runId;
      }
    }
    const next = remoteLink.down.find((message) => message.type === "prompt" && message.runId === settledRunId);
    if (next?.type !== "prompt") throw new Error("远程没有收到接手 prompt");
    expect(next.lane.epoch).toBe(first.lane.epoch + 1);
    expect(runDones(remoteLink, next.runId), remoteComputer.log()).toHaveLength(1);
    const [taken] = await stack.sql<{ holder_computer_id: string; epoch: number }[]>`
      SELECT holder_computer_id, epoch FROM lane_leases WHERE bot_id = ${bot.id} AND group_id = ${groupId}
    `;
    expect(taken).toEqual({ holder_computer_id: remote.computerId, epoch: next.lane.epoch });
    const [remoteRun] = await stack.sql<
      { computer_id: string; ended: boolean; input_tokens: number; output_tokens: number }[]
    >`
      SELECT computer_id, ended_at IS NOT NULL AS ended, input_tokens, output_tokens FROM runs WHERE id = ${next.runId}
    `;
    expect(remoteRun).toMatchObject({
      computer_id: remote.computerId,
      ended: true,
      input_tokens: 30,
      output_tokens: 8,
    });
    const page = MessageListResponse.parse(await stack.get(`/api/groups/${groupId}/messages`));
    expect(
      page.messages.filter((message) => message.body.kind === "cost" && message.body.runId === next.runId),
    ).toHaveLength(1);
    expect(page.messages.some((message) => message.body.kind === "bot" && message.body.text === "远程接手完成。")).toBe(
      true,
    );

    const configsBefore = localLink.down.filter((message) => message.type === "config").length;
    localLink.restore();
    await expect
      .poll(() => localLink!.down.filter((message) => message.type === "config").length, poll)
      .toBeGreaterThan(configsBefore);
    const expectedCancel = { lane: { botId: bot.id, groupId }, epoch: next.lane.epoch };
    await expect.poll(() => localComputer.cancelled, poll).toContainEqual(expectedCancel);
    expect(
      localLink.reliableDown.filter((frame) => frame.body.type === "cancel" && frame.body.lane?.groupId === groupId),
    ).toHaveLength(1);
    expect(
      localLink.reliableDown.find((frame) => frame.body.type === "cancel" && frame.body.lane?.groupId === groupId)
        ?.body,
    ).toEqual({ type: "cancel", ...expectedCancel });
    const config = localLink.down.findLast((message) => message.type === "config");
    if (config?.type !== "config") throw new Error("本机重连没有收到 config");
    const beforeRejected = upstream.requests().length;
    const rejected = await fetch(`${config.modelGateway.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.modelGateway.apiKey}`,
        "x-baize-lane": `${bot.id}/${groupId}/${first.lane.epoch}`,
      },
      body: JSON.stringify({ model: "baize:plan", messages: [{ role: "user", content: "旧代际不得调用模型" }] }),
    });
    expect(rejected.status, "用重连的新 key，只让旧代际触发栅栏").toBe(409);
    expect(await rejected.json()).toEqual({ error: "代际过时" });
    expect(upstream.requests()).toHaveLength(beforeRejected);
    release();
    await expect.poll(() => localComputer.activeRuns(), poll).not.toContain(first.runId);
    expect(runDones(localLink, first.runId), "被道取消的旧 run 不能补发 run_done").toHaveLength(0);
    expect(runDones(remoteLink, next.runId)).toHaveLength(1);
  } finally {
    release();
    await localAgent?.stop();
    await remoteAgent?.stop();
    await localLink?.close();
    await remoteLink?.close();
    await stack?.close();
    await upstream.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
