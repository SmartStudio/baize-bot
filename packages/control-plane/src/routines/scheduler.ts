import type { Db } from "../db/client.js";
import type { NoticePublisher } from "../notifications.js";
import type { AgentHub } from "../agent/hub.js";
import type { GroupTurns } from "../agent/group-turn.js";
import { advanceCronTrigger, listCronRoutines, type OwnedRoutine, type RoutineRow } from "../repo/routines.js";
import type { PushHub } from "../ws/hub.js";
import { dueMoment } from "./cron.js";
import { runRoutine } from "./run.js";

/** 单实例，每 30 秒扫一遍。判定按 cron 时刻算，不按扫描间隔算，扫得勤一点只是让它准时一点。 */
export const SCAN_INTERVAL_MS = 30_000;

export type SchedulerOptions = {
  readonly db: Db;
  readonly push: PushHub;
  readonly agents: AgentHub;
  readonly groupTurns: GroupTurns;
  readonly notifications: NoticePublisher;
  /** 测试注进来一个自己说了算的时钟。不给就是真实时间。 */
  readonly now?: () => Date;
  readonly intervalMs?: number;
};

/**
 * 例行任务的 cron 调度器。
 *
 * 到点判定是「上次触发之后到现在之间存在一个 cron 时刻」，触发时在同一条 UPDATE 里把 `lastFiredAt`
 * 推到那个时刻并以旧值做条件，所以两个进程同时扫也只发一次。
 *
 * 停机期间错过的时刻不补跑：一段空窗里存在几个 cron 时刻都只跑最晚的那一个。
 * 从没触发过的（`lastFiredAt` 为空）在 `start` 时和每次扫到时都对齐到现在，新建的例行任务因此不会立刻跑一次。
 */
export class RoutineScheduler {
  readonly #options: SchedulerOptions;
  readonly #now: () => Date;
  #timer: NodeJS.Timeout | null = null;

  constructor(options: SchedulerOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  async start(): Promise<void> {
    await this.#baseline();
    const timer = setInterval(() => {
      void this.tick().catch((error: unknown) => console.error("扫例行任务出错", error));
    }, this.#options.intervalMs ?? SCAN_INTERVAL_MS);
    timer.unref();
    this.#timer = timer;
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** 扫一遍。一条例行任务出错不连累别的，所以每条各自兜住。 */
  async tick(): Promise<void> {
    const now = this.#now();
    for (const owned of await listCronRoutines(this.#options.db)) {
      try {
        await this.#fireDue(owned, now);
      } catch (error) {
        console.error(`例行任务 ${owned.row.id} 触发出错`, error);
      }
    }
  }

  async #baseline(): Promise<void> {
    const now = this.#now();
    for (const owned of await listCronRoutines(this.#options.db)) {
      await alignUnfired(this.#options.db, owned.row, now);
    }
  }

  async #fireDue({ row, ownerId }: OwnedRoutine, now: Date): Promise<void> {
    await alignUnfired(this.#options.db, row, now);
    for (const [index, trigger] of row.triggers.entries()) {
      if (trigger.kind !== "cron" || trigger.lastFiredAt === null) continue;
      const due = dueMoment(trigger.expr, new Date(trigger.lastFiredAt), now);
      if (due === null) continue;
      // 推得动才算这一刻归我。另一个进程抢到时它看到的已经是新值，推不动就跳过。
      if (!(await advanceCronTrigger(this.#options.db, row.id, index, trigger, due))) continue;
      // 停用的只推游标不跑：不这样的话重新启用时会把停用期间攒下的那一刻补跑掉。
      if (!row.enabled) continue;
      await runRoutine(this.#options, ownerId, row, due);
    }
  }
}

/** 从没触发过的 cron 触发器对齐到现在。对齐不算触发，这一轮扫描里它就跳过去了。 */
async function alignUnfired(db: Db, row: RoutineRow, now: Date): Promise<void> {
  for (const [index, trigger] of row.triggers.entries()) {
    if (trigger.kind !== "cron" || trigger.lastFiredAt !== null) continue;
    await advanceCronTrigger(db, row.id, index, trigger, now);
  }
}
