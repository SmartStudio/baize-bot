import type { AccountId, ComputerId, Platform, UserId } from "@baize/shared";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { accounts } from "../db/schema.js";

/** 电脑代理报上来的账号 id 是外部输入：只认这台电脑主人、登在这台电脑上的账号。 */
export async function findAccountOnComputer(
  db: Db,
  ownerId: UserId,
  computerId: ComputerId,
  accountId: AccountId,
): Promise<{ readonly platform: Platform } | null> {
  const [row] = await db
    .select({ platform: accounts.platform })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.ownerId, ownerId), eq(accounts.computerId, computerId)))
    .limit(1);
  return row ?? null;
}
