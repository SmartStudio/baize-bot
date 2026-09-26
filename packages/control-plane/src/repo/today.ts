import {
  Approval,
  BotId,
  GroupId,
  RoutineId,
  TodayResponse,
  type TodayDoneItem,
  type TodayNextItem,
  type TodayPendingItem,
  type TodayRunningItem,
  type UserId,
} from "@baize/shared";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  accounts,
  approvals,
  bots,
  contentPlans,
  drafts,
  groups,
  publications,
  routineRuns,
  routines,
} from "../db/schema.js";
import { nextMoment } from "../routines/cron.js";
import { findAssistant } from "./bots.js";
import { toAccount, toDraft, toPlan } from "./rows.js";

type DraftRow = typeof drafts.$inferSelect;
type PlanRow = typeof contentPlans.$inferSelect;

export async function getToday(db: Db, ownerId: UserId, now = new Date()): Promise<TodayResponse> {
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
  const [approvalRows, draftRows, accountRows, publicationRows, routineDoneRows, routineRows] = await Promise.all([
    db
      .select({ row: approvals })
      .from(approvals)
      .innerJoin(groups, eq(groups.id, approvals.groupId))
      .where(and(eq(groups.ownerId, ownerId), eq(approvals.status, "pending")))
      .orderBy(desc(approvals.createdAt), desc(approvals.id))
      .limit(50),
    draftRowsQuery,
    db
      .select()
      .from(accounts)
      .where(and(eq(accounts.ownerId, ownerId), eq(accounts.login, "expired")))
      .orderBy(desc(accounts.createdAt), desc(accounts.id))
      .limit(50),
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
      .where(and(eq(bots.ownerId, ownerId), eq(routines.enabled, true))),
  ]);

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

  const pendingPlans = planRows.filter((row) => row.status === "pending");
  const pendingPlanIds = new Set(pendingPlans.map((row) => row.id));
  const pending: { at: Date; id: string; item: TodayPendingItem }[] = [];
  for (const { row } of approvalRows) {
    pending.push({
      at: row.createdAt,
      id: row.id,
      item: { kind: "approval", since: row.createdAt.toISOString(), approval: toApproval(row) },
    });
  }
  for (const row of pendingPlans) {
    const planDrafts = (draftsByPlan.get(row.id) ?? []).slice(0, 20);
    if (planDrafts.length === 0) continue;
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
  for (const row of draftRows) {
    if (row.status !== "pending" || (row.planId !== null && pendingPlanIds.has(row.planId))) continue;
    pending.push({
      at: row.createdAt,
      id: row.id,
      item: { kind: "draft", since: row.createdAt.toISOString(), draft: toDraft(row) },
    });
  }
  for (const row of accountRows) {
    pending.push({
      at: row.createdAt,
      id: row.id,
      item: { kind: "account", since: row.createdAt.toISOString(), account: toAccount(row) },
    });
  }
  const orderedPending = pending.toSorted(
    (left, right) => left.at.getTime() - right.at.getTime() || left.id.localeCompare(right.id),
  );

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
  const running = [...latestApprovedPlans.values()]
    .map((row): { at: Date; id: string; item: TodayRunningItem } | null => {
      const planDrafts = draftsByPlan.get(row.id) ?? [];
      const published = planDrafts.filter((draft) => draft.status === "published").length;
      if (published === planDrafts.length) return null;
      return {
        at: row.decidedAt ?? row.createdAt,
        id: row.id,
        item: {
          groupId: GroupId.parse(row.groupId),
          title: row.title,
          published,
          planned: planDrafts.length,
        },
      };
    })
    .filter((row): row is { at: Date; id: string; item: TodayRunningItem } => row !== null)
    .toSorted((left, right) => right.at.getTime() - left.at.getTime() || right.id.localeCompare(left.id))
    .slice(0, 20)
    .map(({ item }) => item);

  const next: { at: Date; id: string; item: TodayNextItem }[] = [];
  for (const row of draftRows) {
    if (row.status !== "approved" || row.scheduledAt === null) continue;
    next.push({
      at: row.scheduledAt,
      id: row.id,
      item: { kind: "draft", at: row.scheduledAt.toISOString(), draft: toDraft(row) },
    });
  }
  for (const { routine } of routineRows) {
    const times = routine.triggers.flatMap((trigger) => {
      if (trigger.kind !== "cron") return [];
      const at = nextMoment(trigger.expr, now);
      return at === null ? [] : [at];
    });
    const at = times.toSorted((left, right) => left.getTime() - right.getTime())[0];
    if (at === undefined) continue;
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
  const orderedNext = next.toSorted(
    (left, right) => left.at.getTime() - right.at.getTime() || left.id.localeCompare(right.id),
  );

  return TodayResponse.parse({
    assistantGroupId: (await findAssistant(db, ownerId))?.groupId ?? null,
    pending: orderedPending.slice(-50).map(({ item }) => item),
    done: orderedDone.slice(0, 20).map(({ item }) => item),
    running,
    next: orderedNext.slice(0, 20).map(({ item }) => item),
  });
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
    grantId: row.grantId,
  });
}

function draftTitle(row: DraftRow): string {
  return clip(
    row.content.kind === "post" ? (row.content.title ?? row.content.text) : `回复 ${row.content.replyTo.author}`,
    80,
  );
}

function clip(value: string, max: number): string {
  return [...value].slice(0, max).join("");
}
