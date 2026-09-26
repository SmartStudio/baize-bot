import { execFile, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import type { BrowserPlatform, ComputerKind, LoginFailure } from "@baize/shared";
import { type CdpConnection, type CdpPipe, connectPipe } from "@baize/bot-runner";
import { chromeProfileDir, isAlive, reapProfileChromes, terminate } from "./chrome-process.js";

export interface BrowserPage {
  readonly url: string;
  readonly successSelector: string;
  readonly handleSelector: string;
}

// 登录窗口只能看出登上了还是没登上，看不出账号过期，所以没有 expired。
export type BrowserLoginState =
  { readonly login: "valid"; readonly handle: string } | { readonly login: "failed"; readonly reason: LoginFailure };

// 等到上限时有时停在轮询里、有时停在等 Chrome 上，两条路给用户的是同一个结果。
const WINDOW_FAILED: BrowserLoginState = { login: "failed", reason: "window_failed" };

const READY_TIMEOUT_MS = 15_000;

export interface AssistantChrome {
  /** 远程电脑上的这个 Chrome 只给 Bot 的浏览器工具用：没人扫码登录，也就不拿它发布。 */
  readonly kind: ComputerKind;
  readonly profileDir: string;
  /**
   * 这台电脑唯一的那条管道。第一次要时才起 Chrome，这一轮启动失败就 reject，不会一直挂着。
   * Chrome 退了不自己重起，下次再要时起新的，旧连接上的命令已经全以错误结束。
   */
  connection(): Promise<CdpConnection>;
  /** signal 到点就收起登录窗口、回 failed window_failed，等 Chrome 起来的时间也算在内。 */
  login(platform: BrowserPlatform, signal: AbortSignal): Promise<BrowserLoginState>;
  pid(): number | null;
  stop(): Promise<void>;
}

export interface AssistantChromeOptions {
  readonly dataDir: string;
  readonly log?: (line: string) => void;
  readonly platformPages?: Readonly<Record<BrowserPlatform, BrowserPage>>;
  readonly activateProcess?: (pid: number) => Promise<void>;
  readonly backgroundProcess?: (pid: number) => Promise<void>;
  readonly launchChrome?: (profileDir: string) => Promise<ChromeProcess>;
  /** 决定用哪种壳起 Chrome，也就定了这台电脑算本机还是远程。默认是 process.platform。 */
  readonly platform?: NodeJS.Platform;
}

export interface ChromeProcess {
  readonly pid: number;
  readonly exited: Promise<void>;
  readonly pipe: CdpPipe;
  stop(): Promise<void>;
}

interface Running {
  readonly process: ChromeProcess;
  readonly connection: CdpConnection;
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

// 不开 TCP 调试端口：Chrome 只认 fd 3 和 fd 4 这条管道，本机别的进程和页面都够不着它。
const chromeArgs = (profileDir: string): string[] => [
  `--user-data-dir=${profileDir}`,
  "--remote-debugging-pipe",
  "--no-startup-window",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--no-first-run",
  "--no-default-browser-check",
];

// 单独成进程组，代理收到终端的 Ctrl-C 时不跟着挨信号，由代理自己收尾。管道的两头只有代理拿着：
// libuv 建的 fd 都带 CLOEXEC，Bot 的 bash 继承不到。代理被强杀时管道断开，Chrome 自己退出。
async function spawnChrome(binary: string, args: readonly string[]): Promise<ChromeProcess> {
  const child = spawn(binary, args, { detached: true, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
  const pid = child.pid;
  if (pid === undefined) throw new Error("Chrome 没有 PID");
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
  const pipe: CdpPipe = { toChrome: child.stdio[3] as Writable, fromChrome: child.stdio[4] as Readable };
  return { pid, exited, pipe, stop: () => terminate(pid) };
}

const launchMacChrome = (profileDir: string): Promise<ChromeProcess> =>
  spawnChrome("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", chromeArgs(profileDir));

// 远程电脑上没有桌面，Chrome 画在容器里的 Xvfb 上。
async function launchLinuxChrome(profileDir: string): Promise<ChromeProcess> {
  if (!process.env["DISPLAY"]) throw new Error("没有 DISPLAY，远程电脑的 Xvfb 没起来");
  return spawnChrome("/usr/bin/chromium", [...chromeArgs(profileDir), "--password-store=basic"]);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function property(value: unknown, name: string): unknown {
  return record(value)?.[name];
}

export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
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

interface ChromeShell {
  readonly kind: ComputerKind;
  readonly launch: (profileDir: string) => Promise<ChromeProcess>;
}

const chromeShells: Partial<Record<NodeJS.Platform, ChromeShell>> = {
  darwin: { kind: "local", launch: launchMacChrome },
  linux: { kind: "remote", launch: launchLinuxChrome },
};

const unsupportedShell: ChromeShell = {
  kind: "local",
  launch: () => Promise.reject(new Error("助理 Chrome 壳当前只支持 macOS 和 Linux")),
};

export function startAssistantChrome(options: AssistantChromeOptions): AssistantChrome {
  const profileDir = chromeProfileDir(options.dataDir);
  const log = options.log ?? ((line: string) => console.log(`[computer-agent] ${line}`));
  const platformPages = options.platformPages ?? defaultPlatformPages;
  const bringForward = options.activateProcess ?? activateProcess;
  const sendBackward = options.backgroundProcess ?? backgroundProcess;
  const shell = chromeShells[options.platform ?? process.platform] ?? unsupportedShell;
  const launcher = options.launchChrome ?? shell.launch;
  const stopped = new AbortController();

  // starting 是这一轮 Chrome 的来历，起好之后留着给后来的调用复用；running 是起好了、还没退出的那个。
  let starting: Promise<Running> | null = null;
  let running: Running | null = null;
  let stopPromise: Promise<void> | null = null;

  const launch = async (): Promise<Running> => {
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    // 上次的 Chrome 还没退完就占着 profile 锁，新起的实例会被 Chrome 自己的单例并进它，管道随即断开。
    const reaped = await reapProfileChromes(profileDir);
    if (reaped.length > 0) log(`收掉上次留下的助理 Chrome，PID ${reaped.join(", ")}`);
    const pending = launcher(profileDir);
    const launched = await untilAborted(pending, stopped.signal).catch((error: unknown) => {
      void pending.then((late) => late.stop()).catch(() => {});
      throw error;
    });
    try {
      if (stopped.signal.aborted) throw stopped.signal.reason;
      const connection = connectPipe(launched.pipe);
      // 管道的读端要等 Chrome 的所有子进程都放手才 EOF，进程一退就主动掐断，在途命令当场结束。
      void launched.exited.then(() => {
        launched.pipe.toChrome.destroy();
        launched.pipe.fromChrome.destroy();
      });
      const timeout = AbortSignal.any([stopped.signal, AbortSignal.timeout(READY_TIMEOUT_MS)]);
      await untilAborted(connection.send("Browser.getVersion"), timeout).catch((error: unknown) => {
        throw timeout.aborted && !stopped.signal.aborted
          ? new Error(`等了 ${READY_TIMEOUT_MS / 1000}s 管道上没有回音`)
          : error;
      });
      return { process: launched, connection };
    } catch (error) {
      await launched.stop().catch(() => {});
      throw error;
    }
  };

  const ready = (): Promise<Running> => {
    if (stopped.signal.aborted) return Promise.reject(new Error("助理 Chrome 已停止"));
    // 管道断了而退出事件还没到时，手里这个已经不能用了，当它没了重起。
    if (running !== null && !running.connection.isOpen()) {
      running = null;
      starting = null;
    }
    if (starting !== null) return starting;
    const attempt: Promise<Running> = launch().then(
      (up) => {
        running = up;
        log(`助理 Chrome 已就绪，PID ${up.process.pid}，走管道`);
        void up.process.exited.then(() => {
          if (running === up) running = null;
          if (starting === attempt) starting = null;
          if (!stopped.signal.aborted) log("助理 Chrome 已退出，下次用时重新起");
        });
        return up;
      },
      (error: unknown) => {
        if (starting === attempt) starting = null;
        const reason = error instanceof Error ? error.message : String(error);
        if (!stopped.signal.aborted) log(`助理 Chrome 启动失败：${reason}`);
        throw new Error(`助理 Chrome 起不来：${reason}`);
      },
    );
    starting = attempt;
    return attempt;
  };

  return {
    kind: shell.kind,
    profileDir,
    connection: () => ready().then((up) => up.connection),
    pid: () => running?.process.pid ?? null,
    async login(platform, signal) {
      // 远程电脑上没有人看屏幕，扫码或输验证码都没人接。
      if (shell.kind === "remote") {
        log("远程电脑上不能登录，请在本机登录这个账号");
        return { login: "failed", reason: "remote_refused" };
      }
      const pageConfig = platformPages[platform];
      // 管道是共用的，到点不能掐断它，只让这边不再等。
      const step = <T>(work: Promise<T>): Promise<T> => untilAborted(work, signal);
      let up: Running | null = null;
      let targetId: string | undefined;
      let activated = false;
      try {
        up = await step(ready());
        const { connection } = up;
        const created = await step(connection.send("Target.createTarget", { url: pageConfig.url, background: true }));
        if (typeof created.targetId !== "string") throw new Error("CDP 没有返回登录页 targetId");
        targetId = created.targetId;
        const attached = await step(connection.send("Target.attachToTarget", { targetId, flatten: true }));
        const sessionId = String(attached.sessionId);
        const page = (method: string, params: Record<string, unknown> = {}) =>
          step(connection.send(method, params, sessionId));
        await page("Runtime.enable");
        await page("Page.enable");
        await page("Emulation.setFocusEmulationEnabled", { enabled: true });
        await page("Page.bringToFront");
        activated = true;
        await bringForward(up.process.pid);

        const successSelector = JSON.stringify(pageConfig.successSelector);
        const handleSelector = JSON.stringify(pageConfig.handleSelector);
        const expression = `(() => {
          if (!document.querySelector(${successSelector})) return null;
          const handle = document.querySelector(${handleSelector})?.textContent?.trim();
          return handle || null;
        })()`;
        while (!signal.aborted && !stopped.signal.aborted) {
          const response = await page("Runtime.evaluate", { expression, returnByValue: true });
          if (response.exceptionDetails !== undefined) throw new Error("登录页脚本执行失败");
          const handle = property(response.result, "value");
          if (typeof handle === "string" && handle.length > 0) return { login: "valid", handle };
          await delay(250);
        }
        return WINDOW_FAILED;
      } catch (error) {
        if (signal.aborted) return WINDOW_FAILED;
        throw error;
      } finally {
        if (up !== null && targetId !== undefined)
          await up.connection
            .send("Target.closeTarget", { targetId })
            .catch((error: unknown) => log(`关闭登录页失败：${String(error)}`));
        if (up !== null && activated)
          await sendBackward(up.process.pid).catch((error: unknown) => log(`登录窗口退回后台失败：${String(error)}`));
      }
    },
    stop() {
      if (stopPromise !== null) return stopPromise;
      stopped.abort(new Error("助理 Chrome 已停止"));
      const pending = starting;
      stopPromise = (async () => {
        await running?.process.stop();
        await pending?.then(
          (up) => up.process.stop(),
          () => {},
        );
      })();
      return stopPromise;
    },
  };
}
