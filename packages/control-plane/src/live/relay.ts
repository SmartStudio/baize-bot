import {
  decodeLive,
  encodeLive,
  latestWins,
  LiveFromViewer,
  LiveUp,
  LiveViewerClose,
  type ComputerId,
  type LatestWins,
  type LiveAnnounce,
  type LiveDown,
  type LiveId,
  type LiveSession,
  type UserId,
} from "@baize/shared";
import type { RawData, WebSocket } from "ws";
import { log } from "../log.js";
import type { PushHub } from "../ws/hub.js";

/** 中继认的电脑连接。AgentConnection 结构上就满足它，中继只按对象身份比较，不读别的字段。 */
export interface AgentLink {
  readonly computerId: ComputerId;
  readonly ownerId: UserId;
  readonly socket: WebSocket;
}

export type LiveRelayDeps = {
  readonly push: Pick<PushHub, "push">;
  /** 每个观看者每秒最多转几条人的输入，多的丢。网页把 move 合并到每帧一条，正常操作碰不到。 */
  readonly inputPerSecond?: number;
  /** 输入限额的时钟，毫秒。测试冻住它来数限额。 */
  readonly now?: () => number;
  /** 电脑断线后终端会话留多久等它重连重报，毫秒。 */
  readonly terminalGraceMs?: number;
};

const MAX_AGENT_FRAME = 2 * 1024 * 1024;
const DEFAULT_INPUT_PER_SECOND = 120;
/** 终端输入按字节限：粘贴一大段是正常操作，按条数会把它截成半截命令。突发是两秒的量。 */
const TERM_BYTES_PER_SECOND = 1024 * 1024;
const TERM_BYTES_BURST = 2 * TERM_BYTES_PER_SECOND;
const DEFAULT_TERMINAL_GRACE_MS = 15_000;
/** RFC 6455 的 Policy Violation。终端输入丢一段就是一条错的命令，超额不丢，直接关掉。 */
const CLOSE_INPUT_FLOOD = 1008;
/** RFC 6455 的 Service Restart，和 /agent、/api/ws 停机时一样。 */
const CLOSE_SHUTTING_DOWN = 1012;
/** RFC 6455 的 Try Again Later。网页把它当断网，退避重连，电脑在重新 attached 时补发回滚缓冲。 */
const CLOSE_TOO_SLOW = 1013;
/** 终端输出不能丢也不能被顶掉，观看者积压超过这么多就当作跟不上，断开让它重连。 */
const MAX_VIEWER_BACKLOG = 8 * 1024 * 1024;

type SessionKey = `${UserId}:${LiveId}`;
/** grace 只在终端会话的电脑断线后、重连重报前有：到点才结束。 */
type Entry = { readonly link: AgentLink; readonly session: LiveSession; readonly grace?: NodeJS.Timeout };
type Viewer = {
  readonly key: SessionKey;
  readonly liveId: LiveId;
  readonly socket: WebSocket;
  readonly frames: LatestWins;
  readonly admitInput: () => boolean;
  readonly admitTermBytes: (bytes: number) => boolean;
};

/**
 * 画面面的中继。构造参数里没有 Db：它在结构上碰不到库。
 * 会话按 `${ownerId}:${liveId}` 作键：liveId 是电脑报的，别人的电脑报同一个号也撞不进来。
 * 观看者按电脑记，一台电脑同一时刻最多一个人在看：电脑上同时只有一个能被人操作的窗口。
 * 只解帧头，负载（JPEG 或终端输出）原样转发；输入原样转给电脑，不解释、不记日志。
 */
export class LiveRelay {
  readonly #deps: LiveRelayDeps;
  readonly #sessions = new Map<SessionKey, Entry>();
  readonly #viewers = new Map<ComputerId, Viewer>();
  #closed = false;

  constructor(deps: LiveRelayDeps) {
    this.#deps = deps;
  }

  /** hub 收到二进制帧时同步调。解不开、不属于这条连接的会话，静默丢。单帧超过 2MB 丢。 */
  fromAgent(link: AgentLink, bytes: Uint8Array): void {
    if (this.#closed || bytes.length > MAX_AGENT_FRAME) return;
    const decoded = decodeLive(LiveUp, bytes);
    if (decoded === null) return;
    const { header } = decoded;
    if (header.t === "session") {
      this.#upsert(link, header.session);
      return;
    }
    const entry = this.#sessions.get(sessionKey(link.ownerId, header.liveId));
    if (entry === undefined) {
      // 电脑拒开终端时这个号从没登记过，网页还在等它的 session，推一条 live_closed 让它别干等。
      if (header.t === "closed") this.#deps.push.push(link.ownerId, { type: "live_closed", liveId: header.liveId });
      return;
    }
    if (entry.link !== link) return;
    if (header.t === "frame") this.#viewerOf(entry)?.frames.offer(bytes);
    else if (header.t === "term") this.#term(entry, bytes);
    else this.#end(entry);
  }

  /**
   * 连接断了：这条连接上的画面会话全部结束，看画面的人收 gone，推 live_closed。按对象身份认连接，顶号的新连接不受影响。
   * 终端会话不立刻结束：电脑上的 shell 还活着，观看者以 1012 关（网页当断网重连），宽限内这台电脑重连重报同一个号就接着用。
   */
  dropAgent(link: AgentLink): void {
    for (const [key, entry] of this.#sessions) {
      if (entry.link !== link) continue;
      if (entry.session.purpose.kind !== "terminal") {
        this.#end(entry);
        continue;
      }
      const viewer = this.#viewerOf(entry);
      if (viewer !== null) this.#detach(entry.session.computerId, viewer, CLOSE_SHUTTING_DOWN, "云电脑断线，等它重连");
      const grace = setTimeout(() => {
        const current = this.#sessions.get(key);
        if (current?.grace === grace) this.#end(current);
      }, this.#deps.terminalGraceMs ?? DEFAULT_TERMINAL_GRACE_MS);
      this.#sessions.set(key, { ...entry, grace });
    }
  }

  /**
   * 会话不存在或不是这个人的，一律 notFound，不区分。这台电脑上已经有人在看（不论看哪个会话），旧的收 replaced，
   * 电脑先收旧会话的 detached，再收新会话的 attached。同一会话换人也一样走一遍，电脑上每个会话的 attached 和 detached 严格交替。
   */
  attachViewer(ownerId: UserId, liveId: LiveId, socket: WebSocket): void {
    if (this.#closed) {
      socket.close(CLOSE_SHUTTING_DOWN, "控制面正在停机");
      return;
    }
    const key = sessionKey(ownerId, liveId);
    const entry = this.#sessions.get(key);
    if (entry === undefined) {
      socket.close(LiveViewerClose.notFound, "没有这个画面");
      return;
    }
    const { computerId } = entry.session;
    const previous = this.#viewers.get(computerId);
    if (previous !== undefined) this.#detach(computerId, previous, LiveViewerClose.replaced, "在别的窗口打开了");

    const inputPerSecond = this.#deps.inputPerSecond ?? DEFAULT_INPUT_PER_SECOND;
    const viewer: Viewer = {
      key,
      liveId,
      socket,
      frames: latestWins((bytes, sent) => {
        if (socket.readyState !== socket.OPEN) return false;
        socket.send(bytes, () => sent());
        return true;
      }),
      admitInput: tokenBucket(inputPerSecond, inputPerSecond, this.#deps.now ?? Date.now),
      admitTermBytes: tokenBucket(TERM_BYTES_PER_SECOND, TERM_BYTES_BURST, this.#deps.now ?? Date.now),
    };
    this.#viewers.set(computerId, viewer);
    socket.on("message", (raw, isBinary) => {
      if (isBinary && this.#viewers.get(computerId) === viewer) this.#fromViewer(viewer, bytesOf(raw));
    });
    socket.on("close", () => {
      if (this.#viewers.get(computerId) === viewer) this.#detach(computerId, viewer);
    });
    toAgent(entry.link, { t: "viewer", liveId, state: "attached" });
    sendTo(socket, encodeLive({ t: "session", session: entry.session }));
  }

  list(ownerId: UserId): LiveSession[] {
    return [...this.#sessions.values()].filter((entry) => entry.link.ownerId === ownerId).map((entry) => entry.session);
  }

  /** 停机：看画面的人全部 1012，之后来的观看者和电脑帧一律不收。 */
  closeAll(): void {
    this.#closed = true;
    for (const viewer of this.#viewers.values()) {
      viewer.frames.reset();
      viewer.socket.close(CLOSE_SHUTTING_DOWN, "控制面正在停机");
    }
    for (const entry of this.#sessions.values()) clearTimeout(entry.grace);
    this.#viewers.clear();
    this.#sessions.clear();
  }

  /** session 是整份 upsert。同一个号已经挂在这个人的另一台电脑上，后报的不算。 */
  #upsert(link: AgentLink, announce: LiveAnnounce): void {
    const key = sessionKey(link.ownerId, announce.liveId);
    const existing = this.#sessions.get(key);
    if (existing !== undefined && existing.session.computerId !== link.computerId) return;
    clearTimeout(existing?.grace);
    const session: LiveSession = { ...announce, computerId: link.computerId };
    const entry: Entry = { link, session };
    this.#sessions.set(key, entry);
    this.#deps.push.push(link.ownerId, { type: "live_session", session });
    const viewer = this.#viewerOf(entry);
    if (viewer === null) return;
    sendTo(viewer.socket, encodeLive({ t: "session", session }));
    // 电脑重连后重报：新连接不知道有人在看，补一条 attached 让它重开 screencast。
    if (existing !== undefined && existing.link !== link)
      toAgent(link, { t: "viewer", liveId: announce.liveId, state: "attached" });
  }

  /** 终端输出按到达顺序原样转，不走 latestWins。没人看就丢：电脑那边留着回滚缓冲，下次 attached 时补。 */
  #term(entry: Entry, bytes: Uint8Array): void {
    const viewer = this.#viewerOf(entry);
    if (viewer === null) return;
    if (viewer.socket.bufferedAmount > MAX_VIEWER_BACKLOG)
      this.#detach(entry.session.computerId, viewer, CLOSE_TOO_SLOW, "终端输出跟不上，稍后重连");
    else sendTo(viewer.socket, bytes);
  }

  #end(entry: Entry): void {
    clearTimeout(entry.grace);
    const { liveId, computerId } = entry.session;
    this.#sessions.delete(sessionKey(entry.link.ownerId, liveId));
    const viewer = this.#viewerOf(entry);
    if (viewer !== null) {
      this.#viewers.delete(computerId);
      viewer.frames.reset();
      viewer.socket.close(LiveViewerClose.gone, "画面已结束");
    }
    this.#deps.push.push(entry.link.ownerId, { type: "live_closed", liveId });
  }

  /** 观看者离开或被顶掉：出表在前，它自己的 close 回调看到表里已不是它，就不会再发一次 detached。 */
  #detach(computerId: ComputerId, viewer: Viewer, code?: number, reason?: string): void {
    this.#viewers.delete(computerId);
    viewer.frames.reset();
    const entry = this.#sessions.get(viewer.key);
    if (entry !== undefined) toAgent(entry.link, { t: "viewer", liveId: viewer.liveId, state: "detached" });
    if (code !== undefined) viewer.socket.close(code, reason);
  }

  #viewerOf(entry: Entry): Viewer | null {
    const viewer = this.#viewers.get(entry.session.computerId);
    return viewer !== undefined && viewer.liveId === entry.session.liveId ? viewer : null;
  }

  /** 坏帧静默丢：解析失败的原因里可能夹着用户打的字。 */
  #fromViewer(viewer: Viewer, bytes: Uint8Array): void {
    const decoded = decodeLive(LiveFromViewer, bytes);
    if (decoded === null) return;
    const entry = this.#sessions.get(viewer.key);
    if (entry === undefined) return;
    const { header } = decoded;
    const { liveId } = viewer;
    if (header.t === "input") {
      const { kind } = header.input;
      if (kind === "term" || kind === "resize") {
        if (viewer.admitTermBytes(bytes.length)) toAgent(entry.link, { t: "input", liveId, input: header.input });
        else {
          log.warn("终端输入超过每秒 1MB，关掉这个观看者", { computerId: entry.session.computerId, liveId });
          this.#detach(entry.session.computerId, viewer, CLOSE_INPUT_FLOOD, "终端输入太快");
        }
      } else if (viewer.admitInput()) toAgent(entry.link, { t: "input", liveId, input: header.input });
    } else if (header.t === "end") toAgent(entry.link, { t: "end", liveId, action: header.action });
    else toAgent(entry.link, { t: "reveal", liveId });
  }
}

/** ws 默认的 binaryType 给 Buffer；ArrayBuffer 和分片数组是另两种设置下的形状。 */
export function bytesOf(raw: RawData): Uint8Array {
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw;
}

function sessionKey(ownerId: UserId, liveId: LiveId): SessionKey {
  return `${ownerId}:${liveId}`;
}

function toAgent(link: AgentLink, header: LiveDown): void {
  sendTo(link.socket, encodeLive(header));
}

function sendTo(socket: WebSocket, bytes: Uint8Array): void {
  if (socket.readyState === socket.OPEN) socket.send(bytes);
}

/** 令牌桶：满桶是 burst，按流逝时间连续回填。 */
function tokenBucket(perSecond: number, burst: number, now: () => number): (cost?: number) => boolean {
  let tokens = burst;
  let last = now();
  return (cost = 1) => {
    const at = now();
    tokens = Math.min(burst, tokens + ((at - last) * perSecond) / 1000);
    last = at;
    if (tokens < cost) return false;
    tokens -= cost;
    return true;
  };
}
