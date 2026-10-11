import { GroupId, PokerSessionId, type AgentToControl } from "@baize/shared";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { pokerSessions, pokerTables, runs } from "../../db/schema.js";
import { pushMessages } from "../../poker/converge.js";
import { answersKeyHands, keyHandsOf, REVIEW_DONE_LINE } from "../../poker/leave.js";
import { hostMessage, withTableLock } from "../../poker/store.js";
import { loadPokerTableView } from "../../repo/poker-tables.js";
import type { AgentEventDeps } from "../events.js";
import type { AgentConnection } from "../hub.js";

export type PokerReviewEvent = Extract<AgentToControl, { type: "poker_review" }>;

/**
 * 老白交复盘。run 要是这台电脑上、这张桌还没收尾的 reviewer run，session 要是这张桌已散场的一场，
 * 手要和控制面自己挑出的关键手一一对上，任一不成立整条丢掉（运行器那边没有回执，错了让用户再点散场）。
 * 写入靠 `review IS NULL` 的条件更新：同一场重复交只有第一份落库，老白的收尾话也只说一次。
 */
export async function handlePokerReview(
  deps: AgentEventDeps,
  conn: AgentConnection,
  event: PokerReviewEvent,
): Promise<void> {
  const [run] = await deps.db.select().from(runs).where(eq(runs.id, event.runId));
  if (!run?.groupId || run.computerId !== conn.computerId || run.tableRole !== "reviewer" || run.endedAt !== null)
    return;
  const groupId = run.groupId;

  const outcome = await withTableLock(deps.db, groupId, async (db, table) => {
    if (table.ownerId !== conn.ownerId) return null;
    const [session] = await db
      .select()
      .from(pokerSessions)
      .where(
        and(
          eq(pokerSessions.id, event.sessionId),
          eq(pokerSessions.groupId, table.groupId),
          isNotNull(pokerSessions.endedAt),
        ),
      );
    if (!session) return null;
    const numbers = (await keyHandsOf(db, session.id)).map((hand) => hand.number);
    if (!answersKeyHands(event.hands, numbers)) return null;
    const hands = numbers.flatMap((number) => event.hands.filter((hand) => hand.number === number));

    const [written] = await db
      .update(pokerSessions)
      .set({ review: { sessionId: PokerSessionId.parse(session.id), hands } })
      .where(and(eq(pokerSessions.id, session.id), isNull(pokerSessions.review)))
      .returning({ id: pokerSessions.id });
    if (!written) return null;
    await db
      .update(pokerTables)
      .set({ version: sql`${pokerTables.version} + 1` })
      .where(eq(pokerTables.groupId, table.groupId));
    return { ownerId: table.ownerId, message: await hostMessage(db, table, REVIEW_DONE_LINE) };
  });
  if (!outcome) return;

  pushMessages(deps, outcome.ownerId, [outcome.message]);
  const view = await loadPokerTableView(deps.db, conn.ownerId, GroupId.parse(groupId));
  if (view) deps.push.push(conn.ownerId, { type: "poker_table_updated", table: view });
}
