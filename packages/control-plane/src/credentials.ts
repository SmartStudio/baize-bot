import type { AccountId } from "@baize/shared";
import { eq } from "drizzle-orm";
import { open, seal } from "./crypto.js";
import type { Db } from "./db/client.js";
import { accountCredentials } from "./db/schema.js";

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

/** 同一个账号再写一次就换掉旧令牌。 */
export async function saveAccessToken(
  db: Db,
  crypto: CredentialCrypto,
  accountId: AccountId,
  token: string,
  scope = "",
): Promise<void> {
  const row = { accessEnc: crypto.encrypt(token), scope, updatedAt: new Date() };
  await db
    .insert(accountCredentials)
    .values({ accountId, ...row })
    .onConflictDoUpdate({ target: accountCredentials.accountId, set: row });
}

export async function accessTokenOf(db: Db, crypto: CredentialCrypto, accountId: AccountId): Promise<string | null> {
  const [row] = await db
    .select({ accessEnc: accountCredentials.accessEnc })
    .from(accountCredentials)
    .where(eq(accountCredentials.accountId, accountId))
    .limit(1);
  return row === undefined ? null : crypto.decrypt(row.accessEnc);
}
