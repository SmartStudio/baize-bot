import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

/** Authorization 以它开头时，tools/list 回一条 JSON-RPC 错误，错误文字是收到的 Authorization 原文和它的 base64。 */
export const ECHO_AUTHORIZATION_PREFIX = "Bearer echo-";
/** Authorization 以它开头时，tools/list 照常成功，但多出一个 echo_meta，说明里写着收到的 Authorization。 */
export const META_ECHO_AUTHORIZATION_PREFIX = "Bearer meta-echo-";

export type HeldList = {
  /** 那条请求已经到了假 MCP、正停着。 */
  readonly arrived: Promise<void>;
  release(): void;
};

export type TestMcp = {
  readonly url: string;
  initializations(): number;
  calls(): readonly { readonly name: string; readonly arguments: unknown; readonly authorization: string | null }[];
  authorizations(): readonly (string | null)[];
  activeStreams(): number;
  waitForStreams(count: number, signal?: AbortSignal): Promise<void>;
  nextStream(): Promise<void>;
  /** 下一条 tools/list 停住，等 release 才往下走。 */
  holdNextList(): HeldList;
  holdNextInitialization(): HeldList;
  holdNextCall(): HeldList;
  nextCancellation(signal?: AbortSignal): Promise<void>;
  nextCallClosed(): Promise<void>;
  streamedBytes(): number;
  completedLargeResponses(): number;
  resumptions(): readonly string[];
  failNextInitialization(): void;
  close(): Promise<void>;
};

const readBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? undefined : JSON.parse(text);
};

const isRpc = (body: unknown, method: string): body is { id: unknown; method: string } =>
  typeof body === "object" && body !== null && "method" in body && body.method === method;

const holdNext = (queue: { arrive(): void; released: Promise<void> }[]): HeldList => {
  let arrive!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>((resolve) => (arrive = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  queue.push({ arrive, released });
  return { arrived, release };
};

export async function startTestMcp(
  options: { readonly stateful?: boolean; readonly getContentType?: string } = {},
): Promise<TestMcp> {
  const authorizations: (string | null)[] = [];
  let initializations = 0;
  const calls: { name: string; arguments: unknown; authorization: string | null }[] = [];
  const held: { arrive(): void; released: Promise<void> }[] = [];
  const heldInitializations: { arrive(): void; released: Promise<void> }[] = [];
  const heldCalls: { arrive(): void; released: Promise<void> }[] = [];
  const cancellations: (() => void)[] = [];
  const callClosures: (() => void)[] = [];
  let streamedBytes = 0;
  let completedLargeResponses = 0;
  const streamArrivals: (() => void)[] = [];
  const streamWaiters: { count: number; resolve(): void }[] = [];
  let failInitialization = false;
  const sessions = new Map<string, { mcp: McpServer; transport: StreamableHTTPServerTransport }>();
  const getResponses = new Map<string, ServerResponse>();
  const resumptions: string[] = [];
  const resumableCalls = new Map<string, { id: unknown; sku: unknown }>();
  const sockets = new Set<Socket>();
  let streams = 0;
  const notifyStreams = () => {
    for (let i = streamWaiters.length - 1; i >= 0; i -= 1) {
      const waiter = streamWaiters[i];
      if (waiter?.count === streams) {
        streamWaiters.splice(i, 1);
        waiter.resolve();
      }
    }
  };
  const http = createServer((req, res) => {
    if (new URL(req.url ?? "", "http://127.0.0.1").pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    const authorization = req.headers.authorization ?? null;
    authorizations.push(authorization);
    void (async () => {
      const body = await readBody(req);
      const lastEventId = req.headers["last-event-id"];
      if (req.method === "GET" && typeof lastEventId === "string") {
        resumptions.push(lastEventId);
        const pending = resumableCalls.get(lastEventId);
        resumableCalls.delete(lastEventId);
        res.writeHead(pending?.sku === "prime-fail" ? 500 : 200, { "content-type": "text/event-stream" });
        if (pending?.sku === "prime-ok") {
          res.end(
            `data: ${JSON.stringify({ jsonrpc: "2.0", id: pending.id, result: { content: [{ type: "text", text: "resumed-ok" }] } })}\n\n`,
          );
        } else res.end();
        return;
      }
      if (isRpc(body, "notifications/cancelled")) cancellations.shift()?.();
      if (isRpc(body, "initialize")) {
        initializations += 1;
        const hold = heldInitializations.shift();
        if (hold !== undefined) {
          hold.arrive();
          await hold.released;
        }
        if (failInitialization) {
          failInitialization = false;
          res
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32603, message: authorization } }));
          return;
        }
      }
      if (isRpc(body, "tools/call") && "params" in body) {
        res.once("close", () => callClosures.shift()?.());
        const params = body.params as { name: string; arguments: unknown };
        calls.push({ ...params, authorization });
        const hold = heldCalls.shift();
        if (hold !== undefined) {
          hold.arrive();
          await hold.released;
        }
        const sku =
          typeof params.arguments === "object" && params.arguments !== null && "sku" in params.arguments
            ? params.arguments.sku
            : undefined;
        if (sku === "prime-ok" || sku === "prime-end" || sku === "prime-fail") {
          const token = randomUUID();
          resumableCalls.set(token, { id: body.id, sku });
          res.writeHead(200, { "content-type": "Text/Event-Stream; charset=utf-8" });
          res.end(`id: ${token}\nretry: 50\ndata:\n\n`);
          return;
        }
        if (typeof sku === "string" && sku.startsWith("boundary:")) {
          const [, format, total, fill] = sku.split(":");
          const sse = format === "sse";
          const prefix = `${sse ? "data: " : ""}{"jsonrpc":"2.0","id":${JSON.stringify(body.id)},"result":{"content":[{"type":"text","text":"`;
          const tail = `"}]}}${sse ? "\n\n" : ""}`;
          const length = Number(total) - Buffer.byteLength(prefix + tail);
          const text =
            fill === "utf8" ? "库".repeat(Math.floor(length / 3)) + "a".repeat(length % 3) : "a".repeat(length);
          const raw = Buffer.from(prefix + text + tail);
          res.writeHead(200, {
            "content-type": sse ? "Text/Event-Stream; charset=utf-8" : "Application/Json; charset=utf-8",
          });
          streamedBytes = 0;
          // 65537 与 UTF-8 的三字节长度互质；逐块让出事件循环，字符确实跨读取块。
          for (let offset = 0; offset < raw.length && !res.destroyed; offset += 65537) {
            const chunk = raw.subarray(offset, offset + 65537);
            streamedBytes += chunk.byteLength;
            await new Promise<void>((resolve) => res.write(chunk, () => resolve()));
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
          if (!res.destroyed) res.end();
          return;
        }
        if (sku === "get-many") {
          const target = getResponses.get(String(req.headers["mcp-session-id"]));
          if (target === undefined) throw new Error("没有 GET 流");
          res.writeHead(202).end();
          // 每条通知约 64 KiB，总计超过 20 MiB，最后的结果是读取屏障。
          const event = `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "a".repeat(65536) } })}\r\n\r\n`;
          for (let i = 0; i < 336 && !target.destroyed; i += 1) {
            await new Promise<void>((resolve) => target.write(event, () => resolve()));
          }
          if (!target.destroyed) {
            target.write(
              `data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "many-ok" }] } })}\n\n`,
            );
          }
          return;
        }
        if (sku === "sse-end" || sku === "sse-drop") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`: ${authorization}\n\n`, () => {
            if (sku === "sse-drop") res.destroy();
            else res.end();
          });
          return;
        }
        if (sku === "drop-all") {
          for (const socket of sockets) socket.destroy();
          return;
        }
        if (sku === "get-end" || sku === "get-drop") {
          const get = getResponses.get(String(req.headers["mcp-session-id"]));
          if (get === undefined) throw new Error("没有 GET 流");
          res.writeHead(202).end();
          if (sku === "get-end") get.end(`: ${authorization}\n\n`);
          else get.destroy();
          return;
        }
        if (sku === "stream-json" || sku === "stream-sse" || sku === "stream-sse-error" || sku === "stream-get") {
          const sse = sku !== "stream-json";
          const target = sku === "stream-get" ? getResponses.get(String(req.headers["mcp-session-id"])) : res;
          if (target === undefined) throw new Error("没有 GET 流");
          if (target === res) res.writeHead(200, { "content-type": sse ? "text/event-stream" : "application/json" });
          else res.writeHead(202).end();
          target.write(
            `${sse ? "data: " : ""}{"jsonrpc":"2.0","id":${JSON.stringify(body.id)},"result":{"content":[{"type":"text","text":"${authorization}`,
          );
          streamedBytes = 0;
          const chunk = "库".repeat(350_000);
          for (let i = 0; i < 100 && !target.destroyed; i += 1) {
            streamedBytes += Buffer.byteLength(chunk);
            if (!target.write(chunk)) {
              await new Promise<void>((resolve) => {
                const done = () => {
                  target.off("drain", done);
                  target.off("close", done);
                  resolve();
                };
                target.once("drain", done);
                target.once("close", done);
              });
            }
          }
          if (!target.destroyed) {
            completedLargeResponses += 1;
            const tail = `"}],"isError":${sku === "stream-sse-error"}}}${sse ? "\n\n" : ""}`;
            if (target === res) res.end(tail);
            else target.write(tail);
          }
          return;
        }
        if (
          typeof params.arguments === "object" &&
          params.arguments !== null &&
          "sku" in params.arguments &&
          params.arguments.sku === "httperror"
        ) {
          res.writeHead(500).end(`${authorization} ${Buffer.from(authorization ?? "").toString("base64")}`);
          return;
        }
        if (
          typeof params.arguments === "object" &&
          params.arguments !== null &&
          "sku" in params.arguments &&
          params.arguments.sku === "hang"
        )
          return;
        if (
          typeof params.arguments === "object" &&
          params.arguments !== null &&
          "sku" in params.arguments &&
          params.arguments.sku === "rpcerror"
        ) {
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              error: {
                code: -32603,
                message: `${authorization} ${Buffer.from(authorization ?? "").toString("base64")}`,
              },
            }),
          );
          return;
        }
      }
      if (isRpc(body, "tools/list")) {
        if (authorization?.startsWith(ECHO_AUTHORIZATION_PREFIX) === true) {
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              error: { code: -32603, message: `${authorization} ${Buffer.from(authorization).toString("base64")}` },
            }),
          );
          return;
        }
        const hold = held.shift();
        if (hold !== undefined) {
          hold.arrive();
          await hold.released;
        }
      }
      const sessionId = req.headers["mcp-session-id"];
      const session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
      if (session !== undefined) {
        if (req.method === "GET") {
          getResponses.set(String(sessionId), res);
          streams += 1;
          notifyStreams();
          streamArrivals.shift()?.();
          res.once("close", () => {
            if (getResponses.get(String(sessionId)) === res) getResponses.delete(String(sessionId));
            streams -= 1;
            notifyStreams();
          });
          if (options.getContentType !== undefined) {
            res.writeHead(200, { "content-type": options.getContentType });
            res.write(": open\n\n");
            return;
          }
        }
        await session.transport.handleRequest(req, res, body);
        return;
      }
      const mcp = new McpServer({ name: "baize-test-mcp", version: "0.1.0" });
      mcp.registerTool("send_email", { description: "对外发送邮件", inputSchema: { to: z.string() } }, async () => ({
        content: [{ type: "text", text: "sent" }],
      }));
      mcp.registerTool(
        "lookup_stock",
        { description: "查询库存", inputSchema: { sku: z.string() }, annotations: { readOnlyHint: true } },
        async ({ sku }) => {
          if (sku === "large" || sku === "large-error") {
            return {
              content: [{ type: "text", text: `${authorization}${"库".repeat(7 * 1024 * 1024)}` }],
              isError: sku === "large-error",
            };
          }
          if (sku === "echo" || sku === "error") {
            return {
              content: [{ type: "text", text: `收到 ${authorization} ${encodeURIComponent(authorization ?? "")}` }],
              isError: sku === "error",
            };
          }
          return { content: [{ type: "text", text: "160" }] };
        },
      );
      if (authorization?.startsWith(META_ECHO_AUTHORIZATION_PREFIX) === true) {
        mcp.registerTool("echo_meta", { description: `收到的是 ${authorization}`, inputSchema: {} }, async () => ({
          content: [{ type: "text", text: "ok" }],
        }));
      }
      const transport = new StreamableHTTPServerTransport(options.stateful ? { sessionIdGenerator: randomUUID } : {});
      // @ts-expect-error SDK 的 Server 与 transport 声明在 exactOptionalPropertyTypes 下不一致。
      await mcp.connect(transport);
      try {
        await transport.handleRequest(req, res, body);
      } finally {
        if (transport.sessionId === undefined) await mcp.close();
        else sessions.set(transport.sessionId, { mcp, transport });
      }
    })().catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    });
  });
  http.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", resolve);
  });
  const address = http.address();
  if (address === null || typeof address === "string") throw new Error("假 MCP 没拿到端口");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    initializations: () => initializations,
    calls: () => calls,
    authorizations: () => authorizations,
    activeStreams: () => streams,
    waitForStreams: (count, signal) => {
      if (streams === count) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const waiter = {
          count,
          resolve: () => {
            signal?.removeEventListener("abort", abort);
            resolve();
          },
        };
        const abort = () => {
          const index = streamWaiters.indexOf(waiter);
          if (index !== -1) streamWaiters.splice(index, 1);
          reject(new Error(`MCP 流数应为 ${count}，实际为 ${streams}`));
        };
        streamWaiters.push(waiter);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    },
    nextStream: () => new Promise<void>((resolve) => streamArrivals.push(resolve)),
    holdNextList: () => holdNext(held),
    holdNextInitialization: () => holdNext(heldInitializations),
    holdNextCall: () => holdNext(heldCalls),
    nextCancellation: (signal) =>
      new Promise<void>((resolve, reject) => {
        const done = () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          const index = cancellations.indexOf(done);
          if (index !== -1) cancellations.splice(index, 1);
          reject(new Error("没有收到断流调用的取消通知"));
        };
        cancellations.push(done);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      }),
    nextCallClosed: () => new Promise<void>((resolve) => callClosures.push(resolve)),
    streamedBytes: () => streamedBytes,
    completedLargeResponses: () => completedLargeResponses,
    resumptions: () => resumptions,
    failNextInitialization: () => (failInitialization = true),
    close: async () => {
      http.closeAllConnections();
      await Promise.all([...sessions.values()].map((session) => session.mcp.close()));
      await new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
