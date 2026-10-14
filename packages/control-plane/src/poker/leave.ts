import {
  BotId,
  GroupId,
  POKER_REVIEW_TEXT_LIMIT,
  POKER_USER_SEAT,
  PokerHandId,
  PokerSessionId,
  type ComputerId,
  type Message,
  type PokerReviewHand,
  type PokerTableView,
  type TablePrompt,
  type UserId,
} from "@baize/shared";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { sendHiddenRun, type HiddenRunOutcome } from "../agent/hidden-run.js";
import type { Db } from "../db/client.js";
import { bots, groupMembers, pokerHands, pokerSessions, pokerTables } from "../db/schema.js";
import { loadPokerTableView } from "../repo/poker-tables.js";
import { pushMessages, type PokerDeps } from "./converge.js";
import { pickKeyHands } from "./keyhands.js";
import { engineSeatId } from "./seating.js";
import {
  hostMessage,
  loadHand,
  PokerError,
  userDeltaOf,
  withTableLock,
  type StoredHand,
  type TableRow,
} from "./store.js";
import { viewFor } from "./view.js";
import { toWire } from "./wire.js";

export const REVIEW_DONE_LINE = "散场了，复盘在项目页";
export const NO_SUCH_TABLE = "没有这张牌桌";

export type KeyHand = StoredHand & { readonly number: number; readonly delta: number };

/** 这一场里用户筹码变化最大的几手，最多三手、按手序排。只看已结算的手。 */
export async function keyHandsOf(db: Db, sessionId: string): Promise<KeyHand[]> {
  const rows = await db
    .select({ id: pokerHands.id })
    .from(pokerHands)
    .where(and(eq(pokerHands.sessionId, sessionId), eq(pokerHands.status, "complete")));
  const hands: KeyHand[] = [];
  for (const { id } of rows) {
    const hand = await loadHand(db, id);
    if (hand) hands.push({ ...hand, number: hand.row.number, delta: userDeltaOf(hand) });
  }
  return pickKeyHands(hands);
}

/** 老白交上来的复盘要和给他的关键手一一对上：不多不少，序号不重，每手正文不超限。 */
export function answersKeyHands(submitted: readonly PokerReviewHand[], numbers: readonly number[]): boolean {
  const given = submitted.map((hand) => hand.number);
  return (
    new Set(given).size === given.length &&
    given.length === numbers.length &&
    numbers.every((number) => given.includes(number)) &&
    submitted.every((hand) => hand.text.length <= POKER_REVIEW_TEXT_LIMIT)
  );
}

function titleOf(delta: number): string {
  if (delta > 0) return `你赢了 ${delta}`;
  if (delta < 0) return `你输了 ${-delta}`;
  return "不输不赢";
}

async function hostBotOf(db: Db, groupId: string) {
  const [host] = await db
    .select({ id: bots.id })
    .from(groupMembers)
    .innerJoin(bots, eq(bots.id, groupMembers.botId))
    .where(and(eq(groupMembers.groupId, groupId), eq(bots.preset, "laobai")));
  if (!host) throw new Error("牌桌没有老白");
  return BotId.parse(host.id);
}

type SessionRow = typeof pokerSessions.$inferSelect;
type ReviewOutcome =
  | { readonly kind: "written"; readonly message: Message }
  | { readonly kind: "dispatched"; readonly sent: HiddenRunOutcome };

async function latestEndedSession(db: Db, groupId: GroupId): Promise<SessionRow | undefined> {
  const [latest] = await db
    .select()
    .from(pokerSessions)
    .where(and(eq(pokerSessions.groupId, groupId), isNotNull(pokerSessions.endedAt)))
    .orderBy(desc(pokerSessions.endedAt))
    .limit(1);
  return latest;
}

async function bumpVersion(db: Db, groupId: GroupId): Promise<void> {
  await db
    .update(pokerTables)
    .set({ version: sql`${pokerTables.version} + 1` })
    .where(eq(pokerTables.groupId, groupId));
}

/**
 * 给一场还没有复盘的散场派复盘。一手都没结算的场没有可复盘的，直接写空复盘；否则给老白派一条 reviewer run。
 * 复盘 run 在 run 表上一桌一条开着的，重复派撞唯一索引回 busy，所以同一场只会有一份复盘在路上。
 * prompt 入外层事务的发件箱，提交后由调用方 flush。
 */
async function dispatchReview(
  deps: PokerDeps,
  db: Db,
  table: TableRow,
  session: SessionRow,
  dispatches: ComputerId[],
): Promise<ReviewOutcome | null> {
  const picked = await keyHandsOf(db, session.id);
  const last = picked.at(-1);
  if (last === undefined) {
    const [written] = await db
      .update(pokerSessions)
      .set({ review: { sessionId: PokerSessionId.parse(session.id), hands: [] } })
      .where(and(eq(pokerSessions.id, session.id), isNull(pokerSessions.review)))
      .returning({ id: pokerSessions.id });
    return written ? { kind: "written", message: await hostMessage(db, table, REVIEW_DONE_LINE) } : null;
  }
  const groupId = GroupId.parse(table.groupId);
  const hostId = await hostBotOf(db, groupId);
  const sent = await sendHiddenRun(
    {
      db,
      agents: {
        isOnline: (id) => deps.agents.isOnline(id),
        configRejected: (id) => deps.agents.configRejected(id),
        canDeliver: (id) => deps.agents.canDeliver(id),
        // withTableLock 的外层事务提交后再 flush。
        flushOutbox: async (computerId) => {
          dispatches.push(computerId);
        },
      },
    },
    {
      botId: hostId,
      groupId,
      role: "reviewer",
      visibleTo: [{ kind: "bot", botId: hostId }],
      table: reviewPrompt(session.id, last, picked),
    },
  );
  return { kind: "dispatched", sent };
}

/** 事务提交后 flush 可靠下行。 */
async function sendDispatches(deps: PokerDeps, dispatches: readonly ComputerId[]): Promise<void> {
  for (const computerId of dispatches) await deps.agents.flushOutbox(computerId);
}

type Outcome = { readonly changed: boolean; readonly messages: readonly Message[] };

async function finishWithView(
  deps: PokerDeps,
  ownerId: UserId,
  groupId: GroupId,
  outcome: Outcome | null,
  dispatches: readonly ComputerId[],
): Promise<PokerTableView> {
  if (outcome === null) throw new PokerError(404, NO_SUCH_TABLE);
  await sendDispatches(deps, dispatches);
  const view = await loadPokerTableView(deps.db, ownerId, groupId);
  if (view === null) throw new PokerError(404, NO_SUCH_TABLE);
  pushMessages(deps, ownerId, [...outcome.messages]);
  if (outcome.changed) deps.push.push(ownerId, { type: "poker_table_updated", table: view });
  return view;
}

/**
 * 散场：手进行中回 409（D33）；否则用 `ended_at IS NULL` 的条件更新结束这一场，再给老白派一条复盘 run。
 * 点了没反应或复盘没交上来的那一场（最近一场已散场但 review 还空）再点会重派；已经有复盘的再点什么都不做。
 */
export async function leaveTable(deps: PokerDeps, ownerId: UserId, groupId: GroupId): Promise<PokerTableView> {
  const dispatches: ComputerId[] = [];
  const outcome = await withTableLock(deps.db, groupId, async (db, table): Promise<Outcome> => {
    if (table.ownerId !== ownerId) throw new PokerError(404, NO_SUCH_TABLE);
    if (table.status === "in_hand") throw new PokerError(409, "这一手还没打完，打完再散场");

    const [closed] = await db
      .update(pokerSessions)
      .set({ endedAt: new Date() })
      .where(and(eq(pokerSessions.groupId, groupId), isNull(pokerSessions.endedAt)))
      .returning();
    if (closed) await bumpVersion(db, groupId);
    const latest = closed ?? (await latestEndedSession(db, groupId));
    if (!latest) throw new PokerError(409, "还没打过牌，没有要散的场");
    const changed = closed !== undefined;
    if (latest.review !== null) return { changed, messages: [] };

    const review = await dispatchReview(deps, db, table, latest, dispatches);
    if (review?.kind === "written") return { changed: true, messages: [review.message] };
    return { changed, messages: [] };
  });
  return finishWithView(deps, ownerId, groupId, outcome, dispatches);
}

/**
 * 重试复盘：只认最近一场已散场的场次，用户开了新一场也能给上一场补派。
 * 复盘已经落了什么都不做；老白还在写（reviewer run 开着）就回现状；没有电脑在线派不出去回 409。
 * 幂等靠 reviewer run 的唯一索引和 `review IS NULL` 的条件更新，不先查后写。
 */
export async function retryReview(
  deps: PokerDeps,
  ownerId: UserId,
  groupId: GroupId,
  sessionId: PokerSessionId,
): Promise<PokerTableView> {
  const dispatches: ComputerId[] = [];
  const outcome = await withTableLock(deps.db, groupId, async (db, table): Promise<Outcome> => {
    if (table.ownerId !== ownerId) throw new PokerError(404, NO_SUCH_TABLE);
    const latest = await latestEndedSession(db, groupId);
    if (!latest || latest.id !== sessionId) throw new PokerError(409, "只能重试最近一场的复盘");
    if (latest.review !== null) return { changed: false, messages: [] };

    const review = await dispatchReview(deps, db, table, latest, dispatches);
    if (review?.kind === "written") return { changed: true, messages: [review.message] };
    if (review?.kind !== "dispatched") return { changed: false, messages: [] };
    if (review.sent.kind === "unplaced" || review.sent.kind === "skipped")
      throw new PokerError(409, "没有电脑在线，复盘派不出去");
    const changed = review.sent.kind === "sent";
    if (changed) await bumpVersion(db, groupId);
    return { changed, messages: [] };
  });
  return finishWithView(deps, ownerId, groupId, outcome, dispatches);
}

/** 复盘 prompt 只带用户视角：用户的底牌、公开事件、摊牌亮出来的牌；没有种子，没有别人没亮的牌。 */
function reviewPrompt(sessionId: string, last: KeyHand, picked: readonly KeyHand[]): Omit<TablePrompt, "role"> {
  return {
    sessionId: PokerSessionId.parse(sessionId),
    handId: PokerHandId.parse(last.row.id),
    seq: 0,
    view: null,
    publicLog: [],
    question: null,
    review: picked.map((hand) => ({
      number: hand.number,
      title: titleOf(hand.delta),
      userDelta: hand.delta,
      view: toWire(viewFor(hand.state, engineSeatId(POKER_USER_SEAT))),
    })),
  };
}
