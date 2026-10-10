import {
  GroupId,
  type BotId,
  type Group,
  type Message,
  type MessageBody,
  type MessageId,
  type ProjectOfferMember,
  type Routine,
  type TopicTask,
  type UserId,
} from "@baize/shared";
import { TransactionRollbackError, and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { groups, messages, routines, tasks } from "../db/schema.js";
import { newId } from "../ids.js";
import { findAssistant, insertMemberBot } from "./bots.js";
import { findGroup, openGroup } from "./groups.js";
import { nextRevision, type Tx } from "./messages.js";
import { toMessage, toRoutine, toTask } from "./rows.js";
import { lockOwner, shareBotRunsLock } from "./runs.js";

export type ProjectOfferBody = Extract<MessageBody, { kind: "project_offer" }>;

/**
 * 点开始时和项目一起建的两条例行，Bot 是主助理，发进项目群，首席是它，所以活落在它身上。
 * cron 按服务器本地时区。propose_plan 要到 P1-4 才有，工具不在时主助理照文案自己说做不到。
 */
export const PROJECT_ROUTINES = [
  {
    name: "周一 09:00 排本周计划",
    expr: "0 9 * * 1",
    instruction:
      "按任务卡上的目标和节奏排这个项目本周的计划：每一条写清哪天、哪个平台、谁来做、做成什么样。" +
      "排好调 propose_plan 发一张计划卡等我确认，确认之前别开工。" +
      "手上没有 propose_plan 这件工具的话，直接说现在还出不了计划卡，别在群里口头排。",
  },
  {
    name: "周五复盘",
    expr: "0 17 * * 5",
    instruction:
      "复盘这个项目本周：对照任务卡上的目标和节奏，说清做成了哪些、没做成哪些和原因、数字有什么变化，" +
      "最后给下周一条最该改的建议。只复盘，不动手改节奏和计划。" +
      "写完调 submit_review 把整份复盘交上去，它会进项目页的「成果」，同一周再交会顶掉上一份。",
  },
] as const;

export type ProjectOfferMessage = {
  readonly id: MessageId;
  readonly groupId: string;
  readonly body: ProjectOfferBody;
};

/**
 * 方案卡只落在主助理的单聊里（events 那头把关），所以按归属人查到的就是自己单聊里的卡。
 * 别人的、不存在的、正文不是方案卡的，都是 null。
 */
export async function findOwnedProjectOffer(
  db: Db,
  ownerId: UserId,
  messageId: MessageId,
): Promise<ProjectOfferMessage | null> {
  const [found] = await db
    .select({ row: messages })
    .from(messages)
    .innerJoin(groups, eq(groups.id, messages.groupId))
    .where(and(eq(messages.id, messageId), eq(groups.ownerId, ownerId)))
    .limit(1);
  if (found === undefined || found.row.body.kind !== "project_offer") return null;
  return { id: messageId, groupId: found.row.groupId, body: found.row.body };
}

export type DecideProjectOfferResult =
  | {
      readonly kind: "started";
      readonly message: Message;
      readonly group: Group;
      readonly task: TopicTask;
      readonly routines: readonly Routine[];
    }
  | { readonly kind: "dismissed"; readonly message: Message }
  /** 这张卡别人已经点过了。回它现在的样子，开始过的带上那个项目群和它的主题任务卡。 */
  | {
      readonly kind: "settled";
      readonly message: Message;
      readonly project: { readonly group: Group; readonly task: TopicTask } | null;
    }
  /** 路由预查之后、事务拿到账号锁之前账号被删，卡随单聊级联没了，和没找到这张卡是一回事。 */
  | { readonly kind: "gone" };

/**
 * 开始或不要。两种都靠 `UPDATE ... WHERE status = 'offered'` 抢这张卡：并发的第二次在行锁上等第一次提交，
 * 醒来时条件已经不成立，一行都改不到，于是什么都不建，回卡现在的样子。
 */
export async function decideProjectOffer(
  db: Db,
  ownerId: UserId,
  offer: ProjectOfferMessage,
  decision: { readonly decision: "start"; readonly name?: string | undefined } | { readonly decision: "dismiss" },
): Promise<DecideProjectOfferResult> {
  if (decision.decision === "dismiss") {
    const message = await claimOffer(db, offer, { ...offer.body, status: "dismissed" });
    return message === null ? settled(db, ownerId, offer) : { kind: "dismissed", message };
  }

  let lost = false;
  try {
    return await db.transaction(async (tx): Promise<DecideProjectOfferResult> => {
      // 开项目要建群、建助理 Bot，和建 Bot、建群一样先过归属人的共享锁，理由见 createBot 和 createGroup。
      await lockOwner(tx, ownerId, "shared");
      // 两条例行的执行者是主助理。建例行的入口都要先拿执行者的共享锁，和删 Bot 的排他锁互斥，
      // 而且得在抢卡、建队员、推 counter 之前拿，否则锁序倒挂。锁之前那次读不算数，拿锁后用新语句重查。
      const locking = await findAssistant(tx, ownerId);
      // 主助理删不掉，查不到只能是账号在预查之后删了，卡随单聊一起没了，交给 settled 回 gone。
      if (locking === null) {
        lost = true;
        return tx.rollback();
      }
      await shareBotRunsLock(tx, locking.bot.id);
      // 卡在主助理的单聊里，主助理删不掉，单聊随它级联，所以查得到卡就一定查得到主助理。
      const assistant = await findAssistant(tx, ownerId);
      if (assistant?.bot.id !== locking.bot.id) throw new Error(`用户 ${ownerId} 的主助理在拿锁时换了`);

      const projectGroupId = GroupId.parse(newId());
      const name = decision.name ?? offer.body.name;
      // 卡正文就是这张卡的状态，项目改了名，卡上也得是新名字，别处没有第二份。
      const started: ProjectOfferBody = { ...offer.body, name, status: "started", groupId: projectGroupId };
      if ((await claimOffer(tx, offer, started)) === null) {
        lost = true;
        return tx.rollback();
      }

      // 队员和已有的 Bot 或彼此重名就自动换个名字，否则同一个群里两个「小内」，@ 永远只认得第一个。
      const memberIds: BotId[] = [];
      const team: ProjectOfferMember[] = [];
      for (const member of offer.body.team) {
        const created = await insertMemberBot(
          tx,
          ownerId,
          { name: member.name, tags: member.tags, description: member.description },
          "untaken",
        );
        memberIds.push(created.bot.id);
        team.push({ ...member, name: created.bot.name });
      }
      // 卡上的队员名单也换成实际建出来的名字，和项目名一样只有正文这一份。
      const message = await rewriteOffer(tx, offer.id, { ...started, team });

      const opened = await openGroup(tx, ownerId, {
        id: projectGroupId,
        title: name,
        botIds: [assistant.bot.id, ...memberIds],
        summary: offer.body.goal,
        dueAt: null,
        chiefBotId: assistant.bot.id,
        cadence: offer.body.cadence,
        checklist: [{ text: offer.body.firstStep, done: false, ownerBotId: null }],
      });
      const task = await writeOfferGoal(tx, opened.task, offer.body);

      const rows = await tx
        .insert(routines)
        .values(
          PROJECT_ROUTINES.map((routine) => ({
            id: newId(),
            botId: assistant.bot.id,
            groupId: projectGroupId,
            name: routine.name,
            instruction: routine.instruction,
            // lastFiredAt 为 null 时调度器先对齐到当前时刻，刚建的不会立刻补跑一次。
            triggers: [{ kind: "cron" as const, expr: routine.expr, lastFiredAt: null }],
            onFailure: "stop_and_tell" as const,
            purpose: "plan" as const,
            state: "on" as const,
          })),
        )
        .returning();

      return {
        kind: "started",
        message,
        group: opened.group,
        task,
        routines: rows.map((row) => toRoutine(row, [])),
      };
    });
  } catch (error) {
    if (error instanceof TransactionRollbackError && lost) return settled(db, ownerId, offer);
    throw error;
  }
}

/** 卡上目标数和单位都给了才写进任务卡；没给就是 null，进度按清单画。刚建的群没有样本，不用带指标。 */
async function writeOfferGoal(tx: Tx, task: TopicTask, body: ProjectOfferBody): Promise<TopicTask> {
  const { goalTarget, goalUnit } = body;
  if (goalTarget === undefined || goalUnit === undefined) return task;
  const [row] = await tx
    .update(tasks)
    .set({ goalTarget, goalUnit, goalDueAt: null })
    .where(eq(tasks.id, task.id))
    .returning();
  if (row === undefined) throw new Error(`任务卡 ${task.id} 刚建就不见了`);
  return toTask(row);
}

/** 抢到卡之后在同一个事务里改写正文，行锁还在手里。 */
async function rewriteOffer(tx: Tx, id: MessageId, body: ProjectOfferBody): Promise<Message> {
  const [row] = await tx
    .update(messages)
    .set({ body, revision: nextRevision() })
    .where(eq(messages.id, id))
    .returning();
  if (row === undefined) throw new Error(`方案卡 ${id} 抢到之后不见了`);
  return toMessage(row);
}

/** 只改还挂在 offered 的那一条，改不动就是已经有人点过了。 */
async function claimOffer(db: Db | Tx, offer: ProjectOfferMessage, body: ProjectOfferBody): Promise<Message | null> {
  const [row] = await db
    .update(messages)
    .set({ body, revision: nextRevision() })
    .where(
      and(
        eq(messages.id, offer.id),
        eq(messages.groupId, offer.groupId),
        sql`${messages.body} ->> 'status' = 'offered'`,
      ),
    )
    .returning();
  return row === undefined ? null : toMessage(row);
}

async function settled(db: Db, ownerId: UserId, offer: ProjectOfferMessage): Promise<DecideProjectOfferResult> {
  const [row] = await db.select().from(messages).where(eq(messages.id, offer.id)).limit(1);
  if (row === undefined) return { kind: "gone" };
  const message = toMessage(row);
  const projectGroupId = message.body.kind === "project_offer" ? message.body.groupId : null;
  const detail = projectGroupId === null ? null : await findGroup(db, ownerId, projectGroupId);
  return { kind: "settled", message, project: detail === null ? null : { group: detail.group, task: detail.task } };
}
