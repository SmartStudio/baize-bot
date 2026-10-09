import {
  AccountId,
  ComputerId,
  type Account,
  type AccountConfig,
  type AccountTier,
  type CreateAccountRequest,
  type LoginFailure,
  type OAuthPlatform,
  type Platform,
  type UserId,
} from "@baize/shared";
import { and, asc, desc, eq, lte, ne, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { Tx } from "./messages.js";
import { accountCredentials, accounts, computers, drafts } from "../db/schema.js";
import { hashSecret, newId } from "../ids.js";
import { withAccountLock } from "./account-lock.js";
import { ensureComputer, findComputerByOwner } from "./computers.js";
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
 * 已有的行 login 不在这里动：过期的账号靠随后 saveAccessToken 写下的新一代回到 valid。
 */
export async function addAccount(db: Db | Tx, input: NewAccount): Promise<Account> {
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
      set: { computerId: input.computerId, ...(input.tier === undefined ? {} : { tier: input.tier }) },
    })
    .returning();
  if (row === undefined) throw new Error("挂账号没有返回行");
  return toAccount(row);
}

/**
 * account-add 在 advisory lock 里先按这个人、这个平台、这个名字找已有的行：授权回调可能刚把同一个号挂到了远程电脑上，
 * 唯一索引按电脑建，addAccount 在本机插入不会撞上它。找到就用那一行，电脑不动；给了档位就改档，和 addAccount 再挂时一样。
 * 同名的行不止一行时先挑已经在 input 这台电脑上的，和授权回调挑行的顺序一致。
 */
export async function findOwnerAccount(tx: Tx, input: NewAccount): Promise<Account | null> {
  const [known] = await tx
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.ownerId, input.ownerId),
        eq(accounts.platform, input.platform),
        eq(accounts.handle, input.handle),
      ),
    )
    .orderBy(desc(sql`${accounts.computerId} = ${input.computerId}`), asc(accounts.createdAt))
    .limit(1);
  if (known === undefined) return null;
  if (input.tier === undefined) return toAccount(known);
  const [row] = await tx.update(accounts).set({ tier: input.tier }).where(eq(accounts.id, known.id)).returning();
  if (row === undefined) throw new Error("同一个人同一个平台挂账号排着队，选中的账号行不该消失");
  return toAccount(row);
}

/**
 * 这个人这个平台的事务级 advisory lock。唯一索引按电脑建，挡不住同一个外部账号在本机和远程各建一行，
 * 所以会新建 GitHub、X 账号行的路径（授权回调、account-add）都先拿它，再拿 AccountLock，排成一队再选行。
 */
export async function lockOwnerPlatform(tx: Tx, ownerId: UserId, platform: Platform): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`oauth-account:${ownerId}:${platform}`}, 0))`);
}

/**
 * OAuth 授权回来了。这个人在这个平台上已经有同名的行（多半是以前过期的，或者 account-add 挂的）就把那行
 * 挂到这次选的电脑上，不另起一行；同名的行不止一行时先挑已经在这台电脑上的，挪过来不会撞唯一索引。
 * login 不在这里动：调用方随后在 withAccountLock 里写新一代凭据，账号在那一步回到 valid。
 *
 * 唯一索引按电脑建，拦不住同一个号在本机和远程各建一行；第一次授权时也没有现成的行可锁。所以先拿
 * 这个人这个平台的事务级 advisory lock，同一个人同一个平台的回调排成一队，电脑也在锁里选。
 */
export async function connectOAuthAccount(
  tx: Tx,
  input: { readonly ownerId: UserId; readonly platform: OAuthPlatform; readonly handle: string },
): Promise<Account> {
  await lockOwnerPlatform(tx, input.ownerId, input.platform);
  // 读和发都走控制面，账号挂哪台电脑只决定它在账号页上归哪台。有远程电脑挂远程电脑，Bot 常驻在那边。
  const computer =
    (await findComputerByOwner(tx, input.ownerId, "remote")) ?? (await ensureComputer(tx, input.ownerId)).computer;
  const [known] = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.ownerId, input.ownerId),
        eq(accounts.platform, input.platform),
        eq(accounts.handle, input.handle),
      ),
    )
    .orderBy(desc(sql`${accounts.computerId} = ${computer.id}`), asc(accounts.createdAt))
    .limit(1);
  if (known !== undefined) {
    const [row] = await tx
      .update(accounts)
      .set({ computerId: computer.id })
      .where(eq(accounts.id, known.id))
      .returning();
    if (row === undefined) throw new Error("同一个人同一个平台的回调排着队，选中的账号行不该消失");
    return toAccount(row);
  }
  const [row] = await tx
    .insert(accounts)
    .values({ id: newId(), ...input, computerId: computer.id, login: "valid" })
    .onConflictDoUpdate({
      target: [accounts.computerId, accounts.platform, accounts.handle],
      set: { computerId: computer.id },
    })
    .returning();
  if (row === undefined) throw new Error("挂账号没有返回行");
  return toAccount(row);
}

/**
 * login_changed_at 一律取库时钟：迁移前认领的草稿拿它和 claimed_at（库时钟）比先后，控制面多进程部署时各自的进程时钟不齐。
 * 取语句执行那一刻而不是事务开始那一刻：登录事务开头要在电脑和账号的锁上排队，等锁期间认领的草稿不能算在新登录之后。
 */
export const LOGIN_CLOCK = sql`clock_timestamp()`;

/** login 真变了才换时刻：重复报一次 valid 不该让今天页以为刚登上。 */
function loginChangedAt(login: Account["login"]): SQL {
  return sql`case when ${accounts.login} = ${login} then ${accounts.loginChangedAt} else ${LOGIN_CLOCK} end`;
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
 * 电脑代理报登录状态的那条连接。网关 key 每次 hello 都轮换，电脑行上的 hash 就是最近一次握手的代次。
 * 写库那一刻在同一个事务里校验它还是这条连接的。同一台电脑的两条连接在同一个控制面里不会交错（hub 按电脑排成一条链），
 * 这道条件是数据库层的约束：挡 HTTP 路径上并发改电脑的写，也挡以后多个控制面共库的情况。
 */
export type ReportingConnection = { readonly computerId: ComputerId; readonly gatewayKey: string };

function reportedBy(connection: ReportingConnection): SQL {
  return sql`EXISTS (SELECT 1 FROM ${computers} WHERE ${computers.id} = ${connection.computerId} AND ${computers.gatewayKeyHash} = ${hashSecret(connection.gatewayKey)})`;
}

/**
 * 扫码登上了。这台电脑上同平台已经有这个名字的行（多半是以前过期的那行），就把它记回已登录，
 * 报上来的要是占位就删掉，占位上的草稿挪过去；没有就给报上来的这行写上名字。
 * 报上来的行锁住，同一个账号连报两次也只收敛成一行。
 * 电脑上扫码登录的账号没有控制面凭据，这是不经 saveGrant 就回到 valid 的唯一入口。
 */
export async function markLoginValid(
  db: Db,
  ownerId: UserId,
  connection: ReportingConnection,
  accountId: AccountId,
  handle: string,
): Promise<LoginValid | null> {
  const { computerId } = connection;
  return db.transaction(async (outer) => {
    // 合并要锁两行：报上来的和同名的 known。两次合并互为对方的 known 时各自先锁自己的行就互等成 deadlock，
    // 所以先在电脑上排队，同一台电脑的登录结果一次只进一个，两把行锁的顺序才有意义。
    await outer.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`login-valid:${computerId}`}, 0))`);
    return withAccountLock(outer, accountId, async ({ tx }) => {
      // 锁到手之后才查连接代次：新连接的写要么已经提交（这里看得到它换过的 key），要么还在锁上等。
      const [reported] = await tx
        .select()
        .from(accounts)
        .where(
          and(
            eq(accounts.id, accountId),
            eq(accounts.ownerId, ownerId),
            eq(accounts.computerId, computerId),
            reportedBy(connection),
          ),
        );
      if (reported === undefined) return null;
      const loggedIn = {
        login: "valid" as const,
        loginChangedAt: loginChangedAt("valid"),
        loginGeneration: sql`${accounts.loginGeneration} + 1`,
        loginFailure: null,
        loginFailedAt: null,
      };
      const [found] = await tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(
          and(
            eq(accounts.computerId, computerId),
            eq(accounts.platform, reported.platform),
            eq(accounts.handle, handle),
            ne(accounts.id, accountId),
          ),
        );
      if (found !== undefined) {
        // known 那一行也在改登录状态，和结算它的发布结果一样走它自己的账号锁。
        return withAccountLock(tx, AccountId.parse(found.id), async ({ tx: locked }) => {
          const [known] = await locked.update(accounts).set(loggedIn).where(eq(accounts.id, found.id)).returning();
          if (known === undefined) throw new Error("锁住的账号行更新时不见了");
          if (reported.login !== "none") {
            // 报上来的这行不删，这次登录对它也算成了，旧的失败痕迹一起清掉，和下面直接写名字的分支一致。
            await locked
              .update(accounts)
              .set({ loginFailure: null, loginFailedAt: null })
              .where(eq(accounts.id, accountId));
            return { account: toAccount(known), deleted: null };
          }
          await locked.update(drafts).set({ accountId: known.id }).where(eq(drafts.accountId, accountId));
          await locked.delete(accounts).where(eq(accounts.id, accountId));
          return { account: toAccount(known), deleted: accountId };
        });
      }
      const [row] = await tx
        .update(accounts)
        .set({ ...loggedIn, handle })
        .where(eq(accounts.id, accountId))
        .returning();
      if (row === undefined) throw new Error("锁住的账号行更新时不见了");
      return { account: toAccount(row), deleted: null };
    });
  });
}

/**
 * 一次登录没成，记在账号上，login 不动。和过期一样在账号行锁里写、只算在报它的那条连接头上：
 * 锁到手之后这条 UPDATE 才取快照，连接已经被顶掉的话一行都不改，新连接刚登上清掉的痕迹不会被在途的旧帧写回来。
 */
export async function markLoginFailed(
  db: Db,
  ownerId: UserId,
  connection: ReportingConnection,
  accountId: AccountId,
  reason: LoginFailure,
): Promise<Account | null> {
  return withAccountLock(db, accountId, async ({ tx }) => {
    const [row] = await tx
      .update(accounts)
      .set({ loginFailure: reason, loginFailedAt: LOGIN_CLOCK })
      .where(
        and(
          eq(accounts.id, accountId),
          eq(accounts.ownerId, ownerId),
          eq(accounts.computerId, connection.computerId),
          reportedBy(connection),
        ),
      )
      .returning();
    return row === undefined ? null : toAccount(row);
  });
}

/** 控制面拿凭据被平台拒了：被拒的是第几代凭据，null 是这个账号根本没有凭据行。见 AccessToken。 */
export type RejectedCredentials = { readonly generation: number | null };

/**
 * 发布认领时看到的登录会话。generation 是认领那一刻抄下的 login_generation，之后重登过的不算。
 * migrated 是 claimed_login_generation 这列加上之前认领的：代次按迁移基线第 1 代算，
 * 再加基底的认领时刻条件，挡住滚动升级期间旧控制面记登录成功却不推进代次的重登。
 */
export type ClaimedSession =
  | { readonly kind: "generation"; readonly generation: number }
  | { readonly kind: "migrated"; readonly claimedAt: Date };

/**
 * 过期的依据。rejected 是控制面拿着某一代凭据被平台拒了，结论只算在那一代头上；
 * reported 是电脑代理看着浏览器说的，带 session 的是某次发布认领的结论，不带的是此刻看到的；
 * 带 connection 的只算在报它的那条连接头上，连接被顶掉之后写不进去。
 */
export type ExpiryEvidence =
  | ({ readonly kind: "rejected" } & RejectedCredentials)
  | { readonly kind: "reported"; readonly session?: ClaimedSession; readonly connection?: ReportingConnection };

export type ExpiryTarget = {
  readonly ownerId: UserId;
  readonly accountId: AccountId;
  readonly evidence: ExpiryEvidence;
};

/**
 * 登录过期只从已登录变过来：占位没有名字，本来就没登上；已经过期的再报一次什么都不改，调用方据此不重复通知。
 *
 * 在账号行锁里比凭据代际：写凭据的事务都先拿这把锁，等到锁时它们要么已提交要么还没开始，
 * 这里看到的代际就是当前这一代。被拒的那一代已经换掉了，什么都不改。
 */
export async function markLoginExpired(db: Db | Tx, target: ExpiryTarget): Promise<Account | null> {
  return withAccountLock(db, target.accountId, async ({ tx }) => {
    const [row] = await tx
      .update(accounts)
      .set({ login: "expired", loginChangedAt: LOGIN_CLOCK })
      .where(
        and(
          eq(accounts.id, target.accountId),
          eq(accounts.ownerId, target.ownerId),
          eq(accounts.login, "valid"),
          stillHolds(target.evidence),
        ),
      )
      .returning();
    return row === undefined ? null : toAccount(row);
  });
}

function stillHolds(evidence: ExpiryEvidence): SQL | undefined {
  if (evidence.kind === "reported") {
    const { session, connection } = evidence;
    const sameConnection = connection === undefined ? undefined : reportedBy(connection);
    if (session === undefined) return sameConnection;
    if (session.kind === "generation") return and(eq(accounts.loginGeneration, session.generation), sameConnection);
    return and(eq(accounts.loginGeneration, 1), lte(accounts.loginChangedAt, session.claimedAt), sameConnection);
  }
  if (evidence.generation === null) {
    return sql`NOT EXISTS (SELECT 1 FROM ${accountCredentials} WHERE ${accountCredentials.accountId} = ${accounts.id})`;
  }
  return sql`EXISTS (SELECT 1 FROM ${accountCredentials} WHERE ${accountCredentials.accountId} = ${accounts.id} AND ${accountCredentials.generation} = ${evidence.generation})`;
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
