import { describe, expect, it, vi } from "vitest";
import type { CdpConnection, CdpEvent } from "@baize/bot-runner";
import {
  AccountId,
  decodeLive,
  encodeLive,
  type LiveAnnounce,
  type LiveDown,
  LiveUp,
  LoginAttemptId,
} from "@baize/shared";
import { createLiveScreen } from "../src/live-screen.js";
import { createLogins, defaultLoginPages, type LoginRequest, runLogin } from "../src/login.js";

interface Sent {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId: string | undefined;
}

const LOGIN_URL = "https://creator.xiaohongshu.com/login";

/** 一次检查脚本落在哪：主世界、当前文档上的隔离世界，还是已经作废的旧世界。 */
type CheckWorld = "main" | "isolated" | "stale";

/**
 * 假 Chrome：每次 createTarget 开一个新 tab，每次 attach 给一个新 session。登录页上的检查脚本回什么由 signedIn
 * 决定，参数是这个 tab 被查到第几次，作废世界里的那次不算。隔离世界照 Chrome 的脾气：同一 session、同一份文档、
 * 同一个名字回同一个 contextId；jumpsAt 让第 n 次求值到达前页面先跳到新文档，旧文档上的世界随之作废。
 */
function fakeChrome(
  options: {
    readonly signedIn?: (targetId: string, poll: number) => string | null;
    readonly attach?: (targetId: string) => Error | null;
    readonly jumpsAt?: (targetId: string, evaluation: number) => boolean;
  } = {},
) {
  const sent: Sent[] = [];
  const listeners = new Set<(event: CdpEvent) => void>();
  const exitListeners = new Set<(connection: CdpConnection) => void>();
  const sessions = new Map<string, string>();
  const polls = new Map<string, number>();
  const evaluations = new Map<string, number>();
  const documents = new Map<string, number>();
  const worlds = new Map<string, number>();
  const contexts = new Map<
    number,
    { readonly sessionId: string; readonly targetId: string; readonly document: number }
  >();
  const checks = new Map<string, CheckWorld[]>();
  let tabs = 0;
  let attaches = 0;
  const documentOf = (targetId: string): number => documents.get(targetId) ?? 1;
  const worldOf = (sessionId: string, contextId: unknown): CheckWorld => {
    if (contextId === undefined) return "main";
    const context = typeof contextId === "number" ? contexts.get(contextId) : undefined;
    const current =
      context !== undefined && context.sessionId === sessionId && context.document === documentOf(context.targetId);
    return current ? "isolated" : "stale";
  };
  const reply = (method: string, params: Record<string, unknown>, sessionId: string | undefined) => {
    switch (method) {
      case "Target.createTarget":
        tabs += 1;
        return { targetId: `tab-${tabs}` };
      case "Target.attachToTarget": {
        const targetId = String(params.targetId);
        const refused = options.attach?.(targetId) ?? null;
        if (refused !== null) return refused;
        attaches += 1;
        const session = `session-${attaches}`;
        sessions.set(session, targetId);
        return { sessionId: session };
      }
      case "Page.getFrameTree":
        return { frameTree: { frame: { id: "main", url: LOGIN_URL } } };
      case "Page.createIsolatedWorld": {
        const targetId = sessions.get(sessionId ?? "") ?? "";
        if (params.frameId !== "main") return new Error("No frame for given id found");
        const key = `${sessionId}|${targetId}|${documentOf(targetId)}|${String(params.worldName)}`;
        let contextId = worlds.get(key);
        if (contextId === undefined) {
          contextId = 100 + contexts.size;
          worlds.set(key, contextId);
          contexts.set(contextId, { sessionId: sessionId ?? "", targetId, document: documentOf(targetId) });
        }
        return { executionContextId: contextId };
      }
      case "Runtime.evaluate": {
        const targetId = sessions.get(sessionId ?? "") ?? "";
        const evaluation = (evaluations.get(targetId) ?? 0) + 1;
        evaluations.set(targetId, evaluation);
        if (options.jumpsAt?.(targetId, evaluation) === true) documents.set(targetId, documentOf(targetId) + 1);
        const world = worldOf(sessionId ?? "", params.contextId);
        checks.set(targetId, [...(checks.get(targetId) ?? []), world]);
        if (world === "stale") return new Error("Cannot find context with specified id");
        const poll = (polls.get(targetId) ?? 0) + 1;
        polls.set(targetId, poll);
        return { result: { type: "object", value: options.signedIn?.(targetId, poll) ?? null } };
      }
      default:
        return {};
    }
  };
  const connection: CdpConnection = {
    send: (method, params = {}, sessionId) => {
      sent.push({ method, params, sessionId });
      const answer = reply(method, params, sessionId);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isOpen: () => true,
  };
  return {
    sent,
    polls: (targetId: string) => polls.get(targetId) ?? 0,
    checks: (targetId: string) => checks.get(targetId) ?? [],
    closed: () => sent.filter((c) => c.method === "Target.closeTarget").map((c) => c.params.targetId),
    chrome: {
      connection: async () => connection,
      reveal: async () => {},
      conceal: async () => {},
      onExit: (listener: (connection: CdpConnection) => void) => {
        exitListeners.add(listener);
        return () => exitListeners.delete(listener);
      },
    },
    exit: (): void => {
      for (const listener of exitListeners) listener(connection);
    },
  };
}

function rig(options: Parameters<typeof fakeChrome>[0] = {}) {
  const cdp = fakeChrome(options);
  const up: LiveUp[] = [];
  const logs: string[] = [];
  const screen = createLiveScreen({
    chrome: cdp.chrome,
    uplink: (bytes, sent) => {
      const decoded = decodeLive(LiveUp, bytes);
      if (decoded === null) throw new Error("上行帧解不开");
      up.push(decoded.header);
      sent();
      return true;
    },
    log: (line) => logs.push(line),
  });
  const deps = {
    chrome: cdp.chrome,
    present: screen.present,
    pages: defaultLoginPages,
    log: (l: string) => logs.push(l),
  };
  const sessions = (): LiveAnnounce[] => up.flatMap((h) => (h.t === "session" ? [h.session] : []));
  const closedLive = (): string[] => up.flatMap((h) => (h.t === "closed" ? [h.liveId] : []));
  const shownFor = async (account: string): Promise<LiveAnnounce> => {
    let found: LiveAnnounce | undefined;
    await vi.waitFor(() => {
      found = sessions().find((s) => s.purpose.kind === "login" && s.purpose.accountId === account);
      expect(found, `${account} 的登录页上了屏`).toBeDefined();
    });
    return found as LiveAnnounce;
  };
  const viewer = (header: LiveDown): void => screen.receive(encodeLive(header));
  return { cdp, screen, deps, logs, sessions, closedLive, shownFor, viewer };
}

const request = (account = "account-1", attempt = "try-1"): LoginRequest => ({
  platform: "xiaohongshu",
  accountId: AccountId.parse(account),
  attempt: LoginAttemptId.parse(attempt),
});

describe("登录：开页交给屏，自己查登上没有", () => {
  it("第 3 次查到已登录：回 valid 带账号名，画面撤回、上行 closed，登录页被关", async () => {
    const h = rig({ signedIn: (_tab, poll) => (poll >= 3 ? "白泽工厂日记" : null) });

    const result = await runLogin(request(), h.deps, new AbortController().signal);

    expect(result).toEqual({ login: "valid", handle: "白泽工厂日记" });
    expect(h.cdp.polls("tab-1")).toBe(3);
    expect(h.cdp.sent[0], "登录页在后台开").toEqual({
      method: "Target.createTarget",
      params: { url: defaultLoginPages.xiaohongshu.url, background: true },
      sessionId: undefined,
    });
    const [announced] = h.sessions();
    expect(announced?.purpose).toEqual({
      kind: "login",
      accountId: "account-1",
      platform: "xiaohongshu",
      attempt: "try-1",
    });
    expect(h.closedLive(), "画面撤回").toEqual([announced?.liveId]);
    expect(h.cdp.closed()).toEqual(["tab-1"]);
    const evaluated = h.cdp.sent.filter((c) => c.method === "Runtime.evaluate").map((c) => c.sessionId);
    const screenSession = h.cdp.sent.find((c) => c.method === "Page.enable")?.sessionId;
    expect(new Set(evaluated).size, "查登录用同一个自己的 session").toBe(1);
    expect(evaluated[0], "不借屏的 session").not.toBe(screenSession);
  });

  it("观看者在画面上点放弃：回 abandoned，登录页被关", async () => {
    const h = rig();
    const pending = runLogin(request(), h.deps, new AbortController().signal);
    const shown = await h.shownFor("account-1");

    h.viewer({ t: "end", liveId: shown.liveId, action: "abandon" });

    expect(await pending).toEqual({ login: "abandoned" });
    expect(h.cdp.closed()).toEqual(["tab-1"]);
  });

  it("signal 到点：回 failed timed_out，画面撤回，登录页被关", async () => {
    const h = rig();
    const deadline = new AbortController();
    const pending = runLogin(request(), h.deps, deadline.signal);
    const shown = await h.shownFor("account-1");

    deadline.abort();

    expect(await pending).toEqual({ login: "failed", reason: "timed_out" });
    expect(h.closedLive()).toEqual([shown.liveId]);
    expect(h.cdp.closed()).toEqual(["tab-1"]);
  });

  it("登录页 attach 不上：回 failed window_failed，登录页照样关", async () => {
    const h = rig({ attach: () => new Error("No target with given id found") });

    const result = await runLogin(request(), h.deps, new AbortController().signal);

    expect(result).toEqual({ login: "failed", reason: "window_failed" });
    expect(h.cdp.closed()).toEqual(["tab-1"]);
  });

  it("Chrome 整个退出：屏以 page_gone 收场，登录回 failed window_failed", async () => {
    const h = rig();
    const pending = runLogin(request(), h.deps, new AbortController().signal);
    await h.shownFor("account-1");

    h.cdp.exit();

    expect(await pending).toEqual({ login: "failed", reason: "window_failed" });
  });
});

describe("登录：查登录在页面看不见的隔离世界里", () => {
  it("每一次查都落在当前文档上建的隔离世界里，不进页面的主世界", async () => {
    const h = rig({ signedIn: (_tab, poll) => (poll >= 3 ? "白泽工厂日记" : null) });

    const result = await runLogin(request(), h.deps, new AbortController().signal);

    expect(result).toEqual({ login: "valid", handle: "白泽工厂日记" });
    expect(h.cdp.checks("tab-1")).toEqual(["isolated", "isolated", "isolated"]);
  });

  it("登录页跳到新文档，旧世界作废：那一次报找不到 context，下一轮在新文档上重建，照样查到，不算脚本出错", async () => {
    const h = rig({
      signedIn: (_tab, poll) => (poll >= 2 ? "白泽工厂日记" : null),
      jumpsAt: (_tab, evaluation) => evaluation === 2,
    });

    const result = await runLogin(request(), h.deps, AbortSignal.timeout(3_000));

    expect(result).toEqual({ login: "valid", handle: "白泽工厂日记" });
    expect(h.cdp.checks("tab-1"), "作废的那一次之后不再往旧世界里求值").toEqual(["isolated", "stale", "isolated"]);
    expect(h.logs).not.toContain("登录页的检查脚本出错，接着查");
  });
});

describe("登录：一个账号同时只有一次", () => {
  it("同一账号第二次登录：第一次以 abandoned 结束、页被关；第二次照常登上", async () => {
    const h = rig({ signedIn: (tab, poll) => (tab === "tab-2" && poll >= 2 ? "白泽工厂日记" : null) });
    const login = createLogins(h.deps, 60_000);
    const first = login(request("account-1", "try-1"));
    const firstShown = await h.shownFor("account-1");

    const second = login(request("account-1", "try-2"));

    expect(await first).toEqual({ login: "abandoned" });
    expect(h.closedLive()).toContain(firstShown.liveId);
    expect(await second).toEqual({ login: "valid", handle: "白泽工厂日记" });
    expect(h.cdp.closed()).toEqual(["tab-1", "tab-2"]);
  });

  it("两个账号同时登录，各自上屏，互不等", async () => {
    const h = rig();
    const login = createLogins(h.deps, 60_000);
    const one = login(request("account-1", "try-1"));
    const two = login(request("account-2", "try-2"));

    const [a, b] = [await h.shownFor("account-1"), await h.shownFor("account-2")];
    h.viewer({ t: "end", liveId: b.liveId, action: "abandon" });
    expect(await two).toEqual({ login: "abandoned" });
    h.viewer({ t: "end", liveId: a.liveId, action: "abandon" });
    expect(await one).toEqual({ login: "abandoned" });
  });

  it("超过时限没登上：回 failed timed_out，不当成被顶掉", async () => {
    const h = rig();
    const login = createLogins(h.deps, 200);

    expect(await login(request())).toEqual({ login: "failed", reason: "timed_out" });
    expect(h.cdp.closed()).toEqual(["tab-1"]);
  });
});
