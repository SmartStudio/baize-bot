import { Hono } from "hono";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { findComputerByGatewayKey } from "../repo/computers.js";

export const GATEWAY_PATH = "/gateway/v1";

export type GatewayDeps = {
  readonly db: Db;
  readonly model: string;
  readonly upstreamBaseUrl: string;
  readonly upstreamApiKey: string;
};

// 白名单而不是黑名单：上游的组织标识、Set-Cookie 这类头不该漏给云电脑，
// 而黑名单挡不住上游以后新加的头。压缩、长度、分块也顺带落在名单外，那几项由我们这边重新定。
const FORWARDED_HEADERS = new Set(["content-type", "cache-control"]);
const FORWARDED_HEADER_PREFIXES = ["x-ratelimit-"];

function isForwarded(name: string): boolean {
  return FORWARDED_HEADERS.has(name) || FORWARDED_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix));
}

const CompletionRequest = z.object({}).passthrough();

/**
 * 模型网关。云电脑只能出站到控制面，模型调用都从这里转出去。
 * 用量以电脑报上来的 run_done 为准，网关自己不记账。
 */
export function createGateway(deps: GatewayDeps): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    const key = bearerToken(c.req.header("authorization"));
    const computer = key === null ? null : await findComputerByGatewayKey(deps.db, key);
    if (computer === null) return c.json({ error: "网关 key 不对，换一把再来" }, 401);
    await next();
  });

  app.get("/models", (c) => c.json({ object: "list", data: [{ id: deps.model, object: "model", owned_by: "baize" }] }));

  app.post("/chat/completions", async (c) => {
    const parsed = CompletionRequest.safeParse(await readJson(c.req.raw));
    if (!parsed.success) return c.json({ error: "请求体不是一个 JSON 对象" }, 400);

    let upstream: Response;
    try {
      upstream = await fetch(`${deps.upstreamBaseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${deps.upstreamApiKey}` },
        // 选哪个模型由网关说了算，电脑代理报上来的 model 一律换掉。
        body: JSON.stringify({ ...parsed.data, model: deps.model }),
        // 电脑那头断了就把上游一起断掉，别让上游替一个已经没人要的请求接着烧 token。
        signal: c.req.raw.signal,
      });
    } catch (error) {
      // 客户端自己走的，这不是上游连不上；再回一个 502 是对着空气说话，还会把断线记成上游故障。
      if (c.req.raw.signal.aborted) throw error;
      return c.json({ error: `连不上模型上游，${String(error)}。稍后再试或者找管理员看看上游地址。` }, 502);
    }

    const headers = new Headers();
    for (const [name, value] of upstream.headers) {
      if (isForwarded(name.toLowerCase())) headers.set(name, value);
    }
    // 流式和非流式都原样转回去，SSE 分片不在这里攒。
    return new Response(upstream.body, { status: upstream.status, headers });
  });

  return app;
}

function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
