import {
  BotId,
  type GroupId,
  type Bot,
  type Group,
  type Message,
  type MessageBody,
  type MessageId,
  type TeamOfferMember,
  type TeamOfferStatus,
  type UserId,
} from "@baize/shared";
import { TransactionRollbackError, and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { bots, groupMembers, groups, messages } from "../db/schema.js";
import { insertMemberBot } from "./bots.js";
import { GROUP_BOT_LIMIT, appendGroupMembers, findGroup, findProjectGroupId, lockProjectMembers } from "./groups.js";
import { nextRevision, type Tx } from "./messages.js";
import { toBot, toMessage } from "./rows.js";

export type TeamOfferBody = Extract<MessageBody, { kind: "team_offer" }>;

export type TeamOfferMessage = {
  readonly id: MessageId;
  readonly groupId: string;
  readonly body: TeamOfferBody;
};

/** 建队卡只落在主助理的单聊里（events 那头把关），按归属人查到的就是自己的卡。别人的、不存在的、不是建队卡的都是 null。 */
export async function findOwnedTeamOffer(
  db: Db,
  ownerId: UserId,
  messageId: MessageId,
): Promise<TeamOfferMessage | null> {
  const [found] = await db
    .select({ row: messages })
    .from(messages)
    .innerJoin(groups, eq(groups.id, messages.groupId))
    .where(and(eq(messages.id, messageId), eq(groups.ownerId, ownerId)))
    .limit(1);
  if (found === undefined || found.row.body.kind !== "team_offer") return null;
  return { id: messageId, groupId: found.row.groupId, body: found.row.body };
}

/** 卡上 existing 那几行指的 Bot 是不是都是这个用户的。上行报文的 botId 是外部输入。 */
export async function ownsAllBots(db: Db | Tx, ownerId: UserId, botIds: readonly BotId[]): Promise<boolean> {
  const unique = [...new Set(botIds)];
  if (unique.length === 0) return true;
  const rows = await db
    .select({ id: bots.id })
    .from(bots)
    .where(and(eq(bots.ownerId, ownerId), inArray(bots.id, unique)));
  return rows.length === unique.length;
}

/**
 * 落卡前先锁住卡所依赖的 Bot：目标群的成员加上卡上的既有候选，只锁这个用户的，按 id 升序 FOR KEY SHARE。
 * 删 Bot 要拿这些行的排他锁，锁到手之后删除只能排在卡落下之后；锁之前已提交的删除，锁之后的新语句看得见。
 * 读成员和上锁之间成员可能被整批换掉（确认别的卡加人、再删原班人马），所以锁完重读：现在的成员里至少一个在锁里，
 * 目标在卡提交前就删不空；一个都不在就把前后两批并起来再锁一次重读，还不在就当目标没了。
 * 锁完再查目标是这个用户的项目群、候选都归他。先 Bot 行再群行，和确认、删 Bot 同向。
 * 回目标群 id，目标不成立或候选不归他就是 null。
 */
export async function lockOfferTarget(
  tx: Tx,
  ownerId: UserId,
  projectGroupId: GroupId,
  existingIds: readonly BotId[],
): Promise<GroupId | null> {
  const depended = new Set<string>(existingIds);
  let locked = new Set<string>();
  // 至多锁两回：先锁读到的那批，重读发现整批换了人，再把前后两批并起来锁一回。
  for (let round = 0; ; round += 1) {
    const members = await tx
      .select({ botId: groupMembers.botId })
      .from(groupMembers)
      .where(eq(groupMembers.groupId, projectGroupId));
    if (members.length === 0) return null;
    if (members.some((row) => locked.has(row.botId))) break;
    if (round === 2) return null;
    for (const row of members) depended.add(row.botId);
    const rows = await tx
      .select({ id: bots.id })
      .from(bots)
      .where(and(eq(bots.ownerId, ownerId), inArray(bots.id, [...depended])))
      .orderBy(asc(bots.id))
      .for("key share");
    locked = new Set(rows.map((row) => row.id));
  }
  const groupId = await findProjectGroupId(tx, ownerId, projectGroupId);
  if (groupId === null || !(await ownsAllBots(tx, ownerId, existingIds))) return null;
  return groupId;
}

export type DecideTeamOfferResult =
  | {
      readonly kind: "confirmed";
      readonly message: Message;
      readonly group: Group;
      /** 这次进群的人，按卡上的顺序。created 是其中新建的，带各自的单聊群。 */
      readonly added: readonly Bot[];
      readonly created: readonly { readonly bot: Bot; readonly groupId: GroupId }[];
    }
  | { readonly kind: "deferred"; readonly message: Message }
  | { readonly kind: "settled" }
  | { readonly kind: "bad_pick" }
  | { readonly kind: "too_many"; readonly total: number }
  /** 勾的已有 Bot 里有已经删掉的，positions 是它们在卡上从 1 数的位置：删了就读不到名字了。 */
  | { readonly kind: "member_gone"; readonly positions: readonly number[] }
  | { readonly kind: "project_gone" };

/** 还能确认的状态：先放着的卡还在等你确认。 */
const CONFIRMABLE: readonly TeamOfferStatus[] = ["offered", "deferred"];

/**
 * 确认或先放着。确认靠 `UPDATE ... WHERE status IN ('offered', 'deferred')` 抢这张卡：并发的第二次在行锁上等第一次提交，
 * 醒来时条件已经不成立，一行都改不到，什么都不建。超过上限、项目群不见了都回滚，卡留在原来的状态。
 */
export async function decideTeamOffer(
  db: Db,
  ownerId: UserId,
  offer: TeamOfferMessage,
  decision: { readonly decision: "confirm"; readonly picked: readonly number[] } | { readonly decision: "defer" },
): Promise<DecideTeamOfferResult> {
  if (decision.decision === "defer") {
    const message = await claimOffer(db, offer, { ...offer.body, status: "deferred" }, ["offered"]);
    if (message !== null) return { kind: "deferred", message };
    // 再点一次先放着回它现在的样子；已经确认过的卡不能再放回去。
    const current = await currentOffer(db, offer.id);
    return current.body.kind === "team_offer" && current.body.status === "deferred"
      ? { kind: "deferred", message: current }
      : { kind: "settled" };
  }

  const pickedIndexes = [...new Set(decision.picked)].toSorted((left, right) => left - right);
  const picked = pickedIndexes.map((index) => offer.body.members[index]);
  if (picked.length === 0 || !picked.every((member) => member !== undefined)) return { kind: "bad_pick" };

  type Rollback = Exclude<DecideTeamOfferResult, { kind: "confirmed" | "deferred" }>;
  // 回滚的原因从事务回调里带出来；用对象而不是 let，免得 TS 在 catch 里把它收窄成 null。
  const rolledBack: { reason: Rollback | null } = { reason: null };
  const projectGroupId = offer.body.groupId;
  try {
    const confirmed = await db.transaction(async (tx) => {
      const abort = (reason: Rollback): never => {
        rolledBack.reason = reason;
        return tx.rollback();
      };
      // 锁序：卡 → 勾选的已有 Bot（按 id 升序）→ 项目群 → 发号器。删 Bot 是先 Bot 行再级联到它当首席的群行，
      // 和这里同向；先锁群再等 Bot 会和两个项目互邀对方首席、同时删两个首席凑成四方死锁。
      if ((await claimOffer(tx, offer, { ...offer.body, status: "confirmed" }, CONFIRMABLE)) === null) {
        return abort({ kind: "settled" });
      }
      const existingIds = [...new Set(picked.flatMap((member) => (member.kind === "existing" ? [member.botId] : [])))];
      const alive = await lockPickedBots(tx, ownerId, existingIds);
      const positions = pickedIndexes.filter((index, at) => {
        const member = picked[at];
        return member?.kind === "existing" && !alive.has(member.botId);
      });
      if (positions.length > 0) return abort({ kind: "member_gone", positions: positions.map((index) => index + 1) });

      // 成员名单要在群锁到手之后读，前一次加人提交了才看得见。
      const team = await lockProjectMembers(tx, ownerId, projectGroupId);
      if (team === null) return abort({ kind: "project_gone" });
      const present = new Set<BotId>(team.botIds);
      const joining = existingIds.filter((id) => !present.has(id));
      const newcomers = picked.filter((member) => member.kind === "new");
      const total = team.botIds.length + joining.length + newcomers.length;
      if (total > GROUP_BOT_LIMIT) return abort({ kind: "too_many", total });

      // 新人和已有的 Bot 或彼此重名就自动换个名字，否则同一个群里两个「小研」，@ 永远只认得第一个。
      const toAdd = new Set(joining);
      const created: { bot: Bot; groupId: GroupId }[] = [];
      const added: Bot[] = [];
      const finalMembers: TeamOfferMember[] = [];
      for (const member of picked) {
        if (member.kind === "existing") {
          const bot = alive.get(member.botId);
          if (bot !== undefined && toAdd.delete(member.botId)) added.push(bot);
          finalMembers.push(member);
          continue;
        }
        const made = await insertMemberBot(
          tx,
          ownerId,
          { name: member.name, tags: member.tags, description: member.description },
          "untaken",
        );
        created.push({ bot: made.bot, groupId: made.group.id });
        added.push(made.bot);
        finalMembers.push({ ...member, name: made.bot.name });
      }
      await appendGroupMembers(
        tx,
        projectGroupId,
        added.map((bot) => bot.id),
        team.nextPosition,
      );
      // 卡上只留确认进来的人，新人换成实际建出来的名字，正文是这张卡唯一的一份。
      const message = await rewriteOffer(tx, offer.id, { ...offer.body, status: "confirmed", members: finalMembers });
      const detail = await findGroup(tx, ownerId, projectGroupId);
      if (detail === null) return abort({ kind: "project_gone" });
      return { message, added, created, group: detail.group };
    });
    return { kind: "confirmed", ...confirmed };
  } catch (error) {
    if (error instanceof TransactionRollbackError && rolledBack.reason !== null) return rolledBack.reason;
    throw error;
  }
}

/**
 * 勾选的已有 Bot 全部按 id 升序上 FOR KEY SHARE，锁到提交，已经在群里的也锁：删 Bot 的 DELETE 等这次提交了再删，
 * 入群不会撞外键，写进终态正文的人在提交那一刻也都还在群里。已经删掉的不在返回里。
 */
async function lockPickedBots(tx: Tx, ownerId: UserId, botIds: readonly BotId[]): Promise<Map<BotId, Bot>> {
  if (botIds.length === 0) return new Map();
  const rows = await tx
    .select()
    .from(bots)
    .where(and(eq(bots.ownerId, ownerId), inArray(bots.id, [...botIds])))
    .orderBy(asc(bots.id))
    .for("key share");
  return new Map(rows.map((row) => [BotId.parse(row.id), toBot(row)]));
}

/** 只改还在 from 这几种状态里的那一条，改不动就是已经有人点过了。 */
async function claimOffer(
  db: Db | Tx,
  offer: TeamOfferMessage,
  body: TeamOfferBody,
  from: readonly TeamOfferStatus[],
): Promise<Message | null> {
  const [row] = await db
    .update(messages)
    .set({ body, revision: nextRevision() })
    .where(
      and(
        eq(messages.id, offer.id),
        eq(messages.groupId, offer.groupId),
        inArray(sql<string>`${messages.body} ->> 'status'`, [...from]),
      ),
    )
    .returning();
  return row === undefined ? null : toMessage(row);
}

/** 抢到卡之后在同一个事务里改写正文，行锁还在手里。 */
async function rewriteOffer(tx: Tx, id: MessageId, body: TeamOfferBody): Promise<Message> {
  const [row] = await tx
    .update(messages)
    .set({ body, revision: nextRevision() })
    .where(eq(messages.id, id))
    .returning();
  if (row === undefined) throw new Error(`建队卡 ${id} 抢到之后不见了`);
  return toMessage(row);
}

async function currentOffer(db: Db, id: MessageId): Promise<Message> {
  const [row] = await db.select().from(messages).where(eq(messages.id, id)).limit(1);
  if (row === undefined) throw new Error(`建队卡 ${id} 点完就不见了`);
  return toMessage(row);
}
