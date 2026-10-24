import { CreateBotResponse, type ComputerId } from "@baize/shared";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_PATH } from "../src/http/gateway.js";
import { DEFAULT_GATEWAY_LIMITS, type GatewayLimits } from "../src/http/gateway-limits.js";
import { startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { makeComputer, makeUser, PASSWORD } from "./helpers/fixtures.js";
import { helloAgent } from "./helpers/agent.js";
import { scriptedUpstream, type ChatCompletionRequest, type Upstream } from "./helpers/openai-sse.js";
import { deadUpstreamUrl, startUpstream, type FakeUpstream } from "./helpers/upstream.js";

const GATEWAY_MODEL = "gpt-plan-real";
const FAST_GATEWAY_MODEL = "gpt-fast-real";
const UPSTREAM_API_KEY = "sk-fake-upstream";

type Rig = {
  readonly server: TestServer;
  readonly database: TestDb;
  readonly upstream: FakeUpstream | null;
  readonly computerId: ComputerId;
  readonly token: string;
  /** 电脑握手时下发给它的网关 key 明文。 */
  readonly key: string;
  readonly laneHeader: string;
  call(path: string, init?: RequestInit): Promise<Response>;
};

const cleanups: (() => Promise<void>)[] = [];
const laneHeaders = new Map<string, string>();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  laneHeaders.clear();
});

type GatewayRigOptions = {
  upstream?: FakeUpstream;
  upstreamBaseUrl?: string;
  gatewayModels?: { plan: string; fast: string };
  gatewayLimits?: Partial<GatewayLimits>;
};

async function rig(options: GatewayRigOptions = {}): Promise<Rig> {
  const database = await createTestDb();
  cleanups.push(() => database.close());

  const server = await startTestServer(database.db, {
    gatewayModels: options.gatewayModels ?? { plan: GATEWAY_MODEL, fast: FAST_GATEWAY_MODEL },
    upstreamApiKey: UPSTREAM_API_KEY,
    upstreamBaseUrl: options.upstream?.baseUrl ?? options.upstreamBaseUrl ?? "http://127.0.0.1:1/v1",
    gatewayLimits: { ...DEFAULT_GATEWAY_LIMITS, ...options.gatewayLimits },
  });
  cleanups.push(() => server.close());
  const seated = await seatComputer(server, database);

  return {
    server,
    database,
    upstream: options.upstream ?? null,
    ...seated,
    call: (path, init) => fetch(`http://localhost:${server.server.port}${GATEWAY_PATH}${path}`, init),
  };
}

async function seatComputer(
  server: TestServer,
  database: TestDb,
): Promise<Pick<Rig, "computerId" | "token" | "key" | "laneHeader">> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "网关测试" })).json());
  const { agent, config } = await helloAgent(server.server.port, computer.computerId, computer.token);
  cleanups.push(async () => agent.close());
  expect((await client.post(`/api/groups/${created.group.id}/messages`, { text: "建立网关调用道" })).status).toBe(201);
  const prompt = await agent.expect("prompt");
  const laneHeader = `${prompt.botId}/${prompt.groupId}/${prompt.lane.epoch}`;
  laneHeaders.set(config.modelGateway.apiKey, laneHeader);
  agent.send({
    type: "run_done",
    runId: prompt.runId,
    botId: prompt.botId,
    groupId: prompt.groupId,
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
  });
  await agent.ack(prompt.runId);
  return { computerId: computer.computerId, token: computer.token, key: config.modelGateway.apiKey, laneHeader };
}

function chatBody(extra: Record<string, unknown> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "baize:plan", messages: [{ role: "user", content: "在吗" }], ...extra }),
  };
}

function authed(key: string, init: RequestInit): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${key}`);
  const lane = laneHeaders.get(key);
  if (lane !== undefined) headers.set("x-baize-lane", lane);
  return { ...init, headers };
}

async function startSplitSseUpstream(): Promise<FakeUpstream> {
  const server = createServer((req, res) => {
    if (req.method !== "POST" || !(req.url ?? "").startsWith("/v1/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    req.resume();
    req.on("end", () => {
      const payload = JSON.stringify({
        id: "chatcmpl-split",
        object: "chat.completion.chunk",
        model: GATEWAY_MODEL,
        choices: [{ index: 0, delta: { content: "分片" }, finish_reason: null }],
      });
      const splitAt = payload.indexOf('"model"') + 4;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write("event: note\n");
      res.write(`data: ${payload.slice(0, splitAt)}`);
      // 跨一次事件循环再写后半段，让网关必须处理未收完的 data 行。
      setImmediate(() => {
        res.write(`${payload.slice(splitAt)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    calls: [],
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

/** 一台只管回指定响应头的假上游。SCOPE 不含 test/helpers，所以就地起一台。 */
async function startHeaderUpstream(headers: Record<string, string>): Promise<{
  readonly baseUrl: string;
  close(): Promise<void>;
}> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify({ id: "chatcmpl-1", choices: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

/** 一台收下请求就再不回话的假上游。等上游回话那一段是 signal 唯一管得着的地方。 */
async function startSilentUpstream(): Promise<{
  readonly baseUrl: string;
  /** 上游收到的那份请求体。 */
  readonly received: Promise<ChatCompletionRequest>;
  readonly disconnected: Promise<void>;
  connected(): boolean;
  close(): Promise<void>;
}> {
  let sawRequest!: (body: ChatCompletionRequest) => void;
  const received = new Promise<ChatCompletionRequest>((resolve) => {
    sawRequest = resolve;
  });
  let sawDisconnect!: () => void;
  const disconnected = new Promise<void>((resolve) => {
    sawDisconnect = resolve;
  });
  let live = false;

  const server = createServer((req, res) => {
    live = true;
    res.on("close", () => {
      live = false;
      sawDisconnect();
    });
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      raw += chunk;
    });
    // 只收不回：响应永远不 writeHead，网关那头一直挂在 fetch 上。
    req.on("end", () => sawRequest(JSON.parse(raw) as ChatCompletionRequest));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    received,
    disconnected,
    connected: () => live,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}

async function startDripUpstream(options: { kind: "sse" | "json"; intervalMs: number; pieces?: number }): Promise<{
  readonly baseUrl: string;
  readonly disconnected: Promise<void>;
  close(): Promise<void>;
}> {
  let sawDisconnect!: () => void;
  const disconnected = new Promise<void>((resolve) => {
    sawDisconnect = resolve;
  });
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": options.kind === "sse" ? "text/event-stream" : "application/json" });
      if (options.kind === "json") res.write("{");
      let sent = 0;
      const timer = setInterval(() => {
        if (options.pieces !== undefined && sent === options.pieces) {
          clearInterval(timer);
          res.end(options.kind === "sse" ? "data: [DONE]\n\n" : "}");
          return;
        }
        res.write(
          options.kind === "sse"
            ? `data: ${JSON.stringify({ model: GATEWAY_MODEL, choices: [{ index: 0, delta: { content: `片${sent}` } }] })}\n\n`
            : " ",
        );
        sent += 1;
      }, options.intervalMs);
      res.on("close", () => {
        clearInterval(timer);
        if (!res.writableFinished) sawDisconnect();
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    disconnected,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}

function rejectAfter(ms: number, what: string): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error(what)), ms).unref();
  });
}

describe("网关认证", () => {
  it("没有 Authorization 返回 401", async () => {
    const r = await rig();
    const response = await r.call("/chat/completions", chatBody());

    expect(response.status).toBe(401);
    expect((await response.json()) as { error: string }).toEqual({ error: "网关 key 不对，换一把再来" });
  });

  it("编造的 key 返回 401", async () => {
    const r = await rig();
    const response = await r.call("/chat/completions", authed("c".repeat(64), chatBody()));
    expect(response.status).toBe(401);
  });

  it("重新握手之后上一把 key 失效", async () => {
    const r = await rig();
    expect((await r.call("/models", authed(r.key, {}))).status).toBe(200);

    const again = await helloAgent(r.server.server.port, r.computerId, r.token);
    cleanups.push(async () => again.agent.close());
    laneHeaders.set(again.config.modelGateway.apiKey, r.laneHeader);

    expect((await r.call("/models", authed(r.key, {}))).status, "上一条连接那把 key 该作废了").toBe(401);
    expect((await r.call("/models", authed(again.config.modelGateway.apiKey, {}))).status).toBe(200);
  });

  it("GET /models 只返回两个用途别名", async () => {
    const r = await rig();
    const response = await r.call("/models", authed(r.key, {}));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      object: "list",
      data: [
        { id: "baize:plan", object: "model", owned_by: "baize" },
        { id: "baize:fast", object: "model", owned_by: "baize" },
      ],
    });
  });
});

describe("转发", () => {
  it("换成网关的模型和上游 key 再发出去", async () => {
    const upstream = await startUpstream({ json: { id: "chatcmpl-1", choices: [] } });
    cleanups.push(() => upstream.close());
    const r = await rig({ upstream });

    const response = await r.call("/chat/completions", authed(r.key, chatBody()));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "chatcmpl-1", choices: [] });
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]?.authorization, "电脑那把 key 不许漏给上游").toBe(`Bearer ${UPSTREAM_API_KEY}`);
    expect(upstream.calls[0]?.body.model, "选哪个模型由网关说了算").toBe(GATEWAY_MODEL);
    expect(upstream.calls[0]?.body.messages).toEqual([{ role: "user", content: "在吗" }]);
  });

  it("非流式响应不把上游真模型名带回来", async () => {
    const upstream = await startUpstream({
      json: { id: "chatcmpl-1", model: GATEWAY_MODEL, choices: [] },
    });
    cleanups.push(() => upstream.close());
    const r = await rig({ upstream });

    const response = await r.call("/chat/completions", authed(r.key, chatBody()));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { model: string };
    expect(body.model).toBe("baize:plan");
    expect(body.model).not.toBe(GATEWAY_MODEL);
  });

  it("只接受 baize:plan 和 baize:fast，并映射到对应上游模型", async () => {
    const upstream = await startUpstream({ json: { id: "chatcmpl-1", choices: [] } });
    cleanups.push(() => upstream.close());
    const r = await rig({ upstream, gatewayModels: { plan: GATEWAY_MODEL, fast: FAST_GATEWAY_MODEL } });

    const fast = await r.call("/chat/completions", authed(r.key, chatBody({ model: "baize:fast" })));
    expect(fast.status).toBe(200);
    expect(upstream.calls[0]?.body.model).toBe(FAST_GATEWAY_MODEL);

    const ordinary = await r.call("/chat/completions", authed(r.key, chatBody({ model: GATEWAY_MODEL })));
    expect(ordinary.status).toBe(400);
    expect((await ordinary.json()) as { error: string }).toEqual({ error: "model 只能是 baize:plan 或 baize:fast" });

    const unknown = await r.call("/chat/completions", authed(r.key, chatBody({ model: "baize:unknown" })));
    expect(unknown.status).toBe(400);
    expect((await unknown.json()) as { error: string }).toEqual({ error: "model 只能是 baize:plan 或 baize:fast" });
    expect(upstream.calls).toHaveLength(1);
  });

  it("image_url 内容结构原样转给上游", async () => {
    const upstream = await startUpstream({ json: { id: "chatcmpl-1", choices: [] } });
    cleanups.push(() => upstream.close());
    const r = await rig({ upstream });
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "看这张图" },
          { type: "image_url", image_url: { url: "https://example.com/a.png", detail: "high" } },
        ],
      },
    ];

    const response = await r.call("/chat/completions", authed(r.key, chatBody({ messages })));

    expect(response.status).toBe(200);
    expect(upstream.calls[0]?.body.messages).toEqual(messages);
  });

  it("超过 20 MiB 的请求体返回中文 413 且不打上游", async () => {
    const upstream = await startUpstream({ json: {} });
    cleanups.push(() => upstream.close());
    const r = await rig({ upstream });
    const oversized = new Uint8Array(20 * 1024 * 1024 + 1);

    const response = await r.call(
      "/chat/completions",
      authed(r.key, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: oversized,
      }),
    );

    expect(response.status).toBe(413);
    expect((await response.json()) as { error: string }).toEqual({ error: "请求体超过 20 MiB 上限" });
    expect(upstream.calls).toHaveLength(0);
  });

  it("SSE 原样透传", async () => {
    const upstream = await startUpstream({
      stream: scriptedUpstream(() => ({ textChunks: ["你", "好", "啊"], usage: { input: 12, output: 3 } })),
    });
    cleanups.push(() => upstream.close());
    const r = await rig({ upstream });

    const response = await r.call("/chat/completions", authed(r.key, chatBody({ stream: true })));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.body, "流式响应必须有 body").not.toBeNull();

    const chunks: string[] = [];
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value, { stream: true }));
    }

    const body = chunks.join("");
    const payloads = body
      .split("\n\n")
      .filter((block) => block.startsWith("data: "))
      .map((block) => block.slice("data: ".length));
    expect(payloads.at(-1), "最后一片是 [DONE]").toBe("[DONE]");
    expect(
      payloads
        .slice(0, -1)
        .map((p) => (JSON.parse(p) as { choices: { delta: { content?: string } }[] }).choices[0]?.delta.content ?? "")
        .join(""),
    ).toBe("你好啊");
  });

  it("流式响应不把上游真模型名带回来，且支持跨 chunk 的半行", async () => {
    const upstream = await startSplitSseUpstream();
    cleanups.push(() => upstream.close());
    const r = await rig({ upstream });

    const response = await r.call("/chat/completions", authed(r.key, chatBody({ stream: true })));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("event: note\n");
    expect(body).toContain("data: [DONE]\n\n");
    const dataLine = body.split("\n").find((line) => line.startsWith("data: {"));
    expect(dataLine).toBeDefined();
    expect((JSON.parse(dataLine?.slice("data: ".length) ?? "null") as { model: string }).model).toBe("baize:plan");
    expect(body).not.toContain(GATEWAY_MODEL);
  });

  it("分片边到边转，不攒完再给", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // 头一片先放出去，后面的卡在这道闸上。闸没开就读到东西，才说明网关没在攒。
    const gated: Upstream = async function* () {
      yield JSON.stringify({ choices: [{ index: 0, delta: { content: "先" }, finish_reason: null }] });
      await gate;
      yield "[DONE]";
    };
    const upstream = await startUpstream({ stream: gated });
    cleanups.push(() => upstream.close());
    const r = await rig({ upstream });

    const response = await r.call("/chat/completions", authed(r.key, chatBody({ stream: true })));
    expect(response.body).not.toBeNull();
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();

    const first = await reader.read();
    expect(new TextDecoder().decode(first.value), "闸还没开就该读到头一片").toContain("先");

    release();
    const rest = await reader.read();
    expect(new TextDecoder().decode(rest.value)).toContain("[DONE]");
    await reader.cancel();
  });

  it("上游返回的错误状态只带状态码和中文说明回来", async () => {
    const upstream = await startUpstream({ status: 429, json: { error: { message: "rate limited" } } });
    cleanups.push(() => upstream.close());
    const r = await rig({ upstream });

    const response = await r.call("/chat/completions", authed(r.key, chatBody()));
    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("模型上游返回 429");
    expect(body.error).not.toContain("rate limited");
  });

  it("上游非 2xx 的正文只截前 200 字写控制面日志，不回给电脑", async () => {
    const errorBody = `${"a".repeat(200)}THIS_MUST_NOT_BE_LOGGED`;
    const upstream = await startUpstream({
      status: 429,
      raw: { body: errorBody, contentType: "text/plain" },
    });
    cleanups.push(() => upstream.close());
    const r = await rig({ upstream });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const response = await r.call("/chat/completions", authed(r.key, chatBody()));
      expect(response.status).toBe(429);
      const body = await response.text();
      expect(body).not.toContain(errorBody);
      const logged = log.mock.calls.flat().map(String).join(" ");
      expect(logged).toContain(errorBody.slice(0, 200));
      expect(logged).not.toContain("THIS_MUST_NOT_BE_LOGGED");
    } finally {
      log.mockRestore();
    }
  });

  it("上游返回 HTML 的 502，不把正文带回来", async () => {
    const upstream = await startUpstream({
      status: 502,
      raw: { body: "<html><body>cloudflare bad gateway</body></html>", contentType: "text/html" },
    });
    cleanups.push(() => upstream.close());
    const r = await rig({ upstream });

    const response = await r.call("/chat/completions", authed(r.key, chatBody()));
    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("模型上游返回 502");
    expect(body.error).not.toContain("<");
  });

  it("上游连不上返回 502 并说人话", async () => {
    const r = await rig({ upstreamBaseUrl: await deadUpstreamUrl() });

    const response = await r.call("/chat/completions", authed(r.key, chatBody()));

    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("连不上模型上游");
    expect(body.error).toContain("找管理员");
  });

  it("客户端中途断开，还挂在上游那条连接跟着断", async () => {
    const upstream = await startSilentUpstream();
    cleanups.push(() => upstream.close());
    const r = await rig({ upstreamBaseUrl: upstream.baseUrl });

    const controller = new AbortController();
    const pending = r
      .call("/chat/completions", { ...authed(r.key, chatBody({ stream: true })), signal: controller.signal })
      .catch(() => null);

    const forwarded = await upstream.received;
    expect(forwarded.model, "断开之前请求照样按网关的模型转出去了").toBe(GATEWAY_MODEL);
    expect(upstream.connected(), "上游还没回话，这会儿该连着").toBe(true);

    controller.abort();
    await Promise.race([upstream.disconnected, rejectAfter(2000, "客户端都走了，上游那条连接还挂着烧 token")]);
    await pending;
  });

  it("上游的响应头只放白名单里那些过去", async () => {
    const upstream = await startHeaderUpstream({
      "openai-organization": "org-someone-else",
      "set-cookie": "sid=someone-elses-session; Path=/",
      "x-ratelimit-remaining-requests": "99",
    });
    cleanups.push(() => upstream.close());
    const r = await rig({ upstreamBaseUrl: upstream.baseUrl });

    const response = await r.call("/chat/completions", authed(r.key, chatBody()));

    expect(response.headers.get("openai-organization"), "上游的组织标识不该漏给电脑").toBeNull();
    expect(response.headers.getSetCookie(), "上游的 Set-Cookie 不该漏给电脑").toEqual([]);
    expect(response.headers.get("content-type"), "白名单里的照转").toContain("application/json");
    expect(response.headers.get("x-ratelimit-remaining-requests"), "限流头按前缀放行").toBe("99");
    expect(await response.json(), "正文照旧原样带回来").toEqual({ id: "chatcmpl-1", choices: [] });
  });

  it("请求体不是 JSON 对象返回 400，不打上游", async () => {
    const upstream = await startUpstream({ json: {} });
    cleanups.push(() => upstream.close());
    const r = await rig({ upstream });

    const response = await r.call(
      "/chat/completions",
      authed(r.key, { method: "POST", headers: { "content-type": "application/json" }, body: "这不是 JSON" }),
    );

    expect(response.status).toBe(400);
    expect(upstream.calls, "认不出的请求体不该转出去").toHaveLength(0);
  });
});

describe("上游超时", () => {
  it("上游迟迟不回首字节，到首字节时限回中文 504，并断开上游", async () => {
    const upstream = await startSilentUpstream();
    cleanups.push(() => upstream.close());
    const r = await rig({ upstreamBaseUrl: upstream.baseUrl, gatewayLimits: { firstByteTimeoutMs: 400 } });

    const started = performance.now();
    const response = await r.call("/chat/completions", authed(r.key, chatBody({ stream: true })));
    const elapsed = performance.now() - started;

    expect(response.status).toBe(504);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("模型上游 0.4 秒还没开始回话");
    expect(elapsed, "首字节时限到了才断").toBeGreaterThanOrEqual(400);
    expect(elapsed, "是首字节那道表断的，不是总时长").toBeLessThan(DEFAULT_GATEWAY_LIMITS.totalTimeoutMs);
    await Promise.race([upstream.disconnected, rejectAfter(2000, "超时回了 504，上游那条连接还挂着")]);
  });

  it("上游慢慢吐，吐的时间超过首字节时限也照常转完", async () => {
    const upstream = await startDripUpstream({ kind: "sse", intervalMs: 150, pieces: 5 });
    cleanups.push(() => upstream.close());
    const r = await rig({ upstreamBaseUrl: upstream.baseUrl, gatewayLimits: { firstByteTimeoutMs: 300 } });

    const started = performance.now();
    const response = await r.call("/chat/completions", authed(r.key, chatBody({ stream: true })));
    const text = await response.text();

    expect(performance.now() - started, "整段比首字节时限长，才说明首字节那道表在回头时撤了").toBeGreaterThan(300);
    expect(response.status).toBe(200);
    expect(text).toContain("片4");
    expect(text).toContain("data: [DONE]");
    expect(text).not.toContain('"error"');
  });

  it("上游流式一直吐，总时长到了在流尾补一条中文 error 事件，并断开上游", async () => {
    const upstream = await startDripUpstream({ kind: "sse", intervalMs: 50 });
    cleanups.push(() => upstream.close());
    const r = await rig({ upstreamBaseUrl: upstream.baseUrl, gatewayLimits: { totalTimeoutMs: 1000 } });

    const started = performance.now();
    const response = await r.call("/chat/completions", authed(r.key, chatBody({ stream: true })));
    expect(response.status, "流式开头已经照常转出去了").toBe(200);
    const text = await response.text();
    const elapsed = performance.now() - started;

    expect(elapsed, "总时长到了才断").toBeGreaterThanOrEqual(1000);
    expect(elapsed, "到点就断，不等上游自己停").toBeLessThan(3000);
    expect(text, "到点之前吐的照转").toContain("片0");
    const events = text.split("\n\n").filter((event) => event.trim() !== "");
    const last = events.at(-1)?.trim() ?? "";
    expect(last.startsWith("data: "), `最后一个事件是一条单独的 data 行：${last}`).toBe(true);
    const error = (JSON.parse(last.slice("data: ".length)) as { error: { message: string; type: string } }).error;
    expect(error.type).toBe("timeout");
    expect(error.message).toContain("超过 1 秒还没说完");
    await Promise.race([upstream.disconnected, rejectAfter(2000, "流到点收尾了，上游那条连接还挂着")]);
  });

  it("非流式正文一直读不完，总时长到了回中文 504", async () => {
    const upstream = await startDripUpstream({ kind: "json", intervalMs: 50 });
    cleanups.push(() => upstream.close());
    const r = await rig({ upstreamBaseUrl: upstream.baseUrl, gatewayLimits: { totalTimeoutMs: 800 } });

    const started = performance.now();
    const response = await r.call("/chat/completions", authed(r.key, chatBody()));
    const elapsed = performance.now() - started;

    expect(response.status).toBe(504);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("超过 0.8 秒还没说完");
    expect(elapsed).toBeGreaterThanOrEqual(800);
    await Promise.race([upstream.disconnected, rejectAfter(2000, "超时回了 504，上游那条连接还挂着")]);
  });
});

describe("限速", () => {
  it("同一台电脑连发打满令牌桶回中文 429 带 Retry-After，不打上游，别的电脑不受影响", async () => {
    const upstream = await startUpstream({ json: { id: "chatcmpl-1", choices: [] } });
    cleanups.push(() => upstream.close());
    const r = await rig({ upstream, gatewayLimits: { burst: 3, requestsPerMinute: 1 } });

    for (let index = 0; index < 3; index += 1) {
      expect((await r.call("/chat/completions", authed(r.key, chatBody()))).status, `桶里第 ${index + 1} 次`).toBe(200);
    }
    const limited = await r.call("/chat/completions", authed(r.key, chatBody()));

    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after"), "每分钟补一次，下一次要等满一分钟").toBe("60");
    const body = (await limited.json()) as { error: string };
    expect(body.error).toContain("这台电脑请求模型太频繁");
    expect(upstream.calls, "挡下的那次不该转给上游").toHaveLength(3);

    const other = await seatComputer(r.server, r.database);
    expect((await r.call("/chat/completions", authed(other.key, chatBody()))).status, "桶按电脑分").toBe(200);
  });

  it("认证没过的请求不扣令牌", async () => {
    const upstream = await startUpstream({ json: { id: "chatcmpl-1", choices: [] } });
    cleanups.push(() => upstream.close());
    const r = await rig({ upstream, gatewayLimits: { burst: 1, requestsPerMinute: 1 } });

    expect((await r.call("/chat/completions", authed("made-up-key", chatBody()))).status).toBe(401);
    expect((await r.call("/chat/completions", authed(r.key, chatBody()))).status).toBe(200);
  });
});
