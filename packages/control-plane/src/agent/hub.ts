import { AgentToControl, ControlToAgent, type ComputerId, type MessageId, type UserId } from "@baize/shared";
import type { WebSocket } from "ws";
import type { Db } from "../db/client.js";
import { listBots } from "../repo/bots.js";
import {
  authenticateComputer,
  markComputerOnline,
  markComputerSleeping,
  markComputersSleeping,
  rotateGatewayKey,
} from "../repo/computers.js";
import type { PushHub } from "../ws/hub.js";
import { handleAgentEvent } from "./events.js";
import type { MentionLoopGuard } from "./mention-loop.js";

export const AGENT_PATH = "/agent";

/** 连上来不报 hello 就白占一条连接。 */
const HELLO_TIMEOUT_MS = 10_000;

const CLOSE_SUPERSEDED = 4000;
const CLOSE_BAD_HELLO = 4001;

export type AgentConnection = {
  readonly computerId: ComputerId;
  readonly ownerId: UserId;
  readonly socket: WebSocket;
  /** 这条连接下发给电脑的网关 key 明文。hello 时现生成，只活在这条连接上。 */
  readonly gatewayKey: string;
  /** callId 到群里那条工具调用消息。进程重启会丢，重启后同一个 callId 会另起一条消息。 */
  readonly toolCallMessages: Map<string, MessageId>;
};

export type AgentHubDeps = {
  readonly db: Db;
  readonly push: PushHub;
  readonly gatewayModel: string;
  readonly priceInputPerM: number;
  readonly priceOutputPerM: number;
  /** 和 createApp 收的是同一个实例：Bot 之间 @ 的计数要被上行 mention 和用户消息两边碰到。 */
  readonly mentionLoop: MentionLoopGuard;
  /** 监听端口在建 hub 之后才知道，所以基址是现取的。 */
  readonly gatewayBaseUrl: () => string;
};

/** 电脑代理的连接表。一人一台电脑（computers.owner_id 唯一），按 owner 索引就等于按电脑索引。 */
export class AgentHub {
  readonly #deps: AgentHubDeps;
  readonly #connections = new Map<string, AgentConnection>();

  constructor(deps: AgentHubDeps) {
    this.#deps = deps;
  }

  /** 握手之后才算这台电脑在线。升级时不认身份，认不认得上由 hello 决定。 */
  accept(socket: WebSocket): void {
    let conn: AgentConnection | null = null;
    const deadline = setTimeout(() => socket.close(CLOSE_BAD_HELLO, "没有报 hello"), HELLO_TIMEOUT_MS);
    deadline.unref();

    // 报文按到达顺序串行处理。并发跑的话三段 delta 会乱序落库，config 后面紧跟的 prompt 也可能先到。
    let inbox: Promise<void> = Promise.resolve();

    socket.on("message", (raw) => {
      const text = raw.toString();
      inbox = inbox
        .then(async () => {
          conn = await this.#onFrame(socket, conn, deadline, text);
        })
        .catch((error: unknown) => console.error("处理电脑代理报文出错", error));
    });

    socket.on("error", () => socket.close());

    // 关闭也排在同一条链上。hello 还在查库时断开的话，直接读 conn 会读到 null，那台电脑就永远挂在在线。
    socket.on("close", () => {
      clearTimeout(deadline);
      inbox = inbox
        .then(async () => {
          const closed = conn;
          if (closed === null) return;
          // 被新连接顶掉的那条关闭时，表里挂的已经是新连接，不能把在线的那台写成休眠。
          if (this.#connections.get(closed.ownerId) !== closed) return;
          this.#connections.delete(closed.ownerId);
          await markComputerSleeping(this.#deps.db, closed.computerId);
        })
        .catch((error: unknown) => console.error("把电脑标记为休眠出错", error));
    });
  }

  isOnline(ownerId: UserId): boolean {
    const conn = this.#connections.get(ownerId);
    return conn !== undefined && conn.socket.readyState === conn.socket.OPEN;
  }

  send(ownerId: UserId, message: ControlToAgent): boolean {
    const conn = this.#connections.get(ownerId);
    if (conn === undefined) return false;
    return this.#send(conn, message);
  }

  /** Bot 增删改之后重发，电脑代理会按新的 Bot 列表重建运行器。 */
  async sendConfig(ownerId: UserId): Promise<void> {
    const conn = this.#connections.get(ownerId);
    if (conn === undefined) return;
    await this.#sendConfig(conn);
  }

  /** 先落库再断线：反过来的话 socket 的 close 回调要和进程退出抢，那台电脑就永远挂在在线。 */
  async closeAll(): Promise<void> {
    const open = [...this.#connections.values()];
    await markComputersSleeping(
      this.#deps.db,
      open.map((conn) => conn.computerId),
    );
    for (const conn of open) conn.socket.close();
    this.#connections.clear();
  }

  async #onFrame(
    socket: WebSocket,
    conn: AgentConnection | null,
    deadline: NodeJS.Timeout,
    raw: string,
  ): Promise<AgentConnection | null> {
    const message = parseFrame(raw);
    if (message === null) return conn;

    if (conn !== null) {
      await handleAgentEvent(
        {
          db: this.#deps.db,
          push: this.#deps.push,
          agents: this,
          mentionLoop: this.#deps.mentionLoop,
          priceInputPerM: this.#deps.priceInputPerM,
          priceOutputPerM: this.#deps.priceOutputPerM,
        },
        conn,
        message,
      );
      return conn;
    }

    // 还没认上身份，除了 hello 一律不理。
    if (message.type !== "hello") return null;
    clearTimeout(deadline);

    const computer = await authenticateComputer(this.#deps.db, message.computerId, message.token);
    if (computer === null) {
      socket.close(CLOSE_BAD_HELLO, "电脑号或 token 对不上");
      return null;
    }

    const gatewayKey = await rotateGatewayKey(this.#deps.db, computer.id);
    const accepted: AgentConnection = {
      computerId: computer.id,
      ownerId: computer.ownerId,
      socket,
      gatewayKey,
      toolCallMessages: new Map(),
    };

    const previous = this.#connections.get(computer.ownerId);
    this.#connections.set(computer.ownerId, accepted);
    previous?.socket.close(CLOSE_SUPERSEDED, "同一台电脑有了新连接");

    await markComputerOnline(this.#deps.db, computer.id);
    this.#send(accepted, { type: "welcome", ownerId: computer.ownerId, serverTime: new Date().toISOString() });
    await this.#sendConfig(accepted);
    return accepted;
  }

  async #sendConfig(conn: AgentConnection): Promise<void> {
    const items = await listBots(this.#deps.db, conn.ownerId);
    this.#send(conn, {
      type: "config",
      bots: items.map((item) => ({ id: item.bot.id, name: item.bot.name, description: item.bot.description })),
      // 工具连接是 M6 的对象，这一版恒为空。
      tools: [],
      modelGateway: {
        baseUrl: `${this.#deps.gatewayBaseUrl()}/gateway/v1`,
        apiKey: conn.gatewayKey,
        model: this.#deps.gatewayModel,
      },
    });
  }

  #send(conn: AgentConnection, message: ControlToAgent): boolean {
    if (conn.socket.readyState !== conn.socket.OPEN) return false;
    conn.socket.send(JSON.stringify(ControlToAgent.parse(message)));
    return true;
  }
}

function parseFrame(raw: string): AgentToControl | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = AgentToControl.safeParse(json);
  return parsed.success ? parsed.data : null;
}
