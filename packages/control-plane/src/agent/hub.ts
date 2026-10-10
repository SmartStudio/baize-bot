import { ACCOUNTS_PROXY_PATH } from "../http/accounts-proxy.js";
import {
  AgentToControl,
  ControlToAgent,
  type Computer,
  type ComputerId,
  type MessageId,
  type RunId,
  type UserId,
} from "@baize/shared";
import type { WebSocket } from "ws";
import type { Db } from "../db/client.js";
import type { ToolCrypto } from "../crypto.js";
import type { NoticePublisher } from "../notifications.js";
import { listAccountConfigs } from "../repo/accounts.js";
import { listBrandForConfig } from "../repo/brand.js";
import { ensureAssistant, listBots } from "../repo/bots.js";
import {
  authenticateComputer,
  markComputerOnline,
  markComputerSleeping,
  markComputersSleeping,
  rotateGatewayKey,
} from "../repo/computers.js";
import { listGrants } from "../repo/grants.js";
import { listPreferencesForConfig } from "../repo/preferences.js";
import { listSkillsByOwner } from "../repo/skills.js";
import { openRunsForComputer } from "../repo/runs.js";
import { listToolConfigs } from "../repo/tools.js";
import type { RoutineDeps } from "../routines/run.js";
import type { PushHub } from "../ws/hub.js";
import { abandonRun, errorKind, handleAgentEvent, settleUnchargedRuns } from "./events.js";
import type { GroupTurns } from "./group-turn.js";

export const AGENT_PATH = "/agent";

/** 连上来不报 hello 就白占一条连接。 */
const HELLO_TIMEOUT_MS = 10_000;

const CLOSE_SUPERSEDED = 4000;
const CLOSE_BAD_HELLO = 4001;
const CLOSE_ACCOUNT_DELETED = 4002;
/** RFC 6455 的 Service Restart。电脑代理收到任何关闭都按退避重连，停机结束它自己回来。 */
const CLOSE_SHUTTING_DOWN = 1012;
/** RFC 6455 的 Internal Error。握手中途出错，代理按退避重连再握一次。 */
const CLOSE_HANDSHAKE_FAILED = 1011;
const DISCONNECT_NOTICE = "电脑断过线，这次活没做完";
const DEFAULT_DISCONNECT_GRACE_MS = 15_000;
/**
 * 多久收不到任何上行帧就当连接已死。合盖的 Mac 发不出 FIN，服务端手里的 socket 会一直是 OPEN。
 * 电脑代理每 15 秒一次心跳，三倍是连丢两次还不判，第三次也没到才判。
 */
const DEFAULT_SILENCE_TIMEOUT_MS = 45_000;

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
  readonly silenceTimeoutMs?: number | undefined;
  readonly toolCrypto: ToolCrypto;
  readonly notifications: NoticePublisher;
};

/** 电脑代理的连接表。同一个用户可以同时有本机和远程两条连接，连接只按电脑号互相替换。 */
export class AgentHub {
  readonly #deps: AgentHubDeps;
  readonly #connections = new Map<ComputerId, AgentConnection>();
  /**
   * 连接的 config 走到哪一步。连接一握手就进 #connections，好让断线收尾停手、并发的 sendConfig 送得到；
   * 但在 config 发出之前派 prompt，新起的代理还没有运行器，会把它丢掉，那个 run 就永远不收尾。
   * hello 那条发出去就记 ready：旧代理不回 config_applied，等它的话旧代理永远派不上活。
   * 代理回 config_rejected 记 rejected，直到它回 config_applied 才回到 ready。
   *
   * sent 是这条连接上发到第几代，acked 是代理最近回执的哪一代（0 是还没回过带代际的回执）。
   * 并发的 sendConfig 在开始读快照时就领号，先领的号小；后领号的那条可能先发出去，代理按代际丢掉晚到的旧快照。
   * 回执和拒收都只认 sent 这一代：被拒之后又发了一代，早先那一代晚到的 config_applied 不能把 rejected 提前恢复成 ready；
   * 新一代收下之后，早先那一代晚到的 config_rejected 也不能把电脑重新卡成拒收。
   */
  readonly #configs = new WeakMap<
    AgentConnection,
    { sent: number; acked: number; state: "handshaking" | "ready" | "rejected" }
  >();
  readonly #graceTimers = new Map<ComputerId, NodeJS.Timeout>();
  /**
   * 每台电脑一条链。hello、每一帧、关闭、宽限到点的收尾都排在上面，一个任务从开始到它的推送结束，
   * 这台电脑的另一条连接插不进来。一个任务只在开头看一次自己还作不作数，中间的 await 不用再看。
   * 不同电脑的链互相并行；同一用户两台电脑写同一个账号，靠数据库的 advisory lock 和行锁。
   * 写库时带连接 key 的条件和 reportedBy 是数据库层的约束，挡的是 HTTP 路径和以后的多进程，不靠它们挡同进程交错。
   */
  readonly #chains = new Map<ComputerId, Promise<void>>();
  /** 认完身份、还在链上排队的 hello 数。宽限收尾看到有 hello 排着就停手，run 留给它按 activeRuns 对账。 */
  readonly #queuedHellos = new Map<ComputerId, number>();
  /**
   * 每条 socket 的 inbox 尾：还没做完的那一步。closeAll 靠它等停机前已经收下的帧，做完一步就删。
   * 认身份那一步也在里面，所以停机会等正在认身份的 hello 回来；回来之后它自己看停机，关 socket 不入链。
   */
  readonly #inboxTails = new Set<Promise<void>>();
  /**
   * 停机只进不出。进了之后：新 socket 和刚认完身份的 hello 当场关掉；已有 socket 再来的帧在 message 回调里同步丢掉，
   * 不进 inbox；关闭只清计时器，不再排任务、不再起宽限计时器。生产者只剩停机前已经收下的有限几帧。
   */
  #lifecycle: "serving" | "closing" = "serving";
  /**
   * 删过号的用户。认身份在链外、入表在链上，删号落在两者之间时 disconnectOwner 在表里找不到这条连接，
   * #onHello 入表前看这里。用户 id 不复用，只进不出，一个进程里删号的次数就是它的大小。
   */
  readonly #deletedOwners = new Set<UserId>();

  constructor(deps: AgentHubDeps) {
    this.#deps = deps;
  }

  /** 握手之后才算这台电脑在线。升级时不认身份，认不认得上由 hello 决定。 */
  accept(socket: WebSocket): void {
    if (this.#lifecycle === "closing") {
      socket.close(CLOSE_SHUTTING_DOWN, "控制面正在停机");
      return;
    }
    let conn: AgentConnection | null = null;
    const deadline = setTimeout(() => socket.close(CLOSE_BAD_HELLO, "没有报 hello"), HELLO_TIMEOUT_MS);
    deadline.unref();
    // 到点只 terminate，离线处理全交给下面的 close。close() 要等对端回关闭帧，冻住的对端永远不回。
    // 计时器挂在这条 socket 上，被新连接顶掉的旧连接到点也只关它自己。
    const silence = setTimeout(() => socket.terminate(), this.#deps.silenceTimeoutMs ?? DEFAULT_SILENCE_TIMEOUT_MS);
    silence.unref();

    // 同一条 socket 的帧按到达顺序：上一帧在链上做完，下一帧才排进链。并发跑的话三段 delta 会乱序落库。
    // 两帧之间可能插进这台电脑另一条连接的 hello，插进来之后这条连接剩下的帧在任务开头整条丢掉。
    let inbox: Promise<void> = Promise.resolve();
    // 日志只记错误类别和 id，异常原文可能夹着用户正文或凭据。
    const queue = (step: () => Promise<void>, failure: (error: unknown) => string) => {
      const tail = inbox.then(step).catch((error: unknown) => console.error(failure(error)));
      inbox = tail;
      this.#inboxTails.add(tail);
      void tail.then(() => this.#inboxTails.delete(tail));
    };

    socket.on("message", (raw) => {
      // 停机后收到的帧同步丢掉：socket 马上就关，等它做完只会让停机等不到头。
      if (this.#lifecycle === "closing") return;
      silence.refresh();
      const text = raw.toString();
      // 收帧时刻在排队、等锁之前取：周复盘的周界和同一周谁覆盖谁都按它算。
      const receivedAt = new Date();
      queue(
        async () => {
          const current = conn;
          if (current !== null) {
            await this.#enqueue(current.computerId, () => this.#onFrame(current, text, receivedAt));
            return;
          }
          const message = parseFrame(text, "未握手的连接");
          // 还没认上身份，除了 hello 一律不理。
          if (message === null || message.type !== "hello") return;
          clearTimeout(deadline);
          // 认身份在链外做，这时还不知道是哪台电脑。认出来之后余下全部作为一个任务排进这台电脑的链。
          const computer = await authenticateComputer(this.#deps.db, message.computerId, message.token);
          if (computer === null) {
            socket.close(CLOSE_BAD_HELLO, "电脑号或 token 对不上");
            return;
          }
          if (this.#lifecycle === "closing") {
            socket.close(CLOSE_SHUTTING_DOWN, "控制面正在停机");
            return;
          }
          this.#countQueuedHello(computer.id, 1);
          await this.#enqueue(computer.id, async () => {
            this.#countQueuedHello(computer.id, -1);
            conn = await this.#onHello(socket, computer, message.activeRuns);
          });
        },
        (error) => `处理电脑 ${conn?.computerId ?? "（未握手）"}${frameRunId(text)} 的报文出错：${errorKind(error)}`,
      );
    });

    socket.on("error", () => socket.close());

    // 关闭排在这条 socket 的帧后面。hello 还在排队时断开的话，等 hello 任务做完再读 conn，不然读到 null，那台电脑就永远挂在在线。
    // 停机后的关闭不排：连接留在表里，closeAll 一起写成休眠。
    socket.on("close", () => {
      clearTimeout(deadline);
      clearTimeout(silence);
      if (this.#lifecycle === "closing") return;
      queue(
        async () => {
          const closed = conn;
          if (closed === null) return;
          await this.#enqueue(closed.computerId, () => this.#onClose(closed));
        },
        (error) => `把电脑 ${conn?.computerId ?? "（未握手）"} 标记为休眠出错：${errorKind(error)}`,
      );
    });
  }

  /** 能派活：连着，hello 的 config 已经发出，而且代理没拒掉 config。 */
  isOnline(computerId: ComputerId): boolean {
    const conn = this.#connections.get(computerId);
    return (
      conn !== undefined && this.#configs.get(conn)?.state === "ready" && conn.socket.readyState === conn.socket.OPEN
    );
  }

  /** 这台电脑当前这条连接拒了 config，还没收下新的。 */
  configRejected(computerId: ComputerId): boolean {
    const conn = this.#connections.get(computerId);
    return conn !== undefined && this.#configs.get(conn)?.state === "rejected";
  }

  /**
   * 带代际的拒收只认当前这一代。不带代际的是旧代理的报文：它从不回带代际的回执，
   * 这条连接上一旦有过带代际的回执，无代际的拒收就不可能说的是当前这一代，不能盖掉已有的事实。
   * 返回是否采纳：没采纳的拒收不是事实，调用方不能据它告警或通知。
   */
  markConfigRejected(conn: AgentConnection, generation: number | undefined): boolean {
    const config = this.#configs.get(conn);
    if (config === undefined) return false;
    if (generation === undefined ? config.acked !== 0 : generation !== config.sent) return false;
    config.state = "rejected";
    return true;
  }

  markConfigApplied(conn: AgentConnection, generation: number): void {
    const config = this.#configs.get(conn);
    if (config === undefined || config.sent !== generation) return;
    config.acked = generation;
    config.state = "ready";
  }

  #countQueuedHello(computerId: ComputerId, delta: 1 | -1): void {
    const count = (this.#queuedHellos.get(computerId) ?? 0) + delta;
    if (count > 0) this.#queuedHellos.set(computerId, count);
    else this.#queuedHellos.delete(computerId);
  }

  onlineComputerIds(): ComputerId[] {
    return [...this.#connections.keys()].filter((computerId) => this.isOnline(computerId));
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

  /**
   * 账号删了，关掉这个人的每条代理连接。先出表再关：关闭回调看到连接不在表里就什么都不写，
   * 不标休眠、不起宽限收尾，这几台电脑的行已经随账号删掉了。
   */
  disconnectOwner(ownerId: UserId): void {
    this.#deletedOwners.add(ownerId);
    for (const connection of this.#ownerConnections(ownerId)) {
      this.#connections.delete(connection.computerId);
      connection.socket.close(CLOSE_ACCOUNT_DELETED, "账号已删除");
    }
  }

  #ownerConnections(ownerId: UserId): AgentConnection[] {
    return [...this.#connections.values()].filter((connection) => connection.ownerId === ownerId);
  }

  /**
   * 先进停机，这一刻起 message、close 回调都不再往 inbox 和链上排，宽限计时器也全清掉、不再新建，
   * 所以要等的就是此刻各 socket 还没做完的那一步，和链上已经排着的任务，两个集合都是有限的，各等一次就够：
   * inbox 的一步做完才算完，它排进链的任务也随之做完；链上剩下的只有停机前到点的宽限收尾，它不再排别的任务。
   * 然后先清表再关 socket 再写库：清表之后没有谁会再写这几台的状态，这条批量休眠就是最终状态，
   * 不用和 socket 的 close 回调抢。
   */
  async closeAll(): Promise<void> {
    this.#lifecycle = "closing";
    for (const timer of this.#graceTimers.values()) clearTimeout(timer);
    this.#graceTimers.clear();
    await Promise.allSettled(this.#inboxTails);
    await Promise.allSettled(this.#chains.values());
    const open = [...this.#connections.values()];
    this.#connections.clear();
    for (const conn of open) conn.socket.close(CLOSE_SHUTTING_DOWN, "控制面正在停机");
    await markComputersSleeping(
      this.#deps.db,
      open.map((conn) => conn.computerId),
    );
  }

  async #onFrame(conn: AgentConnection, raw: string, receivedAt: Date): Promise<void> {
    // 被新连接顶掉之后这条连接还排着的帧是旧代理的旧话，整条丢掉。从这里到 handler 返回，这台电脑不会换连接。
    if (this.#connections.get(conn.computerId) !== conn) return;
    const message = parseFrame(raw, `电脑 ${conn.computerId}`);
    if (message === null) return;
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
      receivedAt,
    );
  }

  /**
   * 认完身份的 hello 轮到它了。排队期间 socket 已经断了也照做：它排在这条 socket 的关闭前面，关闭跟在后面把电脑写成休眠，
   * 电脑来过这件事才记得下来。
   */
  async #onHello(socket: WebSocket, computer: Computer, activeRuns: readonly RunId[]): Promise<AgentConnection | null> {
    let accepted: AgentConnection | null = null;
    try {
      const gatewayKey = await rotateGatewayKey(this.#deps.db, computer.id);
      // 判删号和入表之间没有 await：删号在前，这里看得见；在后，disconnectOwner 在表里找得到它。
      if (this.#deletedOwners.has(computer.ownerId)) {
        socket.close(CLOSE_ACCOUNT_DELETED, "账号已删除");
        return null;
      }
      accepted = {
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

      await this.#finishMissingRuns(computer.id, computer.ownerId, activeRuns);
      const online = await markComputerOnline(this.#deps.db, computer.id, gatewayKey);
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
      if (assistant !== null) {
        // 已经打开的首页靠这三条认识主助理，不用刷新输入框就能用。
        this.#deps.push.push(computer.ownerId, { type: "bot_updated", bot: assistant.bot });
        this.#deps.push.push(computer.ownerId, { type: "group_created", group: assistant.group, task: assistant.task });
        this.#deps.push.push(computer.ownerId, { type: "message", message: assistant.greeting });
      }
      await this.#sendConfig(accepted, "hello");
      const handshake = this.#configs.get(accepted);
      if (handshake !== undefined) handshake.state = "ready";
      // 主助理是这次建的：这个用户其他电脑的 hello 再补只会撞索引，不推也不重发，所以要送到它们那里。
      if (assistant !== null) {
        const others = this.#ownerConnections(computer.ownerId).filter((connection) => connection !== accepted);
        await Promise.all(others.map((connection) => this.#sendConfig(connection, "changed")));
      }
      // 排在 config 之后：补结账会推进回合，下一位可能派到这台电脑上。抛错不挡上线，账留到下一次 hello。
      await settleUnchargedRuns(this.#routineDeps(), computer.id, computer.ownerId).catch((error: unknown) =>
        console.error(`电脑 ${computer.id} 上线时补结账出错：${errorKind(error)}`),
      );
      return accepted;
    } catch (error) {
      // 握手没走完，conn 留空，这条 socket 的关闭回调什么都不做。表里还挂着它的话照断线处理一遍：出表、记休眠、起宽限收尾。
      socket.close(CLOSE_HANDSHAKE_FAILED, "握手没走完");
      if (accepted !== null && this.#connections.get(computer.id) === accepted) await this.#onClose(accepted);
      throw error;
    }
  }

  async #onClose(closed: AgentConnection): Promise<void> {
    // 停机前排进来、停机后才轮到的关闭：连接留在表里由 closeAll 一起写成休眠，也不起宽限计时器，
    // 停机时已经把计时器清过一遍，这之后起的没人清，到点时库多半已经关了。
    if (this.#lifecycle === "closing") return;
    // 被新连接顶掉的那条关闭时，表里挂的已经是新连接，不能把在线的那台写成休眠。
    if (this.#connections.get(closed.computerId) !== closed) return;
    this.#connections.delete(closed.computerId);
    const timer = setTimeout(() => {
      this.#graceTimers.delete(closed.computerId);
      this.#enqueue(closed.computerId, () => this.#finishAfterGrace(closed.computerId, closed.ownerId)).catch(
        (error: unknown) => console.error(`电脑 ${closed.computerId} 断连后收尾 run 出错：${errorKind(error)}`),
      );
    }, this.#deps.disconnectGraceMs ?? DEFAULT_DISCONNECT_GRACE_MS);
    timer.unref();
    this.#graceTimers.set(closed.computerId, timer);
    const computer = await markComputerSleeping(this.#deps.db, closed.computerId, closed.gatewayKey);
    // 新连接的上线排在这个任务后面，这条休眠一定推在它的上线之前。
    if (computer !== null) this.#deps.push.push(closed.ownerId, { type: "computer_updated", computer });
  }

  /**
   * 收尾的前提是这台电脑还没回来。计时器到点和 hello 认完身份都只是排队，谁先排上谁先跑：
   * hello 先跑的话它已经清掉计时器；收尾先跑的话每收一个 run 之前再看一眼，有 hello 排在后面就停手，
   * run 留给它按 activeRuns 对账，不然代理还在跑的 run 会被当成断线丢掉。
   * 停机时这里不用看停机：没到点的计时器在 closeAll 开头同步清掉，停机后 #onClose 不再建，
   * 已经到点排进链的这一次在 closeAll 等链时做完，库还开着。
   */
  async #finishAfterGrace(computerId: ComputerId, ownerId: UserId): Promise<void> {
    const returning = () => this.#connections.has(computerId) || this.#queuedHellos.has(computerId);
    if (returning()) return;
    await this.#finishMissingRuns(computerId, ownerId, [], returning);
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
      const abandoned = await abandonRun(this.#routineDeps(), ownerId, run, {
        text: DISCONNECT_NOTICE,
        reason: DISCONNECT_NOTICE,
      });
      const routine = abandoned?.routine ?? null;
      if (routine !== null) {
        await this.#deps.notifications.publish(ownerId, {
          kind: "stuck",
          text: `例行任务「${routine.name}」没跑完：电脑中途断线`,
          groupId: run.groupId,
        });
      }
    }
  }

  #routineDeps(): RoutineDeps {
    return {
      db: this.#deps.db,
      push: this.#deps.push,
      agents: this,
      groupTurns: this.#deps.groupTurns,
      notifications: this.#deps.notifications,
    };
  }

  /** 排进这台电脑的链。上一个任务抛错不影响下一个，错误由排任务的那一方接住记日志。 */
  #enqueue(computerId: ComputerId, task: () => Promise<void>): Promise<void> {
    const previous = this.#chains.get(computerId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    this.#chains.set(computerId, current);
    const settled = () => {
      if (this.#chains.get(computerId) === current) this.#chains.delete(computerId);
    };
    void current.then(settled, settled);
    return current;
  }

  /**
   * hello 时 config 后面紧跟每个 Bot 的运行状态，停着的补 pause，其余的补 resume。
   * 暂停状态住在控制面：新起的代理不记得谁停着；同一个代理进程重连则还记得断线前的状态，
   * 断线期间点的继续没送到，只补 pause 的话它会一直停着。
   * 新起的代理进程收到 config 之前的 pause、resume 会被丢掉（还没有运行器），同一个进程重连时运行器还在，早到的会立刻生效；
   * 补发要对两种进程都成立，所以排在 config 后面。
   */
  async #sendConfig(conn: AgentConnection, reason: "hello" | "changed"): Promise<void> {
    const config = this.#configs.get(conn) ?? { sent: 0, acked: 0, state: "handshaking" as const };
    this.#configs.set(conn, config);
    config.sent += 1;
    const generation = config.sent;
    const [tools, skills, grants, accounts, brand, preferences] = await Promise.all([
      listToolConfigs(this.#deps.db, conn.ownerId, this.#deps.toolCrypto),
      listSkillsByOwner(this.#deps.db, conn.ownerId),
      listGrants(this.#deps.db, conn.ownerId),
      listAccountConfigs(this.#deps.db, conn.ownerId),
      listBrandForConfig(this.#deps.db, conn.ownerId),
      listPreferencesForConfig(this.#deps.db, conn.ownerId),
    ]);
    // listBots 是判暂停状态的快照，放在最后一个 await，查完同步发出 config 和补发，
    // 和暂停路由交错的窗口只剩这次查询在途的那一段。
    const bots = (await listBots(this.#deps.db, conn.ownerId)).map((item) => item.bot);
    this.#send(conn, {
      type: "config",
      generation,
      bots: bots.map((bot) => ({
        id: bot.id,
        role: bot.role,
        name: bot.name,
        tags: bot.tags,
        description: bot.description,
      })),
      tools,
      // 恒带这个字段，一条都没有也带一个空数组：运行器靠整份名单和 skills 目录对账，
      // 省掉它它就分不清「这个用户没有 skill」和「这条 config 没说 skill 的事」，剩下的目录就删不干净。
      skills,
      accounts,
      grants,
      // brand 和 preferences 同 skills 一样恒带：运行器靠它们判断要不要重拼系统提示，省掉就分不清「没有」和「没说」。
      brand,
      preferences,
      modelGateway: {
        baseUrl: `${this.#deps.gatewayBaseUrl()}/gateway/v1`,
        apiKey: conn.gatewayKey,
      },
      accountsProxy: { baseUrl: `${this.#deps.gatewayBaseUrl()}${ACCOUNTS_PROXY_PATH}` },
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

/**
 * 丢弃时打一行警告，只带 type 和出错的字段路径：正文里有 token、草稿和链接，不进日志。
 * 新旧版本混跑时形状对不上就走到这里，不留痕的话已经发出去的帖子会在十分钟后被记成没发出去，查不到原因。
 */
/** 出错日志里带上报文的 runId，只认校验过的报文。 */
function frameRunId(raw: string): string {
  try {
    const parsed = AgentToControl.safeParse(JSON.parse(raw));
    return parsed.success && "runId" in parsed.data && parsed.data.runId !== undefined
      ? ` run ${parsed.data.runId}`
      : "";
  } catch {
    return "";
  }
}

function parseFrame(raw: string, from: string): AgentToControl | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    console.warn(`${from} 报的不是 JSON，丢弃`);
    return null;
  }
  const parsed = AgentToControl.safeParse(json);
  if (parsed.success) return parsed.data;
  const type = (json as { type?: unknown } | null)?.type;
  const label = typeof type === "string" ? JSON.stringify(type.slice(0, 64)) : "没有 type 的报文";
  const paths = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "(整条)"))].join("、");
  console.warn(`${from} 报的 ${label} 不合 AgentToControl，丢弃。出错的字段：${paths}`);
  return null;
}
