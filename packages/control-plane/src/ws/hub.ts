import { ServerPush, type UserId } from "@baize/shared";
import type { WebSocket } from "ws";

/** 按用户分组的连接表。一个用户可以开多个标签页，推送发给他的全部连接。 */
export class PushHub {
  readonly #connections = new Map<string, Set<WebSocket>>();

  add(userId: UserId, socket: WebSocket): void {
    const existing = this.#connections.get(userId);
    if (existing === undefined) this.#connections.set(userId, new Set([socket]));
    else existing.add(socket);
    socket.on("close", () => this.remove(userId, socket));
  }

  remove(userId: string, socket: WebSocket): void {
    const existing = this.#connections.get(userId);
    if (existing === undefined) return;
    existing.delete(socket);
    if (existing.size === 0) this.#connections.delete(userId);
  }

  isConnected(userId: string): boolean {
    return this.#connections.has(userId);
  }

  push(userId: string, push: ServerPush): void {
    const sockets = this.#connections.get(userId);
    if (sockets === undefined) return;
    const payload = JSON.stringify(ServerPush.parse(push));
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  }

  async closeAll(): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const sockets of this.#connections.values()) {
      for (const socket of sockets) {
        if (socket.readyState === socket.CLOSED) continue;
        closing.push(new Promise((resolve) => socket.once("close", resolve)));
        socket.close();
      }
    }
    await Promise.all(closing);
    this.#connections.clear();
  }
}
