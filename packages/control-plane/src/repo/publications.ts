import { Publication, type ContentPlanId, type DraftId, type UserId } from "@baize/shared";
import { and, asc, eq, inArray, or, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { drafts, publications } from "../db/schema.js";

/** 一页消息引用到的草稿的发布记录：草稿卡指的那条，加上计划卡下面的每一条。按发布时间升序。 */
export async function listPublicationsForPage(
  db: Db,
  ownerId: UserId,
  draftIds: readonly DraftId[],
  planIds: readonly ContentPlanId[],
): Promise<Publication[]> {
  const sources: SQL[] = [];
  if (draftIds.length > 0) sources.push(inArray(publications.draftId, [...draftIds]));
  if (planIds.length > 0) {
    const planDrafts = db
      .select({ id: drafts.id })
      .from(drafts)
      .where(inArray(drafts.planId, [...planIds]));
    sources.push(inArray(publications.draftId, planDrafts));
  }
  if (sources.length === 0) return [];

  const rows = await db
    .select()
    .from(publications)
    .where(and(eq(publications.ownerId, ownerId), or(...sources)))
    .orderBy(asc(publications.publishedAt), asc(publications.id));
  return rows.map((row) =>
    Publication.parse({
      id: row.id,
      draftId: row.draftId,
      groupId: row.groupId,
      accountId: row.accountId,
      platform: row.platform,
      url: row.url,
      publishedAt: row.publishedAt.toISOString(),
    }),
  );
}
