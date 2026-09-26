import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserPlatform } from "@baize/shared";
import { WebSocket } from "ws";
import { backoffDelay, type BackoffOptions, defaultBackoff } from "./backoff.js";
import {
  chromeProfileDir,
  isAlive,
  profileChromePids,
  reapProfileChromes,
  terminate,
  waitForExit,
} from "./chrome-process.js";

export interface BrowserPage {
  readonly url: string;
  readonly successSelector: string;
  readonly handleSelector: string;
}

export type BrowserLoginState = { readonly login: "valid"; readonly handle: string } | { readonly login: "expired" };

export interface AssistantChrome {
  readonly profileDir: string;
  /** 第一次要地址时才起 Chrome。这一轮启动失败就 reject，不会一直挂着。 */
  cdpUrl(): Promise<string>;
  /** signal 到点就收起登录窗口、回 expired，等 Chrome 起来的时间也算在内。 */
  login(platform: BrowserPlatform, signal: AbortSignal): Promise<BrowserLoginState>;
  pid(): number | null;
  stop(): Promise<void>;
}

export interface AssistantChromeOptions {
  readonly dataDir: string;
  readonly log?: (line: string) => void;
  readonly backoff?: BackoffOptions;
  readonly platformPages?: Readonly<Record<BrowserPlatform, BrowserPage>>;
  readonly activateProcess?: (pid: number) => Promise<void>;
  readonly backgroundProcess?: (pid: number) => Promise<void>;
  readonly launchChrome?: (profileDir: string) => Promise<ChromeProcess>;
  /** 决定用哪种壳起 Chrome、能不能在这台电脑上登录。默认是 process.platform。 */
  readonly platform?: NodeJS.Platform;
}

export interface ChromeProcess {
  readonly pid: number;
  readonly exited: Promise<void>;
  stop(): Promise<void>;
}

interface CdpConnection {
  send(method: string, params?: Readonly<Record<string, unknown>>): Promise<unknown>;
  close(): void;
}

interface CdpWaiter {
  readonly resolve: (url: string) => void;
  readonly reject: (error: Error) => void;
}

const defaultPlatformPages: Readonly<Record<BrowserPlatform, BrowserPage>> = {
  xiaohongshu: {
    url: "https://creator.xiaohongshu.com/",
    successSelector: ".user-info .user_avatar",
    handleSelector: ".user-info span",
  },
};

function run(file: string, args: readonly string[]): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function findChromePid(profileDir: string, timeoutMs = 10_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [pid] = await profileChromePids(profileDir);
    if (pid !== undefined) return pid;
    await delay(50);
  }
  throw new Error(`等不到助理 Chrome 进程，profile ${profileDir}`);
}

const chromeArgs = (profileDir: string): string[] => [
  `--user-data-dir=${profileDir}`,
  "--remote-debugging-port=0",
  "--remote-debugging-address=127.0.0.1",
  "--no-startup-window",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--no-first-run",
  "--no-default-browser-check",
];

async function launchMacChrome(profileDir: string): Promise<ChromeProcess> {
  await run("open", ["-g", "-n", "-a", "Google Chrome", "--args", ...chromeArgs(profileDir)]);
  const pid = await findChromePid(profileDir);
  return { pid, exited: waitForExit(pid), stop: () => terminate(pid) };
}

// 远程电脑上没有桌面，Chrome 画在容器里的 Xvfb 上。单独成进程组，代理被强杀时它留下来，
// 下一次起之前按 profile 收掉，和 macOS 那条一样。
async function launchLinuxChrome(profileDir: string): Promise<ChromeProcess> {
  if (!process.env["DISPLAY"]) throw new Error("没有 DISPLAY，远程电脑的 Xvfb 没起来");
  const child = spawn("/usr/bin/chromium", [...chromeArgs(profileDir), "--password-store=basic"], {
    detached: true,
    stdio: "ignore",
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
  const pid = child.pid;
  if (pid === undefined) throw new Error("chromium 没有 PID");
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
  return { pid, exited, stop: () => terminate(pid) };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function property(value: unknown, name: string): unknown {
  return record(value)?.[name];
}

function stringProperty(value: unknown, name: string): string | undefined {
  const found = property(value, name);
  return typeof found === "string" ? found : undefined;
}

async function waitForCdp(profileDir: string, browser: ChromeProcess, timeoutMs = 15_000): Promise<string> {
  const portFile = join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline && isAlive(browser.pid)) {
    try {
      const contents = await readFile(portFile, "utf8");
      const port = Number(contents.split("\n", 1)[0]);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("DevToolsActivePort 端口无效");
      const url = `http://127.0.0.1:${port}`;
      const response = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(1_000) });
      if (!response.ok) throw new Error(`CDP 返回 ${response.status}`);
      return url;
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  if (!isAlive(browser.pid)) throw new Error("助理 Chrome 在 CDP 就绪前退出");
  throw new Error(`等不到助理 Chrome 的 CDP：${String(lastError)}`);
}

export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

// signal 到点就断开，挂着的命令随之 reject，登录不会卡在一条不回的 CDP 命令上。
function connectCdp(url: string, signal: AbortSignal): Promise<CdpConnection> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const onAbort = (): void => socket.close();
    signal.addEventListener("abort", onAbort, { once: true });
    const pending = new Map<
      number,
      { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }
    >();
    let id = 0;
    let opened = false;
    socket.once("open", () => {
      opened = true;
      resolve({
        send(method, params = {}) {
          const currentId = ++id;
          socket.send(JSON.stringify({ id: currentId, method, params }));
          return new Promise((resolveCommand, rejectCommand) => {
            pending.set(currentId, { resolve: resolveCommand, reject: rejectCommand });
          });
        },
        close() {
          socket.close();
        },
      });
    });
    socket.on("message", (data) => {
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      const responseId = property(message, "id");
      if (typeof responseId !== "number") return;
      const waiter = pending.get(responseId);
      if (waiter === undefined) return;
      pending.delete(responseId);
      const cdpError = property(message, "error");
      if (cdpError !== undefined) waiter.reject(new Error(JSON.stringify(cdpError)));
      else waiter.resolve(property(message, "result"));
    });
    socket.once("error", (error) => {
      if (!opened) reject(error);
    });
    socket.once("close", () => {
      signal.removeEventListener("abort", onAbort);
      const error = new Error("CDP 连接已关闭");
      if (!opened) reject(error);
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
    });
  });
}

async function browserWebSocket(cdpUrl: string): Promise<string> {
  const response = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error(`读取 CDP 版本失败：${response.status}`);
  const url = stringProperty(await response.json(), "webSocketDebuggerUrl");
  if (url === undefined || !url.startsWith("ws://127.0.0.1:")) throw new Error("CDP 浏览器地址不在回环");
  return url;
}

async function pageWebSocket(cdpUrl: string, targetId: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${cdpUrl}/json/list`, { signal: AbortSignal.timeout(2_000) });
    if (response.ok) {
      const targets: unknown = await response.json();
      if (Array.isArray(targets)) {
        const target = targets.find((candidate) => stringProperty(candidate, "id") === targetId);
        const url = stringProperty(target, "webSocketDebuggerUrl");
        if (url !== undefined && url.startsWith("ws://127.0.0.1:")) return url;
      }
    }
    await delay(50);
  }
  throw new Error(`找不到登录页 target ${targetId}`);
}

async function closeTarget(cdpUrl: string, targetId: string): Promise<void> {
  const response = await fetch(`${cdpUrl}/json/close/${encodeURIComponent(targetId)}`, {
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error(`关闭登录页失败：${response.status}`);
}

async function evaluate(page: CdpConnection, expression: string): Promise<unknown> {
  const response = await page.send("Runtime.evaluate", { expression, returnByValue: true });
  if (property(response, "exceptionDetails") !== undefined) throw new Error("登录页脚本执行失败");
  return property(property(response, "result"), "value");
}

async function activateProcess(pid: number): Promise<void> {
  await run("osascript", [
    "-e",
    `tell application "System Events" to set frontmost of first application process whose unix id is ${pid} to true`,
  ]);
}

async function backgroundProcess(pid: number): Promise<void> {
  if (!isAlive(pid)) return;
  await run("osascript", [
    "-e",
    `tell application "System Events" to set visible of first application process whose unix id is ${pid} to false`,
  ]);
}

type LoginMode = { readonly kind: "interactive" } | { readonly kind: "refused"; readonly reason: string };

interface ChromeShell {
  readonly launch: (profileDir: string) => Promise<ChromeProcess>;
  readonly login: LoginMode;
}

const chromeShells: Partial<Record<NodeJS.Platform, ChromeShell>> = {
  darwin: { launch: launchMacChrome, login: { kind: "interactive" } },
  // 远程电脑上没有人看屏幕，扫码或输验证码都没人接。
  linux: {
    launch: launchLinuxChrome,
    login: { kind: "refused", reason: "远程电脑上不能登录，请在本机登录这个账号" },
  },
};

const unsupportedShell: ChromeShell = {
  launch: () => Promise.reject(new Error("助理 Chrome 壳当前只支持 macOS 和 Linux")),
  login: { kind: "interactive" },
};

export function startAssistantChrome(options: AssistantChromeOptions): AssistantChrome {
  const profileDir = chromeProfileDir(options.dataDir);
  const portFile = join(profileDir, "DevToolsActivePort");
  const log = options.log ?? ((line: string) => console.log(`[computer-agent] ${line}`));
  const backoff = options.backoff ?? defaultBackoff;
  const platformPages = options.platformPages ?? defaultPlatformPages;
  const bringForward = options.activateProcess ?? activateProcess;
  const sendBackward = options.backgroundProcess ?? backgroundProcess;
  const shell = chromeShells[options.platform ?? process.platform] ?? unsupportedShell;
  const launcher = options.launchChrome ?? shell.launch;
  const stopped = new AbortController();
  const waiters = new Set<CdpWaiter>();

  let browser: ChromeProcess | null = null;
  let endpoint: string | null = null;
  let starting = false;
  let cycle: Promise<void> | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let stableTimer: NodeJS.Timeout | null = null;
  let attempt = 0;
  let stopPromise: Promise<void> | null = null;

  const settleWaiters = (outcome: { readonly url: string } | { readonly error: Error }): void => {
    for (const waiter of waiters) {
      if ("url" in outcome) waiter.resolve(outcome.url);
      else waiter.reject(outcome.error);
    }
    waiters.clear();
  };

  const schedule = (): void => {
    if (stopped.signal.aborted || retryTimer !== null) return;
    const wait = backoffDelay(attempt, backoff);
    attempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      begin();
    }, wait);
    log(`助理 Chrome ${wait}ms 后重起，第 ${attempt} 次`);
  };

  const launch = async (): Promise<void> => {
    let launched: ChromeProcess | null = null;
    try {
      await mkdir(profileDir, { recursive: true, mode: 0o700 });
      // 上次的代理被强杀时，open 起的 Chrome 挂在 launchd 下活着，还占着 profile 锁。
      // 不先收掉，新起的实例会被 Chrome 自己的单例并进它，守护就盯着一个没开 CDP 的旧进程。
      const reaped = await reapProfileChromes(profileDir);
      if (reaped.length > 0) log(`收掉上次留下的助理 Chrome，PID ${reaped.join(", ")}`);
      await rm(portFile, { force: true });
      const pending = launcher(profileDir);
      launched = await untilAborted(pending, stopped.signal).catch((error: unknown) => {
        void pending.then((late) => late.stop()).catch(() => {});
        throw error;
      });
      browser = launched;
      if (stopped.signal.aborted) throw stopped.signal.reason;
      endpoint = await waitForCdp(profileDir, launched);
      if (stopped.signal.aborted) throw stopped.signal.reason;
    } catch (error) {
      if (launched !== null) await launched.stop().catch(() => {});
      browser = null;
      endpoint = null;
      starting = false;
      const reason = error instanceof Error ? error : new Error(String(error));
      settleWaiters({ error: new Error(`助理 Chrome 起不来：${reason.message}`) });
      if (!stopped.signal.aborted) log(`助理 Chrome 启动失败：${reason.message}`);
      return;
    }

    starting = false;
    settleWaiters({ url: endpoint });
    log(`助理 Chrome 已就绪，PID ${launched.pid}，CDP ${endpoint}`);
    stableTimer = setTimeout(() => {
      stableTimer = null;
      attempt = 0;
    }, 30_000);
    stableTimer.unref();
    await launched.exited;
    if (stableTimer !== null) {
      clearTimeout(stableTimer);
      stableTimer = null;
    }
    browser = null;
    endpoint = null;
    if (!stopped.signal.aborted) {
      log("助理 Chrome 已退出");
      schedule();
    }
  };

  function begin(): void {
    if (stopped.signal.aborted || starting || endpoint !== null) return;
    starting = true;
    const current = launch().finally(() => {
      if (cycle === current) cycle = null;
    });
    cycle = current;
  }

  const cdpUrl = (): Promise<string> => {
    if (endpoint !== null) return Promise.resolve(endpoint);
    if (stopped.signal.aborted) return Promise.reject(new Error("助理 Chrome 已停止"));
    const waiting = new Promise<string>((resolve, reject) => waiters.add({ resolve, reject }));
    if (retryTimer === null) begin();
    return waiting;
  };

  return {
    profileDir,
    cdpUrl,
    pid: () => browser?.pid ?? null,
    async login(platform, signal) {
      if (shell.login.kind === "refused") throw new Error(shell.login.reason);
      const pageConfig = platformPages[platform];
      let url: string | null = null;
      let current: ChromeProcess | null = null;
      let root: CdpConnection | null = null;
      let page: CdpConnection | null = null;
      let targetId: string | undefined;
      let activated = false;
      try {
        url = await untilAborted(cdpUrl(), signal);
        current = browser;
        if (current === null) throw new Error("助理 Chrome 尚未运行");
        root = await connectCdp(await browserWebSocket(url), signal);
        targetId = stringProperty(
          await root.send("Target.createTarget", { url: pageConfig.url, background: true }),
          "targetId",
        );
        if (targetId === undefined) throw new Error("CDP 没有返回登录页 targetId");
        page = await connectCdp(await pageWebSocket(url, targetId), signal);
        await page.send("Runtime.enable");
        await page.send("Page.enable");
        await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
        await page.send("Page.bringToFront");
        activated = true;
        await bringForward(current.pid);

        const successSelector = JSON.stringify(pageConfig.successSelector);
        const handleSelector = JSON.stringify(pageConfig.handleSelector);
        const expression = `(() => {
          if (!document.querySelector(${successSelector})) return null;
          const handle = document.querySelector(${handleSelector})?.textContent?.trim();
          return handle || null;
        })()`;
        while (!signal.aborted && !stopped.signal.aborted) {
          const handle = await evaluate(page, expression);
          if (typeof handle === "string" && handle.length > 0) return { login: "valid", handle };
          await delay(250);
        }
        return { login: "expired" };
      } catch (error) {
        if (signal.aborted) return { login: "expired" };
        throw error;
      } finally {
        page?.close();
        root?.close();
        if (url !== null && targetId !== undefined)
          await closeTarget(url, targetId).catch((error: unknown) => log(`关闭登录页失败：${String(error)}`));
        if (current !== null && activated)
          await sendBackward(current.pid).catch((error: unknown) => log(`登录窗口退回后台失败：${String(error)}`));
      }
    },
    stop() {
      if (stopPromise !== null) return stopPromise;
      const error = new Error("助理 Chrome 已停止");
      stopped.abort(error);
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (stableTimer !== null) {
        clearTimeout(stableTimer);
        stableTimer = null;
      }
      settleWaiters({ error });
      stopPromise = (async () => {
        await browser?.stop();
        await cycle;
      })();
      return stopPromise;
    },
  };
}
