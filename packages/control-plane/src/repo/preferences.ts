import { BotId, Preference, PreferenceId, type GroupId, type MessageId, type UserId } from "@baize/shared";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { botPreferences, bots, messages } from "../db/schema.js";
import { newId } from "../ids.js";
import type { Tx } from "./messages.js";

function toPreference(row: typeof botPreferences.$inferSelect): Preference {
  return Preference.parse({
    id: row.id,
    botId: row.botId,
    text: row.text,
    sourceMessageId: row.sourceMessageId,
    private: row.private,
    createdAt: row.createdAt.toISOString(),
  });
}

/** 按 id 改、删都套这层：别人的 Bot 不在子查询里，碰不到别人的行，路由层回 404。 */
function ownedPreference(db: Db, ownerId: UserId, preferenceId: PreferenceId) {
  const owned = db.select({ id: bots.id }).from(bots).where(eq(bots.ownerId, ownerId));
  return and(eq(botPreferences.id, preferenceId), inArray(botPreferences.botId, owned));
}

/** created_at 在同一事务里会撞，再拿 id 兜一道，顺序稳定可断言。 */
export async function listPreferences(db: Db, botId: BotId): Promise<Preference[]> {
  const rows = await db
    .select()
    .from(botPreferences)
    .where(eq(botPreferences.botId, botId))
    .orderBy(asc(botPreferences.createdAt), asc(botPreferences.id));
  return rows.map(toPreference);
}

/**
 * 随 config 下发的偏好：该用户全部 Bot 的，私人的也在里面。私人只管分享时默认不勾，Bot 写作时照样要套用。
 * 数组恒带，运行器靠整份对账。
 */
export async function listPreferencesForConfig(db: Db, ownerId: UserId): Promise<Preference[]> {
  const rows = await db
    .select({ row: botPreferences })
    .from(botPreferences)
    .innerJoin(bots, eq(bots.id, botPreferences.botId))
    .where(eq(bots.ownerId, ownerId))
    .orderBy(asc(botPreferences.botId), asc(botPreferences.createdAt), asc(botPreferences.id));
  return rows.map((found) => toPreference(found.row));
}

export type PreferenceInput = {
  readonly botId: BotId;
  readonly groupId: GroupId;
  readonly text: string;
  readonly private: boolean;
  readonly sourceMessageId: MessageId | null;
};

/** 来源消息是电脑报上来的外部输入，外键只保证它存在，不在这个群里的记成 null。 */
export async function addPreference(tx: Tx, input: PreferenceInput): Promise<Preference> {
  const [source] =
    input.sourceMessageId === null
      ? []
      : await tx
          .select({ id: messages.id })
          .from(messages)
          .where(and(eq(messages.id, input.sourceMessageId), eq(messages.groupId, input.groupId)))
          .limit(1);
  const [row] = await tx
    .insert(botPreferences)
    .values({
      id: PreferenceId.parse(newId()),
      botId: input.botId,
      text: input.text,
      private: input.private,
      sourceMessageId: source?.id ?? null,
    })
    .returning();
  if (row === undefined) throw new Error("记偏好没有返回行");
  return toPreference(row);
}

export async function setPreferencePrivate(
  db: Db,
  ownerId: UserId,
  preferenceId: PreferenceId,
  value: boolean,
): Promise<Preference | null> {
  const [row] = await db
    .update(botPreferences)
    .set({ private: value })
    .where(ownedPreference(db, ownerId, preferenceId))
    .returning();
  return row === undefined ? null : toPreference(row);
}

/** 删到了回它属于哪个 Bot，推 preference_deleted 要带；别人的、已删的回 null。 */
export async function deletePreference(db: Db, ownerId: UserId, preferenceId: PreferenceId): Promise<BotId | null> {
  const [row] = await db
    .delete(botPreferences)
    .where(ownedPreference(db, ownerId, preferenceId))
    .returning({ botId: botPreferences.botId });
  return row === undefined ? null : BotId.parse(row.botId);
}
