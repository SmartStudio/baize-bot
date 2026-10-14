import type { AgentOptions } from "@baize/computer-agent";
import { chromeProfileDir } from "@baize/computer-agent/chrome-process";

type ChromeFactory = NonNullable<AgentOptions["makeChrome"]>;
type LoginState = Awaited<ReturnType<ReturnType<ChromeFactory>["login"]>>;

// 小红书创作者中心把没登录的人带到这一页，发布器读到它就报登录过期。
const XIAOHONGSHU_LOGIN_PAGE = "https://creator.xiaohongshu.com/login";

export type FakeChrome = {
  readonly factory: ChromeFactory;
  /** 开着的登录窗口数，也就是电脑代理在等几次扫码。 */
  waitingLogins(): number;
  /** 用户在登录窗口里扫完码：最早开的那个窗口以这个账号名登上。 */
  scan(handle: string): void;
  /** 发布器经 CDP 发过的方法名，按顺序。 */
  cdpCalls(): readonly string[];
};

/**
 * 替身助理 Chrome。登录窗口一直开着，等验收脚本代替用户扫码；CDP 那头任何页面都停在小红书登录页，
 * 于是发布器一打开发布页就认成登录过期。不起任何真浏览器，不碰用户的 Chrome。
 */
export function fakeChrome(): FakeChrome {
  const waiting: ((state: LoginState) => void)[] = [];
  const calls: string[] = [];
  const factory: ChromeFactory = ({ dataDir }) => ({
    kind: "local",
    profileDir: chromeProfileDir(dataDir),
    connection: async () => ({
      send: async (method: string) => {
        calls.push(method);
        if (method === "Target.createTarget") return { targetId: "acceptance-tab" };
        if (method === "Target.attachToTarget") return { sessionId: "acceptance-session" };
        if (method === "Runtime.evaluate") return { result: { value: XIAOHONGSHU_LOGIN_PAGE } };
        return {};
      },
      onEvent: () => () => undefined,
      isOpen: () => true,
    }),
    login: (_platform, signal) =>
      new Promise<LoginState>((resolve) => {
        const settle = (state: LoginState): void => {
          const index = waiting.indexOf(settle);
          if (index >= 0) waiting.splice(index, 1);
          resolve(state);
        };
        waiting.push(settle);
        signal.addEventListener("abort", () => settle({ login: "failed", reason: "window_failed" }), { once: true });
      }),
    reveal: async () => {},
    conceal: async () => {},
    pid: () => null,
    stop: async () => undefined,
  });
  return {
    factory,
    waitingLogins: () => waiting.length,
    scan: (handle) => {
      const first = waiting[0];
      if (first === undefined) throw new Error("没有开着的登录窗口可扫");
      first({ login: "valid", handle });
    },
    cdpCalls: () => calls,
  };
}
