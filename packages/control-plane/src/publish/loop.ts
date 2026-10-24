import type { AccountId, ComputerId } from "@baize/shared";
import { log } from "../log.js";
import type { AgentHub } from "../agent/hub.js";
import type { AccountTokens } from "../credentials.js";
import type { Db } from "../db/client.js";
import { enqueueDownlink, lockEnvelopeComputer } from "../agent/envelope.js";
import type { NoticePublisher } from "../notifications.js";
import {
  claimDueDrafts,
  failStaleDrafts,
  listAwaitingLogin,
  reopenMissedDrafts,
  type ClaimedDraft,
} from "../repo/drafts.js";
import type { PushHub } from "../ws/hub.js";
import { draftAttachmentIds, findOwnedAttachmentBytes, matchDraftImages } from "../repo/attachments.js";
import { publisherFor, PublishError, TokenRejected, type ApiBases, type PublishImage } from "./platforms.js";
import { announceFailure, publishFailed, publishSucceeded, type SettleDeps } from "./settle.js";

export const PUBLISH_INTERVAL_MS = 60_000;
/** 同一个号隔这么久才再让电脑看一次浏览器登没登上，没登上的号不至于每轮都开一页。 */
const LOGIN_CHECK_EVERY_MS = 5 * 60_000;
/** 抢到之后这么久还没结论就当发的那一方没了。 */
const STALE_AFTER_MS = 10 * 60_000;

export type PublishLoopOptions = {
  readonly db: Db;
  readonly push: PushHub;
  readonly notifications: NoticePublisher;
  readonly tokens: AccountTokens;
  readonly bases: ApiBases;
  readonly computers: Pick<
    AgentHub,
    "deliverableComputerIds" | "canDeliver" | "flushOutbox" | "sendConfig" | "sendToComputer"
  >;
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
  readonly #loginCheckedAt = new Map<AccountId, number>();

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
      void this.tick().catch((error: unknown) => log.error("发布循环出错", { err: error }));
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
    const computerIds = this.#options.computers.deliverableComputerIds();
    const claimed = await this.#options.db.transaction(async (tx) => {
      for (const computerId of computerIds.toSorted()) await lockEnvelopeComputer(tx, computerId);
      return claimDueDrafts(tx as unknown as Db, now, computerIds, async (claimTx, batch) => {
        for (const one of batch) {
          if (one.via !== "computer" || !this.#options.computers.canDeliver(one.computerId)) continue;
          const publisher = publisherFor(one.draft.platform, "computer");
          await enqueueDownlink(claimTx, one.computerId, {
            type: "publish_draft",
            draftId: one.draft.id,
            botId: one.draft.botId,
            accountId: one.draft.accountId,
            platform: publisher.platform,
            content: one.draft.content,
            attempt: one.claimedAt.toISOString(),
          });
        }
      });
    });
    await Promise.all(
      claimed.map(async (one) => {
        this.#options.push.push(one.ownerId, { type: "draft_updated", draft: one.draft });
        await this.#publish(one);
      }),
    );
    await this.#checkLogins(now, computerIds);
  }

  /** 登上了电脑回 login_state valid，账号变已登录、重发 config，下一轮就抢得到；没登上什么都不变。 */
  async #checkLogins(now: Date, computerIds: readonly ComputerId[]): Promise<void> {
    for (const { accountId, computerId, platform } of await listAwaitingLogin(this.#options.db, computerIds)) {
      const last = this.#loginCheckedAt.get(accountId);
      if (last !== undefined && now.getTime() - last < LOGIN_CHECK_EVERY_MS) continue;
      if (this.#options.computers.sendToComputer(computerId, { type: "login_check", accountId, platform }))
        this.#loginCheckedAt.set(accountId, now.getTime());
    }
  }

  async #failStale(now: Date): Promise<void> {
    for (const stale of await failStaleDrafts(this.#options.db, new Date(now.getTime() - STALE_AFTER_MS))) {
      await announceFailure(this.#deps, stale);
    }
  }

  async #publish(claimed: ClaimedDraft): Promise<void> {
    const { draft } = claimed;
    const scope = { draftId: draft.id, claimedAt: claimed.claimedAt };
    if (claimed.via === "computer") {
      await this.#options.computers.flushOutbox(claimed.computerId);
      return;
    }
    const publisher = publisherFor(draft.platform, "api");
    try {
      const images = await this.#imagesStillStored(claimed);
      // 和账号代理同一条规则：401 把这次用的令牌交回去，库里还是它就强制刷新，已被别处换过就直接用新的，只重试一次。
      // 401 是平台没接受这次请求，重发这条 POST 不会发出两条；别处刷新之后旧令牌晚到的 401 也就不会把账号记过期。
      let rejected: string | null = null;
      for (;;) {
        // 解密也在 try 里：钥匙换过、密文坏了，这一轮就记失败，不等十分钟超时。
        const token = await this.#options.tokens.accessToken(draft.accountId, rejected);
        if (token.kind === "login_expired") {
          await publishFailed(this.#deps, scope, "login_expired", { generation: token.generation });
          return;
        }
        try {
          const published = await publisher.publish({
            content: draft.content,
            images,
            handle: claimed.handle,
            token: token.token,
            baseUrl: publisher.baseUrl(this.#options.bases),
          });
          await publishSucceeded(this.#deps, scope, () => published);
          return;
        } catch (error) {
          if (error instanceof TokenRejected && rejected === null) {
            rejected = token.token;
            continue;
          }
          if (!(error instanceof PublishError) || error.reason !== "login_expired") throw error;
          log.warn("草稿没发出去", { draftId: draft.id, err: error });
          await publishFailed(this.#deps, scope, "login_expired", { generation: token.generation });
          return;
        }
      }
    } catch (error) {
      log.warn("草稿没发出去", { draftId: draft.id, err: error });
      await publishFailed(this.#deps, scope, error instanceof PublishError ? error.reason : "error");
    }
  }

  async #imagesStillStored(claimed: ClaimedDraft): Promise<PublishImage[]> {
    const { images } = claimed.draft.content;
    const rows = await findOwnedAttachmentBytes(this.#options.db, claimed.ownerId, draftAttachmentIds(images));
    const matched = matchDraftImages(images, rows);
    if (matched.kind === "missing") throw new PublishError("error", `第 ${matched.position} 张配图在控制面上找不到了`);
    return matched.rows.map(({ bytes, mime }) => ({ bytes, mime }));
  }
}
