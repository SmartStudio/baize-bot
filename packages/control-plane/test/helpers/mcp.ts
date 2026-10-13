import { createServer, type IncomingMessage } from "node:http";
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
  waitForStreams(count: number): Promise<void>;
  nextStream(): Promise<void>;
  /** 下一条 tools/list 停住，等 release 才往下走。 */
  holdNextList(): HeldList;
  holdNextInitialization(): HeldList;
  holdNextCall(): HeldList;
  nextCancellation(): Promise<void>;
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

export async function startTestMcp(options: { readonly stateful?: boolean } = {}): Promise<TestMcp> {
  const authorizations: (string | null)[] = [];
  let initializations = 0;
  const calls: { name: string; arguments: unknown; authorization: string | null }[] = [];
  const held: { arrive(): void; released: Promise<void> }[] = [];
  const heldInitializations: { arrive(): void; released: Promise<void> }[] = [];
  const heldCalls: { arrive(): void; released: Promise<void> }[] = [];
  const cancellations: (() => void)[] = [];
  const streamArrivals: (() => void)[] = [];
  const streamWaiters: { count: number; resolve(): void }[] = [];
  let failInitialization = false;
  const sessions = new Map<string, { mcp: McpServer; transport: StreamableHTTPServerTransport }>();
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
        const params = body.params as { name: string; arguments: unknown };
        calls.push({ ...params, authorization });
        const hold = heldCalls.shift();
        if (hold !== undefined) {
          hold.arrive();
          await hold.released;
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
          streams += 1;
          notifyStreams();
          streamArrivals.shift()?.();
          res.once("close", () => {
            streams -= 1;
            notifyStreams();
          });
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
    waitForStreams: (count) =>
      streams === count ? Promise.resolve() : new Promise<void>((resolve) => streamWaiters.push({ count, resolve })),
    nextStream: () => new Promise<void>((resolve) => streamArrivals.push(resolve)),
    holdNextList: () => holdNext(held),
    holdNextInitialization: () => holdNext(heldInitializations),
    holdNextCall: () => holdNext(heldCalls),
    nextCancellation: () => new Promise<void>((resolve) => cancellations.push(resolve)),
    failNextInitialization: () => (failInitialization = true),
    close: async () => {
      await Promise.all([...sessions.values()].map((session) => session.mcp.close()));
      await new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
