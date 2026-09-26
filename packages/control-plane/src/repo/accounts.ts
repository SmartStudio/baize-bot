import {
  ComputerId,
  type Account,
  type AccountConfig,
  type AccountId,
  type AccountTier,
  type Platform,
  type UserId,
} from "@baize/shared";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { Tx } from "./messages.js";
import { accounts } from "../db/schema.js";
import { newId } from "../ids.js";
import { toAccount } from "./rows.js";

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

export type NewAccount = {
  readonly ownerId: UserId;
  readonly computerId: ComputerId;
  readonly platform: Platform;
  readonly handle: string;
  readonly tier?: AccountTier;
};

/**
 * account-add 脚本挂一个已登录的账号。同一台电脑上同一平台同一个名字再挂一次是同一个账号，
 * 不另起一行；再挂时给了档位就改档，没给就保持原档。
 */
export async function addAccount(db: Db, input: NewAccount): Promise<Account> {
  const [row] = await db
    .insert(accounts)
    .values({
      id: newId(),
      ownerId: input.ownerId,
      computerId: input.computerId,
      platform: input.platform,
      handle: input.handle,
      login: "valid",
      ...(input.tier === undefined ? {} : { tier: input.tier }),
    })
    .onConflictDoUpdate({
      target: [accounts.computerId, accounts.platform, accounts.handle],
      set: { login: "valid", ...(input.tier === undefined ? {} : { tier: input.tier }) },
    })
    .returning();
  if (row === undefined) throw new Error("挂账号没有返回行");
  return toAccount(row);
}

export async function listAccounts(db: Db, ownerId: UserId): Promise<Account[]> {
  const rows = await db
    .select()
    .from(accounts)
    .where(eq(accounts.ownerId, ownerId))
    .orderBy(asc(accounts.createdAt), asc(accounts.id));
  return rows.map(toAccount);
}

export async function listAccountConfigs(db: Db, ownerId: UserId): Promise<AccountConfig[]> {
  return (await listAccounts(db, ownerId)).map(({ id, platform, handle, tier, login }) => ({
    id,
    platform,
    handle,
    tier,
    login,
  }));
}

export type SetTierResult =
  | { readonly kind: "ok"; readonly account: Account }
  | { readonly kind: "not_found" }
  | { readonly kind: "not_allowed" };

/** 小红书不能设成可直接发布：表上的 CHECK 兜底，这里先挡掉给个人话的 400。 */
export async function setAccountTier(
  db: Db,
  ownerId: UserId,
  accountId: AccountId,
  tier: AccountTier,
): Promise<SetTierResult> {
  const [current] = await db
    .select({ platform: accounts.platform })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.ownerId, ownerId)))
    .limit(1);
  if (current === undefined) return { kind: "not_found" };
  if (current.platform === "xiaohongshu" && tier === "direct_publish") return { kind: "not_allowed" };
  const [row] = await db
    .update(accounts)
    .set({ tier })
    .where(and(eq(accounts.id, accountId), eq(accounts.ownerId, ownerId)))
    .returning();
  if (row === undefined) return { kind: "not_found" };
  return { kind: "ok", account: toAccount(row) };
}

export type DraftAccount = {
  readonly id: AccountId;
  readonly platform: Platform;
  readonly tier: AccountTier;
  readonly computerId: ComputerId;
};

/** Bot 报上来的账号 id 是外部输入：只认这个用户自己的账号。 */
export async function findAccountForDraft(
  db: Db | Tx,
  ownerId: UserId,
  accountId: AccountId,
): Promise<DraftAccount | null> {
  const [row] = await db
    .select({ id: accounts.id, platform: accounts.platform, tier: accounts.tier, computerId: accounts.computerId })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.ownerId, ownerId)))
    .limit(1);
  if (row === undefined) return null;
  return { ...row, id: accountId, computerId: ComputerId.parse(row.computerId) };
}
