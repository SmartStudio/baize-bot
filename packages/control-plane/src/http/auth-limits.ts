import { getConnInfo } from "@hono/node-server/conninfo";
import { createHash } from "node:crypto";
import type { Context } from "hono";

export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_FAILURES_PER_EMAIL = 5;
/** 一个办公室常常共用一个出口 IP，这一维放得比邮箱宽得多，只挡换着邮箱撞库。 */
export const LOGIN_FAILURES_PER_IP = 200;
export const REGISTER_WINDOW_MS = 60 * 60 * 1000;
export const REGISTRATIONS_PER_IP = 20;
/** 每个计数器最多记这么多个键，随机邮箱刷不爆内存。 */
export const MAX_TRACKED_KEYS = 10_000;

type Window = { readonly resetAt: number; count: number };

/**
 * 进程内的定窗计数，窗口从第一次计数起算。控制面是单实例（#25），重启清零可以接受。
 * 所有窗口一样长，Map 的插入顺序就是到期顺序，过期的总在最前面。
 */
export class AttemptCounter {
  readonly #windows = new Map<string, Window>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys: number = MAX_TRACKED_KEYS,
    private readonly now: () => number = Date.now,
  ) {}

  /** 到了上限回还要等多少毫秒，没到回 null。 */
  blockedFor(key: string): number | null {
    const window = this.#windows.get(digest(key));
    const now = this.now();
    if (window === undefined || window.resetAt <= now || window.count < this.limit) return null;
    return window.resetAt - now;
  }

  hit(key: string): void {
    const now = this.now();
    this.#dropExpired(now);
    const k = digest(key);
    const window = this.#windows.get(k);
    if (window !== undefined) {
      window.count += 1;
      return;
    }
    if (this.#windows.size >= this.maxKeys) {
      const oldest = this.#windows.keys().next();
      if (oldest.done !== true) this.#windows.delete(oldest.value);
    }
    this.#windows.set(k, { resetAt: now + this.windowMs, count: 1 });
  }

  /** 退回一次 hit。登录先记上再验密码，验过了就退掉。 */
  unhit(key: string): void {
    const window = this.#windows.get(digest(key));
    if (window !== undefined && window.count > 0) window.count -= 1;
  }

  clear(key: string): void {
    this.#windows.delete(digest(key));
  }

  #dropExpired(now: number): void {
    for (const [k, window] of this.#windows) {
      if (window.resetAt > now) return;
      this.#windows.delete(k);
    }
  }
}

// 邮箱是请求体里的任意长字符串，摘要后每个键定长。
const digest = (key: string): string => createHash("sha256").update(key).digest("base64url");

/**
 * 请求的来源 IP。trustedProxyHops 是控制面前面有几层自己的反向代理：0 只认 socket 地址，
 * 不看 X-Forwarded-For，因为客户端能随便填它；n 取 X-Forwarded-For 从右数第 n 项，那是最外层代理看到的来源。
 */
export function clientIp(c: Context, trustedProxyHops: number): string {
  const socket = getConnInfo(c).remote.address ?? "unknown";
  if (trustedProxyHops === 0) return socket;
  const forwarded = (c.req.header("x-forwarded-for") ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  return forwarded[Math.max(0, forwarded.length - trustedProxyHops)] ?? socket;
}

export function retryAfterSeconds(waitMs: number): number {
  return Math.max(1, Math.ceil(waitMs / 1000));
}
