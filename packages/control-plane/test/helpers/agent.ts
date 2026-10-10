import { ControlToAgent, type AgentToControl, type ComputerId, type RunId } from "@baize/shared";
import { WebSocket } from "ws";
import { AGENT_PATH } from "../../src/agent/hub.js";

/** 扮演电脑代理。测试只通过这条 WebSocket 碰 /agent。 */
export type AgentClient = {
  readonly socket: WebSocket;
  send(message: AgentToControl): void;
  next(timeoutMs?: number): Promise<ControlToAgent>;
  expect<T extends ControlToAgent["type"]>(type: T, timeoutMs?: number): Promise<Extract<ControlToAgent, { type: T }>>;
  /**
   * 等控制面回这个 run 的第 nth 条 run_done_ack。确认帧不进 next、expect、received：每条 run_done 都会回一条，
   * 混在下行里的话，只关心派活和握手的用例都得跳过它。
   */
  ack(runId: RunId, nth?: number, timeoutMs?: number): Promise<void>;
  /** 到现在为止收到这个 run 的几条 run_done_ack。 */
  ackCount(runId: RunId): number;
  /** 连接关闭时的 close code。 */
  closed(timeoutMs?: number): Promise<number>;
  /** 收到还没取走的报文。关闭帧之后不会再来，所以 closed 兑现之后这就是这条连接收到的全部。 */
  received(): readonly ControlToAgent[];
  close(): void;
};

export async function openAgent(port: number): Promise<AgentClient> {
  const socket = new WebSocket(`ws://localhost:${port}${AGENT_PATH}`);
  const inbox: ControlToAgent[] = [];
  const waiters: ((message: ControlToAgent) => void)[] = [];
  let closeCode: number | null = null;
  const closeWaiters: ((code: number) => void)[] = [];
  const acks: RunId[] = [];
  const ackWaiters: (() => void)[] = [];

  socket.on("message", (raw) => {
    const message = ControlToAgent.parse(JSON.parse(raw.toString()));
    if (message.type === "run_done_ack") {
      acks.push(message.runId);
      for (const waiter of ackWaiters.splice(0)) waiter();
      return;
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
    send: (message) => socket.send(JSON.stringify(message)),
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
        if (left <= 0) throw new Error(`等 ${runId} 的第 ${nth} 条 run_done_ack 超时，已收到 ${JSON.stringify(acks)}`);
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
    received: () => [...inbox],
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

export async function helloAgent(
  port: number,
  computerId: ComputerId,
  token: string,
  activeRuns: readonly RunId[] = [],
): Promise<HelloResult> {
  const agent = await openAgent(port);
  sendHello(agent, computerId, token, activeRuns);
  return { agent, ...(await expectHello(agent)) };
}

export function sendHello(
  agent: AgentClient,
  computerId: ComputerId,
  token: string,
  activeRuns: readonly RunId[] = [],
): void {
  agent.send({ type: "hello", computerId, token, version: "test", activeRuns: [...activeRuns] });
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
