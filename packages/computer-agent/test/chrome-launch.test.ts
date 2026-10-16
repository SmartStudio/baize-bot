import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AssistantChrome, startAssistantChrome } from "../src/chrome.js";

interface Spawned {
  readonly binary: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
}

// 只换掉 spawn，看助理 Chrome 带着什么参数和环境起；收残留进程的 ps 照旧走真的 execFile。
// 假进程的管道只回 Browser.getVersion，PID 取一个不存在的，收尾时 terminate 查不到它就直接返回。
const spawned = vi.hoisted((): Spawned[] => []);
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const spawn = (binary: string, args: readonly string[], options: { env: Spawned["env"] }) => {
    spawned.push({ binary, args, env: options.env });
    const toChrome = new PassThrough();
    const fromChrome = new PassThrough();
    let buffered = "";
    toChrome.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      for (let end = buffered.indexOf("\0"); end !== -1; end = buffered.indexOf("\0")) {
        const { id } = JSON.parse(buffered.slice(0, end)) as { id: number };
        buffered = buffered.slice(end + 1);
        fromChrome.write(`${JSON.stringify({ id, result: { product: "Chrome/假的" } })}\0`);
      }
    });
    const child = Object.assign(new EventEmitter(), {
      pid: 2_000_000_000,
      exitCode: null,
      signalCode: null,
      unref: () => {},
      stdio: [null, null, null, toChrome, fromChrome],
    });
    setImmediate(() => child.emit("spawn"));
    return child;
  };
  return { ...actual, spawn };
});

const chromes: AssistantChrome[] = [];
const dataDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  spawned.length = 0;
  await Promise.all(chromes.splice(0).map((chrome) => chrome.stop()));
  await Promise.all(dataDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function launchOn(platform: NodeJS.Platform): Promise<Spawned> {
  const dataDir = await mkdtemp(join(tmpdir(), "baize-chrome-launch-"));
  dataDirs.push(dataDir);
  const chrome = startAssistantChrome({ dataDir, platform, log: () => {} });
  chromes.push(chrome);
  await chrome.connection();
  const [launched] = spawned;
  if (launched === undefined || spawned.length !== 1) throw new Error(`起了 ${spawned.length} 次 Chrome`);
  return launched;
}

describe("助理 Chrome 的启动参数和环境", () => {
  it("Linux：chromium 带关掉 AutomationControlled 的参数，时区上海、语言中文只给 Chrome，代理自己的环境不变", async () => {
    vi.stubEnv("DISPLAY", ":99");
    vi.stubEnv("TZ", "Europe/Berlin");
    vi.stubEnv("LANG", "en_US.UTF-8");

    const launched = await launchOn("linux");

    expect(launched.binary).toBe("/usr/bin/chromium");
    expect(launched.args, "navigator.webdriver 才是 false").toContain("--disable-blink-features=AutomationControlled");
    expect(launched.args, "有启动窗口就会多一条 56px 的警告条").toContain("--no-startup-window");
    expect({ TZ: launched.env["TZ"], LANG: launched.env["LANG"] }).toEqual({
      TZ: "Asia/Shanghai",
      LANG: "zh_CN.UTF-8",
    });
    expect(launched.env["DISPLAY"], "其余照代理的环境").toBe(":99");
    expect({ TZ: process.env["TZ"], LANG: process.env["LANG"] }, "代理进程自己的环境没被改").toEqual({
      TZ: "Europe/Berlin",
      LANG: "en_US.UTF-8",
    });
  });

  it("macOS：Google Chrome 带同一个参数，时区和语言跟着这台电脑，不改", async () => {
    vi.stubEnv("TZ", "Europe/Berlin");
    vi.stubEnv("LANG", "en_US.UTF-8");

    const launched = await launchOn("darwin");

    expect(launched.binary).toBe("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    expect(launched.args).toContain("--disable-blink-features=AutomationControlled");
    expect(launched.args).toContain("--no-startup-window");
    expect({ TZ: launched.env["TZ"], LANG: launched.env["LANG"] }).toEqual({
      TZ: "Europe/Berlin",
      LANG: "en_US.UTF-8",
    });
  });
});
