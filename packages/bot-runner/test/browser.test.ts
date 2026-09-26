import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer, connect as netConnect, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BotBrowser, createBotBrowser } from "../src/browser.js";
import { browserSocketUrl, connectCdp } from "../src/cdp.js";
import {
  chromeBinary,
  evaluateIn,
  launchTestChrome,
  openUserTab,
  type PageTarget,
  pageTargets,
  type TestChrome,
} from "./helpers/chrome.js";

const listen = async (server: Server | ReturnType<typeof createHttpServer>): Promise<number> => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("测试服务没有端口");
  return address.port;
};

const closeServer = (server: Server | ReturnType<typeof createHttpServer>): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

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

/** 攻击页：302、链接、脚本跳转和图片地址都指向 `to`。每条路径的访问次数记在 hits 里。 */
async function startTrapSite(): Promise<{
  readonly url: string;
  readonly hits: Map<string, number>;
  close(): Promise<void>;
}> {
  const hits = new Map<string, number>();
  const server = createHttpServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1);
    const to = url.searchParams.get("to") ?? "";
    if (url.pathname === "/redirect") {
      response.writeHead(302, { location: to });
      response.end();
      return;
    }
    const body: Record<string, string> = {
      "/link": `<a id="go" href="${to}">去看看</a>`,
      "/script-go": `<p>马上跳走</p><script>location.href = ${JSON.stringify(to)};</script>`,
      "/image": `<p>一张图</p><img src="${to}">`,
    };
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      `<!doctype html><meta charset="utf-8"><title>陷阱 ${url.pathname}</title>${body[url.pathname] ?? `<p>PAGE-TEXT${url.pathname}</p>`}`,
    );
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, hits, close: () => closeServer(server) };
}

/**
 * 夹在 Bot 和 Chrome 之间的 TCP 转发。Chrome 按 Host 头拼 webSocketDebuggerUrl，所以 WebSocket 也走这里。
 * cut() 掐断现有连接；cutAtReply(n) 让下一条 WebSocket 连接在 Chrome 回第 n 段数据时断掉，这段不转给 Bot。
 */
async function startCdpProxy(cdpUrl: string) {
  const target = Number(new URL(cdpUrl).port);
  const sockets = new Set<Socket>();
  let cutAt: number | null = null;
  const server = createNetServer((client) => {
    const upstream = netConnect(target, "127.0.0.1");
    let replies: number | null = null;
    const drop = (): void => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    sockets.add(client);
    sockets.add(upstream);
    client.pipe(upstream);
    upstream.on("data", (chunk: Buffer) => {
      if (replies === null && cutAt !== null && chunk.subarray(0, 12).toString() === "HTTP/1.1 101") replies = 0;
      else if (replies !== null && (replies += 1) === cutAt) {
        cutAt = null;
        drop();
        return;
      }
      client.write(chunk);
    });
    client.on("close", drop);
    upstream.on("close", drop);
    client.on("error", drop);
    upstream.on("error", drop);
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}`,
    cut: () => {
      for (const socket of sockets) socket.destroy();
    },
    cutAtReply: (n: number) => {
      cutAt = n;
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    },
  };
}

describe.skipIf(chromeBinary === null)("助理浏览器挡 CDP 端口（真 Chrome）", () => {
  let chrome: TestChrome;
  let site: Awaited<ReturnType<typeof startTrapSite>>;
  let profileDir = "";
  let victim: PageTarget;
  const opened: BotBrowser[] = [];

  beforeAll(async () => {
    profileDir = mkdtempSync(join(tmpdir(), "baize-browser-cdp-"));
    chrome = await launchTestChrome(profileDir);
    site = await startTrapSite();
    victim = await openUserTab(chrome.cdpUrl, `${site.url}/victim`);
  }, 30_000);

  afterAll(async () => {
    await Promise.all(opened.map((browser) => browser.close()));
    await chrome?.stop();
    await site?.close();
    rmSync(profileDir, { recursive: true, force: true });
  });

  const botBrowser = (): BotBrowser => {
    const browser = createBotBrowser({ profileDir, cdpUrl: async () => chrome.cdpUrl });
    opened.push(browser);
    return browser;
  };
  const cdpPort = (): string => new URL(chrome.cdpUrl).port;
  const victimAlive = async (): Promise<boolean> =>
    (await pageTargets(chrome.cdpUrl)).some((target) => target.id === victim.id);

  it("browser_open 只看端口：四种主机名写法都打不开 CDP 端口，页面里没有标签页清单", async () => {
    const browser = botBrowser();
    const port = cdpPort();
    for (const host of ["127.0.0.1", "0.0.0.0", "localhost.", "[::ffff:127.0.0.1]"]) {
      const error = await errorOf(call(browser, "browser_open", { url: `http://${host}:${port}/json/list` }));
      expect(error, host).toContain("不能打开助理 Chrome 自己的调试端口");
      const page = await call(browser, "browser_snapshot");
      expect(page, `${host} 之后页面里不能有别的标签页的 id`).not.toContain(victim.id);
      expect(page, host).not.toContain("webSocketDebuggerUrl");
    }
  });

  it("302、点链接、页面脚本跳转到 CDP 端口都被挡，读不到 /json/list", async () => {
    const browser = botBrowser();
    const list = encodeURIComponent(`http://127.0.0.1:${cdpPort()}/json/list`);
    const pages: string[] = [];

    const redirected = await errorOf(call(browser, "browser_open", { url: `${site.url}/redirect?to=${list}` }));
    pages.push(redirected, await call(browser, "browser_snapshot"));

    await call(browser, "browser_open", { url: `${site.url}/link?to=${list}` });
    await call(browser, "browser_click", { ref: 1 }).catch((error: unknown) => pages.push(String(error)));
    pages.push(await call(browser, "browser_snapshot"));

    await call(browser, "browser_open", { url: `${site.url}/script-go?to=${list}` }).catch((error: unknown) =>
      pages.push(String(error)),
    );
    await delay(500);
    pages.push(await call(browser, "browser_snapshot"));

    expect(site.hits.get("/redirect"), "302 那一页真被请求过").toBe(1);
    expect(site.hits.get("/link")).toBe(1);
    expect(site.hits.get("/script-go")).toBe(1);
    for (const page of pages) {
      expect(page, "页面和报错里都不能有别的标签页的 id").not.toContain(victim.id);
      expect(page).not.toContain("webSocketDebuggerUrl");
    }
    expect(redirected, "302 跳到调试端口时告诉模型被挡了").toContain("调试端口");
  });

  it("页面里的图片地址指向 /json/close 也关不掉别人的标签页", async () => {
    const browser = botBrowser();
    const close = encodeURIComponent(`http://127.0.0.1:${cdpPort()}/json/close/${victim.id}`);
    expect(await victimAlive()).toBe(true);

    await call(browser, "browser_open", { url: `${site.url}/image?to=${close}` });
    await delay(500);

    expect(await victimAlive(), "用户的标签页还在").toBe(true);
    expect(await evaluateIn(victim, "location.pathname")).toBe("/victim");
  });

  it("一个 Bot 同时来三个调用只建一个标签页", async () => {
    const before = (await pageTargets(chrome.cdpUrl)).length;
    const browser = botBrowser();

    await Promise.all([
      call(browser, "browser_snapshot"),
      call(browser, "browser_snapshot"),
      call(browser, "browser_snapshot"),
    ]);

    expect((await pageTargets(chrome.cdpUrl)).length, "调用串行，第二个调用复用第一个建的页").toBe(before + 1);
    await browser.close();
    expect((await pageTargets(chrome.cdpUrl)).length).toBe(before);
  });
});

describe.skipIf(chromeBinary === null)("助理浏览器不留孤儿标签页（真 Chrome）", () => {
  let chrome: TestChrome;
  let site: Awaited<ReturnType<typeof startTrapSite>>;
  let profileDir = "";
  const cleanups: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    profileDir = mkdtempSync(join(tmpdir(), "baize-browser-orphan-"));
    chrome = await launchTestChrome(profileDir);
    site = await startTrapSite();
  }, 30_000);

  afterAll(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    await chrome?.stop();
    await site?.close();
    rmSync(profileDir, { recursive: true, force: true });
  });

  const pageCount = async (): Promise<number> => (await pageTargets(chrome.cdpUrl)).length;
  const proxied = async () => {
    const proxy = await startCdpProxy(chrome.cdpUrl);
    cleanups.push(proxy.close);
    return proxy;
  };

  it("连接断了重开标签页时关掉旧的那页", async () => {
    const proxy = await proxied();
    const browser = createBotBrowser({ profileDir, cdpUrl: async () => proxy.url });
    cleanups.push(() => browser.close());
    const before = await pageCount();
    await call(browser, "browser_open", { url: `${site.url}/first` });

    proxy.cut();
    // 连接刚断时 WebSocket 可能还没收到 close，第一次调用撞上旧连接会报断了，第二次重开。
    await call(browser, "browser_snapshot").catch(() => call(browser, "browser_snapshot"));

    expect(await pageCount(), "旧页关掉，只剩新开的一页").toBe(before + 1);
  });

  it("Chrome 换了地址而旧连接还通时，先关旧页再开新页", async () => {
    const proxy = await proxied();
    let endpoint = proxy.url;
    const browser = createBotBrowser({ profileDir, cdpUrl: async () => endpoint });
    cleanups.push(() => browser.close());
    const before = await pageCount();
    await call(browser, "browser_open", { url: `${site.url}/moved` });

    endpoint = chrome.cdpUrl;
    await call(browser, "browser_snapshot");

    expect(await pageCount()).toBe(before + 1);
  });

  it("开标签页半路断了，建好的那页不留下", async () => {
    const proxy = await proxied();
    const browser = createBotBrowser({ profileDir, cdpUrl: async () => proxy.url });
    cleanups.push(() => browser.close());
    const before = await pageCount();

    proxy.cutAtReply(2);
    expect(await errorOf(call(browser, "browser_snapshot")), "createTarget 回来了，attachToTarget 时断了").toContain(
      "断了",
    );
    await call(browser, "browser_snapshot");

    expect(await pageCount(), "半路建好的页被收掉，只剩这次开的一页").toBe(before + 1);
    await browser.close();
    expect(await pageCount(), "关 Bot 的浏览器后一页不剩").toBe(before);
  });
});

/** 服务端发给客户端的短文本帧，不带掩码。 */
function frame(text: string): Buffer {
  const payload = Buffer.from(text);
  if (payload.length > 125) throw new Error("假服务只发短帧");
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

/** 只会握手的 WebSocket 服务：握手后先发 frames 里的每一帧，再对收到的每条命令回 `{ id: 1, result: { ok: true } }`，收到关闭帧就断开。 */
async function startFakeSocket(frames: readonly string[]) {
  const server = createHttpServer();
  server.on("upgrade", (request, socket: Socket) => {
    const accept = createHash("sha1")
      .update(`${String(request.headers["sec-websocket-key"])}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    for (const text of frames) socket.write(frame(text));
    sockets.add(socket);
    socket.on("data", (chunk: Buffer) => {
      if (((chunk[0] ?? 0) & 0x0f) === 0x8) socket.destroy();
      else socket.write(frame('{"id":1,"result":{"ok":true}}'));
    });
    socket.on("error", () => undefined);
  });
  const sockets = new Set<Socket>();
  const port = await listen(server);
  return {
    url: `ws://127.0.0.1:${port}/devtools/browser/fake`,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return closeServer(server);
    },
  };
}

describe("CDP 客户端", () => {
  it("/json/version 回的 WebSocket 地址不是 127.0.0.1 就不连", async () => {
    for (const socketUrl of ["ws://localhost:1/devtools/browser/x", "ws://10.0.0.8:9222/devtools/browser/x"]) {
      const server = createHttpServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ webSocketDebuggerUrl: socketUrl }));
      });
      const port = await listen(server);
      try {
        expect(await errorOf(browserSocketUrl(`http://127.0.0.1:${port}`)), socketUrl).toContain(
          "助理 Chrome 的 CDP 地址不在本机",
        );
      } finally {
        await closeServer(server);
      }
    }
  });

  it("端口接了 TCP 却一直不握手，5 秒左右报连不上", async () => {
    const sockets = new Set<Socket>();
    const server = createNetServer((socket) => sockets.add(socket));
    const port = await listen(server);
    try {
      const startedAt = Date.now();
      const outcome = await Promise.race([
        errorOf(connectCdp(`ws://127.0.0.1:${port}/devtools/browser/x`)),
        delay(10_000).then(() => "等了 10 秒还没结果"),
      ]);
      expect(outcome).toContain("连不上助理 Chrome");
      expect(Date.now() - startedAt).toBeLessThan(8_000);
    } finally {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    }
  });

  it("收到不是 JSON 的消息就丢掉，连接照常能用", { timeout: 10_000 }, async () => {
    const fake = await startFakeSocket(["not json {", '{"method":"Fake.event","params":{}}']);
    try {
      const connection = await connectCdp(fake.url);
      expect(await connection.send("Browser.getVersion")).toEqual({ ok: true });
      expect(connection.isOpen()).toBe(true);
      connection.close();
    } finally {
      await fake.close();
    }
  });
});
