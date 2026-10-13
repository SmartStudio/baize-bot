import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpProxyCallResponse, redactCredential, type ToolConnection } from "@baize/shared";

export const MCP_CALL_TIMEOUT_MS = 60_000;

interface CachedClient {
  readonly fingerprint: string;
  readonly client: Client;
  readonly ready: Promise<void>;
}

/** 一个控制面实例共用连接；HTTP 写入时作废，失败时只撤掉本次使用的那一份。 */
export class McpClients {
  readonly #clients = new Map<string, CachedClient>();

  async close(): Promise<void> {
    const clients = [...this.#clients.values()];
    this.#clients.clear();
    await Promise.all(clients.map((cached) => cached.client.close().catch(() => undefined)));
  }

  invalidate(id: string): void {
    const cached = this.#clients.get(id);
    if (cached === undefined) return;
    this.#clients.delete(id);
    void cached.client.close().catch(() => undefined);
  }

  async call(
    connection: ToolConnection,
    authorization: string | null,
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<McpProxyCallResponse> {
    const fingerprint = JSON.stringify([connection, authorization]);
    let cached = this.#clients.get(connection.id);
    if (cached !== undefined && cached.fingerprint !== fingerprint) {
      this.invalidate(connection.id);
      cached = undefined;
    }
    if (cached === undefined) {
      const client = new Client({ name: "baize-control-plane", version: "0.1.0" });
      const transport = new StreamableHTTPClientTransport(new URL(connection.url), {
        requestInit: authorization === null ? {} : { headers: { Authorization: authorization } },
      });
      // SDK 的 sessionId 可省属性声明与 getter 不一致。
      const ready = client.connect(transport as unknown as Transport, { signal });
      cached = { fingerprint, client, ready };
      this.#clients.set(connection.id, cached);
    }
    const used = cached;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([
        (async () => {
          await used.ready;
          const result = await used.client.callTool({ name: tool, arguments: args }, undefined, {
            signal,
            timeout: MCP_CALL_TIMEOUT_MS,
          });
          // MCP 的成功和业务错误正文都可能回显凭据；任何内容块在交给电脑前都过同一套脱敏。
          const response = McpProxyCallResponse.parse({ content: result.content, isError: result.isError === true });
          const scrubbed = McpProxyCallResponse.parse(
            JSON.parse(redactCredential(JSON.stringify(response), authorization)),
          );
          if (response.isError && this.#clients.get(connection.id) === used) this.invalidate(connection.id);
          return scrubbed;
        })(),
        aborted,
      ]);
    } catch (error) {
      if (this.#clients.get(connection.id) === used) this.invalidate(connection.id);
      throw error;
    } finally {
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    }
  }
}
