import type { GroupId, NotifyKind, UserId } from "@baize/shared";
import type { Db } from "./db/client.js";
import { getSettings } from "./repo/settings.js";
import type { PushHub } from "./ws/hub.js";

const SHANGHAI_OFFSET_MS = 8 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const SWEEP_INTERVAL_MS = 30_000;

export type NoticeInput = {
  readonly kind: NotifyKind;
  readonly text: string;
  readonly groupId: GroupId | null;
};

export type NoticePublisher = {
  publish(userId: UserId, notice: NoticeInput): Promise<void>;
  /** 该用户有一台电脑代理握手成功，一段离线期结束，下一次卡住再推。 */
  computerOnline(userId: UserId): Promise<void>;
};

export type NotificationOptions = {
  readonly now?: () => Date;
  readonly intervalMs?: number;
};

type PendingSummary = { count: number; endAt: number };

export class Notifications implements NoticePublisher {
  readonly #db: Db;
  readonly #push: PushHub;
  readonly #now: () => Date;
  readonly #intervalMs: number;
  readonly #pending = new Map<UserId, PendingSummary>();
  readonly #stuckSent = new Set<UserId>();
  #timer: NodeJS.Timeout | null = null;
  #chain: Promise<void> = Promise.resolve();

  constructor(db: Db, push: PushHub, options: NotificationOptions = {}) {
    this.#db = db;
    this.#push = push;
    this.#now = options.now ?? (() => new Date());
    this.#intervalMs = options.intervalMs ?? SWEEP_INTERVAL_MS;
  }

  start(): void {
    const timer = setInterval(() => {
      void this.tick().catch((error: unknown) => console.error("汇总免打扰通知出错", error));
    }, this.#intervalMs);
    timer.unref();
    this.#timer = timer;
  }

  async close(): Promise<void> {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    await this.#chain;
  }

  publish(userId: UserId, notice: NoticeInput): Promise<void> {
    return this.#enqueue(() => this.#publish(userId, notice));
  }

  computerOnline(userId: UserId): Promise<void> {
    return this.#enqueue(async () => {
      this.#stuckSent.delete(userId);
    });
  }

  /** 推送连接刚连上。免打扰结束时他不在线而留下的汇总，这时补上。 */
  connected(userId: UserId): Promise<void> {
    return this.#enqueue(() => this.#flush(userId, this.#now()));
  }

  tick(): Promise<void> {
    return this.#enqueue(async () => {
      const now = this.#now();
      for (const [userId, pending] of this.#pending) {
        if (pending.endAt > now.getTime()) continue;
        try {
          await this.#flush(userId, now);
        } catch (error) {
          // 不清的话它每一轮都在同一处抛，排在后面的用户也永远轮不到。
          this.#pending.delete(userId);
          console.error("汇总免打扰通知出错", error);
        }
      }
    });
  }

  #enqueue(job: () => Promise<void>): Promise<void> {
    const current = this.#chain.then(job);
    this.#chain = current.catch(() => undefined);
    return current;
  }

  async #publish(userId: UserId, notice: NoticeInput): Promise<void> {
    if (notice.kind === "stuck") {
      if (this.#stuckSent.has(userId)) return;
      this.#stuckSent.add(userId);
    }

    const now = this.#now();
    const settings = await getSettings(this.#db, userId);
    if (!settings.notify) {
      this.#pending.delete(userId);
      return;
    }
    const endAt = dndEnd(now, settings.dndFrom, settings.dndTo);
    if (endAt !== null) {
      const pending = this.#pending.get(userId);
      this.#pending.set(userId, { count: (pending?.count ?? 0) + 1, endAt: endAt.getTime() });
      return;
    }
    // 免打扰已经结束或刚被关掉，攒下的那几件要排在这一条前面。
    await this.#flush(userId, now);
    this.#send(userId, notice, now);
  }

  async #flush(userId: UserId, now: Date): Promise<void> {
    const pending = this.#pending.get(userId);
    if (pending === undefined) return;
    if (!this.#push.isConnected(userId)) return;
    const settings = await getSettings(this.#db, userId);
    if (!settings.notify) {
      this.#pending.delete(userId);
      return;
    }
    const movedEnd = dndEnd(now, settings.dndFrom, settings.dndTo);
    if (movedEnd !== null) {
      pending.endAt = movedEnd.getTime();
      return;
    }
    this.#pending.delete(userId);
    this.#send(
      userId,
      { kind: "result", text: `免打扰期间有 ${pending.count} 件事，打开「今天」看`, groupId: null },
      now,
    );
  }

  #send(userId: UserId, notice: NoticeInput, at: Date): void {
    this.#push.push(userId, {
      type: "notify",
      notice: { ...notice, text: clip(notice.text, 200), at: at.toISOString() },
    });
  }
}

function dndEnd(now: Date, from: string | null, to: string | null): Date | null {
  if (from === null || to === null) return null;
  const start = minuteOfDay(from);
  const end = minuteOfDay(to);
  if (start === end) return null;

  const local = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  const active = start < end ? minute >= start && minute < end : minute >= start || minute < end;
  if (!active) return null;

  const localMidnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const nextDay = start > end && minute >= start ? DAY_MS : 0;
  return new Date(localMidnight + nextDay + end * 60_000 - SHANGHAI_OFFSET_MS);
}

function minuteOfDay(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return (hour ?? 0) * 60 + (minute ?? 0);
}

function clip(value: string, max: number): string {
  return [...value].slice(0, max).join("");
}
