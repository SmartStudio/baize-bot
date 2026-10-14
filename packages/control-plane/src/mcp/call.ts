import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpProxyCallResponse, redactCredential, type ToolConnection } from "@baize/shared";
import { McpHttpTransport, McpResponseEndedError, McpResultTooLargeError, MCP_MAX_BODY_BYTES } from "./transport.js";

export { McpResultTooLargeError, MCP_MAX_BODY_BYTES } from "./transport.js";

export const MCP_CALL_TIMEOUT_MS = 60_000;

export class McpClientsClosedError extends Error {}

interface CachedClient {
  readonly fingerprint: string;
  readonly client: Client;
  readonly transport: McpHttpTransport;
  ready: Promise<void>;
  readonly closed: Promise<void>;
  finishClose(): void;
  activeCalls: number;
  state: "active" | "retired" | "closing";
}

/** 一个控制面实例共用连接；废弃的连接等在途调用归零后才关闭。 */
export class McpClients {
  readonly #clients = new Map<string, CachedClient>();
  readonly #allClients = new Set<CachedClient>();
  #state: "open" | "closed" = "open";

  async close(): Promise<void> {
    this.#state = "closed";
    const clients = [...this.#allClients];
    this.#clients.clear();
    for (const cached of clients) {
      if (cached.state === "active") cached.state = "retired";
      this.#closeIfIdle(cached);
    }
    await Promise.all(clients.map((cached) => cached.closed));
  }

  invalidate(id: string): void {
    const cached = this.#clients.get(id);
    if (cached !== undefined) this.#retire(id, cached);
  }

  #retire(id: string, cached: CachedClient): void {
    if (this.#clients.get(id) === cached) this.#clients.delete(id);
    if (cached.state === "active") cached.state = "retired";
    this.#closeIfIdle(cached);
  }

  #closeIfIdle(cached: CachedClient): void {
    if (cached.state !== "retired" || cached.activeCalls !== 0) return;
    cached.state = "closing";
    void cached.ready
      .catch(() => undefined)
      .then(() => cached.client.close().catch(() => undefined))
      .finally(() => {
        this.#allClients.delete(cached);
        cached.finishClose();
      });
  }

  async call(
    connection: ToolConnection,
    authorization: string | null,
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<McpProxyCallResponse> {
    if (this.#state === "closed") throw new McpClientsClosedError();
    signal.throwIfAborted();
    const fingerprint = JSON.stringify([connection, authorization]);
    let cached = this.#clients.get(connection.id);
    if (cached !== undefined && cached.fingerprint !== fingerprint) {
      this.invalidate(connection.id);
      cached = undefined;
    }
    if (cached === undefined) {
      const client = new Client({ name: "baize-control-plane", version: "0.1.0" });
      const transport = new McpHttpTransport(new URL(connection.url), authorization);
      let finishClose!: () => void;
      const closed = new Promise<void>((resolve) => (finishClose = resolve));
      cached = {
        fingerprint,
        client,
        transport,
        ready: Promise.resolve(),
        closed,
        finishClose,
        activeCalls: 0,
        state: "active",
      };
      const created = cached;
      this.#clients.set(connection.id, created);
      this.#allClients.add(created);
      // Client.onerror 还会报已取消请求的迟到回包；只有 transport.onerror 才说明连接本身出错。
      // SDK 只提供回调属性，没有 addEventListener。
      // oxlint-disable-next-line unicorn/prefer-add-event-listener
      transport.onerror = () => {
        if (!transport.callAborted) this.#retire(connection.id, created);
      };
      // oxlint-disable-next-line unicorn/prefer-add-event-listener
      client.onclose = () => this.#retire(connection.id, created);
      // 初始化属于连接，不随首个调用取消；SDK 的 sessionId 可省属性声明与 getter 不一致。
      created.ready = client
        .connect(transport as unknown as Transport, { signal: AbortSignal.timeout(MCP_CALL_TIMEOUT_MS) })
        .catch((error: unknown) => {
          this.#retire(connection.id, created);
          throw error;
        });
      // 所有等待者都取消后，初始化仍可能失败。
      void created.ready.catch(() => undefined);
    }
    const used = cached;
    used.activeCalls += 1;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([used.ready, aborted]);
      signal.throwIfAborted();
      let response: McpProxyCallResponse;
      let serialized: string;
      try {
        const result = await used.transport.withCallSignal(signal, (callSignal) =>
          used.client.callTool({ name: tool, arguments: args }, undefined, {
            signal: callSignal,
            timeout: MCP_CALL_TIMEOUT_MS,
          }),
        );
        serialized = JSON.stringify(result);
        response = McpProxyCallResponse.parse({ content: result.content, isError: result.isError === true });
      } catch (error) {
        if (
          !signal.aborted &&
          !(error instanceof McpResponseEndedError) &&
          !(error instanceof McpResultTooLargeError)
        ) {
          this.#retire(connection.id, used);
        }
        throw error;
      }
      if (Buffer.byteLength(serialized, "utf8") > MCP_MAX_BODY_BYTES) throw new McpResultTooLargeError();
      // MCP 的成功和业务错误正文都可能回显凭据；任何内容块在交给电脑前都过同一套脱敏。
      const scrubbed = redactCredential(JSON.stringify(response), authorization);
      if (Buffer.byteLength(scrubbed, "utf8") > MCP_MAX_BODY_BYTES) throw new McpResultTooLargeError();
      return McpProxyCallResponse.parse(JSON.parse(scrubbed));
    } finally {
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
      used.activeCalls -= 1;
      this.#closeIfIdle(used);
    }
  }
}
