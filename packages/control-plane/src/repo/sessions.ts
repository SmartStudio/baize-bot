import type { User } from "@baize/shared";
import { and, eq, gt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { sessions, users } from "../db/schema.js";
import { newSessionToken } from "../ids.js";
import { toUser } from "./rows.js";

export const SESSION_COOKIE = "baize_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function createSession(db: Db, userId: string): Promise<string> {
  const token = newSessionToken();
  await db.insert(sessions).values({
    id: token,
    userId,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return token;
}

export async function userForSession(db: Db, token: string): Promise<User | null> {
  const [row] = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, token), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return row === undefined ? null : toUser(row.user);
}

export async function deleteSession(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, token));
}
