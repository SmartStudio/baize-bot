import { z } from "zod";
import { expireLogin } from "../account-expiry.js";
import type { AgentHub } from "../agent/hub.js";
import type { AccessToken, AccountTokens } from "../credentials.js";
import type { Db } from "../db/client.js";
import type { NoticePublisher } from "../notifications.js";
import { apiHeaders } from "../oauth-providers.js";
import { dueGithubStarsProjects, recordPolledSample, type GithubStarsProject } from "../repo/metrics.js";
import { findTaskByGroup } from "../repo/tasks.js";
import type { PushHub } from "../ws/hub.js";

/** GitHub 星数每 6 小时读一次（D1）。格子按 UTC 对齐，取没取过看库里这一格有没有样本，重启不会重取。 */
export const METRIC_WINDOW_MS = 6 * 60 * 60 * 1000;
/** 扫得勤一点只是让新项目和新的一格早点有数，读不读平台由格子定。 */
export const METRIC_SCAN_INTERVAL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;

const RepoStars = z.object({ stargazers_count: z.number().int().nonnegative() });

export type MetricPollerOptions = {
  readonly db: Db;
  readonly push: PushHub;
  readonly notifications: NoticePublisher;
  readonly agents: Pick<AgentHub, "sendConfig">;
  readonly tokens: AccountTokens;
  readonly githubApiBaseUrl: string;
  /** 测试注进来一个自己说了算的时钟。不给就是真实时间。 */
  readonly now?: () => Date;
  readonly intervalMs?: number;
};

/** 读一个仓库的结论。登录过期交给 expireLogin，其余读不到的这一格稍后再试。 */
type StarsRead =
  | { readonly kind: "stars"; readonly value: number }
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
      void this.tick().catch((error: unknown) => console.error("读指标出错", error));
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
    for (const project of await dueGithubStarsProjects(this.#options.db, windowStart)) {
      try {
        await this.#sample(project, { sampledAt: now, windowStart });
      } catch (error) {
        console.error(`项目群 ${project.groupId} 读 GitHub 星数出错`, error);
      }
    }
  }

  async #sample(project: GithubStarsProject, slot: { sampledAt: Date; windowStart: Date }): Promise<void> {
    const { db, push } = this.#options;
    const read = await this.#readStars(project);
    if (read.kind === "login_expired") {
      await expireLogin(this.#options, project.ownerId, project.accountId, { generation: read.generation });
      return;
    }
    if (read.kind === "unavailable") {
      console.warn(`项目群 ${project.groupId} 这一格没读到 ${project.repo} 的星数：${read.reason}`);
      return;
    }
    const recorded = await recordPolledSample(db, project.ownerId, project.groupId, read.value, "github_stars", slot);
    if (recorded === null) return;
    const task = await findTaskByGroup(db, recorded);
    if (task !== null) push.push(project.ownerId, { type: "task_updated", task });
  }

  /** 和账号代理同一条取令牌的路：401 把这把令牌交回去强制刷新，只重试一次，还不认才算过期。 */
  async #readStars(project: GithubStarsProject): Promise<StarsRead> {
    // 仓库名的格式在 MetricSource 上校过，但 . 和 .. 也合格式，拼进路径会跳出 /repos。
    if (project.repo.split("/").some((part) => part === "." || part === "..")) {
      return { kind: "unavailable", reason: "仓库名不对" };
    }
    const url = `${this.#options.githubApiBaseUrl.replace(/\/$/, "")}/repos/${project.repo}`;
    let rejected: string | null = null;
    for (;;) {
      const token: AccessToken = await this.#options.tokens.accessToken(project.accountId, rejected);
      if (token.kind === "login_expired") return { kind: "login_expired", generation: token.generation };
      let response: Response;
      try {
        response = await fetch(url, {
          headers: { ...apiHeaders("github"), authorization: `Bearer ${token.token}` },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
      } catch (error) {
        return { kind: "unavailable", reason: `连不上 GitHub，${String(error)}` };
      }
      if (response.status === 401) {
        await response.body?.cancel();
        if (rejected !== null) return { kind: "login_expired", generation: token.generation };
        rejected = token.token;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        return { kind: "unavailable", reason: `GitHub 回 ${response.status}` };
      }
      const parsed = RepoStars.safeParse(await response.json().catch(() => undefined));
      if (!parsed.success) return { kind: "unavailable", reason: "回包里没有 stargazers_count" };
      return { kind: "stars", value: parsed.data.stargazers_count };
    }
  }
}
