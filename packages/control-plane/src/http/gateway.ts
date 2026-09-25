import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Db } from "../db/client.js";
import type { GatewayModels } from "../env.js";
import { findComputerByGatewayKey } from "../repo/computers.js";

export const GATEWAY_PATH = "/gateway/v1";
const MAX_REQUEST_BODY_BYTES = 20 * 1024 * 1024;
const PLAN_MODEL_ID = "baize:plan";
const FAST_MODEL_ID = "baize:fast";
const INVALID_MODEL_ERROR = "model 只能是 baize:plan 或 baize:fast";
type GatewayModelId = typeof PLAN_MODEL_ID | typeof FAST_MODEL_ID;

export type GatewayDeps = {
  readonly db: Db;
  readonly models: GatewayModels;
  readonly upstreamBaseUrl: string;
  readonly upstreamApiKey: string;
};

// 白名单而不是黑名单：上游的组织标识、Set-Cookie 这类头不该漏给电脑，
// 而黑名单挡不住上游以后新加的头。压缩、长度、分块也顺带落在名单外，那几项由我们这边重新定。
const FORWARDED_HEADERS = new Set(["content-type", "cache-control"]);
const FORWARDED_HEADER_PREFIXES = ["x-ratelimit-"];

function isForwarded(name: string): boolean {
  return FORWARDED_HEADERS.has(name) || FORWARDED_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix));
}

const CompletionRequest = z.object({}).passthrough();

/**
 * 模型网关。上游密钥不下发到电脑，模型调用都从这里转出去。
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

  app.get("/models", (c) =>
    c.json({
      object: "list",
      data: [
        { id: PLAN_MODEL_ID, object: "model", owned_by: "baize" },
        { id: FAST_MODEL_ID, object: "model", owned_by: "baize" },
      ],
    }),
  );

  app.post(
    "/chat/completions",
    bodyLimit({
      maxSize: MAX_REQUEST_BODY_BYTES,
      onError: (c) => c.json({ error: "请求体超过 20 MiB 上限" }, 413),
    }),
    async (c) => {
      const parsed = CompletionRequest.safeParse(await readJson(c.req.raw));
      if (!parsed.success) return c.json({ error: "请求体不是一个 JSON 对象" }, 400);

      const requestedModel = parsed.data["model"];
      if (requestedModel !== PLAN_MODEL_ID && requestedModel !== FAST_MODEL_ID) {
        return c.json({ error: INVALID_MODEL_ERROR }, 400);
      }
      const modelAlias: GatewayModelId = requestedModel;
      const upstreamModel = modelAlias === PLAN_MODEL_ID ? deps.models.plan : deps.models.fast;

      let upstream: Response;
      try {
        upstream = await fetch(`${deps.upstreamBaseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${deps.upstreamApiKey}` },
          // 选哪个模型由网关说了算，电脑代理报上来的 model 一律换掉。
          body: JSON.stringify({ ...parsed.data, model: upstreamModel }),
          // 电脑那头断了就把上游一起断掉，别让上游替一个已经没人要的请求接着烧 token。
          signal: c.req.raw.signal,
        });
      } catch (error) {
        // 客户端自己走的，这不是上游连不上；再回一个 502 是对着空气说话，还会把断线记成上游故障。
        if (c.req.raw.signal.aborted) throw error;
        return c.json({ error: `连不上模型上游，${String(error)}。稍后再试或者找管理员看看上游地址。` }, 502);
      }

      if (!upstream.ok) {
        const errorBody = await upstream.text();
        console.error(`模型上游返回 ${upstream.status}，正文前 200 字：${errorBody.slice(0, 200)}`);
        return new Response(JSON.stringify({ error: `模型上游返回 ${upstream.status}，请稍后再试或检查上游配置。` }), {
          status: upstream.status,
          headers: { "content-type": "application/json; charset=UTF-8" },
        });
      }

      const headers = new Headers();
      for (const [name, value] of upstream.headers) {
        if (isForwarded(name.toLowerCase())) headers.set(name, value);
      }
      const contentType = upstream.headers.get("content-type")?.toLowerCase() ?? "";
      if (contentType.includes("text/event-stream") && upstream.body !== null) {
        return new Response(rewriteSseBody(upstream.body, modelAlias), { status: upstream.status, headers });
      }
      if (contentType.includes("application/json")) {
        const body = await upstream.text();
        const rewritten = replaceTopLevelModel(body, modelAlias) ?? body;
        return new Response(rewritten, { status: upstream.status, headers });
      }
      return new Response(upstream.body, { status: upstream.status, headers });
    },
  );

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

function rewriteSseBody(body: ReadableStream<Uint8Array>, modelAlias: GatewayModelId): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered: Uint8Array = new Uint8Array(0);

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffered = joinBytes(buffered, chunk);
        let lineStart = 0;
        for (let index = 0; index < buffered.length; index += 1) {
          if (buffered[index] !== 0x0a) continue;
          controller.enqueue(rewriteSseLine(buffered.slice(lineStart, index + 1), decoder, encoder, modelAlias));
          lineStart = index + 1;
        }
        buffered = buffered.slice(lineStart);
      },
      flush(controller) {
        if (buffered.length > 0) controller.enqueue(rewriteSseLine(buffered, decoder, encoder, modelAlias));
      },
    }),
  );
}

function rewriteSseLine(
  line: Uint8Array,
  decoder: TextDecoder,
  encoder: TextEncoder,
  modelAlias: GatewayModelId,
): Uint8Array {
  const lineEnd = line.at(-1) === 0x0a ? line.length - 1 : line.length;
  const contentEnd = line[lineEnd - 1] === 0x0d ? lineEnd - 1 : lineEnd;
  const text = decoder.decode(line.slice(0, contentEnd));
  if (!text.startsWith("data:")) return line;

  const valueStart = text.startsWith("data: ") ? 6 : 5;
  const rewritten = replaceTopLevelModel(text.slice(valueStart), modelAlias);
  if (rewritten === null) return line;
  return joinBytes(joinBytes(line.slice(0, valueStart), encoder.encode(rewritten)), line.slice(contentEnd));
}

function replaceTopLevelModel(json: string, modelAlias: GatewayModelId): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const objectStart = json.search(/\S/);
  if (objectStart < 0 || json[objectStart] !== "{") return null;

  let depth = 1;
  for (let index = objectStart + 1; index < json.length; index += 1) {
    const character = json[index];
    if (character === '"') {
      const stringEnd = skipJsonString(json, index);
      if (stringEnd === null) return null;
      if (depth === 1) {
        const key = JSON.parse(json.slice(index, stringEnd)) as unknown;
        const colon = skipJsonWhitespace(json, stringEnd);
        if (key === "model" && colon < json.length && json[colon] === ":") {
          const value = skipJsonWhitespace(json, colon + 1);
          if (value >= json.length || json[value] !== '"') return null;
          const valueEnd = skipJsonString(json, value);
          if (valueEnd === null) return null;
          return `${json.slice(0, value)}${JSON.stringify(modelAlias)}${json.slice(valueEnd)}`;
        }
      }
      index = stringEnd - 1;
      continue;
    }
    if (character === "{" || character === "[") depth += 1;
    if (character === "}" || character === "]") depth -= 1;
    if (depth === 0) break;
  }
  return null;
}

function skipJsonString(json: string, start: number): number | null {
  for (let index = start + 1; index < json.length; index += 1) {
    if (json[index] === "\\") {
      index += 1;
      continue;
    }
    if (json[index] === '"') return index + 1;
  }
  return null;
}

function skipJsonWhitespace(json: string, start: number): number {
  let index = start;
  while (index < json.length && /\s/.test(json[index] ?? "")) index += 1;
  return index;
}

function joinBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left);
  joined.set(right, left.length);
  return joined;
}
