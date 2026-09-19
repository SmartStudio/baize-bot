import { createServer, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export type McpCall = {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly authorization: string | undefined;
};

export type TestMcp = {
  readonly baseUrl: string;
  calls(): readonly McpCall[];
  close(): Promise<void>;
};

const authorizationOf = (headers: Record<string, string | string[] | undefined> | undefined): string | undefined => {
  const value = headers?.authorization;
  return Array.isArray(value) ? value.join(", ") : value;
};

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string") throw new Error(`参数 ${name} 必须是字符串`);
  return value;
}

function makeServer(calls: McpCall[], authorization: string | undefined): McpServer {
  const server = new McpServer({ name: "baize-e2e-mcp", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "send_email",
        description: "发送邮件",
        inputSchema: {
          type: "object",
          properties: {
            to: { type: "string" },
            subject: { type: "string" },
            body: { type: "string" },
          },
          required: ["to", "subject", "body"],
          additionalProperties: false,
        },
      },
      {
        name: "lookup_stock",
        description: "查询库存",
        inputSchema: {
          type: "object",
          properties: { sku: { type: "string" } },
          required: ["sku"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
      },
    ],
  }));
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments ?? {};
    if (request.params.name === "send_email") {
      const to = stringArg(args, "to");
      stringArg(args, "subject");
      stringArg(args, "body");
      calls.push({ name: "send_email", args, authorization });
      return { content: [{ type: "text", text: `已发给 ${to}` }] };
    }
    if (request.params.name === "lookup_stock") {
      stringArg(args, "sku");
      calls.push({ name: "lookup_stock", args, authorization });
      return { content: [{ type: "text", text: "X3 库存 120" }] };
    }
    throw new Error(`未知工具 ${request.params.name}`);
  });
  return server;
}

export async function startTestMcp(): Promise<TestMcp> {
  const calls: McpCall[] = [];
  const http: Server = createServer((req, res) => {
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }

    const serve = async (): Promise<void> => {
      const server = makeServer(calls, authorizationOf(req.headers));
      const transport = new StreamableHTTPServerTransport({});
      res.on("close", () => void transport.close());
      // SDK 1.30 的 transport 把 sessionId 声明成 string | undefined，Transport 要的是可省属性。
      // @ts-expect-error SDK 的 Server 与 transport 声明在 exactOptionalPropertyTypes 下不一致。
      await server.connect(transport);
      try {
        await transport.handleRequest(req, res);
      } finally {
        await server.close();
      }
    };
    serve().catch((error: unknown) => {
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
    baseUrl: `http://127.0.0.1:${address.port}/mcp`,
    calls: () => calls,
    close: () =>
      new Promise<void>((resolve, reject) => {
        http.close((error) => (error ? reject(error) : resolve()));
        http.closeAllConnections();
      }),
  };
}
