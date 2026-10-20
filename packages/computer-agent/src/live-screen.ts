import { z } from "zod";
import type { CdpConnection, CdpEvent, LiveEnd, LiveOutcome, LiveRequest, PresentPage } from "@baize/bot-runner";
import {
  decodeLive,
  encodeLive,
  latestWins,
  type LatestWins,
  type LiveAnnounce,
  LiveDown,
  liveEndActions,
  type LiveId,
} from "@baize/shared";
import type { AssistantChrome } from "./chrome.js";
import { toCdpInput, type Viewport } from "./live-input.js";
import type { Terminals } from "./terminal.js";

// 电脑上的屏：把助理 Chrome 的某一页摆给 Web 上的人看，替人把点击和按键送进去。
// 屏不排队，谁在看谁上屏：同时登记的会话随便几个，前台标签页只给当前有观看者的那一个。
// 画面和按键只过内存：下行帧解不开不记原文，输入送不进去只记一句固定文案。

export interface LiveScreenDeps {
  readonly chrome: Pick<AssistantChrome, "connection" | "reveal" | "conceal" | "onExit">;
  /** 发一帧二进制上行。连接不在就回 false；sent 在 ws 把字节交出去之后回调。 */
  readonly uplink: (bytes: Uint8Array, sent: () => void) => boolean;
  readonly log: (line: string) => void;
  /** 终端的帧分给它：开终端，和属于开着的终端的 liveId。没有它的屏不认终端。 */
  readonly terminals?: Pick<Terminals, "owns" | "receive">;
}

export interface LiveScreen {
  readonly present: PresentPage;
  /** 控制面下来的二进制帧。解不开的、不认识的 liveId 静默丢。 */
  receive(bytes: Uint8Array): void;
  /** welcome 之后调：重报每个会话，所有看画面的人当作已离开，新连接上谁在看由中继重新告诉我。 */
  reconnected(): void;
}

const SCREENCAST = { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 } as const;
const ORIGIN_MAX = 300;

const ScreencastFrame = z.object({
  data: z.string(),
  sessionId: z.number().int(),
  metadata: z.object({ deviceWidth: z.number().positive(), deviceHeight: z.number().positive() }),
});
const NavigatedFrame = z.object({ frame: z.object({ parentId: z.string().optional(), url: z.string() }) });
const FrameTree = z.object({ frameTree: z.object({ frame: z.object({ url: z.string() }) }) });

interface Entry {
  readonly request: LiveRequest;
  readonly connection: CdpConnection;
  readonly sessionId: string;
  readonly frames: LatestWins;
  readonly resolve: (outcome: LiveOutcome) => void;
  readonly release: () => void;
  url: string | null;
  origin: string | null;
  viewport: Viewport | null;
  revealed: boolean;
  settled: boolean;
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const page = (entry: Entry, method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
  entry.connection.send(method, params, entry.sessionId);

function originOf(url: string): string | null {
  try {
    const origin = new URL(url).origin;
    return origin === "null" || origin.length > ORIGIN_MAX ? null : origin;
  } catch {
    return null;
  }
}

export function createLiveScreen(deps: LiveScreenDeps): LiveScreen {
  const { chrome, uplink, log } = deps;
  const entries = new Map<LiveId, Entry>();
  /** 当前占着前台标签页、在出帧的会话。 */
  let shown: Entry | null = null;
  // 上屏、下屏、收尾的命令串行跑：后到的 attached 不会抢在前一个的 bringToFront 之前。
  let turn: Promise<void> = Promise.resolve();
  const serially = (work: () => Promise<void>): void => {
    turn = turn.then(work).catch((error: unknown) => log(`画面命令失败：${reason(error)}`));
  };

  const announce = (entry: Entry): void => {
    const session: LiveAnnounce = {
      liveId: entry.request.liveId,
      purpose: entry.request.purpose,
      origin: entry.origin,
    };
    uplink(encodeLive({ t: "session", session }), () => {});
  };

  const stopScreencast = (entry: Entry): Promise<void> =>
    page(entry, "Page.stopScreencast").then(
      () => {},
      () => {},
    );

  const reveal = async (entry: Entry): Promise<void> => {
    entry.revealed = true;
    await chrome.reveal().catch((error: unknown) => log(`助理 Chrome 窗口拉到前台失败：${reason(error)}`));
  };

  const settle = (entry: Entry, end: LiveEnd): void => {
    if (entry.settled) return;
    entry.settled = true;
    entries.delete(entry.request.liveId);
    entry.release();
    entry.frames.reset();
    const wasShown = shown === entry;
    if (wasShown) shown = null;
    serially(async () => {
      if (wasShown) await stopScreencast(entry);
      await entry.connection.send("Target.detachFromTarget", { sessionId: entry.sessionId }).catch(() => {});
      if (entry.revealed)
        await chrome.conceal().catch((error: unknown) => log(`助理 Chrome 窗口退回后台失败：${reason(error)}`));
    });
    uplink(encodeLive({ t: "closed", liveId: entry.request.liveId }), () => {});
    entry.resolve({ end, url: entry.url });
  };

  const show = (entry: Entry): void => {
    const previous = shown;
    shown = entry;
    serially(async () => {
      if (previous !== null) await stopScreencast(previous);
      const steps: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
        ["Emulation.setFocusEmulationEnabled", { enabled: true }],
        ["Page.bringToFront", {}],
        ["Page.startScreencast", SCREENCAST],
      ];
      for (const [method, params] of steps) {
        if (shown !== entry) return;
        await page(entry, method, params);
      }
      // 登录是人点出来的，窗口自动拉前台；接手由 Bot 发起，要人在网页上点了「在本机打开」才拉。
      if (entry.request.purpose.kind === "login") await reveal(entry);
    });
  };

  const hide = (entry: Entry): void => {
    if (shown !== entry) return;
    shown = null;
    serially(() => stopScreencast(entry));
  };

  const frame = (entry: Entry, params: Record<string, unknown>): void => {
    const parsed = ScreencastFrame.safeParse(params);
    if (!parsed.success) return;
    // ack 必须在这个 tick 里发出去：漏一次 Chromium 就不再出帧。
    void page(entry, "Page.screencastFrameAck", { sessionId: parsed.data.sessionId }).catch(() => {});
    entry.viewport = { width: parsed.data.metadata.deviceWidth, height: parsed.data.metadata.deviceHeight };
    if (shown !== entry) return;
    entry.frames.offer(
      encodeLive({ t: "frame", liveId: entry.request.liveId }, Buffer.from(parsed.data.data, "base64")),
    );
  };

  const navigated = (entry: Entry, params: Record<string, unknown>): void => {
    const parsed = NavigatedFrame.safeParse(params);
    if (!parsed.success || parsed.data.frame.parentId !== undefined) return;
    entry.url = parsed.data.frame.url;
    const origin = originOf(entry.url);
    if (origin === entry.origin) return;
    entry.origin = origin;
    announce(entry);
  };

  const onEvent = (entry: Entry, event: CdpEvent): void => {
    const own = event.sessionId === entry.sessionId;
    switch (event.method) {
      case "Page.screencastFrame":
        if (own) frame(entry, event.params);
        return;
      case "Page.frameNavigated":
        if (own) navigated(entry, event.params);
        return;
      case "Inspector.detached":
      case "Inspector.targetCrashed":
        if (own) settle(entry, { kind: "page_gone" });
        return;
      case "Target.detachedFromTarget":
        if (event.params.sessionId === entry.sessionId) settle(entry, { kind: "page_gone" });
        return;
      case "Target.targetDestroyed":
      case "Target.targetCrashed":
        if (event.params.targetId === entry.request.targetId) settle(entry, { kind: "page_gone" });
        return;
      default:
        return;
    }
  };

  const enable = async (entry: Entry): Promise<void> => {
    try {
      await page(entry, "Page.enable");
    } catch (error) {
      if (entry.settled) return;
      log(`画面没展示出来：${reason(error)}`);
      settle(entry, { kind: "broken" });
      return;
    }
    // 已经载好的页不会再来 frameNavigated，起始网址要自己问一次。
    const tree = FrameTree.safeParse(await page(entry, "Page.getFrameTree").catch(() => ({})));
    if (entry.settled) return;
    if (tree.success) {
      entry.url = tree.data.frameTree.frame.url;
      entry.origin = originOf(entry.url);
    }
    announce(entry);
  };

  const present: PresentPage = async (request, signal) => {
    if (signal.aborted) return { end: { kind: "caller" }, url: null };
    let connection: CdpConnection;
    let sessionId: string;
    try {
      connection = await chrome.connection();
      const attached = await connection.send("Target.attachToTarget", { targetId: request.targetId, flatten: true });
      if (typeof attached.sessionId !== "string") throw new Error("CDP 没有返回 sessionId");
      sessionId = attached.sessionId;
    } catch (error) {
      log(`画面没展示出来：${reason(error)}`);
      return { end: { kind: "broken" }, url: null };
    }
    if (signal.aborted) {
      await connection.send("Target.detachFromTarget", { sessionId }).catch(() => {});
      return { end: { kind: "caller" }, url: null };
    }
    return new Promise<LiveOutcome>((resolve) => {
      let unsubscribe: (() => void) | null = null;
      const onAbort = (): void => settle(entry, { kind: "caller" });
      const entry: Entry = {
        request,
        connection,
        sessionId,
        frames: latestWins(uplink),
        resolve,
        release: () => {
          unsubscribe?.();
          signal.removeEventListener("abort", onAbort);
        },
        url: null,
        origin: null,
        viewport: null,
        revealed: false,
        settled: false,
      };
      unsubscribe = connection.onEvent((event) => onEvent(entry, event));
      signal.addEventListener("abort", onAbort, { once: true });
      entries.set(request.liveId, entry);
      void enable(entry);
    });
  };

  const receive = (bytes: Uint8Array): void => {
    const decoded = decodeLive(LiveDown, bytes);
    if (decoded === null) {
      log("画面面收到坏帧");
      return;
    }
    const { header } = decoded;
    if (header.t === "terminal_open" || deps.terminals?.owns(header.liveId) === true) {
      deps.terminals?.receive(header);
      return;
    }
    const entry = entries.get(header.liveId);
    if (entry === undefined) return;
    switch (header.t) {
      case "viewer":
        if (header.state === "attached") show(entry);
        else hide(entry);
        return;
      case "input":
        if (shown !== entry || entry.viewport === null) return;
        for (const command of toCdpInput(header.input, entry.viewport)) {
          void page(entry, command.method, command.params).catch(() => log("接管输入没送到"));
        }
        return;
      case "end":
        if (liveEndActions(entry.request.purpose).includes(header.action))
          settle(entry, { kind: "user", action: header.action });
        return;
      case "reveal":
        if (shown === entry) void reveal(entry);
        return;
      default: {
        const exhaustive: never = header;
        return exhaustive;
      }
    }
  };

  chrome.onExit((connection) => {
    for (const entry of entries.values()) if (entry.connection === connection) settle(entry, { kind: "page_gone" });
  });

  const reconnected = (): void => {
    if (shown !== null) hide(shown);
    for (const entry of entries.values()) {
      entry.frames.reset();
      announce(entry);
    }
  };

  return { present, receive, reconnected };
}
