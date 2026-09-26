import type { AgentHub } from "../agent/hub.js";
import type { CredentialCrypto } from "../credentials.js";
import { accessTokenOf } from "../credentials.js";
import type { Db } from "../db/client.js";
import type { NoticePublisher } from "../notifications.js";
import { claimDueDrafts, failStaleDrafts, reopenMissedDrafts, type ClaimedDraft } from "../repo/drafts.js";
import type { PushHub } from "../ws/hub.js";
import { COMPUTER_PLATFORMS, PUBLISHERS, PublishError, type ApiBases } from "./platforms.js";
import { announceFailure, publishFailed, publishSucceeded, type SettleDeps } from "./settle.js";

export const PUBLISH_INTERVAL_MS = 60_000;
/** 抢到之后这么久还没结论就当发的那一方没了。 */
const STALE_AFTER_MS = 10 * 60_000;

export type PublishLoopOptions = {
  readonly db: Db;
  readonly push: PushHub;
  readonly notifications: NoticePublisher;
  readonly crypto: CredentialCrypto;
  readonly bases: ApiBases;
  readonly computers: Pick<AgentHub, "onlineComputerIds" | "send" | "sendConfig">;
  /** 测试注进来一个自己说了算的时钟。不给就是真实时间。 */
  readonly now?: () => Date;
  readonly intervalMs?: number;
};

/**
 * 到点的草稿发出去。多进程同时跑也只发一次：抢行是一条带 RETURNING 的 UPDATE。
 * 停机期间到点的不补发，启动时打回待批；抢到之后没结论的超时记失败，不重发，平台那边可能已经发出去了。
 */
export class PublishLoop {
  readonly #options: PublishLoopOptions;
  readonly #now: () => Date;
  readonly #deps: SettleDeps;
  #timer: NodeJS.Timeout | null = null;

  constructor(options: PublishLoopOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
    this.#deps = {
      db: options.db,
      push: options.push,
      notifications: options.notifications,
      agents: options.computers,
    };
  }

  async start(): Promise<void> {
    const startedAt = this.#now();
    await this.#failStale(startedAt);
    // 往前让一轮：批的时候已经过点、还没等到下一轮就停机的，也算错过。
    for (const reopened of await reopenMissedDrafts(
      this.#options.db,
      new Date(startedAt.getTime() - PUBLISH_INTERVAL_MS),
    )) {
      this.#options.push.push(reopened.ownerId, { type: "draft_updated", draft: reopened.draft });
    }
    const timer = setInterval(() => {
      void this.tick().catch((error: unknown) => console.error("发布循环出错", error));
    }, this.#options.intervalMs ?? PUBLISH_INTERVAL_MS);
    timer.unref();
    this.#timer = timer;
  }

  /** 不等正在发的那几条：它们的结论只认还在 publishing、还是这一次认领的行，晚到了也不会写错。 */
  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  async tick(): Promise<void> {
    const now = this.#now();
    await this.#failStale(now);
    const claimed = await claimDueDrafts(
      this.#options.db,
      now,
      COMPUTER_PLATFORMS,
      this.#options.computers.onlineComputerIds(),
    );
    await Promise.all(
      claimed.map(async (one) => {
        this.#options.push.push(one.ownerId, { type: "draft_updated", draft: one.draft });
        await this.#publish(one);
      }),
    );
  }

  async #failStale(now: Date): Promise<void> {
    for (const stale of await failStaleDrafts(this.#options.db, new Date(now.getTime() - STALE_AFTER_MS))) {
      await announceFailure(this.#deps, stale);
    }
  }

  async #publish(claimed: ClaimedDraft): Promise<void> {
    const { draft } = claimed;
    const publisher = PUBLISHERS[draft.platform];
    const scope = { draftId: draft.id, claimedAt: claimed.claimedAt };
    if (publisher.via === "computer") {
      // 发不出去就是电脑刚好在抢完之后断了。留在 publishing，超时记失败。
      this.#options.computers.send(claimed.computerId, {
        type: "publish_draft",
        draftId: draft.id,
        botId: draft.botId,
        accountId: draft.accountId,
        platform: publisher.platform,
        content: draft.content,
        attempt: claimed.claimedAt.toISOString(),
      });
      return;
    }
    try {
      // 解密也在 try 里：钥匙换过、密文坏了，这一轮就记失败，不等十分钟超时。
      const token = await accessTokenOf(this.#options.db, this.#options.crypto, draft.accountId);
      if (token === null) {
        await publishFailed(this.#deps, scope, "login_expired");
        return;
      }
      const published = await publisher.publish({
        content: draft.content,
        handle: claimed.handle,
        token,
        baseUrl: publisher.baseUrl(this.#options.bases),
      });
      await publishSucceeded(this.#deps, scope, () => published);
    } catch (error) {
      console.warn(`草稿 ${draft.id} 没发出去`, error instanceof PublishError ? error.message : error);
      await publishFailed(this.#deps, scope, error instanceof PublishError ? error.reason : "error");
    }
  }
}
