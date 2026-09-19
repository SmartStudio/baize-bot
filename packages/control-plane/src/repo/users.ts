import type { User, UserId } from "@baize/shared";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { settings, userCounters, users } from "../db/schema.js";
import { newId } from "../ids.js";
import { hashPassword, verifyPassword } from "../password.js";
import { toUser } from "./rows.js";

export type NewUser = {
  readonly name: string;
  readonly email: string;
  readonly password: string;
  readonly teamName: string;
};

export async function createUser(db: Db, input: NewUser): Promise<User> {
  const passwordHash = await hashPassword(input.password);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(users)
      .values({
        id: newId(),
        name: input.name,
        email: input.email,
        teamName: input.teamName,
        passwordHash,
      })
      .returning();
    if (row === undefined) throw new Error("建用户没有返回行");
    await tx.insert(userCounters).values({ userId: row.id });
    await tx.insert(settings).values({ userId: row.id });
    return toUser(row);
  });
}

export async function findUserByEmail(db: Db, email: string): Promise<User | null> {
  const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return row === undefined ? null : toUser(row);
}

export async function recordLastSeen(db: Db, userId: UserId): Promise<void> {
  await db
    .update(users)
    .set({ lastSeenAt: sql`greatest(coalesce(${users.lastSeenAt}, '-infinity'::timestamptz), now())` })
    .where(eq(users.id, userId));
}

// 邮箱不存在时拿它顶上，这样两条路径都只跑一次 scrypt，响应时间不泄露账号是否存在。
const ABSENT_USER_HASH = await hashPassword("没有这个账号");

export async function authenticate(db: Db, email: string, password: string): Promise<User | null> {
  const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  const ok = await verifyPassword(password, row?.passwordHash ?? ABSENT_USER_HASH);
  if (!ok || row === undefined) return null;
  return toUser(row);
}
