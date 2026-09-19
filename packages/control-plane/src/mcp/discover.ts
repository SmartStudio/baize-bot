import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolOperation, type CreateToolRequest } from "@baize/shared";

const DISCOVERY_TIMEOUT_MS = 10_000;

const reason = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  return cause instanceof Error ? `${error.message}：${cause.message}` : error.message;
};

export async function discoverTools(input: CreateToolRequest): Promise<ToolOperation[]> {
  const client = new Client({ name: "baize-control-plane", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(input.url), {
    requestInit: input.authorization === undefined ? {} : { headers: { Authorization: input.authorization } },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("MCP 探测超过 10 秒")), DISCOVERY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      (async () => {
        // SDK 的 transport.sessionId getter 返回 string | undefined，Transport 接口在 exactOptionalPropertyTypes 下写成了 sessionId?: string。
        // @ts-expect-error SDK 两份声明不一致；运行时由同一 SDK 的 Client 和 transport 配对。
        await client.connect(transport);
        const operations: ToolOperation[] = [];
        let cursor: string | undefined;
        do {
          const result = await client.listTools(cursor === undefined ? undefined : { cursor });
          operations.push(
            ...result.tools.map((tool) =>
              ToolOperation.parse({
                name: tool.name,
                description: tool.description ?? "",
                inputSchema: tool.inputSchema,
                needsApproval: tool.annotations?.readOnlyHint !== true,
              }),
            ),
          );
          cursor = result.nextCursor;
        } while (cursor !== undefined);
        return operations;
      })(),
      timeout,
    ]);
  } catch (error) {
    throw new Error(`连不上 MCP：${reason(error)}`, { cause: error });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await client.close().catch(() => undefined);
  }
}
