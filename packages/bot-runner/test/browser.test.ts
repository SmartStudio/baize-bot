import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BotBrowser, createBotBrowser } from "../src/browser.js";
import { type CdpConnection, type CdpEvent, connectPipe } from "../src/cdp.js";
import { chromeBinary, launchTestChrome, pageTargets, settledPageCount, type TestChrome } from "./helpers/chrome.js";

const resultText = (result: { content: ReadonlyArray<{ type: string; text?: string }> }): string =>
  result.content.flatMap((block) => (block.type === "text" ? [block.text ?? ""] : [])).join("\n");

const call = async (browser: BotBrowser, name: string, params: Record<string, unknown> = {}): Promise<string> => {
  const tool = browser.tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`没有工具 ${name}`);
  return resultText(await tool.execute(`call-${name}`, params as never, undefined, undefined, undefined as never));
};

const errorOf = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "（没有报错）",
    (error: unknown) => String(error),
  );

async function startSite(): Promise<{ readonly url: string; close(): Promise<void> }> {
  const server = createHttpServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><meta charset="utf-8"><title>页 ${path}</title><p>PAGE-TEXT${path}</p>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("测试服务没有端口");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** 同一条管道外面再包一层，冒充另一条连接，或者让某条命令失败一次。 */
function wrap(
  inner: CdpConnection,
  intercept: (method: string) => Error | null = () => null,
): CdpConnection & { alive: boolean } {
  const wrapped = {
    alive: true,
    send: (method: string, params?: Record<string, unknown>, sessionId?: string) => {
      const failure = intercept(method);
      return failure === null ? inner.send(method, params, sessionId) : Promise.reject(failure);
    },
    onEvent: (listener: (event: CdpEvent) => void) => inner.onEvent(listener),
    isOpen: () => wrapped.alive && inner.isOpen(),
  };
  return wrapped;
}

describe.skipIf(chromeBinary === null)("助理浏览器走管道（真 Chrome）", () => {
  let chrome: TestChrome;
  let site: Awaited<ReturnType<typeof startSite>>;
  let profileDir = "";
  const opened: BotBrowser[] = [];

  beforeAll(async () => {
    profileDir = mkdtempSync(join(tmpdir(), "baize-browser-pipe-"));
    chrome = await launchTestChrome(profileDir);
    site = await startSite();
  }, 30_000);

  afterAll(async () => {
    await Promise.all(opened.map((browser) => browser.close()));
    await chrome?.stop();
    await site?.close();
    rmSync(profileDir, { recursive: true, force: true });
  });

  const botBrowser = (connection: () => Promise<CdpConnection> = async () => chrome.connection): BotBrowser => {
    const browser = createBotBrowser({ profileDir, connection });
    opened.push(browser);
    return browser;
  };
  const pageCount = async (): Promise<number> => (await pageTargets(chrome.connection)).length;
  const settled = (expected: number): Promise<number> => settledPageCount(chrome.connection, expected);

  it("一个 Bot 同时来三个调用只建一个标签页", async () => {
    const before = await pageCount();
    const browser = botBrowser();

    await Promise.all([
      call(browser, "browser_snapshot"),
      call(browser, "browser_snapshot"),
      call(browser, "browser_snapshot"),
    ]);

    expect(await pageCount(), "调用串行，第二个调用复用第一个建的页").toBe(before + 1);
    await browser.close();
    expect(await settled(before)).toBe(before);
  });

  it("两个 Bot 共用一条管道，各读各的页", async () => {
    const [first, second] = [botBrowser(), botBrowser()];
    await Promise.all([
      call(first, "browser_open", { url: `${site.url}/first` }),
      call(second, "browser_open", { url: `${site.url}/second` }),
    ]);

    expect(await call(first, "browser_snapshot")).toContain("PAGE-TEXT/first");
    expect(await call(second, "browser_snapshot")).toContain("PAGE-TEXT/second");
  });

  it("标签页被关掉后重开一页，告诉模型上次在哪", async () => {
    const browser = botBrowser();
    await call(browser, "browser_open", { url: `${site.url}/closed-under-me` });
    const mine = (await pageTargets(chrome.connection)).find((target) => target.url.endsWith("/closed-under-me"));
    if (mine === undefined) throw new Error("找不到 Bot 的标签页");
    const before = await pageCount();

    await chrome.connection.send("Target.closeTarget", { targetId: mine.id });
    const page = await call(browser, "browser_snapshot").catch(() => call(browser, "browser_snapshot"));

    expect(page).toContain(`标签页断开后重开过，上次在 ${site.url}/closed-under-me`);
    expect(await settled(before), "关掉的那页换成新开的一页").toBe(before);
  });

  it("换了一条连接时，先在旧连接上关旧页再开新页，提示 Chrome 重启过", async () => {
    const old = wrap(chrome.connection);
    let current: CdpConnection = old;
    const browser = botBrowser(async () => current);
    const before = await pageCount();
    await call(browser, "browser_open", { url: `${site.url}/moved` });

    current = wrap(chrome.connection);
    const page = await call(browser, "browser_snapshot");

    expect(page).toContain(`Chrome 重启过，上次在 ${site.url}/moved`);
    expect(await settled(before + 1), "旧页关掉，只剩新开的一页").toBe(before + 1);
  });

  it("开标签页半路失败，建好的那页不留下", async () => {
    let failAttach = true;
    const flaky = wrap(chrome.connection, (method) => {
      if (method !== "Target.attachToTarget" || !failAttach) return null;
      failAttach = false;
      return new Error("attach 失败一次");
    });
    const browser = botBrowser(async () => flaky);
    const before = await pageCount();

    expect(await errorOf(call(browser, "browser_snapshot")), "createTarget 回来了，attachToTarget 失败").toContain(
      "attach 失败一次",
    );
    await call(browser, "browser_snapshot");

    expect(await settled(before + 1), "半路建好的页被收掉，只剩这次开的一页").toBe(before + 1);
    await browser.close();
    expect(await settled(before), "关 Bot 的浏览器后一页不剩").toBe(before);
  });
});

function fakePipe() {
  const toChrome = new PassThrough();
  const fromChrome = new PassThrough();
  const written: string[] = [];
  toChrome.on("data", (chunk: Buffer) => written.push(...chunk.toString("utf8").split("\0").filter(Boolean)));
  return {
    pipe: { toChrome, fromChrome },
    fromChrome,
    written,
    reply: (text: string) => fromChrome.write(`${text}\0`),
  };
}

describe("管道上的 CDP 客户端", () => {
  it("收到不是 JSON 的消息就丢掉，连接照常能用", async () => {
    const fake = fakePipe();
    const connection = connectPipe(fake.pipe);
    fake.reply("not json {");
    const version = connection.send("Browser.getVersion");
    await new Promise((resolve) => setImmediate(resolve));
    const { id } = JSON.parse(fake.written[0] ?? "{}") as { id: number };
    // 一条应答拆成两段到，按 NUL 才算完整。
    fake.fromChrome.write(`{"id":${id},"result":`);
    fake.fromChrome.write(`{"ok":true}}\0`);

    expect(await version).toEqual({ ok: true });
    expect(connection.isOpen()).toBe(true);
  });

  it("事件带着 sessionId 分给监听者，退订后不再收到", async () => {
    const fake = fakePipe();
    const connection = connectPipe(fake.pipe);
    const seen: CdpEvent[] = [];
    const unsubscribe = connection.onEvent((event) => seen.push(event));
    fake.reply('{"method":"Page.loadEventFired","params":{},"sessionId":"S1"}');
    await new Promise((resolve) => setImmediate(resolve));
    unsubscribe();
    fake.reply('{"method":"Page.loadEventFired","params":{},"sessionId":"S2"}');
    await new Promise((resolve) => setImmediate(resolve));

    expect(seen).toEqual([{ method: "Page.loadEventFired", params: {}, sessionId: "S1" }]);
  });

  it("管道断了，在途命令当场报错，之后的命令直接报错", async () => {
    const fake = fakePipe();
    const connection = connectPipe(fake.pipe);
    const inFlight = errorOf(connection.send("Runtime.evaluate", { expression: "1" }, "S1"));
    fake.fromChrome.end();

    expect(await inFlight).toContain("助理 Chrome 退出了");
    expect(connection.isOpen()).toBe(false);
    expect(await errorOf(connection.send("Browser.getVersion"))).toContain("下次用时会重新起");
  });

  it("写端报 EPIPE 不会把进程带崩，在途命令报错", async () => {
    const fake = fakePipe();
    const connection = connectPipe(fake.pipe);
    const inFlight = errorOf(connection.send("Browser.getVersion"));
    fake.pipe.toChrome.destroy(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));

    expect(await inFlight).toContain("助理 Chrome 退出了");
  });
});
