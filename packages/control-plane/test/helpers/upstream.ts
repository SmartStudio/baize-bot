import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ChatCompletionRequest, Upstream } from "./openai-sse.js";

// 假的模型供应商。网关测试只打它，不打任何付费接口。

export type UpstreamCall = {
  readonly authorization: string;
  readonly body: ChatCompletionRequest;
};

export type FakeUpstream = {
  /** 直接就是 UPSTREAM_BASE_URL 的值，网关往它后面拼 /chat/completions。 */
  readonly baseUrl: string;
  readonly calls: readonly UpstreamCall[];
  close(): Promise<void>;
};

export type UpstreamOptions = {
  readonly stream?: Upstream;
  /** 给了就走非流式，整块 JSON 返回。 */
  readonly json?: unknown;
  /** 给了就按指定类型原样返回正文。 */
  readonly raw?: { readonly body: string; readonly contentType: string };
  readonly status?: number;
};

export async function startUpstream(options: UpstreamOptions): Promise<FakeUpstream> {
  const calls: UpstreamCall[] = [];

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "POST" || !(req.url ?? "").startsWith("/v1/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    const body = JSON.parse(await readBody(req)) as ChatCompletionRequest;
    calls.push({ authorization: req.headers.authorization ?? "", body });

    if (options.raw !== undefined) {
      res.writeHead(options.status ?? 200, { "content-type": options.raw.contentType });
      res.end(options.raw.body);
      return;
    }
    if (options.json !== undefined) {
      res.writeHead(options.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(options.json));
      return;
    }
    res.writeHead(options.status ?? 200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    for await (const payload of options.stream?.(body, req.headers.authorization ?? "") ?? []) {
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
    calls,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

/** 找一个没人监听的地址，用来验证上游不可达时网关回 502。 */
export async function deadUpstreamUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  return `http://127.0.0.1:${port}/v1`;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      raw += chunk;
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}
