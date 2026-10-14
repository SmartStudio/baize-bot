import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { type CdpConnection, connectPipe } from "../../src/cdp.js";

const CHROME_BINARIES: Readonly<Partial<Record<NodeJS.Platform, string>>> = {
  darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  linux: "/usr/bin/chromium",
};

export const chromeBinary = ((): string | null => {
  if (process.env.BAIZE_TEST_FAKE_CDP_ONLY === "1") return null;
  const binary = CHROME_BINARIES[process.platform];
  return binary !== undefined && existsSync(binary) ? binary : null;
})();

export interface TestChrome {
  readonly connection: CdpConnection;
  readonly pid: number;
  stop(): Promise<void>;
}

// 用例起的 Chrome 走无头模式，不在桌面上弹窗；实机不抢焦点的证据另外采。和产品一样走管道，不开调试端口。
export async function launchTestChrome(profileDir: string): Promise<TestChrome> {
  if (chromeBinary === null) throw new Error("这台电脑上没有 Chrome");
  const child = spawn(
    chromeBinary,
    [
      `--user-data-dir=${profileDir}`,
      "--headless=new",
      "--remote-debugging-pipe",
      "--no-first-run",
      "--no-default-browser-check",
      "--password-store=basic",
      "--use-mock-keychain",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
  );
  const pid = child.pid;
  if (pid === undefined) throw new Error("Chrome 没有 PID");
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const toChrome = child.stdio[3] as Writable;
  const fromChrome = child.stdio[4] as Readable;
  void exited.then(() => {
    toChrome.destroy();
    fromChrome.destroy();
  });
  const connection = connectPipe({ toChrome, fromChrome });
  const stop = async (): Promise<void> => {
    child.kill("SIGKILL");
    await exited;
  };
  try {
    await connection.send("Browser.getVersion");
  } catch (error) {
    await stop();
    throw error;
  }
  return { connection, pid, stop };
}

export interface PageTarget {
  readonly id: string;
  readonly url: string;
  readonly connection: CdpConnection;
}

export async function pageTargets(connection: CdpConnection): Promise<PageTarget[]> {
  const { targetInfos } = (await connection.send("Target.getTargets")) as {
    targetInfos: Array<{ targetId: string; type: string; url: string }>;
  };
  return targetInfos
    .filter((target) => target.type === "page")
    .map((target) => ({ id: target.targetId, url: target.url, connection }));
}

async function sendIn(target: PageTarget, method: string, params: Record<string, unknown>): Promise<unknown> {
  const { sessionId } = await target.connection.send("Target.attachToTarget", { targetId: target.id, flatten: true });
  try {
    return await target.connection.send(method, params, String(sessionId));
  } finally {
    await target.connection.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
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
export async function openUserTab(connection: CdpConnection, url: string): Promise<PageTarget> {
  const { targetId } = await connection.send("Target.createTarget", { url });
  return { id: String(targetId), url, connection };
}

/**
 * Target.closeTarget 先回 success，标签页等 detachedFromTarget 之后才从清单里消失，所以看关没关要等它落定。
 * 等到 settled 成立或 3 秒到头，回最后一次看到的清单，由用例自己断言。
 */
export async function settledPages(
  connection: CdpConnection,
  settled: (pages: readonly PageTarget[]) => boolean,
): Promise<PageTarget[]> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const pages = await pageTargets(connection);
    if (settled(pages) || Date.now() > deadline) return pages;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export async function settledPageCount(connection: CdpConnection, expected: number): Promise<number> {
  return (await settledPages(connection, (pages) => pages.length === expected)).length;
}
