import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";

// 测试夹具。本地假 MCP，两个工具：send_email 记下收到的参数和 Authorization 头，lookup_stock 回一段固定文字，
// SKU-BAD 时回 isError。SDK 1.30 的无会话 transport 一个实例只能接一个请求，所以按 SDK 文档的无状态写法，
// 每个请求新建一对 server 和 transport，记录放在外面共享。

export interface McpCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly authorization: string | undefined;
}

export interface FakeMcp {
  readonly url: string;
  readonly calls: readonly McpCall[];
  close(): Promise<void>;
}

const header = (
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | undefined => {
  const value = headers?.[name];
  return Array.isArray(value) ? value.join(", ") : value;
};

function makeServer(calls: McpCall[]): McpServer {
  const server = new McpServer({ name: "fake-tools", version: "0.0.0" });
  server.registerTool(
    "send_email",
    { description: "给客户发一封邮件。", inputSchema: { to: z.string(), subject: z.string() } },
    async (args, extra) => {
      calls.push({ name: "send_email", args, authorization: header(extra.requestInfo?.headers, "authorization") });
      return { content: [{ type: "text", text: `已发给 ${args.to}` }] };
    },
  );
  server.registerTool(
    "lookup_stock",
    { description: "查一个 SKU 的库存。", inputSchema: { sku: z.string() } },
    async (args, extra) => {
      calls.push({ name: "lookup_stock", args, authorization: header(extra.requestInfo?.headers, "authorization") });
      if (args.sku === "SKU-BAD") return { content: [{ type: "text", text: "没有这个 SKU" }], isError: true };
      return { content: [{ type: "text", text: `${args.sku} 库存 42` }] };
    },
  );
  return server;
}

export async function startFakeMcp(): Promise<FakeMcp> {
  const calls: McpCall[] = [];

  const http: Server = createServer((req, res) => {
    const serve = async (): Promise<void> => {
      const server = makeServer(calls);
      const transport = new StreamableHTTPServerTransport({});
      res.on("close", () => void transport.close());
      // SDK 1.30 的 transport 把 sessionId 声明成 `string | undefined`，Transport 要的是可省属性，exactOptionalPropertyTypes 下要转一次。
      await server.connect(transport as unknown as Transport);
      await transport.handleRequest(req, res);
    };
    serve().catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // 运行器那头的 client 可能还没关，keep-alive 连接会让 close 等到天荒地老。
        http.close((e) => (e ? reject(e) : resolve()));
        http.closeAllConnections();
      }),
  };
}
