import { createHash } from "node:crypto";
import {
  AccountId,
  BrowserPlatform,
  ComputerId,
  Publication,
  UserId,
  type Account,
  type BotId,
  type BrandBook,
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
  type PublishVia,
  type RunId,
} from "@baize/shared";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notExists,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Db } from "../db/client.js";
import { accounts, agentOutbox, bots, contentPlans, drafts, publications } from "../db/schema.js";
import { lockEnvelopeComputer } from "../agent/envelope.js";
import { newId } from "../ids.js";
import { publisherFor } from "../publish/platforms.js";
import { findAccountForDraft, markLoginExpired, type ClaimedSession, type RejectedCredentials } from "./accounts.js";
import { recordApprovedEdit } from "./brand.js";
import { appendMessage, type Tx } from "./messages.js";
import { toDraft, toPlan } from "./rows.js";
import { lockOpenRun } from "./runs.js";

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

/** 图数超过发布器能带的一律不收，免得人批了一张发不出去或发出去少图的卡。走接口的 GitHub、X 只发文字。 */
export function contentRefusal(account: { platform: Platform; via: PublishVia }, content: DraftContent): string | null {
  const { maxImages } = publisherFor(account.platform, account.via);
  if (content.images.length <= maxImages) return null;
  return maxImages === 0 ? "走接口授权的 GitHub、X 账号的草稿不能带图" : `这个账号的草稿最多带 ${maxImages} 张图`;
}

function kindRefusal(before: DraftContent, after: DraftContent): string | null {
  if (before.kind === after.kind) return null;
  return before.kind === "post" ? "不能把帖子改成回复" : "不能把回复改成帖子";
}

/** 人在卡上改了正文才记一笔。标题、配图的改动不进 edits：edits 只为回看 Bot 写的和人改的差在哪。 */
function editOf(before: DraftContent, after: DraftContent, at: Date): DraftEdit | undefined {
  if (before.text === after.text) return undefined;
  return { before: before.text, after: after.text, at: at.toISOString() };
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
  if (contentRefusal(account, spec.content) !== null) return null;
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
 * 它和 proposePlan、editDraft 都是 run 名下的写，事务开头先过 lockOpenRun，run 收尾之后晚到的报文一行都不写。
 * 可直接发布档的草稿建出来就是已批，其余等人批。
 */
export async function createDraft(
  db: Db,
  source: DraftSource,
  spec: DraftSpec,
): Promise<{ draft: Draft; message: Message } | null> {
  return db.transaction(async (tx) => {
    if (!(await lockOpenRun(tx, source))) return null;
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
      if (!(await lockOpenRun(tx, source))) return null;
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
  owner: DraftSource,
  draftId: DraftId,
  content: DraftContent,
): Promise<Draft | null> {
  return db.transaction(async (tx) => {
    if (!(await lockOpenRun(tx, owner))) return null;
    const [locked] = await tx
      .select({ draft: drafts, via: accounts.via })
      .from(drafts)
      .innerJoin(accounts, eq(accounts.id, drafts.accountId))
      .where(and(eq(drafts.id, draftId), eq(drafts.ownerId, owner.ownerId), eq(drafts.groupId, owner.groupId)))
      .limit(1)
      .for("update", { of: drafts });
    if (locked === undefined) return null;
    const current = locked.draft;
    if (current.status === "publishing" || current.status === "published") return null;
    if (kindRefusal(current.content, content) !== null) return null;
    if (contentRefusal({ platform: current.platform, via: locked.via }, content) !== null) return null;
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
): Promise<DecideResult<{ draft: Draft; brand: BrandBook | null }>> {
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ draft: drafts, via: accounts.via })
      .from(drafts)
      .innerJoin(accounts, eq(accounts.id, drafts.accountId))
      .where(and(eq(drafts.id, draftId), eq(drafts.ownerId, ownerId)))
      .limit(1)
      .for("update", { of: drafts });
    if (locked === undefined) return { kind: "not_found" };
    const current = locked.draft;
    if (current.status !== "pending") return { kind: "already_decided" };
    const now = new Date();
    if (decision.decision === "return") {
      const [row] = await tx
        .update(drafts)
        .set({ status: "returned", decidedAt: now })
        .where(and(eq(drafts.id, draftId), eq(drafts.status, "pending")))
        .returning();
      return row === undefined
        ? { kind: "already_decided" }
        : { kind: "ok", value: { draft: toDraft(row), brand: null } };
    }
    const approved = approval(current, locked.via, decision.content, now);
    if (approved.kind === "invalid") return approved;
    const [row] = await tx
      .update(drafts)
      .set(approved.set)
      .where(and(eq(drafts.id, draftId), eq(drafts.status, "pending")))
      .returning();
    if (row === undefined) return { kind: "already_decided" };
    const brand = await recordApprovedEdit(tx, ownerId, draftId, approved.edit);
    return { kind: "ok", value: { draft: toDraft(row), brand } };
  });
}

function approval(current: DraftRow, via: PublishVia, content: DraftContent | undefined, now: Date) {
  const next = content ?? current.content;
  const refusal = kindRefusal(current.content, next) ?? contentRefusal({ platform: current.platform, via }, next);
  if (refusal !== null) return { kind: "invalid" as const, error: refusal };
  const hash = contentHash({ platform: current.platform, accountId: AccountIdOf(current), content: next });
  const edit = editOf(current.content, next, now);
  return {
    kind: "ok" as const,
    edit,
    set: {
      status: "approved" as const,
      content: next,
      contentHash: hash,
      approvedHash: hash,
      edits: edit === undefined ? current.edits : [...current.edits, edit].slice(-MAX_EDITS),
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

/** brand 是这次批准追加过改动之后的手册，没追加是 null。 */
type ApprovedPlan = { plan: ContentPlan; drafts: Draft[]; brand: BrandBook | null };

/**
 * 一次批准整份计划：计划下每条还在待批的草稿都批掉，edits 里给了新内容的先换内容。
 * 已经单条决定过的草稿不动。返回的 drafts 只含这次状态变了的。
 */
export async function approvePlan(
  db: Db,
  ownerId: UserId,
  planId: ContentPlanId,
  edits: readonly { readonly draftId: DraftId; readonly content: DraftContent }[],
): Promise<DecideResult<ApprovedPlan>> {
  return db
    .transaction(async (tx): Promise<DecideResult<ApprovedPlan>> => {
      const now = new Date();
      const claimed = await claimPlan(tx, ownerId, planId, "approved", now);
      if (claimed.kind !== "ok") return claimed;
      const locked = await tx
        .select({ draft: drafts, via: accounts.via })
        .from(drafts)
        .innerJoin(accounts, eq(accounts.id, drafts.accountId))
        .where(eq(drafts.planId, planId))
        .orderBy(asc(drafts.createdAt), asc(drafts.id))
        .for("update", { of: drafts });
      const rows = locked.map(({ draft }) => draft);
      const byId = new Map(rows.map((row) => [row.id, row]));
      const contentFor = new Map<string, DraftContent>();
      for (const edit of edits) {
        if (!byId.has(edit.draftId)) throw new Refused("改的草稿不在这份计划里");
        contentFor.set(edit.draftId, edit.content);
      }
      const changed: Draft[] = [];
      let brand: BrandBook | null = null;
      for (const { draft: row, via } of locked) {
        if (row.status !== "pending") continue;
        const approved = approval(row, via, contentFor.get(row.id), now);
        if (approved.kind === "invalid") throw new Refused(approved.error);
        const [updated] = await tx
          .update(drafts)
          .set(approved.set)
          .where(and(eq(drafts.id, row.id), eq(drafts.status, "pending")))
          .returning();
        if (updated === undefined) continue;
        const draft = toDraft(updated);
        changed.push(draft);
        brand = (await recordApprovedEdit(tx, ownerId, draft.id, approved.edit)) ?? brand;
      }
      return { kind: "ok", value: { plan: toPlan(claimed.value, rows), drafts: changed, brand } };
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
export const PUBLISHING_TIERS = ["confirm_publish", "direct_publish"] as const;

export type ClaimedDraft = {
  readonly draft: Draft;
  readonly ownerId: UserId;
  readonly handle: string | null;
  readonly via: PublishVia;
  readonly computerId: ComputerId;
  readonly claimedAt: Date;
};

/**
 * 稿子批了、账号却没登上，卡在电脑浏览器账号上的那几个号。claimDueDrafts 不抢它们，
 * 发布循环拿这份名单让账号所在的电脑看一眼浏览器是不是其实已经登上了。
 */
export async function listAwaitingLogin(
  db: Db,
  onlineComputers: readonly ComputerId[],
): Promise<{ readonly accountId: AccountId; readonly computerId: ComputerId; readonly platform: BrowserPlatform }[]> {
  if (onlineComputers.length === 0) return [];
  const rows = await db
    .selectDistinct({ id: accounts.id, computerId: accounts.computerId, platform: accounts.platform })
    .from(drafts)
    .innerJoin(accounts, eq(accounts.id, drafts.accountId))
    .where(
      and(
        eq(drafts.status, "approved"),
        eq(drafts.approvedHash, drafts.contentHash),
        eq(accounts.via, "computer"),
        ne(accounts.login, "valid"),
        inArray(accounts.computerId, [...onlineComputers]),
      ),
    )
    .orderBy(asc(accounts.id));
  return rows.map((row) => ({
    accountId: AccountId.parse(row.id),
    computerId: ComputerId.parse(row.computerId),
    platform: BrowserPlatform.parse(row.platform),
  }));
}

/**
 * 抢这一轮该发的草稿：已批、指纹还是批准时的那个、到点或没定时间、账号档位允许自动发。
 * 走电脑的账号只抢所在电脑在线的。一条 UPDATE 带 RETURNING，两个进程同时抢，行锁让后到的那个
 * 重新判一次 status，已经是 publishing 就不再命中。
 */
export async function claimDueDrafts(
  db: Db,
  now: Date,
  onlineComputers: readonly ComputerId[],
  onClaim?: (tx: Tx, claimed: readonly ClaimedDraft[]) => Promise<void>,
): Promise<ClaimedDraft[]> {
  return db.transaction(async (tx) => {
    const reachable =
      onlineComputers.length === 0
        ? eq(accounts.via, "api")
        : or(eq(accounts.via, "api"), inArray(accounts.computerId, [...onlineComputers]));
    const claimed = await tx
      .update(drafts)
      // 认领时刻由这条语句自己产生：now 是这一轮开始时取的，抢到行的时候可能已经过去不少。
      // 截到毫秒，返回的 Date 和列里存的一样，结算时 claimed_at = ? 才对得上。
      // 登录会话代次也在这条语句里抄：它和 login = 'valid' 是同一行同一刻看到的。
      .set({
        status: "publishing",
        claimedAt: sql`date_trunc('milliseconds', now())`,
        claimedLoginGeneration: sql`${accounts.loginGeneration}`,
      })
      .from(accounts)
      .where(
        and(
          eq(accounts.id, drafts.accountId),
          eq(drafts.status, "approved"),
          eq(drafts.approvedHash, drafts.contentHash),
          inArray(accounts.tier, [...PUBLISHING_TIERS]),
          // 过期账号的稿子抢了也是再失败一次。留在已批，重新登录后下一轮照抢。
          eq(accounts.login, "valid"),
          // 暂停是挂起，不把到点的稿子抢成终态失败；恢复后下一轮照抢。
          notExists(
            tx
              .select({ id: bots.id })
              .from(bots)
              .where(and(eq(bots.id, drafts.botId), eq(bots.runState, "paused"))),
          ),
          or(isNull(drafts.scheduledAt), lte(drafts.scheduledAt, now)),
          reachable,
        ),
      )
      .returning({ id: drafts.id });
    if (claimed.length === 0) return [];
    const rows = await tx
      .select({ draft: drafts, handle: accounts.handle, via: accounts.via, computerId: accounts.computerId })
      .from(drafts)
      .innerJoin(accounts, eq(accounts.id, drafts.accountId))
      .where(
        inArray(
          drafts.id,
          claimed.map((row) => row.id),
        ),
      )
      .orderBy(asc(drafts.createdAt), asc(drafts.id));
    const result = rows.map((row) => {
      if (row.draft.claimedAt === null) throw new Error(`刚认领的草稿 ${row.draft.id} 没有认领时刻`);
      return {
        draft: toDraft(row.draft),
        ownerId: UserId.parse(row.draft.ownerId),
        handle: row.handle,
        via: row.via,
        computerId: ComputerId.parse(row.computerId),
        claimedAt: row.draft.claimedAt,
      };
    });
    await onClaim?.(tx, result);
    return result;
  });
}

/**
 * 认领一条正在发的草稿的结论。只认还在 publishing 的：进程重启时已经记成失败的、结果报了两次的，
 * 都不再改。给了 claimedAt 就还要是那一次认领，超时被记失败又被重新批准重新抢的，旧结果不算数。
 */
export type SettleScope = {
  readonly draftId: DraftId;
  /** 只结算这一次认领。发布循环用自己抢到时记的时刻，电脑报上来的用 publish_result 带回的 attempt。 */
  readonly claimedAt?: Date;
  /** 电脑报上来的结果只认这台电脑上走电脑的账号、这台电脑主人的草稿。走接口的草稿只有发布循环自己能结算。 */
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
          inArray(
            drafts.accountId,
            sql`(select ${accounts.id} from ${accounts} where ${accounts.computerId} = ${scope.computer.computerId} and ${accounts.via} = 'computer')`,
          ),
        ),
  );
}

/** 落账的链接和 id 按这条草稿的平台定：电脑报上来的链接要先过这个平台的域名。 */
export async function settlePublished(
  db: Db,
  scope: SettleScope,
  publishedOn: (platform: Platform) => { readonly url: string; readonly externalId: string | null },
  now: Date,
): Promise<{ draft: Draft; publication: Publication; ownerId: UserId } | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(drafts)
      .set({ status: "published", failure: null })
      .where(settleWhere(scope))
      .returning();
    if (row === undefined) return null;
    const result = publishedOn(row.platform);
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

/**
 * 这次失败对账号登录的影响。expired_now 是这一下由已登录记成过期的。already_known 是账号这边已经有了
 * 不晚于这次认领的结论：先到的过期报文已经记过期、通知过用户，或者认领之后已经重新登录，旧那次的过期不算数。
 */
export type LoginEffect =
  | { readonly kind: "unchanged" }
  | { readonly kind: "expired_now"; readonly account: Account }
  | { readonly kind: "already_known" };

/**
 * 因登录过期没发出去的，同一个事务里把账号也记成过期。控制面拿凭据被拒的（rejected）只按代际：
 * 被拒的那一代还是当前这一代才算；电脑发的草稿没有凭据，只记认领时那一次登录，认领之后重登过的不算。
 */
export async function settleFailed(
  db: Db,
  scope: SettleScope,
  reason: PublishFailureReason,
  rejected?: RejectedCredentials,
): Promise<{ draft: Draft; ownerId: UserId; login: LoginEffect } | null> {
  return db.transaction(async (tx) => {
    await lockDraftDeliveries(tx, settleWhere(scope));
    const [row] = await tx
      .update(drafts)
      .set({ status: "failed", failure: reason })
      .where(settleWhere(scope))
      .returning();
    if (row === undefined) return null;
    await deleteDraftDownlinks(tx, [row.id]);
    const ownerId = UserId.parse(row.ownerId);
    const draft = toDraft(row);
    if (reason !== "login_expired") return { draft, ownerId, login: { kind: "unchanged" } };
    const expired = await markLoginExpired(tx, {
      ownerId,
      accountId: draft.accountId,
      evidence:
        rejected === undefined ? { kind: "reported", session: claimedSession(row) } : { kind: "rejected", ...rejected },
    });
    return {
      draft,
      ownerId,
      login: expired === null ? { kind: "already_known" } : { kind: "expired_now", account: expired },
    };
  });
}

function claimedSession(row: {
  id: string;
  claimedAt: Date | null;
  claimedLoginGeneration: number | null;
}): ClaimedSession {
  if (row.claimedLoginGeneration !== null) return { kind: "generation", generation: row.claimedLoginGeneration };
  if (row.claimedAt === null) throw new Error(`在发的草稿 ${row.id} 没有认领时刻`);
  return { kind: "migrated", claimedAt: row.claimedAt };
}

/** 抢到之后太久没有结论的，多半是发的那个进程没了。记成出错，不重发：平台那边可能已经发出去了。 */
export async function failStaleDrafts(db: Db, before: Date): Promise<{ draft: Draft; ownerId: UserId }[]> {
  return db.transaction(async (tx) => {
    const condition = and(eq(drafts.status, "publishing"), lt(drafts.claimedAt, before));
    const candidates = await lockDraftDeliveries(tx, condition);
    if (candidates.length === 0) return [];
    const rows = await tx
      .update(drafts)
      .set({ status: "failed", failure: "error" })
      .where(and(condition, inArray(drafts.id, candidates)))
      .returning();
    await deleteDraftDownlinks(
      tx,
      rows.map(({ id }) => id),
    );
    return rows.map((row) => ({ draft: toDraft(row), ownerId: UserId.parse(row.ownerId) }));
  });
}

async function lockDraftDeliveries(tx: Tx, condition: SQL | undefined): Promise<string[]> {
  const rows = await tx
    .select({ id: drafts.id, computerId: accounts.computerId })
    .from(drafts)
    .innerJoin(accounts, eq(accounts.id, drafts.accountId))
    .where(condition);
  for (const id of [...new Set(rows.map(({ computerId }) => computerId))].toSorted())
    await lockEnvelopeComputer(tx, ComputerId.parse(id));
  return rows.map(({ id }) => id);
}

async function deleteDraftDownlinks(tx: Tx, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await tx
    .delete(agentOutbox)
    .where(
      and(sql`${agentOutbox.body}->>'type' = 'publish_draft'`, inArray(sql`${agentOutbox.body}->>'draftId'`, [...ids])),
    );
}

/**
 * 停机期间到点的不补发：人批的是「那个时候发」，过了点再发可能已经不合时宜。打回待批，让人重新定。
 * 判据是批准和到点两者中较晚的那个早于启动时刻减一轮：批的时候已经过了点的，是批完下一轮就该发的，不算错过。
 */
export async function reopenMissedDrafts(db: Db, missedBefore: Date): Promise<{ draft: Draft; ownerId: UserId }[]> {
  return db.transaction(async (tx) => {
    const condition = and(
      eq(drafts.status, "approved"),
      inArray(accounts.tier, [...PUBLISHING_TIERS]),
      // 过期账号的稿本来就停着等重新登录，不算停机错过；重登后由正常轮询抢。
      eq(accounts.login, "valid"),
      isNotNull(drafts.scheduledAt),
      // greatest 跳过 NULL：没记批准时刻的只看到点时刻。
      sql`greatest(${drafts.scheduledAt}, ${drafts.decidedAt}) < ${missedBefore.toISOString()}::timestamptz`,
    );
    const candidates = await lockDraftDeliveries(tx, condition);
    if (candidates.length === 0) return [];
    const rows = await tx
      .update(drafts)
      .set({ status: "pending", approvedHash: null, decidedAt: null, failure: null })
      .from(accounts)
      .where(and(eq(accounts.id, drafts.accountId), condition, inArray(drafts.id, candidates)))
      .returning();
    await deleteDraftDownlinks(
      tx,
      rows.map(({ id }) => id),
    );
    return rows.map((row) => ({ draft: toDraft(row), ownerId: UserId.parse(row.ownerId) }));
  });
}
