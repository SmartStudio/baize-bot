import { execFile, spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { ComputerKind } from "@baize/shared";
import { type CdpConnection, type CdpPipe, connectPipe } from "@baize/bot-runner";
import { backoffDelay, type BackoffOptions } from "./backoff.js";
import { chromeProfileDir, isAlive, reapProfileChromes, terminate } from "./chrome-process.js";

const READY_TIMEOUT_MS = 15_000;

// 起来不到这么久就退了，算这一轮没起成。连着没起成就按退避等，不然一起就崩的 Chrome 每次调用都重起一次。
const CRASH_WINDOW_MS = 30_000;
const RESTART_BACKOFF: BackoffOptions = { initialMs: 500, maxMs: 30_000, factor: 2 };

export interface AssistantChrome {
  /** 本机还是远程。只差在 reveal、conceal 有没有窗口可拉。 */
  readonly kind: ComputerKind;
  readonly profileDir: string;
  /**
   * 这台电脑唯一的那条管道。第一次要时才起 Chrome，这一轮启动失败就 reject，不会一直挂着。
   * Chrome 退了不自己重起，下次再要时起新的，旧连接上的命令已经全以错误结束。
   * 连着起不成（起不来或起来就崩）时，第一次立刻重起，之后按退避等，等的期间直接 reject。
   */
  connection(): Promise<CdpConnection>;
  /**
   * Chrome 进程退了，回调拿到它那条连接。管道断了不会再有 CDP 的销毁事件，挂在这条连接上的页只能靠它收场。
   * 带着连接是因为退出事件到之前新的 Chrome 可能已经起来，只有旧连接上的页没了。
   */
  onExit(listener: (connection: CdpConnection) => void): () => void;
  /** 把助理 Chrome 的窗口拉到前台、再收回去。本机是 macOS 的进程激活和隐藏；远程壳画在 Xvfb 上没人看，是空操作。 */
  reveal(): Promise<void>;
  conceal(): Promise<void>;
  pid(): number | null;
  stop(): Promise<void>;
}

export interface AssistantChromeOptions {
  readonly dataDir: string;
  readonly log?: (line: string) => void;
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

// Chrome 的 SingletonSocket 建在临时目录里，谁连上它都能让带登录态的助理 Chrome 打开任意网址。
// 放在系统临时目录时，批了联网的 bash 就连得上；放进 profile，就跟 profile 一起落在 Bot bash 的禁区里。
// macOS 的 Chrome 不看 TMPDIR，只认 MAC_CHROMIUM_TMPDIR；Linux 的 chromium 看 TMPDIR。
const chromeTempDir = (profileDir: string): string => join(profileDir, "tmp");

const SINGLETON_FILES = ["SingletonLock", "SingletonSocket", "SingletonCookie"] as const;

// 单独成进程组，代理收到终端的 Ctrl-C 时不跟着挨信号，由代理自己收尾。管道的两头只有代理拿着：
// libuv 建的 fd 都带 CLOEXEC，Bot 的 bash 继承不到。代理被强杀时管道断开，Chrome 自己退出。
async function spawnChrome(binary: string, profileDir: string, args: readonly string[]): Promise<ChromeProcess> {
  const tmp = chromeTempDir(profileDir);
  const child = spawn(binary, args, {
    detached: true,
    env: { ...process.env, TMPDIR: tmp, MAC_CHROMIUM_TMPDIR: tmp },
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
  });
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
  spawnChrome("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", profileDir, chromeArgs(profileDir));

// 远程电脑上没有桌面，Chrome 画在容器里的 Xvfb 上。
async function launchLinuxChrome(profileDir: string): Promise<ChromeProcess> {
  if (!process.env["DISPLAY"]) throw new Error("没有 DISPLAY，远程电脑的 Xvfb 没起来");
  return spawnChrome("/usr/bin/chromium", profileDir, [...chromeArgs(profileDir), "--password-store=basic"]);
}

export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

// Chrome 被杀之后、退出事件到之前，管道看着还开着。探一条命令：真死了它会随管道掐断而失败，就当它没了重起。
async function answers(connection: CdpConnection): Promise<boolean> {
  if (!connection.isOpen()) return false;
  try {
    await connection.send("Browser.getVersion");
    return true;
  } catch (error) {
    if (connection.isOpen()) throw error;
    return false;
  }
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
  const bringForward = options.activateProcess ?? activateProcess;
  const sendBackward = options.backgroundProcess ?? backgroundProcess;
  const shell = chromeShells[options.platform ?? process.platform] ?? unsupportedShell;
  const launcher = options.launchChrome ?? shell.launch;
  const stopped = new AbortController();
  const exitListeners = new Set<(connection: CdpConnection) => void>();

  // starting 是这一轮 Chrome 的来历，起好之后留着给后来的调用复用；running 是起好了、还没退出的那个。
  let starting: Promise<Running> | null = null;
  let running: Running | null = null;
  let stopPromise: Promise<void> | null = null;
  // 连着没起成几次、下一次最早什么时候再起。起来撑过 CRASH_WINDOW_MS 再退的才清零。
  let crashes = 0;
  let retryAt = 0;

  const noteCrash = (): void => {
    retryAt = crashes === 0 ? 0 : Date.now() + backoffDelay(crashes - 1, RESTART_BACKOFF);
    crashes += 1;
  };

  const launch = async (): Promise<Running> => {
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    // 上次的 Chrome 还没退完就占着 profile 锁，新起的实例会被 Chrome 自己的单例并进它，管道随即断开。
    const reaped = await reapProfileChromes(profileDir);
    if (reaped.length > 0) log(`收掉上次留下的助理 Chrome，PID ${reaped.join(", ")}`);
    // 临时目录不在 Chrome 就起不来。被强杀的 Chrome 留下的 socket 目录没人收，用这个 profile 的 Chrome
    // 上面都收掉了，整个清空再建。
    await rm(chromeTempDir(profileDir), { recursive: true, force: true });
    await mkdir(chromeTempDir(profileDir), { mode: 0o700 });
    // 单例锁里记着主机名。远程电脑的容器每次重建主机名都变，Linux 的 chromium 看到别的主机名就认定 profile
    // 被另一台电脑占着，弹 xmessage 等人点，管道一直不回。用这个 profile 的 Chrome 已经收掉，这几个都是过期的。
    await Promise.all(SINGLETON_FILES.map((name) => rm(join(profileDir, name), { force: true })));
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

  const start = (): Promise<Running> => {
    const waitMs = retryAt - Date.now();
    if (waitMs > 0) {
      return Promise.reject(
        new Error(`助理 Chrome 起不来：连着 ${crashes} 次没起成，${Math.ceil(waitMs / 1000)} 秒后再试`),
      );
    }
    const attempt: Promise<Running> = launch().then(
      (up) => {
        running = up;
        const readyAt = Date.now();
        log(`助理 Chrome 已就绪，PID ${up.process.pid}，走管道`);
        void up.process.exited.then(() => {
          if (running === up) running = null;
          if (starting === attempt) starting = null;
          for (const listener of exitListeners) listener(up.connection);
          if (stopped.signal.aborted) return;
          if (Date.now() - readyAt < CRASH_WINDOW_MS) noteCrash();
          else crashes = 0;
          log("助理 Chrome 已退出，下次用时重新起");
        });
        return up;
      },
      (error: unknown) => {
        if (starting === attempt) starting = null;
        const reason = error instanceof Error ? error.message : String(error);
        if (!stopped.signal.aborted) {
          noteCrash();
          log(`助理 Chrome 启动失败：${reason}`);
        }
        throw new Error(`助理 Chrome 起不来：${reason}`);
      },
    );
    starting = attempt;
    return attempt;
  };

  const ready = async (): Promise<Running> => {
    for (;;) {
      if (stopped.signal.aborted) throw new Error("助理 Chrome 已停止");
      // 这次调用之前就在跑的才要探，刚起好的已经用 Browser.getVersion 判过就绪。
      const earlier = running;
      const pending = starting ?? start();
      const up = await pending;
      if (up !== earlier || (await answers(up.connection))) return up;
      if (running === up) running = null;
      if (starting === pending) starting = null;
    }
  };

  // Chrome 已经退了就没有窗口可拉可收，直接算做完。
  const reveal = async (): Promise<void> => {
    const pid = shell.kind === "local" ? running?.process.pid : undefined;
    if (pid !== undefined) await bringForward(pid);
  };
  const conceal = async (): Promise<void> => {
    const pid = shell.kind === "local" ? running?.process.pid : undefined;
    if (pid !== undefined) await sendBackward(pid);
  };

  return {
    kind: shell.kind,
    profileDir,
    connection: () => ready().then((up) => up.connection),
    reveal,
    conceal,
    pid: () => running?.process.pid ?? null,
    onExit(listener) {
      exitListeners.add(listener);
      return () => {
        exitListeners.delete(listener);
      };
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
