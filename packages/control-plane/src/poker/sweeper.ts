import { eq } from "drizzle-orm";
import { errorKind } from "../agent/events.js";
import { pokerHands } from "../db/schema.js";
import { abandonHand, configurePoker, converge, type PokerDeps, type PokerOptions } from "./converge.js";

export type PokerSweeperOptions = PokerOptions & { readonly intervalMs?: number };

/**
 * 一手连续推进失败这么多次就作废。默认每秒一扫，约半分钟；偶发的库抖动撑不到这么久，撑到的多半是数据或代码出了错。
 * 作废本身也失败时计数接着涨，每满一轮再试一次，其间的失败不记日志，库断开时不会每秒刷一条。
 */
export const SWEEP_FAILURE_LIMIT = 30;

/**
 * 同时对账超时、没出牌就结束的 run，以及 hello 后已经丢失的 run。
 * 连续失败计数只在内存：重启清零，坏手在新进程里再试满一轮才作废，多等半分钟，不会误作废好手。
 */
export class PokerSweeper {
  #timer: NodeJS.Timeout | null = null;
  #running: Promise<void> | null = null;
  #stopped = false;
  readonly #failures = new Map<string, number>();
  constructor(
    readonly deps: PokerDeps,
    readonly options: PokerSweeperOptions = {},
  ) {
    configurePoker(deps.db, options);
  }
  start(): void {
    this.#timer = setInterval(() => {
      void this.tick().catch((error: unknown) => console.error("扫描牌桌失败", errorKind(error)));
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
    const playing = new Set(hands.map((hand) => hand.id));
    for (const id of this.#failures.keys()) if (!playing.has(id)) this.#failures.delete(id);
    for (const hand of hands) {
      if (this.#stopped) return;
      try {
        await converge(this.deps, hand.id);
        this.#failures.delete(hand.id);
      } catch (error) {
        const failures = (this.#failures.get(hand.id) ?? 0) + 1;
        this.#failures.set(hand.id, failures);
        const retry = failures % SWEEP_FAILURE_LIMIT === 0;
        if (failures <= SWEEP_FAILURE_LIMIT || retry)
          console.error("扫描牌桌手失败", hand.id, `${failures}/${SWEEP_FAILURE_LIMIT}`, errorKind(error));
        if (retry) await this.#abandon(hand.id);
      }
    }
  }
  async #abandon(handId: string): Promise<void> {
    try {
      if (await abandonHand(this.deps, handId)) console.error("牌桌手连续推进失败，已作废", handId);
      this.#failures.delete(handId);
    } catch (error) {
      console.error("作废牌桌手失败", handId, errorKind(error));
    }
  }
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    await this.#running;
  }
}
