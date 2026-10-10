import { createServer, type IncomingMessage } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

/** Authorization 以它开头时，tools/list 回一条 JSON-RPC 错误，错误文字是收到的 Authorization 原文和它的 base64。 */
export const ECHO_AUTHORIZATION_PREFIX = "Bearer echo-";
/** Authorization 以它开头时，tools/list 照常成功，但多出一个 echo_meta，说明里写着收到的 Authorization。 */
export const META_ECHO_AUTHORIZATION_PREFIX = "Bearer meta-echo-";

export type HeldList = {
  /** 那条 tools/list 已经到了假 MCP、正停着。 */
  readonly arrived: Promise<void>;
  release(): void;
};

export type TestMcp = {
  readonly url: string;
  authorizations(): readonly (string | null)[];
  /** 下一条 tools/list 停住，等 release 才往下走。 */
  holdNextList(): HeldList;
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

export async function startTestMcp(): Promise<TestMcp> {
  const authorizations: (string | null)[] = [];
  const held: { arrive(): void; released: Promise<void> }[] = [];
  const http = createServer((req, res) => {
    if (new URL(req.url ?? "", "http://127.0.0.1").pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    const authorization = req.headers.authorization ?? null;
    authorizations.push(authorization);
    void (async () => {
      const body = await readBody(req);
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
      const mcp = new McpServer({ name: "baize-test-mcp", version: "0.1.0" });
      mcp.registerTool("send_email", { description: "对外发送邮件", inputSchema: { to: z.string() } }, async () => ({
        content: [{ type: "text", text: "sent" }],
      }));
      mcp.registerTool(
        "lookup_stock",
        { description: "查询库存", inputSchema: { sku: z.string() }, annotations: { readOnlyHint: true } },
        async () => ({ content: [{ type: "text", text: "160" }] }),
      );
      if (authorization?.startsWith(META_ECHO_AUTHORIZATION_PREFIX) === true) {
        mcp.registerTool("echo_meta", { description: `收到的是 ${authorization}`, inputSchema: {} }, async () => ({
          content: [{ type: "text", text: "ok" }],
        }));
      }
      const transport = new StreamableHTTPServerTransport();
      // @ts-expect-error SDK 的 Server 与 transport 声明在 exactOptionalPropertyTypes 下不一致。
      await mcp.connect(transport);
      try {
        await transport.handleRequest(req, res, body);
      } finally {
        await mcp.close();
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
    authorizations: () => authorizations,
    holdNextList: () => {
      const hold: { arrive(): void; release(): void } = { arrive: () => undefined, release: () => undefined };
      const arrived = new Promise<void>((resolve) => (hold.arrive = resolve));
      const released = new Promise<void>((resolve) => (hold.release = resolve));
      held.push({ arrive: () => hold.arrive(), released });
      return { arrived, release: () => hold.release() };
    },
    close: async () => {
      await new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
