import { eq } from "drizzle-orm";
import { pokerHands } from "../db/schema.js";
import { configurePoker, converge, type PokerDeps, type PokerOptions } from "./converge.js";

export type PokerSweeperOptions = PokerOptions & { readonly intervalMs?: number };

/** 同时对账超时、没出牌就结束的 run，以及 hello 后已经丢失的 run。 */
export class PokerSweeper {
  #timer: NodeJS.Timeout | null = null;
  #running: Promise<void> | null = null;
  #stopped = false;
  constructor(
    readonly deps: PokerDeps,
    readonly options: PokerSweeperOptions = {},
  ) {
    configurePoker(deps.db, options);
  }
  start(): void {
    this.#timer = setInterval(() => {
      void this.tick().catch(() => console.error("扫描牌桌失败", "scan_failed"));
    }, this.options.intervalMs ?? 1000);
    this.#timer.unref();
  }
  async tick(): Promise<void> {
    if (this.#stopped) return;
    if (this.#running !== null) return this.#running;
    const running = this.#scan();
    this.#running = running;
    try {
      await running;
    } finally {
      this.#running = null;
    }
  }
  async #scan(): Promise<void> {
    const hands = await this.deps.db
      .select({ id: pokerHands.id })
      .from(pokerHands)
      .where(eq(pokerHands.status, "playing"));
    for (const hand of hands) {
      if (this.#stopped) return;
      try {
        await converge(this.deps, hand.id);
      } catch {
        console.error("扫描牌桌手失败", hand.id, "converge_failed");
      }
    }
  }
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    await this.#running;
  }
}
