import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { CdpConnection, CdpEvent, LiveOutcome, LiveRequest } from "@baize/bot-runner";
import {
  AccountId,
  BotId,
  decodeLive,
  encodeLive,
  GroupId,
  type LiveDown,
  LiveId,
  type LivePurpose,
  LiveUp,
  LoginAttemptId,
} from "@baize/shared";
import { createLiveScreen } from "../src/live-screen.js";

interface Sent {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId: string | undefined;
}
type Reply = Record<string, unknown> | Error;

const LOGIN_URL = "https://creator.xiaohongshu.com/login";

const defaultReply = (method: string, params: Record<string, unknown>): Reply => {
  if (method === "Target.attachToTarget") return { sessionId: `session-${String(params.targetId)}` };
  if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main", url: LOGIN_URL } } };
  return {};
};

function fakeCdp(respond: (method: string, params: Record<string, unknown>) => Reply = defaultReply) {
  const sent: Sent[] = [];
  const listeners = new Set<(event: CdpEvent) => void>();
  const connection: CdpConnection = {
    send: (method, params = {}, sessionId) => {
      sent.push({ method, params, sessionId });
      const reply = respond(method, params);
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
    },
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isOpen: () => true,
  };
  return {
    connection,
    sent,
    emit: (event: CdpEvent): void => {
      for (const listener of listeners) listener(event);
    },
    methods: (sessionId: string) => sent.filter((c) => c.sessionId === sessionId).map((c) => c.method),
    listeners: () => listeners.size,
  };
}

function fakeUplink() {
  const received: Array<{ header: LiveUp; payload: Uint8Array }> = [];
  const waiting: (() => void)[] = [];
  let stuck = false;
  const uplink = (bytes: Uint8Array, sent: () => void): boolean => {
    const decoded = decodeLive(LiveUp, bytes);
    if (decoded === null) throw new Error("上行帧解不开");
    received.push(decoded);
    if (stuck) waiting.push(sent);
    else sent();
    return true;
  };
  return {
    uplink,
    received,
    stick: (): void => {
      stuck = true;
    },
    deliverOne: (): void => waiting.shift()?.(),
    sessions: () => received.flatMap((r) => (r.header.t === "session" ? [r.header.session] : [])),
    closed: () => received.flatMap((r) => (r.header.t === "closed" ? [r.header.liveId] : [])),
    frames: () =>
      received.flatMap((r) =>
        r.header.t === "frame" ? [{ liveId: r.header.liveId, payload: Array.from(r.payload) }] : [],
      ),
  };
}

function screenWith(options: { respond?: typeof defaultReply; connection?: () => Promise<CdpConnection> } = {}) {
  const cdp = fakeCdp(options.respond);
  const up = fakeUplink();
  const logs: string[] = [];
  let reveals = 0;
  let conceals = 0;
  const screen = createLiveScreen({
    chrome: {
      connection: options.connection ?? (async () => cdp.connection),
      reveal: async () => {
        reveals += 1;
      },
      conceal: async () => {
        conceals += 1;
      },
    },
    uplink: up.uplink,
    log: (line) => logs.push(line),
  });
  return { cdp, up, logs, screen, reveals: () => reveals, conceals: () => conceals };
}
type Harness = ReturnType<typeof screenWith>;

const login = (): LivePurpose => ({
  kind: "login",
  accountId: AccountId.parse("account-1"),
  platform: "xiaohongshu",
  attempt: LoginAttemptId.parse("attempt-1"),
});
const takeover = (): LivePurpose => ({
  kind: "takeover",
  botId: BotId.parse("bot-1"),
  groupId: GroupId.parse("group-1"),
  reason: "撞上登录墙",
});
const request = (targetId: string, purpose: LivePurpose): LiveRequest => ({
  liveId: LiveId.parse(randomUUID()),
  targetId,
  purpose,
});
const down = (header: LiveDown): Uint8Array => encodeLive(header);
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface Presented {
  readonly controller: AbortController;
  readonly sessionId: string;
  readonly done: () => boolean;
  readonly outcome: () => LiveOutcome | undefined;
}

async function presented(h: Harness, req: LiveRequest): Promise<Presented> {
  const controller = new AbortController();
  let outcome: LiveOutcome | undefined;
  void h.screen.present(req, controller.signal).then((value) => {
    outcome = value;
  });
  await vi.waitFor(() => expect(h.up.sessions().some((s) => s.liveId === req.liveId)).toBe(true));
  return {
    controller,
    sessionId: `session-${req.targetId}`,
    done: () => outcome !== undefined,
    outcome: () => outcome,
  };
}

async function watched(h: Harness, req: LiveRequest): Promise<void> {
  const session = `session-${req.targetId}`;
  const starts = (): number => h.cdp.methods(session).filter((method) => method === "Page.startScreencast").length;
  const before = starts();
  h.screen.receive(down({ t: "viewer", liveId: req.liveId, state: "attached" }));
  await vi.waitFor(() => expect(starts()).toBe(before + 1));
}

const frameEvent = (
  sessionId: string,
  jpeg: Uint8Array,
  frameId = 1,
  size = { width: 1000, height: 600 },
): CdpEvent => ({
  method: "Page.screencastFrame",
  params: {
    data: Buffer.from(jpeg).toString("base64"),
    sessionId: frameId,
    metadata: {
      offsetTop: 0,
      pageScaleFactor: 1,
      deviceWidth: size.width,
      deviceHeight: size.height,
      scrollOffsetX: 0,
      scrollOffsetY: 0,
      timestamp: 1,
    },
  },
  sessionId,
});

describe("屏：登记和上屏", () => {
  it("两个 present 都登记：各自 attach、Page.enable、问起始网址，上行收到两个 session，谁都没收到 bringToFront 和 startScreencast", async () => {
    const h = screenWith();
    const a = request("tab-a", login());
    const b = request("tab-b", takeover());
    const pa = await presented(h, a);
    const pb = await presented(h, b);

    expect(h.cdp.sent[0]).toEqual({
      method: "Target.attachToTarget",
      params: { targetId: "tab-a", flatten: true },
      sessionId: undefined,
    });
    expect(h.cdp.methods("session-tab-a")).toEqual(["Page.enable", "Page.getFrameTree"]);
    expect(h.cdp.methods("session-tab-b")).toEqual(["Page.enable", "Page.getFrameTree"]);
    expect(h.up.sessions()).toEqual([
      { liveId: a.liveId, purpose: a.purpose, origin: "https://creator.xiaohongshu.com" },
      { liveId: b.liveId, purpose: b.purpose, origin: "https://creator.xiaohongshu.com" },
    ]);
    expect(pa.done()).toBe(false);
    expect(pb.done()).toBe(false);
  });

  it("先 attach A 的观看者：A 依次收到 setFocusEmulationEnabled、bringToFront、startScreencast；再 attach B：A 收到 stopScreencast，B 收到 bringToFront 和 startScreencast", async () => {
    const h = screenWith();
    const a = request("tab-a", takeover());
    const b = request("tab-b", takeover());
    await presented(h, a);
    await presented(h, b);

    const before = h.cdp.sent.length;
    await watched(h, a);
    expect(h.cdp.sent.slice(before)).toEqual([
      { method: "Emulation.setFocusEmulationEnabled", params: { enabled: true }, sessionId: "session-tab-a" },
      { method: "Page.bringToFront", params: {}, sessionId: "session-tab-a" },
      {
        method: "Page.startScreencast",
        params: { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 },
        sessionId: "session-tab-a",
      },
    ]);

    const mid = h.cdp.sent.length;
    await watched(h, b);
    expect(h.cdp.sent.slice(mid).map((c) => [c.method, c.sessionId])).toEqual([
      ["Page.stopScreencast", "session-tab-a"],
      ["Emulation.setFocusEmulationEnabled", "session-tab-b"],
      ["Page.bringToFront", "session-tab-b"],
      ["Page.startScreencast", "session-tab-b"],
    ]);
  });

  it("没人看的会话从头到尾不收到 bringToFront，旁边那个被看、被结束都不影响它", async () => {
    const h = screenWith();
    const a = request("tab-a", takeover());
    const b = request("tab-b", takeover());
    await presented(h, a);
    const pb = await presented(h, b);
    await watched(h, a);
    h.cdp.emit(frameEvent("session-tab-a", Uint8Array.of(1)));
    h.screen.receive(down({ t: "viewer", liveId: a.liveId, state: "detached" }));
    h.screen.receive(down({ t: "end", liveId: a.liveId, action: "finish" }));
    await vi.waitFor(() => expect(h.cdp.methods("session-tab-a")).toContain("Page.stopScreencast"));

    expect(h.cdp.methods("session-tab-b")).toEqual(["Page.enable", "Page.getFrameTree"]);
    expect(pb.done()).toBe(false);
    expect(h.up.closed()).toEqual([a.liveId]);
  });

  it("同一会话的观看者再次接上：先 stop 再 startScreencast，新来的人靠重开拿首帧", async () => {
    const h = screenWith();
    const a = request("tab-a", takeover());
    await presented(h, a);
    await watched(h, a);

    const before = h.cdp.sent.length;
    h.screen.receive(down({ t: "viewer", liveId: a.liveId, state: "attached" }));
    await vi.waitFor(() => expect(h.cdp.sent.length).toBe(before + 4));
    expect(h.cdp.sent.slice(before).map((c) => c.method)).toEqual([
      "Page.stopScreencast",
      "Emulation.setFocusEmulationEnabled",
      "Page.bringToFront",
      "Page.startScreencast",
    ]);
    expect(h.cdp.sent.slice(before).map((c) => c.method)).not.toContain("Page.captureScreenshot");
  });
});

describe("屏：帧和输入", () => {
  it("假 CDP 推一帧：ack 在同一个 tick 里发出，上行帧的负载等于 base64 解码后的字节", async () => {
    const h = screenWith();
    const a = request("tab-a", takeover());
    await presented(h, a);
    await watched(h, a);

    const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3);
    h.cdp.emit(frameEvent("session-tab-a", jpeg, 7));

    expect(h.cdp.sent.at(-1)).toEqual({
      method: "Page.screencastFrameAck",
      params: { sessionId: 7 },
      sessionId: "session-tab-a",
    });
    expect(h.up.frames()).toEqual([{ liveId: a.liveId, payload: [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3] }]);
  });

  it("上行发送器卡住时连推 5 帧：每帧都 ack，最后只发出第 1 和第 5 帧", async () => {
    const h = screenWith();
    const a = request("tab-a", takeover());
    await presented(h, a);
    await watched(h, a);

    h.up.stick();
    for (let i = 1; i <= 5; i += 1) h.cdp.emit(frameEvent("session-tab-a", Uint8Array.of(i), i));
    expect(h.up.frames().map((f) => f.payload)).toEqual([[1]]);
    expect(h.cdp.sent.filter((c) => c.method === "Page.screencastFrameAck").map((c) => c.params.sessionId)).toEqual([
      1, 2, 3, 4, 5,
    ]);

    h.up.deliverOne();
    expect(h.up.frames().map((f) => f.payload)).toEqual([[1], [5]]);
    h.up.deliverOne();
    expect(h.up.frames().map((f) => f.payload)).toEqual([[1], [5]]);
  });

  it("鼠标 (0.5, 0.25) 在 1000×600 的帧之后变成 (500, 150) 发到这一页的 session 上", async () => {
    const h = screenWith();
    const a = request("tab-a", takeover());
    await presented(h, a);
    await watched(h, a);
    h.cdp.emit(frameEvent("session-tab-a", Uint8Array.of(1), 1, { width: 1000, height: 600 }));

    h.screen.receive(
      down({
        t: "input",
        liveId: a.liveId,
        input: { kind: "mouse", phase: "down", x: 0.5, y: 0.25, button: "left", clicks: 1, modifiers: 0 },
      }),
    );
    expect(h.cdp.sent.at(-1)).toEqual({
      method: "Input.dispatchMouseEvent",
      params: { type: "mousePressed", x: 500, y: 150, button: "left", buttons: 1, clickCount: 1, modifiers: 0 },
      sessionId: "session-tab-a",
    });
  });

  it("还没有帧时输入被丢；观看者离开后再来的输入也丢", async () => {
    const h = screenWith();
    const a = request("tab-a", takeover());
    await presented(h, a);
    await watched(h, a);
    const input = (): void =>
      h.screen.receive(down({ t: "input", liveId: a.liveId, input: { kind: "text", text: "密码" } }));

    input();
    await flush();
    expect(h.cdp.sent.map((c) => c.method)).not.toContain("Input.insertText");

    h.cdp.emit(frameEvent("session-tab-a", Uint8Array.of(1)));
    input();
    expect(h.cdp.sent.at(-1)?.method).toBe("Input.insertText");

    h.screen.receive(down({ t: "viewer", liveId: a.liveId, state: "detached" }));
    input();
    await flush();
    expect(h.cdp.sent.filter((c) => c.method === "Input.insertText")).toHaveLength(1);
  });

  it("输入送不进去只记一句固定文案，不带按键内容", async () => {
    const h = screenWith({
      respond: (method, params) =>
        method === "Input.insertText" ? new Error(`bad text ${String(params.text)}`) : defaultReply(method, params),
    });
    const a = request("tab-a", takeover());
    await presented(h, a);
    await watched(h, a);
    h.cdp.emit(frameEvent("session-tab-a", Uint8Array.of(1)));

    h.screen.receive(down({ t: "input", liveId: a.liveId, input: { kind: "text", text: "密码" } }));
    await vi.waitFor(() => expect(h.logs).toContain("接管输入没送到"));
    expect(h.logs.join("\n")).not.toContain("密码");
  });
});

describe("屏：结束", () => {
  it("end finish 在 login 用途上被忽略，在 takeover 上以 user/finish 结束并带回网址", async () => {
    const h = screenWith();
    const a = request("tab-a", login());
    const b = request("tab-b", takeover());
    const pa = await presented(h, a);
    const pb = await presented(h, b);

    h.screen.receive(down({ t: "end", liveId: a.liveId, action: "finish" }));
    h.screen.receive(down({ t: "end", liveId: b.liveId, action: "finish" }));
    await vi.waitFor(() => expect(pb.done()).toBe(true));

    expect(pb.outcome()).toEqual({ end: { kind: "user", action: "finish" }, url: LOGIN_URL });
    expect(pa.done(), "登录只能放弃，交还被忽略").toBe(false);
    expect(h.up.closed()).toEqual([b.liveId]);
  });

  it("login：观看者接上时 reveal；detach 之后 stopScreencast、不 conceal；abandon 收尾时 detach target、conceal、上行 closed", async () => {
    const h = screenWith();
    const a = request("tab-a", login());
    const pa = await presented(h, a);
    await watched(h, a);
    await vi.waitFor(() => expect(h.reveals()).toBe(1));

    h.screen.receive(down({ t: "viewer", liveId: a.liveId, state: "detached" }));
    await vi.waitFor(() => expect(h.cdp.methods("session-tab-a")).toContain("Page.stopScreencast"));
    expect(h.conceals(), "本机用户可能正在真窗口里操作").toBe(0);

    h.screen.receive(down({ t: "end", liveId: a.liveId, action: "abandon" }));
    await vi.waitFor(() => expect(h.conceals()).toBe(1));
    expect(pa.outcome()).toEqual({ end: { kind: "user", action: "abandon" }, url: LOGIN_URL });
    expect(h.cdp.sent.at(-1)).toEqual({
      method: "Target.detachFromTarget",
      params: { sessionId: "session-tab-a" },
      sessionId: undefined,
    });
    expect(h.up.closed()).toEqual([a.liveId]);
    expect(h.cdp.listeners(), "事件订阅摘掉了").toBe(0);
  });

  it("takeover：观看者接上不 reveal，收到 reveal 帧才 reveal；没人看时的 reveal 帧不算", async () => {
    const h = screenWith();
    const a = request("tab-a", takeover());
    const pa = await presented(h, a);

    h.screen.receive(down({ t: "reveal", liveId: a.liveId }));
    await flush();
    expect(h.reveals()).toBe(0);

    await watched(h, a);
    expect(h.reveals()).toBe(0);
    h.screen.receive(down({ t: "reveal", liveId: a.liveId }));
    await vi.waitFor(() => expect(h.reveals()).toBe(1));

    h.screen.receive(down({ t: "end", liveId: a.liveId, action: "finish" }));
    await vi.waitFor(() => expect(h.conceals()).toBe(1));
    expect(pa.outcome()?.end).toEqual({ kind: "user", action: "finish" });
  });

  it("某个会话的 signal 响了：detach target、上行 closed、present 以 caller 结束，另一个会话照常能上屏", async () => {
    const h = screenWith();
    const a = request("tab-a", takeover());
    const b = request("tab-b", takeover());
    const pa = await presented(h, a);
    const pb = await presented(h, b);

    pa.controller.abort();
    await vi.waitFor(() => expect(pa.done()).toBe(true));
    expect(pa.outcome()).toEqual({ end: { kind: "caller" }, url: LOGIN_URL });
    await vi.waitFor(() =>
      expect(h.cdp.sent.filter((c) => c.method === "Target.detachFromTarget").map((c) => c.params)).toEqual([
        { sessionId: "session-tab-a" },
      ]),
    );
    expect(h.up.closed()).toEqual([a.liveId]);
    expect(h.conceals(), "没 reveal 过就不 conceal").toBe(0);

    await watched(h, b);
    expect(pb.done()).toBe(false);
    expect(h.cdp.methods("session-tab-b")).toContain("Page.bringToFront");
  });

  it("Target.targetDestroyed 让 present 以 page_gone 结束，旁边的会话不受影响", async () => {
    const h = screenWith();
    const a = request("tab-a", takeover());
    const b = request("tab-b", takeover());
    const pa = await presented(h, a);
    const pb = await presented(h, b);
    await watched(h, a);

    h.cdp.emit({ method: "Target.targetDestroyed", params: { targetId: "tab-a" }, sessionId: undefined });
    await vi.waitFor(() => expect(pa.done()).toBe(true));
    expect(pa.outcome()).toEqual({ end: { kind: "page_gone" }, url: LOGIN_URL });
    expect(h.up.closed()).toEqual([a.liveId]);
    expect(pb.done()).toBe(false);

    h.cdp.emit(frameEvent("session-tab-a", Uint8Array.of(1)));
    expect(h.up.frames(), "结束后的帧不再上行").toEqual([]);
  });

  it("Target.detachedFromTarget 带这个 session 时同样是 page_gone；别的 session 的不算", async () => {
    const h = screenWith();
    const a = request("tab-a", takeover());
    const pa = await presented(h, a);

    h.cdp.emit({ method: "Target.detachedFromTarget", params: { sessionId: "session-other" }, sessionId: undefined });
    await flush();
    expect(pa.done()).toBe(false);

    h.cdp.emit({ method: "Target.detachedFromTarget", params: { sessionId: "session-tab-a" }, sessionId: undefined });
    await vi.waitFor(() => expect(pa.done()).toBe(true));
    expect(pa.outcome()?.end).toEqual({ kind: "page_gone" });
  });

  it("signal 在 present 之前就响了：直接 caller，不 attach", async () => {
    const h = screenWith();
    const controller = new AbortController();
    controller.abort();

    const outcome = await h.screen.present(request("tab-a", takeover()), controller.signal);
    expect(outcome).toEqual({ end: { kind: "caller" }, url: null });
    expect(h.cdp.sent).toEqual([]);
    expect(h.up.received).toEqual([]);
  });

  it("Chrome 起不来或 attach 失败：present 以 broken 结束，上行什么都不发，日志记原因", async () => {
    const noChrome = screenWith({ connection: () => Promise.reject(new Error("助理 Chrome 起不来：没装")) });
    expect(await noChrome.screen.present(request("tab-a", login()), new AbortController().signal)).toEqual({
      end: { kind: "broken" },
      url: null,
    });
    expect(noChrome.up.received).toEqual([]);
    expect(noChrome.logs).toEqual(["画面没展示出来：助理 Chrome 起不来：没装"]);

    const noTarget = screenWith({
      respond: (method, params) =>
        method === "Target.attachToTarget" ? new Error("No target with given id found") : defaultReply(method, params),
    });
    expect(await noTarget.screen.present(request("tab-a", login()), new AbortController().signal)).toEqual({
      end: { kind: "broken" },
      url: null,
    });
    expect(noTarget.up.received).toEqual([]);
  });

  it("Page.enable 失败：登记过的会话以 broken 结束，不报 session", async () => {
    const h = screenWith({
      respond: (method, params) =>
        method === "Page.enable" ? new Error("Target closed") : defaultReply(method, params),
    });
    const outcome = await h.screen.present(request("tab-a", takeover()), new AbortController().signal);
    expect(outcome).toEqual({ end: { kind: "broken" }, url: null });
    expect(h.up.sessions()).toEqual([]);
  });
});

describe("屏：网址和重连", () => {
  it("主 frame 换了 origin 就重报 session，同 origin 内导航和子 frame 不重报，结束时带回最后的网址", async () => {
    const h = screenWith();
    const a = request("tab-a", takeover());
    const pa = await presented(h, a);

    h.cdp.emit({
      method: "Page.frameNavigated",
      params: { frame: { id: "main", url: "https://creator.xiaohongshu.com/publish" } },
      sessionId: "session-tab-a",
    });
    h.cdp.emit({
      method: "Page.frameNavigated",
      params: { frame: { id: "sub", parentId: "main", url: "https://sso.example.com/iframe" } },
      sessionId: "session-tab-a",
    });
    expect(h.up.sessions()).toHaveLength(1);

    h.cdp.emit({
      method: "Page.frameNavigated",
      params: { frame: { id: "main", url: "https://sso.example.com/auth" } },
      sessionId: "session-tab-a",
    });
    expect(h.up.sessions().at(-1)).toEqual({ liveId: a.liveId, purpose: a.purpose, origin: "https://sso.example.com" });

    h.screen.receive(down({ t: "end", liveId: a.liveId, action: "abandon" }));
    await vi.waitFor(() => expect(pa.done()).toBe(true));
    expect(pa.outcome()?.url).toBe("https://sso.example.com/auth");
  });

  it("reconnected() 之后每个会话都重报一遍，正在出帧的停下，之后的帧不上行，直到观看者重新接上", async () => {
    const h = screenWith();
    const a = request("tab-a", takeover());
    const b = request("tab-b", login());
    await presented(h, a);
    await presented(h, b);
    await watched(h, a);
    const announced = h.up.sessions().length;

    h.screen.reconnected();
    expect(
      h.up
        .sessions()
        .slice(announced)
        .map((s) => s.liveId),
    ).toEqual([a.liveId, b.liveId]);
    await vi.waitFor(() => expect(h.cdp.methods("session-tab-a")).toContain("Page.stopScreencast"));

    h.cdp.emit(frameEvent("session-tab-a", Uint8Array.of(1)));
    expect(h.up.frames()).toEqual([]);
    expect(h.cdp.sent.at(-1)?.method, "停了也照样 ack，免得 Chromium 卡住").toBe("Page.screencastFrameAck");

    const before = h.cdp.sent.length;
    await watched(h, a);
    expect(h.cdp.sent.slice(before).map((c) => c.method)).toEqual([
      "Emulation.setFocusEmulationEnabled",
      "Page.bringToFront",
      "Page.startScreencast",
    ]);
  });

  it("解不开的下行帧只记「坏帧」不带原文；不认识的 liveId 静默丢", async () => {
    const h = screenWith();
    const a = request("tab-a", takeover());
    await presented(h, a);
    const before = h.cdp.sent.length;

    h.screen.receive(new TextEncoder().encode("\u0000\u0000\u0000\u0005{secret-password}"));
    expect(h.logs).toEqual(["画面面收到坏帧"]);

    h.screen.receive(down({ t: "viewer", liveId: LiveId.parse(randomUUID()), state: "attached" }));
    await flush();
    expect(h.cdp.sent.length).toBe(before);
    expect(h.logs).toHaveLength(1);
  });
});
