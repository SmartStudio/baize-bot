import type { Settings, UserId } from "@baize/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { settings } from "../db/schema.js";
import { toSettings } from "./rows.js";

export async function getSettings(db: Db, userId: UserId): Promise<Settings> {
  const [row] = await db.select().from(settings).where(eq(settings.userId, userId)).limit(1);
  if (row === undefined) throw new Error(`用户 ${userId} 没有设置行`);
  return toSettings(row);
}

export type SettingsPatch = { readonly [K in keyof Settings]?: Settings[K] | undefined };

export async function updateSettings(
  db: Db,
  userId: UserId,
  patch: SettingsPatch,
): Promise<Settings> {
  const columns: Partial<typeof settings.$inferInsert> = {};
  if (patch.theme !== undefined) columns.theme = patch.theme;
  if (patch.notify !== undefined) columns.notify = patch.notify;
  if (patch.dndFrom !== undefined) columns.dndFrom = patch.dndFrom;
  if (patch.dndTo !== undefined) columns.dndTo = patch.dndTo;

  if (Object.keys(columns).length === 0) return getSettings(db, userId);

  const [row] = await db.update(settings).set(columns).where(eq(settings.userId, userId)).returning();
  if (row === undefined) throw new Error("写设置没有返回行");
  return toSettings(row);
}
