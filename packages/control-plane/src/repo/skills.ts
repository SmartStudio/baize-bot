import { SkillId, UserId, type BotId, type Message, type MessageId, type Skill } from "@baize/shared";
import { TransactionRollbackError, and, asc, eq, inArray, sql } from "drizzle-orm";
import { parseSkillRefs } from "../agent/routing.js";
import type { Db } from "../db/client.js";
import { bots, groupMembers, groups, messages, skills } from "../db/schema.js";
import { newId } from "../ids.js";
import type { SkillOfferBody, Tx } from "./messages.js";
import { toMessage, toSkill } from "./rows.js";

export type SkillRow = typeof skills.$inferSelect;
type SkillSource = SkillRow["source"];

/**
 * 同一 Bot 下名字撞了。判的是 SQLSTATE 不是错误消息文本：文本跟着索引名和服务端的语言走，
 * 换个 locale 就对不上了，SQLSTATE 是标准里定死的。
 */
function isNameTaken(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "23505";
}

/** skill 按归属人过滤。别人的在这里查不到，路由层因此返回 404 而不是 403。 */
export async function findOwnedSkill(db: Db, ownerId: UserId, skillId: SkillId): Promise<SkillRow | null> {
  const [found] = await db
    .select({ row: skills })
    .from(skills)
    .innerJoin(bots, eq(bots.id, skills.botId))
    .where(and(eq(skills.id, skillId), eq(bots.ownerId, ownerId)))
    .limit(1);
  return found?.row ?? null;
}

/** created_at 在同一事务里会撞，所以再拿 id 兜一道，顺序因此稳定可断言。 */
export async function listSkills(db: Db, botId: BotId): Promise<Skill[]> {
  const rows = await db
    .select()
    .from(skills)
    .where(eq(skills.botId, botId))
    .orderBy(asc(skills.createdAt), asc(skills.id));
  return rows.map(toSkill);
}

/** 这个用户全部 Bot 的 skill。`config.skills` 要这一份，运行器拿到后按 botId 分开落盘。 */
export async function listSkillsByOwner(db: Db, ownerId: UserId): Promise<Skill[]> {
  const rows = await db
    .select({ row: skills })
    .from(skills)
    .innerJoin(bots, eq(bots.id, skills.botId))
    .where(eq(bots.ownerId, ownerId))
    .orderBy(asc(skills.botId), asc(skills.createdAt), asc(skills.id));
  return rows.map((found) => toSkill(found.row));
}

export type SkillInput = {
  readonly name: string;
  readonly steps: readonly string[];
  readonly source: SkillSource;
};

/** 撞名返回 null。靠唯一索引判，不先查后写：先查后写挡不住并发的两个同名请求。 */
export async function createSkill(db: Db, botId: BotId, input: SkillInput): Promise<Skill | null> {
  const [row] = await db
    .insert(skills)
    .values({ id: SkillId.parse(newId()), botId, name: input.name, steps: [...input.steps], source: input.source })
    .onConflictDoNothing({ target: [skills.botId, skills.name] })
    .returning();
  return row === undefined ? null : toSkill(row);
}

/** `UpdateSkillRequest` 解出来的样子：没给的字段是 undefined，不是缺席。 */
export type SkillUpdate = { readonly name?: string | undefined; readonly steps?: readonly string[] | undefined };

export type UpdateSkillResult =
  { readonly kind: "ok"; readonly skill: Skill } | { readonly kind: "name_taken" } | { readonly kind: "gone" };

/**
 * 给到的字段整份替换，steps 给了就是整份替换。一个字段都没给就回当前这一行。
 * 改名撞上唯一索引是用户能打出来的输入，不是服务端出错，所以接住它翻成 `name_taken` 而不是让 500 冒上去。
 */
export async function updateSkill(db: Db, skillId: SkillId, patch: SkillUpdate): Promise<UpdateSkillResult> {
  const values: Partial<typeof skills.$inferInsert> = {};
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.steps !== undefined) values.steps = [...patch.steps];

  if (Object.keys(values).length === 0) {
    const [row] = await db.select().from(skills).where(eq(skills.id, skillId)).limit(1);
    return row === undefined ? { kind: "gone" } : { kind: "ok", skill: toSkill(row) };
  }

  let updated: SkillRow | undefined;
  try {
    [updated] = await db.update(skills).set(values).where(eq(skills.id, skillId)).returning();
  } catch (error) {
    if (isNameTaken(error)) return { kind: "name_taken" };
    throw error;
  }
  return updated === undefined ? { kind: "gone" } : { kind: "ok", skill: toSkill(updated) };
}

export async function deleteSkill(db: Db, skillId: SkillId): Promise<boolean> {
  const deleted = await db.delete(skills).where(eq(skills.id, skillId)).returning({ id: skills.id });
  return deleted.length > 0;
}

/**
 * 复制给同一个用户的另一个 Bot。来源保留：这件活当初是教的还是对话里攒的，换个 Bot 做不改变它的出身。
 * 用量归零，那是这一条自己的账。目标已有同名返回 null，和建一条撞名走同一道唯一索引。
 */
export async function copySkill(db: Db, source: SkillRow, targetBotId: BotId): Promise<Skill | null> {
  return createSkill(db, targetBotId, { name: source.name, steps: source.steps, source: source.source });
}

/**
 * 正文里 `/名` 引到的 skill 各加一次用量，回加过的那些。
 * 一条都没引到就一条 UPDATE 都不发：群里绝大多数消息不带 `/`。
 */
export async function bumpSkillUses(db: Db, groupId: string, text: string): Promise<Skill[]> {
  // 按成员展示顺序排，同一个 Bot 内按建的先后。重名时认在前面的那一条，这个顺序就是「在前面」的定义。
  const candidates = await db
    .select({ id: skills.id, name: skills.name })
    .from(skills)
    .innerJoin(groupMembers, eq(groupMembers.botId, skills.botId))
    .where(eq(groupMembers.groupId, groupId))
    .orderBy(asc(groupMembers.position), asc(skills.createdAt), asc(skills.id));

  const hits = parseSkillRefs(
    text,
    candidates.map((row) => ({ id: SkillId.parse(row.id), name: row.name })),
  );
  if (hits.length === 0) return [];

  const bumped = await db
    .update(skills)
    .set({ useCount: sql`${skills.useCount} + 1` })
    .where(inArray(skills.id, hits))
    .returning();
  // RETURNING 的行序由库说了算，按命中顺序理一遍，推给客户端的次序因此和正文里出现的次序一致。
  const byId = new Map(bumped.map((row) => [row.id, toSkill(row)]));
  return hits.flatMap((id) => {
    const skill = byId.get(id);
    return skill === undefined ? [] : [skill];
  });
}

export type SkillOfferMessage = {
  readonly id: MessageId;
  readonly groupId: string;
  readonly body: SkillOfferBody;
  /** 上行那一刻判出来的来源。M10 之前落的卡没有这一列，点存时按对话算。 */
  readonly source: SkillSource | null;
};

/**
 * 群里那张 skill_offer 卡，按归属人过滤。别人的、不存在的、正文不是这张卡的，都返回 null，
 * 路由层一律 404：不是这张卡的消息和不存在的消息，对调用方来说是同一件事。
 */
export async function findOwnedSkillOfferMessage(
  db: Db,
  ownerId: UserId,
  messageId: MessageId,
): Promise<SkillOfferMessage | null> {
  const [found] = await db
    .select({ row: messages })
    .from(messages)
    .innerJoin(groups, eq(groups.id, messages.groupId))
    .where(and(eq(messages.id, messageId), eq(groups.ownerId, ownerId)))
    .limit(1);
  if (found === undefined || found.row.body.kind !== "skill_offer") return null;
  return {
    id: messageId,
    groupId: found.row.groupId,
    body: found.row.body,
    source: found.row.skillOfferSource,
  };
}

export type DecideSkillOfferResult =
  | { readonly kind: "ok"; readonly message: Message; readonly skill: Skill | null }
  | { readonly kind: "already_decided" }
  | { readonly kind: "name_taken" }
  | { readonly kind: "bot_gone" };

/**
 * 用户在群里点了「存」或「不存」。
 *
 * 两边都靠同一条带 `body->>'status' = 'offered'` 的条件 UPDATE 做幂等，不先查后写：
 * 两个并发的点存只有一个改得动那条消息，另一个看到 0 行。
 */
export async function decideSkillOffer(
  db: Db,
  ownerId: UserId,
  offer: SkillOfferMessage,
  decision: "save" | "dismiss",
): Promise<DecideSkillOfferResult> {
  if (decision === "dismiss") {
    const message = await settleOffer(db, offer, { ...offer.body, status: "dismissed" });
    return message === null ? { kind: "already_decided" } : { kind: "ok", message, skill: null };
  }

  // 卡上那个 Bot 可能已经被删了，正文里的 botId 是当初落卡时的。插 skills 行会撞外键，所以先看它还在不在。
  const [bot] = await db
    .select({ id: bots.id })
    .from(bots)
    .where(and(eq(bots.id, offer.body.botId), eq(bots.ownerId, ownerId)))
    .limit(1);
  if (bot === undefined) return { kind: "bot_gone" };

  const skillId = SkillId.parse(newId());
  // 两处失败都要整条回滚（撞名时卡必须留在 offered 让用户先改名），而 `tx.rollback()` 抛的是同一种错，
  // 所以把是谁回滚的记在这里，外层照着它翻状态码。
  let failure: "name_taken" | "already_decided" | null = null;
  try {
    return await db.transaction(async (tx): Promise<DecideSkillOfferResult> => {
      const [row] = await tx
        .insert(skills)
        .values({
          id: skillId,
          botId: offer.body.botId,
          name: offer.body.name,
          steps: [...offer.body.steps],
          source: offer.source ?? "chat",
        })
        .onConflictDoNothing({ target: [skills.botId, skills.name] })
        .returning();
      if (row === undefined) {
        failure = "name_taken";
        return tx.rollback();
      }

      const message = await settleOffer(tx, offer, { ...offer.body, status: "saved", skillId });
      if (message === null) {
        failure = "already_decided";
        return tx.rollback();
      }
      return { kind: "ok", message, skill: toSkill(row) };
    });
  } catch (error) {
    if (error instanceof TransactionRollbackError && failure !== null) return { kind: failure };
    throw error;
  }
}

/** 只改还挂在 offered 的那一条。改不动就是别人已经点过了。 */
async function settleOffer(db: Db | Tx, offer: SkillOfferMessage, body: SkillOfferBody): Promise<Message | null> {
  const [row] = await db
    .update(messages)
    .set({ body })
    .where(
      and(
        eq(messages.id, offer.id),
        eq(messages.groupId, offer.groupId),
        sql`${messages.body} ->> 'status' = 'offered'`,
      ),
    )
    .returning();
  return row === undefined ? null : toMessage(row);
}
