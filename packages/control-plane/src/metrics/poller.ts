import { log } from "../log.js";
import { expireLogin } from "../account-expiry.js";
import type { AgentHub } from "../agent/hub.js";
import type { AccessToken, AccountTokens } from "../credentials.js";
import type { Db } from "../db/client.js";
import type { NoticePublisher } from "../notifications.js";
import { apiHeaders } from "../oauth-providers.js";
import type { ApiBases } from "../publish/platforms.js";
import { duePolledMetrics, recordPolledSample, type DueMetric, type PollSlot } from "../repo/metrics.js";
import { findTaskByGroup } from "../repo/tasks.js";
import type { PushHub } from "../ws/hub.js";
import { readerOf } from "./readers.js";

export const METRIC_WINDOW_MS = 6 * 60 * 60 * 1000;
/** 扫得勤一点只是让新项目和新的一格早点有数，读不读平台由格子定。 */
export const METRIC_SCAN_INTERVAL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;

export type MetricPollerOptions = {
  readonly db: Db;
  readonly push: PushHub;
  readonly notifications: NoticePublisher;
  readonly agents: Pick<AgentHub, "sendConfig">;
  readonly tokens: AccountTokens;
  readonly bases: ApiBases;
  /** 测试注进来一个自己说了算的时钟。不给就是真实时间。 */
  readonly now?: () => Date;
  readonly intervalMs?: number;
};

type MetricRead =
  | { readonly kind: "value"; readonly value: number }
  | { readonly kind: "login_expired"; readonly generation: number | null }
  | { readonly kind: "unavailable"; readonly reason: string };

export class MetricPoller {
  readonly #options: MetricPollerOptions;
  readonly #now: () => Date;
  #timer: NodeJS.Timeout | null = null;
  #running: Promise<void> | null = null;

  constructor(options: MetricPollerOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  start(): void {
    const timer = setInterval(() => {
      void this.tick().catch((error: unknown) => log.error("读指标出错", { err: error }));
    }, this.#options.intervalMs ?? METRIC_SCAN_INTERVAL_MS);
    timer.unref();
    this.#timer = timer;
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** 上一轮还没读完就等它，不另起一轮：两轮同时读同一个项目会白打一次平台。 */
  tick(): Promise<void> {
    this.#running ??= this.#scan().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #scan(): Promise<void> {
    const now = this.#now();
    const windowStart = new Date(Math.floor(now.getTime() / METRIC_WINDOW_MS) * METRIC_WINDOW_MS);
    for (const due of await duePolledMetrics(this.#options.db, windowStart)) {
      try {
        await this.#sample(due, { sampledAt: now, windowStart });
      } catch (error) {
        log.error(`读 ${readerOf(due.source).what(due.source)} 出错`, { groupId: due.groupId, err: error });
      }
    }
  }

  async #sample(due: DueMetric, slot: PollSlot): Promise<void> {
    const { db, push } = this.#options;
    const read = await this.#read(due);
    if (read.kind === "login_expired") {
      await expireLogin(this.#options, due.ownerId, due.source.accountId, { generation: read.generation });
      return;
    }
    if (read.kind === "unavailable") {
      log.warn(`这一格没读到 ${readerOf(due.source).what(due.source)}：${read.reason}`, { groupId: due.groupId });
      return;
    }
    const recorded = await recordPolledSample(db, due.ownerId, due.groupId, due.source, read.value, slot);
    if (recorded === null) return;
    const task = await findTaskByGroup(db, recorded);
    if (task !== null) push.push(due.ownerId, { type: "task_updated", task });
  }

  /** 和账号代理同一条取令牌的路：401 把这把令牌交回去强制刷新，只重试一次，还不认才算过期。 */
  async #read({ source }: DueMetric): Promise<MetricRead> {
    const reader = readerOf(source);
    const path = reader.path(source);
    if (typeof path !== "string") return { kind: "unavailable", reason: path.invalid };
    const url = `${reader.baseUrl(this.#options.bases).replace(/\/$/, "")}${path}`;
    let rejected: string | null = null;
    for (;;) {
      const token: AccessToken = await this.#options.tokens.accessToken(source.accountId, rejected);
      if (token.kind === "login_expired") return { kind: "login_expired", generation: token.generation };
      let response: Response;
      try {
        response = await fetch(url, {
          headers: { ...apiHeaders(reader.platform), authorization: `Bearer ${token.token}` },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
      } catch (error) {
        return { kind: "unavailable", reason: `连不上 ${reader.site}，${String(error)}` };
      }
      if (response.status === 401) {
        await response.body?.cancel();
        if (rejected !== null) return { kind: "login_expired", generation: token.generation };
        rejected = token.token;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        return { kind: "unavailable", reason: `${reader.site} 回 ${response.status}` };
      }
      const value = reader.value(await response.json().catch(() => undefined));
      if (value === null) return { kind: "unavailable", reason: reader.missing };
      return { kind: "value", value };
    }
  }
}
