import { randomUUID } from "node:crypto";
import { type CdpConnection, evaluateIsolated, type LiveEnd, type PresentPage } from "@baize/bot-runner";
import { type AccountId, type BrowserPlatform, LiveId, type LoginAttemptId, type LoginFailure } from "@baize/shared";
import { type AssistantChrome, untilAborted } from "./chrome.js";

// 登录就是把平台的登录页摆到屏上给人操作，本机和远程一样。电脑这边只看页面上出没出现已登录的标志。

/**
 * 一个站怎么看出登上了。小红书看页面上出没出现头像；X 的登录页登上就跳走，页面上没有稳定的标志，看 cookie。
 * 两种都要再从页面上读出账号名，读到才算登上。
 */
export type SignedInBy =
  | { readonly kind: "element"; readonly selector: string }
  /** 只看 url 下有没有这个名字的 cookie，值不读出来比，也不记。 */
  | { readonly kind: "cookie"; readonly url: string; readonly name: string };

export interface BrowserPage {
  readonly url: string;
  /** 静默查登录开的页：登上了才有账号名可读，没登上会被平台带去登录页。 */
  readonly home: string;
  readonly signedIn: SignedInBy;
  readonly handleSelector: string;
  /** 给了就从元素文字里按它抠第一组，没给取整段文字。 */
  readonly handlePattern?: RegExp;
}

// 登录页只能看出登上了还是没登上，看不出账号过期，所以没有 expired。
export type BrowserLoginState =
  { readonly login: "valid"; readonly handle: string } | { readonly login: "failed"; readonly reason: LoginFailure };

/** abandoned 是人在画面上放弃或被同一账号的新登录顶掉，不算没成，不报。 */
export type LoginResult = BrowserLoginState | { readonly login: "abandoned" };

export interface LoginRequest {
  readonly platform: BrowserPlatform;
  readonly accountId: AccountId;
  readonly attempt: LoginAttemptId;
}

export interface LoginDeps {
  readonly chrome: Pick<AssistantChrome, "connection">;
  readonly present: PresentPage;
  readonly pages: Readonly<Record<BrowserPlatform, BrowserPage>>;
  readonly log: (line: string) => void;
}

export const defaultLoginPages: Readonly<Record<BrowserPlatform, BrowserPage>> = {
  xiaohongshu: {
    url: "https://creator.xiaohongshu.com/",
    home: "https://creator.xiaohongshu.com/",
    signedIn: { kind: "element", selector: ".user-info .user_avatar" },
    handleSelector: ".user-info span",
  },
  // 待实机核：登上后 X 跳回 /home，左下角账号切换按钮的文字里带「@账号名」。
  x: {
    url: "https://x.com/i/flow/login",
    home: "https://x.com/home",
    signedIn: { kind: "cookie", url: "https://x.com/", name: "auth_token" },
    handleSelector: '[data-testid="SideNav_AccountSwitcher_Button"]',
    handlePattern: /@([A-Za-z0-9_]{1,15})/,
  },
};

const POLL_MS = 250;
const WINDOW_FAILED: BrowserLoginState = { login: "failed", reason: "window_failed" };
const TIMED_OUT: BrowserLoginState = { login: "failed", reason: "timed_out" };

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const pause = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

// 屏只 resolve 不 reject；caller 只会是到点，登上了的那条路不等 present。
const fromEnd = (end: LiveEnd): LoginResult => {
  switch (end.kind) {
    case "user":
      return { login: "abandoned" };
    case "caller":
      return TIMED_OUT;
    case "page_gone":
    case "broken":
      return WINDOW_FAILED;
  }
};

function signedInExpression(page: BrowserPage): string {
  const element = page.signedIn.kind === "element" ? page.signedIn.selector : null;
  const pattern = page.handlePattern === undefined ? null : page.handlePattern.source;
  return `(() => {
    const element = ${JSON.stringify(element)};
    if (element !== null && !document.querySelector(element)) return null;
    const text = document.querySelector(${JSON.stringify(page.handleSelector)})?.textContent?.trim() ?? "";
    const pattern = ${JSON.stringify(pattern)};
    const handle = pattern === null ? text : (new RegExp(pattern).exec(text)?.[1] ?? "");
    return handle || null;
  })()`;
}

async function hasCookie(
  send: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>,
  by: SignedInBy,
): Promise<boolean> {
  if (by.kind !== "cookie") return true;
  const { cookies } = await send("Network.getCookies", { urls: [by.url] });
  return (
    Array.isArray(cookies) &&
    cookies.some(
      (cookie: unknown) => typeof cookie === "object" && cookie !== null && "name" in cookie && cookie.name === by.name,
    )
  );
}

/**
 * 每 250ms 用自己的 session 查一次登上没有，不借屏的 session：屏的 session 跟着观看者上屏下屏，这里得一直查。
 * 回登上的账号名；attach 不上回 null；被叫停时永远不回。查的过程中出的错不算数，页在跳转时 evaluate 会失败，
 * 页真没了屏会报 page_gone。
 */
async function watchSignedIn(
  connection: CdpConnection,
  targetId: string,
  page: BrowserPage,
  stop: AbortSignal,
  log: (line: string) => void,
): Promise<string | null> {
  let sessionId: string;
  try {
    const attached = await connection.send("Target.attachToTarget", { targetId, flatten: true });
    if (typeof attached.sessionId !== "string") throw new Error("CDP 没有返回 sessionId");
    sessionId = attached.sessionId;
  } catch (error) {
    if (stop.aborted) return new Promise<never>(() => {});
    log(`登录页查不了：${reason(error)}`);
    return null;
  }
  const expression = signedInExpression(page);
  let scriptFailed = false;
  try {
    while (!stop.aborted) {
      const send = (method: string, params: Record<string, unknown> = {}) => connection.send(method, params, sessionId);
      // 在隔离世界里查，登录页的风控脚本钩了 querySelector 也看不到有人每 250ms 来翻一遍。
      const response = (await hasCookie(send, page.signedIn).catch(() => false))
        ? await evaluateIsolated(send, { expression, returnByValue: true }).catch(() => ({}) as Record<string, unknown>)
        : {};
      if (stop.aborted) break;
      const result = response.result;
      const handle = typeof result === "object" && result !== null ? (result as { value?: unknown }).value : undefined;
      if (typeof handle === "string" && handle.length > 0) return handle;
      if (response.exceptionDetails !== undefined && !scriptFailed) {
        scriptFailed = true;
        log("登录页的检查脚本出错，接着查");
      }
      await pause(POLL_MS, stop);
    }
  } finally {
    void connection.send("Target.detachFromTarget", { sessionId }).catch(() => {});
  }
  return new Promise<never>(() => {});
}

/**
 * 开登录页（后台 target），交给屏，同时查登上没有。登上了撤回画面回 valid。人放弃回 abandoned；signal 到点回
 * failed timed_out；页没了、画面没展示出来回 failed window_failed。不管怎么结束，登录页都关掉。
 */
export async function runLogin(request: LoginRequest, deps: LoginDeps, signal: AbortSignal): Promise<LoginResult> {
  const page = deps.pages[request.platform];
  let connection: CdpConnection;
  let targetId: string;
  try {
    connection = await untilAborted(deps.chrome.connection(), signal);
    const creating = connection.send("Target.createTarget", { url: page.url, background: true });
    const created = await untilAborted(creating, signal).catch((error: unknown) => {
      // 到点时页可能已经在开，开出来也要关掉。
      if (signal.aborted)
        void creating.then(
          (late) => closeTarget(connection, late.targetId, deps.log),
          () => {},
        );
      throw error;
    });
    if (typeof created.targetId !== "string") throw new Error("CDP 没有返回登录页 targetId");
    targetId = created.targetId;
  } catch (error) {
    if (signal.aborted) return TIMED_OUT;
    deps.log(`登录页没打开：${reason(error)}`);
    return WINDOW_FAILED;
  }

  const done = new AbortController();
  try {
    const shown = deps
      .present(
        {
          liveId: LiveId.parse(randomUUID()),
          targetId,
          purpose: {
            kind: "login",
            accountId: request.accountId,
            platform: request.platform,
            attempt: request.attempt,
          },
        },
        AbortSignal.any([signal, done.signal]),
      )
      .then((outcome) => fromEnd(outcome.end));
    const signedIn = watchSignedIn(connection, targetId, page, done.signal, deps.log).then((handle): LoginResult =>
      handle === null ? WINDOW_FAILED : { login: "valid", handle },
    );
    return await Promise.race([shown, signedIn]);
  } finally {
    done.abort();
    await closeTarget(connection, targetId, deps.log);
  }
}

/**
 * 不上屏，在后台页上看浏览器是不是已经登上了，登上回账号名，到点或出错回 null。
 * 人在 Bot 的浏览器里登过的，账号页不知道，靠这个补上，不用再点一次登录。
 */
export async function checkLogin(
  platform: BrowserPlatform,
  deps: Pick<LoginDeps, "chrome" | "pages" | "log">,
  signal: AbortSignal,
): Promise<string | null> {
  const page = deps.pages[platform];
  let connection: CdpConnection;
  let targetId: string;
  try {
    connection = await untilAborted(deps.chrome.connection(), signal);
    const created = await untilAborted(
      connection.send("Target.createTarget", { url: page.home, background: true }),
      signal,
    );
    if (typeof created.targetId !== "string") throw new Error("CDP 没有返回 targetId");
    targetId = created.targetId;
  } catch (error) {
    if (!signal.aborted) deps.log(`查 ${platform} 登录的页没打开：${reason(error)}`);
    return null;
  }
  const done = new AbortController();
  const stop = AbortSignal.any([signal, done.signal]);
  try {
    const stopped = new Promise<null>((resolve) => stop.addEventListener("abort", () => resolve(null), { once: true }));
    return await Promise.race([watchSignedIn(connection, targetId, page, stop, deps.log), stopped]);
  } finally {
    done.abort();
    await closeTarget(connection, targetId, deps.log);
  }
}

async function closeTarget(connection: CdpConnection, targetId: unknown, log: (line: string) => void): Promise<void> {
  if (typeof targetId !== "string") return;
  await connection
    .send("Target.closeTarget", { targetId })
    .catch((error: unknown) => log(`关闭登录页失败：${reason(error)}`));
}

/**
 * 一个账号同时只有一次登录：同一账号来了新的，旧的撤回、以 abandoned 收场。不同账号各开各的页，互不等。
 * timeoutMs 从收到算起，等 Chrome 起来、人在画面上操作都算在内。
 */
export function createLogins(deps: LoginDeps, timeoutMs: number): (request: LoginRequest) => Promise<LoginResult> {
  const current = new Map<AccountId, AbortController>();
  return async (request) => {
    current.get(request.accountId)?.abort();
    const own = new AbortController();
    current.set(request.accountId, own);
    try {
      const result = await runLogin(request, deps, AbortSignal.any([own.signal, AbortSignal.timeout(timeoutMs)]));
      return own.signal.aborted && result.login === "failed" ? { login: "abandoned" } : result;
    } finally {
      if (current.get(request.accountId) === own) current.delete(request.accountId);
    }
  };
}
