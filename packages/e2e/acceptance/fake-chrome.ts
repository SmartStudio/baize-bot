import type { CdpConnection, CdpEvent } from "@baize/bot-runner";
import { type AgentOptions, defaultLoginPages } from "@baize/computer-agent";
import { chromeProfileDir } from "@baize/computer-agent/chrome-process";

type ChromeFactory = NonNullable<AgentOptions["makeChrome"]>;

// 小红书创作者中心把没登录的人带到这一页，发布器读到它就报登录过期。
const XIAOHONGSHU_LOGIN_PAGE = "https://creator.xiaohongshu.com/login";

/** 画面上的一帧：16x10 的红色 JPEG，网页能真画出来。 */
export const FAKE_FRAME_JPEG: Uint8Array = Buffer.from(
  [
    "/9j/4AAQSkZJRgABAQAASABIAAD/wAARCAAKABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QA",
    "tRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6",
    "Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJ",
    "ytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQD",
    "BAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElK",
    "U1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX",
    "2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBQMDAwUGBQUFBQYIBgYGBgYICggICAgICAoKCgoKCgoKDAwMDAwM",
    "Dg4ODg4PDw8PDw8PDw8P/9sAQwECAwMEBAQHBAQHEAsJCxAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ",
    "EBAQEBAQEBAQ/90ABAAB/9oADAMBAAIRAxEAPwDyeiiivxM/1AP/2Q==",
  ].join(""),
  "base64",
);

export type FakeCdpCall = { readonly method: string; readonly params: Record<string, unknown> };

export type FakeChrome = {
  readonly factory: ChromeFactory;
  /** 开着、还没登上的登录页数，也就是电脑代理在等几次扫码。 */
  waitingLogins(): number;
  /** 用户在登录页里扫完码：最早开的那个登录页从下一次检查起以这个账号名登上。 */
  scan(handle: string): void;
  /** 经 CDP 发过的方法名，按顺序。 */
  cdpCalls(): readonly string[];
  /** 送进页面的 Input.* 命令，原样记下参数。 */
  inputs(): readonly FakeCdpCall[];
};

type Tab = { readonly login: boolean; handle: string | null; closed: boolean };

/**
 * 替身助理 Chrome，只有一条假 CDP 管道。电脑代理开的登录页由 createTarget 的网址认出来，检查脚本在 scan 之前回 null、
 * 之后回账号名；屏开 screencast 就给一帧。别的页面一律停在小红书登录页，于是发布器一打开发布页就认成登录过期。
 * 不起任何真浏览器，不碰用户的 Chrome。
 */
export function fakeChrome(): FakeChrome {
  const calls: string[] = [];
  const inputs: FakeCdpCall[] = [];
  const tabs = new Map<string, Tab>();
  const sessions = new Map<string, string>();
  const listeners = new Set<(event: CdpEvent) => void>();
  let created = 0;
  let attached = 0;
  let frames = 0;

  const emit = (event: CdpEvent): void => {
    for (const listener of listeners) listener(event);
  };

  const reply = (method: string, params: Record<string, unknown>, sessionId: string | undefined) => {
    switch (method) {
      case "Target.createTarget": {
        created += 1;
        const targetId = `fake-tab-${created}`;
        tabs.set(targetId, { login: params.url === defaultLoginPages.xiaohongshu.url, handle: null, closed: false });
        return { targetId };
      }
      case "Target.attachToTarget": {
        attached += 1;
        const session = `fake-session-${attached}`;
        sessions.set(session, String(params.targetId));
        return { sessionId: session };
      }
      case "Target.closeTarget": {
        const tab = tabs.get(String(params.targetId));
        if (tab !== undefined) tab.closed = true;
        return {};
      }
      case "Page.startScreencast":
        frames += 1;
        setImmediate(() =>
          emit({
            method: "Page.screencastFrame",
            params: {
              data: Buffer.from(FAKE_FRAME_JPEG).toString("base64"),
              sessionId: frames,
              metadata: { deviceWidth: 1280, deviceHeight: 800 },
            },
            sessionId,
          }),
        );
        return {};
      case "Page.getFrameTree":
        return { frameTree: { frame: { id: `fake-frame-${sessions.get(sessionId ?? "") ?? ""}` } } };
      case "Page.createIsolatedWorld":
        return { executionContextId: 1 };
      case "Runtime.evaluate": {
        const tab = tabs.get(sessions.get(sessionId ?? "") ?? "");
        if (tab?.login === true) return { result: { value: tab.handle } };
        return { result: { value: XIAOHONGSHU_LOGIN_PAGE } };
      }
      default:
        if (method.startsWith("Input.")) inputs.push({ method, params });
        return {};
    }
  };

  const connection: CdpConnection = {
    send: async (method, params = {}, sessionId) => {
      calls.push(method);
      return reply(method, params, sessionId);
    },
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isOpen: () => true,
  };

  const waiting = (): Tab[] => [...tabs.values()].filter((tab) => tab.login && !tab.closed && tab.handle === null);
  const factory: ChromeFactory = ({ dataDir }) => ({
    profileDir: chromeProfileDir(dataDir),
    connection: async () => connection,
    onExit: () => () => {},
    reveal: async () => {},
    conceal: async () => {},
    pid: () => null,
    stop: async () => undefined,
  });
  return {
    factory,
    waitingLogins: () => waiting().length,
    scan: (handle) => {
      const first = waiting()[0];
      if (first === undefined) throw new Error("没有开着的登录页可扫");
      first.handle = handle;
    },
    cdpCalls: () => calls,
    inputs: () => inputs,
  };
}
