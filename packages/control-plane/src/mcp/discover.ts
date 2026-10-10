import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolOperation, describeMcpFailure, mentionsCredential, type CreateToolRequest } from "@baize/shared";

const DISCOVERY_TIMEOUT_MS = 10_000;

/** 探测失败，message 是给前端看的固定说法，不带对端写的文字。 */
export class DiscoveryError extends Error {}

/** 对端把凭据写进了操作的名字、说明或参数表。这些会落库、进回包、进分享包、进模型的工具定义，整份不收。 */
const echoesCredential = (operations: readonly ToolOperation[], authorization: string | null): boolean =>
  operations.some((operation) => mentionsCredential(JSON.stringify(operation), authorization));

export async function discoverTools(input: CreateToolRequest): Promise<ToolOperation[]> {
  const authorization = input.authorization ?? null;
  const client = new Client({ name: "baize-control-plane", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(input.url), {
    requestInit: input.authorization === undefined ? {} : { headers: { Authorization: input.authorization } },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DiscoveryError("连不上 MCP：探测超过 10 秒")), DISCOVERY_TIMEOUT_MS);
  });
  let operations: ToolOperation[];
  try {
    operations = await Promise.race([
      (async () => {
        // SDK 的 transport.sessionId getter 返回 string | undefined，Transport 接口在 exactOptionalPropertyTypes 下写成了 sessionId?: string。
        // @ts-expect-error SDK 两份声明不一致；运行时由同一 SDK 的 Client 和 transport 配对。
        await client.connect(transport);
        const listed: ToolOperation[] = [];
        let cursor: string | undefined;
        do {
          const result = await client.listTools(cursor === undefined ? undefined : { cursor });
          listed.push(
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
        return listed;
      })(),
      timeout,
    ]);
  } catch (error) {
    throw error instanceof DiscoveryError ? error : new DiscoveryError(`连不上 MCP：${describeMcpFailure(error)}`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await client.close().catch(() => undefined);
  }
  if (echoesCredential(operations, authorization)) {
    throw new DiscoveryError("MCP 服务在操作的名字、说明或参数表里写了收到的凭据，没有保存。请检查这个 MCP 服务。");
  }
  return operations;
}
