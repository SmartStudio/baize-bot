import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ChatCompletionRequest, Upstream } from "./openai-sse.js";

// 测试夹具。搬自 spikes/pi-embed/src/gateway.ts，去掉了转发真上游的分支：测试只跑假上游，不打付费接口。

export interface UsageRecord {
  readonly key: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface GatewayModel {
  readonly id: string;
}

export interface Gateway {
  readonly baseUrl: string;
  readonly usage: readonly UsageRecord[];
  totalsFor(key: string): { inputTokens: number; outputTokens: number };
  /** 到达网关的补全请求数，重试会让它大于会话轮数。 */
  requestCount(): number;
  close(): Promise<void>;
}

const bearer = (req: IncomingMessage): string => (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      raw += c;
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });

export async function startGateway(options: {
  upstream: Upstream;
  models: readonly GatewayModel[];
  /** 头 N 个补全请求返回错误；默认 503，可用 401 测无效密钥。 */
  failFirst?: number;
  failStatus?: 401 | 500 | 503;
  failMessage?: string;
}): Promise<Gateway> {
  const usage: UsageRecord[] = [];
  let requests = 0;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = req.url ?? "";
    if (req.method === "GET" && url.startsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: options.models.map((m) => ({ id: m.id, object: "model", owned_by: "baize" })),
        }),
      );
      return;
    }
    if (req.method !== "POST" || !url.startsWith("/v1/chat/completions")) {
      res.writeHead(404).end();
      return;
    }

    const key = bearer(req);
    const body = JSON.parse(await readBody(req)) as ChatCompletionRequest;
    requests += 1;
    if (requests <= (options.failFirst ?? 0)) {
      const status = options.failStatus ?? 503;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: options.failMessage ?? (status === 401 ? "401 Unauthorized" : "503 Service Unavailable"),
            type: status === 401 ? "authentication_error" : "server_error",
          },
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });

    for await (const payload of options.upstream(body, key)) {
      if (payload !== "[DONE]") {
        const parsed = JSON.parse(payload) as { usage?: { prompt_tokens?: number; completion_tokens?: number } };
        if (parsed.usage) {
          usage.push({
            key,
            model: body.model,
            inputTokens: parsed.usage.prompt_tokens ?? 0,
            outputTokens: parsed.usage.completion_tokens ?? 0,
          });
        }
      }
      res.write(`data: ${payload}\n\n`);
    }
    res.end();
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(error) } }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    usage,
    totalsFor: (key) =>
      usage
        .filter((u) => u.key === key)
        .reduce(
          (acc, u) => ({
            inputTokens: acc.inputTokens + u.inputTokens,
            outputTokens: acc.outputTokens + u.outputTokens,
          }),
          {
            inputTokens: 0,
            outputTokens: 0,
          },
        ),
    requestCount: () => requests,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
