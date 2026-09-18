import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export function newId(): string {
  return randomUUID();
}

export function newSessionToken(): string {
  return randomBytes(32).toString("hex");
}

/** 电脑代理的 token 和模型网关的 key。32 字节随机数，明文只在生成的这一刻存在。 */
export function newSecret(): string {
  return randomBytes(32).toString("hex");
}

/**
 * 秘密是 32 字节随机数，不是密码，穷举不可行，所以不加盐也不用 scrypt。
 * 网关要按 Bearer 反查是哪台电脑，加盐就查不了。
 */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function secretMatches(secret: string, storedHash: string): boolean {
  const actual = Buffer.from(hashSecret(secret), "hex");
  const expected = Buffer.from(storedHash, "hex");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
