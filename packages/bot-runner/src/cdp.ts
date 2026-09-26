// 裸 CDP 客户端，跑在 Node 自带的全局 WebSocket 上。一条连接连浏览器级端点，
// 标签页的命令走 flatten 模式的 sessionId，一个 Bot 只占一条连接。

const COMMAND_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 5_000;

export interface CdpEvent {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId: string | undefined;
}

export interface CdpConnection {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>>;
  onEvent(listener: (event: CdpEvent) => void): void;
  isOpen(): boolean;
  close(): void;
}

interface Pending {
  readonly resolve: (value: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

const objectOf = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** 浏览器级 WebSocket 地址只认本机回环，`/json/version` 回别的一律不连。 */
export async function browserSocketUrl(cdpUrl: string): Promise<string> {
  const response = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`助理 Chrome 的 CDP 回了 ${response.status}`);
  const socketUrl = objectOf(await response.json()).webSocketDebuggerUrl;
  if (typeof socketUrl !== "string" || !socketUrl.startsWith("ws://127.0.0.1:")) {
    throw new Error("助理 Chrome 的 CDP 地址不在本机");
  }
  return socketUrl;
}

export function connectCdp(socketUrl: string): Promise<CdpConnection> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl);
    const pending = new Map<number, Pending>();
    const listeners: Array<(event: CdpEvent) => void> = [];
    let nextId = 0;
    let open = false;
    // 端口接了 TCP 却不握手时 WebSocket 不会自己报错，不设限就一直挂着，Bot 的浏览器队列跟着卡死。
    const connectTimer = setTimeout(() => {
      reject(new Error(`连不上助理 Chrome（等了 ${CONNECT_TIMEOUT_MS / 1000}s 没握手）`));
      socket.close();
    }, CONNECT_TIMEOUT_MS);

    const failAll = (error: Error): void => {
      for (const [id, waiter] of pending) {
        clearTimeout(waiter.timer);
        pending.delete(id);
        waiter.reject(error);
      }
    };

    socket.addEventListener("message", (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
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
      const cdpEvent: CdpEvent = {
        method: message.method,
        params: objectOf(message.params),
        sessionId: typeof message.sessionId === "string" ? message.sessionId : undefined,
      };
      for (const listener of listeners) listener(cdpEvent);
    });
    socket.addEventListener("close", () => {
      open = false;
      failAll(new Error("和助理 Chrome 的连接断了"));
    });
    socket.addEventListener("error", () => {
      clearTimeout(connectTimer);
      if (!open) reject(new Error("连不上助理 Chrome"));
    });
    socket.addEventListener("open", () => {
      clearTimeout(connectTimer);
      open = true;
      resolve({
        send(method, params = {}, sessionId) {
          if (!open) return Promise.reject(new Error("和助理 Chrome 的连接断了"));
          nextId += 1;
          const id = nextId;
          return new Promise((resolveCommand, rejectCommand) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              rejectCommand(new Error(`助理 Chrome 等了 ${COMMAND_TIMEOUT_MS / 1000}s 没回 ${method}`));
            }, COMMAND_TIMEOUT_MS);
            pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timer });
            socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
          });
        },
        onEvent(listener) {
          listeners.push(listener);
        },
        isOpen: () => open,
        close() {
          open = false;
          socket.close();
        },
      });
    });
  });
}
