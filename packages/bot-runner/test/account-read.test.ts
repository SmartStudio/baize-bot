import { createServer, type Server } from "node:http";
import { AccountConfig } from "@baize/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_READ_MAX_BYTES,
  ACCOUNT_READ_TOOL,
  type AccountReadLive,
  createAccountReadTool,
} from "../src/account-read.js";

const GITHUB = AccountConfig.parse({
  id: "acc-github",
  platform: "github",
  handle: "baize-dev",
  tier: "draft",
  login: "valid",
});
const X = AccountConfig.parse({ id: "acc-x", platform: "x", handle: "baize_x", tier: "read_only", login: "valid" });
const XHS = AccountConfig.parse({
  id: "acc-xhs",
  platform: "xiaohongshu",
  handle: "白泽",
  tier: "draft",
  login: "valid",
});
const GATEWAY_KEY = "gw-key-for-this-computer";

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

type Reply = { readonly status: number; readonly body: string };

const emptyJson = (): Reply => ({ status: 200, body: "{}" });

const errorOf = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "（没有报错）",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

describe("account_read 打账号代理", () => {
  const seen: Seen[] = [];
  let reply: (url: string) => Reply = emptyJson;
  let baseUrl = "";
  let server: Server | undefined;

  beforeAll(async () => {
    server = createServer((request, response) => {
      seen.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers });
      const { status, body } = reply(request.url ?? "");
      response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      response.end(body);
    });
    const listening = server;
    await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve));
    const address = listening.address();
    if (address === null || typeof address === "string") throw new Error("假代理没有端口");
    baseUrl = `http://127.0.0.1:${address.port}/accounts-proxy`;
  });

  afterAll(() => new Promise<void>((resolve) => (server === undefined ? resolve() : server.close(() => resolve()))));

  beforeEach(() => {
    seen.length = 0;
    reply = emptyJson;
  });

  const live = (accounts: readonly AccountConfig[] = [GITHUB, X, XHS]): AccountReadLive => ({
    accounts,
    proxy: { baseUrl },
    gateway: { baseUrl: "http://127.0.0.1:9/gateway/v1", apiKey: GATEWAY_KEY },
  });

  const tool = (current: () => AccountReadLive = () => live()) =>
    createAccountReadTool({ described: [GITHUB, X, XHS], live: current });

  const call = async (params: { accountId: string; path: string }, current?: () => AccountReadLive) => {
    const result = await tool(current).execute("call-1", params as never, undefined, undefined, undefined as never);
    return result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
  };

  it("描述里列出能读的 GitHub、X 号和 accountId，小红书的号不列", () => {
    const { name, description } = tool();
    expect(name).toBe(ACCOUNT_READ_TOOL);
    expect(description).toContain("GitHub @baize-dev，accountId：acc-github");
    expect(description).toContain("X @baize_x，accountId：acc-x");
    expect(description).not.toContain("acc-xhs");
  });

  it("GET 到 <baseUrl>/<accountId>/<平台路径>，查询串原样带上，请求头只有网关 key 这一把凭据，回平台原文", async () => {
    reply = () => ({ status: 200, body: '[{"number":7,"title":"假 issue"}]' });
    const text = await call({ accountId: "acc-github", path: "/repos/o/r/issues?state=open&per_page=5" });

    expect(text).toBe('[{"number":7,"title":"假 issue"}]');
    expect(seen.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: "GET", url: "/accounts-proxy/acc-github/repos/o/r/issues?state=open&per_page=5" },
    ]);
    const headers = seen[0]?.headers ?? {};
    expect(headers["authorization"], "Bearer 是网关 key").toBe(`Bearer ${GATEWAY_KEY}`);
    const carriesSecret = Object.entries(headers).filter(
      ([name, value]) => /auth|token|cookie|key/i.test(name) || String(value).includes("Bearer"),
    );
    expect(carriesSecret, "除了网关 key 那一行，没有别的像凭据的头").toEqual([
      ["authorization", `Bearer ${GATEWAY_KEY}`],
    ]);
  });

  it("网关 key 每次调用现取，config 换了 key 下一次就用新的", async () => {
    let key = "old-key";
    const current = (): AccountReadLive => ({ ...live(), gateway: { baseUrl: "http://127.0.0.1:9", apiKey: key } });
    const read = tool(current);
    await read.execute(
      "c1",
      { accountId: "acc-x", path: "2/users/me" } as never,
      undefined,
      undefined,
      undefined as never,
    );
    key = "new-key";
    await read.execute(
      "c2",
      { accountId: "acc-x", path: "2/users/me" } as never,
      undefined,
      undefined,
      undefined as never,
    );
    expect(seen.map((request) => request.headers["authorization"])).toEqual(["Bearer old-key", "Bearer new-key"]);
  });

  it("409 报登录过期、叫用户去账号页重新授权", async () => {
    reply = () => ({ status: 409, body: JSON.stringify({ error: "这个账号登录过期了，到账号页重新连一下" }) });
    expect(await errorOf(call({ accountId: "acc-github", path: "user" }))).toBe(
      "GitHub @baize-dev（accountId：acc-github） 这个号登录过期了，去账号页重新授权。",
    );
  });

  it("502 带状态码和代理的 error 文案", async () => {
    reply = () => ({ status: 502, body: JSON.stringify({ error: "连不上平台换令牌，稍后再试" }) });
    expect(await errorOf(call({ accountId: "acc-x", path: "2/tweets/search/recent?query=白泽" }))).toBe(
      "用 X @baize_x（accountId：acc-x） 读 2/tweets/search/recent?query=白泽 没成，账号代理回 502：连不上平台换令牌，稍后再试",
    );
  });

  it("平台透过来的 403 带平台自己的 message", async () => {
    reply = () => ({ status: 403, body: JSON.stringify({ message: "Resource not accessible by integration" }) });
    expect(await errorOf(call({ accountId: "acc-github", path: "repos/secret/repo" }))).toContain(
      "账号代理回 403：Resource not accessible by integration",
    );
  });

  it("config 里没有的 accountId、小红书的号、跳出账号那一段的路径，都在发请求前拒掉", async () => {
    expect(await errorOf(call({ accountId: "acc-someone-else", path: "user" }))).toBe(
      "没有 accountId 是「acc-someone-else」的账号。能读的号：GitHub @baize-dev（acc-github）、X @baize_x（acc-x）。",
    );
    expect(await errorOf(call({ accountId: "acc-xhs", path: "user" }))).toContain(
      "小红书 @白泽 不是 GitHub 或 X 的号，这个工具读不了",
    );
    expect(await errorOf(call({ accountId: "acc-github", path: "../acc-other/user" }))).toContain(
      "跳出了这个账号的接口范围",
    );
    expect(await errorOf(call({ accountId: "acc-github", path: "%2e%2e/acc-other/user" }))).toContain(
      "跳出了这个账号的接口范围",
    );
    expect(await errorOf(call({ accountId: "acc-github", path: "  " }))).toContain("path 是空的");
    expect(seen, "一条请求都没发出去").toEqual([]);
  });

  it("账号清单按调用时的 config 判：建工具之后删掉的号当场拒", async () => {
    expect(await errorOf(call({ accountId: "acc-github", path: "user" }, () => live([X])))).toContain(
      "没有 accountId 是「acc-github」的账号",
    );
    expect(seen).toEqual([]);
  });

  it("回包超过上限就截断，结果里注明已截断", async () => {
    const big = `"${"字".repeat(ACCOUNT_READ_MAX_BYTES)}"`;
    reply = () => ({ status: 200, body: big });
    const text = await call({ accountId: "acc-github", path: "repos/o/r/readme" });

    const [head, note] = text.split("\n\n（已截断");
    expect(note, "结尾有「已截断」说明").toMatch(/^：回包超过 50\.0KB，只给了前 50\.0KB/);
    expect(Buffer.byteLength(head ?? "", "utf8")).toBeLessThanOrEqual(ACCOUNT_READ_MAX_BYTES);
    expect(head?.endsWith("字"), "按字节切不留半个字").toBe(true);
    expect(big.startsWith(head ?? "（空）")).toBe(true);
  });

  it("没超上限的回包原样返回，不带截断说明", async () => {
    const exact = "a".repeat(ACCOUNT_READ_MAX_BYTES);
    reply = () => ({ status: 200, body: exact });
    expect(await call({ accountId: "acc-github", path: "x" })).toBe(exact);
  });

  it("上限处恰好是一个完整的 U+FFFD，它是正文的一部分，要留着", async () => {
    const body = `${"a".repeat(ACCOUNT_READ_MAX_BYTES - 3)}\uFFFD尾`;
    reply = () => ({ status: 200, body });
    const [head] = (await call({ accountId: "acc-github", path: "utf8" })).split("\n\n（已截断");

    expect(head, "前 50KB 恰好以一个完整的 U+FFFD 收尾").toBe(`${"a".repeat(ACCOUNT_READ_MAX_BYTES - 3)}\uFFFD`);
  });

  it.each([
    ["汉字切在第 1 个字节后", `${"a".repeat(ACCOUNT_READ_MAX_BYTES - 1)}字尾`, ACCOUNT_READ_MAX_BYTES - 1],
    ["汉字切在第 2 个字节后", `${"a".repeat(ACCOUNT_READ_MAX_BYTES - 2)}字尾`, ACCOUNT_READ_MAX_BYTES - 2],
    ["emoji 切在第 3 个字节后", `${"a".repeat(ACCOUNT_READ_MAX_BYTES - 3)}😀尾`, ACCOUNT_READ_MAX_BYTES - 3],
    ["emoji 正好收在上限处", `${"a".repeat(ACCOUNT_READ_MAX_BYTES - 4)}😀尾`, ACCOUNT_READ_MAX_BYTES],
  ])("%s：切到最后一个完整码点，不出半个字、不出替换符", async (_name, body, bytes) => {
    reply = () => ({ status: 200, body });
    const [head] = (await call({ accountId: "acc-github", path: "utf8" })).split("\n\n（已截断");

    expect(Buffer.byteLength(head ?? "", "utf8")).toBe(bytes);
    expect(body.startsWith(head ?? "（空）"), "结果是原文的前缀").toBe(true);
  });
});

describe("account_read 读完放开流", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const readWith = (body: ReadableStream<Uint8Array>, status = 200) => {
    const response = new Response(body, { status });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const tool = createAccountReadTool({
      described: [GITHUB],
      live: () => ({
        accounts: [GITHUB],
        proxy: { baseUrl: "http://127.0.0.1:9/accounts-proxy" },
        gateway: { baseUrl: "http://127.0.0.1:9/gateway/v1", apiKey: GATEWAY_KEY },
      }),
    });
    const done = tool.execute(
      "lock",
      { accountId: "acc-github", path: "big" } as never,
      undefined,
      undefined,
      undefined as never,
    );
    return { response, done };
  };

  it("读够上限 cancel 之后放开 reader，流不再被锁着，也不再往下拉", async () => {
    let pulls = 0;
    let cancels = 0;
    const { response, done } = readWith(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(Buffer.alloc(16 * 1024, "a"));
        },
        cancel() {
          cancels += 1;
        },
      }),
    );
    const result = await done;

    expect(JSON.stringify(result.content)).toContain("已截断");
    expect(cancels, "读够就 cancel").toBe(1);
    expect(response.body?.locked, "cancel 之后 reader lock 放开了").toBe(false);
    const pulled = pulls;
    await new Promise((resolve) => setImmediate(resolve));
    expect(pulls, "cancel 之后不再拉").toBe(pulled);
  });

  it("读到一半流出错，工具报错，reader lock 也放开", async () => {
    let sent = false;
    const { response, done } = readWith(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) controller.error(new Error("对端断了"));
          else controller.enqueue(Buffer.from('{"partial":'));
          sent = true;
        },
      }),
    );

    await expect(done).rejects.toThrow("对端断了");
    expect(response.body?.locked, "出错路径也放开 reader lock").toBe(false);
  });

  it("出错回包读够上限 cancel 之后同样放开", async () => {
    const { response, done } = readWith(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(Buffer.alloc(16 * 1024, "e"));
        },
      }),
      502,
    );

    await expect(done).rejects.toThrow("账号代理回 502");
    expect(response.body?.locked).toBe(false);
  });
});

describe("account_read 读大回包", () => {
  const TOTAL = 16 * 1024 * 1024;
  let written = 0;
  let status = 200;
  let finished: Promise<void> = Promise.resolve();
  let baseUrl = "";
  let server: Server | undefined;

  beforeAll(async () => {
    server = createServer((_request, response) => {
      written = 0;
      finished = (async () => {
        response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
        const chunk = Buffer.alloc(16 * 1024, "a");
        // 只数写进内核之前的字节：对端 cancel 之后 socket 关掉，写不出去的那一段不算。
        while (written < TOTAL && !response.destroyed) {
          written += chunk.length;
          if (!response.write(chunk)) {
            await new Promise<void>((resolve) => {
              response.once("drain", resolve);
              response.once("close", resolve);
            });
          }
        }
        response.end();
      })();
    });
    const listening = server;
    await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve));
    const address = listening.address();
    if (address === null || typeof address === "string") throw new Error("假代理没有端口");
    baseUrl = `http://127.0.0.1:${address.port}/accounts-proxy`;
  });

  afterAll(() => new Promise<void>((resolve) => (server === undefined ? resolve() : server.close(() => resolve()))));

  const read = async () => {
    const tool = createAccountReadTool({
      described: [GITHUB],
      live: () => ({
        accounts: [GITHUB],
        proxy: { baseUrl },
        gateway: { baseUrl: "http://127.0.0.1:9/gateway/v1", apiKey: GATEWAY_KEY },
      }),
    });
    return tool.execute(
      "big",
      { accountId: "acc-github", path: "big" } as never,
      undefined,
      undefined,
      undefined as never,
    );
  };

  it("16MB 的成功回包读够上限就 cancel，假代理实际写出去的远少于全文", async () => {
    status = 200;
    const result = await read();
    await finished;
    const text = result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");

    expect(text).toContain("（已截断：回包超过 50.0KB");
    expect(written, `假代理只写出去 ${written} 字节就被对端掐断`).toBeLessThan(TOTAL / 4);
  });

  it("16MB 的出错回包也只读一小段，错误文案截短", async () => {
    status = 502;
    const message = await errorOf(read());
    await finished;

    expect(message).toMatch(/^用 GitHub @baize-dev（accountId：acc-github） 读 big 没成，账号代理回 502：a{300}…$/);
    expect(written, `假代理只写出去 ${written} 字节就被对端掐断`).toBeLessThan(TOTAL / 4);
  });
});
