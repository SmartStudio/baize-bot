import {
  ModelPurpose,
  gatewayAlias,
  type BotId,
  type ComputerId,
  type GatewayModels,
  type GroupId,
} from "@baize/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { findComputerByGatewayKey } from "../repo/computers.js";
import { retryAfterSeconds } from "./auth-limits.js";
import { GATEWAY_TIMEOUT_MARK, RequestBuckets, type GatewayLimits } from "./gateway-limits.js";
import { LANE_FENCE_ERRORS, validateLaneFence } from "./lane-fence.js";
import { log } from "../log.js";
import type { StatusCounts } from "./ops-metrics.js";

export const GATEWAY_PATH = "/gateway/v1";
const MAX_REQUEST_BODY_BYTES = 20 * 1024 * 1024;
const PURPOSE_BY_ALIAS = new Map<string, ModelPurpose>(
  ModelPurpose.options.map((purpose) => [gatewayAlias(purpose), purpose]),
);
const INVALID_MODEL_ERROR = `model 只能是 ${[...PURPOSE_BY_ALIAS.keys()].join(" 或 ")}`;
type GatewayModelId = ReturnType<typeof gatewayAlias>;

export type GatewayDeps = {
  readonly db: Db;
  readonly models: GatewayModels;
  readonly upstreamBaseUrl: string;
  readonly upstreamApiKey: string;
  readonly limits: GatewayLimits;
  readonly responses: StatusCounts;
};

type GatewayEnv = { Variables: { computerId: ComputerId; lane: { botId: BotId; groupId: GroupId } } };

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
export function createGateway(deps: GatewayDeps): Hono<GatewayEnv> {
  const app = new Hono<GatewayEnv>();
  const buckets = new RequestBuckets(deps.limits);

  app.use("/chat/completions", async (c, next) => {
    await next();
    deps.responses.add(c.res.status);
  });

  app.use("*", async (c, next) => {
    const key = bearerToken(c.req.header("authorization"));
    const computer = key === null ? null : await findComputerByGatewayKey(deps.db, key);
    if (computer === null) return c.json({ error: "网关 key 不对，换一把再来" }, 401);
    const fence = await validateLaneFence(deps.db, computer, c.req.header("x-baize-lane"));
    if (fence.kind !== "ok") return c.json({ error: LANE_FENCE_ERRORS[fence.kind] }, 409);
    c.set("computerId", computer.id);
    c.set("lane", fence.lane);
    await next();
  });

  app.get("/models", (c) =>
    c.json({
      object: "list",
      data: ModelPurpose.options.map((purpose) => ({ id: gatewayAlias(purpose), object: "model", owned_by: "baize" })),
    }),
  );

  app.post(
    "/chat/completions",
    async (c, next) => {
      const waitMs = buckets.take(c.get("computerId"));
      if (waitMs === null) return next();
      c.header("Retry-After", String(retryAfterSeconds(waitMs)));
      return c.json({ error: "这台电脑请求模型太频繁，网关先挡一下，稍后再试" }, 429);
    },
    bodyLimit({
      maxSize: MAX_REQUEST_BODY_BYTES,
      onError: (c) => c.json({ error: "请求体超过 20 MiB 上限" }, 413),
    }),
    async (c) => {
      const parsed = CompletionRequest.safeParse(await readJson(c.req.raw));
      if (!parsed.success) return c.json({ error: "请求体不是一个 JSON 对象" }, 400);

      const requestedModel = parsed.data["model"];
      const purpose = typeof requestedModel === "string" ? PURPOSE_BY_ALIAS.get(requestedModel) : undefined;
      if (purpose === undefined) return c.json({ error: INVALID_MODEL_ERROR }, 400);
      const modelAlias = gatewayAlias(purpose);
      const upstreamModel = deps.models[purpose];

      const client = c.req.raw.signal;
      const deadline = new Deadline(deps.limits, client);
      const timedOut = (error: unknown): Response => {
        deadline.clear();
        if (client.aborted) throw error;
        const overrun = deadline.overrun();
        if (overrun === null) throw error;
        return c.json({ error: overrunMessage(overrun, deps.limits) }, 504);
      };

      let upstream: Response;
      try {
        upstream = await fetch(`${deps.upstreamBaseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${deps.upstreamApiKey}` },
          // 选哪个模型由网关说了算，电脑代理报上来的 model 一律换掉。
          body: JSON.stringify({ ...parsed.data, model: upstreamModel }),
          signal: deadline.signal,
        });
      } catch (error) {
        if (client.aborted || deadline.overrun() !== null) return timedOut(error);
        deadline.clear();
        return c.json({ error: `连不上模型上游，${String(error)}。稍后再试或者找管理员看看上游地址。` }, 502);
      }
      deadline.responded();

      if (!upstream.ok) {
        let errorBody: string;
        try {
          errorBody = await upstream.text();
        } catch (error) {
          return timedOut(error);
        }
        deadline.clear();
        log.error("模型上游返回错误", {
          computerId: c.get("computerId"),
          botId: c.get("lane").botId,
          groupId: c.get("lane").groupId,
          status: upstream.status,
          body: errorBody.slice(0, 200),
        });
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
        const body = untilDeadline(rewriteSseBody(upstream.body, modelAlias), deadline, (overrun) =>
          sseError(overrunMessage(overrun, deps.limits)),
        );
        return new Response(body, { status: upstream.status, headers });
      }
      if (contentType.includes("application/json")) {
        let body: string;
        try {
          body = await upstream.text();
        } catch (error) {
          return timedOut(error);
        }
        deadline.clear();
        const rewritten = replaceTopLevelModel(body, modelAlias) ?? body;
        return new Response(rewritten, { status: upstream.status, headers });
      }
      const body = upstream.body === null ? null : untilDeadline(upstream.body, deadline, null);
      if (body === null) deadline.clear();
      return new Response(body, { status: upstream.status, headers });
    },
  );

  return app;
}

type Overrun = "first_byte" | "total";

class Deadline {
  readonly #timeout = new AbortController();
  readonly #firstByte: ReturnType<typeof setTimeout>;
  readonly #total: ReturnType<typeof setTimeout>;
  readonly signal: AbortSignal;

  constructor(limits: GatewayLimits, client: AbortSignal) {
    this.#firstByte = setTimeout(() => this.#timeout.abort("first_byte"), limits.firstByteTimeoutMs);
    this.#total = setTimeout(() => this.#timeout.abort("total"), limits.totalTimeoutMs);
    this.signal = AbortSignal.any([client, this.#timeout.signal]);
  }

  responded(): void {
    clearTimeout(this.#firstByte);
  }

  clear(): void {
    clearTimeout(this.#firstByte);
    clearTimeout(this.#total);
  }

  overrun(): Overrun | null {
    return this.#timeout.signal.aborted ? (this.#timeout.signal.reason as Overrun) : null;
  }
}

function overrunMessage(overrun: Overrun, limits: GatewayLimits): string {
  return overrun === "first_byte"
    ? `模型上游 ${seconds(limits.firstByteTimeoutMs)} 秒还没开始回话，${GATEWAY_TIMEOUT_MARK}。稍后再试，一直这样就找管理员看看上游。`
    : `模型上游这次回话超过 ${seconds(limits.totalTimeoutMs)} 秒还没说完，${GATEWAY_TIMEOUT_MARK}。稍后再试，或者把要做的事拆小一点。`;
}

const seconds = (ms: number): string => String(Math.round(ms / 100) / 10);

/** 形状照 OpenAI 流里的 error 事件，SDK 读到它就当这次请求出错，把 message 原样交给调用方。 */
function sseError(message: string): Uint8Array {
  // 打头的空行收掉上游可能只转了一半的那个事件，免得错误这行被并进去。
  return new TextEncoder().encode(`\ndata: ${JSON.stringify({ error: { message, type: "timeout" } })}\n\n`);
}

/**
 * 正文转给电脑期间总时长到了，响应头早已发出去，没法再改成 504：流式的在末尾补一个 error 事件好好收尾，
 * 认不出格式的只能把连接掐断。
 */
function untilDeadline(
  body: ReadableStream<Uint8Array>,
  deadline: Deadline,
  tail: ((overrun: Overrun) => Uint8Array) | null,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        deadline.clear();
        const overrun = deadline.overrun();
        if (overrun === null || tail === null) throw error;
        controller.enqueue(tail(overrun));
        controller.close();
        return;
      }
      if (chunk.done) {
        deadline.clear();
        controller.close();
        return;
      }
      controller.enqueue(chunk.value);
    },
    async cancel(reason) {
      deadline.clear();
      await reader.cancel(reason);
    },
  });
}

export function bearerToken(header: string | undefined): string | null {
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
