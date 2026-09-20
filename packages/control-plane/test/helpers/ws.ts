import { ServerPush } from "@baize/shared";
import { WebSocket } from "ws";
import { WS_PATH } from "../../src/server.js";

export type PushClient = {
  readonly socket: WebSocket;
  next(timeoutMs?: number): Promise<ServerPush>;
  nextRaw(timeoutMs?: number): Promise<ServerPush>;
  close(): void;
};

export async function connectPush(port: number, cookie: string): Promise<PushClient> {
  const socket = new WebSocket(`ws://localhost:${port}${WS_PATH}`, { headers: { cookie } });
  const inbox: ServerPush[] = [];
  const waiters: ((push: ServerPush) => void)[] = [];

  socket.on("message", (raw) => {
    const push = ServerPush.parse(JSON.parse(raw.toString()));
    const waiter = waiters.shift();
    if (waiter === undefined) inbox.push(push);
    else waiter(push);
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  const nextRaw = (timeoutMs = 5000): Promise<ServerPush> =>
    new Promise((resolve, reject) => {
      const buffered = inbox.shift();
      if (buffered !== undefined) return resolve(buffered);
      const waiter = (push: ServerPush) => {
        clearTimeout(timer);
        resolve(push);
      };
      const timer = setTimeout(() => {
        const at = waiters.indexOf(waiter);
        if (at !== -1) waiters.splice(at, 1);
        reject(new Error("等推送超时"));
      }, timeoutMs);
      waiters.push(waiter);
    });

  return {
    socket,
    nextRaw,
    next: async (timeoutMs = 5000) => {
      for (;;) {
        const push = await nextRaw(timeoutMs);
        if (push.type !== "group_turn") return push;
      }
    },
    close: () => socket.close(),
  };
}

export function expectUpgradeRejected(port: number, cookie: string | null): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://localhost:${port}${WS_PATH}`, cookie === null ? {} : { headers: { cookie } });
    socket.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    socket.once("open", () => reject(new Error("握手本应被拒绝")));
    socket.once("error", (err) => reject(err));
  });
}
