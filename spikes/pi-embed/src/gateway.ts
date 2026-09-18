import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ChatCompletionRequest, Upstream } from "./openai-sse.js";

// 模型网关。对 Pi 露出 OpenAI 兼容的 /v1/chat/completions，用 Authorization 里的 key 区分会话，
// 边转发边从流里读 usage，记进内存日志。

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

/** 真上游。只有环境变量给了 key 才会走到这里，本次验证没有跑过。 */
function realUpstream(apiKey: string, baseUrl: string): Upstream {
  return async function* (req) {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ ...req, stream: true, stream_options: { include_usage: true } }),
    });
    if (!res.body) throw new Error(`upstream ${res.status} 没有响应体`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data: ")) yield line.slice(6).trim();
      }
    }
  };
}

export function resolveUpstream(fake: Upstream, env: NodeJS.ProcessEnv = process.env): Upstream {
  if (env.OPENAI_API_KEY) return realUpstream(env.OPENAI_API_KEY, "https://api.openai.com/v1");
  if (env.ANTHROPIC_API_KEY) return realUpstream(env.ANTHROPIC_API_KEY, "https://api.anthropic.com/v1");
  return fake;
}

export async function startGateway(options: { upstream: Upstream; models: readonly GatewayModel[] }): Promise<Gateway> {
  const usage: UsageRecord[] = [];

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
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
