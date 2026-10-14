import { ServerPush, type UserId } from "@baize/shared";
import type { WebSocket } from "ws";

/** WebSocket 的 1008（违反策略）：握手时认得出的人，后来账号没了。 */
const ACCOUNT_DELETED_CLOSE = 1008;

/** 按用户分组的连接表。一个用户可以开多个标签页，推送发给他的全部连接。 */
export class PushHub {
  readonly #connections = new Map<string, Set<WebSocket>>();
  /**
   * 删过号的用户。握手认身份在前、入表在后，删号落在两者之间时 disconnectUser 在表里找不到这条连接，
   * add 入表前看这里。用户 id 不复用，只进不出。
   */
  readonly #deleted = new Set<string>();

  add(userId: UserId, socket: WebSocket): void {
    if (this.#deleted.has(userId)) {
      socket.close(ACCOUNT_DELETED_CLOSE, "账号已删除");
      return;
    }
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

  /** 账号删除后调：这个人的浏览器连接全关掉并移出，之后的推送不再发给任何连接。 */
  disconnectUser(userId: UserId): void {
    this.#deleted.add(userId);
    const sockets = this.#connections.get(userId);
    this.#connections.delete(userId);
    for (const socket of sockets ?? []) socket.close(ACCOUNT_DELETED_CLOSE, "账号已删除");
  }

  isConnected(userId: string): boolean {
    return this.#connections.has(userId);
  }

  push(userId: string, push: ServerPush): void {
    if (push.type === "message" || push.type === "message_delta") {
      const visibleTo = push.type === "message" ? push.message.visibleTo : push.visibleTo;
      if (visibleTo !== null && !visibleTo.some((viewer) => viewer.kind === "user")) return;
    }
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
