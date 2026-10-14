import { AsyncLocalStorage } from "node:async_hooks";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { isJSONRPCRequest, type JSONRPCMessage, type RequestId } from "@modelcontextprotocol/sdk/types.js";

export const MCP_MAX_BODY_BYTES = 20 * 1024 * 1024;
export class McpResultTooLargeError extends Error {}
export class McpResponseEndedError extends TypeError {}

interface CallStream {
  readonly controller: AbortController;
  readonly signal: AbortSignal;
  id?: RequestId;
  completed: boolean;
  viaGet: boolean;
  resumable: boolean;
}

/** SDK 不把 POST SSE 的断流交给请求 Promise；在 fetch 边界关联请求、限长和取消。 */
export class McpHttpTransport extends StreamableHTTPClientTransport {
  readonly #calling = new AsyncLocalStorage<CallStream | undefined>();
  readonly #pending = new Map<RequestId, CallStream>();
  #getState: "absent" | "open" | "ended" = "absent";

  get callAborted(): boolean {
    return this.#calling.getStore()?.signal.aborted === true;
  }

  constructor(url: URL, authorization: string | null) {
    super(url, {
      requestInit: authorization === null ? {} : { headers: { Authorization: authorization } },
      fetch: (input, init) => this.#fetch(input, init),
    });
    // Protocol.connect 会串接这个回调，先标记结果再交给 SDK，避免把正常 EOF 当作断流。
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    this.onmessage = (message) => {
      if ("id" in message && message.id !== undefined && !("method" in message)) {
        const call = this.#pending.get(message.id);
        if (call !== undefined) call.completed = true;
        this.#pending.delete(message.id);
      }
    };
  }

  async withCallSignal<T>(signal: AbortSignal, invoke: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const call: CallStream = {
      controller,
      signal: AbortSignal.any([signal, controller.signal]),
      completed: false,
      viaGet: false,
      resumable: false,
    };
    try {
      return await this.#calling.run(call, () => invoke(call.signal));
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally {
      call.completed = true;
      if (call.id !== undefined) this.#pending.delete(call.id);
    }
  }

  override async send(
    message: JSONRPCMessage | JSONRPCMessage[],
    options?: Parameters<StreamableHTTPClientTransport["send"]>[1],
  ) {
    const call =
      !Array.isArray(message) && isJSONRPCRequest(message) && message.method === "tools/call"
        ? this.#calling.getStore()
        : undefined;
    if (call !== undefined && !Array.isArray(message) && isJSONRPCRequest(message)) {
      call.id = message.id;
      this.#pending.set(message.id, call);
    }
    const sendOptions =
      call === undefined
        ? options
        : {
            ...options,
            onresumptiontoken: (token: string) => {
              call.resumable = true;
              options?.onresumptiontoken?.(token);
            },
          };
    await this.#calling.run(call, () => super.send(message, sendOptions));
  }

  async #fetch(input: string | URL, init?: RequestInit): Promise<Response> {
    const call = this.#calling.getStore();
    const post = init?.method === "POST";
    // token 只授权下一次续传；续传流没有新 token 时仍需快速判定断流。
    if (!post && call !== undefined) call.resumable = false;
    let response: Response;
    try {
      response = await fetch(input, {
        ...init,
        ...(call === undefined
          ? {}
          : { signal: AbortSignal.any([call.signal, ...(init?.signal ? [init.signal] : [])]) }),
      });
    } catch (error) {
      // 单次取消已由 Protocol 拒绝；不要再经 transport.onerror 作废共享 Client。
      if (call?.signal.aborted) return new Response(null, { status: 202 });
      if (!post && call !== undefined) {
        call.controller.abort(new McpResponseEndedError());
        return new Response(null, { status: 202 });
      }
      throw error;
    }
    if (!post && call !== undefined && !response.ok) {
      await response.body?.cancel();
      call.controller.abort(new McpResponseEndedError());
      return new Response(null, { status: 202 });
    }
    if (response.status === 202 && call !== undefined) {
      call.viaGet = true;
      if (this.#getState === "ended") {
        setImmediate(() => {
          if (!call.completed) call.controller.abort(new McpResponseEndedError());
        });
      }
    }
    if (response.body === null || response.status === 202) return response;
    const reader = response.body.getReader();
    const sse = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream";
    if (!post && sse && call === undefined) this.#getState = "open";
    let bytes = 0;
    let lineBytes = 0;
    let previousCr = false;
    const cancel = () => {
      void reader.cancel().catch(() => undefined);
    };
    call?.signal.addEventListener("abort", cancel, { once: true });
    if (call?.signal.aborted) cancel();
    const finish = () => call?.signal.removeEventListener("abort", cancel);
    const fail = (error: Error) => {
      if (call !== undefined) call.controller.abort(error);
      else
        for (const pending of this.#pending.values()) {
          pending.controller.abort(pending.viaGet ? error : new McpResponseEndedError());
        }
      cancel();
    };
    const failGetWaiters = () => {
      for (const pending of this.#pending.values()) {
        if (pending.viaGet && !pending.completed) pending.controller.abort(new McpResponseEndedError());
      }
    };
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            finish();
            controller.close();
            if (response.ok && call !== undefined && !call.signal.aborted) {
              // 最后一块还要经过 SDK 的解码和解析管线；下一轮事件循环才能确认没有回包。
              setImmediate(() => {
                if (!call.completed && !call.resumable) fail(new McpResponseEndedError());
              });
            } else if (!post && sse && call === undefined) {
              this.#getState = "ended";
              setImmediate(failGetWaiters);
            }
            return;
          }
          if (!post && sse) {
            // GET 是长连接，按 SSE 事件而非连接累计限长；扫描原始字节，不先解码大正文。
            for (const byte of chunk.value) {
              bytes += 1;
              if (bytes > MCP_MAX_BODY_BYTES) break;
              if (previousCr && byte === 10) {
                previousCr = false;
                continue;
              }
              if (byte === 10 || byte === 13) {
                if (lineBytes === 0) bytes = 0;
                lineBytes = 0;
                previousCr = byte === 13;
              } else {
                lineBytes += 1;
                previousCr = false;
              }
            }
          } else bytes += chunk.value.byteLength;
          if (bytes > MCP_MAX_BODY_BYTES) {
            const error = new McpResultTooLargeError();
            fail(error);
            finish();
            if (call === undefined) controller.error(error);
            else controller.close();
            return;
          }
          controller.enqueue(chunk.value);
        } catch (error) {
          finish();
          if (call !== undefined) {
            if (!call.signal.aborted && !call.completed && !call.resumable) fail(new McpResponseEndedError());
            controller.close();
          } else {
            if (sse) {
              this.#getState = "ended";
              failGetWaiters();
            }
            controller.error(error);
          }
        }
      },
      cancel: async () => {
        finish();
        await reader.cancel().catch(() => undefined);
      },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
}
