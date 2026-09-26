import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { type AgentToControl, type ComputerId, ControlToAgent } from "@baize/shared";
import { createRunner, publishDraft, type Runner, type RunnerConfig } from "@baize/bot-runner";
import { backoffDelay, type BackoffOptions, defaultBackoff } from "./backoff.js";
import { type AssistantChrome, type AssistantChromeOptions, startAssistantChrome, untilAborted } from "./chrome.js";

export interface AgentRunnerConfig extends RunnerConfig {
  readonly browser: NonNullable<RunnerConfig["browser"]>;
}

export type RunnerFactory = (config: AgentRunnerConfig) => Runner;
export type AssistantChromeFactory = (options: AssistantChromeOptions) => AssistantChrome;

export interface AgentOptions {
  readonly url: string;
  readonly computerId: ComputerId;
  readonly token: string;
  readonly version: string;
  readonly heartbeatMs?: number;
  readonly backoff?: BackoffOptions;
  readonly log?: (line: string) => void;
  /** 每个 Bot 的 Pi 目录建在这下面。main.ts 从 BAIZE_DATA_DIR 读，不给就落到 ~/.baize/bots。 */
  readonly dataDir?: string;
  /** 换掉真运行器。测试用它免去起真模型网关。 */
  readonly makeRunner?: RunnerFactory;
  /** 停机时等运行器收尾的上限。超时后仍会关连接退出。 */
  readonly runnerStopTimeoutMs?: number;
  /** 换掉真 Chrome 守护。测试用它避免启动图形应用。 */
  readonly makeChrome?: AssistantChromeFactory;
  /** 一次 browser_login 从收到到回 login_state 的上限，排队和等 Chrome 起来都算在内。 */
  readonly loginTimeoutMs?: number;
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
  const dataDir = options.dataDir ?? join(homedir(), ".baize", "bots");
  const makeRunner: RunnerFactory = options.makeRunner ?? ((config) => createRunner(config));
  const runnerStopTimeoutMs = options.runnerStopTimeoutMs ?? 3_000;
  const loginTimeoutMs = options.loginTimeoutMs ?? 120_000;
  const chrome = (options.makeChrome ?? startAssistantChrome)({ dataDir, log });
  const browserConfig: AgentRunnerConfig["browser"] = {
    profileDir: chrome.profileDir,
    connection: () => chrome.connection(),
  };

  let link: Link = { phase: "stopped" };
  let stopping = false;
  let stopPromise: Promise<void> | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let attempt = 0;
  let runner: Runner | null = null;
  // 报文按到达顺序串行处理。handle 是 async，并发跑会让 config 后面紧跟的 prompt 先看到还没建好的 runner。
  let inbox: Promise<void> = Promise.resolve();
  let loginQueue: Promise<void> = Promise.resolve();

  const send = (message: AgentToControl): void => {
    if (link.phase !== "open" || link.socket.readyState !== WebSocket.OPEN) {
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
    if (stopping || link.phase === "stopped") return;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      log("收到非 JSON 报文，丢弃");
      return;
    }
    const parsed = ControlToAgent.safeParse(json);
    if (!parsed.success) {
      // config 被拒只在本地记一笔的话，控制面会一直往这台电脑派活，用户只看到活没人接。报回去让它停派。
      if ((json as { type?: unknown } | null)?.type === "config") {
        const paths = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "(整条)"))].join("、");
        log(`config 不合这个电脑代理的版本，丢弃。校验不过的字段：${paths}`);
        send({
          type: "agent_error",
          code: "config_rejected",
          detail: `config 不合这个电脑代理的版本，校验不过的字段：${paths}`,
        });
        return;
      }
      log(`报文不合 ControlToAgent，丢弃：${parsed.error.message}`);
      return;
    }
    const message = parsed.data;
    switch (message.type) {
      // welcome 才说明控制面收下了 hello。只看 TCP 连上就清零退避，会被「连上就踢」的控制面打成密集重连。
      case "welcome":
        attempt = 0;
        log(`控制面已接纳，owner ${message.ownerId}`);
        process.stdout.write('{"type":"online"}\n');
        return;
      case "config": {
        const config: AgentRunnerConfig = {
          computerId: options.computerId,
          bots: message.bots,
          tools: message.tools,
          accounts: message.accounts,
          grants: message.grants,
          modelGateway: message.modelGateway,
          accountsProxy: message.accountsProxy,
          // 不透传的话运行器按空数组对账，每来一条 config 就把所有 Bot 盘上的 skill 清空。
          skills: message.skills,
          dataDir,
          send,
          browser: browserConfig,
        };
        if (runner === null) {
          runner = makeRunner(config);
        } else {
          await runner.applyConfig(config);
        }
        log(`收到 config，${message.bots.length} 个 Bot，${message.tools.length} 个工具连接`);
        send({ type: "config_applied" });
        return;
      }
      case "prompt": {
        if (runner === null) {
          log(`还没收到 config，丢弃 run ${message.runId} 的 prompt`);
          send({
            type: "agent_error",
            code: "prompt_before_config",
            detail: `run ${message.runId} 的 prompt 比 config 先到`,
            groupId: message.groupId,
            runId: message.runId,
          });
          return;
        }
        void runner.prompt(message);
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
      case "browser_login": {
        const deadline = AbortSignal.timeout(loginTimeoutMs);
        // 到点就不再等这次登录，队列接着走。login 自己也收 deadline，会收起窗口。
        loginQueue = loginQueue
          .then(() => {
            deadline.throwIfAborted();
            return untilAborted(chrome.login(message.platform, deadline), deadline);
          })
          .then((state) => {
            if (stopping) return;
            send({
              type: "login_state",
              accountId: message.accountId,
              state: state.login === "failed" ? { ...state, attempt: message.attempt } : state,
            });
          })
          .catch((error: unknown) => {
            log(`登录 ${message.platform} 失败：${String(error)}`);
            if (!stopping) {
              send({
                type: "login_state",
                accountId: message.accountId,
                state: { login: "failed", reason: "window_failed", attempt: message.attempt },
              });
            }
          });
        return;
      }
      case "pause":
        await runner?.pause(message.botId);
        return;
      case "resume":
        void runner?.resume(message.botId).catch((error: unknown) => log(`恢复 Bot 失败：${String(error)}`));
        return;
      case "publish_draft":
        void publishDraft(message, { dataDir, browser: chrome.kind === "local" ? browserConfig : null }).then(
          send,
          (error: unknown) => log(`发布草稿 ${message.draftId} 出错：${String(error)}`),
        );
        return;
    }
  };

  const scheduleReconnect = (): void => {
    if (stopping || link.phase === "stopped") return;
    const delay = backoffDelay(attempt, backoff);
    attempt += 1;
    // 这个定时器必须 ref 住事件循环。unref 的话，断开期间进程没有别的 handle，会直接退出而不是重连。
    const timer = setTimeout(connect, delay);
    link = { phase: "waiting", timer };
    log(`${delay}ms 后重连，第 ${attempt} 次`);
  };

  function connect(): void {
    if (stopping) return;
    const socket = new WebSocket(options.url);
    link = { phase: "connecting", socket };

    socket.on("open", () => {
      if (stopping) return;
      link = { phase: "open", socket };
      const activeRuns = runner?.activeRuns() ?? [];
      send({
        type: "hello",
        computerId: options.computerId,
        token: options.token,
        version: options.version,
        activeRuns: [...activeRuns],
      });
      log(`已发 hello，报告 ${activeRuns.length} 个仍在跑的 run`);
      stopHeartbeat();
      heartbeat = setInterval(() => send({ type: "heartbeat", at: new Date().toISOString() }), heartbeatMs);
      heartbeat.unref();
    });

    socket.on("message", (data) => {
      if (stopping) return;
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
    stop() {
      if (stopPromise !== null) return stopPromise;
      stopping = true;
      stopHeartbeat();
      if (link.phase === "waiting") clearTimeout(link.timer);

      stopPromise = (async () => {
        const chromeStopping = chrome.stop().catch((error: unknown) => log(`助理 Chrome 停机失败：${String(error)}`));
        const currentRunner = runner;
        if (currentRunner !== null) {
          let timeout: NodeJS.Timeout | null = null;
          const result = await Promise.race([
            Promise.resolve()
              .then(() => currentRunner.stop())
              .then(
                () => "stopped" as const,
                (error: unknown) => {
                  log(`运行器停机失败：${String(error)}`);
                  return "stopped" as const;
                },
              ),
            new Promise<"timed-out">((resolve) => {
              timeout = setTimeout(() => resolve("timed-out"), runnerStopTimeoutMs);
              timeout.unref();
            }),
          ]);
          if (timeout !== null) clearTimeout(timeout);
          if (result === "timed-out") log(`运行器停机超过 ${runnerStopTimeoutMs}ms，继续关闭连接`);
        }
        runner = null;
        await chromeStopping;

        const current = link;
        link = { phase: "stopped" };
        stopHeartbeat();
        if (current.phase === "waiting") clearTimeout(current.timer);
        if (current.phase === "connecting" || current.phase === "open") current.socket.close();
      })();
      return stopPromise;
    },
  };
}
