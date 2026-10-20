import { GroupId, type UserId } from "@baize/shared";
import { and, eq, exists, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { groupMembers, groups } from "../db/schema.js";
import type { Tx } from "./messages.js";

/**
 * 群对外还在：没解散，也还有成员。
 * 团队群的成员删光后群行和任务卡还在，但没有 Bot 的群派不了活，也构造不出 Group（botIds 至少一个）；
 * 解散的群行也留着，历史不丢。两种对外一律当它不存在：列表早就藏了它，按群 id 访问的接口用这个条件跟列表保持一致。
 */
export const groupIsLive = (db: Db | Tx) =>
  and(
    isNull(groups.archivedAt),
    exists(
      db
        .select({ one: sql`1` })
        .from(groupMembers)
        .where(eq(groupMembers.groupId, groups.id)),
    ),
  );

/** 群按归属人过滤，空群、解散的群和别人的群一样查不到，路由层因此返回 404。 */
export async function findLiveGroupId(db: Db, ownerId: UserId, groupId: GroupId): Promise<GroupId | null> {
  const [row] = await db
    .select({ id: groups.id })
    .from(groups)
    .where(and(eq(groups.id, groupId), eq(groups.ownerId, ownerId), groupIsLive(db)))
    .limit(1);
  return row === undefined ? null : GroupId.parse(row.id);
}
