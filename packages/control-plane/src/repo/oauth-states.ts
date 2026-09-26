import type { OAuthPlatform, UserId } from "@baize/shared";
import { and, desc, eq, gt, lte, notInArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { oauthStates } from "../db/schema.js";
import type { Tx } from "./messages.js";

/** 在平台授权页上停这么久还没回来，就当这次放弃了。 */
const STATE_TTL_MS = 10 * 60_000;

/** 同一个人同一个平台同时开着的授权页最多这么多：多开几个标签页都还能回来，再多就把最旧的挤掉。 */
export const STATES_PER_PLATFORM = 5;

/**
 * 发起一次授权。过期的 state 顺手清掉（走 expires_at 的索引）；这个人这个平台超过上限的，
 * 同一个事务里把最旧的删掉。两条清理和插入在一把 advisory lock 里，同一个人同时点几次也不会越过上限。
 */
export async function createOAuthState(
  db: Db,
  input: {
    readonly state: string;
    readonly ownerId: UserId;
    readonly platform: OAuthPlatform;
    readonly verifier: string;
  },
): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`oauth-state:${input.ownerId}:${input.platform}`}, 0))`,
    );
    await tx.delete(oauthStates).where(lte(oauthStates.expiresAt, now));
    await tx.insert(oauthStates).values({
      state: input.state,
      ownerId: input.ownerId,
      platform: input.platform,
      codeVerifier: input.verifier,
      expiresAt: new Date(now.getTime() + STATE_TTL_MS),
    });
    await pruneOverflow(tx, input.ownerId, input.platform);
  });
}

/** 删掉这个人这个平台最新几条之外的 state。过滤和排序都落在 (owner_id, platform, expires_at desc, state desc) 索引上。 */
export function pruneOverflow(db: Db | Tx, ownerId: UserId, platform: OAuthPlatform) {
  const keep = db
    .select({ state: oauthStates.state })
    .from(oauthStates)
    .where(and(eq(oauthStates.ownerId, ownerId), eq(oauthStates.platform, platform)))
    .orderBy(desc(oauthStates.expiresAt), desc(oauthStates.state))
    .limit(STATES_PER_PLATFORM);
  return db
    .delete(oauthStates)
    .where(
      and(eq(oauthStates.ownerId, ownerId), eq(oauthStates.platform, platform), notInArray(oauthStates.state, keep)),
    );
}

/**
 * 平台跳回来时取走 state，只认发起它的那个人、那个平台、还没过期的。一条 DELETE 拿走，
 * 同一个回调地址被打两次也只有一次拿得到 verifier。
 */
export async function consumeOAuthState(
  db: Db,
  input: { readonly state: string; readonly ownerId: UserId; readonly platform: OAuthPlatform },
): Promise<{ readonly verifier: string } | null> {
  const [row] = await db
    .delete(oauthStates)
    .where(
      and(
        eq(oauthStates.state, input.state),
        eq(oauthStates.ownerId, input.ownerId),
        eq(oauthStates.platform, input.platform),
        gt(oauthStates.expiresAt, new Date()),
      ),
    )
    .returning({ verifier: oauthStates.codeVerifier });
  return row ?? null;
}
