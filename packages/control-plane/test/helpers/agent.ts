import { ControlToAgent, type AgentToControl, type ComputerId, type RunId } from "@baize/shared";
import { WebSocket } from "ws";
import { AGENT_PATH } from "../../src/agent/hub.js";

/** 扮演电脑代理。测试只通过这条 WebSocket 碰 /agent。 */
export type AgentClient = {
  readonly socket: WebSocket;
  send(message: AgentToControl): void;
  next(timeoutMs?: number): Promise<ControlToAgent>;
  expect<T extends ControlToAgent["type"]>(type: T, timeoutMs?: number): Promise<Extract<ControlToAgent, { type: T }>>;
  /** 连接关闭时的 close code。 */
  closed(timeoutMs?: number): Promise<number>;
  close(): void;
};

export async function openAgent(port: number): Promise<AgentClient> {
  const socket = new WebSocket(`ws://localhost:${port}${AGENT_PATH}`);
  const inbox: ControlToAgent[] = [];
  const waiters: ((message: ControlToAgent) => void)[] = [];
  let closeCode: number | null = null;
  const closeWaiters: ((code: number) => void)[] = [];

  socket.on("message", (raw) => {
    const message = ControlToAgent.parse(JSON.parse(raw.toString()));
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
  agent.send({ type: "hello", computerId, token, version: "test", activeRuns: [...activeRuns] });
  const welcome = await agent.expect("welcome");
  const config = await agent.expect("config");
  const runStates: Extract<ControlToAgent, { type: "pause" | "resume" }>[] = [];
  for (const bot of config.bots) {
    const synced = await agent.next();
    if ((synced.type !== "pause" && synced.type !== "resume") || synced.botId !== bot.id) {
      throw new Error(`config 之后本应按顺序补发 ${bot.id} 的运行状态，实际是 ${JSON.stringify(synced)}`);
    }
    runStates.push(synced);
  }
  return { agent, welcome, config, runStates };
}
