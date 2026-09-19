import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

export type TestMcp = {
  readonly url: string;
  authorizations(): readonly (string | null)[];
  close(): Promise<void>;
};

export async function startTestMcp(): Promise<TestMcp> {
  const authorizations: (string | null)[] = [];
  const http = createServer((req, res) => {
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    authorizations.push(req.headers.authorization ?? null);
    void (async () => {
      const mcp = new McpServer({ name: "baize-test-mcp", version: "0.1.0" });
      mcp.registerTool("send_email", { description: "对外发送邮件", inputSchema: { to: z.string() } }, async () => ({
        content: [{ type: "text", text: "sent" }],
      }));
      mcp.registerTool(
        "lookup_stock",
        { description: "查询库存", inputSchema: { sku: z.string() }, annotations: { readOnlyHint: true } },
        async () => ({ content: [{ type: "text", text: "160" }] }),
      );
      const transport = new StreamableHTTPServerTransport();
      // @ts-expect-error SDK 的 Server 与 transport 声明在 exactOptionalPropertyTypes 下不一致。
      await mcp.connect(transport);
      try {
        await transport.handleRequest(req, res);
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
    close: async () => {
      await new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
