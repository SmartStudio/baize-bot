import { OAuthPlatform, type Account, type AccountId, type Platform } from "@baize/shared";
import { and, eq, ne, sql } from "drizzle-orm";
import { open, seal } from "./crypto.js";
import type { Db } from "./db/client.js";
import { accountCredentials, accounts } from "./db/schema.js";
import { requestToken, type OAuthEndpoints, type TokenGrant } from "./oauth-providers.js";
import { withAccountLock, type AccountLock } from "./repo/account-lock.js";
import { LOGIN_CLOCK, addAccount, findOwnerAccount, lockOwnerPlatform, type NewAccount } from "./repo/accounts.js";
import type { Tx } from "./repo/messages.js";
import { toAccount } from "./repo/rows.js";

const KEY_BYTES = 32;

/**
 * 账号凭据的钥匙。令牌只在控制面里解密，拿去打平台接口，不进日志、不进任何报文。
 * 和工具认证分开一把钥匙：泄露一把不连带另一把。
 */
export class CredentialCrypto {
  readonly #key: Buffer;

  constructor(keyBase64: string) {
    const key = Buffer.from(keyBase64, "base64");
    // Buffer.from 遇到非 base64 字符会静默跳过，所以再编回去比一次，写错一个字符也能在启动时发现。
    if (key.length !== KEY_BYTES || key.toString("base64") !== keyBase64.trim()) {
      throw new Error("CREDENTIALS_KEY 必须是 32 字节的 base64，用 openssl rand -base64 32 生成");
    }
    this.#key = key;
  }

  encrypt(plain: string): string {
    return seal(this.#key, plain);
  }

  decrypt(ciphertext: string): string {
    return open(this.#key, ciphertext, "账号凭据");
  }
}

/**
 * 手上只有一个不过期的访问令牌（account-add 脚本、测试）。同一个账号再写一次就换掉旧令牌，
 * 以前 OAuth 留下的刷新令牌和过期时间一起清掉，不然会拿旧的刷新令牌把这个新令牌刷掉。
 */
export async function saveAccessToken(
  lock: AccountLock,
  crypto: CredentialCrypto,
  token: string,
  scope = "",
): Promise<SavedGrant> {
  return saveGrant(lock, crypto, {
    accessToken: token,
    refreshToken: null,
    accessExpiresAt: null,
    refreshExpiresAt: null,
    scope,
  });
}

/**
 * 挂一个手里已有令牌的账号（account-add 脚本、测试）。账号行和凭据一个事务，
 * 中间没有「valid 却没有凭据」的一刻给发布器看到；再挂一次过期的账号，新令牌把它带回 valid。
 * 和授权回调一样先拿这个人这个平台的 advisory lock，锁里先找同名的行再决定建不建：授权回调先提交了，
 * 就用它挂在远程电脑上的那一行，不在本机另建。
 */
export async function addAccountWithToken(
  db: Db,
  crypto: CredentialCrypto,
  input: NewAccount,
  token: string,
): Promise<Account> {
  return db.transaction(async (tx) => {
    await lockOwnerPlatform(tx, input.ownerId, input.platform);
    const added = (await findOwnerAccount(tx, input)) ?? (await addAccount(tx, input));
    const saved = await withAccountLock(tx, added.id, (lock) => saveAccessToken(lock, crypto, token));
    return saved.restored ?? added;
  });
}

/** restored 是这一下从 expired（或 none）记回 valid 的账号，本来就是 valid 的为 null。 */
export type SavedGrant = { readonly generation: number; readonly restored: Account | null };

/**
 * 一份新凭据落库：换成新的一代，账号同一个事务里回到 valid。这是账号回到 valid 的唯一入口
 * （电脑上扫码登录的账号除外，它们没有控制面凭据），代际推进和 login 不会各走各的。
 */
export async function saveGrant(lock: AccountLock, crypto: CredentialCrypto, grant: TokenGrant): Promise<SavedGrant> {
  const now = new Date();
  const row = {
    accessEnc: crypto.encrypt(grant.accessToken),
    refreshEnc: grant.refreshToken === null ? null : crypto.encrypt(grant.refreshToken),
    accessExpiresAt: grant.accessExpiresAt,
    refreshExpiresAt: grant.refreshExpiresAt,
    scope: grant.scope,
    updatedAt: now,
  };
  const [saved] = await lock.tx
    .insert(accountCredentials)
    .values({ accountId: lock.accountId, ...row })
    .onConflictDoUpdate({
      target: accountCredentials.accountId,
      set: { ...row, generation: sql`${accountCredentials.generation} + 1` },
    })
    .returning({ generation: accountCredentials.generation });
  if (saved === undefined) throw new Error("写凭据没有返回行");
  const [restored] = await lock.tx
    .update(accounts)
    .set({ login: "valid", loginChangedAt: LOGIN_CLOCK })
    .where(and(eq(accounts.id, lock.accountId), ne(accounts.login, "valid")))
    .returning();
  return { generation: saved.generation, restored: restored === undefined ? null : toAccount(restored) };
}

/**
 * generation 是这个令牌出自哪一代凭据；login_expired 的 generation 是被判死的那一代，null 是这个账号根本没有凭据。
 * 调用方把账号记过期时原样交给 markLoginExpired，那一代已经被新授权换掉的话就不记。
 */
export type AccessToken =
  | { readonly kind: "token"; readonly token: string; readonly generation: number }
  | { readonly kind: "login_expired"; readonly generation: number | null };

/** 离过期不到这么久就先刷新：拿到令牌到请求打到平台之间还要走一段。 */
const REFRESH_MARGIN_MS = 60_000;

type CredentialRow = {
  readonly platform: Platform;
  readonly accessEnc: string;
  readonly refreshEnc: string | null;
  readonly accessExpiresAt: Date | null;
  readonly refreshExpiresAt: Date | null;
  readonly generation: number;
};

/** 能直接用：没到刷新窗口，也不是平台刚回 401 的那一个。 */
function usable(row: CredentialRow, crypto: CredentialCrypto, now: Date, rejected: string | null): string | null {
  if (row.accessExpiresAt !== null && row.accessExpiresAt.getTime() - REFRESH_MARGIN_MS <= now.getTime()) return null;
  const token = crypto.decrypt(row.accessEnc);
  return token === rejected ? null : token;
}

/**
 * 取一个能用的平台令牌，快过期就先刷新。两家的刷新令牌都只能用一次，两个请求同时拿旧的去刷，
 * 后到的那个会被平台拒掉、把账号误记成过期。
 *
 * 同一进程里同一个账号的刷新只跑一趟，后来的请求等那一趟的结果，不进事务、不占数据库连接；
 * 不然十来个请求各开一个事务在同一行锁上排队，连接池就被一个账号占满了。
 * 不同账号的刷新各要一个事务，而事务里要等令牌端点（最长 10 秒），所以同时进事务的刷新不超过连接池的三分之一，
 * 多出来的在事务外排队，普通请求总还有连接可用。
 * 账号行锁和「锁到之后再看一次」留着挡别的进程。刷到的新令牌先落库再返回，进程在这之后死掉也不会丢掉唯一能用的刷新令牌。
 */
export class AccountTokens {
  readonly #db: Db;
  readonly #crypto: CredentialCrypto;
  readonly #endpoints: OAuthEndpoints;
  readonly #restored: (account: Account) => Promise<void>;
  readonly #refreshing = new Map<AccountId, Promise<AccessToken>>();
  readonly #slots: Slots;

  constructor(
    db: Db,
    crypto: CredentialCrypto,
    endpoints: OAuthEndpoints,
    /** 刷新成功把一个 expired 的账号带回 valid 时叫一下：推账号、重发 config 都在这里面做。 */
    restored: (account: Account) => Promise<void> = async () => {},
  ) {
    this.#db = db;
    this.#crypto = crypto;
    this.#endpoints = endpoints;
    this.#restored = restored;
    this.#slots = new Slots(Math.max(1, Math.floor(db.$client.options.max / 3)));
  }

  /**
   * 平台明确不认刷新令牌、或者根本没有可用的令牌，回 login_expired；连不上平台抛异常，账号状态不动。
   * rejected 是平台刚回 401 的那个令牌：库里还是它就强制刷新，已经换过了就用换过的。
   */
  async accessToken(accountId: AccountId, rejected: string | null = null): Promise<AccessToken> {
    const [row] = await this.#select(this.#db, accountId);
    if (row === undefined) return { kind: "login_expired", generation: null };
    const token = usable(row, this.#crypto, new Date(), rejected);
    if (token !== null) return { kind: "token", token, generation: row.generation };

    const inFlight = this.#refreshing.get(accountId);
    if (inFlight !== undefined) return inFlight;
    const refresh = this.#refresh(accountId, rejected).finally(() => this.#refreshing.delete(accountId));
    this.#refreshing.set(accountId, refresh);
    return refresh;
  }

  /**
   * 先在事务外排到一个名额，再整趟都在账号行锁里，包括打令牌端点那一段（最长 10 秒，只挡同一个账号的过期、授权回调和改档）。
   * 打令牌端点不挪到事务外：两家的刷新令牌只能用一次，别的进程拿同一个去刷会被平台拒掉、把账号误记成过期，行锁正好让它们排队。
   * 锁里刷新成功就写 valid：过期先提交、刷新后提交的交错，终态由后提交的这一代说了算。
   */
  async #refresh(accountId: AccountId, rejected: string | null): Promise<AccessToken> {
    const outcome = await this.#slots.run(() => this.#refreshLocked(accountId, rejected));
    if (outcome.restored !== null) await this.#restored(outcome.restored);
    return outcome.token;
  }

  #refreshLocked(accountId: AccountId, rejected: string | null) {
    return withAccountLock(this.#db, accountId, async (lock) => {
      const [locked] = await this.#select(lock.tx, accountId);
      if (locked === undefined) return { token: { kind: "login_expired", generation: null } as const, restored: null };
      const { generation } = locked;
      const now = new Date();
      const token = usable(locked, this.#crypto, now, rejected);
      if (token !== null) return { token: { kind: "token", token, generation } as const, restored: null };
      if (locked.refreshEnc === null || (locked.refreshExpiresAt !== null && locked.refreshExpiresAt <= now)) {
        return { token: { kind: "login_expired", generation } as const, restored: null };
      }
      if (!isOAuthPlatform(locked.platform))
        return { token: { kind: "login_expired", generation } as const, restored: null };
      const refreshed = await requestToken(
        locked.platform,
        this.#endpoints,
        { grant: "refresh", refreshToken: this.#crypto.decrypt(locked.refreshEnc) },
        now,
      );
      if (refreshed.kind === "rejected") {
        // 死掉的刷新令牌不留：再来的请求直接回过期，不再拿它去打平台。代际不动，死的还是这一代。
        await lock.tx
          .update(accountCredentials)
          .set({ refreshEnc: null, updatedAt: now })
          .where(eq(accountCredentials.accountId, accountId));
        return { token: { kind: "login_expired", generation } as const, restored: null };
      }
      const saved = await saveGrant(lock, this.#crypto, refreshed.grant);
      return {
        token: { kind: "token", token: refreshed.grant.accessToken, generation: saved.generation } as const,
        restored: saved.restored,
      };
    });
  }

  #select(db: Db | Tx, accountId: AccountId) {
    return db
      .select({
        platform: accounts.platform,
        accessEnc: accountCredentials.accessEnc,
        refreshEnc: accountCredentials.refreshEnc,
        accessExpiresAt: accountCredentials.accessExpiresAt,
        refreshExpiresAt: accountCredentials.refreshExpiresAt,
        generation: accountCredentials.generation,
      })
      .from(accountCredentials)
      .innerJoin(accounts, eq(accounts.id, accountCredentials.accountId))
      .where(eq(accountCredentials.accountId, accountId))
      .limit(1);
  }
}

/** 计数信号量：拿不到名额的在内存里排队，不开事务、不占连接。 */
class Slots {
  #free: number;
  readonly #waiting: (() => void)[] = [];

  constructor(size: number) {
    this.#free = size;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.#free > 0) this.#free -= 1;
    else await new Promise<void>((resolve) => this.#waiting.push(resolve));
    try {
      return await work();
    } finally {
      const next = this.#waiting.shift();
      if (next === undefined) this.#free += 1;
      else next();
    }
  }
}

const isOAuthPlatform = (platform: Platform): platform is OAuthPlatform => OAuthPlatform.safeParse(platform).success;
