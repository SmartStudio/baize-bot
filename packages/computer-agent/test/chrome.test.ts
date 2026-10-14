import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { basename, dirname, join } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CdpConnection } from "@baize/bot-runner";
import { AccountId, BotId, LoginAttemptId } from "@baize/shared";
import { botDirs, forbiddenZones } from "../../bot-runner/src/paths.js";
import { createSandboxedBash } from "../../bot-runner/src/sandbox.js";
import { startAssistantChrome, type AssistantChrome, type ChromeProcess } from "../src/chrome.js";
import { chromeProfileDir, isAlive, profileChromePids, reapProfileChromes } from "../src/chrome-process.js";
import { createLiveScreen } from "../src/live-screen.js";
import { runLogin } from "../src/login.js";

const chromes: AssistantChrome[] = [];
const dataDirs: string[] = [];
// 把冻住的 Date 拨过崩溃窗口，免得重起退避挡住后面的连接。
const pastCrashWindow = (): void => {
  vi.setSystemTime(Date.now() + 60_000);
};

async function poll<T>(
  get: () => T | undefined | Promise<T | undefined>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await get();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`等了 ${timeoutMs}ms 还没等到${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function dataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "baize-chrome-test-"));
  dataDirs.push(directory);
  return directory;
}

type Host = {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly ready: { readonly pid: number; readonly product: string };
  log(): string;
};

const hosts: Host["child"][] = [];

async function startHost(directory: string): Promise<Host> {
  const fixture = fileURLToPath(new URL("fixtures/chrome-host.ts", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", fixture, directory], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  hosts.push(child);
  let output = "";
  const ready = await new Promise<Host["ready"]>((resolve, reject) => {
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const line = output.split("\n").find((candidate) => candidate.startsWith("{"));
      if (line !== undefined) resolve(JSON.parse(line) as Host["ready"]);
    });
    child.once("exit", (code, signal) => reject(new Error(`宿主进程提前退出 ${String(code ?? signal)}：${output}`)));
  });
  return { child, ready, log: () => output };
}

function exited(child: Host["child"]): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

afterEach(async () => {
  vi.useRealTimers();
  for (const host of hosts.splice(0)) host.kill("SIGKILL");
  await Promise.all(chromes.splice(0).map((chrome) => chrome.stop()));
  await Promise.all(dataDirs.map((directory) => reapProfileChromes(chromeProfileDir(directory))));
  await Promise.all(dataDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("助理 Chrome 按需起", () => {
  it("构造时不起 Chrome，要连接时才起，起不来就 reject，下次再要再起", async () => {
    let launches = 0;
    const chrome = startAssistantChrome({
      dataDir: await dataDir(),
      log: () => {},
      launchChrome: async () => {
        launches += 1;
        throw new Error("没装 Chrome");
      },
    });
    chromes.push(chrome);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(launches, "没人要连接就不起").toBe(0);

    await expect(chrome.connection()).rejects.toThrow("助理 Chrome 起不来：没装 Chrome");
    await expect(chrome.connection()).rejects.toThrow("助理 Chrome 起不来：没装 Chrome");
    expect(launches).toBe(2);
  });
});

type Reply = Record<string, unknown> | "hold";

/** 管道那头的假 Chrome。respond 回 "hold" 就不回这条命令；killed 之后什么都不回，exit() 才算进程退出。 */
interface FakeChrome {
  readonly commands: string[];
  kill(): void;
  exit(): void;
}

function fakeChromes(respond: (method: string, params: Record<string, unknown>) => Reply = () => ({})) {
  const launched: FakeChrome[] = [];
  const launchChrome = async (): Promise<ChromeProcess> => {
    const toChrome = new PassThrough();
    const fromChrome = new PassThrough();
    const commands: string[] = [];
    let answering = true;
    let markExited: (() => void) | undefined;
    const processExited = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    let buffered = "";
    toChrome.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      for (let end = buffered.indexOf("\0"); end !== -1; end = buffered.indexOf("\0")) {
        const { id, method, params } = JSON.parse(buffered.slice(0, end)) as {
          id: number;
          method: string;
          params: Record<string, unknown>;
        };
        buffered = buffered.slice(end + 1);
        commands.push(method);
        const reply = answering ? respond(method, params) : "hold";
        if (reply !== "hold") fromChrome.write(`${JSON.stringify({ id, result: reply })}\0`);
      }
    });
    const fake: FakeChrome = {
      commands,
      kill: () => {
        answering = false;
      },
      exit: () => {
        answering = false;
        markExited?.();
      },
    };
    launched.push(fake);
    return {
      pid: 4_000_000 + launched.length,
      exited: processExited,
      pipe: { toChrome, fromChrome },
      stop: async () => fake.exit(),
    };
  };
  return { launched, launchChrome };
}

describe("助理 Chrome 连接失效和重起退避", () => {
  it("Chrome 刚被杀、退出事件还没到时要连接，拿到的是重起的新连接，不是旧的", async () => {
    const { launched, launchChrome } = fakeChromes();
    const chrome = startAssistantChrome({ dataDir: await dataDir(), log: () => {}, launchChrome });
    chromes.push(chrome);
    const first = await chrome.connection();
    const old = launched[0];
    if (old === undefined) throw new Error("前提：起过一个 Chrome");

    old.kill();
    const next = chrome.connection();
    // 要连接的调用先到，进程退出事件晚一轮才到。
    await new Promise((resolve) => setImmediate(resolve));
    old.exit();

    const again = await next;
    expect(again, "拿到的不是旧连接").not.toBe(first);
    expect(launched, "重起了一个 Chrome").toHaveLength(2);
    await expect(again.send("Target.getTargets")).resolves.toEqual({});
  });

  it("起来就崩的 Chrome：第一次立刻重起，之后按 0.5 秒起翻倍退避，等的期间直接 reject 不起", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { launched, launchChrome } = fakeChromes();
    const chrome = startAssistantChrome({ dataDir: await dataDir(), log: () => {}, launchChrome });
    chromes.push(chrome);
    const crashNext = async (): Promise<void> => {
      await chrome.connection();
      launched.at(-1)?.exit();
      await poll(() => (chrome.pid() === null ? true : undefined), 3_000, "Chrome 退出被看到");
    };

    await crashNext();
    await crashNext();
    expect(launched, "第一次崩了立刻重起").toHaveLength(2);

    await expect(chrome.connection()).rejects.toThrow("助理 Chrome 起不来：连着 2 次没起成，1 秒后再试");
    vi.setSystemTime(Date.now() + 499);
    await expect(chrome.connection()).rejects.toThrow("秒后再试");
    expect(launched, "退避期间不起").toHaveLength(2);

    vi.setSystemTime(Date.now() + 1);
    await crashNext();
    expect(launched).toHaveLength(3);
    vi.setSystemTime(Date.now() + 999);
    await expect(chrome.connection()).rejects.toThrow("连着 3 次没起成");
    vi.setSystemTime(Date.now() + 1);
    await chrome.connection();
    expect(launched).toHaveLength(4);

    vi.setSystemTime(Date.now() + 30_000);
    launched.at(-1)?.exit();
    await poll(() => (chrome.pid() === null ? true : undefined), 3_000, "Chrome 退出被看到");
    await crashNext();
    await chrome.connection();
    expect(launched, "撑过 30 秒才退的不算崩，计数清零，之后第一次崩照样立刻重起").toHaveLength(6);
  });
});

describe("助理 Chrome 的单例锁", () => {
  it("profile 里留着别的主机写下的单例锁（远程电脑的容器重建过），起 Chrome 之前已经清掉", async () => {
    const directory = await dataDir();
    const profileDir = chromeProfileDir(directory);
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    await symlink("7ec7de76ada7-80", join(profileDir, "SingletonLock"));
    await symlink("17585210604407249254", join(profileDir, "SingletonCookie"));
    await symlink(
      join(profileDir, "tmp", "org.chromium.Chromium.gone", "SingletonSocket"),
      join(profileDir, "SingletonSocket"),
    );
    const { launchChrome } = fakeChromes();
    let seen: string[] = [];
    const chrome = startAssistantChrome({
      dataDir: directory,
      log: () => {},
      launchChrome: async (launchedProfile) => {
        seen = (await readdir(launchedProfile)).toSorted();
        return launchChrome();
      },
    });
    chromes.push(chrome);

    await chrome.connection();

    expect(seen, "Chrome 起的那一刻 profile 里只剩临时目录").toEqual(["tmp"]);
  });
});

describe("助理 Chrome 退出通知", () => {
  it("Chrome 退了：订阅的人拿到退出的那条连接；之后重起的是新连接，再退再通知；退订后不再收到", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { launched, launchChrome } = fakeChromes();
    const chrome = startAssistantChrome({ dataDir: await dataDir(), log: () => {}, launchChrome });
    chromes.push(chrome);
    const exits: CdpConnection[] = [];
    const unsubscribe = chrome.onExit((connection) => exits.push(connection));
    const first = await chrome.connection();

    pastCrashWindow();
    launched[0]?.exit();
    await poll(() => (exits.length === 1 ? true : undefined), 3_000, "第一次退出通知");
    expect(exits[0]).toBe(first);

    const second = await chrome.connection();
    expect(second).not.toBe(first);
    pastCrashWindow();
    launched[1]?.exit();
    await poll(() => (exits.length === 2 ? true : undefined), 3_000, "第二次退出通知");
    expect(exits[1]).toBe(second);

    unsubscribe();
    await chrome.connection();
    pastCrashWindow();
    launched[2]?.exit();
    await poll(() => (chrome.pid() === null ? true : undefined), 3_000, "Chrome 退出被看到");
    expect(exits, "退订后不再收到").toHaveLength(2);
  });

  it("代理停机时 Chrome 被收掉，也通知一次", async () => {
    const { launchChrome } = fakeChromes();
    const chrome = startAssistantChrome({ dataDir: await dataDir(), log: () => {}, launchChrome });
    chromes.push(chrome);
    const exits: CdpConnection[] = [];
    chrome.onExit((connection) => exits.push(connection));
    const connection = await chrome.connection();

    await chrome.stop();

    await poll(() => (exits.length === 1 ? true : undefined), 3_000, "停机的退出通知");
    expect(exits[0]).toBe(connection);
  });
});

/** 真 Chrome 上跑登录：屏照常登记会话，上行丢掉，没人看。 */
function loginOn(chrome: AssistantChrome, url: string) {
  const screen = createLiveScreen({ chrome, uplink: () => true, log: () => {} });
  const page = { url, successSelector: ".user-info .user_avatar", handleSelector: ".user-info span" };
  return (signal: AbortSignal) =>
    runLogin(
      {
        platform: "xiaohongshu",
        accountId: AccountId.parse("account-1"),
        attempt: LoginAttemptId.parse("try-1"),
      },
      { chrome, present: screen.present, pages: { xiaohongshu: page }, log: () => {} },
      signal,
    );
}

describe.runIf(process.platform === "darwin")("助理专用 Chrome 上登录", () => {
  it("本地静态页按钮加出登录后元素后返回账号，登录页关掉", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><meta charset="utf-8">
        <button id="login" onclick="document.body.insertAdjacentHTML('beforeend', '<div class=user-info><img class=user_avatar><span>白泽工厂日记</span></div>')">登录</button>
        <script>setTimeout(() => login.click(), 100)</script>`);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("本地静态页没有端口");
    const chrome = startAssistantChrome({
      dataDir: await dataDir(),
      log: () => {},
      activateProcess: async () => {},
      backgroundProcess: async () => {},
    });
    chromes.push(chrome);

    try {
      const login = loginOn(chrome, `http://127.0.0.1:${address.port}/`);
      await expect(login(AbortSignal.timeout(5_000))).resolves.toEqual({ login: "valid", handle: "白泽工厂日记" });
      const connection = await chrome.connection();
      const loginPages = async (): Promise<string[]> => {
        const { targetInfos } = (await connection.send("Target.getTargets")) as { targetInfos: { url: string }[] };
        return targetInfos
          .map((target) => target.url)
          .filter((url) => url.startsWith(`http://127.0.0.1:${address.port}`));
      };
      // closeTarget 先回 success，标签页等 detachedFromTarget 之后才从清单里消失。
      const settled = await poll(
        async () => ((await loginPages()).length === 0 ? [] : undefined),
        3_000,
        "登录页关掉",
      ).catch(() => loginPages());
      expect(settled, "登录完关掉登录页，不越攒越多").toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);

  it("登录元素在上限内没出现就返回 failed timed_out", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><button id=login>登录</button>");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("本地静态页没有端口");
    const chrome = startAssistantChrome({
      dataDir: await dataDir(),
      log: () => {},
      activateProcess: async () => {},
      backgroundProcess: async () => {},
    });
    chromes.push(chrome);
    // 先把 Chrome 起好，上限只算登录页上的时间。
    await chrome.connection();

    try {
      await expect(loginOn(chrome, `http://127.0.0.1:${address.port}/`)(AbortSignal.timeout(1_000))).resolves.toEqual({
        login: "failed",
        reason: "timed_out",
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);
});

// 真起浏览器的用例。macOS 起 Google Chrome，Linux 起 Debian 的 chromium，远程电脑镜像里就是这一种。
const realChrome = process.platform === "darwin" || (process.platform === "linux" && existsSync("/usr/bin/chromium"));

/** 这个进程在听的 TCP 端口，lsof 查不到就是空数组。 */
function listeningPorts(pid: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile("lsof", ["-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"], (error, stdout) => {
      if (error !== null && error.code !== 1) reject(error);
      else resolve(stdout.split("\n").filter((line) => line.startsWith("n")));
    });
  });
}

describe.runIf(realChrome)("助理 Chrome 只有一条管道", () => {
  it("起来以后本机没有它监听的 TCP 端口，profile 里也没有 DevToolsActivePort", async () => {
    const directory = await dataDir();
    const chrome = startAssistantChrome({ dataDir: directory, log: () => {} });
    chromes.push(chrome);
    await chrome.connection();
    const pid = chrome.pid();
    if (pid === null) throw new Error("Chrome 没有 PID");

    expect(await listeningPorts(pid), "助理 Chrome 不听任何 TCP 端口").toEqual([]);
    expect(existsSync(join(chromeProfileDir(directory), "DevToolsActivePort"))).toBe(false);
  }, 20_000);

  it("Chrome 被杀后在途命令以中文错误结束，不自己重起，下次要连接时再起", async () => {
    const directory = await dataDir();
    const chrome = startAssistantChrome({ dataDir: directory, log: () => {} });
    chromes.push(chrome);
    const connection = await chrome.connection();
    const firstPid = chrome.pid();
    if (firstPid === null) throw new Error("Chrome 没有 PID");
    const { targetId } = await connection.send("Target.createTarget", { url: "about:blank", background: true });
    const { sessionId } = await connection.send("Target.attachToTarget", { targetId, flatten: true });
    const inFlight = connection
      .send("Runtime.evaluate", { expression: "new Promise(() => {})", awaitPromise: true }, String(sessionId))
      .then(
        () => "居然回了结果",
        (error: unknown) => String(error),
      );

    process.kill(firstPid, "SIGKILL");

    const outcome = await Promise.race([inFlight, delay(5_000).then(() => "等了 5 秒还挂着")]);
    expect(outcome, "在途命令当场以错误结束").toContain("助理 Chrome 退出了");
    await delay(500);
    expect(await profileChromePids(chromeProfileDir(directory)), "没人要就不重起").toEqual([]);

    const again = await chrome.connection();
    expect(chrome.pid(), "下次要连接时起的是新 Chrome").not.toBe(firstPid);
    expect(String((await again.send("Browser.getVersion")).product)).toContain("Chrome");
  }, 30_000);
});

describe.runIf(realChrome)("助理 Chrome 被杀的那一刻", () => {
  it("SIGKILL 之后紧接着要连接，拿到的是新 Chrome 的连接，命令照常回", async () => {
    const chrome = startAssistantChrome({ dataDir: await dataDir(), log: () => {} });
    chromes.push(chrome);
    const first = await chrome.connection();
    const firstPid = chrome.pid();
    if (firstPid === null) throw new Error("Chrome 没有 PID");

    process.kill(firstPid, "SIGKILL");
    const again = await chrome.connection();

    expect(again, "不是被杀的那条旧连接").not.toBe(first);
    expect(chrome.pid()).not.toBe(firstPid);
    expect(String((await again.send("Browser.getVersion")).product)).toMatch(/Chrome/u);
  }, 30_000);
});

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

// Chrome 单例 socket 的报文：让已在跑的实例打开 url。能连上它就能让带登录态的助理 Chrome 替自己开网址。
const openThroughSingleton = (url: string): string => {
  const message = JSON.stringify(`START\0/tmp\0/x/chrome\0${url}\0`);
  return `const s=require("node:net").connect("SingletonSocket");s.on("connect",()=>s.end(${message}));s.on("data",(d)=>{process.stdout.write("REPLY "+d+"\\n");s.destroy()});s.on("error",(e)=>process.stdout.write("REFUSED "+e.code+"\\n"))`;
};

describe.runIf(realChrome)("助理 Chrome 的单例 socket", () => {
  it("落在 profile 里，批了联网和写 /tmp 的 Bot bash 列不出、连不上，Chrome 不替它开网址", async () => {
    const directory = await dataDir();
    const chrome = startAssistantChrome({ dataDir: directory, log: () => {} });
    chromes.push(chrome);
    await chrome.connection();
    const profileDir = await realpath(chrome.profileDir);
    const socket = await realpath(join(profileDir, "SingletonSocket"));
    expect(socket.startsWith(`${profileDir}/`), `SingletonSocket 指到 ${socket}`).toBe(true);

    const hits: string[] = [];
    const server = createServer((request, response) => {
      hits.push(request.url ?? "");
      response.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("没有拿到本地测试端口");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const workDir = join(directory, "bot-1", "work");
      await mkdir(workDir, { recursive: true });
      const bash = createSandboxedBash(
        workDir,
        forbiddenZones(botDirs(directory, BotId.parse("bot-1")), chrome.profileDir),
        () => "run-singleton",
      );
      bash.allow("run-singleton", "call-singleton", {
        network: true,
        writePaths: [join("/tmp", `p1-5-singleton-${process.pid}`, "x")],
      });
      const socketDir = dirname(socket);
      const probe = [
        `ls -d /var/folders/*/*/T/com.google.Chrome.* /tmp/org.chromium.Chromium.* 2>/dev/null`,
        `ls -A ${shellQuote(profileDir)} 2>/dev/null`,
        `(cd ${shellQuote(socketDir)} 2>/dev/null && ${shellQuote(process.execPath)} -e ${shellQuote(openThroughSingleton(`${origin}/from-bash`))})`,
        "true",
      ].join("; ");
      const result = await bash.tool.execute(
        "call-singleton",
        { command: probe },
        undefined,
        undefined,
        undefined as never,
      );
      const output = JSON.stringify(result.content);
      expect(output, "列不出单例 socket 所在的目录").not.toContain(basename(socketDir));
      expect(output, "列不出 profile").not.toContain("SingletonSocket");
      expect(output, "连不上单例 socket").not.toContain("REPLY");

      // 沙箱外按同样的报文再开一次，这一次落地了，说明 socket 本身是通的，前一次没开是被挡住了。
      const control = await new Promise<string>((resolve, reject) => {
        execFile(
          process.execPath,
          ["-e", openThroughSingleton(`${origin}/control`)],
          { cwd: socketDir },
          (error, stdout) => (error === null ? resolve(stdout) : reject(error)),
        );
      });
      expect(control).toContain("REPLY ACK");
      await poll(() => (hits.includes("/control") ? true : undefined), 10_000, "沙箱外的报文让 Chrome 打开 /control");
      expect(hits, "Bot bash 那一次没让 Chrome 开网址").not.toContain("/from-bash");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);
});

describe.runIf(realChrome)("助理 Chrome 进程", () => {
  it("收尾时 Chrome 进程一起退出", async () => {
    const chrome = startAssistantChrome({ dataDir: await dataDir(), log: () => {} });
    chromes.push(chrome);
    await chrome.connection();
    const pid = chrome.pid();
    if (pid === null) throw new Error("Chrome 没有 PID");

    await chrome.stop();

    expect(() => process.kill(pid, 0)).toThrow();
  }, 20_000);

  it("代理进程被 SIGKILL 后它的 Chrome 跟着退，再起时这个 profile 只剩新守护的一个 Chrome，管道连得上", async () => {
    const directory = await dataDir();
    const profileDir = chromeProfileDir(directory);
    const first = await startHost(directory);

    first.child.kill("SIGKILL");
    await exited(first.child);
    await poll(() => (isAlive(first.ready.pid) ? undefined : true), 10_000, "管道断开后旧 Chrome 自己退出");

    const second = await startHost(directory);

    expect(await profileChromePids(profileDir), "进程表里这个 profile 只剩一个 Chrome，就是新守护报的那个").toEqual([
      second.ready.pid,
    ]);
    expect(second.ready.product, `新守护经管道拿到了版本：${second.log()}`).toContain("Chrome");

    second.child.kill("SIGTERM");
    await exited(second.child);
    expect(await profileChromePids(profileDir), "新守护正常停机后不留 Chrome").toEqual([]);
  }, 60_000);
});
