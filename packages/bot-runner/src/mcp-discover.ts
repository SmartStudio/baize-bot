import {
  classifyMcpDiscoveryFailure,
  MCP_DISCOVERY_MAX_OPERATIONS,
  McpHttpUrl,
  validateMcpDiscoveryOperations,
  type McpDiscoveryResult,
  type ToolOperation,
} from "@baize/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const DISCOVERY_TIMEOUT_MS = 10_000;

export interface McpDiscoveryInput {
  readonly url: string;
  readonly authorization?: string;
}

export interface McpDiscoveryOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export async function discoverMcpTools(
  input: McpDiscoveryInput,
  options: McpDiscoveryOptions = {},
): Promise<McpDiscoveryResult> {
  if (options.signal?.aborted === true) return { ok: false, reason: "timeout" };
  const parsedUrl = McpHttpUrl.safeParse(input.url);
  if (!parsedUrl.success) return { ok: false, reason: "not_mcp" };

  const client = new Client({ name: "baize-bot-runner", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(parsedUrl.data), {
    requestInit: input.authorization === undefined ? {} : { headers: { Authorization: input.authorization } },
    reconnectionOptions: {
      maxRetries: 0,
      maxReconnectionDelay: 0,
      initialReconnectionDelay: 0,
      reconnectionDelayGrowFactor: 1,
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  let timedOut = false;
  const timeoutMs = options.timeoutMs ?? DISCOVERY_TIMEOUT_MS;
  const cancel = (): void => {
    void transport.close().catch(() => undefined);
  };
  const abortPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      cancel();
      const error = new Error("MCP 探测超时");
      error.name = "TimeoutError";
      reject(error);
    }, timeoutMs);
    if (options.signal !== undefined) {
      abortListener = () => {
        cancel();
        const error = new Error("MCP 探测已取消");
        error.name = "AbortError";
        reject(error);
      };
      if (options.signal.aborted) abortListener();
      else options.signal.addEventListener("abort", abortListener, { once: true });
    }
  });

  try {
    return await Promise.race([
      (async (): Promise<McpDiscoveryResult> => {
        // SDK 1.30 的 transport.sessionId 类型和 Transport 接口不一致；运行时由同一 SDK 配对。
        // @ts-expect-error SDK 声明不一致
        await client.connect(transport);
        const operations: ToolOperation[] = [];
        let cursor: string | undefined;
        const seenCursors = new Set<string>();
        do {
          const page = await client.listTools(cursor === undefined ? undefined : { cursor });
          if (operations.length + page.tools.length > MCP_DISCOVERY_MAX_OPERATIONS) {
            return { ok: false, reason: "invalid_operations" };
          }
          const additions = page.tools.map((tool) => ({
            name: tool.name,
            description: tool.description ?? "",
            inputSchema: tool.inputSchema,
            needsApproval: tool.annotations?.readOnlyHint !== true,
          }));
          operations.push(...additions);
          const checked = validateMcpDiscoveryOperations(operations, input.authorization ?? null);
          if (!checked.ok) return checked;
          cursor = page.nextCursor;
          if (cursor !== undefined) {
            if (seenCursors.has(cursor)) return { ok: false, reason: "invalid_operations" };
            seenCursors.add(cursor);
          }
        } while (cursor !== undefined);
        return validateMcpDiscoveryOperations(operations, input.authorization ?? null);
      })(),
      abortPromise,
    ]);
  } catch (error) {
    return { ok: false, reason: timedOut ? "timeout" : classifyMcpDiscoveryFailure(error) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (options.signal !== undefined && abortListener !== undefined) {
      options.signal.removeEventListener("abort", abortListener);
    }
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}
