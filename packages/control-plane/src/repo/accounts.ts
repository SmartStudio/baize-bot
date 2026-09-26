import {
  AccountId,
  ComputerId,
  type Account,
  type AccountConfig,
  type AccountTier,
  type CreateAccountRequest,
  type Platform,
  type UserId,
} from "@baize/shared";
import { and, asc, eq, lte, ne, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { Tx } from "./messages.js";
import { accounts, computers, drafts } from "../db/schema.js";
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
      set: {
        login: "valid",
        loginChangedAt: loginChangedAt("valid", new Date()),
        ...(input.tier === undefined ? {} : { tier: input.tier }),
      },
    })
    .returning();
  if (row === undefined) throw new Error("挂账号没有返回行");
  return toAccount(row);
}

/** login 真变了才换时刻：重复报一次 valid 不该让今天页以为刚登上。 */
function loginChangedAt(login: Account["login"], now: Date): SQL {
  return sql`case when ${accounts.login} = ${login} then ${accounts.loginChangedAt} else ${now.toISOString()}::timestamptz end`;
}

export type CreatePlaceholderResult =
  | { readonly kind: "created" | "existing"; readonly account: Account }
  | { readonly kind: "no_computer" }
  | { readonly kind: "remote_computer" };

/**
 * 账号页点「加小红书」：建一个没登录、没名字的占位，扫码回来才有名字。一个人每个平台最多一个占位，
 * 靠部分唯一索引收敛：已经有了就回那一行。
 */
export async function createPlaceholder(
  db: Db,
  ownerId: UserId,
  request: CreateAccountRequest,
): Promise<CreatePlaceholderResult> {
  const [computer] = await db
    .select({ kind: computers.kind })
    .from(computers)
    .where(and(eq(computers.id, request.computerId), eq(computers.ownerId, ownerId)))
    .limit(1);
  if (computer === undefined) return { kind: "no_computer" };
  // 请求只收浏览器平台。远程电脑没有助理浏览器，挂上去登不了也发不了。
  if (computer.kind === "remote") return { kind: "remote_computer" };
  const id = newId();
  const [row] = await db
    .insert(accounts)
    .values({ id, ownerId, computerId: request.computerId, platform: request.platform })
    .onConflictDoUpdate({
      target: [accounts.ownerId, accounts.platform],
      targetWhere: sql`${accounts.login} = 'none'`,
      // 什么都不改，只为让 RETURNING 带回已有那行。每人只有一台本机，占位不会在别的电脑上。
      set: { computerId: sql`${accounts.computerId}` },
    })
    .returning();
  if (row === undefined) throw new Error("建账号占位没有返回行");
  return { kind: row.id === id ? "created" : "existing", account: toAccount(row) };
}

export async function findAccount(db: Db, ownerId: UserId, accountId: AccountId): Promise<Account | null> {
  const [row] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.ownerId, ownerId)))
    .limit(1);
  return row === undefined ? null : toAccount(row);
}

export type LoginValid = { readonly account: Account; readonly deleted: AccountId | null };

/**
 * 扫码登上了。这台电脑上同平台已经有这个名字的行（多半是以前过期的那行），就把它记回已登录，
 * 报上来的要是占位就删掉，占位上的草稿挪过去；没有就给报上来的这行写上名字。
 * 报上来的行锁住，同一个账号连报两次也只收敛成一行。
 */
export async function markLoginValid(
  db: Db,
  ownerId: UserId,
  computerId: ComputerId,
  accountId: AccountId,
  handle: string,
): Promise<LoginValid | null> {
  return db.transaction(async (tx) => {
    const [reported] = await tx
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, accountId), eq(accounts.ownerId, ownerId), eq(accounts.computerId, computerId)))
      .for("update");
    if (reported === undefined) return null;
    const now = new Date();
    const [known] = await tx
      .update(accounts)
      .set({ login: "valid", loginChangedAt: loginChangedAt("valid", now) })
      .where(
        and(
          eq(accounts.computerId, computerId),
          eq(accounts.platform, reported.platform),
          eq(accounts.handle, handle),
          ne(accounts.id, accountId),
        ),
      )
      .returning();
    if (known !== undefined) {
      if (reported.login !== "none") return { account: toAccount(known), deleted: null };
      await tx.update(drafts).set({ accountId: known.id }).where(eq(drafts.accountId, accountId));
      await tx.delete(accounts).where(eq(accounts.id, accountId));
      return { account: toAccount(known), deleted: accountId };
    }
    const [row] = await tx
      .update(accounts)
      .set({ login: "valid", handle, loginChangedAt: loginChangedAt("valid", now) })
      .where(eq(accounts.id, accountId))
      .returning();
    if (row === undefined) throw new Error("锁住的账号行更新时不见了");
    return { account: toAccount(row), deleted: null };
  });
}

/**
 * 登录过期只从已登录变过来：占位没有名字，本来就没登上；已经过期的再报一次什么都不改，调用方据此不重复通知。
 * 给了 sessionAt 就只认那一刻还在的那次登录：之后又重登过的，loginChangedAt 晚于它，不再命中。
 */
export async function markLoginExpired(
  db: Db | Tx,
  target: { readonly ownerId: UserId; readonly accountId: AccountId; readonly sessionAt?: Date },
): Promise<Account | null> {
  const [row] = await db
    .update(accounts)
    .set({ login: "expired", loginChangedAt: new Date() })
    .where(
      and(
        eq(accounts.id, target.accountId),
        eq(accounts.ownerId, target.ownerId),
        eq(accounts.login, "valid"),
        target.sessionAt === undefined ? undefined : lte(accounts.loginChangedAt, target.sessionAt),
      ),
    )
    .returning();
  return row === undefined ? null : toAccount(row);
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
