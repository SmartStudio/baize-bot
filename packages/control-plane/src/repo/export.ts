import {
  BotId,
  type Bot,
  type BrandBook,
  type Draft,
  type Preference,
  type Routine,
  type Settings,
  type Skill,
  type TopicTask,
  type Trigger,
  type User,
  type UserId,
} from "@baize/shared";
import { asc, eq, inArray, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { bots, drafts, handoffs, runs, users } from "../db/schema.js";
import { getBrand } from "./brand.js";
import { listPreferencesForConfig } from "./preferences.js";
import { listOwnerRoutines } from "./routines.js";
import { lockOwner, lockRunsOfBot } from "./runs.js";
import { toBot, toDraft } from "./rows.js";
import { getSettings } from "./settings.js";
import { listSkillsByOwner } from "./skills.js";
import { findTaskByGroup, listProjects } from "./tasks.js";

/** webhook 的 token 本身就是触发凭据，导出只留「有一个 webhook 触发」。 */
export type ExportedTrigger = Exclude<Trigger, { kind: "webhook" }> | { readonly kind: "webhook" };
export type ExportedRoutine = Omit<Routine, "triggers"> & { readonly triggers: ExportedTrigger[] };
export type ExportedBot = Bot & { readonly skills: Skill[]; readonly preferences: Preference[] };

/**
 * 数据与隐私页的导出（D14）。每一段都按白名单从领域对象拼出来，工具连接、平台账号、电脑三类带凭据的对象整段不进，
 * 以后往领域对象里加字段的人不会顺手把凭据带进来。
 */
export type DataExport = {
  readonly format: 1;
  readonly exportedAt: string;
  readonly user: User;
  readonly settings: Settings;
  readonly brand: BrandBook | null;
  readonly bots: ExportedBot[];
  readonly routines: ExportedRoutine[];
  readonly projects: TopicTask[];
  readonly drafts: Draft[];
};

const withoutWebhookToken = (trigger: Trigger): ExportedTrigger =>
  trigger.kind === "webhook" ? { kind: "webhook" } : trigger;

export async function exportUserData(db: Db, user: User, now: Date): Promise<DataExport> {
  const [botRows, skills, preferences, routines, projects, draftRows, settings, brand] = await Promise.all([
    db.select().from(bots).where(eq(bots.ownerId, user.id)).orderBy(asc(bots.createdAt), asc(bots.id)),
    listSkillsByOwner(db, user.id),
    listPreferencesForConfig(db, user.id),
    listOwnerRoutines(db, user.id),
    listProjects(db, user.id),
    db.select().from(drafts).where(eq(drafts.ownerId, user.id)).orderBy(asc(drafts.createdAt), asc(drafts.id)),
    getSettings(db, user.id),
    getBrand(db, user.id),
  ]);
  const tasks = await Promise.all(projects.map((project) => findTaskByGroup(db, project.groupId)));
  return {
    format: 1,
    exportedAt: now.toISOString(),
    user,
    settings,
    brand,
    bots: botRows.map((row) => ({
      ...toBot(row),
      skills: skills.filter((skill) => skill.botId === row.id),
      preferences: preferences.filter((preference) => preference.botId === row.id),
    })),
    routines: routines.map((routine) => ({ ...routine, triggers: routine.triggers.map(withoutWebhookToken) })),
    projects: tasks.filter((task) => task !== null),
    drafts: draftRows.map(toDraft),
  };
}

/**
 * 删账号：其余表都挂在 users 上级联删。runs 是账，对 users 的外键是置空，删 Bot、删群时要留着；
 * 删账号是把这个人整个拿走，账也跟着删，同一个事务里先删。
 *
 * 第一句先拿这个人的排他锁（lockOwner）：建 Bot、建群、开项目、建 run 都拿它的共享锁，拿到排他时这些事务都已提交，
 * 提交前它们再也建不出 Bot 和 run；建群和开项目也不会反着锁序和级联各拿一半。
 * 补建主助理（ensureAssistant）不过这把锁，可能在枚举之后插出一个 Bot：它随 users 级联删掉，建不出 run 靠 startRun 的共享锁。
 * 然后和删 Bot 一样对每个 Bot 过 lockRunsOfBot，再锁交接卡，理由见 deleteBot。
 * 拿到每个 Bot 的排他锁之后，已有的 run 都已提交、删得到；在锁上等的 startRun 醒来时成员行已随 Bot 删掉，不建 run。
 * 多把锁按 Bot id 升序拿，两次删号、删号和删 Bot 之间不会各拿一半。
 */
export async function deleteAccount(db: Db, userId: UserId): Promise<void> {
  await db.transaction(async (tx) => {
    await lockOwner(tx, userId, "exclusive");
    const owned = await tx.select({ id: bots.id }).from(bots).where(eq(bots.ownerId, userId)).orderBy(asc(bots.id));
    const botIds = owned.map((row) => BotId.parse(row.id));
    for (const botId of botIds) await lockRunsOfBot(tx, botId);
    if (botIds.length > 0) {
      await tx
        .select({ id: handoffs.id })
        .from(handoffs)
        .where(or(inArray(handoffs.fromBotId, botIds), inArray(handoffs.toBotId, botIds)))
        .for("update");
    }
    await tx.delete(runs).where(eq(runs.ownerId, userId));
    await tx.delete(users).where(eq(users.id, userId));
  });
}
