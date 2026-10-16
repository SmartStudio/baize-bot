import { randomUUID } from "node:crypto";
import { type CdpConnection, evaluateIsolated, type LiveEnd, type PresentPage } from "@baize/bot-runner";
import { type AccountId, type BrowserPlatform, LiveId, type LoginAttemptId, type LoginFailure } from "@baize/shared";
import { type AssistantChrome, untilAborted } from "./chrome.js";

// 登录就是把平台的登录页摆到屏上给人操作，本机和远程一样。电脑这边只看页面上出没出现已登录的标志。

export interface BrowserPage {
  readonly url: string;
  readonly successSelector: string;
  readonly handleSelector: string;
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
    successSelector: ".user-info .user_avatar",
    handleSelector: ".user-info span",
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
  return `(() => {
    if (!document.querySelector(${JSON.stringify(page.successSelector)})) return null;
    const handle = document.querySelector(${JSON.stringify(page.handleSelector)})?.textContent?.trim();
    return handle || null;
  })()`;
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
      // 在隔离世界里查，登录页的风控脚本钩了 querySelector 也看不到有人每 250ms 来翻一遍。
      const response = await evaluateIsolated((method, params) => connection.send(method, params, sessionId), {
        expression,
        returnByValue: true,
      }).catch(() => ({}) as Record<string, unknown>);
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
