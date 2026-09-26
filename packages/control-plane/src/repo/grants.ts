import type { Grant, GrantId, UserId } from "@baize/shared";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { grants } from "../db/schema.js";
import { toGrant } from "./rows.js";

/** 这个用户的全部授权。config 和授权列表共用这一份。 */
export async function listGrants(db: Db, ownerId: UserId): Promise<Grant[]> {
  const rows = await db
    .select()
    .from(grants)
    .where(eq(grants.ownerId, ownerId))
    .orderBy(asc(grants.createdAt), asc(grants.id));
  return rows.map(toGrant);
}

/** 按归属人删，别人的授权删不到，和不存在一样返回 false。 */
export async function deleteGrant(db: Db, ownerId: UserId, grantId: GrantId): Promise<boolean> {
  const deleted = await db
    .delete(grants)
    .where(and(eq(grants.id, grantId), eq(grants.ownerId, ownerId)))
    .returning({ id: grants.id });
  return deleted.length > 0;
}
