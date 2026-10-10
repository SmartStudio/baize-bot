import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";

// 测试夹具。本地假 MCP，四个工具：send_email 记下收到的参数和 Authorization 头，lookup_stock 回一段固定文字，
// SKU-BAD 时回 isError，render_chart 回一段文字加一张图（字节是 MCP_CHART_BYTES，不是真 PNG），
// render_image 按参数回任意格式和大小的图，wait_forever 挂到客户端取消为止，
// echo_secret 回 isError、错误文字里带着收到的 Authorization。SDK 1.30 的无会话 transport 一个实例只能接一个请求，所以按 SDK 文档的无状态写法，
// 每个请求新建一对 server 和 transport，记录放在外面共享。

export const MCP_CHART_BYTES = Buffer.from("mcp-chart-p1-5");

export interface McpCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly authorization: string | undefined;
}

export interface FakeMcp {
  readonly url: string;
  readonly calls: readonly McpCall[];
  /** 客户端发过几次 `notifications/initialized`，一次完整 connect 记一次。 */
  readonly connections: number;
  close(): Promise<void>;
}

const header = (
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | undefined => {
  const value = headers?.[name];
  return Array.isArray(value) ? value.join(", ") : value;
};

function makeServer(calls: McpCall[], onInitialized: () => void): McpServer {
  const server = new McpServer({ name: "fake-tools", version: "0.0.0" });
  server.server.oninitialized = onInitialized;
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
  server.registerTool(
    "echo_secret",
    { description: "报错，错误文字里原样带上收到的 Authorization。", inputSchema: {} },
    async (_args, extra) => {
      const authorization = header(extra.requestInfo?.headers, "authorization");
      calls.push({ name: "echo_secret", args: {}, authorization });
      return { content: [{ type: "text", text: `拒绝：你发来的是 ${authorization ?? "（没有）"}` }], isError: true };
    },
  );
  server.registerTool(
    "render_chart",
    { description: "把库存画成图。", inputSchema: { sku: z.string() } },
    async (args) => ({
      content: [
        { type: "text", text: `${args.sku} 的库存图` },
        { type: "image", data: MCP_CHART_BYTES.toString("base64"), mimeType: "image/png" },
      ],
    }),
  );
  server.registerTool(
    "wait_forever",
    { description: "一直不回，直到客户端取消这次调用。", inputSchema: {} },
    async (_args, extra) => {
      calls.push({
        name: "wait_forever",
        args: {},
        authorization: header(extra.requestInfo?.headers, "authorization"),
      });
      await new Promise<void>((resolve) => extra.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { content: [{ type: "text", text: "被取消了" }] };
    },
  );
  server.registerTool(
    "render_image",
    { description: "按给定的格式和字节数回一张图。", inputSchema: { mimeType: z.string(), bytes: z.number() } },
    async (args) => ({
      content: [
        { type: "text", text: `${args.mimeType} 的图` },
        { type: "image", data: Buffer.alloc(args.bytes, "a").toString("base64"), mimeType: args.mimeType },
      ],
    }),
  );
  return server;
}

export async function startFakeMcp(): Promise<FakeMcp> {
  const calls: McpCall[] = [];
  let connections = 0;

  const http: Server = createServer((req, res) => {
    const serve = async (): Promise<void> => {
      const server = makeServer(calls, () => {
        connections += 1;
      });
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
    get connections() {
      return connections;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        // 运行器那头的 client 可能还没关，keep-alive 连接会让 close 等到天荒地老。
        http.close((e) => (e ? reject(e) : resolve()));
        http.closeAllConnections();
      }),
  };
}
