import { createHash } from "node:crypto";
import {
  AccountId,
  ComputerId,
  Publication,
  UserId,
  type BotId,
  type ContentPlan,
  type ContentPlanId,
  type DecideDraftRequest,
  type Draft,
  type DraftContent,
  type DraftEdit,
  type DraftId,
  type DraftSpec,
  type GroupId,
  type Message,
  type Platform,
  type PublishFailureReason,
  type RunId,
} from "@baize/shared";
import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { accounts, contentPlans, drafts, publications } from "../db/schema.js";
import { newId } from "../ids.js";
import { COMPUTER_PLATFORMS } from "../publish/platforms.js";
import { findAccountForDraft } from "./accounts.js";
import { appendMessage, type Tx } from "./messages.js";
import { toDraft, toPlan } from "./rows.js";

type DraftRow = typeof drafts.$inferSelect;

const MAX_EDITS = 50;

/**
 * 批准时记下的内容指纹。改了任何一样会改变发出去的东西（平台、账号、正文、标题、发布目标、图片、回复目标），
 * 指纹就变，已批的草稿要重新等人批。图片只认 sha256：本地路径换了、图没换，发出去的是同一张。
 * 回复目标只认链接：作者和引文是给人看的上下文，不随帖子发出。拼成 JSON 数组，字段之间不会串位。
 */
export function contentHash(input: {
  readonly platform: Platform;
  readonly accountId: AccountId;
  readonly content: DraftContent;
}): string {
  const { content } = input;
  const images = content.images.map((image) => image.sha256);
  const parts =
    content.kind === "post"
      ? ["post", content.title, content.text, content.github?.repo ?? null, content.github?.as ?? null, images]
      : ["reply", content.text, content.replyTo.url, images];
  return createHash("sha256")
    .update(JSON.stringify([input.platform, input.accountId, ...parts]))
    .digest("hex");
}

/** GitHub 和 X 的发布器只会发文字，带图的草稿一律不收，免得人批了一张发出去没图的卡。 */
const TEXT_ONLY: ReadonlySet<Platform> = new Set(["github", "x"]);

export function contentRefusal(platform: Platform, content: DraftContent): string | null {
  if (content.images.length > 0 && TEXT_ONLY.has(platform)) return "GitHub 和 X 的草稿不能带图";
  return null;
}

function kindRefusal(before: DraftContent, after: DraftContent): string | null {
  if (before.kind === after.kind) return null;
  return before.kind === "post" ? "不能把帖子改成回复" : "不能把回复改成帖子";
}

/** 人在卡上改了正文才记一笔。标题、配图的改动不进 edits：edits 只为回看 Bot 写的和人改的差在哪。 */
function appendEdit(edits: readonly DraftEdit[], before: DraftContent, after: DraftContent, at: Date): DraftEdit[] {
  if (before.text === after.text) return [...edits];
  return [...edits, { before: before.text, after: after.text, at: at.toISOString() }].slice(-MAX_EDITS);
}

// ---- Bot 起草 ----

export type DraftSource = {
  readonly ownerId: UserId;
  readonly groupId: GroupId;
  readonly botId: BotId;
  readonly runId: RunId;
};

/** 一条草稿能不能落：账号是这个用户的、不是只读档、内容合这个平台。返回落库要的平台和档位。 */
async function admit(db: Db | Tx, ownerId: UserId, spec: DraftSpec) {
  const account = await findAccountForDraft(db, ownerId, spec.accountId);
  if (account === null || account.tier === "read_only") return null;
  if (contentRefusal(account.platform, spec.content) !== null) return null;
  return account;
}

function draftValues(source: DraftSource, spec: DraftSpec, platform: Platform, createdAt: Date) {
  return {
    id: spec.draftId,
    ownerId: source.ownerId,
    groupId: source.groupId,
    botId: source.botId,
    runId: source.runId,
    accountId: spec.accountId,
    platform,
    content: spec.content,
    contentHash: contentHash({ platform, accountId: spec.accountId, content: spec.content }),
    scheduledAt: spec.scheduledAt === null ? null : new Date(spec.scheduledAt),
    createdAt,
  };
}

/**
 * 单条草稿和群里那张卡一起落。draftId 由运行器生成，重复报上来撞主键什么都不做，也不再出一张卡。
 * 可直接发布档的草稿建出来就是已批，其余等人批。
 */
export async function createDraft(
  db: Db,
  source: DraftSource,
  spec: DraftSpec,
): Promise<{ draft: Draft; message: Message } | null> {
  return db.transaction(async (tx) => {
    const account = await admit(tx, source.ownerId, spec);
    if (account === null) return null;
    const now = new Date();
    const values = draftValues(source, spec, account.platform, now);
    const direct = account.tier === "direct_publish";
    const [row] = await tx
      .insert(drafts)
      .values({
        ...values,
        ...(direct ? { status: "approved" as const, approvedHash: values.contentHash, decidedAt: now } : {}),
      })
      .onConflictDoNothing()
      .returning();
    if (row === undefined) return null;
    const message = await appendMessage(tx, source.groupId, { kind: "draft", draftId: spec.draftId });
    return { draft: toDraft(row), message };
  });
}

/**
 * 一份计划和它的草稿一起落，任何一条不合格整份不落：人批的是整份计划，缺一条的计划不是 Bot 排的那份。
 * 计划下的草稿不看档位一律待批，跟计划一起批。created_at 逐条错开一毫秒，读回的顺序就是 Bot 排的顺序。
 */
export async function proposePlan(
  db: Db,
  source: DraftSource,
  planId: ContentPlanId,
  title: string,
  specs: readonly DraftSpec[],
): Promise<{ plan: ContentPlan; drafts: Draft[]; message: Message } | null> {
  if (new Set(specs.map((spec) => spec.draftId)).size !== specs.length) return null;
  return db
    .transaction(async (tx) => {
      const now = new Date();
      const [plan] = await tx
        .insert(contentPlans)
        .values({
          id: planId,
          ownerId: source.ownerId,
          groupId: source.groupId,
          botId: source.botId,
          runId: source.runId,
          title,
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning();
      if (plan === undefined) return null;
      const values = [];
      for (const [index, spec] of specs.entries()) {
        const account = await admit(tx, source.ownerId, spec);
        if (account === null) throw new Rollback();
        values.push({
          ...draftValues(source, spec, account.platform, new Date(now.getTime() + index)),
          planId,
        });
      }
      const rows = await tx.insert(drafts).values(values).onConflictDoNothing().returning();
      if (rows.length !== specs.length) throw new Rollback();
      const ordered = rows.toSorted((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
      const message = await appendMessage(tx, source.groupId, { kind: "plan", planId });
      return { plan: toPlan(plan, ordered), drafts: ordered.map(toDraft), message };
    })
    .catch((error: unknown) => {
      if (error instanceof Rollback) return null;
      throw error;
    });
}

class Rollback extends Error {}

/**
 * Bot 改一条自己群里的草稿。发出去的和正在发的不改。内容指纹没变就原样保留状态，
 * 变了一律回到待批：已批的要重新批，退回的和发失败的也要人再看一眼。
 */
export async function editDraft(
  db: Db,
  owner: { readonly ownerId: UserId; readonly groupId: GroupId },
  draftId: DraftId,
  content: DraftContent,
): Promise<Draft | null> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(drafts)
      .where(and(eq(drafts.id, draftId), eq(drafts.ownerId, owner.ownerId), eq(drafts.groupId, owner.groupId)))
      .limit(1)
      .for("update");
    if (current === undefined || current.status === "publishing" || current.status === "published") return null;
    if (kindRefusal(current.content, content) !== null) return null;
    if (contentRefusal(current.platform, content) !== null) return null;
    const hash = contentHash({ platform: current.platform, accountId: AccountIdOf(current), content });
    const reopened =
      hash === current.contentHash
        ? {}
        : { status: "pending" as const, approvedHash: null, decidedAt: null, failure: null };
    const [row] = await tx
      .update(drafts)
      .set({ content, contentHash: hash, ...reopened })
      .where(and(eq(drafts.id, draftId), notInArray(drafts.status, ["publishing", "published"])))
      .returning();
    return row === undefined ? null : toDraft(row);
  });
}

const AccountIdOf = (row: DraftRow): AccountId => AccountId.parse(row.accountId);

// ---- 人的决定 ----

export type DecideResult<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "not_found" }
  | { readonly kind: "already_decided" }
  | { readonly kind: "invalid"; readonly error: string };

/** 按行锁住再判：先 404，再 409，再 400。改了正文的批准顺手记一笔 edits，重新批准清掉上次的失败原因。 */
export async function decideDraft(
  db: Db,
  ownerId: UserId,
  draftId: DraftId,
  decision: DecideDraftRequest,
): Promise<DecideResult<Draft>> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(drafts)
      .where(and(eq(drafts.id, draftId), eq(drafts.ownerId, ownerId)))
      .limit(1)
      .for("update");
    if (current === undefined) return { kind: "not_found" };
    if (current.status !== "pending") return { kind: "already_decided" };
    const now = new Date();
    if (decision.decision === "return") {
      const [row] = await tx
        .update(drafts)
        .set({ status: "returned", decidedAt: now })
        .where(and(eq(drafts.id, draftId), eq(drafts.status, "pending")))
        .returning();
      return row === undefined ? { kind: "already_decided" } : { kind: "ok", value: toDraft(row) };
    }
    const approved = approval(current, decision.content, now);
    if (approved.kind === "invalid") return approved;
    const [row] = await tx
      .update(drafts)
      .set(approved.set)
      .where(and(eq(drafts.id, draftId), eq(drafts.status, "pending")))
      .returning();
    return row === undefined ? { kind: "already_decided" } : { kind: "ok", value: toDraft(row) };
  });
}

function approval(current: DraftRow, content: DraftContent | undefined, now: Date) {
  const next = content ?? current.content;
  const refusal = kindRefusal(current.content, next) ?? contentRefusal(current.platform, next);
  if (refusal !== null) return { kind: "invalid" as const, error: refusal };
  const hash = contentHash({ platform: current.platform, accountId: AccountIdOf(current), content: next });
  return {
    kind: "ok" as const,
    set: {
      status: "approved" as const,
      content: next,
      contentHash: hash,
      approvedHash: hash,
      edits: appendEdit(current.edits, current.content, next, now),
      failure: null,
      decidedAt: now,
    },
  };
}

async function planDraftRows(db: Db | Tx, planId: string): Promise<DraftRow[]> {
  return db.select().from(drafts).where(eq(drafts.planId, planId)).orderBy(asc(drafts.createdAt), asc(drafts.id));
}

async function claimPlan(
  tx: Tx,
  ownerId: UserId,
  planId: ContentPlanId,
  status: "approved" | "returned",
  now: Date,
): Promise<DecideResult<typeof contentPlans.$inferSelect>> {
  const [plan] = await tx
    .update(contentPlans)
    .set({ status, decidedAt: now })
    .where(and(eq(contentPlans.id, planId), eq(contentPlans.ownerId, ownerId), eq(contentPlans.status, "pending")))
    .returning();
  if (plan !== undefined) return { kind: "ok", value: plan };
  const [existing] = await tx
    .select({ id: contentPlans.id })
    .from(contentPlans)
    .where(and(eq(contentPlans.id, planId), eq(contentPlans.ownerId, ownerId)))
    .limit(1);
  return existing === undefined ? { kind: "not_found" } : { kind: "already_decided" };
}

class Refused extends Error {}

/**
 * 一次批准整份计划：计划下每条还在待批的草稿都批掉，edits 里给了新内容的先换内容。
 * 已经单条决定过的草稿不动。返回的 drafts 只含这次状态变了的。
 */
export async function approvePlan(
  db: Db,
  ownerId: UserId,
  planId: ContentPlanId,
  edits: readonly { readonly draftId: DraftId; readonly content: DraftContent }[],
): Promise<DecideResult<{ plan: ContentPlan; drafts: Draft[] }>> {
  return db
    .transaction(async (tx): Promise<DecideResult<{ plan: ContentPlan; drafts: Draft[] }>> => {
      const now = new Date();
      const claimed = await claimPlan(tx, ownerId, planId, "approved", now);
      if (claimed.kind !== "ok") return claimed;
      const rows = await tx
        .select()
        .from(drafts)
        .where(eq(drafts.planId, planId))
        .orderBy(asc(drafts.createdAt), asc(drafts.id))
        .for("update");
      const byId = new Map(rows.map((row) => [row.id, row]));
      const contentFor = new Map<string, DraftContent>();
      for (const edit of edits) {
        if (!byId.has(edit.draftId)) throw new Refused("改的草稿不在这份计划里");
        contentFor.set(edit.draftId, edit.content);
      }
      const changed: Draft[] = [];
      for (const row of rows) {
        if (row.status !== "pending") continue;
        const approved = approval(row, contentFor.get(row.id), now);
        if (approved.kind === "invalid") throw new Refused(approved.error);
        const [updated] = await tx
          .update(drafts)
          .set(approved.set)
          .where(and(eq(drafts.id, row.id), eq(drafts.status, "pending")))
          .returning();
        if (updated !== undefined) changed.push(toDraft(updated));
      }
      return { kind: "ok", value: { plan: toPlan(claimed.value, rows), drafts: changed } };
    })
    .catch((error: unknown) => {
      if (error instanceof Refused) return { kind: "invalid", error: error.message };
      throw error;
    });
}

/** 退回计划，计划下还在待批的草稿一起退。 */
export async function returnPlan(
  db: Db,
  ownerId: UserId,
  planId: ContentPlanId,
): Promise<DecideResult<{ plan: ContentPlan; drafts: Draft[] }>> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const claimed = await claimPlan(tx, ownerId, planId, "returned", now);
    if (claimed.kind !== "ok") return claimed;
    const returned = await tx
      .update(drafts)
      .set({ status: "returned", decidedAt: now })
      .where(and(eq(drafts.planId, planId), eq(drafts.status, "pending")))
      .returning();
    const rows = await planDraftRows(tx, planId);
    const ordered = returned.toSorted(
      (left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id),
    );
    return { kind: "ok", value: { plan: toPlan(claimed.value, rows), drafts: ordered.map(toDraft) } };
  });
}

// ---- 消息页 ----

/** 一页消息引用到的草稿：草稿卡指的那条，加上计划卡下面的每一条。按 created_at 升序。 */
export async function listDraftsForPage(
  db: Db,
  ownerId: UserId,
  draftIds: readonly DraftId[],
  planIds: readonly ContentPlanId[],
): Promise<Draft[]> {
  const sources: SQL[] = [];
  if (draftIds.length > 0) sources.push(inArray(drafts.id, [...draftIds]));
  if (planIds.length > 0) sources.push(inArray(drafts.planId, [...planIds]));
  if (sources.length === 0) return [];
  const rows = await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.ownerId, ownerId), or(...sources)))
    .orderBy(asc(drafts.createdAt), asc(drafts.id));
  return rows.map(toDraft);
}

export async function listPlansForPage(
  db: Db,
  ownerId: UserId,
  planIds: readonly ContentPlanId[],
): Promise<ContentPlan[]> {
  if (planIds.length === 0) return [];
  const plans = await db
    .select()
    .from(contentPlans)
    .where(and(eq(contentPlans.ownerId, ownerId), inArray(contentPlans.id, [...planIds])))
    .orderBy(asc(contentPlans.createdAt), asc(contentPlans.id));
  const rows = await db
    .select({ id: drafts.id, planId: drafts.planId })
    .from(drafts)
    .where(inArray(drafts.planId, [...planIds]))
    .orderBy(asc(drafts.createdAt), asc(drafts.id));
  return plans.flatMap((plan) => {
    const planDrafts = rows.filter((row) => row.planId === plan.id);
    return planDrafts.length === 0 ? [] : [toPlan(plan, planDrafts)];
  });
}

// ---- 发布 ----

/** 能自动发的档位。可起草档批了也只是留着，只读档连草稿都建不了。 */
const PUBLISHING_TIERS = ["confirm_publish", "direct_publish"] as const;

export type ClaimedDraft = {
  readonly draft: Draft;
  readonly ownerId: UserId;
  readonly handle: string | null;
  readonly computerId: ComputerId;
  readonly claimedAt: Date;
};

/**
 * 抢这一轮该发的草稿：已批、指纹还是批准时的那个、到点或没定时间、账号档位允许自动发。
 * 走电脑的平台只抢账号所在电脑在线的。一条 UPDATE 带 RETURNING，两个进程同时抢，行锁让后到的那个
 * 重新判一次 status，已经是 publishing 就不再命中。
 */
export async function claimDueDrafts(
  db: Db,
  now: Date,
  computerPlatforms: readonly Platform[],
  onlineComputers: readonly ComputerId[],
): Promise<ClaimedDraft[]> {
  const reachable =
    computerPlatforms.length === 0
      ? sql`true`
      : onlineComputers.length === 0
        ? notInArray(drafts.platform, [...computerPlatforms])
        : or(notInArray(drafts.platform, [...computerPlatforms]), inArray(accounts.computerId, [...onlineComputers]));
  const claimed = await db
    .update(drafts)
    .set({ status: "publishing", claimedAt: now })
    .from(accounts)
    .where(
      and(
        eq(accounts.id, drafts.accountId),
        eq(drafts.status, "approved"),
        eq(drafts.approvedHash, drafts.contentHash),
        inArray(accounts.tier, [...PUBLISHING_TIERS]),
        or(isNull(drafts.scheduledAt), lte(drafts.scheduledAt, now)),
        reachable,
      ),
    )
    .returning({ id: drafts.id });
  if (claimed.length === 0) return [];
  const rows = await db
    .select({ draft: drafts, handle: accounts.handle, computerId: accounts.computerId })
    .from(drafts)
    .innerJoin(accounts, eq(accounts.id, drafts.accountId))
    .where(
      inArray(
        drafts.id,
        claimed.map((row) => row.id),
      ),
    )
    .orderBy(asc(drafts.createdAt), asc(drafts.id));
  return rows.map((row) => ({
    draft: toDraft(row.draft),
    ownerId: UserId.parse(row.draft.ownerId),
    handle: row.handle,
    computerId: ComputerId.parse(row.computerId),
    claimedAt: now,
  }));
}

/**
 * 认领一条正在发的草稿的结论。只认还在 publishing 的：进程重启时已经记成失败的、结果报了两次的，
 * 都不再改。给了 claimedAt 就还要是那一次认领，超时被记失败又被重新批准重新抢的，旧结果不算数。
 */
export type SettleScope = {
  readonly draftId: DraftId;
  readonly claimedAt?: Date;
  /** 电脑报上来的结果只认走电脑的平台、这台电脑上的账号、这台电脑主人的草稿。走接口的草稿只有发布循环自己能结算。 */
  readonly computer?: { readonly ownerId: UserId; readonly computerId: ComputerId };
};

function settleWhere(scope: SettleScope): SQL | undefined {
  return and(
    eq(drafts.id, scope.draftId),
    eq(drafts.status, "publishing"),
    scope.claimedAt === undefined ? undefined : eq(drafts.claimedAt, scope.claimedAt),
    scope.computer === undefined
      ? undefined
      : and(
          eq(drafts.ownerId, scope.computer.ownerId),
          inArray(drafts.platform, [...COMPUTER_PLATFORMS]),
          inArray(
            drafts.accountId,
            sql`(select ${accounts.id} from ${accounts} where ${accounts.computerId} = ${scope.computer.computerId})`,
          ),
        ),
  );
}

export async function settlePublished(
  db: Db,
  scope: SettleScope,
  result: { readonly url: string; readonly externalId: string },
  now: Date,
): Promise<{ draft: Draft; publication: Publication; ownerId: UserId } | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(drafts)
      .set({ status: "published", failure: null })
      .where(settleWhere(scope))
      .returning();
    if (row === undefined) return null;
    const [publication] = await tx
      .insert(publications)
      .values({
        id: newId(),
        ownerId: row.ownerId,
        draftId: row.id,
        groupId: row.groupId,
        accountId: row.accountId,
        platform: row.platform,
        url: result.url,
        externalId: result.externalId,
        publishedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (publication === undefined) return null;
    return {
      draft: toDraft(row),
      ownerId: UserId.parse(row.ownerId),
      publication: Publication.parse({
        id: publication.id,
        draftId: publication.draftId,
        groupId: publication.groupId,
        accountId: publication.accountId,
        platform: publication.platform,
        url: publication.url,
        publishedAt: publication.publishedAt.toISOString(),
      }),
    };
  });
}

export async function settleFailed(
  db: Db,
  scope: SettleScope,
  reason: PublishFailureReason,
): Promise<{ draft: Draft; ownerId: UserId } | null> {
  const [row] = await db
    .update(drafts)
    .set({ status: "failed", failure: reason })
    .where(settleWhere(scope))
    .returning();
  return row === undefined ? null : { draft: toDraft(row), ownerId: UserId.parse(row.ownerId) };
}

/** 抢到之后太久没有结论的，多半是发的那个进程没了。记成出错，不重发：平台那边可能已经发出去了。 */
export async function failStaleDrafts(db: Db, before: Date): Promise<{ draft: Draft; ownerId: UserId }[]> {
  const rows = await db
    .update(drafts)
    .set({ status: "failed", failure: "error" })
    .where(and(eq(drafts.status, "publishing"), lt(drafts.claimedAt, before)))
    .returning();
  return rows.map((row) => ({ draft: toDraft(row), ownerId: UserId.parse(row.ownerId) }));
}

/**
 * 停机期间到点的不补发：人批的是「那个时候发」，过了点再发可能已经不合时宜。打回待批，让人重新定。
 * 判据是批准和到点两者中较晚的那个早于启动时刻减一轮：批的时候已经过了点的，是批完下一轮就该发的，不算错过。
 */
export async function reopenMissedDrafts(db: Db, missedBefore: Date): Promise<{ draft: Draft; ownerId: UserId }[]> {
  const rows = await db
    .update(drafts)
    .set({ status: "pending", approvedHash: null, decidedAt: null, failure: null })
    .from(accounts)
    .where(
      and(
        eq(accounts.id, drafts.accountId),
        eq(drafts.status, "approved"),
        inArray(accounts.tier, [...PUBLISHING_TIERS]),
        isNotNull(drafts.scheduledAt),
        // greatest 跳过 NULL：没记批准时刻的只看到点时刻。
        sql`greatest(${drafts.scheduledAt}, ${drafts.decidedAt}) < ${missedBefore.toISOString()}::timestamptz`,
      ),
    )
    .returning();
  return rows.map((row) => ({ draft: toDraft(row), ownerId: UserId.parse(row.ownerId) }));
}
