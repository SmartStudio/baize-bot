import {
  AGENT_PROTOCOL,
  BareUplinkFrame,
  ControlToAgent,
  controlOriginFromAgentUrl,
  decodeLive,
  DownlinkFrame,
  LiveDown,
  UPLINK_DELIVERY,
  UplinkAck,
  type AgentToControl,
  type ComputerId,
  type RunId,
} from "@baize/shared";
import { WebSocket } from "ws";
import { AGENT_PATH } from "../../src/agent/hub.js";
import { bytesOf } from "../../src/live/relay.js";

/** 扮演电脑代理。测试只通过这条 WebSocket 碰 /agent。 */
export type AgentClient = {
  readonly socket: WebSocket;
  send(message: AgentToControl | LegacyBotText): void;
  next(timeoutMs?: number): Promise<ControlToAgent>;
  expect<T extends ControlToAgent["type"]>(type: T, timeoutMs?: number): Promise<Extract<ControlToAgent, { type: T }>>;
  /**
   * 等控制面累计确认这个 run 的第 nth 条 run_done。uplink_ack 不进 next、expect、received。
   */
  ack(runId: RunId, nth?: number, timeoutMs?: number): Promise<void>;
  /** 到现在为止累计确认这个 run 的几条 run_done。 */
  ackCount(runId: RunId): number;
  /** 控制面已接收的累计确认帧，包括被拒帧。 */
  uplinkAcks(): readonly UplinkAck[];
  /** 用当前连接和下一个序号发送结构无效的可靠帧。 */
  sendMalformedReliable(body: unknown): number;
  /** 连接关闭时的 close code。 */
  closed(timeoutMs?: number): Promise<number>;
  /** 收到还没取走的报文。关闭帧之后不会再来，所以 closed 兑现之后这就是这条连接收到的全部。 */
  received(): readonly ControlToAgent[];
  /** 画面面：原样发一条二进制帧。 */
  sendLive(bytes: Uint8Array): void;
  /** 画面面：下一条二进制下行，按 LiveDown 解头。和 next 各排各的队。 */
  nextLive(timeoutMs?: number): Promise<LiveDown>;
  close(): void;
};

type LegacyBotText = {
  type: "bot_text";
  runId: Extract<AgentToControl, { type: "bot_text" }>["runId"];
  botId: Extract<AgentToControl, { type: "bot_text" }>["botId"];
  groupId: Extract<AgentToControl, { type: "bot_text" }>["groupId"];
  messageId: Extract<AgentToControl, { type: "bot_text" }>["messageId"];
  delta: string;
  done: boolean;
};

export async function openAgent(port: number, options: { readonly ackDownlink?: boolean } = {}): Promise<AgentClient> {
  const socket = new WebSocket(`ws://localhost:${port}${AGENT_PATH}`);
  const inbox: ControlToAgent[] = [];
  const waiters: ((message: ControlToAgent) => void)[] = [];
  let closeCode: number | null = null;
  const closeWaiters: ((code: number) => void)[] = [];
  const doneSeqs = new Map<number, RunId>();
  const acks: RunId[] = [];
  const uplinkAcks: UplinkAck[] = [];
  const ackWaiters: (() => void)[] = [];
  const textByMessage = new Map<string, string>();
  let conn: number | null = null;
  let uplinkStream = "";
  let nextSeq = 1;
  let downApplied = 0;
  const liveInbox: LiveDown[] = [];
  const liveWaiters: ((message: LiveDown) => void)[] = [];

  const sendBody = (message: AgentToControl): void => {
    if (message.type === "hello") {
      uplinkStream = message.uplinkStream;
      downApplied = message.downApplied;
      socket.send(JSON.stringify(message));
      return;
    }
    if (conn === null) throw new Error("收到 welcome 前不能发上行报文");
    if (UPLINK_DELIVERY[message.type] === "bare") {
      socket.send(JSON.stringify(BareUplinkFrame.parse({ conn, body: message })));
      return;
    }
    const seq = nextSeq++;
    socket.send(JSON.stringify({ type: "uplink", conn, stream: uplinkStream, seq, body: message }));
    if (message.type === "run_done") doneSeqs.set(seq, message.runId);
  };

  socket.on("message", (raw, isBinary) => {
    if (isBinary) {
      const decoded = decodeLive(LiveDown, bytesOf(raw));
      if (decoded === null) throw new Error("控制面发来的二进制帧不合 LiveDown");
      const waiter = liveWaiters.shift();
      if (waiter === undefined) liveInbox.push(decoded.header);
      else waiter(decoded.header);
      return;
    }
    const value: unknown = JSON.parse(raw.toString());
    if (typeof value === "object" && value !== null && "type" in value && value.type === "uplink_ack") {
      const ack = UplinkAck.parse(value);
      uplinkAcks.push(ack);
      const rejected = new Set(ack.rejected.map((entry) => entry.seq));
      for (const [seq, runId] of doneSeqs) {
        if (seq <= ack.upTo) {
          if (!rejected.has(seq)) acks.push(runId);
          doneSeqs.delete(seq);
        }
      }
      for (const waiter of ackWaiters.splice(0)) waiter();
      return;
    }
    if (typeof value === "object" && value !== null && "type" in value && value.type === "downlink") {
      const frame = DownlinkFrame.parse(value);
      downApplied = Math.max(downApplied, frame.seq);
      if (options.ackDownlink !== false) sendBody({ type: "downlink_ack", upTo: downApplied });
      const message = frame.body;
      const waiter = waiters.shift();
      if (waiter === undefined) inbox.push(message);
      else waiter(message);
      return;
    }
    const message = ControlToAgent.parse(value);
    if (message.type === "welcome") {
      conn = message.conn;
      nextSeq = message.upAcked + 1;
    }
    const waiter = waiters.shift();
    if (waiter === undefined) inbox.push(message);
    else waiter(message);
  });
  socket.on("close", (code) => {
    closeCode = code;
    for (const waiter of closeWaiters.splice(0)) waiter(code);
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  const next = (timeoutMs = 5000): Promise<ControlToAgent> =>
    new Promise((resolve, reject) => {
      const buffered = inbox.shift();
      if (buffered !== undefined) {
        resolve(buffered);
        return;
      }
      const waiter = (message: ControlToAgent) => {
        clearTimeout(timer);
        resolve(message);
      };
      const timer = setTimeout(() => {
        const at = waiters.indexOf(waiter);
        if (at !== -1) waiters.splice(at, 1);
        reject(new Error("等控制面下发报文超时"));
      }, timeoutMs);
      waiters.push(waiter);
    });

  return {
    socket,
    send: (message) => {
      if (message.type === "bot_text") {
        const key = `${message.runId}:${message.messageId}`;
        const text = (textByMessage.get(key) ?? "") + message.delta;
        if (message.done) {
          textByMessage.delete(key);
          sendBody({
            type: "bot_text_done",
            runId: message.runId,
            botId: message.botId,
            groupId: message.groupId,
            messageId: message.messageId,
            text,
          });
        } else {
          textByMessage.set(key, text);
          sendBody({ ...message, done: false });
        }
        return;
      }
      sendBody(message);
    },
    next,
    expect: async (type, timeoutMs) => {
      const message = await next(timeoutMs);
      if (message.type !== type) throw new Error(`本应收到 ${type}，实际是 ${message.type}`);
      return message as Extract<ControlToAgent, { type: typeof type }>;
    },
    closed: (timeoutMs = 5000) =>
      new Promise((resolve, reject) => {
        if (closeCode !== null) {
          resolve(closeCode);
          return;
        }
        const waiter = (code: number) => {
          clearTimeout(timer);
          resolve(code);
        };
        const timer = setTimeout(() => reject(new Error("等连接关闭超时")), timeoutMs);
        closeWaiters.push(waiter);
      }),
    ack: async (runId, nth = 1, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;
      while (acks.filter((acked) => acked === runId).length < nth) {
        const left = deadline - Date.now();
        if (left <= 0)
          throw new Error(`等 ${runId} 的第 ${nth} 条 run_done 累计确认超时，已收到 ${JSON.stringify(acks)}`);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, left);
          ackWaiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
    ackCount: (runId) => acks.filter((acked) => acked === runId).length,
    uplinkAcks: () => [...uplinkAcks],
    sendMalformedReliable: (body) => {
      if (conn === null) throw new Error("收到 welcome 前不能发上行报文");
      const seq = nextSeq++;
      socket.send(JSON.stringify({ type: "uplink", conn, stream: uplinkStream, seq, body }));
      return seq;
    },
    received: () => [...inbox],
    sendLive: (bytes) => socket.send(bytes),
    nextLive: (timeoutMs = 5000) =>
      new Promise((resolve, reject) => {
        const buffered = liveInbox.shift();
        if (buffered !== undefined) {
          resolve(buffered);
          return;
        }
        const waiter = (message: LiveDown) => {
          clearTimeout(timer);
          resolve(message);
        };
        const timer = setTimeout(() => {
          const at = liveWaiters.indexOf(waiter);
          if (at !== -1) liveWaiters.splice(at, 1);
          reject(new Error("等控制面下发画面帧超时"));
        }, timeoutMs);
        liveWaiters.push(waiter);
      }),
    close: () => socket.close(),
  };
}

export type HelloResult = {
  readonly agent: AgentClient;
  readonly welcome: Extract<ControlToAgent, { type: "welcome" }>;
  readonly config: Extract<ControlToAgent, { type: "config" }>;
  /** config 后面紧跟的补发，config 里每个 Bot 恰好一条 pause 或 resume。 */
  readonly runStates: readonly Extract<ControlToAgent, { type: "pause" | "resume" }>[];
};

export type HelloOverrides = {
  readonly installId?: string;
  readonly piSessionVersion?: number;
  readonly protocol?: number;
  readonly controlOrigin?: string;
};

export async function helloAgent(
  port: number,
  computerId: ComputerId,
  token: string,
  activeRuns: readonly RunId[] = [],
  overrides: HelloOverrides = {},
): Promise<HelloResult> {
  const agent = await openAgent(port);
  sendHello(agent, computerId, token, activeRuns, overrides);
  return { agent, ...(await expectHello(agent)) };
}

export function sendHello(
  agent: AgentClient,
  computerId: ComputerId,
  token: string,
  activeRuns: readonly RunId[] = [],
  overrides: HelloOverrides = {},
): void {
  agent.send({
    type: "hello",
    computerId,
    token,
    version: "test",
    protocol: overrides.protocol ?? AGENT_PROTOCOL,
    controlOrigin: overrides.controlOrigin ?? controlOriginFromAgentUrl(agent.socket.url),
    installId: overrides.installId ?? computerId,
    piSessionVersion: overrides.piSessionVersion ?? 3,
    uplinkStream: computerId,
    downApplied: 0,
    activeRuns: [...activeRuns],
  });
}

/** 收 hello 的回应：welcome、config，再按 config 里的 Bot 顺序各收一条 pause 或 resume。 */
export async function expectHello(agent: AgentClient): Promise<Omit<HelloResult, "agent">> {
  const welcome = await agent.expect("welcome");
  const config = await agent.expect("config");
  const runStates: Extract<ControlToAgent, { type: "pause" | "resume" }>[] = [];
  for (const bot of config.bots) {
    // 缺了要说清缺的是谁，不然只看到一个通用超时。
    const synced = await agent.next().catch(() => {
      throw new Error(
        `config 之后等不到 ${bot.id} 的运行状态补发，已收到 ${runStates.length}/${config.bots.length} 条：${JSON.stringify(runStates)}`,
      );
    });
    if ((synced.type !== "pause" && synced.type !== "resume") || synced.botId !== bot.id) {
      throw new Error(`config 之后本应按顺序补发 ${bot.id} 的运行状态，实际是 ${JSON.stringify(synced)}`);
    }
    runStates.push(synced);
  }
  return { welcome, config, runStates };
}
