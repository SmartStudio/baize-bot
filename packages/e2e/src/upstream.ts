import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// 假上游。做法照 spikes/pi-embed/src/openai-sse.ts：按 OpenAI 的 SSE 约定产分片。
// 端到端测试不打任何付费接口，模型那一端到此为止，再往外就是控制面的网关转发了。

export type ChatMessage = {
  readonly role: string;
  readonly content?: unknown;
  readonly tool_call_id?: string;
};

export type ChatRequest = {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
};

export type ScriptedTurn = {
  readonly textChunks: readonly string[];
  readonly toolCall?: { readonly id: string; readonly name: string; readonly args: Record<string, unknown> };
  readonly usage: { readonly input: number; readonly output: number };
};

export type FakeUpstream = {
  /** 交给控制面的 UPSTREAM_BASE_URL。 */
  readonly baseUrl: string;
  /** 到达的补全请求，按到达顺序。Pi 重试会让它多于剧本轮数。 */
  requests(): readonly ChatRequest[];
  close(): Promise<void>;
};

/** 请求里出现过工具结果，说明这是工具调用之后的那一轮。 */
export const isFollowUpTurn = (req: ChatRequest): boolean => req.messages.some((m) => m.role === "tool");

const chunk = (model: string, delta: unknown, finishReason: string | null): string =>
  JSON.stringify({
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 1758153600,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });

function* frames(req: ChatRequest, turn: ScriptedTurn): Generator<string> {
  yield chunk(req.model, { role: "assistant" }, null);
  for (const text of turn.textChunks) yield chunk(req.model, { content: text }, null);
  if (turn.toolCall === undefined) {
    yield chunk(req.model, {}, "stop");
  } else {
    const { id, name, args } = turn.toolCall;
    yield chunk(
      req.model,
      { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }] },
      null,
    );
    yield chunk(req.model, { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }, null);
    yield chunk(req.model, {}, "tool_calls");
  }
  yield JSON.stringify({
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 1758153600,
    model: req.model,
    choices: [],
    usage: {
      prompt_tokens: turn.usage.input,
      completion_tokens: turn.usage.output,
      total_tokens: turn.usage.input + turn.usage.output,
    },
  });
  yield "[DONE]";
}

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

export async function startUpstream(
  script: (req: ChatRequest) => ScriptedTurn | Promise<ScriptedTurn>,
): Promise<FakeUpstream> {
  const requests: ChatRequest[] = [];

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "POST" || !(req.url ?? "").startsWith("/v1/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    const body = JSON.parse(await readBody(req)) as ChatRequest;
    requests.push(body);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    for (const payload of frames(body, await script(body))) res.write(`data: ${payload}\n\n`);
    res.end();
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(error) } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests: () => requests,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
