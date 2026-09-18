import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { type AgentToControl, type ComputerId, ControlToAgent } from "@baize/shared";
import { createRunner, type Runner, type RunnerConfig } from "@baize/bot-runner";
import { backoffDelay, type BackoffOptions, defaultBackoff } from "./backoff.js";

export type RunnerFactory = (config: RunnerConfig) => Runner;

export interface AgentOptions {
  readonly url: string;
  readonly computerId: ComputerId;
  readonly token: string;
  readonly version: string;
  readonly heartbeatMs?: number;
  readonly backoff?: BackoffOptions;
  readonly log?: (line: string) => void;
  /** 每个 Bot 的 Pi 目录建在这下面。 */
  readonly dataDir?: string;
  /** 换掉真运行器。测试用它免去起真模型网关。 */
  readonly makeRunner?: RunnerFactory;
}

export interface AgentHandle {
  stop(): Promise<void>;
}

type Link =
  | { readonly phase: "connecting"; readonly socket: WebSocket }
  | { readonly phase: "open"; readonly socket: WebSocket }
  | { readonly phase: "waiting"; readonly timer: NodeJS.Timeout }
  | { readonly phase: "stopped" };

export function startAgent(options: AgentOptions): AgentHandle {
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const backoff = options.backoff ?? defaultBackoff;
  const log = options.log ?? ((line: string) => console.log(`[computer-agent] ${line}`));
  const dataDir = options.dataDir ?? process.env["BAIZE_DATA_DIR"] ?? join(homedir(), ".baize", "bots");
  const makeRunner = options.makeRunner ?? createRunner;

  let link: Link = { phase: "stopped" };
  let heartbeat: NodeJS.Timeout | null = null;
  let attempt = 0;
  let runner: Runner | null = null;
  // 报文按到达顺序串行处理。handle 是 async，并发跑会让 config 后面紧跟的 prompt 先看到还没建好的 runner。
  let inbox: Promise<void> = Promise.resolve();

  const send = (message: AgentToControl): void => {
    if (link.phase !== "open") {
      log(`连接不在，丢弃 ${message.type}`);
      return;
    }
    link.socket.send(JSON.stringify(message));
  };

  const stopHeartbeat = (): void => {
    if (heartbeat === null) return;
    clearInterval(heartbeat);
    heartbeat = null;
  };

  const handle = async (raw: string): Promise<void> => {
    // socket.close() 之后 ws 仍会把已经到手的帧派发上来。停了还建 runner 的话就没人再停它。
    if (link.phase === "stopped") return;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      log("收到非 JSON 报文，丢弃");
      return;
    }
    const parsed = ControlToAgent.safeParse(json);
    if (!parsed.success) {
      log(`报文不合 ControlToAgent，丢弃：${parsed.error.message}`);
      return;
    }
    const message = parsed.data;
    switch (message.type) {
      // welcome 才说明控制面收下了 hello。只看 TCP 连上就清零退避，会被「连上就踢」的控制面打成密集重连。
      case "welcome":
        attempt = 0;
        log(`控制面已接纳，owner ${message.ownerId}`);
        return;
      case "config": {
        const previous = runner;
        // 先同步换上新 runner，再去停旧的。中间不能有 await，否则紧跟其后的 prompt 会看到还没建好的 runner。
        runner = makeRunner({
          bots: message.bots,
          tools: message.tools,
          modelGateway: message.modelGateway,
          dataDir,
          send,
        });
        await previous?.stop();
        log(`收到 config，${message.bots.length} 个 Bot，${message.tools.length} 个工具连接`);
        return;
      }
      case "prompt": {
        if (runner === null) {
          log(`还没收到 config，丢弃 run ${message.runId} 的 prompt`);
          return;
        }
        await runner.prompt(message);
        return;
      }
      case "approval_result": {
        if (runner === null) {
          log(`还没收到 config，丢弃 run ${message.runId} 的审批结论`);
          return;
        }
        runner.approve(message.runId, message.callId, message.approved);
        return;
      }
      case "pause":
        await runner?.pause(message.botId);
        return;
      case "resume":
        await runner?.resume(message.botId);
        return;
    }
  };

  const scheduleReconnect = (): void => {
    if (link.phase === "stopped") return;
    const delay = backoffDelay(attempt, backoff);
    attempt += 1;
    // 这个定时器必须 ref 住事件循环。unref 的话，断开期间进程没有别的 handle，会直接退出而不是重连。
    const timer = setTimeout(connect, delay);
    link = { phase: "waiting", timer };
    log(`${delay}ms 后重连，第 ${attempt} 次`);
  };

  function connect(): void {
    const socket = new WebSocket(options.url);
    link = { phase: "connecting", socket };

    socket.on("open", () => {
      link = { phase: "open", socket };
      send({
        type: "hello",
        computerId: options.computerId,
        token: options.token,
        version: options.version,
      });
      stopHeartbeat();
      heartbeat = setInterval(() => send({ type: "heartbeat", at: new Date().toISOString() }), heartbeatMs);
      heartbeat.unref();
    });

    socket.on("message", (data) => {
      const raw = data.toString();
      inbox = inbox.then(() => handle(raw)).catch((error: unknown) => log(`处理报文出错：${String(error)}`));
    });

    socket.on("error", (error) => {
      if (link.phase === "stopped") return;
      log(`连接出错：${error.message}`);
    });

    socket.on("close", () => {
      stopHeartbeat();
      scheduleReconnect();
    });
  }

  connect();

  return {
    async stop() {
      const current = link;
      link = { phase: "stopped" };
      stopHeartbeat();
      if (current.phase === "waiting") clearTimeout(current.timer);
      if (current.phase === "connecting" || current.phase === "open") current.socket.close();
      await inbox;
      await runner?.stop();
      runner = null;
    },
  };
}
