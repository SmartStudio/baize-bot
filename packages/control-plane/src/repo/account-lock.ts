import type { AccountId } from "@baize/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { accounts } from "../db/schema.js";
import type { Tx } from "./messages.js";

declare const locked: unique symbol;

/**
 * 锁住的账号行。只有 withAccountLock 造得出来：写 account_credentials、改 accounts.login 的函数都收它，
 * 不收 Db，绕过锁的写法编译不过。
 */
export type AccountLock = { readonly tx: Tx; readonly accountId: AccountId; readonly [locked]: true };

/**
 * 唯一的锁序：先锁 accounts 行，再碰 account_credentials。刷新、过期、授权回调、account-add 都从这里进，
 * 谁先拿到账号行谁先做完，后到的在锁上等，醒来看到的是前一个提交之后的世界。
 * 账号行不存在时锁不到任何东西，里面的 UPDATE 也改不到行，外键会挡住凭据。
 */
export async function withAccountLock<T>(
  db: Db | Tx,
  accountId: AccountId,
  run: (lock: AccountLock) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId)).for("update");
    return run({ tx, accountId } as AccountLock);
  });
}
