import {
  ComputerChoices,
  type BotId,
  type ComputerKind,
  type GroupId,
  type ServerPush,
  type UserId,
} from "@baize/shared";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { bots, computers, groupMembers, groups, runs } from "../db/schema.js";
import { appendMessage, type Tx } from "../repo/messages.js";
import type { ComputerAvailability } from "./computer-availability.js";

export type ChoiceBy = "user" | "bot";

export type ChoiceRefusal = "no_such_computer" | "target_offline";

/** pushes 要等事务提交后由调用方推出去：这里在调用方的事务里，提交前推了，网页可能拉到还没落库的值。 */
export type ChooseOutcome =
  | { readonly kind: "changed"; readonly pushes: readonly ServerPush[] }
  | { readonly kind: "unchanged" }
  | { readonly kind: "refused"; readonly reason: ChoiceRefusal }
  | { readonly kind: "not_found" };

export const CHOICE_REFUSED: Record<ChoiceRefusal, Record<ComputerKind, string>> = {
  no_such_computer: { remote: "你还没有云电脑，选不了", local: "你还没有接上自己的电脑，选不了" },
  target_offline: { remote: "云电脑现在不在线，换不过去", local: "你的电脑现在不在线，换不过去" },
};

const CHOSEN_TEXT: Record<ComputerKind, string> = { remote: "云电脑", local: "你的电脑" };

async function ownsGroup(db: Db | Tx, ownerId: UserId, groupId: GroupId): Promise<boolean> {
  const [row] = await db
    .select({ id: groups.id })
    .from(groups)
    .where(and(eq(groups.id, groupId), eq(groups.ownerId, ownerId)))
    .limit(1);
  return row !== undefined;
}

/**
 * 头部（PUT）和 Bot 的换电脑工具都调它，选择只有这一个写者。
 * by:"user" 不要求目标可派，出门前先把 Bot 放到云上是合理的；by:"bot" 要求目标当下可派，它要这一轮接着做。
 */
export async function chooseComputer(
  tx: Tx,
  input: {
    readonly ownerId: UserId;
    readonly groupId: GroupId;
    readonly botId: BotId;
    readonly kind: ComputerKind;
    readonly by: ChoiceBy;
  },
  deps: { readonly availability: () => Promise<readonly ComputerAvailability[]> },
): Promise<ChooseOutcome> {
  if (!(await ownsGroup(tx, input.ownerId, input.groupId))) return { kind: "not_found" };
  const [member] = await tx
    .select({ name: bots.name })
    .from(groupMembers)
    .innerJoin(bots, eq(bots.id, groupMembers.botId))
    .where(and(eq(groupMembers.groupId, input.groupId), eq(groupMembers.botId, input.botId)))
    .limit(1);
  if (member === undefined) return { kind: "not_found" };
  const target = (await deps.availability()).find((one) => one.kind === input.kind);
  if (target === undefined) return { kind: "refused", reason: "no_such_computer" };
  if (input.by === "bot" && !target.dispatchable) return { kind: "refused", reason: "target_offline" };
  const changed = await tx
    .update(groupMembers)
    .set({ computerKind: input.kind })
    .where(
      and(
        eq(groupMembers.groupId, input.groupId),
        eq(groupMembers.botId, input.botId),
        sql`${groupMembers.computerKind} IS DISTINCT FROM ${input.kind}`,
      ),
    )
    .returning({ botId: groupMembers.botId });
  if (changed.length === 0) return { kind: "unchanged" };
  const updated: ServerPush = {
    type: "computer_choice_updated",
    groupId: input.groupId,
    botId: input.botId,
    kind: input.kind,
  };
  // Bot 自己换的那次不留这句，由接续那条消息说明。
  if (input.by === "bot") return { kind: "changed", pushes: [updated] };
  const message = await appendMessage(tx, input.groupId, {
    kind: "system",
    text: `${member.name}之后在这个群里用${CHOSEN_TEXT[input.kind]}`,
  });
  return { kind: "changed", pushes: [{ type: "message", message }, updated] };
}

/** 群不属于这个人回 null。runningOn 取这条道上还没结束的 run 所在电脑的种类，选择变了但这一轮还在旧电脑上跑完时两者不同。 */
export async function listComputerChoices(
  db: Db | Tx,
  ownerId: UserId,
  groupId: GroupId,
): Promise<ComputerChoices | null> {
  if (!(await ownsGroup(db, ownerId, groupId))) return null;
  const members = await db
    .select({ botId: groupMembers.botId, kind: groupMembers.computerKind })
    .from(groupMembers)
    .where(eq(groupMembers.groupId, groupId))
    .orderBy(asc(groupMembers.position));
  const running = await db
    .selectDistinctOn([runs.botId], { botId: runs.botId, kind: computers.kind })
    .from(runs)
    .innerJoin(computers, eq(computers.id, runs.computerId))
    .where(and(eq(runs.groupId, groupId), isNull(runs.endedAt)))
    .orderBy(runs.botId, desc(runs.startedAt));
  return ComputerChoices.parse(
    members.map((member) => ({
      botId: member.botId,
      kind: member.kind ?? null,
      runningOn: running.find((run) => run.botId === member.botId)?.kind ?? null,
    })),
  );
}
