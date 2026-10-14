import { homedir } from "node:os";
import { join } from "node:path";
import { type RawData, WebSocket } from "ws";
import {
  AGENT_PROTOCOL,
  classifyMcpDiscoveryFailure,
  AgentCloseCode,
  AgentStatusLine,
  type AgentToControl,
  BareUplinkFrame,
  type ComputerId,
  ControlToAgent,
  DownlinkFrame,
  UplinkFrame,
  UPLINK_DELIVERY,
  UplinkAck,
} from "@baize/shared";
import {
  createRunner,
  CURRENT_SESSION_VERSION,
  discoverMcpTools,
  publishDraft,
  type Runner,
  type RunnerConfig,
} from "@baize/bot-runner";
import { backoffDelay, type BackoffOptions, defaultBackoff } from "./backoff.js";
import { type AssistantChrome, type AssistantChromeOptions, startAssistantChrome } from "./chrome.js";
import { createLiveScreen } from "./live-screen.js";
import { createLogins, defaultLoginPages } from "./login.js";
import { DownlinkCursor, quarantineTransportState, ReliableOutbox } from "./reliable-transport.js";
import { loadInstallId } from "./install-id.js";
import { WorkAppendChannel } from "./work-append.js";

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
  /** 一次 browser_login 从收到算起多久没登上就回 timed_out，等 Chrome 起来、人在画面上操作都算在内。 */
  readonly loginTimeoutMs?: number;
  /** 测试用断线注入点：持久化完成后、可靠帧发送前调用。 */
  readonly beforeReliableSend?: (frame: UplinkFrame) => void;
  readonly discoverMcp?: typeof discoverMcpTools;
}

export interface AgentHandle {
  stop(): Promise<void>;
}

type Link =
  | { readonly phase: "connecting"; readonly socket: WebSocket }
  // applied 是这条连接上已应用到第几代 config。代际按连接算，连接换了号就跟着换，旧连接的号不带过来。
  | { readonly phase: "open"; readonly socket: WebSocket; applied: number }
  | { readonly phase: "waiting"; readonly timer: NodeJS.Timeout }
  | { readonly phase: "stopped" };

const bytesOf = (data: RawData): Uint8Array =>
  Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data;

export function startAgent(options: AgentOptions): AgentHandle {
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const backoff = options.backoff ?? defaultBackoff;
  const log = options.log ?? ((line: string) => console.log(`[computer-agent] ${line}`));
  const dataDir = options.dataDir ?? join(homedir(), ".baize", "bots");
  const makeRunner: RunnerFactory = options.makeRunner ?? ((config) => createRunner(config));
  const runnerStopTimeoutMs = options.runnerStopTimeoutMs ?? 3_000;
  // 远程登录要等人看到提示、拿出手机扫码或收验证码，2 分钟不够。
  const loginTimeoutMs = options.loginTimeoutMs ?? 15 * 60_000;
  const chrome = (options.makeChrome ?? startAssistantChrome)({ dataDir, log });

  let link: Link = { phase: "stopped" };
  let stopping = false;
  let stopPromise: Promise<void> | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let attempt = 0;
  let runner: Runner | null = null;
  let attachmentConfig: Pick<AgentRunnerConfig, "hub" | "modelGateway"> | null = null;
  let conn: number | null = null;
  let upSent = 0;
  let outbox: ReliableOutbox | null = null;
  let downlinkCursor: DownlinkCursor | null = null;
  let resettingTransport = false;
  const resetReports: AgentToControl[] = [];
  let installId: string | null = null;
  const reliableSends = new Set<Promise<void>>();
  const discoveries = new Map<AbortController, Promise<void>>();
  // 报文按到达顺序串行处理。handle 是 async，并发跑会让 config 后面紧跟的 prompt 先看到还没建好的 runner。
  let inbox: Promise<void> = Promise.resolve();
  const screen = createLiveScreen({
    chrome,
    uplink: (bytes, sent) => {
      if (link.phase !== "open" || link.socket.readyState !== WebSocket.OPEN || conn === null) return false;
      link.socket.send(bytes, { binary: true }, () => sent());
      return true;
    },
    log,
  });
  const login = createLogins({ chrome, present: screen.present, pages: defaultLoginPages, log }, loginTimeoutMs);
  const browserConfig: AgentRunnerConfig["browser"] = {
    profileDir: chrome.profileDir,
    connection: () => chrome.connection(),
    present: screen.present,
  };
  const sendBare = (message: AgentToControl): void => {
    if (link.phase !== "open" || link.socket.readyState !== WebSocket.OPEN) {
      log(`连接不在，丢弃 ${message.type}`);
      return;
    }
    if (message.type === "hello") {
      link.socket.send(JSON.stringify(message));
      return;
    }
    if (conn === null) {
      log(`welcome 之前不发送 ${message.type}`);
      return;
    }
    const frame = BareUplinkFrame.parse({ conn, body: message });
    link.socket.send(JSON.stringify(frame));
  };

  const sendStored = (frame: { readonly seq: number; readonly body: AgentToControl }): void => {
    if (
      link.phase !== "open" ||
      link.socket.readyState !== WebSocket.OPEN ||
      conn === null ||
      outbox === null ||
      frame.seq <= upSent
    )
      return;
    const socket = link.socket;
    const sendingConn = conn;
    // 不同调用方的 Promise 层数不同，后序帧可能先醒；发送顺序只认已落盘的发件箱。
    for (const pending of outbox.pending()) {
      if (pending.seq <= upSent) continue;
      if (pending.seq > frame.seq) break;
      const wireFrame = UplinkFrame.parse({
        type: "uplink",
        conn: sendingConn,
        stream: outbox.stream,
        seq: pending.seq,
        body: pending.body,
      });
      options.beforeReliableSend?.(wireFrame);
      if (
        link.phase !== "open" ||
        link.socket !== socket ||
        conn !== sendingConn ||
        socket.readyState !== WebSocket.OPEN
      )
        return;
      socket.send(JSON.stringify(wireFrame));
      upSent = pending.seq;
    }
  };

  const report = (message: AgentToControl): void => {
    if (UPLINK_DELIVERY[message.type] === "bare") {
      sendBare(message);
      return;
    }
    if (outbox === null) {
      if (resettingTransport) {
        resetReports.push(message);
        return;
      }
      log(`可靠发件箱未就绪，暂存不了 ${message.type}`);
      return;
    }
    let pending: Promise<void>;
    pending = outbox
      .append(message)
      .then(sendStored)
      .catch((error: unknown) => {
        log(`可靠上行落盘失败：${String(error)}`);
        void stop().catch((stopError: unknown) => log(`代理停机失败：${String(stopError)}`));
      })
      .finally(() => reliableSends.delete(pending));
    reliableSends.add(pending);
  };

  const workAppends = new WorkAppendChannel({
    connected: () =>
      !stopping &&
      link.phase === "open" &&
      link.socket.readyState === WebSocket.OPEN &&
      conn !== null &&
      outbox !== null,
    append: async (frame) => {
      const stored = await outbox!.append(frame);
      return { seq: stored.seq, body: frame };
    },
    send: sendStored,
    cancel: (lane, epoch) => runner?.cancel({ lane: { botId: lane.botId, groupId: lane.groupId }, epoch }),
    failed: (error) => {
      log(`工作记录探针落盘失败：${String(error)}`);
      void stop().catch((stopError: unknown) => log(`代理停机失败：${String(stopError)}`));
    },
  });

  const stopHeartbeat = (): void => {
    if (heartbeat === null) return;
    clearInterval(heartbeat);
    heartbeat = null;
  };

  const handle = async (raw: string, from: WebSocket): Promise<void> => {
    // socket.close() 之后 ws 仍会把已经到手的帧派发上来。停了还建 runner 的话就没人再停它。
    if (stopping || link.phase === "stopped") return;
    if (link.phase !== "open" || link.socket !== from) {
      log("收到已经换掉的连接报文，丢弃");
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      log("收到非 JSON 报文，丢弃");
      return;
    }
    const frame = json as { type?: unknown; generation?: unknown; seq?: unknown } | null;
    if (frame?.type === "uplink_ack") {
      const ack = UplinkAck.safeParse(json);
      if (!ack.success || outbox === null) {
        log(`收到无效 uplink_ack：${ack.success ? "发件箱未就绪" : ack.error.message}`);
        return;
      }
      await outbox.acknowledge(ack.data.upTo);
      workAppends.acknowledge(ack.data);
      for (const rejected of ack.data.rejected) {
        if (rejected.code === "run_closed" && rejected.runId !== undefined) runner?.cancel(rejected.runId);
        else log(`可靠上行 ${rejected.seq} 被拒收：${rejected.code}`);
      }
      return;
    }
    if (frame?.type === "downlink") {
      const parsedDownlink = DownlinkFrame.safeParse(json);
      if (!parsedDownlink.success || downlinkCursor === null || conn === null) {
        log(`收到无效 downlink：${parsedDownlink.success ? "游标未就绪" : parsedDownlink.error.message}`);
        return;
      }
      const downlink = parsedDownlink.data;
      if (downlink.seq <= downlinkCursor.applied) {
        sendBare({ type: "downlink_ack", upTo: downlinkCursor.applied });
        return;
      }
      await downlinkCursor.persist(downlink.seq);
      sendBare({ type: "downlink_ack", upTo: downlink.seq });
      await applyMessage(downlink.body, from);
      return;
    }
    const wrapped = json as { conn?: unknown; body?: unknown } | null;
    if (wrapped && Number.isInteger(wrapped.conn) && wrapped.body !== undefined) {
      if (conn === null || wrapped.conn !== conn) {
        log("收到其他连接代际的 bare 报文，丢弃");
        return;
      }
      json = wrapped.body;
    }
    await applyMessage(json, from);
  };

  const applyMessage = async (json: unknown, from: WebSocket): Promise<void> => {
    if (stopping || link.phase === "stopped") return;
    const frame = json as { type?: unknown; generation?: unknown } | null;
    if (conn === null && frame?.type !== "welcome") {
      log("welcome 之前收到控制面报文，丢弃");
      return;
    }
    const generation =
      frame?.type === "config" && Number.isInteger(frame.generation) && (frame.generation as number) > 0
        ? (frame.generation as number)
        : undefined;
    if (frame?.type === "config") {
      // 先按代际丢，再校验形状：旧代际的快照就算不合版本也不能回拒收，不然控制面会被一条晚到的旧报文卡在拒收上。
      // 旧连接上晚派发的 config 也不认：它的代际是上一条连接的号，收下会把这条连接的号顶乱。
      if (link.phase !== "open" || link.socket !== from) {
        log(`第 ${generation ?? "?"} 代 config 来自已经换掉的连接，丢弃`);
        return;
      }
      // 控制面并发重发时先开始读快照的那条可能后到，它的代际小、里面的账号状态旧，收下会盖掉新的。
      if (generation !== undefined && generation <= link.applied) {
        log(`第 ${generation} 代 config 比已应用的第 ${link.applied} 代旧，丢弃`);
        return;
      }
    }
    const parsed = ControlToAgent.safeParse(json);
    if (!parsed.success) {
      // config 被拒只在本地记一笔的话，控制面会一直往这台电脑派活，用户只看到活没人接。报回去让它停派。
      if (frame?.type === "config") {
        const paths = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "(整条)"))].join("、");
        log(`config 不合这个电脑代理的版本，丢弃。校验不过的字段：${paths}`);
        report({
          type: "agent_error",
          code: "config_rejected",
          ...(generation === undefined ? {} : { generation }),
          detail: `config 不合这个电脑代理的版本，校验不过的字段：${paths}`,
        });
        return;
      }
      log(`报文不合 ControlToAgent，丢弃：${parsed.error.message}`);
      return;
    }
    const message = parsed.data;
    switch (message.type) {
      case "mcp_discover": {
        const control = new AbortController();
        const discoveryConn = conn;
        const respond = (result: Awaited<ReturnType<typeof discoverMcpTools>>) => {
          if (stopping || link.phase !== "open" || link.socket !== from || conn !== discoveryConn) return;
          sendBare({ type: "mcp_discovered", requestId: message.requestId, result });
        };
        const pending = Promise.resolve()
          .then(() =>
            (options.discoverMcp ?? discoverMcpTools)(
              {
                url: message.url,
                ...(message.authorization === undefined ? {} : { authorization: message.authorization }),
              },
              { signal: control.signal },
            ),
          )
          .then(respond, (error: unknown) => respond({ ok: false, reason: classifyMcpDiscoveryFailure(error) }))
          .finally(() => discoveries.delete(control));
        discoveries.set(control, pending);
        return;
      }
      // welcome 才说明控制面收下了 hello。只看 TCP 连上就清零退避，会被「连上就踢」的控制面打成密集重连。
      case "welcome":
        if (conn !== null) return;
        if (outbox !== null && message.upAcked < outbox.acknowledged) {
          const previousOutbox = outbox;
          resettingTransport = true;
          outbox = null;
          downlinkCursor = null;
          await Promise.all(reliableSends);
          await previousOutbox.flush();
          if (stopping) return;
          try {
            await quarantineTransportState(dataDir, "服务器确认序号回退", options.log);
            const fresh = await ReliableOutbox.openForComputer(dataDir, options.computerId, options.log);
            outbox = fresh.outbox;
            downlinkCursor = fresh.downlinkCursor;
            resettingTransport = false;
            for (const body of resetReports.splice(0)) report(body);
            if (stopping) return;
            if (link.phase === "open" && link.socket === from) from.close();
            else if (link.phase === "waiting") {
              clearTimeout(link.timer);
              connect();
            }
          } catch (error) {
            log(`可靠传输状态重置失败：${String(error)}`);
            await stop();
          }
          return;
        }
        attempt = 0;
        await outbox?.acknowledge(message.upAcked);
        if (stopping || link.phase !== "open" || link.socket !== from) return;
        conn = message.conn;
        upSent = message.upAcked;
        log(`控制面已接纳，owner ${message.ownerId}`);
        process.stdout.write(`${JSON.stringify(AgentStatusLine.parse({ type: "online" }))}\n`);
        for (const pending of outbox?.pending() ?? []) sendStored(pending);
        stopHeartbeat();
        heartbeat = setInterval(() => sendBare({ type: "heartbeat", at: new Date().toISOString() }), heartbeatMs);
        heartbeat.unref();
        screen.reconnected();
        return;
      case "config": {
        attachmentConfig = { hub: message.hub, modelGateway: message.modelGateway };
        const config: AgentRunnerConfig = {
          computerId: options.computerId,
          bots: message.bots,
          tools: message.tools,
          accounts: message.accounts,
          grants: message.grants,
          modelGateway: message.modelGateway,
          accountsProxy: message.accountsProxy,
          mcpProxy: message.mcpProxy,
          hub: message.hub,
          // 不透传的话运行器按空数组对账，每来一条 config 就把所有 Bot 盘上的 skill 清空。
          skills: message.skills,
          brand: message.brand,
          preferences: message.preferences,
          dataDir,
          send: report,
          workAppend: (appendFrame) => workAppends.append(appendFrame),
          browser: browserConfig,
        };
        if (runner === null) {
          runner = makeRunner(config);
        } else {
          await runner.applyConfig(config);
        }
        // applyConfig 期间连接可能换了。这份配置已经进了运行器，但它的号属于旧连接，不能记到新连接头上，
        // 回执也不能经新连接发：新连接自己的第一代紧跟在后面（报文串行），运行器最后停在那一份上。
        if (link.phase !== "open" || link.socket !== from) {
          log(`第 ${message.generation} 代 config 应用完时连接已经换掉，不回执`);
          return;
        }
        link.applied = message.generation;
        log(
          `收到第 ${message.generation} 代 config，${message.bots.length} 个 Bot，${message.tools.length} 个工具连接`,
        );
        sendBare({ type: "config_applied", generation: message.generation });
        return;
      }
      case "prompt": {
        if (runner === null) {
          log(`还没收到 config，丢弃 run ${message.runId} 的 prompt`);
          report({
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
        runner.approve(message.runId, message.callId, message.outcome);
        return;
      }
      case "cancel":
        if (message.runId !== undefined) runner?.cancel(message.runId);
        else if (message.lane !== undefined && message.epoch !== undefined)
          runner?.cancel({ lane: message.lane, epoch: message.epoch });
        return;
      case "poker_result": {
        if (runner === null) {
          log(`还没收到 config，丢弃 run ${message.runId} 的出牌回执`);
          return;
        }
        runner.pokerResult(message.runId, message.callId, message.result);
        return;
      }
      case "browser_login":
        void login(message)
          .catch((error: unknown) => {
            log(`登录 ${message.platform} 出错：${String(error)}`);
            return { login: "failed", reason: "window_failed" } as const;
          })
          .then((result) => {
            if (result.login === "abandoned") return;
            report({
              type: "login_state",
              accountId: message.accountId,
              state: result.login === "failed" ? { ...result, attempt: message.attempt } : result,
            });
          });
        return;
      case "pause":
        await runner?.pause(message.botId);
        return;
      case "resume":
        void runner?.resume(message.botId).catch((error: unknown) => log(`恢复 Bot 失败：${String(error)}`));
        return;
      case "publish_draft":
        void publishDraft(message, {
          dataDir,
          browser: chrome.kind === "local" ? browserConfig : null,
          liveHub: () => {
            if (attachmentConfig === null) throw new Error("附件配置尚未下发");
            return { hub: attachmentConfig.hub, gateway: attachmentConfig.modelGateway };
          },
        }).then(report, (error: unknown) => log(`发布草稿 ${message.draftId} 出错：${String(error)}`));
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
    if (stopping || resettingTransport) return;
    const socket = new WebSocket(options.url);
    link = { phase: "connecting", socket };

    socket.on("open", () => {
      if (stopping) return;
      conn = null;
      link = { phase: "open", socket, applied: 0 };
      stopHeartbeat();
      void outbox
        ?.flush()
        .then(() => {
          if (stopping || link.phase !== "open" || link.socket !== socket) return;
          const pendingRuns = (outbox?.pending() ?? []).flatMap(({ body }) =>
            "runId" in body && body.runId !== undefined && body.runId !== null ? [body.runId] : [],
          );
          const activeRuns = new Set([...(runner?.activeRuns() ?? []), ...pendingRuns]);
          socket.send(
            JSON.stringify({
              type: "hello",
              computerId: options.computerId,
              token: options.token,
              version: options.version,
              protocol: AGENT_PROTOCOL,
              installId,
              piSessionVersion: CURRENT_SESSION_VERSION,
              uplinkStream: outbox?.stream,
              downApplied: downlinkCursor?.applied,
              activeRuns: [...activeRuns],
            }),
          );
          log(`已发 hello，报告 ${activeRuns.size} 个仍在跑或待确认的 run`);
        })
        .catch((error: unknown) => {
          log(`握手前落盘失败：${String(error)}`);
          void stop().catch((stopError: unknown) => log(`代理停机失败：${String(stopError)}`));
        });
    });

    socket.on("message", (data, isBinary) => {
      if (stopping) return;
      // 画面面：不进 inbox，不进 handle，出错也不记原文，里面可能是人敲的密码。
      if (isBinary) {
        if (link.phase !== "open" || link.socket !== socket) return;
        try {
          screen.receive(bytesOf(data));
        } catch {
          log("画面帧处理出错");
        }
        return;
      }
      const raw = data.toString();
      inbox = inbox.then(() => handle(raw, socket)).catch((error: unknown) => log(`处理报文出错：${String(error)}`));
    });

    socket.on("error", (error) => {
      if (link.phase === "stopped") return;
      log(`连接出错：${error.message}`);
    });

    socket.on("close", (code) => {
      if ((link.phase !== "open" && link.phase !== "connecting") || link.socket !== socket) return;
      workAppends.disconnect();
      stopHeartbeat();
      for (const control of discoveries.keys()) control.abort();
      if (code === AgentCloseCode.displaced) {
        process.stdout.write(`${JSON.stringify(AgentStatusLine.parse({ type: "displaced" }))}\n`);
        void stop().catch((error: unknown) => log(`代理停机失败：${String(error)}`));
        return;
      }
      if (code === AgentCloseCode.accountDeleted) {
        void stop().catch((error: unknown) => log(`代理停机失败：${String(error)}`));
        return;
      }
      if (code === AgentCloseCode.upgradeRequired) {
        process.stdout.write(`${JSON.stringify(AgentStatusLine.parse({ type: "upgrade_required" }))}\n`);
        void stop().catch((error: unknown) => log(`代理停机失败：${String(error)}`));
        return;
      }
      scheduleReconnect();
    });
  }

  void Promise.all([ReliableOutbox.openForComputer(dataDir, options.computerId, options.log), loadInstallId(dataDir)])
    .then(([{ outbox: openedOutbox, downlinkCursor: openedCursor }, openedInstallId]) => {
      outbox = openedOutbox;
      downlinkCursor = openedCursor;
      installId = openedInstallId;
      if (!stopping) connect();
    })
    .catch((error: unknown) => {
      log(`可靠传输状态加载失败：${String(error)}`);
      void stop();
    });

  function stop(): Promise<void> {
    if (stopPromise !== null) return stopPromise;
    stopping = true;
    for (const control of discoveries.keys()) control.abort();
    workAppends.disconnect();
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
      await outbox?.flush().catch((error: unknown) => log(`停机落盘失败：${String(error)}`));
      await Promise.all(reliableSends);
      await Promise.allSettled(discoveries.values());
      await chromeStopping;

      const current = link;
      link = { phase: "stopped" };
      stopHeartbeat();
      if (current.phase === "waiting") clearTimeout(current.timer);
      if (current.phase === "connecting" || current.phase === "open") current.socket.close();
    })();
    return stopPromise;
  }

  return { stop };
}
