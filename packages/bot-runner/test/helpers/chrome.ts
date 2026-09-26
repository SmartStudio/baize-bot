import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const CHROME_BINARIES: Readonly<Partial<Record<NodeJS.Platform, string>>> = {
  darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  linux: "/usr/bin/chromium",
};

export const chromeBinary = ((): string | null => {
  const binary = CHROME_BINARIES[process.platform];
  return binary !== undefined && existsSync(binary) ? binary : null;
})();

export interface TestChrome {
  readonly cdpUrl: string;
  readonly pid: number;
  stop(): Promise<void>;
}

// 用例起的 Chrome 走无头模式，不在桌面上弹窗；实机不抢焦点的证据另外采。
export async function launchTestChrome(profileDir: string): Promise<TestChrome> {
  if (chromeBinary === null) throw new Error("这台电脑上没有 Chrome");
  const child = spawn(
    chromeBinary,
    [
      `--user-data-dir=${profileDir}`,
      "--headless=new",
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      "--no-first-run",
      "--no-default-browser-check",
      "--password-store=basic",
      "--use-mock-keychain",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const pid = child.pid;
  if (pid === undefined) throw new Error("Chrome 没有 PID");
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const port = Number(readFileSync(`${profileDir}/DevToolsActivePort`, "utf8").split("\n", 1)[0]);
      const url = `http://127.0.0.1:${port}`;
      const response = await fetch(`${url}/json/version`);
      if (response.ok) {
        return {
          cdpUrl: url,
          pid,
          stop: async () => {
            child.kill("SIGKILL");
            await exited;
          },
        };
      }
    } catch {
      // Chrome 还没写 DevToolsActivePort 或还没开始听。
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error("等了 15s 还没等到 Chrome 的 CDP");
    }
    await delay(50);
  }
}

export interface PageTarget {
  readonly id: string;
  readonly url: string;
  readonly webSocketDebuggerUrl: string;
}

export async function pageTargets(cdpUrl: string): Promise<PageTarget[]> {
  const response = await fetch(`${cdpUrl}/json/list`);
  const list = (await response.json()) as Array<PageTarget & { readonly type: string }>;
  return list.filter((target) => target.type === "page");
}

async function sendIn(target: PageTarget, method: string, params: Record<string, unknown>): Promise<unknown> {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("连不上标签页的 CDP")), { once: true });
  });
  try {
    socket.send(JSON.stringify({ id: 1, method, params }));
    return await new Promise((resolve, reject) => {
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as {
          id?: number;
          result?: unknown;
          error?: { message: string };
        };
        if (message.id !== 1) return;
        if (message.error !== undefined) reject(new Error(message.error.message));
        else resolve(message.result);
      });
    });
  } finally {
    socket.close();
  }
}

/** 在某个标签页里求一个表达式的值，用例用它看页面的真实状态。 */
export async function evaluateIn(target: PageTarget, expression: string): Promise<unknown> {
  const result = (await sendIn(target, "Runtime.evaluate", { expression, returnByValue: true })) as {
    result?: { value?: unknown };
  };
  return result.result?.value;
}

/** 用例自己截一张，base64，和 Bot 截到的比。 */
export async function captureIn(target: PageTarget): Promise<string> {
  const result = (await sendIn(target, "Page.captureScreenshot", { format: "png" })) as { data: string };
  return result.data;
}

/** 用前台方式开一个标签页，冒充用户自己正在看的那一页。 */
export async function openUserTab(cdpUrl: string, url: string): Promise<PageTarget> {
  const response = await fetch(`${cdpUrl}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  return (await response.json()) as PageTarget;
}
