import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { startAssistantChrome, type AssistantChrome } from "../src/chrome.js";
import { chromeProfileDir, isAlive, profileChromePids, reapProfileChromes } from "../src/chrome-process.js";

const chromes: AssistantChrome[] = [];
const dataDirs: string[] = [];

async function poll<T>(get: () => T | undefined, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = get();
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
  readonly ready: { readonly pid: number; readonly cdpUrl: string };
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
  for (const host of hosts.splice(0)) host.kill("SIGKILL");
  await Promise.all(chromes.splice(0).map((chrome) => chrome.stop()));
  await Promise.all(dataDirs.map((directory) => reapProfileChromes(chromeProfileDir(directory))));
  await Promise.all(dataDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("助理 Chrome 按需起", () => {
  it("构造时不起 Chrome，要 CDP 时才起，起不来就 reject，下次再要再起", async () => {
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
    expect(launches, "没人要 CDP 就不起").toBe(0);

    await expect(chrome.cdpUrl()).rejects.toThrow("助理 Chrome 起不来：没装 Chrome");
    await expect(chrome.cdpUrl()).rejects.toThrow("助理 Chrome 起不来：没装 Chrome");
    expect(launches).toBe(2);
  });
});

describe.runIf(process.platform === "darwin")("助理专用 Chrome", () => {
  it("本地静态页按钮加出登录后元素后返回账号", async () => {
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
      platformPages: {
        xiaohongshu: {
          url: `http://127.0.0.1:${address.port}/`,
          successSelector: ".user-info .user_avatar",
          handleSelector: ".user-info span",
        },
      },
      activateProcess: async () => {},
      backgroundProcess: async () => {},
    });
    chromes.push(chrome);

    try {
      await expect(chrome.login("xiaohongshu", AbortSignal.timeout(5_000))).resolves.toEqual({
        login: "valid",
        handle: "白泽工厂日记",
      });
      const targets = (await (await fetch(`${await chrome.cdpUrl()}/json/list`)).json()) as { url: string }[];
      expect(
        targets.map((target) => target.url).filter((url) => url.startsWith(`http://127.0.0.1:${address.port}`)),
        "登录完关掉登录页，不越攒越多",
      ).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);

  it("登录元素在上限内没出现就返回 expired", async () => {
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
      platformPages: {
        xiaohongshu: {
          url: `http://127.0.0.1:${address.port}/`,
          successSelector: ".user-info .user_avatar",
          handleSelector: ".user-info span",
        },
      },
      activateProcess: async () => {},
      backgroundProcess: async () => {},
    });
    chromes.push(chrome);

    try {
      await expect(chrome.login("xiaohongshu", AbortSignal.timeout(300))).resolves.toEqual({ login: "expired" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);

  it("Chrome 进程被杀后自动重起", async () => {
    const chrome = startAssistantChrome({
      dataDir: await dataDir(),
      log: () => {},
      backoff: { initialMs: 20, maxMs: 20, factor: 1 },
    });
    chromes.push(chrome);
    await chrome.cdpUrl();
    const firstPid = chrome.pid();
    if (firstPid === null) throw new Error("Chrome 没有 PID");

    process.kill(firstPid, "SIGKILL");
    const restartedPid = await poll(
      () => {
        const pid = chrome.pid();
        return pid !== null && pid !== firstPid ? pid : undefined;
      },
      10_000,
      "Chrome 重起",
    );

    expect(restartedPid).not.toBe(firstPid);
    await expect(chrome.cdpUrl()).resolves.toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
  }, 20_000);

  it("收尾时 Chrome 进程一起退出", async () => {
    const chrome = startAssistantChrome({ dataDir: await dataDir(), log: () => {} });
    chromes.push(chrome);
    await chrome.cdpUrl();
    const pid = chrome.pid();
    if (pid === null) throw new Error("Chrome 没有 PID");

    await chrome.stop();

    expect(() => process.kill(pid, 0)).toThrow();
  }, 20_000);

  it("代理进程被 SIGKILL 后再起，这个 profile 只剩新守护的一个 Chrome，CDP 连得上", async () => {
    const directory = await dataDir();
    const profileDir = chromeProfileDir(directory);
    const first = await startHost(directory);

    first.child.kill("SIGKILL");
    await exited(first.child);
    expect(isAlive(first.ready.pid), "前提：宿主被强杀后它的 Chrome 成了孤儿").toBe(true);

    const restartedAt = Date.now();
    const second = await startHost(directory);

    // 旧孤儿还占着 profile 时，Chrome 自己的单例会把新起的实例并进孤儿。守护若先认领孤儿，
    // 就要干等 15 秒 CDP 超时才失败重起，这段时间 Bot 用不了浏览器。
    expect(Date.now() - restartedAt, `再起的守护认领了孤儿：${second.log()}`).toBeLessThan(10_000);
    expect(await profileChromePids(profileDir), "进程表里这个 profile 只剩一个 Chrome，就是新守护报的那个").toEqual([
      second.ready.pid,
    ]);
    const version = await fetch(`${second.ready.cdpUrl}/json/version`, { signal: AbortSignal.timeout(2_000) });
    expect(version.status).toBe(200);

    second.child.kill("SIGTERM");
    await exited(second.child);
    expect(await profileChromePids(profileDir), "新守护正常停机后不留 Chrome").toEqual([]);
  }, 60_000);
});
