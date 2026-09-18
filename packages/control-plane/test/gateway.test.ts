import type { ComputerId } from "@baize/shared";
import { afterEach, describe, expect, it } from "vitest";
import { GATEWAY_PATH } from "../src/http/gateway.js";
import { startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { makeComputer, makeUser } from "./helpers/fixtures.js";
import { helloAgent } from "./helpers/agent.js";
import { scriptedUpstream, type Upstream } from "./helpers/openai-sse.js";
import { deadUpstreamUrl, startUpstream, type FakeUpstream } from "./helpers/upstream.js";

const GATEWAY_MODEL = "baize-test-model";
const UPSTREAM_API_KEY = "sk-fake-upstream";

type Rig = {
  readonly server: TestServer;
  readonly database: TestDb;
  readonly upstream: FakeUpstream | null;
  readonly computerId: ComputerId;
  readonly token: string;
  /** 电脑握手时下发给它的网关 key 明文。 */
  readonly key: string;
  call(path: string, init?: RequestInit): Promise<Response>;
};

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function rig(options: { upstream?: FakeUpstream; upstreamBaseUrl?: string } = {}): Promise<Rig> {
  const database = await createTestDb();
  cleanups.push(() => database.close());

  const server = await startTestServer(database.db, {
    gatewayModel: GATEWAY_MODEL,
    upstreamApiKey: UPSTREAM_API_KEY,
    upstreamBaseUrl: options.upstream?.baseUrl ?? options.upstreamBaseUrl ?? "http://127.0.0.1:1/v1",
  });
  cleanups.push(() => server.close());

  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const { agent, config } = await helloAgent(server.server.port, computer.computerId, computer.token);
  cleanups.push(async () => agent.close());

  return {
    server,
    database,
    upstream: options.upstream ?? null,
    computerId: computer.computerId,
    token: computer.token,
    key: config.modelGateway.apiKey,
    call: (path, init) => fetch(`http://localhost:${server.server.port}${GATEWAY_PATH}${path}`, init),
  };
}

function chatBody(extra: Record<string, unknown> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "电脑自己挑的模型", messages: [{ role: "user", content: "在吗" }], ...extra }),
  };
}

function authed(key: string, init: RequestInit): RequestInit {
  return { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${key}` } };
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

    expect((await r.call("/models", authed(r.key, {}))).status, "上一条连接那把 key 该作废了").toBe(401);
    expect((await r.call("/models", authed(again.config.modelGateway.apiKey, {}))).status).toBe(200);
  });

  it("GET /models 返回网关自己那一个模型", async () => {
    const r = await rig();
    const response = await r.call("/models", authed(r.key, {}));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      object: "list",
      data: [{ id: GATEWAY_MODEL, object: "model", owned_by: "baize" }],
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

  it("上游返回的错误状态照原样带回来", async () => {
    const upstream = await startUpstream({ status: 429, json: { error: { message: "rate limited" } } });
    cleanups.push(() => upstream.close());
    const r = await rig({ upstream });

    const response = await r.call("/chat/completions", authed(r.key, chatBody()));
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: { message: "rate limited" } });
  });

  it("上游连不上返回 502 并说人话", async () => {
    const r = await rig({ upstreamBaseUrl: await deadUpstreamUrl() });

    const response = await r.call("/chat/completions", authed(r.key, chatBody()));

    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("连不上模型上游");
    expect(body.error).toContain("找管理员");
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
