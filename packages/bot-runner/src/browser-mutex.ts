import { realpathSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { BotId } from "@baize/shared";

const aborted = (): Error => new Error("这次浏览器操作被中止了");
export class BotPausedError extends Error {
  constructor() {
    super("Bot 已暂停，这条没发出去，恢复 Bot 后让它再起一稿。");
  }
}

export class BrowserMutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    let phase: "queued" | "running" | "cancelled" = "queued";
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<T>((done, failed) => {
      resolve = done;
      reject = failed;
    });
    const onAbort = (): void => {
      if (phase !== "queued") return;
      phase = "cancelled";
      reject(aborted());
    };
    if (signal?.aborted === true) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    this.tail = this.tail.then(async () => {
      signal?.removeEventListener("abort", onAbort);
      if (phase === "cancelled") return;
      phase = "running";
      try {
        resolve(await work());
      } catch (error) {
        reject(error);
      }
    });
    return completion;
  }

  acquire(signal: AbortSignal | undefined): Promise<() => void> {
    return new Promise((resolve, reject) => {
      void this.run(signal, () => new Promise<void>((release) => resolve(release))).catch(reject);
    });
  }
}

export interface BrowserLifecycle {
  readonly signal: AbortSignal;
  isRunning(): boolean;
}

export interface BrowserMutexLease {
  readonly mutex: BrowserMutex;
  run<T>(work: () => Promise<T>): Promise<T>;
  release(): void;
}

const locks = new Map<
  string,
  { readonly mutex: BrowserMutex; references: number; lifecycle: BrowserLifecycle | undefined }
>();

/** 发布器不经过 Runner；用数据根和 Bot ID 找到运行器持有的同一把锁。 */
export function acquireBotBrowserMutex(dataDir: string, botId: BotId, lifecycle?: BrowserLifecycle): BrowserMutexLease {
  let root: string;
  try {
    root = realpathSync(dataDir);
  } catch {
    root = resolvePath(dataDir);
  }
  const key = JSON.stringify([root, botId]);
  let entry = locks.get(key);
  if (entry === undefined) {
    entry = { mutex: new BrowserMutex(), references: 0, lifecycle: undefined };
    locks.set(key, entry);
  }
  if (lifecycle !== undefined) entry.lifecycle = lifecycle;
  entry.references += 1;
  const held = entry;
  let released = false;
  return {
    mutex: held.mutex,
    run: async (work) => {
      const gate = held.lifecycle;
      if (gate?.signal.aborted) throw aborted();
      if (gate !== undefined && !gate.isRunning()) throw new BotPausedError();
      const release = await held.mutex.acquire(gate?.signal);
      try {
        if (gate?.signal.aborted) throw aborted();
        if (gate !== undefined && !gate.isRunning()) throw new BotPausedError();
        return await work();
      } finally {
        release();
      }
    },
    release: () => {
      if (released) return;
      released = true;
      held.references -= 1;
      if (held.references === 0) locks.delete(key);
    },
  };
}
