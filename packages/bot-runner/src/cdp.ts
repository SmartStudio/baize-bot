import type { Readable, Writable } from "node:stream";

// 裸 CDP 客户端，跑在 --remote-debugging-pipe 上：Chrome 从 fd 3 读、往 fd 4 写，一条消息一段 JSON，以 NUL 结尾。
// 一台电脑只有这一条管道，Bot 的浏览器工具、发布器和登录窗口都挂在上面，各自 attach 自己的标签页，
// 命令和事件按 flatten 模式的 sessionId 分路。

const COMMAND_TIMEOUT_MS = 30_000;

export interface CdpEvent {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId: string | undefined;
}

export interface CdpConnection {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>>;
  /** 回退订函数。管道是共用的，挂上的监听要自己摘。 */
  onEvent(listener: (event: CdpEvent) => void): () => void;
  isOpen(): boolean;
}

export class CdpTimeoutError extends Error {}

export interface CdpPipe {
  /** Chrome 的 fd 3。 */
  readonly toChrome: Writable;
  /** Chrome 的 fd 4。 */
  readonly fromChrome: Readable;
}

interface Pending {
  readonly resolve: (value: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

const objectOf = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** 管道任一头断了（Chrome 退出、被杀、流被销毁），在途命令全部以错误结束，之后的命令直接 reject。 */
export function connectPipe(pipe: CdpPipe): CdpConnection {
  const pending = new Map<number, Pending>();
  const listeners = new Set<(event: CdpEvent) => void>();
  let buffered = Buffer.alloc(0);
  let nextId = 0;
  let open = true;

  const shut = (): void => {
    if (!open) return;
    open = false;
    const error = new Error("助理 Chrome 退出了，这条命令没做完");
    for (const [id, waiter] of pending) {
      clearTimeout(waiter.timer);
      pending.delete(id);
      waiter.reject(error);
    }
  };

  const dispatch = (raw: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const message = objectOf(parsed);
    if (typeof message.id === "number") {
      const waiter = pending.get(message.id);
      if (waiter === undefined) return;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      const error = objectOf(message.error);
      if (typeof error.message === "string") waiter.reject(new Error(error.message));
      else waiter.resolve(objectOf(message.result));
      return;
    }
    if (typeof message.method !== "string") return;
    const event: CdpEvent = {
      method: message.method,
      params: objectOf(message.params),
      sessionId: typeof message.sessionId === "string" ? message.sessionId : undefined,
    };
    for (const listener of listeners) listener(event);
  };

  pipe.fromChrome.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    for (let end = buffered.indexOf(0); end !== -1; end = buffered.indexOf(0)) {
      const raw = buffered.subarray(0, end).toString("utf8");
      buffered = buffered.subarray(end + 1);
      dispatch(raw);
    }
  });
  for (const stream of [pipe.fromChrome, pipe.toChrome]) {
    stream.on("close", shut);
    stream.on("end", shut);
    // 写一个已经关掉的管道会报 EPIPE，不接住就是未处理的 error 事件，整个代理进程跟着崩。
    stream.on("error", shut);
  }

  return {
    send(method, params = {}, sessionId) {
      if (!open) return Promise.reject(new Error("助理 Chrome 退出了，下次用时会重新起"));
      nextId += 1;
      const id = nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new CdpTimeoutError(`助理 Chrome 等了 ${COMMAND_TIMEOUT_MS / 1000}s 没回 ${method}`));
        }, COMMAND_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        pipe.toChrome.write(
          `${JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) })}\0`,
        );
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isOpen: () => open,
  };
}
