import { BotId, GroupId, ProjectResponse, PublicationId, RoutineId, type UserId } from "@baize/shared";
import { and, count, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  approvals,
  contentPlans,
  drafts,
  groups,
  messages,
  publications,
  routineRuns,
  routines,
  runs,
  tasks,
} from "../db/schema.js";
import { groupHasMembers } from "./live-groups.js";
import type { Tx } from "./messages.js";
import { toDraft, toMessage, toPlan } from "./rows.js";
import { draftTitle, draftsByPlanOf, nextItems, nextRoutineAt, pendingItems } from "./today.js";
import { runTitle, weekStart } from "./usage.js";

/** 项目就是本人的多 Bot 群。别人的群、单 Bot 群、成员删光的群、不存在的群都是 null，路由据此回 404。 */
export function getProject(
  db: Db,
  ownerId: UserId,
  groupId: GroupId,
  now = new Date(),
): Promise<ProjectResponse | null> {
  // 起点、轮数、回应分几条查。不在同一个快照里的话，查起点之后才落库的新一句不算起点，却会被当成回应带出来。
  return db.transaction((tx) => readProject(tx, ownerId, groupId, now), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}

async function readProject(db: Tx, ownerId: UserId, groupId: GroupId, now: Date): Promise<ProjectResponse | null> {
  const [group] = await db
    .select({ id: groups.id })
    .from(groups)
    .where(and(eq(groups.id, groupId), eq(groups.ownerId, ownerId), isNull(groups.soloBotId), groupHasMembers(db)))
    .limit(1);
  if (group === undefined) return null;

  const planRows = await db
    .select()
    .from(contentPlans)
    .where(and(eq(contentPlans.groupId, groupId), inArray(contentPlans.status, ["pending", "approved"])));
  const activePlanIds = planRows.map((row) => row.id);
  const openDraft = and(isNull(drafts.planId), inArray(drafts.status, ["pending", "approved"]));
  const ownPublication = and(eq(publications.groupId, groupId), eq(publications.ownerId, ownerId));
  const said = sql`${messages.body}->>'kind' = 'user'`;
  const [approvalRows, draftRows, publicationRows, [weekRow], [saidRow], [turnRow], runRows, routineRows, [taskRow]] =
    await Promise.all([
      db
        .select()
        .from(approvals)
        .where(and(eq(approvals.groupId, groupId), eq(approvals.status, "pending")))
        .orderBy(desc(approvals.createdAt), desc(approvals.id))
        .limit(50),
      db
        .select()
        .from(drafts)
        .where(
          and(
            eq(drafts.groupId, groupId),
            activePlanIds.length === 0 ? openDraft : or(inArray(drafts.planId, activePlanIds), openDraft),
          ),
        ),
      db
        .select({ publication: publications, draft: drafts })
        .from(publications)
        .leftJoin(drafts, eq(drafts.id, publications.draftId))
        .where(ownPublication)
        .orderBy(desc(publications.publishedAt), desc(publications.id))
        .limit(20),
      db
        .select({ value: count() })
        .from(publications)
        .where(and(ownPublication, gte(publications.publishedAt, weekStart(now)))),
      db
        .select()
        .from(messages)
        .where(and(eq(messages.groupId, groupId), said))
        .orderBy(desc(messages.createdAt), desc(messages.seq))
        .limit(1),
      db
        .select({ value: count() })
        .from(messages)
        .where(and(eq(messages.groupId, groupId), said)),
      db
        .select({ run: runs, trigger: messages.body, routineName: routines.name, taskTitle: tasks.title })
        .from(runs)
        .leftJoin(messages, eq(messages.id, runs.triggerMessageId))
        .leftJoin(routineRuns, eq(routineRuns.id, runs.routineRunId))
        .leftJoin(routines, eq(routines.id, routineRuns.routineId))
        .leftJoin(tasks, eq(tasks.groupId, runs.groupId))
        .where(and(eq(runs.groupId, groupId), isNull(runs.endedAt)))
        .orderBy(desc(runs.startedAt), desc(runs.id))
        .limit(20),
      db
        .select()
        .from(routines)
        .where(eq(routines.groupId, groupId))
        .orderBy(routines.createdAt, routines.id)
        .limit(50),
      db.select({ checklist: tasks.checklist }).from(tasks).where(eq(tasks.groupId, groupId)).limit(1),
    ]);
  // 同一毫秒的先后按 seq 判，上一轮和你这句同一时刻落库的消息不会混进来。
  const replyRows =
    saidRow === undefined
      ? []
      : await db
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.groupId, groupId),
              sql`${messages.body}->>'kind' <> 'cost'`,
              sql`(${messages.createdAt}, ${messages.seq}) > (select created_at, seq from messages where id = ${saidRow.id})`,
            ),
          )
          .orderBy(desc(messages.createdAt), desc(messages.seq))
          .limit(50);

  const latestPlan = planRows
    .filter((row) => row.status === "approved")
    .toSorted(
      (left, right) =>
        (right.decidedAt ?? right.createdAt).getTime() - (left.decidedAt ?? left.createdAt).getTime() ||
        right.id.localeCompare(left.id),
    )[0];
  const planDrafts = latestPlan === undefined ? [] : (draftsByPlanOf(draftRows).get(latestPlan.id) ?? []).slice(0, 20);

  return ProjectResponse.parse({
    groupId,
    weekPublished: weekRow?.value ?? 0,
    weekChecked: (taskRow?.checklist ?? []).filter(
      (item) => item.done && item.doneAt !== null && new Date(item.doneAt) >= weekStart(now),
    ).length,
    latestTurn:
      saidRow === undefined ? null : { said: toMessage(saidRow), replies: replyRows.toReversed().map(toMessage) },
    olderTurns: saidRow === undefined ? 0 : Math.max(0, (turnRow?.value ?? 1) - 1),
    working: runRows.map(({ run, trigger, routineName, taskTitle }) => ({
      botId: run.botId === null ? null : BotId.parse(run.botId),
      title: runTitle({ isRoutine: run.isRoutine, routineName, trigger, taskTitle }),
      since: run.startedAt.toISOString(),
    })),
    pending: pendingItems({
      approvals: approvalRows,
      plans: planRows,
      drafts: draftRows,
      expiredAccounts: [],
      placeholders: [],
    }).slice(-50),
    plan:
      latestPlan === undefined
        ? null
        : { plan: toPlan(latestPlan, planDrafts), drafts: planDrafts.map((row) => toDraft(row)) },
    next:
      nextItems(
        draftRows,
        routineRows.filter((routine) => routine.enabled),
        now,
      )[0] ?? null,
    achievements: publicationRows.map(({ publication, draft }) => ({
      id: PublicationId.parse(publication.id),
      at: publication.publishedAt.toISOString(),
      title: draft === null ? "成果已发布" : draftTitle(draft),
      platform: publication.platform,
      url: publication.url,
    })),
    routines: routineRows.map((routine) => {
      const at = routine.enabled ? nextRoutineAt(routine, now) : null;
      return {
        routineId: RoutineId.parse(routine.id),
        botId: BotId.parse(routine.botId),
        name: routine.name,
        enabled: routine.enabled,
        nextAt: at === null ? null : at.toISOString(),
      };
    }),
  });
}
