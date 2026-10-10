import type { Settings, UserId } from "@baize/shared";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { settings } from "../db/schema.js";
import { toSettings } from "./rows.js";
import { monthKey, monthTotal } from "./usage.js";

export async function getSettings(db: Db, userId: UserId): Promise<Settings> {
  const [row] = await db.select().from(settings).where(eq(settings.userId, userId)).limit(1);
  if (row === undefined) throw new Error(`用户 ${userId} 没有设置行`);
  return toSettings(row);
}

export type SettingsPatch = { readonly [K in keyof Settings]?: Settings[K] | undefined };

export async function updateSettings(db: Db, userId: UserId, patch: SettingsPatch): Promise<Settings> {
  const columns: Partial<typeof settings.$inferInsert> = {};
  if (patch.theme !== undefined) columns.theme = patch.theme;
  if (patch.notify !== undefined) columns.notify = patch.notify;
  if (patch.dndFrom !== undefined) columns.dndFrom = patch.dndFrom;
  if (patch.dndTo !== undefined) columns.dndTo = patch.dndTo;
  if (patch.budget !== undefined) columns.budget = patch.budget;

  if (Object.keys(columns).length === 0) return getSettings(db, userId);

  const [row] = await db.update(settings).set(columns).where(eq(settings.userId, userId)).returning();
  if (row === undefined) throw new Error("写设置没有返回行");
  return toSettings(row);
}

export type BudgetAlert = { readonly budget: number; readonly total: number };

/**
 * 本月花费到了预算的 80%、开着提醒、这个月还没提醒过，就把本月记上并回这一次的数。
 * 「这个月还没提醒过」写在 UPDATE 的条件里抢，两次结账同时到也只有一边抢到。
 */
export async function claimBudgetAlert(db: Db, userId: UserId, now: Date): Promise<BudgetAlert | null> {
  const total = await monthTotal(db, userId, now);
  const month = monthKey(now);
  const [row] = await db
    .update(settings)
    .set({ budgetAlertedMonth: month })
    .where(
      and(
        eq(settings.userId, userId),
        eq(settings.notify, true),
        isNotNull(settings.budget),
        sql`${settings.budget} * 0.8 <= ${total}::numeric`,
        sql`${settings.budgetAlertedMonth} IS DISTINCT FROM ${month}`,
      ),
    )
    .returning({ budget: settings.budget });
  return row === undefined || row.budget === null ? null : { budget: row.budget, total };
}
