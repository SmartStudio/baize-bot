import {
  BotId,
  GroupId,
  PokerHandId,
  PokerSessionId,
  type ComputerId,
  type ControlToAgent,
  type Message,
  type PokerReviewHand,
  type PokerTableView,
  type TablePrompt,
  type UserId,
} from "@baize/shared";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { sendHiddenRun } from "../agent/hidden-run.js";
import type { Db } from "../db/client.js";
import { bots, groupMembers, pokerHands, pokerSessions, pokerTables } from "../db/schema.js";
import { loadPokerTableView, USER_SEAT } from "../repo/poker-tables.js";
import { finishRun } from "../repo/runs.js";
import { pushMessages, type PokerDeps } from "./converge.js";
import { pickKeyHands } from "./keyhands.js";
import { engineSeatId } from "./seating.js";
import { hostMessage, loadHand, PokerError, withTableLock, type StoredHand } from "./store.js";
import { viewFor } from "./view.js";
import { toWire } from "./wire.js";

/** 运行器的 poker_review 工具另有一份同值的校验，两边各自把关。 */
export const REVIEW_TEXT_LIMIT = 120;
export const REVIEW_DONE_LINE = "散场了，复盘在项目页";
export const NO_SUCH_TABLE = "没有这张牌桌";

export type KeyHand = StoredHand & { readonly number: number; readonly delta: number };

function userDeltaOf(hand: StoredHand): number {
  const stackOf = (id: string) => hand.state.seats.find((seat) => seat.id === id)?.stack ?? 0;
  const startOf = hand.row.seatsStart.find((seat) => seat.seat === USER_SEAT)?.stack ?? 0;
  return stackOf(engineSeatId(USER_SEAT)) - startOf;
}

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
    submitted.every((hand) => hand.text.length <= REVIEW_TEXT_LIMIT)
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

type Dispatch = { computerId: ComputerId; message: Extract<ControlToAgent, { type: "prompt" }> };

/**
 * 散场：手进行中回 409（D33）；否则用 `ended_at IS NULL` 的条件更新结束这一场，再给老白派一条复盘 run。
 * 点了没反应或复盘没交上来的那一场（最近一场已散场但 review 还空）再点会重派；已经有复盘的再点什么都不做。
 * 复盘 run 在 run 表上一桌一条，重复点击撞唯一索引回 busy，所以同一场只会有一份复盘在路上。
 */
export async function leaveTable(deps: PokerDeps, ownerId: UserId, groupId: GroupId): Promise<PokerTableView> {
  const dispatches: Dispatch[] = [];
  const outcome = await withTableLock(deps.db, groupId, async (db, table) => {
    if (table.ownerId !== ownerId) throw new PokerError(404, NO_SUCH_TABLE);
    if (table.status === "in_hand") throw new PokerError(409, "这一手还没打完，打完再散场");

    const [closed] = await db
      .update(pokerSessions)
      .set({ endedAt: new Date() })
      .where(and(eq(pokerSessions.groupId, groupId), isNull(pokerSessions.endedAt)))
      .returning();
    if (closed)
      await db
        .update(pokerTables)
        .set({ version: sql`${pokerTables.version} + 1` })
        .where(eq(pokerTables.groupId, groupId));
    const [latest] = closed
      ? [closed]
      : await db
          .select()
          .from(pokerSessions)
          .where(and(eq(pokerSessions.groupId, groupId), isNotNull(pokerSessions.endedAt)))
          .orderBy(desc(pokerSessions.endedAt))
          .limit(1);
    if (!latest) throw new PokerError(409, "还没打过牌，没有要散的场");
    const changed = closed !== undefined;
    if (latest.review !== null) return { changed, messages: [] as Message[] };

    const picked = await keyHandsOf(db, latest.id);
    const last = picked.at(-1);
    if (last === undefined) {
      // 一手都没结算的场没有可复盘的，直接给空复盘；TablePrompt 要 handId，也派不出去。
      const [written] = await db
        .update(pokerSessions)
        .set({ review: { sessionId: PokerSessionId.parse(latest.id), hands: [] } })
        .where(and(eq(pokerSessions.id, latest.id), isNull(pokerSessions.review)))
        .returning({ id: pokerSessions.id });
      return {
        changed: changed || written !== undefined,
        messages: written ? [await hostMessage(db, table, REVIEW_DONE_LINE)] : [],
      };
    }
    const hostId = await hostBotOf(db, groupId);
    await sendHiddenRun(
      {
        db,
        agents: {
          isOnline: (id) => deps.agents.isOnline(id),
          configRejected: (id) => deps.agents.configRejected(id),
          // 外层事务提交后才发 prompt，避免重连对账看不到刚创建的 run。
          send: (computerId, message) => {
            if (!deps.agents.isOnline(computerId)) return false;
            if (message.type !== "prompt") throw new Error("隐藏派活只能发送 prompt");
            dispatches.push({ computerId, message });
            return true;
          },
        },
      },
      {
        botId: hostId,
        groupId,
        role: "reviewer",
        visibleTo: [{ kind: "bot", botId: hostId }],
        table: reviewPrompt(latest.id, last, picked),
      },
    );
    return { changed, messages: [] as Message[] };
  });
  if (outcome === null) throw new PokerError(404, NO_SUCH_TABLE);

  for (const dispatch of dispatches) {
    if (!deps.agents.send(dispatch.computerId, dispatch.message)) {
      await finishRun(
        deps.db,
        dispatch.message.runId,
        dispatch.message.groupId,
        { steps: 0, inputTokens: 0, outputTokens: 0, amount: 0 },
        "abandoned",
      );
    }
  }
  const view = await loadPokerTableView(deps.db, ownerId, groupId);
  if (view === null) throw new PokerError(404, NO_SUCH_TABLE);
  pushMessages(deps, ownerId, outcome.messages);
  if (outcome.changed) deps.push.push(ownerId, { type: "poker_table_updated", table: view });
  return view;
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
      view: toWire(viewFor(hand.state, engineSeatId(USER_SEAT))),
    })),
  };
}
