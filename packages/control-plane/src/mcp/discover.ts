import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ToolOperation,
  describeMcpFailure,
  MCP_DISCOVERY_MAX_OPERATIONS,
  McpHttpUrl,
  validateMcpDiscoveryOperations,
  type McpDiscoveryReason,
  type CreateToolRequest,
} from "@baize/shared";

const DISCOVERY_TIMEOUT_MS = 10_000;

/** 探测失败，message 是给前端看的固定说法，不带对端写的文字。 */
export class DiscoveryError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 = 400,
  ) {
    super(message);
  }
}

export const DISCOVERY_FAILURE_MESSAGES: Readonly<Record<McpDiscoveryReason, string>> = {
  unreachable: "连不上 MCP：这个地址连不上",
  timeout: "连不上 MCP：探测超时",
  not_mcp: "连不上 MCP：这个地址不是可用的 MCP 服务",
  unauthorized: "连不上 MCP：MCP 服务拒绝了凭据或要求授权",
  rejected: "连不上 MCP：MCP 服务拒绝了探测请求",
  echoes_credential: "MCP 服务在操作的名字、说明或参数表里写了收到的凭据，没有保存。请检查这个 MCP 服务。",
  invalid_operations: "MCP 服务返回的操作表格式不正确或超过限制，没有保存。",
};

export async function discoverTools(input: CreateToolRequest): Promise<ToolOperation[]> {
  if (!McpHttpUrl.safeParse(input.url).success) throw new DiscoveryError(DISCOVERY_FAILURE_MESSAGES.not_mcp);
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
        const seenCursors = new Set<string>();
        do {
          const result = await client.listTools(cursor === undefined ? undefined : { cursor });
          if (listed.length + result.tools.length > MCP_DISCOVERY_MAX_OPERATIONS) {
            throw new DiscoveryError(DISCOVERY_FAILURE_MESSAGES.invalid_operations);
          }
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
          const validated = validateMcpDiscoveryOperations(listed, authorization);
          if (!validated.ok) throw new DiscoveryError(DISCOVERY_FAILURE_MESSAGES[validated.reason]);
          cursor = result.nextCursor;
          if (cursor !== undefined) {
            if (seenCursors.has(cursor)) throw new DiscoveryError(DISCOVERY_FAILURE_MESSAGES.invalid_operations);
            seenCursors.add(cursor);
          }
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
  return operations;
}
