import { Cron } from "croner";

/** 五段 cron，服务器本地时区。六段带秒的表达式在这里直接报错，调度器最细就是分钟。 */
const CRON_MODE = { mode: "5-part" } as const;

/** 解得开、而且今后还会响。「2 月 30 号」这种解得开但永远不到点的，收下来只是一条永远不跑的例行任务。 */
export function isValidCron(expr: string): boolean {
  try {
    return new Cron(expr, CRON_MODE).nextRun() !== null;
  } catch {
    return false;
  }
}

export function nextMoment(expr: string, after: Date): Date | null {
  try {
    return new Cron(expr, CRON_MODE).nextRun(after);
  } catch {
    return null;
  }
}

/**
 * `after` 之后、`now` 之前（含）最晚的那个 cron 时刻，没有就是 null。
 *
 * 取最晚的那一个而不是最早的：停机三小时再起来，每分钟跑的例行任务只补这一刻，不把错过的 180 次排队跑一遍。
 * croner 的 `previousRuns` 先把参考时刻截到整秒再取严格早于它的那一个，所以参考时刻往后推一秒，
 * 恰好落在整分上的 `now` 自己才算数；五段 cron 的时刻都在整分上，推一秒不会跨到下一个。
 */
export function dueMoment(expr: string, after: Date, now: Date): Date | null {
  const [latest] = new Cron(expr, CRON_MODE).previousRuns(1, new Date(now.getTime() + 1000));
  if (latest === undefined) return null;
  if (latest.getTime() > now.getTime()) return null;
  return latest.getTime() > after.getTime() ? latest : null;
}
