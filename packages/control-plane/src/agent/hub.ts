import {
  AgentToControl,
  ControlToAgent,
  type ComputerId,
  type MessageId,
  type RunId,
  type UserId,
} from "@baize/shared";
import type { WebSocket } from "ws";
import type { Db } from "../db/client.js";
import type { ToolCrypto } from "../crypto.js";
import type { NoticePublisher } from "../notifications.js";
import { ensureAssistant, listBots } from "../repo/bots.js";
import {
  authenticateComputer,
  markComputerOnline,
  markComputerSleeping,
  markComputersSleeping,
  rotateGatewayKey,
} from "../repo/computers.js";
import { expireApprovalsOfRun } from "../repo/approvals.js";
import { listGrants } from "../repo/grants.js";
import { listSkillsByOwner } from "../repo/skills.js";
import { appendMessage, failRunningToolCalls } from "../repo/messages.js";
import { finishRun, openRunsForComputer } from "../repo/runs.js";
import { listToolConfigs } from "../repo/tools.js";
import { EXPIRED_APPROVAL_NOTE, failRoutineRunOf } from "../routines/run.js";
import type { PushHub } from "../ws/hub.js";
import { clearTextPrefixes, handleAgentEvent } from "./events.js";
import type { GroupTurns } from "./group-turn.js";

export const AGENT_PATH = "/agent";

/** 连上来不报 hello 就白占一条连接。 */
const HELLO_TIMEOUT_MS = 10_000;

const CLOSE_SUPERSEDED = 4000;
const CLOSE_BAD_HELLO = 4001;
const DISCONNECT_NOTICE = "电脑断过线，这次活没做完";
const DEFAULT_DISCONNECT_GRACE_MS = 15_000;

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
  readonly priceInputPerM: number;
  readonly priceOutputPerM: number;
  readonly groupTurns: GroupTurns;
  /** 监听端口在建 hub 之后才知道，所以基址是现取的。 */
  readonly gatewayBaseUrl: () => string;
  readonly disconnectGraceMs?: number | undefined;
  readonly toolCrypto: ToolCrypto;
  readonly notifications: NoticePublisher;
};

/** 电脑代理的连接表。同一个用户可以同时有本机和远程两条连接，连接只按电脑号互相替换。 */
export class AgentHub {
  readonly #deps: AgentHubDeps;
  readonly #connections = new Map<ComputerId, AgentConnection>();
  readonly #graceTimers = new Map<ComputerId, NodeJS.Timeout>();
  readonly #finishChains = new Map<ComputerId, Promise<void>>();
  readonly #pendingFinishes = new Set<Promise<void>>();
  readonly #sleepingWrites = new Map<ComputerId, Promise<void>>();

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
          if (this.#connections.get(closed.computerId) !== closed) return;
          this.#connections.delete(closed.computerId);
          const timer = setTimeout(() => {
            this.#graceTimers.delete(closed.computerId);
            const job = this.#enqueueFinish(closed.computerId, async () => {
              if (this.isOnline(closed.computerId)) return;
              await this.#finishMissingRuns(closed.computerId, closed.ownerId, [], () =>
                this.isOnline(closed.computerId),
              );
            }).catch((error: unknown) => console.error("断连后收尾 run 出错", error));
            this.#pendingFinishes.add(job);
            void job.then(() => this.#pendingFinishes.delete(job));
          }, this.#deps.disconnectGraceMs ?? DEFAULT_DISCONNECT_GRACE_MS);
          timer.unref();
          this.#graceTimers.set(closed.computerId, timer);
          const sleeping = markComputerSleeping(this.#deps.db, closed.computerId).then((computer) => {
            if (computer !== null) this.#deps.push.push(closed.ownerId, { type: "computer_updated", computer });
          });
          this.#sleepingWrites.set(closed.computerId, sleeping);
          try {
            await sleeping;
          } finally {
            if (this.#sleepingWrites.get(closed.computerId) === sleeping)
              this.#sleepingWrites.delete(closed.computerId);
          }
        })
        .catch((error: unknown) => console.error("把电脑标记为休眠出错", error));
    });
  }

  isOnline(computerId: ComputerId): boolean {
    const conn = this.#connections.get(computerId);
    return conn !== undefined && conn.socket.readyState === conn.socket.OPEN;
  }

  send(computerId: ComputerId, message: ControlToAgent): boolean {
    const conn = this.#connections.get(computerId);
    if (conn === undefined) return false;
    return this.#send(conn, message);
  }

  /** 这个用户在线的每台电脑各发一条。暂停和继续不知道 Bot 的活在哪台电脑上，所以都发。 */
  sendToOwner(ownerId: UserId, message: ControlToAgent): void {
    for (const connection of this.#ownerConnections(ownerId)) this.#send(connection, message);
  }

  /** Bot 或授权变了之后重发，电脑代理会按新的 Bot 列表和授权对账运行器。 */
  async sendConfig(ownerId: UserId): Promise<void> {
    await Promise.all(this.#ownerConnections(ownerId).map((connection) => this.#sendConfig(connection, "changed")));
  }

  #ownerConnections(ownerId: UserId): AgentConnection[] {
    return [...this.#connections.values()].filter((connection) => connection.ownerId === ownerId);
  }

  /** 先落库再断线：反过来的话 socket 的 close 回调要和进程退出抢，那台电脑就永远挂在在线。 */
  async closeAll(): Promise<void> {
    for (const timer of this.#graceTimers.values()) clearTimeout(timer);
    this.#graceTimers.clear();
    await Promise.all(this.#pendingFinishes);
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
          groupTurns: this.#deps.groupTurns,
          priceInputPerM: this.#deps.priceInputPerM,
          priceOutputPerM: this.#deps.priceOutputPerM,
          notifications: this.#deps.notifications,
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

    const previous = this.#connections.get(computer.id);
    this.#connections.set(computer.id, accepted);
    const timer = this.#graceTimers.get(computer.id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#graceTimers.delete(computer.id);
    }
    previous?.socket.close(CLOSE_SUPERSEDED, "同一台电脑有了新连接");

    await this.#enqueueFinish(computer.id, async () => {
      await this.#sleepingWrites.get(computer.id);
      await this.#finishMissingRuns(computer.id, computer.ownerId, message.activeRuns);
    });
    const online = await markComputerOnline(this.#deps.db, computer.id);
    if (online !== null) this.#deps.push.push(computer.ownerId, { type: "computer_updated", computer: online });
    await this.#deps.notifications.computerOnline(computer.ownerId);
    this.#send(accepted, {
      type: "welcome",
      ownerId: computer.ownerId,
      kind: computer.kind,
      serverTime: new Date().toISOString(),
    });
    // 登录时补建管不到会话还有效的老用户，他们下次登录前一直没有主助理。hello 这里再补一次，
    // 撞部分唯一索引的那次什么都不做，所以和并发的登录谁先谁后都只建一个。
    const assistant = await this.#deps.db.transaction((tx) => ensureAssistant(tx, computer.ownerId));
    await this.#sendConfig(accepted, "hello");
    if (assistant !== null) {
      const others = this.#ownerConnections(computer.ownerId).filter((connection) => connection !== accepted);
      await Promise.all(others.map((connection) => this.#sendConfig(connection, "changed")));
    }
    return accepted;
  }

  async #finishMissingRuns(
    computerId: ComputerId,
    ownerId: UserId,
    activeRuns: readonly RunId[],
    shouldStop: (() => boolean) | undefined = undefined,
  ): Promise<void> {
    const active = new Set(activeRuns);
    for (const run of await openRunsForComputer(this.#deps.db, computerId)) {
      if (shouldStop?.()) return;
      if (active.has(run.runId)) continue;
      if (shouldStop?.()) return;
      const result = await this.#deps.db.transaction(async (tx) => {
        const usage = await finishRun(tx, run.runId, run.groupId, {
          steps: 0,
          inputTokens: 0,
          outputTokens: 0,
          amount: 0,
        });
        if (usage === null) return null;
        const expiredApprovals = await expireApprovalsOfRun(tx, run.runId);
        const failedTools = run.groupId === null ? [] : await failRunningToolCalls(tx, run.groupId, run.runId);
        const message =
          run.groupId === null
            ? null
            : await appendMessage(tx, run.groupId, { kind: "system", tone: "error", text: DISCONNECT_NOTICE });
        return { expiredApprovals, failedTools, message };
      });
      if (result === null) continue;
      clearTextPrefixes(run.runId);
      if (run.groupId !== null) this.#deps.groupTurns.abandon(run.groupId, run.runId);
      for (const approval of result.expiredApprovals) {
        this.#deps.push.push(ownerId, { type: "approval_updated", approval });
      }
      for (const message of result.failedTools) this.#deps.push.push(ownerId, { type: "message", message });
      if (result.message !== null) this.#deps.push.push(ownerId, { type: "message", message: result.message });
      const routine = await failRoutineRunOf(
        {
          db: this.#deps.db,
          push: this.#deps.push,
          agents: this,
          groupTurns: this.#deps.groupTurns,
          notifications: this.#deps.notifications,
        },
        run.runId,
        result.expiredApprovals.length > 0 ? EXPIRED_APPROVAL_NOTE : DISCONNECT_NOTICE,
      );
      if (routine !== null) {
        await this.#deps.notifications.publish(ownerId, {
          kind: "stuck",
          text: `例行任务「${routine.name}」没跑完：电脑中途断线`,
          groupId: run.groupId,
        });
      }
    }
  }

  #enqueueFinish(computerId: ComputerId, task: () => Promise<void>): Promise<void> {
    const previous = this.#finishChains.get(computerId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    this.#finishChains.set(computerId, current);
    void current.then(
      () => {
        if (this.#finishChains.get(computerId) === current) this.#finishChains.delete(computerId);
      },
      () => {
        if (this.#finishChains.get(computerId) === current) this.#finishChains.delete(computerId);
      },
    );
    return current;
  }

  /**
   * hello 时 config 后面紧跟每个 Bot 的运行状态，停着的补 pause，其余的补 resume。
   * 暂停状态住在控制面：新起的代理不记得谁停着；同一个代理进程重连则还记得断线前的状态，
   * 断线期间点的继续没送到，只补 pause 的话它会一直停着。代理收到 config 之前的 pause、resume 会被丢掉，
   * 所以只能排在 config 后面。
   */
  async #sendConfig(conn: AgentConnection, reason: "hello" | "changed"): Promise<void> {
    const [tools, skills, grants] = await Promise.all([
      listToolConfigs(this.#deps.db, conn.ownerId, this.#deps.toolCrypto),
      listSkillsByOwner(this.#deps.db, conn.ownerId),
      listGrants(this.#deps.db, conn.ownerId),
    ]);
    // listBots 是判暂停状态的快照，放在最后一个 await，查完同步发出 config 和补发，
    // 和暂停路由交错的窗口只剩这次查询在途的那一段。
    const bots = (await listBots(this.#deps.db, conn.ownerId)).map((item) => item.bot);
    this.#send(conn, {
      type: "config",
      bots: bots.map((bot) => ({
        id: bot.id,
        role: bot.role,
        name: bot.name,
        tag: bot.tag,
        description: bot.description,
      })),
      tools,
      // 恒带这个字段，一条都没有也带一个空数组：运行器靠整份名单和 skills 目录对账，
      // 省掉它它就分不清「这个用户没有 skill」和「这条 config 没说 skill 的事」，剩下的目录就删不干净。
      skills,
      accounts: [],
      grants,
      modelGateway: {
        baseUrl: `${this.#deps.gatewayBaseUrl()}/gateway/v1`,
        apiKey: conn.gatewayKey,
      },
    });
    if (reason === "hello") {
      for (const bot of bots) this.#send(conn, { type: bot.runState === "paused" ? "pause" : "resume", botId: bot.id });
    }
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
