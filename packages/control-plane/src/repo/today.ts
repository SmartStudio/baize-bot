import {
  Approval,
  BotId,
  GroupId,
  RoutineId,
  TodayResponse,
  type TodayAssistantLine,
  type TodayDoneItem,
  type TodayNextItem,
  type TodayPendingItem,
  type TodayRunningItem,
  type UserId,
  type Viewer,
} from "@baize/shared";
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  accounts,
  approvals,
  bots,
  contentPlans,
  drafts,
  groups,
  messages,
  publications,
  routineRuns,
  routines,
  tasks,
} from "../db/schema.js";
import { nextMoment } from "../routines/cron.js";
import { findAssistant } from "./bots.js";
import { hasMembers } from "./groups.js";
import { groupIsLive } from "./live-groups.js";
import { messageVisibleTo } from "./messages.js";
import { goalMetricOf, metricsOf } from "./metrics.js";
import { listPendingRoutineOffers } from "./routine-offers.js";
import { toAccount, toDraft, toMessage, toPlan, toTask } from "./rows.js";

type DraftRow = typeof drafts.$inferSelect;
type PlanRow = typeof contentPlans.$inferSelect;
type AccountRow = typeof accounts.$inferSelect;
type MessageRow = typeof messages.$inferSelect;

export async function getToday(db: Db, ownerId: UserId, viewer: Viewer, now = new Date()): Promise<TodayResponse> {
  const planRows = await db
    .select()
    .from(contentPlans)
    .where(and(eq(contentPlans.ownerId, ownerId), inArray(contentPlans.status, ["pending", "approved"])));
  const activePlanIds = planRows.map((row) => row.id);
  const draftRowsQuery =
    activePlanIds.length === 0
      ? db
          .select()
          .from(drafts)
          .where(
            and(eq(drafts.ownerId, ownerId), isNull(drafts.planId), inArray(drafts.status, ["pending", "approved"])),
          )
      : db
          .select()
          .from(drafts)
          .where(
            and(
              eq(drafts.ownerId, ownerId),
              or(
                inArray(drafts.planId, activePlanIds),
                and(isNull(drafts.planId), inArray(drafts.status, ["pending", "approved"])),
              ),
            ),
          );
  const [
    approvalRows,
    draftRows,
    expiredAccountRows,
    placeholderRows,
    publicationRows,
    routineDoneRows,
    routineRows,
    teamOfferRows,
  ] = await Promise.all([
    db
      .select({ row: approvals })
      .from(approvals)
      .innerJoin(groups, eq(groups.id, approvals.groupId))
      .innerJoin(messages, eq(messages.id, approvals.messageId))
      .where(and(eq(groups.ownerId, ownerId), eq(approvals.status, "pending"), messageVisibleTo(viewer)))
      .orderBy(desc(approvals.createdAt), desc(approvals.id))
      .limit(50),
    draftRowsQuery,
    db
      .select()
      .from(accounts)
      .where(and(eq(accounts.ownerId, ownerId), eq(accounts.login, "expired")))
      .orderBy(desc(accounts.loginChangedAt), desc(accounts.id))
      .limit(50),
    // 每个平台至多一个占位（accounts_owner_platform_none_idx），不用 limit。
    db
      .select()
      .from(accounts)
      .where(and(eq(accounts.ownerId, ownerId), eq(accounts.login, "none"), eq(accounts.via, "computer"))),
    db
      .select({ publication: publications, draft: drafts })
      .from(publications)
      .leftJoin(drafts, eq(drafts.id, publications.draftId))
      .where(eq(publications.ownerId, ownerId))
      .orderBy(desc(publications.publishedAt), desc(publications.id))
      .limit(20),
    db
      .select({ run: routineRuns, routine: routines })
      .from(routineRuns)
      .innerJoin(routines, eq(routines.id, routineRuns.routineId))
      .innerJoin(bots, eq(bots.id, routines.botId))
      .where(and(eq(bots.ownerId, ownerId), eq(routineRuns.status, "ok")))
      .orderBy(desc(routineRuns.startedAt), desc(routineRuns.id))
      .limit(20),
    db
      .select({ routine: routines })
      .from(routines)
      .innerJoin(bots, eq(bots.id, routines.botId))
      .where(and(eq(bots.ownerId, ownerId), eq(routines.state, "on"))),
    // 建队卡只落在主助理单聊，先放着的也还在等你确认。卡落下之后目标群才删空的，确认只会 404，不再列。
    db
      .select({ row: messages })
      .from(messages)
      .innerJoin(groups, eq(groups.id, messages.groupId))
      .where(
        and(
          eq(groups.ownerId, ownerId),
          messageVisibleTo(viewer),
          sql`${messages.body} ->> 'kind' = 'team_offer'`,
          sql`${messages.body} ->> 'status' in ('offered', 'deferred')`,
          hasMembers(sql`${messages.body} ->> 'groupId'`),
        ),
      )
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(50),
  ]);

  const draftsByPlan = draftsByPlanOf(draftRows);
  const orderedPending = pendingItems({
    approvals: approvalRows.map(({ row }) => row),
    plans: planRows,
    drafts: draftRows,
    expiredAccounts: expiredAccountRows,
    placeholders: placeholderRows,
    teamOffers: teamOfferRows.map(({ row }) => row),
    routineOffers: await listPendingRoutineOffers(db, ownerId, viewer),
  });

  const done: { at: Date; id: string; item: TodayDoneItem }[] = [];
  for (const { publication, draft } of publicationRows) {
    done.push({
      at: publication.publishedAt,
      id: publication.id,
      item: {
        kind: "publication",
        at: publication.publishedAt.toISOString(),
        groupId: publication.groupId === null ? null : GroupId.parse(publication.groupId),
        title: draft === null ? "成果已发布" : draftTitle(draft),
        platform: publication.platform,
        url: publication.url,
      },
    });
  }
  for (const row of planRows) {
    if (row.status !== "approved" || row.decidedAt === null) continue;
    const planDrafts = draftsByPlan.get(row.id) ?? [];
    if (planDrafts.length === 0) continue;
    done.push({
      at: row.decidedAt,
      id: row.id,
      item: {
        kind: "plan_approved",
        at: row.decidedAt.toISOString(),
        groupId: GroupId.parse(row.groupId),
        title: clip(row.title, 80),
        draftCount: planDrafts.length,
      },
    });
  }
  for (const { run, routine } of routineDoneRows) {
    done.push({
      at: run.startedAt,
      id: run.id,
      item: {
        kind: "routine",
        at: run.startedAt.toISOString(),
        groupId: routine.groupId === null ? null : GroupId.parse(routine.groupId),
        title: clip(routine.name, 80),
        note: clip(run.note, 200),
      },
    });
  }
  const orderedDone = done.toSorted(
    (left, right) => right.at.getTime() - left.at.getTime() || right.id.localeCompare(left.id),
  );

  const latestApprovedPlans = new Map<string, PlanRow>();
  for (const row of planRows) {
    if (row.status !== "approved") continue;
    const current = latestApprovedPlans.get(row.groupId);
    if (
      current === undefined ||
      (row.decidedAt?.getTime() ?? Number.NEGATIVE_INFINITY) >
        (current.decidedAt?.getTime() ?? Number.NEGATIVE_INFINITY) ||
      ((row.decidedAt?.getTime() ?? Number.NEGATIVE_INFINITY) ===
        (current.decidedAt?.getTime() ?? Number.NEGATIVE_INFINITY) &&
        row.id > current.id)
    ) {
      latestApprovedPlans.set(row.groupId, row);
    }
  }
  // 进「在进行」只有一道门：任务卡 active、群里还有成员。有目标的项目恒出一行，进度按目标画；
  // 没有目标的项目只在计划还有稿子没发时出一行，按稿子数画。
  const hasGoal = and(isNull(groups.soloBotId), isNotNull(tasks.goalTarget), isNotNull(tasks.goalUnit));
  const planGroupIds = [...latestApprovedPlans.keys()];
  const liveRows = await db
    .select({ task: tasks, createdAt: groups.createdAt, soloBotId: groups.soloBotId })
    .from(tasks)
    .innerJoin(groups, eq(groups.id, tasks.groupId))
    .where(
      and(
        eq(groups.ownerId, ownerId),
        groupIsLive(db),
        eq(tasks.status, "active"),
        planGroupIds.length === 0 ? hasGoal : or(hasGoal, inArray(groups.id, planGroupIds)),
      ),
    );
  const liveGroupIds = new Set(liveRows.map(({ task }) => GroupId.parse(task.groupId)));
  const goalTasks = new Map(
    liveRows
      .map(({ task, createdAt, soloBotId }) => ({ task: toTask(task), createdAt, soloBotId }))
      .filter(({ task, soloBotId }) => soloBotId === null && task.goal !== null)
      .map(({ task, createdAt }) => [task.groupId, { task, createdAt }]),
  );
  const metrics = await metricsOf(db, [...goalTasks.keys()], now);
  const running = [...liveGroupIds]
    .map((groupId): { at: Date; id: string; item: TodayRunningItem } | null => {
      const plan = latestApprovedPlans.get(groupId);
      const planDrafts = plan === undefined ? [] : (draftsByPlan.get(plan.id) ?? []);
      const published = planDrafts.filter((draft) => draft.status === "published").length;
      const counts = { published, planned: planDrafts.length };
      const goalTask = goalTasks.get(groupId);
      if (goalTask !== undefined) {
        return {
          at: plan?.decidedAt ?? goalTask.createdAt,
          id: plan?.id ?? goalTask.task.id,
          item: {
            groupId,
            title: goalTask.task.title,
            ...counts,
            goal: goalTask.task.goal,
            metric: goalMetricOf(goalTask.task, metrics.get(groupId)),
          },
        };
      }
      if (plan === undefined || published === planDrafts.length) return null;
      return {
        at: plan.decidedAt ?? plan.createdAt,
        id: plan.id,
        item: { groupId, title: plan.title, ...counts, goal: null, metric: null },
      };
    })
    .filter((row): row is { at: Date; id: string; item: TodayRunningItem } => row !== null)
    .toSorted((left, right) => right.at.getTime() - left.at.getTime() || right.id.localeCompare(left.id))
    .slice(0, 20)
    .map(({ item }) => item);

  const orderedNext = nextItems(
    draftRows,
    routineRows.map(({ routine }) => routine),
    now,
  );

  const assistant = await findAssistant(db, ownerId);
  return TodayResponse.parse({
    assistantGroupId: assistant?.groupId ?? null,
    assistantLatest: assistant === null ? null : await latestBotLine(db, assistant.groupId, viewer),
    pending: deferredLast(orderedPending.slice(-50)),
    done: orderedDone.slice(0, 20).map(({ item }) => item),
    running,
    next: orderedNext.slice(0, 20),
  });
}

/** 稿子按所属计划分桶，桶里按建稿先后排。 */
export function draftsByPlanOf(draftRows: readonly DraftRow[]): Map<string, DraftRow[]> {
  const draftsByPlan = new Map<string, DraftRow[]>();
  for (const row of draftRows) {
    if (row.planId === null) continue;
    const bucket = draftsByPlan.get(row.planId);
    if (bucket === undefined) draftsByPlan.set(row.planId, [row]);
    else bucket.push(row);
  }
  for (const [planId, rows] of draftsByPlan) {
    draftsByPlan.set(
      planId,
      rows.toSorted(
        (left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id),
      ),
    );
  }
  return draftsByPlan;
}

/**
 * 等你确认的卡，按来的先后排。approvals 只给待批的；plans 里只有待批的计划成卡；
 * drafts 要带上待批计划下的稿子，它们只随计划出现，不单独成卡。首页和项目页共用。
 * 过期的号恒成一行；没登录的浏览器平台占位只在有待办等着发给它时成一行，一个号一行，
 * 从最早那件等它的待办算起：占位可能早就建了，要登录是从有稿子等着它那一刻开始的。
 */
export function pendingItems(input: {
  readonly approvals: readonly (typeof approvals.$inferSelect)[];
  readonly plans: readonly PlanRow[];
  readonly drafts: readonly DraftRow[];
  readonly expiredAccounts: readonly AccountRow[];
  readonly placeholders: readonly AccountRow[];
  /** 项目页还不出建队卡，所以可省。 */
  readonly teamOffers?: readonly MessageRow[];
  /** 项目页不出例行确认卡，所以可省。 */
  readonly routineOffers?: readonly MessageRow[];
}): TodayPendingItem[] {
  const draftsByPlan = draftsByPlanOf(input.drafts);
  const pendingPlans = input.plans.filter((row) => row.status === "pending");
  const pendingPlanIds = new Set(pendingPlans.map((row) => row.id));
  const pending: { at: Date; id: string; item: TodayPendingItem }[] = [];
  const waitingSince = new Map<string, Date>();
  const waitOn = (accountId: string, at: Date) => {
    const current = waitingSince.get(accountId);
    if (current === undefined || at < current) waitingSince.set(accountId, at);
  };
  for (const row of input.approvals) {
    pending.push({
      at: row.createdAt,
      id: row.id,
      item: { kind: "approval", since: row.createdAt.toISOString(), approval: toApproval(row) },
    });
  }
  for (const row of pendingPlans) {
    const planDrafts = (draftsByPlan.get(row.id) ?? []).slice(0, 20);
    if (planDrafts.length === 0) continue;
    for (const draft of planDrafts) if (draft.status === "pending") waitOn(draft.accountId, row.createdAt);
    pending.push({
      at: row.createdAt,
      id: row.id,
      item: {
        kind: "plan",
        since: row.createdAt.toISOString(),
        plan: toPlan(row, planDrafts),
        drafts: planDrafts.map(toDraft),
      },
    });
  }
  for (const row of input.drafts) {
    if (row.status !== "pending" || (row.planId !== null && pendingPlanIds.has(row.planId))) continue;
    waitOn(row.accountId, row.createdAt);
    pending.push({
      at: row.createdAt,
      id: row.id,
      item: { kind: "draft", since: row.createdAt.toISOString(), draft: toDraft(row) },
    });
  }
  const accountRows = [
    ...input.expiredAccounts.map((row) => ({ row, at: row.loginChangedAt })),
    ...input.placeholders.flatMap((row) => {
      const at = waitingSince.get(row.id);
      return at === undefined ? [] : [{ row, at }];
    }),
  ];
  for (const row of input.teamOffers ?? []) {
    pending.push({
      at: row.createdAt,
      id: row.id,
      item: { kind: "team_offer", since: row.createdAt.toISOString(), message: toMessage(row) },
    });
  }
  for (const row of input.routineOffers ?? []) {
    pending.push({
      at: row.createdAt,
      id: row.id,
      item: { kind: "routine_offer", since: row.createdAt.toISOString(), message: toMessage(row) },
    });
  }
  for (const { row, at } of accountRows) {
    pending.push({
      at,
      id: row.id,
      item: { kind: "account", since: at.toISOString(), account: toAccount(row) },
    });
  }
  return pending
    .toSorted(
      (left, right) =>
        left.at.getTime() - right.at.getTime() || rank(left.item) - rank(right.item) || left.id.localeCompare(right.id),
    )
    .map(({ item }) => item);
}

// 账号行和等它的第一件待办同一刻时排在前面，菜单栏里先看到要登录。
const rank = (item: TodayPendingItem): number => (item.kind === "account" ? 0 : 1);

/**
 * 先放着的建队卡还在等你确认，只是不再排在前面：整组挪到仍待处理的项之后，组内照旧按来的先后。
 * 在按来的先后截好最新 50 条之后再挪，先挪再截会让一堆先放着的卡把更新的待办挤出去。
 */
function deferredLast(items: readonly TodayPendingItem[]): TodayPendingItem[] {
  return [...items.filter((item) => !isDeferredOffer(item)), ...items.filter(isDeferredOffer)];
}

const isDeferredOffer = (item: TodayPendingItem): boolean =>
  item.kind === "team_offer" && item.message.body.kind === "team_offer" && item.message.body.status === "deferred";

/** 排了时间的已批稿子和启用中的例行下一次触发，按时间升序。首页和项目页共用。 */
export function nextItems(
  draftRows: readonly DraftRow[],
  routineRows: readonly (typeof routines.$inferSelect)[],
  now: Date,
): TodayNextItem[] {
  const next: { at: Date; id: string; item: TodayNextItem }[] = [];
  for (const row of draftRows) {
    if (row.status !== "approved" || row.scheduledAt === null) continue;
    next.push({
      at: row.scheduledAt,
      id: row.id,
      item: { kind: "draft", at: row.scheduledAt.toISOString(), draft: toDraft(row) },
    });
  }
  for (const routine of routineRows) {
    const at = nextRoutineAt(routine, now);
    if (at === null) continue;
    next.push({
      at,
      id: routine.id,
      item: {
        kind: "routine",
        at: at.toISOString(),
        routineId: RoutineId.parse(routine.id),
        groupId: routine.groupId === null ? null : GroupId.parse(routine.groupId),
        botId: BotId.parse(routine.botId),
        title: routine.name,
      },
    });
  }
  return next
    .toSorted((left, right) => left.at.getTime() - right.at.getTime() || left.id.localeCompare(right.id))
    .map(({ item }) => item);
}

export function nextRoutineAt(routine: typeof routines.$inferSelect, now: Date): Date | null {
  const times = routine.triggers.flatMap((trigger) => {
    if (trigger.kind !== "cron") return [];
    const at = nextMoment(trigger.expr, now);
    return at === null ? [] : [at];
  });
  return times.toSorted((left, right) => left.getTime() - right.getTime())[0] ?? null;
}

function toApproval(row: typeof approvals.$inferSelect): Approval {
  return Approval.parse({
    id: row.id,
    groupId: row.groupId,
    botId: row.botId,
    runId: row.runId,
    action: row.action,
    target: row.target,
    view: row.view,
    status: row.status,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    deadlineAt: row.deadlineAt?.toISOString() ?? null,
    grantId: row.grantId,
  });
}

export function draftTitle(row: DraftRow): string {
  return clip(
    row.content.kind === "post" ? (row.content.title ?? row.content.text) : `回复 ${row.content.replyTo.author}`,
    80,
  );
}

// 流式中的消息还会变，断在半路就永远是半句，只认说完的；空壳不算说过话。
async function latestBotLine(db: Db, groupId: GroupId, viewer: Viewer): Promise<TodayAssistantLine | null> {
  const [row] = await db
    .select({ text: sql<string>`${messages.body}->>'text'`, createdAt: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.groupId, groupId),
        messageVisibleTo(viewer),
        sql`${messages.body}->>'kind' = 'bot'`,
        sql`${messages.body}->>'streaming' = 'false'`,
        sql`${messages.body}->>'text' <> ''`,
      ),
    )
    .orderBy(desc(messages.seq))
    .limit(1);
  return row === undefined ? null : { text: clip(row.text, 200), at: row.createdAt.toISOString() };
}

// zod 的 max 数的是 UTF-16 码元，这里按同一个口径截；一个码点一个码点地收，emoji 这类代理对不会被劈成两半。
export function clip(value: string, max: number): string {
  let clipped = "";
  for (const point of value) {
    if (clipped.length + point.length > max) break;
    clipped += point;
  }
  return clipped;
}
