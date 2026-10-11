import type { BotId, GroupId, Message, MessageId, RunId, Viewer } from "@baize/shared";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { messages, runs } from "../db/schema.js";
import { messageVisibleTo, type Tx } from "./messages.js";
import { toMessage } from "./rows.js";

export interface PromptContextRecord {
  /** 这次 prompt 上下文里读到时没定稿的行。等 confirmContext 之后它才参与下一次派活接着送的名单。 */
  readonly unsettled: readonly MessageId[];
  /** 这次 prompt 上下文里读到时已定稿的行。确认之后，这些行从此不再是候选：模型已经看过结论。 */
  readonly settled: readonly MessageId[];
}

export async function recordContext(db: Db, runId: RunId, viewer: Viewer, record: PromptContextRecord): Promise<void> {
  const ids = [...record.unsettled, ...record.settled];
  const visible =
    ids.length === 0
      ? []
      : await db
          .select({ id: messages.id })
          .from(messages)
          .innerJoin(runs, and(eq(runs.id, runId), eq(runs.groupId, messages.groupId)))
          .where(and(inArray(messages.id, ids), messageVisibleTo(viewer)));
  const allowed = new Set(visible.map(({ id }) => id));
  await db
    .update(runs)
    .set({
      unsettledContext: record.unsettled.filter((id) => allowed.has(id)),
      settledContext: record.settled.filter((id) => allowed.has(id)),
    })
    .where(eq(runs.id, runId));
}

/** 运行器报这次 run 的触发消息进了会话，它那份名单生效。用库时钟，窗口按它排，几台控制面的应用时钟不齐也不乱序。 */
export async function confirmContext(db: Db | Tx, runId: RunId): Promise<void> {
  await db
    .update(runs)
    .set({ contextConfirmedAt: sql`clock_timestamp()` })
    .where(eq(runs.id, runId));
}

/**
 * 往回看几份最近确认的名单。一份名单的寿命从它被确认算起，不从建 run 算起：派活建完 run 之后可能隔一阵才送出去
 * （主助理送之前还要读项目清单），这期间别的 run 已经建了又确认了，按建 run 的时刻往回数，这份名单刚确认就落在
 * 窗口外，它记下的卡从此没人接。按确认时刻数，每份名单都能撑过后面这么多次确认。
 * 还没定稿的行每次派活都接着送、接着记，所以它一直在最近几份名单里，不用翻全部历史；超出 CONTEXT_CATCHUP
 * 不再送的行，过了这么多次确认以后就不再占内存。
 */
const CONFIRMED_RUNS_CONSIDERED = 20;

/**
 * 这个 Bot 在这个群里，确认过的 run 读到时没定稿、之后也没有哪次确认过的 run 读到它定稿的行，按消息顺序。
 * 名单取并集而不是挑「最新的一份」：派活交错、交接延后时，各 run 读到的消息集合互不包含（触发更早的 run
 * 可能接回了别的 run 的卡，触发更晚的 run 窗口里却没有它），按任何一个序号挑一份都会把别的名单里的卡盖掉。
 * 定稿是终态，所以减法不看先后：哪次读到过定稿的字，模型就看过结论了。
 * 没进会话、被收尾、还在跑的 run 都不算；一次都没确认过就是空。
 */
export async function pendingLines(db: Db, groupId: GroupId, botId: BotId, viewer: Viewer): Promise<Message[]> {
  const recent = await db
    .select({ unsettled: runs.unsettledContext, settled: runs.settledContext })
    .from(runs)
    .where(and(eq(runs.groupId, groupId), eq(runs.botId, botId), isNotNull(runs.contextConfirmedAt)))
    .orderBy(desc(runs.contextConfirmedAt), desc(runs.startedAt))
    .limit(CONFIRMED_RUNS_CONSIDERED);
  const seen = new Set(recent.flatMap((run) => run.settled ?? []));
  const ids = [...new Set(recent.flatMap((run) => run.unsettled ?? []))].filter((id) => !seen.has(id));
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.groupId, groupId), inArray(messages.id, ids), messageVisibleTo(viewer)))
    .orderBy(asc(messages.seq));
  return rows.map(toMessage);
}
